// Native-asset prices.
//
// This is not decoration. Chains here do NOT share a gas asset: Polygon settles
// in POL (~$0.10), Base and Ethereum in ETH (~$2,500), BNB in BNB, Monad in MON.
// Any cross-chain leg that compares "native in" against "native out" numerically
// is wrong by up to five orders of magnitude, so every cross-chain number the
// bot reports is converted to USD first.

import { formatEther } from 'viem';
import { CHAINS } from './config.mjs';

const SOURCES = [
  async (ids) => {
    const r = await fetch(`https://coins.llama.fi/prices/current/${ids.map((i) => `coingecko:${i}`).join(',')}`,
      { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`llama ${r.status}`);
    const j = await r.json();
    const out = {};
    for (const [k, v] of Object.entries(j.coins || {})) out[k.replace('coingecko:', '')] = v.price;
    return out;
  },
  async (ids) => {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const j = await r.json();
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v.usd]));
  },
];

let cache = null;

/**
 * USD price per chain id. `PRICE_<SYMBOL>` in the environment overrides a feed,
 * which is also the escape hatch when a chain's asset has no listing yet.
 */
export async function nativePrices({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const ids = [...new Set(CHAINS.map((c) => c.priceId))];
  let prices = {};
  for (const src of SOURCES) {
    try { prices = await src(ids); if (Object.keys(prices).length) break; } catch { /* try next */ }
  }
  const byChain = new Map();
  const missing = [];
  for (const c of CHAINS) {
    const env = process.env[`PRICE_${c.nativeSymbol}`];
    const usd = env ? Number(env) : prices[c.priceId];
    if (!usd || !Number.isFinite(usd)) missing.push(c.short);
    byChain.set(c.id, { usd: usd ?? null, symbol: c.nativeSymbol });
  }
  cache = { byChain, missing };
  return cache;
}

/** Convert a wei amount of `chain`'s native asset into USD. Null when unpriced. */
export function toUsd(prices, chainId, wei) {
  const p = prices.byChain.get(Number(chainId));
  if (!p?.usd) return null;
  return Number(formatEther(wei)) * p.usd;
}

export const usdStr = (v) =>
  v === null || v === undefined ? '—'
    : (Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(5)}`);
