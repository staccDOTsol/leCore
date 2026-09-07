#!/usr/bin/env node
//
// Unstick an address whose nonce queue has jammed.
//
// A chain that stops accepting one transaction stops accepting every later one
// from the same key: the queue is ordered, so nonce 210 refusing to mine leaves
// 211 through 369 sitting in the mempool behind it, and everything that key was
// supposed to do on that chain — mints, pool opens, deploys — silently stops.
// It reads as "the relay is slow" for as long as nobody looks at the nonce.
//
// The fix is to replace the blocking nonce with a transaction the chain will
// take: a zero-value send to self, priced well above the floor. Doing that for
// the FIRST stuck nonce usually frees the whole queue, because the ones behind
// it were priced fine and were only ever waiting their turn. Replacing every
// nonce cancels every queued operation, so it is opt-in and last.
//
//   node scripts/unstick.mjs --chain Lin                  # look, change nothing
//   node scripts/unstick.mjs --chain Lin --send           # free the queue head
//   node scripts/unstick.mjs --chain Lin --all --send     # cancel the whole queue
//   node scripts/unstick.mjs --chain Lin --send --watch   # keep it free
//
// --watch exists because on Linea this comes back. Linea enforces a minimum
// priority fee, reported by linea_estimateGas and not by eth_gasPrice, and it
// moves. A transaction priced under it is accepted into the mempool, never
// mined, and blocks every later nonce from the same key — the queue jammed at
// 210 for an hour and a half, was cleared, and jammed again two minutes later.
// The real repair is to price Linea from that floor; until then this holds the
// queue open, and only ever replaces a nonce that has sat still for --after
// seconds, so it never cancels a transaction that was merely waiting a block.
//
// The key comes from RELAYER_KEY, or STACCOVERFLOW_KP, and is never printed.

import { createWalletClient, http, formatUnits, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, chainById, rpcsFor } from '../src/config.mjs';
import { publicClient } from '../src/chain.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const key = process.env.RELAYER_KEY || process.env.STACCOVERFLOW_KP;
if (!key) {
  console.error('no key: set RELAYER_KEY (or STACCOVERFLOW_KP) to the address whose queue is stuck');
  process.exit(1);
}
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);

const wanted = opt('chain');
const chains = wanted
  ? [CHAINS.find((c) => c.short.toLowerCase() === wanted.toLowerCase() || String(c.id) === wanted)].filter(Boolean)
  : CHAINS;
if (!chains.length) {
  console.error(`unknown chain ${wanted} — one of ${CHAINS.map((c) => c.short).join(', ')}`);
  process.exit(1);
}

// However far above the floor the chain says it wants. A replacement has to beat
// the stuck transaction's own fee, and the point of this is to stop guessing.
const BUMP = BigInt(opt('bump', '4'));
const AFTER = Number(opt('after', '90')) * 1000;
const EVERY = Number(opt('every', '60')) * 1000;

/**
 * What this chain will actually take, per gas.
 *
 * eth_gasPrice is not the answer on Linea: it reports a base fee of 7 wei and
 * the sequencer separately requires a priority fee that eth_gasPrice does not
 * mention. linea_estimateGas does, so ask it where it exists and take the
 * larger of the two everywhere else.
 */
async function floorFor(c, pc) {
  const gasPrice = await pc.getGasPrice().catch(() => 0n);
  try {
    const r = await pc.request({ method: 'linea_estimateGas',
      params: [{ from: account.address, to: account.address, value: '0x0' }] });
    const prio = BigInt(r.priorityFeePerGas ?? 0n) + BigInt(r.baseFeePerGas ?? 0n);
    return prio > gasPrice ? prio : gasPrice;
  } catch { return gasPrice; }
}

/** Nonces the queue has been sitting on, and for how long. */
const _since = new Map();
function held(c, mined) {
  const k = `${c.id}:${mined}`;
  if (!_since.has(k)) _since.set(k, Date.now());
  for (const other of [..._since.keys()]) if (other.startsWith(`${c.id}:`) && other !== k) _since.delete(other);
  return Date.now() - _since.get(k);
}

console.log(`${account.address} — checking ${chains.map((c) => c.short).join(' ')}` +
  (flag('watch') ? ` every ${EVERY / 1000}s, replacing a nonce held for ${AFTER / 1000}s` : '') + '\n');
let acted = 0;

do {
for (const c of chains) {
  const pc = publicClient(c);
  const [mined, pending] = await Promise.all([
    pc.getTransactionCount({ address: account.address }),
    pc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  ]);
  if (pending <= mined) {
    console.log(`${c.short.padEnd(5)} nonce ${mined} — clear`);
    continue;
  }

  const stuck = pending - mined;
  const [gasPrice, balance] = [await floorFor(c, pc), await pc.getBalance({ address: account.address }).catch(() => 0n)];
  const fee = gasPrice * BUMP;
  const targets = flag('all') ? Array.from({ length: stuck }, (_, i) => mined + i)
    : opt('nonce') ? [Number(opt('nonce'))] : [mined];
  const cost = fee * 21_000n * BigInt(targets.length);

  const waited = held(c, mined);
  if (flag('watch') && waited < AFTER) {
    console.log(`${c.short.padEnd(5)} nonce ${mined} mined, ${pending} pending — waiting (${Math.round(waited / 1000)}s)`);
    continue;
  }
  console.log(`${c.short.padEnd(5)} nonce ${mined} mined, ${pending} pending — ${stuck} stuck behind ${mined}`);
  console.log(`      gas ${formatUnits(gasPrice, 9)} gwei, replacing at ${formatUnits(fee, 9)} gwei ` +
    `· ${targets.length} transaction${targets.length === 1 ? '' : 's'} ` +
    `· ${formatEther(cost)} ${c.nativeSymbol} of ${formatEther(balance)} held`);
  if (balance < cost) { console.log('      not enough native to replace them — fund the key first'); continue; }
  if (!flag('send')) { console.log('      dry run: add --send to do it\n'); continue; }

  const wallet = createWalletClient({ account, chain: { id: c.id, name: c.name, nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 }, rpcUrls: { default: { http: rpcsFor(c) } } }, transport: http(rpcsFor(c)[0]) });
  for (const nonce of targets) {
    try {
      // Zero value, to self: the cheapest transaction a chain will accept, and
      // it cannot do anything except take the slot.
      const hash = await wallet.sendTransaction({ to: account.address, value: 0n, nonce, gas: 21_000n, gasPrice: fee });
      console.log(`      nonce ${nonce} replaced — ${c.explorer}/tx/${hash}`);
      _since.delete(`${c.id}:${nonce}`);
      acted += 1;
    } catch (e) {
      console.log(`      nonce ${nonce}: ${String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 140)}`);
      break;      // a refusal here repeats for every later nonce
    }
  }
  console.log('');
}

if (flag('watch')) await new Promise((r) => setTimeout(r, EVERY));
} while (flag('watch'));

if (acted) {
  console.log('give it a minute, then re-run without --send: the queue behind the replaced nonce should drain on its own.');
}
