import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export async function compileContracts({ includeMocks = false, write = false } = {}) {
  const names = ['AtomicExecutor.sol', ...(includeMocks ? ['test/ExecutorMocks.sol'] : [])];
  const sources = Object.fromEntries(await Promise.all(names.map(async name => [
    name, { content: await readFile(new URL(`../contracts/${name}`, import.meta.url), 'utf8') },
  ])));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object',
        'evm.deployedBytecode.immutableReferences'] } },
    },
  })));
  const errors = (output.errors ?? []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = {};
  for (const contracts of Object.values(output.contracts)) {
    for (const [name, contract] of Object.entries(contracts)) {
      if (!contract.evm.bytecode.object) continue;
      artifacts[name] = {
        contractName: name,
        compiler: solc.version(),
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        immutableReferences: contract.evm.deployedBytecode.immutableReferences,
      };
    }
  }
  if (write) {
    const directory = new URL('../build/', import.meta.url);
    await mkdir(directory, { recursive: true });
    for (const [name, artifact] of Object.entries(artifacts)) {
      await writeFile(new URL(`${name}.json`, directory), `${JSON.stringify(artifact, null, 2)}\n`);
    }
  }
  return artifacts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifacts = await compileContracts({ write: true });
  console.log(`Compiled ${Object.keys(artifacts).join(', ')} with solc ${solc.version()} (paris).`);
}
