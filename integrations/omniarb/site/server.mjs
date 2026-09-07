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
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { formatUnits, parseUnits, parseEther, getAddress } from 'viem';

import { CHAINS, chainById, HOME_CHAIN, PORTAL, PORTAL_ABI, ERC20_ABI, PAD, PAD_ABI,
  NATIVE, POOL_FEE, POOL_TICK_SPACING, rpcsFor } from '../src/config.mjs';
import { publicClient } from '../src/chain.mjs';
import { fetchIndexedTokens, fetchLaunchedTokens, discoverCurve, getLogsChunked, poolId,
  readPoolState, tokenMeta } from '../src/discovery.mjs';
import { nativePrices, toUsd } from '../src/prices.mjs';
import { loadAccount } from '../src/chain.mjs';
import { quoteBuy, quoteSell } from '../src/quote.mjs';
import { buyOnVenue, sellOnVenue } from '../src/exec.mjs';
import { bridge } from '../src/bridge.mjs';
import { launchOnBase, seedAll, uploadMetadata, curveSqrtPrice } from '../src/launch.mjs';
import * as be from './birdeye.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
// Loopback by default: the write endpoints below sign with a real key, and a
// dashboard that can spend money should not be reachable just because it was
// started on a box with a public interface. HOST=0.0.0.0 is opt-in.
const HOST = process.env.HOST || '127.0.0.1';

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

let _discovered = { at: 0, value: null };

