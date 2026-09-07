import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { ChainMonitor, PoolRegistry, keyId, backfill, decodeState, readPools, readCurves,
  curveRegistrations, stateSlots, poolId } from '../src/monitor.mjs';
import { CHAINS, DEFAULT_TOKEN, endpoints } from '../src/chains.mjs';
import { FxBook, usd } from '../src/pricing.mjs';

const chain = CHAINS.find(c => c.id === 8453);
const hash = `0x${'a'.repeat(64)}`;
const now = 1_000_000;
const evidence = { chainId: chain.id, poolManager: chain.poolManager,
  managerCodeHash: keccak256('0x6000'), sourceSha256: hash, mappingSlot: '6',
  layout: 'uniswap-v4-pool-state-v1', proxy: false };
function fixture() {
  const calls = [];
  const client = {
    getChainId: async () => chain.id,
    getBlock: async ({ blockNumber } = {}) => ({
      number: blockNumber ?? 50n, hash, timestamp: 1000n,
    }),
    getCode: async () => '0x6000',
    getLogs: async params => { calls.push(params); return []; },
    readContract: async params => {
      calls.push(params);
      if (params.functionName === 'decimals') return 18;
      if (params.functionName === 'extsload') return [
        toHex(1n << 96n, { size: 32 }), toHex(1000n, { size: 32 }),
        toHex(0n, { size: 32 }), toHex(0n, { size: 32 }),
      ];
      throw Error('unexpected read');
    },
  };
  const fx = new FxBook();
  fx.set(chain.id, usd('2000'), now, now);
  return { client, fx, calls };
}

test('storage decoding distinguishes absent market and handles signed ticks', () => {
  const slot = (1n << 96n) | ((1n << 24n) - 1n) << 160n;
  const state = decodeState([toHex(slot, { size: 32 }), toHex(10n, { size: 32 })]);
  assert.equal(state.tick, -1);
  assert.equal(state.sqrtPriceX96, 1n << 96n);
  assert.equal(state.initialised, true);
  assert.equal(decodeState([hash.replaceAll('a', '0'), hash.replaceAll('a', '0')]).initialised, false);
  assert.throws(() => decodeState(['0x']));
  assert.throws(() => stateSlots(hash, -1n));
  assert.notEqual(poolId(DEFAULT_TOKEN, chain.hook), poolId(DEFAULT_TOKEN, '0x' + '0'.repeat(40)));
});

test('all pool slots are read in a single batch pinned to a block', async () => {
  const { client, calls } = fixture();
  const pools = await readPools(client, chain, DEFAULT_TOKEN, evidence, 50n);
  assert.equal(pools.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].length, 4);
  assert.equal(calls[0].blockNumber, 50n);
});

test('unverified layouts and changed bytecode fail closed before pool reads', async () => {
  const { client, calls } = fixture();
  await assert.rejects(readPools(client, chain, DEFAULT_TOKEN, null, 50n));
  await assert.rejects(readPools(client, chain, DEFAULT_TOKEN, { ...evidence, managerCodeHash: hash }, 50n));
  await assert.rejects(readPools(client, chain, DEFAULT_TOKEN, { ...evidence, proxy: true }, 50n));
  assert.equal(calls.length, 0);
});

test('rate-limited log chunk is an error, not successful partial coverage', async () => {
  let count = 0;
  await assert.rejects(backfill({ getLogs: async () => {
    if (++count === 2) throw Error('429');
    return [{}];
  } }, chain.poolManager, 0n, 20n, 10n));
  assert.equal(count, 2);
});

test('snapshot excludes uninitialised pool and labels curve verification gap', async () => {
  const f = fixture();
  const monitor = new ChainMonitor(chain, DEFAULT_TOKEN, { ...f, evidence });
  const result = await monitor.snapshot(now);
  assert.equal(result.coverage, 'fresh');
  assert.equal(result.markets[0].priceUsd, usd('2000'));
  assert.equal(result.markets[1].coverage, 'no-market');
  assert.equal(result.markets[1].priceUsd, null);
  assert.equal(result.markets[2].coverage, 'unverified');
  assert.equal(result.executionEnabled, false);
});

test('RPC failure does not advance cursor or publish retained prices', async () => {
  const f = fixture();
  const monitor = new ChainMonitor(chain, DEFAULT_TOKEN, { ...f, evidence });
  await monitor.snapshot(now);
  f.client.getLogs = async () => { throw Error('rate limited'); };
  const result = await monitor.snapshot(now);
  assert.equal(result.coverage, 'unknown');
  assert.equal(result.markets.length, 0);
  assert.deepEqual(monitor.cursor, { number: 50n, hash });
});

test('reorg triggers canonical backfill and rejects mixed-state snapshot', async () => {
  const f = fixture();
  const monitor = new ChainMonitor(chain, DEFAULT_TOKEN, { ...f, evidence });
  await monitor.snapshot(now);
  const other = `0x${'b'.repeat(64)}`;
  f.client.getBlock = async ({ blockNumber } = {}) => ({
    number: blockNumber ?? 51n, hash: other, timestamp: 1000n,
  });
  const result = await monitor.snapshot(now);
  assert.equal(result.reorgDetected, true);
  assert.ok(f.calls.some(call => call.fromBlock === 31n));
  let reads = 0;
  f.client.getBlock = async () => ({ number: 51n, hash: ++reads === 1 ? hash : other, timestamp: 1000n });
  assert.equal((await monitor.snapshot(now)).coverage, 'unknown');
});

