// omniview — a working explorer for omnichain.family tokens.
//
// What it does that the official /explore does not:
//
//   * charts at all. Their /api/chart returns 503 "birdeye unset".
//   * BOTH pools per chain. Every CA has a hooked pool and a hookless one; their
//     router only knows the hooked one, so their UI cannot show the other half of
//     the market — which is usually where the price gap is.
//   * supply reconciliation. Per-chain supply swings wildly as people bridge, and
//     reading one chain's explorer makes a token look like it is inflating. This
//     shows the invariant: sum(totalSupply) - (minted - burned) = original supply.
//   * bridges that never landed. Burned on the source, unminted on the
//     destination — real user funds, currently invisible everywhere else.
//
// The Birdeye key stays in this process. The browser never sees it.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { formatUnits, parseUnits, parseEther, getAddress, encodeFunctionData, decodeEventLog,
  encodeAbiParameters, keccak256 } from 'viem';

import { CHAINS, chainById, HOME_CHAIN, PORTAL, PORTAL_ABI, ERC20_ABI, PAD, PAD_ABI, ROUTER_ABI,
  NATIVE, POOL_FEE, POOL_TICK_SPACING, rpcsFor, arbHelperFor, recordDeployment, FACTORY } from '../src/config.mjs';
import { publicClient } from '../src/chain.mjs';
import { fetchIndexedTokens, fetchLaunchedTokens, discoverCurve, getLogsChunked, poolId,
  readPoolState, tokenMeta } from '../src/discovery.mjs';
import { nativePrices, toUsd } from '../src/prices.mjs';
import { quoteBuy, quoteSell, ARTIFACT } from '../src/quote.mjs';
import { requestMint } from '../src/bridge.mjs';
import { quoteNative, supportedChains } from '../src/relay.mjs';
import * as alchemy from '../src/alchemy.mjs';
import { API } from '../src/config.mjs';
import { FACTORY_DEPLOY_TOPIC } from '../src/discovery.mjs';
import { uploadMetadata, curveSqrtPrice, deployRemote, wallChain, tokenFromReceipt,
  saltFor, LAUNCH_ABI, LAUNCH_FEE_WEI, DEFAULT_HOOK_PARAMS, RELAYER,
  relayerHoldsFloat, isDeployedOn, recoverMeta } from '../src/launch.mjs';
import { fetchLiveConfig, readLiveConfig } from '../src/refresh.mjs';
import * as be from './birdeye.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
// Loopback by default: the write endpoints below sign with a real key, and a
// dashboard that can spend money should not be reachable just because it was
// started on a box with a public interface. HOST=0.0.0.0 is opt-in.
const HOST = process.env.HOST || '127.0.0.1';

const ZERO32 = `0x${'0'.repeat(64)}`;

const num = (v, d = 18) => (v === null || v === undefined ? null : Number(formatUnits(v, d)));

/**
 * The two pools a launch always creates, read directly by id.
 *
 * Deliberately not the event-scanning discovery the bot uses: that walks from
 * the factory's deploy block, which is millions of blocks and takes minutes per
 * chain. A dashboard needs the canonical pair, and those ids are computable —
 * so this is two `extsload` reads instead of a log scan.
 */
async function fastPools(chain, token) {
  const key = (hooks) => ({
    currency0: NATIVE, currency1: getAddress(token),
    fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: getAddress(hooks),
  });
  const variants = [
    { kind: 'v4-hooked', hooks: chain.hook, viaOmniRouter: true },
    { kind: 'v4-vanilla', hooks: NATIVE, viaOmniRouter: false },
  ];
  const found = await Promise.all(variants.map(async (v) => {
    const id = poolId(key(v.hooks));
    try {
      const st = await readPoolState(chain, id);
      if (!st?.initialized) return null;
      return { ...v, poolId: id, tick: st.tick, liquidity: st.liquidity,
        tokensPerNative: st.tokensPerNative };
    } catch { return null; }
  }));
  return found.filter(Boolean);
}
const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

// ----------------------------------------------------------------- endpoints

/** Every launched token, with a live price for the ones Birdeye covers. */
async function apiTokens() {
  const tokens = await fetchIndexedTokens().catch(() => []);
  const rows = await Promise.all(tokens.map(async (t) => {
    // Price from the home chain first; it is the one that always has a market.
    const p = await be.price(t.address, HOME_CHAIN);
    const ov = await be.overview(t.address, HOME_CHAIN);
    return {
      address: t.address, name: t.name, symbol: t.symbol, tagline: t.tagline,
      createdAt: t.createdAt, chains: t.indexedChains,
      priceUsd: p?.value ?? null,
      change24h: p?.priceChange24h ?? null,
      liquidityUsd: ov?.liquidity ?? null,
      volume24hUsd: ov?.v24hUSD ?? null,
      holders: ov?.holder ?? null,
      traders24h: ov?.uniqueWallet24h ?? null,
    };
  }));
  rows.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  return { tokens: rows };
}

/**
 * One token, per chain: supply, both pools, curve, and a price.
 * Pool state is read from the PoolManager, so it is present even where Birdeye
 * has no coverage — the response says which source each price came from.
 */
async function apiToken(ca) {
  const token = getAddress(ca);
  const prices = await nativePrices();

  const chains = await Promise.all(CHAINS.map(async (c) => {
    const pc = publicClient(c);
    const [code, supply] = await Promise.all([
      pc.getBytecode({ address: token }).catch(() => null),
      pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
    ]);
    const deployed = Boolean(code && code !== '0x');
    if (!deployed) {
      return { id: c.id, short: c.short, name: c.name, explorer: c.explorer, deployed: false, pools: [] };
    }

    const [pools, bird] = await Promise.all([
      fastPools(c, token).catch(() => []),
      be.price(token, c.id),
    ]);

    // On-chain fallback price: the pool's own tick, converted to USD via the
    // chain's native asset. Works on World and Linea where Birdeye does not go.
    const hooked = pools.find((p) => p.viaOmniRouter);
    const nativeUsd = prices.byChain.get(c.id)?.usd ?? null;
    const onchainUsd = hooked && nativeUsd ? nativeUsd / hooked.tokensPerNative : null;

    return {
      id: c.id, short: c.short, name: c.name, explorer: c.explorer,
      nativeSymbol: c.nativeSymbol, deployed: true,
      supply: num(supply),
      priceUsd: bird?.value ?? onchainUsd,
      priceSource: bird?.value ? 'birdeye' : (onchainUsd ? 'pool' : null),
      change24h: bird?.priceChange24h ?? null,
      birdeyeCovered: be.covers(c.id),
      pools: pools.map((p) => ({
        kind: p.kind, tick: p.tick, liquidity: p.liquidity.toString(),
        tokensPerNative: p.tokensPerNative,
        reachableByOfficialRouter: p.viaOmniRouter,
        poolId: p.poolId,
      })),
    };
  }));

  const curve = await discoverCurve(token).catch(() => null);

  // Cross-chain spread: the gap the official UI cannot show, because it only
  // ever prices one pool on one chain.
  const priced = chains.filter((c) => c.priceUsd > 0);
  let spread = null;
  if (priced.length > 1) {
    const lo = priced.reduce((a, b) => (a.priceUsd <= b.priceUsd ? a : b));
    const hi = priced.reduce((a, b) => (a.priceUsd >= b.priceUsd ? a : b));
    spread = { low: lo.short, lowUsd: lo.priceUsd, high: hi.short, highUsd: hi.priceUsd,
      ratio: hi.priceUsd / lo.priceUsd };
  }

  return jsonSafe({
    address: token, chains, spread,
    curve: curve ? { chainId: curve.chainId, priceNative: num(curve.price) } : null,
  });
}

/**
 * Supply reconciliation.
 *
 * The bridge burns on one chain and mints on another, so per-chain supply is
 * meaningless on its own and looks like inflation to anyone watching a single
 * explorer. The invariant that actually holds:
 *
 *     sum(totalSupply) - (minted - burned) = original supply
 *
 * A negative (minted - burned) is supply in flight: burned somewhere, not yet
 * minted anywhere. That is either latency or a stuck bridge.
 */
async function apiSupply(ca) {
  const token = getAddress(ca);
  let sum = 0n; let minted = 0n; let burned = 0n;

  const rows = await Promise.all(CHAINS.map(async (c) => {
    const pc = publicClient(c);
    const [s, m, b] = await Promise.all([
      pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
      pc.readContract({ address: PORTAL, abi: PORTAL_ABI, functionName: 'minted', args: [token] }).catch(() => null),
      pc.readContract({ address: PORTAL, abi: PORTAL_ABI, functionName: 'burned', args: [token] }).catch(() => null),
    ]);
    return { id: c.id, short: c.short, supply: s, minted: m, burned: b };
  }));

  for (const r of rows) {
    if (r.supply) sum += r.supply;
    if (r.minted) minted += r.minted;
    if (r.burned) burned += r.burned;
  }
  const net = minted - burned;
  const original = sum - net;

  return {
    chains: rows.map((r) => ({
      short: r.short, id: r.id,
      supply: num(r.supply), minted: num(r.minted), burned: num(r.burned),
    })),
    totalSupply: num(sum),
    minted: num(minted),
    burned: num(burned),
    inFlight: num(-net > 0n ? -net : 0n),   // burned but not yet minted
    originalSupply: num(original),
    conserved: true,                         // by construction; shown with the arithmetic
  };
}

/**
 * Bridges that burned on the source and never minted on the destination.
 * These are real balances that no explorer shows, because the tokens exist on
 * neither side while a message is unprocessed.
 */
async function apiStuck(ca, lookback = 20000n, maxChecks = 60) {
  const token = getAddress(ca);
  const evOut = PORTAL_ABI.find((x) => x.type === 'event' && x.name === 'BridgeOut');

  // Filter by token in the log query rather than fetching every BridgeOut and
  // discarding most of them — the Portal carries all tokens' traffic, so an
  // unfiltered scan is mostly other people's bridges.
  const perChain = await Promise.all(CHAINS.map(async (src) => {
    const pc = publicClient(src);
    try {
      const latest = await pc.getBlockNumber();
      const from = latest > lookback ? latest - lookback : 0n;
      const logs = await getLogsChunked(pc, {
        address: PORTAL, event: evOut, args: { token }, fromBlock: from, toBlock: latest,
      });
      return logs.slice(-maxChecks).map((l) => ({ src, l }));
    } catch { return []; }
  }));

  // One processed() call per candidate, all in flight together.
  const checked = await Promise.all(perChain.flat().map(async ({ src, l }) => {
    const dst = chainById(Number(l.args.destChainId));
    if (!dst) return null;
    const done = await publicClient(dst).readContract({
      address: PORTAL, abi: PORTAL_ABI, functionName: 'processed', args: [l.args.messageId],
    }).catch(() => null);
    if (done !== false) return null;
    return {
      from: src.short, to: dst.short,
      amount: num(l.args.amount), recipient: l.args.to,
      messageId: l.args.messageId, nonce: l.args.nonce.toString(),
      txUrl: `${src.explorer}/tx/${l.transactionHash}`,
    };
  }));

  const stuck = checked.filter(Boolean).sort((a, b) => b.amount - a.amount);
  return { stuck, total: stuck.reduce((a, s) => a + s.amount, 0), scannedBlocks: Number(lookback) };
}

/** OHLCV proxy. The key stays here. */
async function apiChart(ca, chainId, type, hours) {
  const data = await be.ohlcv(getAddress(ca), Number(chainId), type, Number(hours));
  const items = (data?.items ?? []).map((i) => ({ t: i.unixTime, o: i.o, h: i.h, l: i.l, c: i.c, v: i.v }));
  return { items, covered: be.covers(chainId) };
}

// --------------------------------------------------------------- discovery
//
// The site's index is not the set of launches. A token can be on chain, in the
// launcher's own event log, with pools open on nine chains, and still be missing
// from /api/launches because the backend never booked it — which is exactly what
// happened to SWO. So the board reads both and says which source each row came
// from; an unindexed launch is a real launch.

/** The launch the index starts at: anything older is pre-launcher test noise. */
const EPOCH_TOKEN = '0x9a5baA12664c89cFbF5cFcD9d0D4805bDcAB29E8';

let _discovered = new Map();

/**
 * `deep` walks the launcher's own event log, which is dozens of sequential
 * getLogs ranges and can outlast a serverless request budget. So the board asks
 * for the index first — one HTTP call, instant — and folds the event scan in
 * afterwards. A launch missing from the index still appears, just a moment later.
 */
