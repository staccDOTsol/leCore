// Quoting. Every number the bot acts on comes from simulating the real call
// against real chain state — never from a spot price.
//
// That distinction is not academic here. The hooked pools carry a dynamic fee
// with a surge component and their sell side saturates hard: on Base the pool
// quotes ~8.7e-6 native/token at spot, yet selling ANY size into it returns at
// most ~0.0014 native. A spot-price bot would read a fortune and execute a loss.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEther } from 'viem';
import { ROUTER_ABI, PAD_ABI, PAD, HOME_CHAIN, chainById, arbHelperFor } from './config.mjs';
import { publicClient, simOverrides, SIM_ACCOUNT, deadline } from './chain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = JSON.parse(readFileSync(join(here, '..', 'build', 'OmniArb.json'), 'utf8'));

/** Address the helper is simulated at when it is not deployed on a chain yet. */
export const SIM_HELPER = '0x00000000000000000000000000000000000a4b00';

export function helperFor(c) {
  const deployed = arbHelperFor(c);
  return { address: deployed || SIM_HELPER, deployed: Boolean(deployed) };
}

/** Overrides that put the helper's runtime code at `address` when it is not real yet. */
function helperOverride(h) {
  return h.deployed ? [] : [{ address: h.address, code: ARTIFACT.deployedBytecode }];
}

// ------------------------------------------------------------------ cache
//
// A cross-chain sweep asks the same question many times: a buy quote on one
// venue is reused against every sell venue on every other chain. Without a cache
// a full nine-chain pass is quadratic in RPC calls and takes minutes; with one
// it is roughly linear in (venue x size).

const _cache = new Map();
let _cacheStamp = 0;

/** Drop memoised quotes. Call once per scan pass so each pass sees fresh state. */
export function resetQuoteCache() { _cache.clear(); _cacheStamp = Date.now(); }
export const quoteCacheSize = () => _cache.size;

/**
 * Memoise the in-flight promise, not the resolved value.
 *
 * With the search running concurrently, several workers ask for the same quote
 * at the same moment; caching only after resolution lets every one of them miss
 * and fire its own RPC call, which is the bulk of the duplicate traffic.
 */
async function memo(key, fn) {
  if (!_cache.has(key)) _cache.set(key, fn());
  return _cache.get(key);
}

const venueKey = (v) => (v.kind === 'curve' ? 'curve' : v.poolId ?? `${v.key?.hooks}`);

// ------------------------------------------------- omnichain hooked pools

export async function quoteOmniBuy(c, token, nativeIn) {
  try {
    const { result } = await publicClient(c).simulateContract({
      address: c.router, abi: ROUTER_ABI, functionName: 'buy',
      args: [token, c.hook, 0n, SIM_ACCOUNT, deadline()],
      value: nativeIn, account: SIM_ACCOUNT,
      stateOverride: simOverrides({ native: nativeIn + parseEther('1') }),
    });
    return result;
  } catch { return null; }
}

export async function quoteOmniSell(c, token, tokenIn) {
  try {
    const { result } = await publicClient(c).simulateContract({
      address: c.router, abi: ROUTER_ABI, functionName: 'sell',
      args: [token, c.hook, tokenIn, 0n, SIM_ACCOUNT, deadline()],
      account: SIM_ACCOUNT,
      stateOverride: simOverrides({ token, tokenAmount: tokenIn, spender: c.router }),
    });
    return result;
  } catch { return null; }
}

// ------------------------------------------------------- raw v4 pools

/**
 * Quote any v4 pool (including the hookless one omnichain's router refuses to
 * touch) through the OmniArb helper, simulated in place when undeployed.
 */
export async function quoteV4(c, venue, { nativeIn = 0n, tokenIn = 0n } = {}) {
  const h = helperFor(c);
  const zeroForOne = nativeIn > 0n; // currency0 is native on every omnichain pool
  const amountIn = zeroForOne ? nativeIn : tokenIn;
  if (amountIn === 0n) return null;
  const token = zeroForOne ? venue.key.currency1 : venue.key.currency1;
  try {
    const { result } = await publicClient(c).simulateContract({
      address: h.address, abi: ARTIFACT.abi, functionName: 'swapV4',
      args: [c.poolManager, venue.key, zeroForOne, amountIn, 0n],
      value: zeroForOne ? amountIn : 0n, account: SIM_ACCOUNT,
      stateOverride: simOverrides({
        token, tokenAmount: zeroForOne ? 0n : tokenIn, spender: zeroForOne ? null : h.address,
        native: amountIn + parseEther('1'), extra: helperOverride(h),
      }),
    });
    return result;
  } catch { return null; }
}

// --------------------------------------------------------- the Base curve

export async function quotePadBuy(token, nativeIn) {
  try {
    const r = await publicClient(chainById(HOME_CHAIN)).readContract({
      address: PAD, abi: PAD_ABI, functionName: 'quoteBuy', args: [token, nativeIn] });
    return { tokensOut: r[0], totalCost: r[1] };
  } catch { return null; }
}

export async function quotePadSell(token, tokenIn) {
  try {
    return await publicClient(chainById(HOME_CHAIN)).readContract({
      address: PAD, abi: PAD_ABI, functionName: 'quoteSell', args: [token, tokenIn] });
  } catch { return null; }
}

// ------------------------------------------------------- unified helpers

/** native -> token on whichever venue this is. Memoised per scan pass. */
export async function quoteBuy(c, token, venue, nativeIn) {
  return memo(`b:${c.id}:${venueKey(venue)}:${token}:${nativeIn}`, async () => {
    if (venue.kind === 'curve') {
      const q = await quotePadBuy(token, nativeIn);
      return q ? q.tokensOut : null;
    }
    if (venue.viaOmniRouter) return quoteOmniBuy(c, token, nativeIn);
    return quoteV4(c, venue, { nativeIn });
  });
}

/** token -> native on whichever venue this is. Memoised per scan pass. */
export async function quoteSell(c, token, venue, tokenIn) {
  return memo(`s:${c.id}:${venueKey(venue)}:${token}:${tokenIn}`, async () => {
    if (venue.kind === 'curve') return quotePadSell(token, tokenIn);
    if (venue.viaOmniRouter) return quoteOmniSell(c, token, tokenIn);
    return quoteV4(c, venue, { tokenIn });
  });
}

/**
 * Gas the bot should assume for one atomic two-leg arb on this chain, priced at
 * the current gas price. Falls back to a conservative constant when the node
 * will not estimate.
 */
export async function arbGasCost(c, { estimate = null } = {}) {
  const pc = publicClient(c);
  let price;
  try { price = await pc.getGasPrice(); } catch { return null; }
  const gas = estimate ?? 600_000n;
  return { gas, price, cost: gas * price };
}
