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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { formatUnits, getAddress } from 'viem';

import { CHAINS, chainById, HOME_CHAIN, PORTAL, PORTAL_ABI, ERC20_ABI, PAD, PAD_ABI,
  NATIVE, POOL_FEE, POOL_TICK_SPACING } from '../src/config.mjs';
import { publicClient } from '../src/chain.mjs';
import { fetchIndexedTokens, discoverCurve, getLogsChunked, poolId, readPoolState } from '../src/discovery.mjs';
import { nativePrices, toUsd } from '../src/prices.mjs';
import * as be from './birdeye.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

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

// -------------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const routes = {
  '/api/tokens': () => apiTokens(),
  '/api/token': (q) => apiToken(q.get('ca')),
  '/api/supply': (q) => apiSupply(q.get('ca')),
  '/api/stuck': (q) => apiStuck(q.get('ca')),
  '/api/chart': (q) => apiChart(q.get('ca'), q.get('chain') ?? HOME_CHAIN, q.get('type') ?? '15m', q.get('hours') ?? 24),
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    // Buffers (static files) must go out as-is; stringifying one yields
    // {"type":"Buffer","data":[…]} and serves a broken page with a 200.
    if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
    else res.end(JSON.stringify(body));
  };

  const route = routes[url.pathname];
  if (route) {
    try {
      send(200, await route(url.searchParams));
    } catch (e) {
      send(500, { error: e.message.split('\n')[0] });
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
}).listen(PORT, () => {
  console.log(`omniview on http://localhost:${PORT}`);
  console.log(`birdeye covers ${CHAINS.filter((c) => be.covers(c.id)).map((c) => c.short).join(', ')}` +
    ` · pool-derived prices elsewhere`);
});