async function apiDiscover(lookback, deep) {
  const key = deep ? 'deep' : 'fast';
  const hit = _discovered.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let [indexed, launched] = await Promise.all([
    fetchIndexedTokens().catch(() => []),
    deep ? fetchLaunchedTokens({ lookbackBlocks: BigInt(lookback ?? 200_000) }).catch(() => []) : [],
  ]);

  // Their index goes down. When it does, the chain still knows every launch —
  // so an empty index is a reason to scan the factory now rather than serve an
  // empty board and wait for the deep pass. It is one Etherscan call.
  if (!indexed.length && !launched.length) {
    launched = await fetchLaunchedTokens({ lookbackBlocks: BigInt(lookback ?? 200_000) }).catch(() => []);
  }

  const rows = new Map();
  for (const t of indexed) {
    rows.set(t.address.toLowerCase(), {
      address: t.address, name: t.name, symbol: t.symbol, tagline: t.tagline,
      createdAt: t.createdAt, chains: t.indexedChains, source: 'indexed',
      block: t.blockNumber ? Number(t.blockNumber) : null,
    });
  }

  // Anything the launcher emitted but the index does not carry: name and symbol
  // come off the contract, because there is no index entry to read them from.
  const home = chainById(HOME_CHAIN);
  // The factory log carries name and symbol, so most of these need no call at
  // all; only an older log shape falls back to reading the contract.
  const extra = launched.filter((l) => !rows.has(l.address.toLowerCase()));
  await Promise.all(extra.map(async (l) => {
    let { name, symbol } = l;
    if (!symbol) {
      const m = await tokenMeta(chainById(l.launchChain) ?? home, l.address).catch(() => null);
      name = m?.symbol ?? null; symbol = m?.symbol ?? '?';
    }
    rows.set(l.address.toLowerCase(), {
      address: l.address, name: name ?? symbol, symbol: symbol ?? '?', tagline: null,
      createdAt: null, chains: [], source: 'factory-log',
      block: l.blockNumber ? Number(l.blockNumber) : null,
    });
  }));

  // Cutoff: everything before OMNI is a test launch from before the launcher
  // settled, and the site's own indexer ignores them — a board that showed them
  // would disagree with every other surface for no gain. Kept as an address
  // rather than a block because the launch chain is not always the same one.
  const all = [...rows.values()].sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
  const floor = all.find((t) => t.address.toLowerCase() === EPOCH_TOKEN.toLowerCase());
  const at = (t) => (t.createdAt ? Date.parse(t.createdAt) : null);
  const keep = !floor ? all : all.filter((t) => {
    if (t.address.toLowerCase() === EPOCH_TOKEN.toLowerCase()) return true;
    const a = at(t); const b = at(floor);
    if (a != null && b != null) return a >= b;
    if (t.block != null && floor.block != null) return t.block >= floor.block;
    return true;   // unknown age: show it rather than silently swallow a launch
  });

  const value = {
    tokens: keep, deep: Boolean(deep),
    indexed: indexed.length, fromEvents: extra.length,
    hiddenBeforeEpoch: all.length - keep.length, epoch: EPOCH_TOKEN,
  };
  _discovered.set(key, { at: Date.now(), value });
  return value;
}

// ----------------------------------------------------------------- charts
//
// One CA trades on up to nine chains at once. Every existing chart — theirs,
// Birdeye's own, DexScreener — shows exactly one of them, which is why a token
// can look flat on Base while it is 40% richer on BNB.
//
// So: one line per chain Birdeye can see, and one fat line for the aggregate.
// The aggregate is the float-weighted mean — each chain's print weighted by the
// supply actually sitting on that chain — because the portal moves supply
// around and a plain average would let an empty chain outvote a full one.

/** Birdeye covers 7 of the 9. These are the ones a line can honestly be drawn for. */
const paintable = () => CHAINS.filter((c) => be.covers(c.id));

async function apiCharts(ca, type = '15m', hours = 24) {
  const token = getAddress(ca);
  const [prices, supplies] = await Promise.all([
    nativePrices().catch(() => null),
    Promise.all(CHAINS.map((c) => publicClient(c)
      .readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' })
      .catch(() => null))),
  ]);
  const supplyOf = Object.fromEntries(CHAINS.map((c, i) => [c.id, num(supplies[i]) ?? 0]));

  const series = await Promise.all(CHAINS.map(async (c) => {
    const base = {
      id: c.id, short: c.short, name: c.name, explorer: c.explorer,
      supply: supplyOf[c.id], covered: be.covers(c.id),
    };
    // No Birdeye feed (World, Linea): no history exists to draw, so draw
    // nothing rather than something invented — but the live pool still gives an
    // honest spot price, and that gets marked on the axis.
    if (!be.covers(c.id)) {
      const pools = await fastPools(c, token).catch(() => []);
      const hooked = pools.find((p) => p.viaOmniRouter) ?? pools[0];
      const nativeUsd = prices?.byChain.get(c.id)?.usd ?? null;
      return { ...base, points: [],
        spotUsd: hooked && nativeUsd ? nativeUsd / hooked.tokensPerNative : null,
        spotSource: hooked ? 'pool' : null };
    }
    const d = await be.ohlcv(token, c.id, type, Number(hours)).catch(() => null);
    const points = (d?.items ?? [])
      .filter((i) => Number(i.c) > 0)
      .map((i) => ({ t: Number(i.unixTime), c: Number(i.c), v: Number(i.v ?? 0) }));
    const last = points.at(-1) ?? null;
    return { ...base, points, spotUsd: last?.c ?? null, spotSource: last ? 'birdeye' : null };
  }));

  // Aggregate. Birdeye buckets land on the same unix grid for a given bucket
  // size, so the union of timestamps lines up across chains; a chain that has
  // not printed in a bucket carries its last print forward rather than dropping
  // out, which would make the aggregate jump every time one venue went quiet.
  const grid = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const cursor = new Map(series.map((s) => [s.id, { i: 0, last: null }]));
  const agg = [];
  for (const t of grid) {
    let wsum = 0; let vsum = 0; let n = 0;
    for (const s of series) {
      if (!s.points.length) continue;
      const cur = cursor.get(s.id);
      while (cur.i < s.points.length && s.points[cur.i].t <= t) { cur.last = s.points[cur.i].c; cur.i += 1; }
      if (cur.last == null) continue;          // chain had not started printing yet
      const w = supplyOf[s.id] > 0 ? supplyOf[s.id] : 0;
      if (w <= 0) continue;
      wsum += w; vsum += cur.last * w; n += 1;
    }
    if (wsum > 0) agg.push({ t, c: vsum / wsum, chains: n });
  }

  const float = CHAINS.reduce((a, c) => a + (supplyOf[c.id] || 0), 0);
  const lastAgg = agg.at(-1)?.c ?? null;
  const firstAgg = agg[0]?.c ?? null;
  return {
    address: token, type, hours: Number(hours), series, agg,
    float,
    aggPrice: lastAgg,
    aggChangePct: lastAgg && firstAgg ? ((lastAgg / firstAgg) - 1) * 100 : null,
    aggMcap: lastAgg ? lastAgg * float : null,
    paintable: paintable().map((c) => c.short),
    unpaintable: CHAINS.filter((c) => !be.covers(c.id)).map((c) => c.short),
    weighting: 'float-weighted: each chain’s print weighted by the supply sitting on that chain',
  };
}

// ------------------------------------------------------------------- curve
//
// The bonding curve exists on Base only. Before graduation it is the cheapest
// venue there is — which is the whole point of "buy on the pad, sell on a dex".

async function apiCurve(ca, sizeEth, sizeTok, chain) {
  const token = getAddress(ca);
  const on = (chain && chainById(Number(chain))) || chainById(HOME_CHAIN);
  const pc = publicClient(on);
  // Each chain's own launchpad, where it has one. Reading Base's pad for a
  // Robinhood curve answered every chain with Base's numbers.
  const pad = padFor(on);
  const read = (fn, args = []) => (pad
    ? pc.readContract({ address: pad, abi: PAD_ABI, functionName: fn, args }).catch(() => null)
    : Promise.resolve(null));

  const price = await read('currentCurvePrice', [token]);
  const onCurve = price !== null && price > 0n;
  const [curveSupply, held] = await Promise.all([
    read('CURVE_SUPPLY'),
    pad ? pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [pad] }).catch(() => null) : null,
  ]);

  const inEth = sizeEth ? parseEther(String(sizeEth)) : 0n;
  const inTok = sizeTok ? parseUnits(String(sizeTok), 18) : 0n;
  const [buy, sell] = await Promise.all([
    inEth > 0n ? read('quoteBuy', [token, inEth]) : null,
    inTok > 0n ? read('quoteSell', [token, inTok]) : null,
  ]);

  // What the same size does on the Base pools, so the pad can be compared with
  // the thing it is supposed to be cheaper than.
  const baseChain = chainById(HOME_CHAIN);
  const pools = await fastPools(baseChain, token).catch(() => []);
  // Sequentially: both of these are eth_call simulations carrying a full state
  // override, and firing them at the same public endpoint together is how one
  // of the two comes back empty and a real quote reads as "no venue".
  const dexQuotes = [];
  for (const p of pools) {
    const v = venueFor(baseChain, p.kind, token);
    dexQuotes.push({
      kind: p.kind,
      buy: inEth > 0n ? await quoteBuy(baseChain, token, v, inEth).catch(() => null) : null,
      sell: inTok > 0n ? await quoteSell(baseChain, token, v, inTok).catch(() => null) : null,
    });
  }

  return jsonSafe({
    address: token, onCurve, graduated: Boolean(pad) && !onCurve && (held ?? 0n) > 0n, pad, chainId: on.id,
    priceNative: num(price),
    curveSupply: num(curveSupply),
    padHolds: num(held),
    buy: buy ? { tokensOut: num(buy[0]), totalCost: num(buy[1]) } : null,
    sell: sell != null ? { nativeOut: num(sell) } : null,
    dex: dexQuotes.map((q) => ({
      kind: q.kind,
      tokensOut: q.buy == null ? null : num(q.buy),
      nativeOut: q.sell == null ? null : num(q.sell),
    })),
  });
}

/** The venue shape the quoter and executor expect, built from a kind string. */
function venueOf(c, kind) {
  if (kind === 'curve') return { kind: 'curve', chainId: HOME_CHAIN };
  const hooks = kind === 'v4-hooked' || kind === 'hooked' ? c.hook : NATIVE;
  const key = {
    currency0: NATIVE, currency1: null, fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING,
    hooks: getAddress(hooks),
  };
  return {
    kind: hooks === NATIVE ? 'v4-vanilla' : 'v4-hooked',
    chainId: c.id, key,
    viaOmniRouter: hooks !== NATIVE,
    nativeIsCurrency0: true,
  };
}
/** venueOf leaves currency1 open because the token is only known per request. */
const venueFor = (c, kind, token) => {
  const v = venueOf(c, kind);
  if (v.key) { v.key = { ...v.key, currency1: getAddress(token) }; v.poolId = poolId(v.key); }
  return v;
};

async function apiQuote(ca, chainId, kind, side, amount) {
  const token = getAddress(ca);
  const c = chainById(chainId);
  if (!c) throw new Error(`unknown chain ${chainId}`);
  const v = venueFor(c, kind, token);
  const wei = parseUnits(String(amount), 18);
  const out = side === 'buy'
    ? await quoteBuy(c, token, v, wei)
    : await quoteSell(c, token, v, wei);
  return { chain: c.short, venue: v.kind, side, in: String(amount), out: num(out) };
}

// ------------------------------------------------------- transaction builder
//
// Nothing here holds a key. The desk is a dapp: the visitor connects their own
// wallet and signs their own transactions, exactly like every other front-end
// for these pools. What this process does is the part a browser is bad at —
// quoting against live pool state, deriving the slippage floor, and encoding
// the calldata — and it hands back an unsigned transaction for the wallet to
// sign or refuse.
//
// A step list rather than a single transaction, because a sell is an approve
// and then a swap, and the page should not have to know which venues need one.

/** One unsigned transaction, in the shape `eth_sendTransaction` wants. */
const step = (label, chain, to, data, value = 0n, note = null) => ({
  label, note, chainId: chain.id, chainName: chain.name,
  to: getAddress(to), data, value: '0x' + value.toString(16),
});

const MAX_UINT256 = (1n << 256n) - 1n;

/** How much of `token` `owner` has already approved to `spender`. */
const allowanceOf = (c, token, owner, spender) => publicClient(c)
  .readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] })
  .catch(() => 0n);

/**
 * Buy or sell one venue: curve, hooked pool, or hookless pool.
 *
 * The floor is set from a quote taken against the pool's real state right now,
 * so a stale edge reverts in the wallet instead of settling at a loss — the
 * same rule the bot follows before it signs.
 */