test('wrong network, stale block and missing FX cannot emit comparable market', async () => {
  const f = fixture();
  const monitor = new ChainMonitor(chain, DEFAULT_TOKEN, { ...f, evidence });
  f.client.getChainId = async () => 143;
  assert.equal((await monitor.snapshot(now)).coverage, 'unknown');
  f.client.getChainId = async () => chain.id;
  assert.equal((await monitor.snapshot(now + 100_000)).coverage, 'unknown');
  f.fx.entries.clear();
  const result = await monitor.snapshot(now);
  assert.equal(result.coverage, 'incomplete');
  assert.equal(result.markets[0].coverage, 'missing-fx');
});

test('Robinhood is always explicitly polling-only, even with WS environment', async () => {
  const rh = CHAINS.find(c => c.id === 4663);
  assert.equal(endpoints(rh, { WS_RPC_4663: 'wss://example.org' }).ws, null);
  const f = fixture();
  f.client.getChainId = async () => 4663;
  const result = await new ChainMonitor(rh, DEFAULT_TOKEN, f).snapshot(now);
  assert.match(result.coverageGap, /Robinhood: polling only/);
});

test('removed WS logs invalidate state, errors cannot masquerade as healthy stream', () => {
  const f = fixture();
  let options;
  const monitor = new ChainMonitor(chain, DEFAULT_TOKEN, { ...f,
    wsClient: { watchEvent: opts => { options = opts; return () => {}; } } });
  monitor.start();
  options.onLogs([{ removed: true }]);
  assert.equal(monitor.reorgDetected, true);
  assert.equal(monitor.invalidated, true);
  options.onError(Error('disconnected'));
  assert.equal(monitor.streamHealthy, false);
});

test('dozens of arbitrary PoolKeys survive discovery and share one storage batch', async () => {
  const registry = new PoolRegistry();
  const keys = Array.from({ length: 48 }, (_, i) => ({
    currency0: '0x' + '0'.repeat(40), currency1: DEFAULT_TOKEN,
    fee: 100 + i * 100, tickSpacing: i + 1,
    hooks: i % 2 ? chain.hook : '0x' + '0'.repeat(40),
  }));
  registry.apply(keys.map(key => ({ eventName: 'Initialize',
    args: { ...key, id: keyId(key) }, blockNumber: 40n })));
  assert.equal(registry.values().length, 48);
  const f = fixture();
  let request;
  f.client.readContract = async params => {
    request = params;
    return params.args[0].map((_, i) => toHex(i % 2 ? 100n : 1n << 96n, { size: 32 }));
  };
  const pools = await readPools(f.client, chain, DEFAULT_TOKEN, evidence, 50n, registry.values());
  assert.equal(pools.length, 48);
  assert.equal(request.args[0].length, 96);
  registry.rewind(40n);
  assert.equal(registry.values().length, 0);
});

test('registry preserves intermediate assets but rejects fake Initialize ids', () => {
  const key = { currency0: '0x' + '1'.repeat(40), currency1: '0x' + '2'.repeat(40),
    fee: 500, tickSpacing: 10, hooks: '0x' + '0'.repeat(40) };
  const registry = new PoolRegistry([key]);
  assert.equal(registry.values()[0].key.currency0, key.currency0);
  assert.throws(() => registry.apply([{ eventName: 'Initialize', blockNumber: 1n,
    args: { ...key, id: hash } }]));
  assert.throws(() => registry.add({ ...key, tickSpacing: -1 }, null));
  registry.apply([{ eventName: 'Initialize', removed: true, args: { id: keyId(key) } }]);
  assert.equal(registry.values().length, 0);
});

test('Sewn curve registrations are supported on all chains, not just Base and Robinhood', async () => {
  const f = fixture();
  const curve = { id: 'sewn-1', protocol: 'sewn', quoteChainId: 143,
    units: 'wei-per-whole-token', priceMethod: 'currentCurvePrice',
    address: '0x' + '1'.repeat(40), codeHash: keccak256('0x6000') };
  f.fx.set(143, usd('0.02'), now, now);
  f.client.readContract = async params => {
    assert.equal(params.functionName, 'currentCurvePrice');
    assert.equal(params.blockNumber, 50n);
    return 10n ** 18n;
  };
  for (const deployment of CHAINS) {
    const result = await readCurves(f.client, deployment, DEFAULT_TOKEN, { curves: [curve] },
      50n, f.fx, now);
    assert.equal(result[0].chainId, deployment.id);
    assert.equal(result[0].priceUsd, usd('0.02'));
    assert.equal(result[0].coverage, 'fresh');
    assert.equal(result[0].executable, false);
  }
});

test('curve quote denomination and ABI must be explicit; new deployments never imply ETH FX', async () => {
  const f = fixture();
  const curve = { id: 'sewn-1', protocol: 'sewn', units: 'wei-per-whole-token',
    priceMethod: 'currentCurvePrice', address: '0x' + '1'.repeat(40), codeHash: keccak256('0x6000') };
  let result = await readCurves(f.client, chain, DEFAULT_TOKEN, { curves: [curve] }, 50n, f.fx, now);
  assert.equal(result[0].coverage, 'unverified');
  result = await readCurves(f.client, chain, DEFAULT_TOKEN, {
    curves: [{ ...curve, quoteChainId: 8453, priceMethod: 'unknownSewnAbi' }],
  }, 50n, f.fx, now);
  assert.equal(result[0].coverage, 'unverified');
  assert.equal(f.calls.length, 0);
  assert.throws(() => curveRegistrations(chain, { curves: [curve, curve] }));
  assert.ok(curveRegistrations(CHAINS.find(c => c.id === 143), null).some(c => c.protocol === 'sewn'));
});
