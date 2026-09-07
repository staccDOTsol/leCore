#!/usr/bin/env node
//
// Clear a jammed nonce queue by hand. The desk does this by itself when it is
// given RELAYER_KEY (see src/unstick.mjs); this is the same code with a
// terminal in front of it, for a key you would rather not leave on a server.
//
//   node scripts/unstick.mjs --chain Lin                  # look, change nothing
//   node scripts/unstick.mjs --chain Lin --send           # free the queue head
//   node scripts/unstick.mjs --send --watch               # keep every chain free
//
// The key comes from RELAYER_KEY, or UNSTICK_KEY, and is never printed.

import { formatUnits, formatEther } from 'viem';
import { CHAINS } from '../src/config.mjs';
import { unstickAccount, unstickAll, queueOf } from '../src/unstick.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const account = unstickAccount();
if (!account) {
  console.error('no key: set RELAYER_KEY to the address whose queue is stuck');
  process.exit(1);
}

const wanted = opt('chain');
const chains = wanted
  ? [CHAINS.find((c) => c.short.toLowerCase() === wanted.toLowerCase() || String(c.id) === wanted)].filter(Boolean)
  : CHAINS;
if (!chains.length) {
  console.error(`unknown chain ${wanted} — one of ${CHAINS.map((c) => c.short).join(', ')}`);
  process.exit(1);
}

const afterMs = Number(opt('after', flag('watch') ? '90' : '0')) * 1000;
const bump = BigInt(opt('bump', '4'));
console.log(`${account.address} — ${chains.map((c) => c.short).join(' ')}\n`);

do {
  const r = await unstickAll({ account, chains, afterMs, bump, send: flag('send') });
  for (const row of r.chains) {
    if (!row.stuck) { console.log(`${row.chain.padEnd(5)} nonce ${row.mined} — clear`); continue; }
    const head = `${row.chain.padEnd(5)} nonce ${row.mined} mined, ${row.pending} pending — ${row.stuck} stuck behind ${row.blockedAt}`;
    if (row.acted) console.log(`${head}\n      replaced at ${formatUnits(BigInt(row.fee), 9)} gwei — ${row.hash}`);
    else if (row.would) console.log(`${head}\n      would replace nonce ${row.would.nonce} at ${formatUnits(BigInt(row.would.fee), 9)} gwei — add --send`);
    else if (row.error) console.log(`${head}\n      ${row.error}`);
    else if (row.reason) console.log(`${head}\n      ${row.reason}`);
    else console.log(`${head}\n      waiting (${Math.round((row.waitedMs ?? 0) / 1000)}s)`);
  }
  if (flag('watch')) await new Promise((r) => setTimeout(r, Number(opt('every', '60')) * 1000));
} while (flag('watch'));