async function txTrade({ ca, chain, venue, side, amount, from, slippageBps }) {
  const token = getAddress(ca);
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const kind = String(venue ?? 'hooked');
  if (kind === 'curve' && c.id !== HOME_CHAIN) throw new Error('the curve only exists on Base');
  const who = getAddress(from);
  const v = venueFor(c, kind, token);
  const wei = parseUnits(String(amount), 18);
  if (wei <= 0n) throw new Error('amount must be positive');
  const slip = BigInt(slippageBps ?? (side === 'sell' ? 1500 : 1000));

  const quoted = side === 'buy'
    ? await quoteBuy(c, token, v, wei)
    : await quoteSell(c, token, v, wei);
  if (!quoted || quoted === 0n) throw new Error(`no ${side} quote on ${c.name} ${v.kind}`);
  const minOut = (quoted * (10000n - slip)) / 10000n;

  // The hookless pool is unreachable through omnichain's own router: it builds
  // the PoolKey with its own hook and rejects hooks = 0x0. It needs the OmniArb
  // helper, which exists only where it has been deployed.
  const helper = kind !== 'curve' && !v.viaOmniRouter ? arbHelperFor(c) : null;
  if (helper !== null && !helper) {
    throw new Error(`the hookless pool on ${c.name} has no OmniArb helper deployed — nothing on chain can reach it`);
  }
  const spender = kind === 'curve' ? PAD : (helper || c.router);

  const steps = [];
  if (side === 'sell') {
    const have = await allowanceOf(c, token, who, spender);
    if (have < wei) {
      steps.push(step('approve', c, token,
        encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] }),
        0n, `lets ${kind === 'curve' ? 'the pad' : helper ? 'the OmniArb helper' : 'the omnichain router'} move the tokens`));
    }
  }

  if (kind === 'curve') {
    steps.push(side === 'buy'
      ? step('buy on the curve', c, PAD,
        encodeFunctionData({ abi: PAD_ABI, functionName: 'buy', args: [token, minOut] }), wei)
      : step('sell into the curve', c, PAD,
        encodeFunctionData({ abi: PAD_ABI, functionName: 'sell', args: [token, wei, minOut] })));
  } else if (helper) {
    // Native is currency0 on every omnichain pool, so a buy is zeroForOne.
    steps.push(step(`${side} the hookless pool`, c, helper,
      encodeFunctionData({ abi: ARTIFACT.abi, functionName: 'swapV4',
        args: [getAddress(c.poolManager), v.key, side === 'buy', wei, minOut] }),
      side === 'buy' ? wei : 0n, 'through the OmniArb helper — the official router cannot reach this pool'));
  } else {
    steps.push(side === 'buy'
      ? step('buy the hooked pool', c, c.router,
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'buy',
          args: [token, getAddress(c.hook), minOut, who, dl()] }), wei)
      : step('sell the hooked pool', c, c.router,
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'sell',
          args: [token, getAddress(c.hook), wei, minOut, who, dl()] })));
  }

  // Only the last step is simulated: an approve that has not happened yet makes
  // the sell revert here for a reason that is not the interesting one.
  if (steps.length === 1) {
    const t = steps[0];
    await preflight(c, { to: t.to, data: t.data, value: t.value, from: who, what: `the ${side}` });
  }

  return jsonSafe({ steps, venue: v.kind, side, chain: c.short,
    quoted: num(quoted), minOut: num(minOut), slippageBps: Number(slip) });
}

const dl = (secs = 900) => BigInt(Math.floor(Date.now() / 1000) + secs);

/**
 * Burn on the source. The mint on the destination is a separate, permissioned
 * call only the relayer can make — so the page must follow this transaction
 * with /api/mint, or the tokens are burned with nothing on the other side.
 */
async function txBridge({ ca, from, to, amount, recipient }) {
  const token = getAddress(ca);
  const src = chainById(from);
  const dst = chainById(to);
  if (!src || !dst) throw new Error('from and to must both be known chain ids');
  if (src.id === dst.id) throw new Error('source and destination are the same chain');
  const wei = parseUnits(String(amount), 18);
  if (wei <= 0n) throw new Error('amount must be positive');
  const dest = getAddress(recipient);

  // Refuse to build a burn into a chain where the token does not exist: bridgeOut
  // burns unconditionally, while bridgeIn mints into the token contract on the
  // destination. That mismatch is how 269 million tokens went into chains with no
  // contract to mint them.
  const code = await publicClient(dst).getBytecode({ address: token }).catch(() => null);
  if (!code || code === '0x') {
    throw new Error(`${token} is not deployed on ${dst.name} yet — burning to it would strand the supply`);
  }

  const data = encodeFunctionData({ abi: PORTAL_ABI, functionName: 'bridgeOut',
    args: [token, BigInt(dst.id), dest, wei] });
  await preflight(src, { to: PORTAL, data, value: '0x0', from: dest, what: 'the burn' });

  return jsonSafe({
    steps: [step(`burn on ${src.short}`, src, PORTAL, data, 0n,
      `the relayer mints the same amount to ${short(dest)} on ${dst.name}`)],
    from: src.short, to: dst.short, destChainId: dst.id, amount: String(amount),
  });
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Ask the relayer to mint, from a burn that already happened.
 *
 * Reads the BridgeOut event out of the receipt rather than trusting the caller
 * for the nonce: the Portal guards each message by id, so a wrong nonce is a
 * mint that can never be replayed correctly.
 */
async function apiMint({ chain, hash }) {
  const src = chainById(chain);
  if (!src) throw new Error(`unknown chain ${chain}`);
  const rec = await publicClient(src).getTransactionReceipt({ hash });
  if (rec.status !== 'success') throw new Error(`${hash} did not succeed on ${src.name}`);

  let ev = null;
  for (const log of rec.logs) {
    if (log.address.toLowerCase() !== PORTAL.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: PORTAL_ABI, data: log.data, topics: log.topics });
      if (d.eventName === 'BridgeOut') { ev = d.args; break; }
    } catch { /* not ours */ }
  }
  if (!ev) throw new Error(`${hash} carries no BridgeOut event — nothing to mint`);

  const dst = chainById(Number(ev.destChainId));
  if (!dst) throw new Error(`burn names unknown destination chain ${ev.destChainId}`);

  await requestMint({ srcChainId: src.id, dstChainId: dst.id, srcTxHash: hash,
    token: ev.token, sender: ev.sender, to: ev.to, amount: ev.amount, srcNonce: ev.nonce });

  return jsonSafe({ requested: true, from: src.short, to: dst.short,
    token: ev.token, to_: ev.to, amount: num(ev.amount), nonce: ev.nonce, messageId: ev.messageId });
}

/** Has the destination actually minted it yet? */
async function apiMinted({ chain, messageId }) {
  const dst = chainById(chain);
  if (!dst) throw new Error(`unknown chain ${chain}`);
  const done = await publicClient(dst).readContract({
    address: PORTAL, abi: PORTAL_ABI, functionName: 'processed', args: [messageId] }).catch(() => null);
  return { processed: done === true, chain: dst.short };
}

/**
 * Upload the launch mark and metadata.
 *
 * A browser cannot post this itself — it is a multipart upload to
 * omnichain.family, cross-origin, and their endpoint sends no CORS header. So
 * the page hands over the image and this forwards it.
 */
async function apiMetadata(body) {
  const symbol = String(body.symbol ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (!symbol || !name) throw new Error('name and symbol are required');
  const img = await stageImage({ symbol, image: body.image, imageName: body.imageName });
  const meta = await uploadMetadata({ file: img.path, name, symbol,
    description: body.description ?? body.tagline ?? '' });
  return { ...meta, generated: img.generated };
}

/**
 * The launch call itself, unsigned. Needs a logoURI from /api/metadata: the
 * launcher records it on chain, and a launch with an empty logo cannot be fixed
 * afterwards.
 */
/**
 * Simulate before handing a transaction to somebody's wallet.
 *
 * A wallet reports a failed gas estimate as "execution reverted" and nothing
 * else, which is how a launcher that had simply moved address looked like a bad
 * parameter for an hour. Simulating here gets the actual revert — and when the
 * revert is an unnamed custom error, at least says which contract said it and
 * how old our address for that contract is.
 */
async function preflight(c, { to, data, value, from, what }) {
  const pc = publicClient(c);
  const who = getAddress(from);
  const wei = BigInt(value);

  // Check the balance first. A node asked to simulate a call carrying more value
  // than the sender has does not say "insufficient funds" — Base says
  // "Transaction creation failed", which reads like a bug in the transaction
  // rather than an empty wallet, and sent me looking at contract addresses.
  if (wei > 0n) {
    const [bal, gasPrice] = await Promise.all([
      pc.getBalance({ address: who }).catch(() => null),
      pc.getGasPrice().catch(() => 0n),
    ]);
    if (bal != null && bal < wei) {
      throw new Error(
        `not enough ${c.nativeSymbol} on ${c.name}: ${formatUnits(bal, 18)} held, ` +
        `${formatUnits(wei, 18)} needed${gasPrice ? ' plus gas' : ''}`);
    }
    const reserve = gasPrice * 300_000n;
    if (bal != null && bal < wei + reserve) {
      throw new Error(
        `${formatUnits(bal, 18)} ${c.nativeSymbol} on ${c.name} covers the ${formatUnits(wei, 18)} ` +
        `but leaves nothing for gas — about ${formatUnits(reserve, 18)} more is needed`);
    }
  }

  try {
    await pc.call({ to, data, value: wei, account: who });
  } catch (e) {
    const raw = String(e.shortMessage ?? e.message ?? e);
    const sel = /(0x[0-9a-fA-F]{8})\b/.exec(raw.replace(/\s/g, ' '))?.[1];
    const live = readLiveConfig();
    const age = live?.fetchedAt ? `contract map fetched ${live.fetchedAt}` : 'contract map never fetched';
    throw new Error(
      `${what} would revert on ${c.name}: ${raw.split('\n')[0]}` +
      (sel ? ` (custom error ${sel} from ${to})` : '') +
      ` — ${age}. If these addresses are stale, restart the server: it refreshes them from the live app on boot.`);
  }
}

/** The factory predicts the CA before anything is signed; the salt is creator-bound. */
const FACTORY_PREDICT_ABI = [{
  type: 'function', name: 'predict', stateMutability: 'view',
  inputs: [{ name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
    { name: 'tagline', type: 'string' }, { name: 'logoURI', type: 'string' },
    { name: 'salt', type: 'bytes32' }],
  outputs: [{ type: 'address' }],
}];

const LAUNCH_AND_FUND_ABI = LAUNCH_ABI.map((f) => (f.name === 'launch'
  ? { ...f, name: 'launchAndFund', inputs: [...f.inputs, { name: 'relayerFeeWei', type: 'uint256' }] }
  : f));

const effectiveSalt = (creator, userSalt) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'bytes32' }], [getAddress(creator), userSalt]));

/**
 * Build the launch.
 *
 * The site rotates its launcher through a gate, so the address is asked for
 * rather than remembered — a stale one reverts with an unnamed custom error and
 * looks like a bad parameter, which cost an hour earlier today.
 *
 * On the v3 launcher this is ONE signature: the creation fee, the creator's ape
 * and the relayer's whole cross-chain bill in a single transaction. That bill is
 * what the relayer then spends deploying the token on eight more chains, opening
 * the curves and paying every pool bid — the work that was failing here for want
 * of relayer gas, now paid for by the launch itself. On v2 it is two: the
 * token-bound funding payment first, so a launcher who changes their mind before
 * the second signature has bought nothing.
 */
