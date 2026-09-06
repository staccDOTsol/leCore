// Compile contracts/OmniArb.sol into build/OmniArb.json (abi + bytecode +
// deployedBytecode). The deployed bytecode is what lets the bot simulate the
// helper on chains where it has not been deployed yet, via an eth_call state
// override, so the artifact is committed rather than built on demand.

import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'contracts', 'OmniArb.sol'), 'utf8');

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'OmniArb.sol': { content: src } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
})));

const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}
for (const w of out.errors || []) console.error('warn:', w.formattedMessage.split('\n')[0]);

const c = out.contracts['OmniArb.sol'].OmniArb;
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'OmniArb.json'), `${JSON.stringify({
  abi: c.abi,
  bytecode: `0x${c.evm.bytecode.object}`,
  deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
}, null, 2)}\n`);

console.log(`OmniArb compiled — ${c.evm.deployedBytecode.object.length / 2} bytes deployed`);
