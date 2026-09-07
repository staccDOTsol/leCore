import test from 'node:test';
import assert from 'node:assert/strict';
import { researchRoutes } from '../src/aggregator.mjs';
import { keyId } from '../src/monitor.mjs';
import { assetId, ROUTE_VALUE_SCALE } from '../src/routes.mjs';

const NOW = 1_000_000;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const asset = (n, chainId = 1) => ({ chainId, address: address(n) });
function fixture() {
  const assignments = {};
  const chains = [1, 2].map(chainId => {
    const chain = { chainId, coverage: 'fresh', observedAt: NOW, blockNumber: 100n,
      blockHash: hash(chainId), stateRoot: hash(chainId + 10), discovery: 'configured-range' };
    chain.pools = [[1, 2, 100], [1, 2, 200], [2, 3, 300], [1, 3, 400]].map(([a, b, fee]) => {
      const key = { currency0: address(a), currency1: address(b),
        fee, tickSpacing: 60, hooks: address(0) };
      const id = keyId(key), poolManager = address(100);
      assignments[`${chainId}:${poolManager}:${id}`] = 'test';
      return { id, key, chainId, poolManager, venue: `hookless:${id}`, initialised: true,
        blockNumber: chain.blockNumber, blockHash: chain.blockHash, liquidity: 1000n,
        sqrtPriceX96: 2n ** 96n, quoteAdapter: 'unverified', executable: false };
    });
    return chain;
  });
  return { report: { chains }, assignments };
}
const rate = (edge, amount) => edge.from.address === address(2) && edge.to.address === address(3)
  ? amount * 12n / 10n : amount;
const quote = (edge, amountIn, pins) => ({
  status: 'success', complete: true, edgeId: edge.id, adapterId: edge.adapterId,
  from: edge.from, to: edge.to, amountIn, amountOut: rate(edge, amountIn),
  pins: structuredClone(pins), observedAt: NOW, feesIncluded: true, outputHookFeesIncluded: true,
});
const adapters = { test: {
  supports: edge => edge.kind !== 'pool' || edge.poolKey.hooks === address(0),
  quote: async ({ edge, amountIn, pins }) => quote(edge, amountIn, pins),
} };
async function simulateRoute({ route, amountIn, pins, ...rest }) {
  assert.deepEqual(rest, {});
  let amount = amountIn;
  const steps = route.edges.map(edge => {
    const step = quote(edge, amount, pins);
    amount = step.amountOut;
    return step;
  });
  return { routeId: route.id, amountIn, amountOut: amount, pins, observedAt: NOW,
    status: 'success', executionMode: 'whole-route', sequentialState: true,
    feesIncluded: true, outputHookFeesIncluded: true, steps, atomic: !route.nonAtomic,
    inventoryVerified: true, latencyRiskAccepted: true,
    gasCosts: route.chainIds.map(chainId => ({ chainId, nativeCost: 1n })) };
}
const evaluate = ({ amountIn, simulation }) => ({
  eligible: true, numeraire: 'USD', scale: ROUTE_VALUE_SCALE,
  net: simulation.amountOut - amountIn - simulation.gasCosts.reduce((sum, cost) => sum + cost.nativeCost, 0n),
});
const searches = [1, 2].map(chainId => ({
  start: asset(1, chainId), sizes: [100n, 200n], maxHops: 3, clock: () => NOW,
}));
const research = (report, options = {}) => researchRoutes(report, { now: NOW, ...options });

test('default CLI routing coverage is paper-only and never trusts snapshot quoteAdapter labels', async () => {
  const { report } = fixture();
  const result = await research(report);
  assert.equal(result.mode, 'paper');
  assert.equal(result.fundedTrading, false);
  assert.equal(result.automaticBridging, false);
  assert.equal(result.supportedDirectedEdges, 0);
  assert.equal(result.rejectedPools.length, 8);
  assert.ok(result.rejectedPools.every(row => /adapter binding required/.test(row.reason)));
  assert.deepEqual(result.results, []);
});

test('unknown, stale and missing-state-root chain snapshots are excluded', async () => {
  for (const mutate of [
    chain => { chain.coverage = 'unknown'; },
    chain => { chain.observedAt = NOW - 30_001; },
    chain => { chain.observedAt = NOW + 1; },
    chain => { delete chain.stateRoot; },
    chain => { chain.stateRoot = hash(1).slice(0, -1); },
  ]) {
    const { report, assignments } = fixture();
    mutate(report.chains[0]);
    const result = await research(report, { adapters, assignments });
    assert.deepEqual(result.excludedChains, [1]);
    assert.equal(result.supportedDirectedEdges, 8);
    assert.deepEqual(result.rejectedPools, []);
  }
});