async function txLaunch(body) {
  const c = chainById(HOME_CHAIN);
  const name = String(body.name ?? '').trim();
  const symbol = String(body.symbol ?? '').trim();
  if (!name || !symbol) throw new Error('name and symbol are required');
  if (!body.logoURI) throw new Error('upload the metadata first — the launcher records the logo on chain');
  const tagline = body.tagline ?? '';

  const caps = await apiLauncher().catch(() => null);
  const launcher = caps?.launcher?.address ? getAddress(caps.launcher.address) : getAddress(c.launcher);
  const oneSignature = caps?.launcher?.oneSignature === true;

  const perChain = parseEther(String(body.creatorBuyEth ?? '0')) / BigInt(CHAINS.length);
  const userSalt = saltFor(symbol);
  const params = {
    name, symbol, tagline, logoURI: body.logoURI,
    salt: userSalt, intentId: ZERO32, quoteToken: NATIVE,
    targetRaiseWei: parseEther(String(body.targetRaiseEth ?? '0.06')),
    creatorBuyWei: perChain, minTokensOut: 0n, blueprintId: 0,
    custom: DEFAULT_HOOK_PARAMS, creatorFeeBps: 0,
  };

  // What the CA will be, before a signature exists — the relayer quotes against
  // this exact address, and every destination chain deploys to it.
  let predicted = null;
  if (body.from) {
    predicted = await publicClient(c).readContract({
      address: FACTORY, abi: FACTORY_PREDICT_ABI, functionName: 'predict',
      args: [name, symbol, tagline, body.logoURI, effectiveSalt(body.from, userSalt)],
    }).catch(() => null);
  }

  // What the relayer will charge to carry this across nine chains, and whether it
  // can. Refusing here is the point: the alternative is a launch that lands on
  // Base and then cannot be finished anywhere.
  let owed = 0n; let funding = null; let gate = { failure: null, requiredOnly: false, blocked: [] };
  if (predicted) {
    funding = await apiRelay({ action: 'relayerFunding', token: predicted }).catch(() => null);
    // The site answers this in two shapes. The new one quotes a complete launch
    // and is worth refusing on; the old one only reports what the relayer is
    // missing, and refusing on that would block every launch today.
    if (funding?.launchCostWei != null || funding?.quoteReady != null) {
      gate = launchGate(funding, oneSignature);
      if (gate.failure) throw new Error(`${gate.failure} — nothing signed`);
      owed = BigInt(funding.launchCostWei ?? '0');
    } else if (oneSignature && /^[0-9]+$/.test(String(funding?.totalToFundWei ?? ''))) {
      // The older relay does not quote a launch, but it does say what the
      // relayer is short of across every chain. On a one-signature launcher
      // that is the number worth paying: it is the difference between a token
      // that fans out by itself and one that waits for somebody to notice.
      owed = BigInt(funding.totalToFundWei);
    }
  }

  const steps = [];
  if (oneSignature) {
    const value = LAUNCH_FEE_WEI + perChain + owed;
    const data = encodeFunctionData({ abi: LAUNCH_AND_FUND_ABI, functionName: 'launchAndFund',
      args: [params, owed] });
    if (body.from) await preflight(c, { to: launcher, data, value, from: body.from, what: 'the launch' });
    steps.push(step('launch on Base', c, launcher, data, value,
      `0.0002 ETH fee${perChain > 0n ? ` + ${formatUnits(perChain, 18)} ETH ape` : ''}` +
      `${owed > 0n ? ` + ${formatUnits(owed, 18)} ETH for the relayer's nine-chain work` : ''}`));
  } else {
    if (owed > 0n) {
      if (!funding?.fundingData) throw new Error('the relayer did not return a funding authorization — retry before paying');
      steps.push(step('pay the cross-chain cost', c, RELAYER, funding.fundingData, owed,
        'token-bound, and settled first so nothing is spent if you stop here'));
    }
    const value = LAUNCH_FEE_WEI + perChain;
    const data = encodeFunctionData({ abi: LAUNCH_ABI, functionName: 'launch', args: [params] });
    steps.push(step('launch on Base', c, launcher, data, value,
      `0.0002 ETH fee${perChain > 0n ? ` + ${formatUnits(perChain, 18)} ETH ape` : ''}`));
  }

  return jsonSafe({
    steps, launcher, oneSignature,
    destCurveChains: caps?.launcher?.destCurveChains ?? null,
    launcherNote: caps?.unavailable
      ? (oneSignature
        ? `the site's relay does not announce its launcher (${caps.unavailable}) — read from the gate: v3, one signature, ${caps.launcher.destCurveChains} destination curves`
        : `the site has not shipped the one-signature launcher yet (${caps.unavailable}) — launching the two-step way`)
      : null,
    predicted, salt: userSalt,
    // The seed loop reads this: with it, initialize opens the CA, the curve and
    // the native pools everywhere and skips the extras the relayer cannot stock.
    requiredOnly: gate.requiredOnly === true, blocked: gate.blocked ?? [],
    // What the relayer is short of right now, whether or not the launch pays it.
    relayerShortWei: funding?.totalToFundWei ?? null,
    relayerShortChains: funding?.shortChains ?? null,
    relayerCost: num(owed), value: num(LAUNCH_FEE_WEI + perChain + (oneSignature ? owed : 0n)),
  });
}

/**
 * What the relayer's quote means for a launch that is about to be signed.
 *
 * There are two very different things in that reply and the site's own form
 * treats them the same. One is "this launch cannot be priced" — no cost, no
 * authorization, the quote unreachable — and signing through that is how you
 * pay for a fan-out that never happens. The other is "the relayer is out of
 * OMNI on three chains", which is inventory, on someone else's balance sheet,
 * and refusing the launch over it makes the creator the site's treasury desk:
 * stock the relayer, arbitrage its pools, then ask to launch. That is not one
 * click and it is not their job.
 *
 * So only the first is a refusal. The second lands as requiredOnly: every
 * chain still gets its CA, its curve and its native pools, and the OMNI,
 * stable and memecoin extras are opened later, by whoever has the inventory,
 * through the same initialize call.
 */
function launchGate(d, oneSignature) {
  if (!d || d.httpOk === false) return { failure: d?.error ?? 'pool funding quote unavailable' };
  if (typeof d.launchCostWei !== 'string' || !/^[1-9][0-9]*$/.test(d.launchCostWei)) {
    return { failure: 'the relayer cannot price this launch right now; retry before paying' };
  }
  // Only the two-signature path needs the token-bound authorization blob.
  if (!oneSignature && (typeof d.fundingData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(d.fundingData))) {
    return { failure: 'token-bound funding authorization unavailable; retry before paying' };
  }
  const blocked = [...new Set([...(d.quoteBlockedChains ?? []), ...(d.unreadable ?? [])])];
  return { failure: null, requiredOnly: d.quoteReady !== true, blocked };
}

/** Read the new CA out of a launch receipt, the same way the bot does. */
async function apiLaunched({ hash }) {
  const c = chainById(HOME_CHAIN);
  const rec = await publicClient(c).getTransactionReceipt({ hash });
  if (rec.status !== 'success') throw new Error(`launch ${hash} reverted`);
  const token = await tokenFromReceipt(rec, c.launcher, rec.from);
  if (!token) throw new Error(`${hash} succeeded but no token address could be read from its logs`);
  _discovered.clear();   // the board should show it immediately
  return { token, hash, explorer: `${c.explorer}/tx/${hash}` };
}

/**
 * Relay actions: `deploy` puts the same CA on a remote chain, `wall` has the
 * relayer open that chain's two pools from the float it holds. Both are calls
 * only the relayer can make, so they are forwarded, not signed.
 *
 * The relay lies in both directions — it has reported an HTTP failure for a
 * chain whose pool did open, and returned successful hashes for a chain where
 * nothing opened — so the page is told to verify against pool state, and
 * /api/pools is what it verifies with.
 */
/**
 * The launcher, as the site reports it right now.
 *
 * omnichain.family rotates the launcher through a gate, and every time it does,
 * an address baked in here becomes a dead contract that reverts every launch
 * with an unnamed custom error. Asking costs one request and cannot go stale.
 */
/**
 * The gate is the authority on which launcher is live.
 *
 * The site's own frontend config lags it — right now that config names
 * 0x25538e30, the gate names 0x15973D89, and the factory answers the first with
 * NotLauncher(). Every launch reverted for that reason and the error said
 * nothing about it. So the address is read from the gate, which cannot be
 * behind, and the version is probed rather than assumed.
 */
const GATE = '0x53064B36C663dDB18e1c8aafb3169A3B6d268867';
const GATE_ABI = [{ type: 'function', name: 'launcher', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const DEST_CURVE_ABI = [{ type: 'function', name: 'DEST_CURVE_CHAINS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];

async function launcherFromGate() {
  const c = chainById(HOME_CHAIN);
  const pc = publicClient(c);
  const address = await pc.readContract({ address: getAddress(GATE), abi: GATE_ABI, functionName: 'launcher' });
  if (!address || address === NATIVE) return null;
  // A v3 launcher answers DEST_CURVE_CHAINS(); a v2 one does not. That probe is
  // how the site itself decides, and it needs no deploy to start working.
  const destCurveChains = await pc.readContract({ address, abi: DEST_CURVE_ABI, functionName: 'DEST_CURVE_CHAINS' })
    .then((n) => Number(n)).catch(() => null);
  return { address: getAddress(address), oneSignature: destCurveChains != null, destCurveChains, source: 'gate' };
}

async function apiLauncher() {
  // The site's own answer first, when it has one — it knows more than the gate
  // does about how it wants to be called.
  const r = await relayPost({ action: 'launcher' });
  if (r.ok && r.data?.launcher?.address) return { ...r.data, launcher: { ...r.data.launcher, source: 'relay' } };

  const gate = await launcherFromGate().catch(() => null);
  if (gate) return { launcher: gate, unavailable: r.data?.error ?? `http ${r.status}` };
  return { launcher: null, unavailable: r.data?.error ?? `http ${r.status}` };
}

/** POST to the site's relay, with the shape the rest of this file expects back. */
async function relayPost(payload) {
  const r = await fetch(`${API}/api/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(180_000),
  });
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, data };
}

async function apiRelay(body) {
  const action = String(body.action ?? '');

  // Actions the site added with the one-signature launcher. `initialize` is the
  // whole per-chain seed in one call — deploy, allocation, curve, every pool —
  // and replaces the deploy/bridge/wall sequence this used to drive by hand.
  if (action === 'launcher') return apiLauncher();
  if (action === 'relayerFunding') {
    const r = await relayPost({ action, token: body.token ? getAddress(body.token) : undefined });
    if (r.ok) notePads(r.data);
    return { ...r.data, httpOk: r.ok, status: r.status };
  }
  if (action === 'fundChains') {
    // The relayer moves its own Base gas out to the chains it is short on, over
    // Relay, from what launches paid it. Amounts and destinations are its call:
    // nothing in the body chooses them, and nobody signs anything.
    const r = await relayPost({ action, token: body.token ? getAddress(body.token) : undefined });
    return { ...r.data, httpOk: r.ok, status: r.status };
  }
  if (action === 'initialize') {
    const r = await relayPost({
      action, token: getAddress(body.token), chainId: Number(body.chainId),
      launchHash: body.launchHash, fundingTxHash: body.fundingTxHash,
      requiredOnly: body.requiredOnly === true,
    });
    // 422 means "not complete yet", which is a state, not a failure: the same
    // call is the resume, so the page needs the body either way.
    return { ...r.data, httpOk: r.ok, status: r.status };
  }

  if (action === 'deploy') {
    const r = await deployRemote({ chainId: body.chainId, name: body.name, symbol: body.symbol,
      tagline: body.tagline ?? '', logoURI: body.logoURI, creator: getAddress(body.creator) });
    return { action, ...r };
  }
  if (action === 'wall') {
    const sqrt = body.sqrtPriceX96 ?? (await curveSqrtPrice(getAddress(body.token)));
    const r = await wallChain({ chainId: body.chainId, token: getAddress(body.token), sqrtPriceX96: sqrt,
      tokenBudget: /^\d+$/.test(String(body.tokenBudget ?? '')) ? String(body.tokenBudget) : undefined });
    return jsonSafe({ action, ...r });
  }
  throw new Error(`relay action not proxied: ${action || '(none)'}`);
}

// -------------------------------------------------------------------- seed
//
// A launch is not done when the Base transaction confirms. It is done when the
// same CA exists on nine chains with both pools open on each — nine deploys,
// eight bridges, eight relayer mints, eighteen pools. Every one of those can
// fail on its own, so the page drives them in a loop and this reports the
// ground truth it drives against.
//
// The float goes to the RELAYER, not to the launcher: the relayer is what opens
// the pools, and it can only open them from what it holds.

// Launchpads per chain, as the relay last reported them. The site deploys pads
// as it goes and its relayerFunding quote names the live one for each chain, so
// that answer wins over the address baked into the chain table.
const PADS = new Map();
function notePads(funding) {
  for (const row of funding?.chains ?? []) {
    const pad = row?.curve?.pad;
    if (row?.chainId && /^0x[0-9a-fA-F]{40}$/.test(pad ?? '')) PADS.set(Number(row.chainId), getAddress(pad));
  }
}
const padFor = (c) => PADS.get(c.id) ?? (c.pad ? getAddress(c.pad) : null);

// The pool allocation every launch mints to the relayer on Base, and one chain's
// share of it. What the relayer holds on Base above this is eight other chains'.
const BASE_SHARE = (4_000_000_000n * 10n ** 18n) / BigInt(CHAINS.length);

const LAUNCH_ALLOC_ABI = [{ type: 'function', name: 'curveAllocationOf', stateMutability: 'view',
  inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

/** The Base transaction that created this token, from the factory's own log. */
async function launchHashOf(token) {
  const home = chainById(HOME_CHAIN);
  const topic = `0x${'0'.repeat(24)}${token.slice(2).toLowerCase()}`;
  const logs = await getLogsChunked(publicClient(home), {
    address: getAddress(FACTORY), topics: [FACTORY_DEPLOY_TOPIC, topic], fromBlock: 0n, toBlock: 99_999_999n,
  }).catch(() => []);
  return logs?.[0]?.transactionHash ?? null;
}

async function apiSeedState(ca, address, hash) {
  const token = getAddress(ca);
  const home = chainById(HOME_CHAIN);
  const who = address ? getAddress(address) : null;
  // The relayer's own wallet is the one place a float worth splitting nine ways
  // lives. Every other wallet's balance is that person's position: a v3 launch
  // mints the pool and curve allocations straight to the relayer and takes
  // nothing from the creator, and a seed that spends the creator's tokens is
  // not a step, it is the bug that burned one ape 24M at a time.
  const operator = Boolean(who && who === getAddress(RELAYER));

  // The site prices the relayer's own shortfall per chain — pool bids, curve fee
  // and gas, from the actual pool count. That is a better number than anything
  // derivable from a gas price here, so use it where the answer arrives.
  const quoted = new Map();
  const funding = await apiRelay({ action: 'relayerFunding', token }).catch(() => null);
  for (const row of funding?.chains ?? []) {
    if (row?.shortfall && row.shortfall !== '0') quoted.set(Number(row.chainId), BigInt(row.shortfall));
  }

  const balanceOf = (c, owner) => publicClient(c).readContract({ address: token, abi: ERC20_ABI,
    functionName: 'balanceOf', args: [getAddress(owner)] });
  const [curveAlloc, relayerBase, launchHash] = await Promise.all([
    launcherFromGate().then((g) => g?.address
      ? publicClient(home).readContract({ address: g.address, abi: LAUNCH_ALLOC_ABI,
          functionName: 'curveAllocationOf', args: [token] })
      : 0n).catch(() => 0n),
    balanceOf(home, RELAYER).catch(() => 0n),
    /^0x[0-9a-fA-F]{64}$/.test(hash ?? '') ? Promise.resolve(hash) : launchHashOf(token),
  ]);
  // A v3 launch is one signature: the relayer holds this token's eight curve
  // supplies and its pool allocation, and `initialize` per chain does the rest.
  const v3 = curveAlloc > 0n;

  const held = operator ? relayerBase : 0n;
  const share = held / BigInt(CHAINS.length);

  const rows = await Promise.all(CHAINS.map(async (c) => {
    const [deployed, pools] = await Promise.all([
      isDeployedOn(c, token).catch(() => false),
      fastPools(c, token).catch(() => []),
    ]);
    const hooked = pools.some((p) => p.viaOmniRouter);
    const hookless = pools.some((p) => !p.viaOmniRouter);
    // What the relayer holds here is what a wall can spend here. On Base that is
    // the whole allocation — 4B on v2, 12B on v3 — and a wall with no budget
    // spends every token of it on Base's two pools, which is exactly what
    // emptied one v3 launch's eight destination curves into Base. One ninth of
    // what is left after the curve supplies is the share Base is meant to keep.
    const relayerHeld = deployed ? await balanceOf(c, RELAYER).catch(() => 0n) : 0n;
    // A v3 launch is also a curve on every chain that has a launchpad. Only
    // Base and Robinhood have one today; the rest read as "no pad", not "no curve".
    const pad = padFor(c);
    const curve = !pad ? null
      : !deployed ? false
        : await publicClient(c).readContract({ address: pad, abi: PAD_ABI,
            functionName: 'currentCurvePrice', args: [token] }).then((p) => p > 0n).catch(() => false);
    const funded = relayerHeld > 0n && (share > 0n ? relayerHeld >= share / 2n : true);
    // Base is safe to wall from here only when what the relayer holds there is
    // already one chain's share — its own wallet splitting, or a site that has
    // bridged the other eight out. A whole allocation sitting on Base waits for
    // the site (initialize, or the admin backfill) to split it; nothing here
    // can, and a wall with a budget the live relay may not honour is a bet
    // with eight chains' worth of supply.
    const split = relayerHeld <= BASE_SHARE + BASE_SHARE / 100n;
    const wallSafe = c.id !== HOME_CHAIN || operator || split;
    const wallBudget = c.id !== HOME_CHAIN ? relayerHeld
      : operator && share > 0n ? share
        : split ? relayerHeld : BASE_SHARE;
    const done = deployed && hooked && hookless && !(v3 && curve === false);
    const next = !deployed ? 'deploy'
      : done ? null
        : v3 ? 'initialize'
          : funded && wallSafe ? 'wall'
            : operator ? 'move'
              : 'allocation';
    // What the relayer must be able to pay for on this chain, not just what it
    // holds. Every remaining step here — the deploy of the CA, and the wall that
    // opens both pools — is the relayer's own transaction paid from the
    // relayer's own wallet, so a dry relayer blocks the whole chain and does it
    // silently until something tries and fails.
    const [gas, price] = await Promise.all([
      publicClient(c).getBalance({ address: getAddress(RELAYER) }).catch(() => null),
      publicClient(c).getGasPrice().catch(() => null),
    ]);
    const need = price != null ? price * 2_500_000n : null;   // a deploy plus a wall
    const mine = gas != null && need != null && gas < need ? need - gas : 0n;
    // Theirs wins when they answered: it counts the pool bids and the curve fee,
    // which a gas-price estimate here cannot see.
    const short = quoted.has(c.id) ? quoted.get(c.id) : mine;

    return { id: c.id, short: c.short, name: c.name, explorer: c.explorer,
      nativeSymbol: c.nativeSymbol,
      relayerGas: num(gas), relayerNeeds: num(need != null && quoted.has(c.id) ? (gas ?? 0n) + short : need),
      shortfallSource: quoted.has(c.id) ? 'site' : 'estimated',
      relayerShortWei: short > 0n ? short.toString() : null,
      relayerHeld: num(relayerHeld), wallBudgetWei: wallBudget > 0n ? wallBudget.toString() : null, wallSafe,
      deployed, hooked, hookless, curve, pad, funded, done, next };
  }));

  return jsonSafe({
    token, relayer: RELAYER, needsWallet: !who, operator, v3, launchHash,
    curveAllocation: num(curveAlloc), relayerBase: num(relayerBase),
    held: num(held), share: num(share), shareWei: share.toString(),
    curves: { open: rows.filter((r) => r.curve === true).length, pads: rows.filter((r) => r.pad).length },
    chains: rows, complete: rows.every((r) => r.done),
    remaining: rows.filter((r) => !r.done).map((r) => r.short),
  });
}

// ------------------------------------------------------------ readiness
//
// The site will not quote a launch until its relayer can pay for every pool on
// every chain — and OMNI is the quote asset in half of them. Two things block
// that today, and both can be fixed by the wallet that is about to launch:
// the relayer holding too little OMNI on a chain, and a chain's two OMNI pools
// having drifted past the 5% the site tolerates between them. So the launch
// button reads this first and repairs it before asking for the launch itself.

const OMNI = EPOCH_TOKEN;
const DRIFT_BPS = 500n;          // the site's PAIR_TOLERANCE_BPS
const SETTLE_BPS = 150n;         // land this far inside it, not on the line

/** OMNI's two native pools on a chain, priced, plus how far apart they are. */
async function omniPools(c) {
  const key = (hooks) => ({ currency0: NATIVE, currency1: getAddress(OMNI),
    fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: getAddress(hooks) });
  const [hooked, hookless] = await Promise.all([c.hook, NATIVE].map((h) =>
    readPoolState(c, poolId(key(h))).catch(() => null)));
  if (!hooked?.initialized || !hookless?.initialized) return { hooked, hookless, gapBps: null };
  const [lo, hi] = hooked.sqrtPriceX96 < hookless.sqrtPriceX96
    ? [hooked.sqrtPriceX96, hookless.sqrtPriceX96] : [hookless.sqrtPriceX96, hooked.sqrtPriceX96];
  // Price is sqrt², so the gap the site measures is on the squares.
  const gapBps = Number(((hi * hi - lo * lo) * 10000n) / (lo * lo));
  return { hooked, hookless, gapBps };
}

async function apiLaunchReady(token) {
  const f = await apiRelay({ action: 'relayerFunding', token: token ? getAddress(token) : undefined })
    .catch((e) => ({ error: e.message, httpOk: false }));
  const rows = await Promise.all(CHAINS.map(async (c) => {
    const q = (f.chains ?? []).find((r) => Number(r.chainId) === c.id);
    const o = q?.omni ?? null;
    const have = o?.have != null ? BigInt(o.have) : null;
    const need = o?.need != null ? BigInt(o.need) : null;
    const stock = have != null && need != null && have < need ? (need * 11n) / 10n - have : 0n;
    const p = await omniPools(c).catch(() => null);
    return { id: c.id, short: c.short, name: c.name, nativeSymbol: c.nativeSymbol,
      omniOk: o?.available === true, omniError: o?.error ?? null,
      omniHave: num(have), omniNeed: num(need), stockWei: stock > 0n ? stock.toString() : null,
      gapBps: p?.gapBps ?? null, drift: p?.gapBps != null && BigInt(p.gapBps) > DRIFT_BPS,
      hookedTpn: p?.hooked?.tokensPerNative ?? null, hooklessTpn: p?.hookless?.tokensPerNative ?? null,
      helper: Boolean(arbHelperFor(c)) };
  }));
  const gate = launchGate(f, true);
  return jsonSafe({
    quoteReady: f.quoteReady === true, blocked: gate.blocked ?? f.quoteBlockedChains ?? [],
    launchCostWei: f.launchCostWei ?? null, relayer: RELAYER,
    failure: gate.failure, requiredOnly: gate.requiredOnly === true, chains: rows,
  });
}

/** OMNI held by `who` on every chain, richest first. */
async function omniBalances(who) {
  const rows = await Promise.all(CHAINS.map(async (c) => ({
    c, bal: await publicClient(c).readContract({ address: getAddress(OMNI), abi: ERC20_ABI,
      functionName: 'balanceOf', args: [who] }).catch(() => 0n) })));
  return rows.sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
}

/**
 * Put OMNI in the relayer's hands on one chain, from wherever the wallet has it.
 * On the chain itself it is a transfer; otherwise a burn on the richest chain
 * that the relayer then mints to itself on the far side (the page asks for the
 * mint straight after, as with any bridge).
 */
async function txStockOmni({ chain, from, amountWei }) {
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const who = getAddress(from);
  const wei = BigInt(amountWei);
  if (wei <= 0n) throw new Error('amount must be positive');
  const bals = await omniBalances(who);
  const here = bals.find((b) => b.c.id === c.id)?.bal ?? 0n;
  if (here >= wei) {
    return jsonSafe({ route: 'direct', chainId: c.id, amount: num(wei), to: RELAYER,
      steps: [step(`stock the relayer with OMNI on ${c.short}`, c, OMNI,
        encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(RELAYER), wei] }),
        0n, `${C_fmt(wei)} OMNI — the quote asset it needs to open the OMNI pools here`)] });
  }
  const src = bals.find((b) => b.c.id !== c.id && b.bal >= wei)?.c
    ?? (bals.find((b) => b.c.id === HOME_CHAIN && b.bal >= wei)?.c);
  if (!src) {
    throw new Error(`you hold ${C_fmt(here)} OMNI on ${c.short} and not ${C_fmt(wei)} on any one chain — ` +
      bals.filter((b) => b.bal > 0n).map((b) => `${b.c.short} ${C_fmt(b.bal)}`).join(', '));
  }
  return jsonSafe({ route: 'bridge', chainId: c.id, mintFrom: src.id, via: src.short, amount: num(wei), to: RELAYER,
    steps: [step(`bridge OMNI ${src.short} → ${c.short} for the relayer`, src, PORTAL,
      encodeFunctionData({ abi: PORTAL_ABI, functionName: 'bridgeOut',
        args: [getAddress(OMNI), BigInt(c.id), getAddress(RELAYER), wei] }),
      0n, `burns on ${src.name}; the relayer mints ${C_fmt(wei)} OMNI to itself on ${c.name}`)] });
}

const C_fmt = (wei) => Number(formatUnits(wei, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });

/**
 * Bring a chain's two OMNI pools back within the site's tolerance.
 *
 * Price here is tokens per native, so the pool where OMNI is CHEAP carries the
 * higher sqrt price. There are two ways to close the gap and they cost entirely
 * different things: buy the cheap pool down, which spends native, or sell OMNI
 * into the dear pool, which spends OMNI and hands back native. The second is
 * the profitable side of the same trade the arb bot takes, so a wallet holding
 * OMNI and no gas can still do it — and on most chains it is the only one it
 * can afford. So both are priced, and the one this wallet can actually fund
 * wins; a bridge of its own OMNI counts as affordable, a bridge of native it
 * does not have anywhere does not.
 *
 * Sizing, for a v4 pool at sqrt price S with liquidity L: moving S by a
 * fraction f takes L·f/((1−f)·S) of native in, or L·S·f of token in.
 */
async function txAlign({ chain, from }) {
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const who = getAddress(from);
  const p = await omniPools(c);
  if (p.gapBps == null) throw new Error(`OMNI does not have both pools on ${c.name}`);
  const settled = { chainId: c.id, gapBps: p.gapBps, steps: [], legs: [], note: 'within tolerance' };
  if (BigInt(p.gapBps) <= DRIFT_BPS) return jsonSafe(settled);

  const cheap = p.hooked.sqrtPriceX96 > p.hookless.sqrtPriceX96 ? 'hooked' : 'hookless';
  const dear = cheap === 'hooked' ? 'hookless' : 'hooked';
  const S = { hooked: p.hooked.sqrtPriceX96, hookless: p.hookless.sqrtPriceX96 };
  const L = { hooked: p.hooked.liquidity, hookless: p.hookless.liquidity };
  const sqrtGap = ((S[cheap] - S[dear]) * 10000n) / S[dear];
  const target = (DRIFT_BPS - SETTLE_BPS) / 2n;      // on the sqrt, half the price tolerance
  const move = sqrtGap > target ? sqrtGap - target : 0n;
  if (move <= 0n) return jsonSafe(settled);

  const Q96 = 1n << 96n;
  const buyWei = (L[cheap] * Q96 * move) / ((10000n - move) * S[cheap]);
  const sellWei = (L[dear] * S[dear] * move) / (10000n * Q96);

  const pc = publicClient(c);
  const [nativeHere, omniHere, gasPrice, elsewhere] = await Promise.all([
    pc.getBalance({ address: who }).catch(() => 0n),
    pc.readContract({ address: getAddress(OMNI), abi: ERC20_ABI, functionName: 'balanceOf', args: [who] }).catch(() => 0n),
    pc.getGasPrice().catch(() => 0n),
    omniBalances(who),
  ]);
  const helper = arbHelperFor(c);
  // What the legs actually cost to send, not a round number: on a chain where
  // the whole balance is a third of a cent, an over-generous reserve is the
  // difference between doing the trade and reporting it as unaffordable. The
  // approve is only counted when the wallet has not already given one.
  const spender = helper && dear !== 'hooked' ? getAddress(helper) : getAddress(c.router);
  const approved = await allowanceOf(c, getAddress(OMNI), who, spender).catch(() => 0n);
  const gasReserve = gasPrice * (250_000n + (approved >= sellWei ? 0n : 50_000n));

  const plan = (side) => {
    const venue = side === 'buy' ? cheap : dear;
    const wei = side === 'buy' ? buyWei : sellWei;
    // Only the hooked pool has a router. The hookless one needs the OmniArb
    // helper, which is a one-off deploy this wallet can make itself.
    const needsHelper = venue !== 'hooked' && !helper;
    const src = side === 'sell' && omniHere < wei
      ? elsewhere.find((b) => b.c.id !== c.id && b.bal >= wei)?.c ?? null : null;
    // Everything that has to arrive before the leg can be signed, source or no
    // source: the page brings each one over, and a shortage left off this list
    // is one it never fixes and then retries into forever.
    const shorts = [];
    if (side === 'sell' && omniHere < wei) {
      shorts.push({ what: 'omni', needWei: (wei - omniHere).toString(), haveWei: omniHere.toString(), from: src?.short ?? null });
    }
    const native = side === 'buy' ? wei + gasReserve : gasReserve + (needsHelper ? gasPrice * 1_400_000n : 0n);
    if (nativeHere < native) shorts.push({ what: 'native', needWei: (native - nativeHere).toString(), haveWei: nativeHere.toString() });
    // Cheapest first: pay from what is here, then from OMNI this wallet holds
    // on another chain (a burn and a mint we drive ourselves), then a helper
    // deploy, and only last a native top-up — the one thing that needs money
    // this wallet may not have anywhere.
    const missing = shorts.some((x) => x.what === 'omni') && !src;
    const cost = missing ? 9 : shorts.some((x) => x.what === 'native') ? 3 : needsHelper ? 2 : src ? 1 : 0;
    return { side, venue, wei, needsHelper, src, shorts, cost,
      brief: { venue, side, amount: num(wei), unit: side === 'buy' ? c.nativeSymbol : 'OMNI' } };
  };

  const chosen = [plan('sell'), plan('buy')].sort((a, b) => a.cost - b.cost)[0];
  // Price is tokens per native, so native out is tokens in DIVIDED by it. The
  // sell leg pays the wallet; saying so is the difference between "this costs
  // you 880k OMNI" and "this is the profitable side of the arb".
  const proceeds = chosen.side === 'sell' ? (chosen.wei * Q96 * Q96) / (S[dear] * S[dear]) : null;
  const common = { chainId: c.id, gapBps: p.gapBps, cheap, legs: [chosen.brief],
    proceeds: proceeds == null ? null : num(proceeds) };

  if (chosen.needsHelper && !chosen.shorts.length) {
    return jsonSafe({ ...common, steps: [], needsHelper: true,
      note: `the ${chosen.venue} pool has no router — deploy the OmniArb helper here first` });
  }
  if (chosen.shorts.length) {
    return jsonSafe({ ...common, steps: [], needsHelper: chosen.needsHelper,
      short: chosen.shorts[0], shorts: chosen.shorts,
      source: chosen.src ? { id: chosen.src.id, short: chosen.src.short } : null });
  }

  const t = await txTrade({ ca: OMNI, chain: c.id, venue: chosen.venue, side: chosen.side,
    amount: formatUnits(chosen.wei, 18), from: who, slippageBps: 3000 });
  return jsonSafe({ ...common, steps: t.steps, needsHelper: false, short: null });
}

/**
 * Deploy the OmniArb helper, from the visitor's own wallet.
 *
 * omnichain's router only ever builds a PoolKey carrying its own hook, so the
 * hookless pool at the same CA is unreachable without this. It holds no state
 * and no balances between calls, and one per chain serves everybody.
 */
function txDeployHelper({ chain, from }) {
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const have = arbHelperFor(c);
  if (have) return jsonSafe({ chainId: c.id, address: getAddress(have), steps: [], skipped: true });
  const bytecode = ARTIFACT.bytecode?.object ?? ARTIFACT.bytecode;
  if (typeof bytecode !== 'string' || !/^0x[0-9a-fA-F]+$/.test(bytecode)) throw new Error('no helper bytecode in the build');
  return jsonSafe({ chainId: c.id, address: null, skipped: false, from: getAddress(from ?? RELAYER),
    steps: [{ label: `deploy the OmniArb helper on ${c.short}`, chainId: c.id, chainName: c.name,
      to: null, data: bytecode, value: '0x0',
      note: 'a stateless v4 swap helper — it is what makes the hookless pool reachable at all' }] });
}

/** Record a helper someone just deployed, after checking the code is really ours. */
async function apiHelper({ chain, address, hash }) {
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  let at = address ? getAddress(address) : null;
  if (!at && hash) {
    const rec = await publicClient(c).getTransactionReceipt({ hash });
    at = rec?.contractAddress ? getAddress(rec.contractAddress) : null;
  }
  if (!at) throw new Error('no address and no deployment receipt to read one from');
  const code = await publicClient(c).getBytecode({ address: at }).catch(() => null);
  const want = ARTIFACT.deployedBytecode?.object ?? ARTIFACT.deployedBytecode;
  if (!code || code === '0x') throw new Error(`nothing deployed at ${at} on ${c.name}`);
  // Metadata trailers differ per compile; the body is what has to match.
  if (typeof want === 'string' && code.slice(0, 200) !== want.slice(0, 200)) {
    throw new Error(`the code at ${at} is not the OmniArb helper`);
  }
  try { recordDeployment(c.id, at.toLowerCase()); } catch { /* read-only fs: in-memory is enough */ }
  return { chainId: c.id, address: at, recorded: true };
}

/**
 * Move one chain's share of the float to the relayer.
 *
 * Base is a transfer — the relayer is already on the chain the tokens are on.
 * Everywhere else it is a burn, and it refuses to build one for a chain where
 * the token does not exist yet: bridgeOut burns unconditionally while bridgeIn
 * mints into the token contract, so bridging ahead of the deploy destroys
 * supply that can never be minted. That mistake cost 269 million tokens once.
 */
async function txSeed({ ca, chain, from, amountWei, amount, donate }) {
  const token = getAddress(ca);
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const home = chainById(HOME_CHAIN);
  const who = getAddress(from);
  // The float that seeds a chain is the relayer's allocation, minted to it at
  // launch. Anyone else's balance is their position, and building a burn of it
  // here is how a creator's ape went out 24M at a time under the name of a
  // "share". Only the relayer's own wallet splits from here — or a holder who
  // says, on a button that says it, that they want to donate.
  if (who !== getAddress(RELAYER) && donate !== true) {
    throw new Error('the seeding float is the relayer\'s allocation, not your tokens — nothing to sign here');
  }

  // The caller fixes the share once and passes it as wei on every leg. Deriving
  // it here per chain takes a ninth of a balance that the previous leg just
  // reduced, so each chain gets less than the last: 182,012 then 161,789 then
  // 143,812, while the caller believes it is sending an equal split.
  let wei;
  if (amountWei != null && amountWei !== '') wei = BigInt(amountWei);
  else if (amount != null && amount !== '') wei = parseUnits(String(amount), 18);
  else {
    const held = await publicClient(home).readContract({ address: token, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [who] });
    wei = held / BigInt(CHAINS.length);
  }
  if (wei <= 0n) throw new Error('nothing to move — the launcher wallet holds no float on Base');

  if (c.id === HOME_CHAIN) {
    return jsonSafe({ steps: [step(`fund the relayer on ${c.short}`, home, token,
      encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(RELAYER), wei] }),
      0n, 'the relayer opens the pools from what it holds')],
      amount: num(wei), amountWei: wei.toString(), to: RELAYER });
  }

  if (!await isDeployedOn(c, token)) {
    throw new Error(`${token} is not deployed on ${c.name} yet — deploy first, or the burn destroys supply`);
  }
  return jsonSafe({
    steps: [step(`bridge the share to ${c.short}`, home, PORTAL,
      encodeFunctionData({ abi: PORTAL_ABI, functionName: 'bridgeOut',
        args: [token, BigInt(c.id), getAddress(RELAYER), wei] }),
      0n, `burns on Base; the relayer mints to itself on ${c.name} and opens the pools`)],
    amount: num(wei), amountWei: wei.toString(), to: RELAYER,
  });
}

/**
 * Top the relayer up with gas.
 *
 * `wall` is the relayer's own transaction, paid from the relayer's own wallet,
 * so when that wallet is dry the pools simply never open and the relay says so
 * in words: "relayer short on Arbitrum: has …, needs …, send … more". Nothing
 * else in the flow can proceed, and it is a plain native transfer to fix.
 */
async function txFundRelayer({ chain, amountWei, from, prefer, origin, recipient }) {
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const wei = BigInt(amountWei);
  // Gas goes to the relayer, or back to the wallet that is paying — the same
  // Relay hop lands native on a chain the wallet has never been on, which is
  // what an align on Polygon needs before it can trade there.
  const dest = recipient ? getAddress(recipient) : getAddress(RELAYER);
  if (from && dest !== getAddress(from) && dest !== getAddress(RELAYER)) throw new Error('recipient must be you or the relayer');
  const who_ = dest === getAddress(RELAYER) ? 'the relayer' : 'you';
  if (wei <= 0n) throw new Error('amount must be positive');
  // A cap, because this is parsed out of someone else's error string and the
  // shortfalls are cents: nothing here should ever be able to send real money.
  const CAP = parseEther('0.05');
  if (wei > CAP && c.nativeSymbol !== 'POL' && c.nativeSymbol !== 'MON') {
    throw new Error(`refusing to send ${formatUnits(wei, 18)} ${c.nativeSymbol} — gas top-ups are cents, this is not one`);
  }

  const direct = () => jsonSafe({
    route: 'direct', chainId: c.id,
    steps: [step(`send gas to ${who_} on ${c.short}`, c, dest, '0x', wei,
      `${formatUnits(wei, 18)} ${c.nativeSymbol} so it can open the pools`)],
    amount: num(wei), to: dest,
  });
  if (!from) return direct();

  const who = getAddress(from);
  const pc = publicClient(c);

  // Enough on the destination already? Then it is one transfer, and the reserve
  // is for the transfer's own gas. Unless the caller has asked for a relay hop:
  // a direct send means the wallet has to be ON that chain, and six of these
  // nine are chains no wallet ships with. A relay hop runs entirely on the chain
  // the wallet is already sitting on.
  // Relay unless a direct send costs nothing extra. A direct send means the
  // wallet must be ON the destination chain, and six of these nine are chains no
  // wallet ships with — asking it to add Polygon so it can forward 8 POL it does
  // not have is worse than paying two cents to Relay. So: direct only when the
  // wallet is already sitting there and already holds enough.
  if (prefer !== 'relay' && Number(origin) === c.id) {
    const here = await pc.getBalance({ address: who }).catch(() => 0n);
    const gasHere = await pc.getGasPrice().catch(() => 0n);
    if (here > wei + gasHere * 120_000n) return direct();
  }

  // Otherwise it has to come from a chain where there IS money. Assuming a
  // balance sits on the chain that needs it is how a top-up becomes an
  // insufficient-funds revert on a chain the user has never used.
  const [prices, supported] = await Promise.all([
    nativePrices().catch(() => null),
    supportedChains().catch(() => new Set()),
  ]);
  const balances = await Promise.all(CHAINS.map(async (src) => {
    if (src.id === c.id || !supported.has(src.id)) return null;
    const bal = await publicClient(src).getBalance({ address: who }).catch(() => 0n);
    const usd = prices?.byChain.get(src.id)?.usd ?? null;
    return { src, bal, usd: usd ? num(bal) * usd : 0 };
  }));
  // Richest first, but the chain the wallet is already on wins a tie by a mile:
  // every other choice costs a network switch the wallet may refuse.
  const ranked = balances.filter(Boolean).filter((b) => b.bal > 0n)
    .sort((a, b) => b.usd - a.usd)
    .sort((a, b) => Number(b.src.id === Number(origin)) - Number(a.src.id === Number(origin)));
  if (!ranked.length) {
    throw new Error(`no native balance anywhere Relay can route from — ${who} holds nothing to bridge`);
  }

  const tried = [];
  for (const { src } of ranked.slice(0, 4)) {
    try {
      // EXACT_OUTPUT: the relayer needs this much on the far side, not "about
      // this much minus the bridge fee".
      const q = await quoteNative({ from: src, to: c, amount: wei, address: who,
        recipient: dest, tradeType: 'EXACT_OUTPUT' });
      const steps = [];
      for (const st of q.steps ?? []) {
        for (const item of st.items ?? []) {
          if (item.status === 'complete' || !item.data?.to) continue;
          steps.push(step(`${st.action ?? 'relay'} on ${src.short}`, src, item.data.to,
            item.data.data ?? '0x', BigInt(item.data.value ?? '0'),
            `bridges ${formatUnits(wei, 18)} ${c.nativeSymbol} to ${who_} on ${c.name}`));
        }
      }
      if (!steps.length) throw new Error('relay returned no transaction to send');
      // The quote does not know what the wallet holds; a hop it cannot pay for
      // reaches the wallet as an insufficient-funds revert on a chain the person
      // did not choose. The next richest chain is the one to try instead.
      const bal = balances.find((b) => b?.src.id === src.id)?.bal ?? 0n;
      const cost = steps.reduce((a, st) => a + BigInt(st.value), 0n);
      if (bal < cost + cost / 50n) throw new Error(`holds ${formatUnits(bal, 18)} ${src.nativeSymbol}, the hop needs ${formatUnits(cost, 18)}`);
      return jsonSafe({
        route: 'relay', chainId: src.id, via: src.short, to: dest, amount: num(wei),
        spend: num(q.amountIn), costUsd: q.costUsd, seconds: q.timeEstimate, steps,
      });
    } catch (e) {
      tried.push(`${src.short}: ${String(e.message).split('\n')[0].slice(0, 90)}`);
    }
  }
  throw new Error(`no route to fund the relayer on ${c.name} — ${tried.join(' · ')}`);
}

/** Which of a chain's two pools are actually open — the check the relay's answer needs. */
async function apiPools(ca, chain) {
  const token = getAddress(ca);
  const c = chainById(chain);
  if (!c) throw new Error(`unknown chain ${chain}`);
  const [code, pools] = await Promise.all([
    publicClient(c).getBytecode({ address: token }).catch(() => null),
    fastPools(c, token).catch(() => []),
  ]);
  return jsonSafe({
    chain: c.short, deployed: Boolean(code && code !== '0x'),
    hooked: pools.some((p) => p.viaOmniRouter),
    hookless: pools.some((p) => !p.viaOmniRouter),
    pools: pools.map((p) => ({ kind: p.kind, tick: p.tick, liquidity: p.liquidity.toString() })),
  });
}

/**
 * A launch mark, when nobody supplied one.
 *
 * Deterministic from the ticker: the same symbol always gets the same colours,
 * so a retry after a failed upload does not quietly change the logo.
 */
function generateMark(symbol) {
  const hash = createHash('sha256').update(symbol.toUpperCase()).digest();
  const hue = (a) => `hsl(${(hash[a] * 360) / 256} 72% ${42 + (hash[a + 1] % 22)}%)`;
  const letters = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || '?';
  const size = letters.length > 3 ? 150 : letters.length > 2 ? 190 : 250;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${hue(0)}"/><stop offset="1" stop-color="${hue(4)}"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="96" fill="#0b0d11"/>
  <circle cx="256" cy="256" r="188" fill="url(#g)"/>
  <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
    font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="${size}"
    fill="#0b0d11">${letters}</text>
</svg>`;
}

/** uploadMetadata takes a path, not bytes, so the image lands on disk first. */
async function stageImage({ symbol, image, imageName }) {
  const dir = await mkdtemp(join(tmpdir(), 'omniarb-launch-'));
  if (!image) {
    const p = join(dir, `${symbol.toLowerCase()}.svg`);
    await writeFile(p, generateMark(symbol));
    return { path: p, generated: true };
  }
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(image);
  if (!m) throw new Error('image must be a data: URL');
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg' })[m[1]] ?? 'png';
  const name = (imageName && /^[\w.-]+$/.test(imageName)) ? imageName : `${symbol.toLowerCase()}.${ext}`;
  const p = join(dir, name);
  await writeFile(p, m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])));
  return { path: p, generated: false };
}


/** Native + token balance for one address on all nine chains. */
async function apiBag(address, ca) {
  const who = getAddress(address);
  const token = ca ? getAddress(ca) : null;
  const prices = await nativePrices().catch(() => null);
  const rows = await Promise.all(CHAINS.map(async (c) => {
    const pc = publicClient(c);
    const [nat, tok] = await Promise.all([
      pc.getBalance({ address: who }).catch(() => null),
      token ? pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] })
        .catch(() => null) : null,
    ]);
    const usd = prices?.byChain.get(c.id)?.usd ?? null;
    return { id: c.id, short: c.short, name: c.name, nativeSymbol: c.nativeSymbol,
      native: num(nat), nativeUsd: nat != null && usd ? num(nat) * usd : null,
      token: num(tok), explorer: c.explorer };
  }));
  return { address: who, chains: rows,
    nativeUsdTotal: rows.reduce((a, r) => a + (r.nativeUsd ?? 0), 0) };
}

/**
 * Burns that never minted, for one address.
 *
 * There is no database behind this and there does not need to be: the burn is a
 * `BridgeOut` log on the source Portal and the mint is `processed(messageId)` on
 * the destination Portal. The chain is the index. Filtering by the indexed
 * `sender` topic keeps the scan cheap enough to answer inside a request.
 */
async function apiPending(address, lookback, chain) {
  const who = getAddress(address);
  const span = BigInt(lookback ?? 20_000);
  const evOut = PORTAL_ABI.find((x) => x.type === 'event' && x.name === 'BridgeOut');

  // One chain per request. A nine-chain scan is nine chunked log walks and the
  // slowest one decides the whole answer — which on a 60s serverless budget
  // means no answer at all. The page fans these out and draws each as it lands.
  const sources = chain ? [chainById(chain)].filter(Boolean) : CHAINS;
  if (chain && !sources.length) throw new Error(`unknown chain ${chain}`);

  const burns = await Promise.all(sources.map(async (src) => {
    const pc = publicClient(src);
    try {
      const latest = await pc.getBlockNumber();
      const from = latest > span ? latest - span : 0n;
      const logs = await getLogsChunked(pc, {
        address: PORTAL, event: evOut, args: { sender: who }, fromBlock: from, toBlock: latest,
      });
      return logs.map((l) => ({ src, l }));
    } catch { return []; }
  }));

  // One processed() call per burn, all in flight together.
  const checked = await Promise.all(burns.flat().map(async ({ src, l }) => {
    const dst = chainById(Number(l.args.destChainId));
    if (!dst) return null;
    const done = await publicClient(dst).readContract({
      address: PORTAL, abi: PORTAL_ABI, functionName: 'processed', args: [l.args.messageId],
    }).catch(() => null);
    if (done !== false) return null;
    return {
      from: src.short, fromId: src.id, to: dst.short, toId: dst.id,
      token: l.args.token, recipient: l.args.to, amount: num(l.args.amount),
      messageId: l.args.messageId, nonce: l.args.nonce.toString(),
      txHash: l.transactionHash, txUrl: `${src.explorer}/tx/${l.transactionHash}`,
    };
  }));

  const stuck = checked.filter(Boolean).sort((a, b) => b.amount - a.amount);
  return jsonSafe({ address: who, chain: chain ? sources[0].short : null,
    stuck, scannedBlocks: Number(span), total: stuck.reduce((a, x) => a + (x.amount ?? 0), 0) });
}

// ---------------------------------------------------------------- stream
//
// Websockets, so the desk is live rather than polled.
//
// A 30-second poll of nine chains is 30 seconds of being wrong about a chain
// that moves every two — and it is the same nine requests whether anything
// happened or not. Alchemy speaks websockets on eight of the nine, so heads and
// factory deploys arrive when they happen and the page gets them over one SSE
// connection it did not have to ask for.
//
// The poll stays as the floor. Robinhood has no Alchemy network at all, and a
// socket that drops takes a moment to come back.

const clients = new Set();
const sockets = new Map();
const heads = new Map();

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }
}

