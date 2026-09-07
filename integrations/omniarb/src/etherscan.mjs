// Etherscan V2, as a log source.
//
// The public RPCs cap `eth_getLogs` ranges, so every historical scan here walks
// the chain in 5,000-block chunks — dozens of sequential requests, any of which
// can be dropped, for one question. Etherscan answers the same question in one
// call over an unbounded range, on seven of the nine chains.
//
// It is a fallback, not a dependency: an unsupported chain, a missing key or a
// rate limit all fall through to the RPC path, which still works.

const KEY = process.env.ETHERSCAN_KEY || 'Y54HQWC3NJ3E9ZSKKM5347WPHZ2D7KA2XW';
const BASE = 'https://api.etherscan.io/v2/api';

/** Chains Etherscan V2 serves. Robinhood and Monad are not among them. */
export const ETHERSCAN_CHAINS = new Set([1, 56, 137, 480, 8453, 42161, 59144]);
export const covers = (chainId) => Boolean(KEY) && ETHERSCAN_CHAINS.has(Number(chainId));

const hex = (v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v);

/**
 * `eth_getLogs` over an arbitrary range, in Etherscan's shape, returned in the
 * shape viem's decoders expect.
 *
 * Etherscan pages at 1,000 records; a scan that fills a page keeps asking. The
 * "No records found" reply is a successful empty answer, not an error — treating
 * it as one is how an empty result becomes a fallback to a slow path that also
 * finds nothing.
 */
export async function getLogs({ chainId, address, topics = [], fromBlock, toBlock }) {
  if (!covers(chainId)) throw new Error(`etherscan does not cover chain ${chainId}`);
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const q = new URLSearchParams({
      chainid: String(Number(chainId)), module: 'logs', action: 'getLogs',
      address, fromBlock: String(BigInt(fromBlock ?? 0n)), toBlock: String(BigInt(toBlock ?? 99999999n)),
      page: String(page), offset: '1000', apikey: KEY,
    });
    topics.forEach((t, i) => { if (t) q.set(`topic${i}`, Array.isArray(t) ? t[0] : t); });
    // Etherscan wants the join operator spelled out for every adjacent pair.
    for (let i = 1; i < topics.length; i += 1) {
      if (topics[i] && topics[i - 1]) q.set(`topic${i - 1}_${i}_opr`, 'and');
    }

    const r = await fetch(`${BASE}?${q}`, { signal: AbortSignal.timeout(25_000) });
    if (!r.ok) throw new Error(`etherscan ${r.status}`);
    const j = await r.json();
    if (j.status !== '1') {
      if (/no records found/i.test(j.message ?? '')) break;   // a real, empty answer
      throw new Error(`etherscan: ${j.message ?? 'unknown'} ${String(j.result ?? '').slice(0, 80)}`);
    }
    const rows = Array.isArray(j.result) ? j.result : [];
    out.push(...rows.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data && l.data !== '0x' ? l.data : '0x',
      blockNumber: BigInt(l.blockNumber),
      transactionHash: l.transactionHash,
      logIndex: Number(l.logIndex === '0x' ? 0 : l.logIndex),
      blockTimestamp: l.timeStamp,
    })));
    if (rows.length < 1000) break;
  }
  return out;
}

export { hex };
