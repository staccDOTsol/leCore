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
  start: asset(1, chainId), sizes: [100n, 200n], maxHops: 3,
}));
const research = (report, options = {}) => researchRoutes(report, { now: NOW, clock: () => NOW, ...options });

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

test('shared expired clock, malformed policy and invalid mode retain their actual error diagnostics', async () => {
  const { report, assignments } = fixture();
  const result = await research(report, { adapters, assignments, simulateRoute, evaluate,
    clock: () => NOW + 30_001,
    searches: [
      searches[0],
      { ...searches[1], sizes: [100] },
      { ...searches[1], mode: 'live' },
    ] });
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every(run => run.best === null && run.executable === false
    && /blocked/.test(run.reason)));
  assert.match(result.results[0].reason, /stale pinned/);
  assert.match(result.results[1].reason, /BigInt/);
  assert.match(result.results[2].reason, /readonly\/paper/);
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

test('a later search taking 31 seconds invalidates all earlier retained candidates using the shared clock', async () => {
  const { report, assignments } = fixture();
  let time = NOW, firstSimulations = 0;
  const slow = { test: { ...adapters.test, quote: async args => {
    if (args.edge.from.chainId === 2) {
      assert.ok(firstSimulations > 0);
      time = NOW + 31_000;
    }
    return adapters.test.quote(args);
  } } };
  const result = await research(report, { assignments, adapters: slow, clock: () => time,
    searches: searches.map(search => ({ ...search, clock: () => NOW })),
    simulateRoute: async args => {
      if (args.route.chainIds.includes(1)) firstSimulations++;
      return simulateRoute(args);
    }, evaluate });
  assert.ok(result.results[0].candidates.length > 0);
  assert.equal(result.results[0].best, null);
  assert.ok(result.results[0].candidates.every(candidate => !candidate.paperCandidate
    && !candidate.simulationValidated && candidate.status === 'expired'));
  assert.ok(result.results[0].failures.some(row => row.stage === 'expiry' && /stale pinned/.test(row.reason)));
});

test('final aggregation revalidates simulation and step timestamps even when chain pins remain fresh', async () => {
  for (const staleField of ['simulation', 'steps']) {
    const { report, assignments } = fixture();
    let time = NOW;
    const slow = { test: { ...adapters.test, quote: async args => {
      if (args.edge.from.chainId === 2) time = NOW + 15_000;
      return adapters.test.quote(args);
    } } };
    const result = await research(report, { assignments, adapters: slow, searches, clock: () => time,
      simulateRoute: async args => {
        const value = await simulateRoute(args);
        if (args.route.chainIds[0] === 1) {
          if (staleField === 'simulation') value.observedAt = NOW - 20_000;
          else value.steps.forEach(step => { step.observedAt = NOW - 20_000; });
        }
        return value;
      }, evaluate });
    assert.equal(result.results[0].best, null, staleField);
    assert.ok(result.results[1].best, staleField);
    assert.ok(result.results[0].candidates.every(candidate => !candidate.paperCandidate
      && !candidate.simulationValidated), staleField);
  }
});

test('expired transfer equivalence clears an earlier cross-chain winner without disabling local routes', async () => {
  const { report, assignments } = fixture();
  let time = NOW;
  const transfer = { id: 'inventory-1-2', kind: 'inventory', adapterId: 'test',
    from: asset(2, 1), to: asset(2, 2), equivalenceId: 'verified-2', latencyMs: 1000 };
  const equivalence = { id: 'verified-2', verified: true, verifiedBy: 'registry',
    evidenceId: 'audit', issuedAt: NOW, expiresAt: NOW + 10_000,
    deployments: [transfer.from, transfer.to] };
  let crossCompleted = false;
  const slow = { test: { ...adapters.test, quote: async args => {
    if (crossCompleted && args.edge.from.chainId === 1 && args.amountIn === 300n) time = NOW + 15_000;
    return adapters.test.quote(args);
  } } };
  const result = await research(report, { assignments, adapters: slow, clock: () => time,
    transfers: [transfer], equivalences: [equivalence],
    searches: [{ ...searches[0], sizes: [100n], targets: [asset(3, 2)] },
      { ...searches[0], sizes: [300n] }],
    simulateRoute, evaluate: args => {
      if (args.route.nonAtomic) crossCompleted = true;
      return evaluate(args);
    } });
  assert.ok(crossCompleted);
  assert.equal(result.results[0].best, null);
  assert.ok(result.results[0].failures.some(row => row.stage === 'expiry' && /equivalence/.test(row.reason)));
  assert.ok(result.results[1].best);
});

test('an unavailable transfer-only destination chain is diagnostic and leaves local opportunities usable', async () => {
  const { report, assignments } = fixture();
  report.chains = [report.chains[0]];
  const transfer = { id: 'offline-destination', kind: 'inventory', adapterId: 'test',
    from: asset(2, 1), to: asset(2, 2), equivalenceId: 'verified-2', latencyMs: 1000 };
  const equivalence = { id: 'verified-2', verified: true, verifiedBy: 'registry',
    evidenceId: 'audit', issuedAt: NOW, expiresAt: NOW + 10_000,
    deployments: [transfer.from, transfer.to] };
  const result = await research(report, { adapters, assignments, transfers: [transfer],
    equivalences: [equivalence], searches: [searches[0]], simulateRoute, evaluate });
  assert.ok(result.results[0].best);
  assert.deepEqual(result.results[0].best.route.chainIds, [1]);
  assert.ok(result.results[0].graphRejections.some(row =>
    row.edgeId === 'transfer:offline-destination' && /pinned chain state: 2/.test(row.reason)));
});
