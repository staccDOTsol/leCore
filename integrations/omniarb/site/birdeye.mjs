// Birdeye client.
//
// The key lives here, server-side, and is never sent to the browser — every
// call the page makes goes through this process. Putting it in the frontend
// would publish it to anyone who opens devtools.
//
// Birdeye covers 7 of the 9 chains omnichain.family deploys to. World and Linea
// are not in its network list, so those fall back to on-chain pool state; the
// API surfaces which source a number came from rather than quietly mixing them.

const KEY = process.env.BIRDEYE_KEY || 'e651436dfac74f39bf71ca7f57abe7e7';
const BASE = 'https://public-api.birdeye.so';

/** omnichain chain id -> Birdeye's `x-chain` name. Null where unsupported. */
export const BIRDEYE_CHAIN = {
  1: 'ethereum',
  56: 'bsc',
  137: 'polygon',
  143: 'monad',
  4663: 'robinhood',
  8453: 'base',
  42161: 'arbitrum',
  480: null,    // World — not in Birdeye's network list
  59144: null,  // Linea — not in Birdeye's network list
};

export const covers = (chainId) => Boolean(BIRDEYE_CHAIN[Number(chainId)]);

// Small TTL cache: the dashboard polls, and Birdeye bills per call.
const cache = new Map();
const TTL = 20_000;

async function get(path, chainId, { ttl = TTL } = {}) {
  const chain = BIRDEYE_CHAIN[Number(chainId)];
  if (!chain) return null;
  const url = `${BASE}${path}`;
  const key = `${chain}:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  try {
    const r = await fetch(url, {
      headers: { 'X-API-KEY': KEY, 'x-chain': chain, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const value = j?.success ? j.data : null;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch { return null; }
}

export const price = (address, chainId) =>
  get(`/defi/price?address=${address}`, chainId);

export const overview = (address, chainId) =>
  get(`/defi/token_overview?address=${address}`, chainId, { ttl: 60_000 });

/**
 * OHLCV candles. `type` is Birdeye's bucket size (1m/5m/15m/1H/4H/1D…);
 * the window is derived from it so a chart always gets a useful number of bars.
 */
export function ohlcv(address, chainId, type = '15m', hours = 24) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;
  return get(`/defi/ohlcv?address=${address}&type=${type}&time_from=${from}&time_to=${now}`,
    chainId, { ttl: 30_000 });
}
