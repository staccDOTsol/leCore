import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult, keccak256, toHex } from 'viem';
import { compileContracts } from '../scripts/compile.mjs';
import {
  atomicRoutingConstraints, assertSupportedAtomicRoute, executorAbi, simulateRoundTrip, verifyDeployment,
} from '../src/execution.mjs';

const artifacts = await compileContracts({ includeMocks: true, write: true });
const addresses = {
  executor: '0x1111111111111111111111111111111111111111',
  owner: '0x2222222222222222222222222222222222222222',
  router: '0x3333333333333333333333333333333333333333',
  token: '0x4444444444444444444444444444444444444444',
  hook: '0x5555555555555555555555555555555555555555',
};
const blockHash = `0x${'ab'.repeat(32)}`;

function fixture() {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const calls = [];
  const codes = {
    [addresses.executor]: artifacts.AtomicExecutor.deployedBytecode,
    [addresses.router]: '0x6001600055',
    [addresses.token]: '0x6002600055',
    [addresses.hook]: '0x6003600055',
  };
  const codeHashes = Object.fromEntries(['executor', 'router', 'token', 'hook'].map(role => [
    role, keccak256(codes[addresses[role]]),
  ]));
  const deployment = { ...addresses, chainId: 1, codeHashes,
    reviews: Object.fromEntries(['router', 'token', 'hook'].map(role => [role, {
      kind: 'direct-runtime', codeHash: codeHashes[role], reference: `https://example.invalid/review/${role}`,
    }])) };
  const client = {
    getChainId: async () => 1,
    getBlock: async () => ({ number: 42n, hash: blockHash, timestamp }),
    getBytecode: async ({ address, blockNumber }) => {
      assert.equal(blockNumber, 42n);
      return codes[address.toLowerCase()];
    },
    readContract: async ({ functionName, blockNumber }) => {
      assert.equal(blockNumber, 42n);
      return addresses[functionName];
    },
    getTransactionCount: async ({ blockNumber }) => { assert.equal(blockNumber, 42n); return 0; },
    request: async request => {
      calls.push(request);
      if (request.method === 'eth_gasPrice') return '0x1';
      if (request.method === 'eth_estimateGas') return toHex(100_000n);
      if (request.method === 'eth_call') return encodeFunctionResult({
        abi: executorAbi, functionName: 'execute', result: 2_000_000n,
      });
      throw new Error(`Unexpected method ${request.method}`);
    },
  };
  return { client, deployment, calls, codes, input: {
    client, deployment, blockNumber: 42n, caller: addresses.owner, value: 1_000_000n,
    buyHooked: true, minTokensOut: 10n, minNativeOut: 1n, minProfit: 100n, deadline: timestamp + 100n,
    feePolicy: { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, l1: { mode: 'none' } },
  } };
}

test('restricted contract and adversarial fixtures compile with pinned compiler', () => {
  assert.match(artifacts.AtomicExecutor.compiler, /^0\.8\.26\+/);
  const functions = artifacts.AtomicExecutor.abi.filter(item => item.type === 'function').map(item => item.name);
  assert.deepEqual(functions.sort(), ['execute', 'hook', 'owner', 'router', 'token']);
  assert.ok(artifacts.TestRouter.bytecode.length > 100);
});

test('whole roundtrip is pinned with identical caller/value/calldata and costs deducted', async () => {
  const { input, calls } = fixture();
  const result = await simulateRoundTrip(input);
  assert.equal(result.mode, 'simulation-only');
  assert.equal(result.netProfit, 880_000n);
  assert.equal(result.gasLimit, 120_000n);
  assert.equal(result.gasPrice, 1n);
  assert.equal(calls.shift().method, 'eth_gasPrice');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'eth_estimateGas');
  assert.equal(calls[1].method, 'eth_call');
  for (const field of ['from', 'to', 'value', 'data', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    assert.equal(calls[0].params[0][field], calls[1].params[0][field]);
  }
  assert.equal(calls[0].params[1], '0x2a');
  assert.equal(calls[1].params[1], '0x2a');
  assert.equal(result.transaction.gas, '0x1d4c0');
  assert.ok(result.evidence.identities.executor.codeHash);
});