/** One socket per chain: new heads, and every deploy the factory emits. */
function openSocket(c) {
  const url = alchemy.wsUrl(c.id);
  if (!url || sockets.has(c.id)) return;

  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  sockets.set(c.id, ws);
  let alive = true;

  // Wrapped, all of it: an exception inside a websocket event handler is
  // unhandled by construction — it killed the whole server the first time.
  ws.onopen = () => { try {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    // Only the factory: a launch is the one event on these chains worth waking
    // the page for, and subscribing to everything else would be a firehose.
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe',
      params: ['logs', { address: FACTORY, topics: [FACTORY_DEPLOY_TOPIC] }] }));
  } catch (e) { console.warn(`ws ${c.short}: ${e.message}`); } };

  ws.onmessage = (m) => { try {
    let j;
    try { j = JSON.parse(String(m.data)); } catch { return; }
    const r = j?.params?.result;
    if (!r) return;
    if (r.number) {
      const head = { id: c.id, short: c.short, block: Number(r.number),
        gas: Number(BigInt(r.baseFeePerGas ?? '0x0')) / 1e9 };
      heads.set(c.id, head);
      broadcast('head', head);
      return;
    }
    if (r.topics?.[0]?.toLowerCase() === FACTORY_DEPLOY_TOPIC) {
      // A launch: tell the page immediately and drop the discovery cache, so a
      // refresh does not serve a board that predates it.
      _discovered.clear();
      broadcast('launch', { chain: c.short, chainId: c.id,
        token: getAddress(`0x${r.topics[1].slice(26)}`), tx: r.transactionHash });
    }
  } catch (e) { console.warn(`ws ${c.short}: ${e.message}`); } };

  const reopen = () => {
    if (!alive) return;
    alive = false;
    sockets.delete(c.id);
    // Only while somebody is watching; an idle server should not hold nine
    // sockets open forever.
    if (clients.size) setTimeout(() => openSocket(c), 4000);
  };
  ws.onclose = reopen;
  ws.onerror = reopen;
}

