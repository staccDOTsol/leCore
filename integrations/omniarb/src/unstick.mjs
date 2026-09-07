//
// Keep a key's nonce queue moving.
//
// Nonces are ordered, so one transaction a chain will not mine stops every
// later one from the same key. Linea does this on a schedule: its sequencer
// enforces a minimum priority fee that eth_gasPrice does not report — that call
// puts the base fee at seven wei and says nothing about the rest — so anything
// priced from eth_gasPrice alone is accepted into the mempool, never mined, and
// blocks the key. The relayer sat at nonce 210 there for an hour and a half,
// was cleared by hand, and jammed again two minutes later.
//
// The repair is to replace the blocking nonce with a transaction the chain will
// take: zero value, to self, priced off the floor the chain actually reports.
// Only the head is replaced — the ones behind it were priced fine and were only
// ever waiting their turn — and only once it has stood still long enough that
// it is not simply waiting for the next block.
//
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, rpcsFor } from './config.mjs';
import { publicClient } from './chain.mjs';

/** The key that signs replacements, if this process was given one. */
export function unstickAccount() {
  const key = process.env.RELAYER_KEY || process.env.UNSTICK_KEY;
  if (!key) return null;
  try { return privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`); } catch { return null; }
}

/** Mined against pending: the gap is the queue. */
export async function queueOf(c, address) {
  const pc = publicClient(c);
  try {
    const [mined, pending] = await Promise.all([
      pc.getTransactionCount({ address }),
      pc.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    return { mined, pending, stuck: Math.max(0, pending - mined), blockedAt: pending > mined ? mined : null };
  } catch { return { mined: null, pending: null, stuck: 0, blockedAt: null }; }
}

/**
 * What this chain will actually take, per gas.
 *
 * linea_estimateGas reports the priority fee its sequencer requires and
 * eth_gasPrice does not. Ask for it where it exists; everywhere else the two
 * agree and the larger is still the right answer.
 */
export async function feeFloor(c, address) {
  const pc = publicClient(c);
  const gasPrice = await pc.getGasPrice().catch(() => 0n);
  try {
    const r = await pc.request({ method: 'linea_estimateGas',
      params: [{ from: address, to: address, value: '0x0' }] });
    const floor = BigInt(r.priorityFeePerGas ?? 0) + BigInt(r.baseFeePerGas ?? 0);
    return floor > gasPrice ? floor : gasPrice;
  } catch { return gasPrice; }
}

const walletFor = (c, account) => createWalletClient({
  account,
  chain: { id: c.id, name: c.name, nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: rpcsFor(c) } } },
  transport: http(rpcsFor(c)[0]),
});

/** Zero value, to self, at `fee`: the cheapest thing that can take a nonce. */
export async function replaceNonce({ c, account, nonce, fee }) {
  return walletFor(c, account).sendTransaction({
    to: account.address, value: 0n, nonce, gas: 21_000n, gasPrice: fee });
}

// How long a nonce has stood still, per chain. A queue that moves resets it.
const _since = new Map();
function heldFor(c, mined) {
  const prev = _since.get(c.id);
  if (!prev || prev.nonce !== mined) { _since.set(c.id, { nonce: mined, at: Date.now() }); return 0; }
  return Date.now() - prev.at;
}

/**
 * One pass over one chain. Returns what it saw and what, if anything, it did.
 * `bump` multiplies the floor, and rises with each attempt on the same nonce:
 * a replacement has to beat the stuck transaction's own fee, which cannot be
 * read from here, so the second try simply bids more than the first.
 */
export async function unstickChain({ c, account, afterMs = 90_000, bump = 4n, send = true }) {
  const q = await queueOf(c, account.address);
  if (!q.stuck) { _since.delete(c.id); return { ...q, chain: c.short, acted: false }; }

  const waited = heldFor(c, q.mined);
  if (waited < afterMs) return { ...q, chain: c.short, acted: false, waitedMs: waited };

  const pc = publicClient(c);
  const [floor, balance] = await Promise.all([
    feeFloor(c, account.address),
    pc.getBalance({ address: account.address }).catch(() => 0n),
  ]);
  const tries = (_since.get(c.id)?.tries ?? 0) + 1;
  const fee = floor * (bump + BigInt(tries - 1) * 2n);
  const cost = fee * 21_000n;
  if (balance < cost) return { ...q, chain: c.short, acted: false, reason: 'not enough native to replace it' };
  if (!send) return { ...q, chain: c.short, acted: false, would: { nonce: q.blockedAt, fee: fee.toString() } };

  try {
    const hash = await replaceNonce({ c, account, nonce: q.blockedAt, fee });
    // Start the clock again, and bid higher if this one does not take either.
    _since.set(c.id, { nonce: q.mined, at: Date.now(), tries });
    return { ...q, chain: c.short, acted: true, nonce: q.blockedAt, fee: fee.toString(), hash };
  } catch (e) {
    _since.set(c.id, { nonce: q.mined, at: Date.now(), tries });
    return { ...q, chain: c.short, acted: false, error: String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 160) };
  }
}

/** Every chain, once. */
export async function unstickAll({ account, afterMs, bump, send = true, chains = CHAINS } = {}) {
  const acct = account ?? unstickAccount();
  if (!acct) return { key: false, chains: [] };
  const rows = [];
  for (const c of chains) rows.push(await unstickChain({ c, account: acct, afterMs, bump, send }));
  return { key: true, address: acct.address, chains: rows };
}

/**
 * Run it forever. Started at boot when the process was given a key, because a
 * queue that jams while nobody is looking is exactly the case this is for.
 */
export function watchQueues({ everyMs = 60_000, afterMs = 90_000, onEvent = () => {} } = {}) {
  const account = unstickAccount();
  if (!account) return null;
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const r = await unstickAll({ account, afterMs });
        for (const row of r.chains) {
          if (row.acted) onEvent(`${row.chain}: replaced the relayer's stuck nonce ${row.nonce} — ${row.hash}`);
          else if (row.error) onEvent(`${row.chain}: could not replace nonce ${row.blockedAt} — ${row.error}`);
        }
      } catch { /* a bad pass is not a reason to stop watching */ }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  })();
  return { address: account.address, stop: () => { stop = true; } };
}
