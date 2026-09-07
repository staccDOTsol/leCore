import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPublicClient, encodeDeployData, encodeFunctionData, http, parseAbi, toFunctionSelector, toHex,
} from 'viem';
import { compileContracts } from '../scripts/compile.mjs';
import { executorAbi, verifyDeployment } from '../src/execution.mjs';

const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)']);

// The only state-changing RPCs in this integration live behind these local-fork gates.
test('local Anvil fork: real executor rollback and adversarial native/token roundtrips', async t => {
  const endpoint = process.env.OMNIARB_FORK_RPC_URL;
  const evidencePath = process.env.OMNIARB_FORK_EVIDENCE;
  if (!endpoint) return t.skip('No OMNIARB_FORK_RPC_URL; a local Anvil fork is required (no public fallback).');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password) {
    return t.skip('Fork endpoint must be loopback, without credentials.');
  }
  const client = createPublicClient({
    transport: http(endpoint, { retryCount: 0, timeout: 5000, fetchOptions: { redirect: 'error' } }),
  });
  let info;
  try { info = await client.request({ method: 'anvil_nodeInfo' }); }
  catch { return t.skip('Loopback endpoint is unavailable or is not Anvil.'); }
  if (!info?.forkConfig?.forkUrl || !info.forkConfig.forkBlockNumber
      || BigInt(info.forkConfig.forkBlockNumber) <= 0n) {
    return t.skip('anvil_nodeInfo did not verify active fork metadata.');
  }
  if (!evidencePath) return t.skip('No OMNIARB_FORK_EVIDENCE; verified executor/router/token/hook evidence is required.');
  const fixture = JSON.parse(await readFile(evidencePath, 'utf8'));
  const artifacts = await compileContracts({ includeMocks: true, write: true });
  const blockNumber = BigInt(fixture.blockNumber);
  await verifyDeployment({ client, deployment: fixture.deployment, blockNumber });
  // Verify current identities too: evidence from an older block cannot authorize changed code.
  const currentBlock = await client.getBlockNumber();
  await verifyDeployment({ client, deployment: fixture.deployment, blockNumber: currentBlock });
  const snapshot = await client.request({ method: 'evm_snapshot' });
  const rpc = (method, params = []) => client.request({ method, params });
  const owner = fixture.deployment.owner;
  const balance = account => client.getBalance({ address: account });
  const read = (artifact, address, functionName, args = []) =>
    client.readContract({ abi: artifact.abi, address, functionName, args });
  const send = async (from, to, data = '0x', value = 0n) => {
    const hash = await rpc('eth_sendTransaction', [{
      from, ...(to ? { to } : {}), data, value: toHex(value), gas: toHex(8_000_000n),
    }]);
    return client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  };
  const deploy = async (artifact, args = []) => {
    const receipt = await send(owner, undefined, encodeDeployData({ ...artifact, args }));
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const write = async (artifact, target, name, args = [], value = 0n) =>
    send(owner, target, encodeFunctionData({ abi: artifact.abi, functionName: name, args }), value);
  try {
    await rpc('anvil_impersonateAccount', [owner]);
    await rpc('anvil_setBalance', [owner, toHex(100n * 10n ** 18n)]);
    await t.test('real configured executor rejects losing transaction and preserves inventory', async () => {
      const executor = fixture.deployment.executor;
      const token = fixture.deployment.token;
      const nativeBefore = await balance(executor);
      const tokensBefore = await client.readContract({
        address: token, abi: tokenAbi, functionName: 'balanceOf', args: [executor],
      });
      const allowanceBefore = await client.readContract({
        address: token, abi: tokenAbi, functionName: 'allowance', args: [executor, fixture.deployment.router],
      });
      const routerBefore = await balance(fixture.deployment.router);
      const block = await client.getBlock();
      const data = encodeFunctionData({
        abi: executorAbi, functionName: 'execute',
        args: [fixture.trade.buyHooked, 1n, 1n, 2n ** 255n, block.timestamp + 300n],
      });
      const receipt = await send(owner, executor, data, BigInt(fixture.trade.value));
      assert.equal(receipt.status, 'reverted');
      const trace = await rpc('debug_traceTransaction', [receipt.transactionHash, {}]);
      assert.ok(trace.returnValue?.replace(/^0x/, '').startsWith(
        toFunctionSelector('Unprofitable(uint256,uint256)').slice(2)),
      'Real route must reach the balance-delta profit guard, not merely fail for an unrelated reason');
      assert.equal(await balance(executor), nativeBefore);
      assert.equal(await balance(fixture.deployment.router), routerBefore);
      assert.equal(await client.readContract({
        address: token, abi: tokenAbi, functionName: 'balanceOf', args: [executor],
      }), tokensBefore);
      assert.equal(await client.readContract({
        address: token, abi: tokenAbi, functionName: 'allowance', args: [executor, fixture.deployment.router],
      }), allowanceBefore);
    });

    const token = await deploy(artifacts.TestToken);
    const hook = await deploy(artifacts.TestHook);
    const router = await deploy(artifacts.TestRouter);
    const receiver = await deploy(artifacts.TestOwner);
    const executor = await deploy(artifacts.AtomicExecutor, [receiver, router, token, hook]);
    assert.equal((await write(artifacts.TestOwner, receiver, 'setExecutor', [executor])).status, 'success');
    await rpc('anvil_setBalance', [router, toHex(10n ** 18n)]);
    await rpc('anvil_setBalance', [executor, toHex(17n)]);
    assert.equal((await write(artifacts.TestToken, token, 'mint', [executor, 23n])).status, 'success');
    const deadline = (await client.getBlock()).timestamp + 3600n;
    const run = (direction = true, floor = 1n, expiry = deadline) =>
      write(artifacts.TestOwner, receiver, 'run', [direction, floor, expiry], 10n);
    const inventory = async () => ({
      native: await balance(executor),
      token: await read(artifacts.TestToken, token, 'balanceOf', [executor]),
      approval: await read(artifacts.TestToken, token, 'allowance', [executor, router]),
    });
    const baseline = { native: 17n, token: 23n, approval: 0n };

    await t.test('both directions use native currency, delta-only tokens and reset approvals', async () => {
      for (const direction of [true, false]) {
        const before = await balance(receiver);
        assert.equal((await run(direction)).status, 'success');
        assert.equal(await balance(receiver), before + 12n);
        assert.deepEqual(await inventory(), baseline);
        assert.equal(await read(artifacts.TestRouter, router, 'sold'), 10n);
        assert.equal((await read(artifacts.TestRouter, router, 'buyHook')).toLowerCase(),
          direction ? hook.toLowerCase() : '0x0000000000000000000000000000000000000000');
        assert.equal((await read(artifacts.TestRouter, router, 'sellHook')).toLowerCase(),
          direction ? '0x0000000000000000000000000000000000000000' : hook.toLowerCase());
      }
    });
    await t.test('loss, floor failure, expiry and bad approval revert atomically', async () => {
      for (const payout of [9n, 10n]) {
        await write(artifacts.TestRouter, router, 'configure', [payout, false]);
        const routerBefore = await balance(router);
        assert.equal((await run()).status, 'reverted');
        assert.deepEqual(await inventory(), baseline);
        assert.equal(await balance(router), routerBefore);
      }
      await write(artifacts.TestRouter, router, 'configure', [12n, false]);
      assert.equal((await run(true, 3n)).status, 'reverted');
      assert.equal((await run(true, 1n, 1n)).status, 'reverted');
      assert.equal((await run(true, 0n)).status, 'reverted');
      await write(artifacts.TestToken, token, 'setApprovalMode', [1n]);
      assert.equal((await run()).status, 'reverted');
      assert.deepEqual(await inventory(), baseline);
      await write(artifacts.TestToken, token, 'setApprovalMode', [2n]);
      assert.equal((await run()).status, 'success');
      assert.deepEqual(await inventory(), baseline);
      await write(artifacts.TestToken, token, 'setApprovalMode', [0n]);
    });
    await t.test('router and owner callbacks cannot reenter; failed native payout rolls back', async () => {
      await write(artifacts.TestRouter, router, 'configure', [12n, true]);
      await write(artifacts.TestOwner, receiver, 'configure', [true, false]);
      assert.equal((await run()).status, 'success');
      assert.equal(await read(artifacts.TestRouter, router, 'callbackBlocked'), true);
      assert.equal(await read(artifacts.TestOwner, receiver, 'callbackBlocked'), true);
      assert.deepEqual(await inventory(), baseline);
      await write(artifacts.TestOwner, receiver, 'configure', [false, true]);
      const routerBefore = await balance(router);
      assert.equal((await run()).status, 'reverted');
      assert.equal(await balance(router), routerBefore);
      assert.deepEqual(await inventory(), baseline);
    });
    await t.test('nonowner execution and unsolicited native transfers are rejected', async () => {
      assert.equal((await write(artifacts.AtomicExecutor, executor, 'execute',
        [true, 1n, 1n, 1n, deadline], 10n)).status, 'reverted');
      assert.equal((await send(owner, executor, '0x', 1n)).status, 'reverted');
      assert.deepEqual(await inventory(), baseline);
    });
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [owner]);
    assert.equal(await rpc('evm_revert', [snapshot]), true);
  }
});