function openSockets() { for (const c of CHAINS) openSocket(c); }
function closeSockets() {
  for (const [, ws] of sockets) { try { ws.close(); } catch { /* already gone */ } }
  sockets.clear();
}

function streamTo(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  clients.add(res);
  if (sockets.size === 0) openSockets();

  // Whatever is already known, so a page that just loaded is not blank until
  // the next block.
  res.write(`event: hello\ndata: ${JSON.stringify({
    chains: [...heads.values()], live: [...sockets.keys()],
    polled: CHAINS.filter((c) => !alchemy.covers(c.id)).map((c) => c.short),
  })}\n\n`);

  const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* gone */ } }, 25_000);
  const bye = () => {
    clearInterval(beat);
    clients.delete(res);
    if (!clients.size) closeSockets();
  };
  req.on('close', bye);
  req.on('error', bye);
}

// ------------------------------------------------------------- rpc proxy
//
// The page reads chain state itself (pool slots, code, balances) rather than
// asking this process for a pre-chewed answer, so the desk stays a thin client
// over real chain data. It cannot call the RPCs directly, though: half of them
// send no CORS header, and the ones that do are the ones with the tightest rate
// limits. So the same failover list the bot uses is exposed here, restricted to
// read methods.

/**
 * The app moves under us. Boot loads the current map; this notices when it moves
 * again while the process is up, because in-memory addresses cannot be swapped
 * safely mid-flight — the page shows a banner and the fix is a restart.
 */
