// Finding what to trade, and where it can be traded.
//
// Tokens come from omnichain.family's own index, backfilled from the launcher's
// OmniLaunched events so a token is tradable the moment it lands rather than
// whenever the site's indexer catches up.
//
// Venues are discovered per chain from the v4 PoolManager's Initialize events.
// This matters: every CA has at least TWO pools per chain — the hooked pool the
// site's router trades, and a hookless (hooks == 0x0) pool it cannot reach. The
// two drift apart, which is where most of the edge lives.

import { getAddress } from 'viem';
import { API, CHAINS, chainById, NATIVE, POOL_FEE, POOL_TICK_SPACING, POOLS_SLOT,
  PAD, PAD_ABI, HOME_CHAIN, ERC20_ABI, POOL_MANAGER_ABI,
  V4_INITIALIZE_EVENT, OMNI_LAUNCHED_EVENT } from './config.mjs';
import { publicClient } from './chain.mjs';
import { keccak256, encodeAbiParameters } from 'viem';

/** Tokens the site has indexed. */
export async function fetchIndexedTokens() {
  const r = await fetch(`${API}/api/launches`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`/api/launches -> HTTP ${r.status}`);
  const j = await r.json();
  return (j.tokens || []).map((t) => ({
    address: getAddress(t.address), name: t.name, symbol: t.symbol,
    tagline: t.tagline, createdAt: t.createdAt, salt: t.salt,
    blockNumber: t.blockNumber, indexedChains: (t.chains || []).map((c) => c.id),
  }));
}

/**
 * Tokens straight from the launcher's own events — this catches launches the
 * site's index has not picked up yet.
 */
export async function fetchLaunchedTokens({ lookbackBlocks = 200_000n } = {}) {
  const out = new Map();
  for (const c of CHAINS.filter((x) => x.launcher)) {
    const pc = publicClient(c);
    try {
      const latest = await pc.getBlockNumber();
      const from = latest - lookbackBlocks > c.factoryFromBlock ? latest - lookbackBlocks : c.factoryFromBlock;
      const logs = await getLogsChunked(pc, {
        address: c.launcher, event: OMNI_LAUNCHED_EVENT, fromBlock: from, toBlock: latest,
      });
      for (const l of logs) {
        const a = getAddress(l.args.token);
        if (!out.has(a)) out.set(a, { address: a, launchChain: c.id, blockNumber: l.blockNumber, salt: l.args.salt });
      }
    } catch { /* a launcher-less or rate-limited chain is not fatal */ }
  }
  return [...out.values()];
}

/** getLogs with an automatic fallback to fixed-size ranges for strict RPCs. */
export async function getLogsChunked(pc, params, span = 5000n) {
  try {
    return await pc.getLogs(params);
  } catch {
    const out = [];
    for (let a = params.fromBlock; a <= params.toBlock; a += span) {
      const b = a + span - 1n > params.toBlock ? params.toBlock : a + span - 1n;
      try { out.push(...await pc.getLogs({ ...params, fromBlock: a, toBlock: b })); } catch { /* skip */ }
    }
    return out;
  }
}

export const poolId = (key) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

const poolStateSlot = (id) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, POOLS_SLOT]));
const addSlot = (h, n) => `0x${(BigInt(h) + BigInt(n)).toString(16).padStart(64, '0')}`;

/** slot0 + liquidity straight out of the PoolManager, no periphery needed. */
export async function readPoolState(c, id) {
  const pc = publicClient(c);
  const base = poolStateSlot(id);
  const [s0, lq] = await Promise.all([
    pc.readContract({ address: c.poolManager, abi: POOL_MANAGER_ABI, functionName: 'extsload', args: [base] }),
    pc.readContract({ address: c.poolManager, abi: POOL_MANAGER_ABI, functionName: 'extsload', args: [addSlot(base, 3)] }),
  ]);
  const v = BigInt(s0);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick >= 1 << 23) tick -= 1 << 24;
  const liquidity = BigInt(lq) & ((1n << 128n) - 1n);
  // currency0 is native, currency1 is the token, so this is tokens per native.
  const tokensPerNative = Number(sqrtPriceX96) ** 2 / 2 ** 192;
  return { sqrtPriceX96, tick, liquidity, tokensPerNative, initialized: sqrtPriceX96 > 0n };
}

/**
 * Every v4 pool that exists for `token` on `c`, hooked and hookless alike,
 * annotated with live price and liquidity.
 */
export async function discoverPools(c, token) {
  const pc = publicClient(c);
  const found = new Map();

  // The canonical pair the launcher creates: native/token, fee 3000, spacing 60,
  // once with the chain's hook and once with no hook at all.
  for (const hooks of [c.hook, NATIVE]) {
    const key = { currency0: NATIVE, currency1: getAddress(token), fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: getAddress(hooks) };
    found.set(poolId(key).toLowerCase(), key);
  }

  // Anything else anyone initialized against this CA.
  try {
    const latest = await pc.getBlockNumber();
    for (const args of [{ currency1: token }, { currency0: token }]) {
      const logs = await getLogsChunked(pc, {
        address: c.poolManager, event: V4_INITIALIZE_EVENT, args,
        fromBlock: c.factoryFromBlock, toBlock: latest,
      });
      for (const l of logs) {
        const key = {
          currency0: getAddress(l.args.currency0), currency1: getAddress(l.args.currency1),
          fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: getAddress(l.args.hooks),
        };
        found.set(poolId(key).toLowerCase(), key);
      }
    }
  } catch { /* event scan is best-effort; the canonical pair is always covered */ }

  const venues = [];
  for (const [id, key] of found) {
    let state = null;
    try { state = await readPoolState(c, id); } catch { /* unreadable */ }
    if (!state?.initialized) continue;
    venues.push({
      kind: key.hooks.toLowerCase() === NATIVE ? 'v4-vanilla' : 'v4-hooked',
      chainId: c.id, poolId: id, key, ...state,
      // Only the hooked pool is reachable through omnichain's router; the
      // hookless one needs our own OmniArb helper.
      viaOmniRouter: key.hooks.toLowerCase() === c.hook.toLowerCase(),
      nativeIsCurrency0: key.currency0.toLowerCase() === NATIVE,
    });
  }
  return venues;
}

/** The Base bonding curve, when the token has not graduated off it yet. */
export async function discoverCurve(token) {
  const c = chainById(HOME_CHAIN);
  const pc = publicClient(c);
  try {
    const price = await pc.readContract({ address: PAD, abi: PAD_ABI, functionName: 'currentCurvePrice', args: [token] });
    if (price === 0n) return null; // graduated, or never on the pad
    return { kind: 'curve', chainId: c.id, pad: PAD, price };
  } catch { return null; }
}

/** Which chains this CA is actually deployed on. */
export async function liveChains(token) {
  const out = [];
  await Promise.all(CHAINS.map(async (c) => {
    try {
      const code = await publicClient(c).getBytecode({ address: token });
      if (code && code !== '0x') out.push(c.id);
    } catch { /* unreachable rpc */ }
  }));
  return out.sort((a, b) => a - b);
}

export async function tokenMeta(c, token) {
  const pc = publicClient(c);
  const [symbol, decimals, totalSupply] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?'),
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
  ]);
  return { symbol, decimals: Number(decimals), totalSupply };
}