test('deployment verification rejects flags, missing code, wrong hashes and immutable identities', async t => {
  for (const [name, mutate, error] of [
    ['booleans alone', f => { f.deployment.codeHashes = undefined; f.deployment.verified = true; }, /code hash/],
    ['missing code', f => { f.codes[addresses.token] = '0x'; }, /no deployed bytecode/],
    ['wrong code hash', f => { f.deployment.codeHashes.router = blockHash; }, /hash mismatch/],
    ['wrong chain', f => { f.client.getChainId = async () => 56; }, /chain mismatch/],
    ['wrong owner', f => { f.deployment.owner = addresses.token; }, /immutable owner/],
    ['missing review', f => { f.deployment.reviews = undefined; }, /review evidence/],
    ['proxy despite review', f => {
      f.codes[addresses.router] = '0x60006000f4';
      const codeHash = keccak256(f.codes[addresses.router]);
      f.deployment.codeHashes.router = codeHash;
      f.deployment.reviews.router.codeHash = codeHash;
    }, /delegation opcodes/],
    ['foreign executor', f => {
      f.codes[addresses.executor] = '0x60006000';
      f.deployment.codeHashes.executor = keccak256('0x60006000');
    }, /locally compiled/],
  ]) await t.test(name, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyDeployment({ ...f, blockNumber: 42n }), error);
  });
});

test('simulation fails closed on unavailable or unsafe evidence', async t => {
  for (const [name, mutate, error] of [
    ['gas unavailable', f => { f.client.request = async () => { throw new Error('gas unavailable'); }; }, /gas unavailable/],
    ['gas price zero', f => { f.client.request = async () => '0x0'; }, /gasPrice/],
    ['fee cap below gas price', f => {
      const request = f.client.request;
      f.client.request = async value => value.method === 'eth_gasPrice' ? '0x2' : request(value);
    }, /below observed gasPrice/],
    ['gas zero', f => {
      const request = f.client.request;
      f.client.request = async value => value.method === 'eth_estimateGas' ? '0x0' : request(value);
    }, /gas estimate/],
    ['L1 unknown', f => { delete f.input.feePolicy.l1; }, /L1 fee policy/],
    ['L1 chain mismatch', f => { f.deployment.chainId = 480; f.client.getChainId = async () => 480; }, /No-L1 fee policy/],
    ['unsupported OP chain', f => {
      f.deployment.chainId = 42161; f.client.getChainId = async () => 42161;
      f.input.feePolicy.l1 = { mode: 'op-oracle', address: addresses.token, codeHash: f.deployment.codeHashes.token };
    }, /OP oracle fee policy is unsupported/],
    ['L1 oracle missing', f => {
      f.deployment.chainId = 8453; f.client.getChainId = async () => 8453;
      f.input.feePolicy.l1 = { mode: 'op-oracle', address: addresses.token };
    }, /L1 oracle code hash/],
    ['L1 unavailable', f => {
      f.deployment.chainId = 8453; f.client.getChainId = async () => 8453;
      f.input.feePolicy.l1 = { mode: 'op-oracle', address: addresses.token, codeHash: f.deployment.codeHashes.token };
      const request = f.client.request;
      f.client.request = async value => {
        if (value.method === 'eth_call' && value.params[0].to === addresses.token) throw new Error('L1 unavailable');
        return request(value);
      };
    }, /L1 unavailable/],
    ['wrong caller', f => { f.input.caller = addresses.token; }, /not executor owner/],
    ['expired', f => { f.input.deadline = 100n; }, /Deadline/],
    ['zero floor', f => { f.input.minProfit = 0n; }, /minProfit/],
    ['stale observation', f => { f.input.observedAt = Date.now() - 31_000; }, /observation is stale/],
    ['future observation', f => { f.input.observedAt = Date.now() + 31_000; }, /observation is stale/],
    ['stale block', f => { f.client.getBlock = async () => ({
      number: 42n, hash: blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) - 31n,
    }); }, /Pinned block is stale/],
    ['net loss', f => { f.input.feePolicy.maxFeePerGas = 100n; }, /Net profit/],
    ['reorg', f => { let n = 0; f.client.getBlock = async () => ({
      number: 42n, hash: n++ ? `0x${'cd'.repeat(32)}` : blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)),
    }); }, /block changed/],
  ]) await t.test(name, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(simulateRoundTrip(f.input), error);
  });
});

test('OP L1 oracle is code-hash verified and called at the same pinned block', async () => {
  const f = fixture();
  f.deployment.chainId = 8453; f.client.getChainId = async () => 8453;
  f.input.feePolicy.l1 = {
    mode: 'op-oracle', address: addresses.token, codeHash: f.deployment.codeHashes.token,
  };
  const request = f.client.request;
  f.client.request = async value => {
    if (value.method === 'eth_call' && value.params[0].to === addresses.token) {
      assert.equal(value.params[1], '0x2a');
      return `0x${(200n).toString(16).padStart(64, '0')}`;
    }
    return request(value);
  };
  const result = await simulateRoundTrip(f.input);
  assert.equal(result.l1Fee, 400n);
  assert.equal(result.netProfit, 879_600n);
  assert.equal(result.l1Evidence.codeHash, f.deployment.codeHashes.token);
  assert.match(result.l1Evidence.serializedTransaction, /^0x02/);
});