let _stale = null;
async function watchConfig() {
  try {
    const live = await fetchLiveConfig();
    const now = chainById(HOME_CHAIN)?.launcher?.toLowerCase();
    if (live.launcher && now && live.launcher.toLowerCase() !== now) {
      _stale = { field: 'launcher', using: now, live: live.launcher, seenAt: new Date().toISOString() };
      console.warn(`launcher moved to ${live.launcher} (using ${now}) — restart to pick it up`);
    } else _stale = null;
  } catch { /* the site being unreachable is not evidence of staleness */ }
}

const RPC_OK = new Set(['eth_blockNumber', 'eth_gasPrice', 'eth_call', 'eth_getCode',
  'eth_getBalance', 'eth_chainId', 'eth_getLogs', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_estimateGas', 'eth_maxPriorityFeePerGas']);

/**
 * What a wallet needs, which is more than the page does.
 *
 * This is the endpoint handed to wallet_addEthereumChain, so the wallet's own
 * traffic lands on Alchemy instead of on whatever public node it was given —
 * "eth_getBlockByNumber: Request is being rate limited" on BNB was the wallet
 * being throttled, not us.
 *
 * eth_sendRawTransaction is on the list deliberately: it carries a transaction
 * the wallet has already signed, so broadcasting it is not a privilege anyone
 * gains by pointing at this. Nothing that could sign, or read an account, is.
 */
const WALLET_RPC_OK = new Set([...RPC_OK,
  'eth_sendRawTransaction', 'eth_getTransactionCount', 'eth_getTransactionByHash',
  'eth_getBlockByHash', 'eth_feeHistory', 'eth_getStorageAt', 'eth_getProof',
  'net_version', 'web3_clientVersion', 'eth_syncing', 'eth_getBlockReceipts',
  'eth_createAccessList', 'eth_getFilterChanges', 'eth_newBlockFilter',
  'eth_uninstallFilter', 'eth_subscribe', 'eth_unsubscribe', 'eth_blobBaseFee']);

async function rpcProxy(chainId, payload, allow = RPC_OK) {
  const c = chainById(chainId);
  if (!c) throw new Error(`unknown chain ${chainId}`);
  const calls = Array.isArray(payload) ? payload : [payload];
  for (const call of calls) {
    if (!allow.has(call?.method)) throw new Error(`method not proxied: ${call?.method}`);
  }
  let last = null;
  for (const url of rpcsFor(c)) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) { last = new Error(`rpc ${r.status}`); continue; }
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last ?? new Error('no rpc answered');
}

// -------------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

const routes = {
  '/api/tokens': () => apiTokens(),
  '/api/discover': (q) => apiDiscover(q.get('lookback'), q.get('deep') === '1'),
  '/api/token': (q) => apiToken(q.get('ca')),
  '/api/supply': (q) => apiSupply(q.get('ca')),
  '/api/stuck': (q) => apiStuck(q.get('ca')),
  '/api/chart': (q) => apiChart(q.get('ca'), q.get('chain') ?? HOME_CHAIN, q.get('type') ?? '15m', q.get('hours') ?? 24),
  '/api/charts': (q) => apiCharts(q.get('ca'), q.get('type') ?? '15m', q.get('hours') ?? 24),
  '/api/curve': (q) => apiCurve(q.get('ca'), q.get('eth'), q.get('tok'), q.get('chain')),
  '/api/quote': (q) => apiQuote(q.get('ca'), q.get('chain'), q.get('venue') ?? 'hooked',
    q.get('side') ?? 'buy', q.get('amount') ?? '0'),
  '/api/bag': (q) => apiBag(q.get('address'), q.get('ca')),
  '/api/config': () => {
    const live = readLiveConfig();
    return { factory: live?.factory ?? null, portal: live?.portal ?? null,
      launcher: chainById(HOME_CHAIN)?.launcher ?? null,
      deployment: live?.deployment ?? null, fetchedAt: live?.fetchedAt ?? null, stale: _stale };
  },
  '/api/me': () => ({
    // No signing here, by design: the desk is a dapp and the visitor's wallet
    // signs. What the page needs from this process is the chain map — including
    // an rpc per chain, so a wallet can be asked to add a chain it lacks.
    signing: 'wallet',
    chains: CHAINS.map((c) => ({ id: c.id, short: c.short, name: c.name, explorer: c.explorer,
      nativeSymbol: c.nativeSymbol,
      // The PUBLIC endpoints only, and never rpcsFor(): that list is led by the
      // keyed Alchemy URL, and this object goes to every visitor. These exist so
      // a wallet can be asked to add a chain it does not know, which the wallet
      // then calls itself — a key in there would be a key handed to every
      // browser that loads the page.
      rpcs: [...c.rpcs], rpc: c.rpcs[0],
      poolManager: c.poolManager, hook: c.hook,
      router: c.router, launcher: c.launcher ?? null, helper: arbHelperFor(c),
      birdeye: be.nameOf(c.id) })),
    portal: PORTAL, pad: PAD, homeChain: HOME_CHAIN, stale: _stale,
  }),
  '/api/be': (q) => {
    const path = q.get('path');
    const chain = q.get('chain');
    const params = {};
    for (const [k, v] of q) if (!['path', 'chain'].includes(k)) params[k] = v;
    return be.passthrough(path, params, chain);
  },
  '/api/pending': (q) => apiPending(q.get('address'), q.get('lookback'), q.get('chain')),
  '/api/pools': (q) => apiPools(q.get('ca'), q.get('chain')),
  '/api/seedstate': (q) => apiSeedState(q.get('ca'), q.get('address'), q.get('hash')),
  '/api/launchready': (q) => apiLaunchReady(q.get('token')),
  // Name and symbol off the contract, logo off the site's index: a CA seeded in
  // a later session has no launch form to read them from, and the remote deploy
  // cannot be made without them.
  '/api/meta': async (q) => {
    const m = await recoverMeta(getAddress(q.get('ca')));
    if (!m) throw new Error('that address does not answer name() and symbol() on Base');
    return m;
  },
  '/api/minted': (q) => apiMinted({ chain: q.get('chain'), messageId: q.get('messageId') }),
};

/**
 * POST endpoints. None of them signs anything.
 *
 * The `/api/tx/*` ones quote against live state and hand back unsigned
 * transactions for the visitor's wallet. The others forward the two calls a
 * browser cannot make itself: the multipart metadata upload, and the relayer's
 * permissioned deploy / wall / mint.
 */
const writeRoutes = {
  '/api/tx/trade': (b) => txTrade(b),
  '/api/tx/bridge': (b) => txBridge(b),
  '/api/tx/seed': (b) => txSeed(b),
  '/api/tx/fundrelayer': (b) => txFundRelayer(b),
  '/api/tx/stockomni': (b) => txStockOmni(b),
  '/api/tx/deployhelper': (b) => txDeployHelper(b),
  '/api/helper': (b) => apiHelper(b),
  '/api/tx/align': (b) => txAlign(b),
  '/api/tx/launch': (b) => txLaunch(b),
  '/api/metadata': (b) => apiMetadata(b),
  '/api/relay': (b) => apiRelay(b),
  '/api/mint': (b) => apiMint(b),
  '/api/launched': (b) => apiLaunched(b),
};

/** Every secret this process holds, so no response can carry one out. */
const SECRETS = () => [process.env.ALCHEMY_KEY, process.env.ETHERSCAN_KEY, process.env.BIRDEYE_KEY,
  process.env.STACCOVERFLOW_KP, alchemy.httpUrl(HOME_CHAIN)?.split('/v2/')[1]]
  .filter((x) => typeof x === 'string' && x.length > 12);

function redactSecrets(text, where) {
  let out = text;
  for (const secret of SECRETS()) {
    if (!out.includes(secret)) continue;
    console.error(`REDACTED a secret from the response to ${where} — fix the endpoint`);
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (d) => {
    size += d.length;
    if (size > 8_000_000) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch (e) { reject(new Error(`bad json body: ${e.message}`)); }
  });
  req.on('error', reject);
});