test('adapter assignments are deployment-specific and unsupported hooks fail closed', async () => {
  const { report, assignments } = fixture();
  const first = report.chains[0].pools[0];
  const only = { [`1:${first.poolManager}:${first.id}`]: 'test' };
  const scoped = await research(report, { adapters, assignments: only });
  assert.equal(scoped.supportedDirectedEdges, 2);
  assert.equal(scoped.rejectedPools.length, 7);
  first.key.hooks = address(9);
  first.id = keyId(first.key);
  assignments[`1:${first.poolManager}:${first.id}`] = 'test';
  const blocked = await research(report, { adapters, assignments });
  assert.equal(blocked.supportedDirectedEdges, 14);
  assert.match(blocked.rejectedPools[0].reason, /unsupported adapter or hook/);
  report.chains[1].pools[0].initialised = false;
  assert.equal((await research(report, { adapters, assignments })).supportedDirectedEdges, 12);
});

test('two chain snapshots produce independent simulated three-hop self-cycles and sized paper candidates', async () => {
  const { report, assignments } = fixture();
  const result = await research(report, { adapters, assignments, searches, simulateRoute, evaluate });
  assert.equal(result.supportedDirectedEdges, 16);
  assert.equal(result.results.length, 2);
  for (const [i, run] of result.results.entries()) {
    assert.equal(run.best.route.edges.length, 3);
    assert.equal(run.best.amountIn, 200n);
    assert.equal(run.best.assessment.net, 39n);
    assert.deepEqual(run.best.route.chainIds, [i + 1]);
    assert.equal(assetId(run.best.route.from), assetId(run.best.route.to));
    assert.equal(run.best.simulationValidated, true);
    assert.equal(run.best.executable, false);
    assert.equal(run.best.liveAuthorized, false);
    assert.equal(run.splitRoutesSupported, false);
    assert.equal(run.globallyOptimal, false);
  }
});

test('prefunded cross-chain edges require verified equivalence and remain non-atomic', async () => {
  const { report, assignments } = fixture();
  const transfer = { id: 'inventory-1-2', kind: 'inventory', adapterId: 'test',
    from: asset(2, 1), to: asset(2, 2), equivalenceId: 'verified-2', latencyMs: 1000 };
  const equivalence = { id: 'verified-2', verified: true, verifiedBy: 'registry',
    evidenceId: 'audit', issuedAt: NOW, expiresAt: NOW + 10_000,
    deployments: [transfer.from, transfer.to] };
  const options = { adapters, assignments, transfers: [transfer],
    searches: [{ ...searches[0], targets: [asset(3, 2)] }], simulateRoute, evaluate };
  const absent = await research(report, options);
  assert.equal(absent.rejectedPools.filter(row => row.kind === 'transfer').length, 1);
  assert.equal(absent.results[0].best, null);
  const verified = await research(report, { ...options, equivalences: [equivalence] });
  assert.equal(verified.results[0].best.route.kind, 'cross-chain-inventory');
  assert.equal(verified.results[0].best.simulation.atomic, false);
  assert.equal(verified.results[0].best.executable, false);
});

test('per-search expired clocks and malformed policy are reported without execution authority', async () => {
  const { report, assignments } = fixture();
  const result = await research(report, { adapters, assignments, simulateRoute, evaluate,
    searches: [
      { ...searches[0], clock: () => NOW + 30_001 },
      { ...searches[1], sizes: [100] },
    ] });
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(run => run.best === null && run.executable === false
    && /blocked/.test(run.reason)));
});

test('snapshot identity, block and fallback diagnostics cannot become assigned routing edges', async () => {
  for (const mutate of [
    pool => { pool.id = hash(999); },
    pool => { pool.chainId = 2; },
    pool => { pool.blockHash = hash(999); },
    pool => { pool.blockNumber = 99n; },
    pool => { pool.venue = 'hookless'; },
    pool => { pool.discoverySource = 'baseline'; },
  ]) {
    const { report, assignments } = fixture();
    mutate(report.chains[0].pools[0]);
    const result = await research(report, { adapters, assignments });
    assert.equal(result.supportedDirectedEdges, 14);
    assert.equal(result.rejectedPools.length, 1);
    assert.equal(result.rejectedPools[0].kind, 'snapshot');
  }
});
