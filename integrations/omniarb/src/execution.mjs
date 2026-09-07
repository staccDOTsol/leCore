import { readFile } from 'node:fs/promises';
import {
  decodeFunctionResult, encodeFunctionData, getAddress, isAddress, keccak256,
  parseAbi, serializeTransaction, toHex,
} from 'viem';

export const executorAbi = parseAbi([
  'function owner() view returns (address)',
  'function router() view returns (address)',
  'function token() view returns (address)',
  'function hook() view returns (address)',
  'function execute(bool buyHooked,uint256 minTokensOut,uint256 minNativeOut,uint256 minProfit,uint256 deadline) payable returns (uint256 nativeOut)',
]);
export const atomicRoutingConstraints = Object.freeze({
  kind: 'router-v2-pair',
  swaps: 2,
  startAsset: 'native',
  intermediateAsset: 'immutable token',
  endAsset: 'native',
  venue: 'immutable router V2; one configured-hook leg and one zero-hook leg',
  poolSelection: 'router-selected only; arbitrary PoolKeys, managers, fee tiers and tick spacings unsupported',
  crossChain: false,
  curve: false,
  arbitraryAdapters: false,
  graphRoutes: 'unsupported until exact PoolKey-to-router execution binding is implemented and verified',
});
const oracleAbi = parseAbi(['function getL1Fee(bytes transaction) view returns (uint256)']);
const NO_SEPARATE_L1_FEE = new Set([1, 56, 137, 143]);
const OP_ORACLE_CHAINS = new Set([10, 130, 480, 8453]);
const ZERO = '0x0000000000000000000000000000000000000000';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function uint(value, name, positive = false) {
  requireThat(typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value < 2n ** 256n,
    `${name} must be a ${positive ? 'positive ' : ''}uint256 bigint`);
  return value;
}
function hash(value, name) {
  requireThat(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${name} is missing or invalid`);
  return value.toLowerCase();
}
function address(value, name) {
  requireThat(isAddress(value ?? '') && value.toLowerCase() !== ZERO, `${name} must be a nonzero address`);
  return getAddress(value);
}

/** This checks routing scope only, never deployment or execution evidence. */
export function assertSupportedAtomicRoute({ route, deployment, buyHooked }) {
  requireThat(typeof buyHooked === 'boolean', 'buyHooked must be boolean');
  const canonical = {
    kind: atomicRoutingConstraints.kind, chainId: deployment?.chainId,
    router: address(deployment?.router, 'router'), token: address(deployment?.token, 'token'),
    hook: address(deployment?.hook, 'hook'), buyHooked,
  };
  if (route !== undefined) {
    requireThat(route && typeof route === 'object' && !Array.isArray(route)
      && Object.keys(route).length === Object.keys(canonical).length
      && Object.keys(route).every(key => Object.hasOwn(canonical, key)),
    'Unsupported atomic route: only the exact router-v2-pair descriptor is supported, not graph routes or PoolKeys');
    for (const [key, expected] of Object.entries(canonical)) {
      const actual = ['router', 'token', 'hook'].includes(key) ? address(route[key], `route ${key}`) : route[key];
      requireThat(actual === expected, `Unsupported atomic route: ${key} differs from the immutable pair`);
    }
  }
  return Object.freeze(canonical);
}
function assertFresh(observedAt, blockTimestamp, maxAgeMs) {
  const now = Date.now();
  requireThat(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0, 'maxAgeMs must be a positive safe integer');
  requireThat(Number.isSafeInteger(observedAt) && observedAt <= now && now - observedAt <= maxAgeMs,
    'Simulation observation is stale or in the future');
  uint(blockTimestamp, 'block timestamp');
  requireThat(blockTimestamp * 1000n <= BigInt(now)
    && BigInt(now) - blockTimestamp * 1000n <= BigInt(maxAgeMs),
  'Pinned block is stale or in the future');
}
async function bytecodeEvidence(client, role, target, expected, blockNumber) {
  const code = await client.getBytecode({ address: target, blockNumber });
  requireThat(code && code !== '0x', `${role} has no deployed bytecode`);
  const codeHash = keccak256(code);
  requireThat(codeHash === hash(expected, `${role} code hash`), `${role} code hash mismatch`);
  return { address: target, codeHash, code };
}

function hasDelegation(code) {
  const bytes = Buffer.from(code.slice(2), 'hex');
  if (code.startsWith('0xef0100')) return true;
  for (let i = 0; i < bytes.length; i++) {
    const opcode = bytes[i];
    if (opcode === 0xf4 || opcode === 0xf2) return true;
    if (opcode >= 0x60 && opcode <= 0x7f) i += opcode - 0x5f;
  }
  return false;
}

// Ignore only the compiler-declared immutable slots, not any executable instructions.
function matchesExecutorArtifact(code, artifact) {
  requireThat(artifact?.contractName === 'AtomicExecutor'
    && typeof artifact.deployedBytecode === 'string', 'Compile AtomicExecutor before simulation');
  const actual = Buffer.from(code.slice(2), 'hex');
  const expected = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  if (actual.length !== expected.length) return false;
  for (const references of Object.values(artifact.immutableReferences ?? {})) {
    for (const { start, length } of references) {
      actual.fill(0, start, start + length);
      expected.fill(0, start, start + length);
    }
  }
  return actual.equals(expected);
}

/** Manifest code hashes are an out-of-band trust anchor, never a verified:true flag.
 * Proxy runtime hashes alone do not prove implementation identity: proxies are unsupported.
 */
export async function verifyDeployment({ client, deployment, blockNumber }) {
  uint(blockNumber, 'blockNumber');
  requireThat(deployment && Number.isSafeInteger(deployment.chainId), 'Missing deployment chainId');
  const chainId = await client.getChainId();
  requireThat(chainId === deployment.chainId, 'Deployment chain mismatch');
  const block = await client.getBlock({ blockNumber });
  const blockHash = hash(block.hash, 'Pinned block hash');
  requireThat(block.number === blockNumber, 'RPC returned the wrong block');
  const identities = {};
  for (const role of ['executor', 'router', 'token', 'hook']) {
    const target = address(deployment[role], role);
    identities[role] = await bytecodeEvidence(client, role, target, deployment.codeHashes?.[role], blockNumber);
  }
  const owner = address(deployment.owner, 'owner');
  const artifact = JSON.parse(await readFile(new URL('../build/AtomicExecutor.json', import.meta.url), 'utf8'));
  requireThat(matchesExecutorArtifact(identities.executor.code, artifact), 'Executor differs from locally compiled restricted executor');
  for (const role of ['owner', 'router', 'token', 'hook']) {
    const actual = await client.readContract({
      address: identities.executor.address, abi: executorAbi, functionName: role, blockNumber,
    });
    requireThat(getAddress(actual) === (role === 'owner' ? owner : identities[role].address),
      `Executor immutable ${role} mismatch`);
  }
  // Explicitly require nonproxy source-review evidence; hashes do not certify router semantics.
  for (const role of ['router', 'token', 'hook']) {
    const review = deployment.reviews?.[role];
    requireThat(!hasDelegation(identities[role].code),
      `${role} contains delegation opcodes; proxy/implementation verification is unsupported`);
    requireThat(review && review.kind === 'direct-runtime' && review.codeHash?.toLowerCase() === identities[role].codeHash
      && typeof review.reference === 'string' && /^https:\/\//.test(review.reference),
    `${role} needs code-hash-bound direct-runtime review evidence (proxies unsupported)`);
  }
  return {
    chainId, blockNumber, blockHash, timestamp: block.timestamp, owner,
    identities: Object.fromEntries(Object.entries(identities).map(([role, item]) => [
      role, { address: item.address, codeHash: item.codeHash },
    ])),
    reviews: deployment.reviews,
  };
}

/** Read-only whole-transaction simulation. There is deliberately no signer or send path. */
export async function simulateRoundTrip({
  client, deployment, blockNumber, caller, value, buyHooked,
  minTokensOut, minNativeOut, minProfit, deadline, feePolicy,
  observedAt = Date.now(), maxAgeMs = 30_000, route,
}) {
  const executionRoute = assertSupportedAtomicRoute({ route, deployment, buyHooked });
  const evidence = await verifyDeployment({ client, deployment, blockNumber });
  assertFresh(observedAt, evidence.timestamp, maxAgeMs);
  requireThat(address(caller, 'caller') === evidence.owner, 'Caller is not executor owner');
  requireThat(typeof buyHooked === 'boolean', 'buyHooked must be boolean');
  for (const [name, amount] of Object.entries({ value, minTokensOut, minNativeOut, minProfit, deadline })) {
    uint(amount, name, true);
  }
  requireThat(deadline > evidence.timestamp && deadline > BigInt(Math.floor(Date.now() / 1000)),
    'Deadline must be after the pinned block timestamp and current time');
  const maxFeePerGas = uint(feePolicy?.maxFeePerGas, 'maxFeePerGas', true);
  const maxPriorityFeePerGas = uint(feePolicy?.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
  requireThat(maxPriorityFeePerGas <= maxFeePerGas, 'Priority fee exceeds fee cap');
  const gasPrice = BigInt(await client.request({ method: 'eth_gasPrice', params: [] }));
  uint(gasPrice, 'observed gasPrice', true);
  requireThat(maxFeePerGas >= gasPrice, 'Fee cap is below observed gasPrice');
  const gasPriceObservedAt = Date.now();
  const data = encodeFunctionData({
    abi: executorAbi, functionName: 'execute', args: [buyHooked, minTokensOut, minNativeOut, minProfit, deadline],
  });
  const transaction = {
    from: evidence.owner, to: evidence.identities.executor.address,
    value: toHex(value), data, maxFeePerGas: toHex(maxFeePerGas),
    maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
  };
  const tag = toHex(blockNumber);
  // Block numbers are accepted by estimateGas on more RPCs than EIP-1898 hashes.
  // A hash recheck rejects reorgs instead of silently mixing evidence across blocks.
  const gasEstimate = BigInt(await client.request({ method: 'eth_estimateGas', params: [transaction, tag] }));
  uint(gasEstimate, 'gas estimate', true);
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  const exactTransaction = { ...transaction, gas: toHex(gasLimit) };
  const result = await client.request({ method: 'eth_call', params: [exactTransaction, tag] });
  const nativeOut = decodeFunctionResult({ abi: executorAbi, functionName: 'execute', data: result });
  requireThat(nativeOut >= value + minProfit, 'Simulated output violates profit floor');
  const nonce = await client.getTransactionCount({ address: evidence.owner, blockNumber });
  let l1Fee = 0n;
  let l1Evidence;
  if (feePolicy?.l1?.mode === 'none') {
    requireThat(NO_SEPARATE_L1_FEE.has(evidence.chainId), 'No-L1 fee policy is not supported for this chain');
    l1Evidence = { mode: 'none', chainId: evidence.chainId, basis: 'built-in L1 chain registry' };
  } else {
    requireThat(feePolicy?.l1?.mode === 'op-oracle', 'Missing supported L1 fee policy');
    requireThat(OP_ORACLE_CHAINS.has(evidence.chainId), 'OP oracle fee policy is unsupported for this chain');
    const oracle = feePolicy.l1;
    const oracleAddress = address(oracle.address, 'L1 oracle');
    const oracleIdentity = await bytecodeEvidence(client, 'L1 oracle', oracleAddress, oracle.codeHash, blockNumber);
    let implementationEvidence;
    if (hasDelegation(oracleIdentity.code)) {
      const implementation = address(oracle.implementation?.address, 'L1 oracle implementation');
      const slot = await client.getStorageAt({ address: oracleAddress, slot: IMPLEMENTATION_SLOT, blockNumber });
      requireThat(typeof slot === 'string' && /^0x[0-9a-fA-F]{64}$/.test(slot)
        && getAddress(`0x${slot.slice(-40)}`) === implementation, 'L1 oracle implementation slot mismatch');
      const verified = await bytecodeEvidence(
        client, 'L1 oracle implementation', implementation, oracle.implementation.codeHash, blockNumber,
      );
      requireThat(!hasDelegation(verified.code), 'Nested L1 oracle delegation is unsupported');
      implementationEvidence = { address: implementation, codeHash: verified.codeHash };
    }
    const serialized = serializeTransaction({
      chainId: evidence.chainId, type: 'eip1559', nonce, to: transaction.to, value, data,
      gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas,
    }, { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
    const oracleData = encodeFunctionData({
      abi: oracleAbi, functionName: 'getL1Fee', args: [serialized],
    });
    const raw = await client.request({
      method: 'eth_call', params: [{ to: oracleAddress, data: oracleData }, tag],
    });
    const estimated = decodeFunctionResult({ abi: oracleAbi, functionName: 'getL1Fee', data: raw });
    uint(estimated, 'L1 fee estimate', true);
    // Compression-dependent L1 fees are estimates, not a claim of future fee certainty.
    l1Fee = estimated * 2n;
    l1Evidence = { mode: oracle.mode, address: oracleAddress, codeHash: oracleIdentity.codeHash,
      ...(implementationEvidence ? { implementation: implementationEvidence } : {}),
      serializedTransaction: serialized, estimateWei: estimated, budgetWei: l1Fee };
  }
  const finalBlock = await client.getBlock({ blockNumber });
  requireThat(finalBlock.hash?.toLowerCase() === evidence.blockHash, 'Pinned block changed during simulation');
  assertFresh(observedAt, evidence.timestamp, maxAgeMs);
  requireThat(deadline > BigInt(Math.floor(Date.now() / 1000)), 'Deadline expired during simulation');
  const gasBudget = gasLimit * maxFeePerGas;
  const netProfit = nativeOut - value - gasBudget - l1Fee;
  requireThat(netProfit >= minProfit, 'Net profit after gas and L1 budget is below the requested floor');
  return {
    mode: 'simulation-only', evidence, observedAt, maxAgeMs, executionRoute,
    transaction: exactTransaction, blockNumber, blockHash: evidence.blockHash,
    nativeOut, gasEstimate, gasLimit, gasBudget, gasPrice, gasPriceObservedAt, l1Fee, l1Evidence, netProfit,
    warning: 'Pinned simulation is not a guarantee of inclusion, future profit, or L1 fee bounds.',
  };
}