/**
 * The whole app as one handler, so it can run behind `node server.mjs` on a box
 * that holds a key, or as a single serverless function on a host that must not.
 */
export async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    // Buffers (static files) must go out as-is; stringifying one yields
    // {"type":"Buffer","data":[…]} and serves a broken page with a 200.
    let out = (Buffer.isBuffer(body) || typeof body === 'string') ? body : JSON.stringify(body);
    // Last line of defence. /api/me leaked the Alchemy key the moment Alchemy
    // became the first entry in rpcsFor() — nothing about that edit looked like
    // it touched a secret. A key never reaches a browser from here again,
    // whoever writes the next endpoint.
    if (typeof out === 'string') out = redactSecrets(out, url.pathname);
    res.end(out);
  };

  // /rpc/<chainId> is the wallet-facing endpoint. A wallet is not a browser
  // page: it calls this from the extension, so it gets CORS and the wider
  // method list.
  const walletRpc = /^\/rpc\/(\d+)$/.exec(url.pathname);
  if (walletRpc) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { send(405, { error: 'post json-rpc here' }); return; }
    try { send(200, await rpcProxy(walletRpc[1], await readBody(req), WALLET_RPC_OK)); }
    catch (e) {
      send(200, { jsonrpc: '2.0', id: null,
        error: { code: -32601, message: String(e.message).split('\n')[0] } });
    }
    return;
  }

  if (req.method === 'POST') {
    if (url.pathname === '/api/rpc') {
      try { send(200, await rpcProxy(url.searchParams.get('chain'), await readBody(req))); }
      catch (e) { send(400, { error: String(e.message).split('\n')[0] }); }
      return;
    }
    const w = writeRoutes[url.pathname];
    if (!w) { send(404, { error: 'not found' }); return; }
    try {
      send(200, await w(await readBody(req)));
    } catch (e) {
      send(400, { error: String(e.message ?? e).split('\n')[0] });
    }
    return;
  }

  if (url.pathname === '/api/stream') { streamTo(req, res); return; }

  const route = routes[url.pathname];
  if (route) {
    try {
      send(200, await route(url.searchParams));
    } catch (e) {
      send(500, { error: String(e.message ?? e).split('\n')[0] });
    }
    return;
  }

  // The desk is the site. omniview — the older, read-only explorer this grew out
  // of — keeps its own path rather than the front door.
  const PAGES = { '/': 'desk.html', '/desk': 'desk.html', '/explore': 'index.html', '/omniview': 'index.html' };
  const file = PAGES[url.pathname] ?? url.pathname.replace(/^\/+/, '');
  try {
    const buf = await readFile(join(here, 'public', file));
    send(200, buf, MIME[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(404, { error: 'not found' });
  }
}

export default handler;

/** Bind a port. Not done on import: a serverless wrapper only wants the handler. */
export function start() {
  return createServer(handler).listen(PORT, HOST, () => {
    console.log(`desk       http://${HOST}:${PORT}/`);
    console.log(`omniview   http://${HOST}:${PORT}/explore`);
    console.log(`birdeye covers ${paintable().map((c) => c.short).join(', ')}` +
      ` · pool-derived prices on ${CHAINS.filter((c) => !be.covers(c.id)).map((c) => c.short).join(', ')}`);
    console.log('no key here: the visitor’s wallet signs every transaction');
    watchConfig();
    setInterval(watchConfig, 10 * 60_000).unref();
  }).on('error', (e) => { console.error(e.message); process.exit(1); });
}

// Run directly rather than through site/boot.mjs: still binds, but with whatever
// contract addresses happen to be on disk.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
