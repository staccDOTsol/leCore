// Alchemy, as the primary transport.
//
// The public endpoints this started on are the reason half the bugs in here
// exist: dropped batches, capped getLogs ranges, a node behind the head
// answering a balance read with zero. Alchemy answers all of that consistently
// on eight of the nine chains — Robinhood is its own thing — and it speaks
// websockets, which is what makes the desk live rather than polled.
//
// Two keys, because they are scoped differently. The server key is unrestricted
// and used here. The browser key is domain-locked to the site, and is not used
// here at all: the page reaches chains through this process, so it never needs
// one.

const KEY = process.env.ALCHEMY_KEY || 'alch_6iOstmPLJo0rD58EgDFcn';

/** chain id -> Alchemy network slug. Robinhood has no Alchemy network. */
export const NETWORKS = {
  1: 'eth-mainnet',
  56: 'bnb-mainnet',
  137: 'polygon-mainnet',
  143: 'monad-mainnet',
  480: 'worldchain-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  59144: 'linea-mainnet',
};

export const covers = (chainId) => Boolean(KEY) && Boolean(NETWORKS[Number(chainId)]);
export const httpUrl = (chainId) =>
  (covers(chainId) ? `https://${NETWORKS[Number(chainId)]}.g.alchemy.com/v2/${KEY}` : null);
export const wsUrl = (chainId) =>
  (covers(chainId) ? `wss://${NETWORKS[Number(chainId)]}.g.alchemy.com/v2/${KEY}` : null);

/** For logs: never print the key, and say which network answered. */
export const describe = (chainId) => NETWORKS[Number(chainId)] ?? null;