test('delegating L1 oracle requires pinned implementation identity and code hash', async () => {
  const f = fixture();
  f.deployment.chainId = 8453; f.client.getChainId = async () => 8453;
  const oracle = '0x6666666666666666666666666666666666666666';
  const code = '0x60006000f4';
  f.codes[oracle] = code;
  f.input.feePolicy.l1 = { mode: 'op-oracle', address: oracle, codeHash: keccak256(code) };
  await assert.rejects(simulateRoundTrip(f.input), /oracle implementation/);
  f.input.feePolicy.l1.implementation = { address: addresses.token, codeHash: f.deployment.codeHashes.token };
  f.client.getStorageAt = async ({ blockNumber }) => {
    assert.equal(blockNumber, 42n);
    return `0x${addresses.token.slice(2).padStart(64, '0')}`;
  };
  const request = f.client.request;
  f.client.request = async value => value.method === 'eth_call' && value.params[0].to === oracle
    ? `0x${(100n).toString(16).padStart(64, '0')}` : request(value);
  const result = await simulateRoundTrip(f.input);
  assert.deepEqual(result.l1Evidence.implementation, f.input.feePolicy.l1.implementation);
  f.client.getStorageAt = async () => `0x${addresses.router.slice(2).padStart(64, '0')}`;
  await assert.rejects(simulateRoundTrip(f.input), /implementation slot mismatch/);
});

test('BNB zero base fee cannot bypass the observed gas price floor', async () => {
  const f = fixture();
  f.deployment.chainId = 56;
  f.client.getChainId = async () => 56;
  const getBlock = f.client.getBlock;
  f.client.getBlock = async args => ({ ...await getBlock(args), baseFeePerGas: 0n });
  const request = f.client.request;
  f.client.request = async args => args.method === 'eth_gasPrice' ? '0x2' : request(args);
  await assert.rejects(simulateRoundTrip(f.input), /below observed gasPrice/);
  f.input.feePolicy.maxFeePerGas = 2n;
  const result = await simulateRoundTrip(f.input);
  assert.equal(result.gasPrice, 2n);
  assert.equal(result.gasBudget, 240_000n);
  assert.equal(result.maxAgeMs, 30_000);
  assert.ok(Date.now() - result.observedAt < 30_000);
});

test('Linea cannot use OP oracle evidence', async () => {
  const f = fixture();
  f.deployment.chainId = 59144;
  f.client.getChainId = async () => 59144;
  f.input.feePolicy.l1 = { mode: 'op-oracle', address: addresses.token, codeHash: f.deployment.codeHashes.token };
  await assert.rejects(simulateRoundTrip(f.input), /OP oracle fee policy is unsupported/);
});

test('explicit pair scope is not generic graph execution evidence', async () => {
  const f = fixture();
  const route = assertSupportedAtomicRoute(f.input);
  assert.equal(route.kind, 'router-v2-pair');
  assert.equal(atomicRoutingConstraints.swaps, 2);
  assert.equal(atomicRoutingConstraints.crossChain, false);
  const result = await simulateRoundTrip({ ...f.input, route });
  assert.deepEqual(result.executionRoute, route);
  assert.ok(result.evidence.identities.executor.codeHash);
});

test('arbitrary graph paths, pools, adapters, chains and pair substitutions fail before RPC', async t => {
  for (const [name, makeRoute] of [
    ['graph route', () => ({ id: 'route:1', edges: [{ kind: 'pool' }, { kind: 'pool' }] })],
    ['different token', route => ({ ...route, token: addresses.owner })],
    ['different router', route => ({ ...route, router: addresses.owner })],
    ['different hook', route => ({ ...route, hook: addresses.owner })],
    ['cross-chain', route => ({ ...route, chainId: 56 })],
    ['opposite direction', route => ({ ...route, buyHooked: false })],
    ['fee tier override', route => ({ ...route, poolKey: { fee: 3000, tickSpacing: 60 } })],
    ['adapter override', route => ({ ...route, adapter: addresses.owner })],
    ['curve', route => ({ ...route, kind: 'curve' })],
    ['verification boolean', () => ({ verified: true })],
  ]) await t.test(name, async () => {
    const f = fixture();
    const route = makeRoute(assertSupportedAtomicRoute(f.input));
    f.client.getChainId = async () => { assert.fail('Unsupported routes must not trigger simulation'); };
    await assert.rejects(simulateRoundTrip({ ...f.input, route }), /Unsupported atomic route/);
  });
});