async function apiDiscover(lookback) {
  if (_discovered.value && Date.now() - _discovered.at < 60_000) return _discovered.value;
  const [indexed, launched] = await Promise.all([
    fetchIndexedTokens().catch(() => []),
    fetchLaunchedTokens({ lookbackBlocks: BigInt(lookback ?? 200_000) }).catch(() => []),
  ]);

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
  const extra = launched.filter((l) => !rows.has(l.address.toLowerCase()));
  await Promise.all(extra.map(async (l) => {
    const m = await tokenMeta(chainById(l.launchChain) ?? home, l.address).catch(() => null);
    rows.set(l.address.toLowerCase(), {
      address: l.address, name: m?.symbol ?? null, symbol: m?.symbol ?? '?', tagline: null,
      createdAt: null, chains: [], source: 'launcher-event',
      block: l.blockNumber ? Number(l.blockNumber) : null,
    });
  }));

  const value = {
    tokens: [...rows.values()].sort((a, b) => (b.block ?? 0) - (a.block ?? 0)),
    indexed: indexed.length, fromEvents: extra.length,
  };
  _discovered = { at: Date.now(), value };
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

async function apiCurve(ca, sizeEth, sizeTok) {
  const token = getAddress(ca);
  const pc = publicClient(chainById(HOME_CHAIN));
  const read = (fn, args = []) => pc.readContract({ address: PAD, abi: PAD_ABI, functionName: fn, args })
    .catch(() => null);

  const price = await read('currentCurvePrice', [token]);
  const onCurve = price !== null && price > 0n;
  const [curveSupply, held] = await Promise.all([
    read('CURVE_SUPPLY'),
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [PAD] }).catch(() => null),
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
    address: token, onCurve, graduated: !onCurve,
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

// -------------------------------------------------------------- write side
//
// Everything below signs with the operator key. It is off unless the process was
// started with OMNIVIEW_WRITE=1 AND the key is present, and the server binds to
// loopback by default — a dashboard that can spend money should not be one
// misconfigured bind away from the open internet.

const CAN_WRITE = process.env.OMNIVIEW_WRITE === '1' && Boolean(process.env.STACCOVERFLOW_KP);
let _account = null;
function operator() {
  if (!CAN_WRITE) {
    throw new Error('write endpoints are off — start with OMNIVIEW_WRITE=1 and STACCOVERFLOW_KP set');
  }
  _account ??= loadAccount();
  return _account;
}

/**
 * Jobs, because a launch takes minutes.
 *
 * A launch is: upload metadata, sign on Base, deploy the CA on eight more
 * chains, split the float, bridge it out, wait for eight relayer mints, open
 * eighteen pools. Holding an HTTP request open across that is how you end up
 * with a proxy timeout in the middle of a bridge and no record of where it got
 * to — so the request starts the job and the page follows the steps.
 */
const jobs = new Map();

function startJob(kind, meta, fn) {
  const id = randomUUID().slice(0, 8);
  const job = { id, kind, meta, state: 'running', steps: [], startedAt: Date.now(),
    result: null, error: null };
  jobs.set(id, job);
  const step = (s) => { job.steps.push({ at: Date.now(), text: String(s) }); };
  step(`${kind} started`);
  fn(step)
    .then((r) => { job.result = jsonSafe(r ?? null); job.state = 'done'; step(`${kind} done`); })
    .catch((e) => { job.error = String(e.message ?? e).split('\n')[0]; job.state = 'error'; step(`failed: ${job.error}`); })
    .finally(() => { job.endedAt = Date.now(); });
  return { id, kind, state: job.state };
}

const jobView = (j) => ({ id: j.id, kind: j.kind, meta: j.meta, state: j.state,
  steps: j.steps, result: j.result, error: j.error,
  startedAt: j.startedAt, endedAt: j.endedAt ?? null });

/**
 * A launch mark, when nobody supplied one.
 *
 * Deterministic from the ticker: the same symbol always gets the same colours,
 * so a re-run of a failed launch does not quietly change the logo the metadata
 * upload already registered.
 */
function generateMark(symbol) {
  const h = createHash('sha256').update(symbol.toUpperCase()).digest();
  const hue = (a) => `hsl(${(h[a] * 360) / 256} 72% ${42 + (h[a + 1] % 22)}%)`;
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

/** Write the launch image to disk: uploadMetadata takes a path, not bytes. */
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

function apiLaunch(body) {
  const account = operator();
  const symbol = String(body.symbol ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (!symbol || !name) throw new Error('name and symbol are required');
  const seed = body.seed !== false;

  return startJob('launch', { name, symbol }, async (step) => {
    const img = await stageImage({ symbol, image: body.image, imageName: body.imageName });
    step(img.generated ? `generated a mark for ${symbol}` : `staged ${body.imageName ?? 'the supplied image'}`);

    const meta = await uploadMetadata({ file: img.path, name, symbol,
      description: body.description ?? body.tagline ?? '' });
    step(`metadata uploaded — ${meta.logoURI}`);

    const launched = await launchOnBase({ account, name, symbol,
      tagline: body.tagline ?? '', logoURI: meta.logoURI,
      targetRaiseEth: body.targetRaiseEth ?? '0.06',
      creatorBuyEth: body.creatorBuyEth ?? '0',
      dryRun: false });
    step(`launched on Base — ${launched.token} (${launched.explorer})`);

    if (!seed) return { token: launched.token, hash: launched.hash, seeded: false };

    const seeded = await seedAll({ account, token: launched.token,
      meta: { name, symbol, tagline: body.tagline ?? '', logoURI: meta.logoURI },
      dryRun: false, onStep: step });
    return { token: launched.token, hash: launched.hash, seeded: true, results: seeded.results };
  });
}

function apiSeed(body) {
  const account = operator();
  const token = getAddress(body.ca);
  return startJob('seed', { token }, async (step) => {
    const r = await seedAll({ account, token, dryRun: false, onStep: step });
    return { token, results: r.results };
  });
}

function apiBridge(body) {
  const account = operator();
  const token = getAddress(body.ca);
  const src = chainById(body.from);
  const dst = chainById(body.to);
  if (!src || !dst) throw new Error('from and to must both be known chain ids');
  if (src.id === dst.id) throw new Error('source and destination are the same chain');
  const amount = parseUnits(String(body.amount), 18);
  if (amount <= 0n) throw new Error('amount must be positive');

  return startJob('bridge', { token, from: src.short, to: dst.short, amount: String(body.amount) },
    async (step) => {
      step(`burning ${body.amount} on ${src.short}…`);
      const r = await bridge({ src, dst, account, token, amount, wait: body.wait !== false });
      step(`burned: ${src.explorer}/tx/${r.hash}`);
      if (r.arrived === false) step('relayer has not minted yet — recorded as pending');
      else if (r.arrived) step(`minted on ${dst.short}`);
      return r;
    });
}

function apiTrade(body) {
  const account = operator();
  const token = getAddress(body.ca);
  const c = chainById(body.chain);
  if (!c) throw new Error(`unknown chain ${body.chain}`);
  const kind = String(body.venue ?? 'hooked');
  if (kind === 'curve' && c.id !== HOME_CHAIN) throw new Error('the curve only exists on Base');
  const v = venueFor(c, kind, token);
  const side = body.side === 'sell' ? 'sell' : 'buy';
  const amount = parseUnits(String(body.amount), 18);
  if (amount <= 0n) throw new Error('amount must be positive');
  const slippageBps = BigInt(body.slippageBps ?? (side === 'buy' ? 1000 : 1500));

  return startJob(side, { token, chain: c.short, venue: v.kind, amount: String(body.amount) },
    async (step) => {
      step(`${side} ${body.amount} on ${c.short} ${v.kind} (slippage ${slippageBps}bps)`);
      const r = side === 'buy'
        ? await buyOnVenue(c, account, token, v, amount, { slippageBps })
        : await sellOnVenue(c, account, token, v, amount, { slippageBps });
      step(r.explorer);
      return { ...r, receivedFmt: num(r.received) };
    });
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

// ------------------------------------------------------------- rpc proxy
//
// The page reads chain state itself (pool slots, code, balances) rather than
// asking this process for a pre-chewed answer, so the desk stays a thin client
// over real chain data. It cannot call the RPCs directly, though: half of them
// send no CORS header, and the ones that do are the ones with the tightest rate
// limits. So the same failover list the bot uses is exposed here, restricted to
// read methods.

const RPC_OK = new Set(['eth_blockNumber', 'eth_gasPrice', 'eth_call', 'eth_getCode',
  'eth_getBalance', 'eth_chainId', 'eth_getLogs', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_estimateGas', 'eth_maxPriorityFeePerGas']);

async function rpcProxy(chainId, payload) {
  const c = chainById(chainId);
  if (!c) throw new Error(`unknown chain ${chainId}`);
  const calls = Array.isArray(payload) ? payload : [payload];
  for (const call of calls) {
    if (!RPC_OK.has(call?.method)) throw new Error(`method not proxied: ${call?.method}`);
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
  '/api/discover': (q) => apiDiscover(q.get('lookback')),
  '/api/token': (q) => apiToken(q.get('ca')),
  '/api/supply': (q) => apiSupply(q.get('ca')),
  '/api/stuck': (q) => apiStuck(q.get('ca')),
  '/api/chart': (q) => apiChart(q.get('ca'), q.get('chain') ?? HOME_CHAIN, q.get('type') ?? '15m', q.get('hours') ?? 24),
  '/api/charts': (q) => apiCharts(q.get('ca'), q.get('type') ?? '15m', q.get('hours') ?? 24),
  '/api/curve': (q) => apiCurve(q.get('ca'), q.get('eth'), q.get('tok')),
  '/api/quote': (q) => apiQuote(q.get('ca'), q.get('chain'), q.get('venue') ?? 'hooked',
    q.get('side') ?? 'buy', q.get('amount') ?? '0'),
  '/api/bag': (q) => apiBag(q.get('address'), q.get('ca')),
  '/api/me': () => ({
    canWrite: CAN_WRITE,
    address: CAN_WRITE ? operator().address : null,
    chains: CHAINS.map((c) => ({ id: c.id, short: c.short, name: c.name, explorer: c.explorer,
      nativeSymbol: c.nativeSymbol, poolManager: c.poolManager, hook: c.hook, router: c.router,
      launcher: c.launcher ?? null, birdeye: be.nameOf(c.id) })),
    portal: PORTAL, pad: PAD, homeChain: HOME_CHAIN,
  }),
  '/api/be': (q) => {
    const path = q.get('path');
    const chain = q.get('chain');
    const params = {};
    for (const [k, v] of q) if (!['path', 'chain'].includes(k)) params[k] = v;
    return be.passthrough(path, params, chain);
  },
  '/api/jobs': () => ({ jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40).map(jobView) }),
  '/api/job': (q) => {
    const j = jobs.get(q.get('id'));
    if (!j) throw new Error('no such job');
    return jobView(j);
  },
};

/** POST bodies all start work that signs. Each returns a job handle, not a result. */
const writeRoutes = {
  '/api/launch': (b) => apiLaunch(b),
  '/api/seed': (b) => apiSeed(b),
  '/api/bridge': (b) => apiBridge(b),
  '/api/trade': (b) => apiTrade(b),
};

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
    if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
    else res.end(JSON.stringify(body));
  };

  if (req.method === 'POST') {
    if (url.pathname === '/api/rpc') {
      try { send(200, await rpcProxy(url.searchParams.get('chain'), await readBody(req))); }
      catch (e) { send(400, { error: String(e.message).split('\n')[0] }); }
      return;
    }
    const w = writeRoutes[url.pathname];
    if (!w) { send(404, { error: 'not found' }); return; }
    try {
      send(202, w(await readBody(req)));
    } catch (e) {
      // A refused write is a 403 when it is the gate, not the request.
      const msg = String(e.message ?? e).split('\n')[0];
      send(msg.startsWith('write endpoints are off') ? 403 : 400, { error: msg });
    }
    return;
  }

  const route = routes[url.pathname];
  if (route) {
    try {
      send(200, await route(url.searchParams));
    } catch (e) {
      send(500, { error: String(e.message ?? e).split('\n')[0] });
    }
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  try {
    const buf = await readFile(join(here, 'public', file));
    send(200, buf, MIME[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(404, { error: 'not found' });
  }
}

export default handler;

// Started directly (rather than imported by a serverless wrapper): bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer(handler).listen(PORT, HOST, () => {
    console.log(`omniview   http://${HOST}:${PORT}/`);
    console.log(`desk       http://${HOST}:${PORT}/desk.html`);
    console.log(`birdeye covers ${paintable().map((c) => c.short).join(', ')}` +
      ` · pool-derived prices on ${CHAINS.filter((c) => !be.covers(c.id)).map((c) => c.short).join(', ')}`);
    console.log(CAN_WRITE
      ? `signing as ${operator().address} — launch / bridge / trade are LIVE`
      : 'read-only: set OMNIVIEW_WRITE=1 with STACCOVERFLOW_KP to enable launch / bridge / trade');
  }).on('error', (e) => { console.error(e.message); process.exit(1); });
}
