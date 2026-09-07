import test from 'node:test';
import assert from 'node:assert/strict';
import { assetId, poolId, buildRouteGraph, searchRoutes } from '../src/routes.mjs';

const NOW = 1_000_000;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const asset = (n, chainId = 1) => ({ chainId, address: address(n) });
const A = asset(1), B = asset(2), C = asset(3);
const pins = Object.fromEntries([1, 2].map(chainId => [chainId,
  { chainId, blockHash: hash(chainId), stateRoot: hash(chainId + 10), observedAt: NOW }]));
const pool = (a, b, n, overrides = {}) => ({
  chainId: a.chainId, manager: address(100),
  poolKey: { currency0: a.address, currency1: b.address, fee: n, tickSpacing: 60, hooks: address(0) },
  adapterId: 'test', ...overrides,
});
const result = (edge, amountIn, amountOut, state = pins) => ({
  status: 'success', complete: true, edgeId: edge.id, adapterId: edge.adapterId,
  from: edge.from, to: edge.to, amountIn, amountOut, pins: structuredClone(state),
  observedAt: NOW, feesIncluded: true, outputHookFeesIncluded: true,
});
function adapter(rate = (_edge, amount) => amount) {
  return { supports: () => true,
    quote: async ({ edge, amountIn, pins: state }) => result(edge, amountIn, rate(edge, amountIn), state) };
}
function simulator(rate = (_edge, amount) => amount, gas = () => 1n) {
  return async ({ route, amountIn, pins: state, ...rest }) => {
    assert.deepEqual(rest, {}, 'simulator must not receive independently composed quotes');
    let amount = amountIn;
    const steps = route.edges.map(edge => {
      const output = rate(edge, amount);
      const step = result(edge, amount, output, state);
      amount = output;
      return step;
    });
    return { status: 'success', executionMode: 'whole-route', sequentialState: true,
      routeId: route.id, amountIn, amountOut: amount, steps, pins: state,
      observedAt: NOW, feesIncluded: true, outputHookFeesIncluded: true,
      atomic: !route.nonAtomic, inventoryVerified: true, latencyRiskAccepted: true,
      gasCosts: route.chainIds.map(chainId => ({ chainId, nativeCost: gas(amountIn) })) };
  };
}
const evaluate = ({ amountIn, simulation }) => ({
  eligible: true,
  net: simulation.amountOut - amountIn - simulation.gasCosts.reduce((sum, cost) => sum + cost.nativeCost, 0n),
});
const search = (graph, overrides = {}) => searchRoutes({
  graph, start: A, sizes: [100n], pins, now: NOW, maxHops: 3, ...overrides,
});
const graphOf = (pools, rate) => buildRouteGraph({ pools, adapters: { test: adapter(rate) }, now: NOW });
const pairGraph = rate => graphOf([pool(A, B, 100), pool(A, B, 200)], rate);

test('asset and PoolKey identity includes chain, fee, tick spacing and hooks, never symbol', () => {
  assert.notEqual(assetId(A), assetId({ ...A, chainId: 2, symbol: 'SAME' }));
  const base = pool(A, B, 100);
  const variants = [base, { ...base, chainId: 2 },
    { ...base, poolKey: { ...base.poolKey, fee: 200 } },
    { ...base, poolKey: { ...base.poolKey, tickSpacing: 10 } },
    { ...base, poolKey: { ...base.poolKey, hooks: address(700) } }];
  assert.equal(new Set(variants.map(poolId)).size, 5);
  assert.equal(poolId(base), poolId({ ...base, adapterId: 'alias' }));
  assert.throws(() => assetId({ ...A, chainId: '1' }), /identity/);
  assert.throws(() => poolId({ ...base, poolKey: { ...base.poolKey, tickSpacing: 0 } }), /PoolKey/);
});

test('dozens of pools are retained per pair per chain and a three-hop cycle beats all two-hop cycles', async () => {
  const pools = [];
  for (const chainId of [1, 2]) {
    for (let fee = 1; fee <= 36; fee++) {
      pools.push(pool(asset(1, chainId), asset(2, chainId), fee));
    }
    pools.push(pool(asset(2, chainId), asset(3, chainId), 500));
    pools.push(pool(asset(1, chainId), asset(3, chainId), 600));
  }
  const rate = (edge, amount) => edge.from.address === B.address && edge.to.address === C.address
    ? amount * 12n / 10n : amount;
  const graph = graphOf(pools, rate);
  assert.equal(graph.edges.length, 152);
  assert.deepEqual(graph.rejected, []);
  const report = await search(graph, { simulateRoute: simulator(rate), evaluate,
    maxCandidates: 5000, maxSimulations: 5000, maxExpansions: 50_000, maxQuotes: 50_000 });
  assert.ok(report.candidates.some(candidate => candidate.route.edges.length === 2));
  assert.equal(report.best.route.edges.length, 3);
  assert.equal(report.best.assessment.net, 19n);
  assert.ok(report.candidates.every(candidate => candidate.route.chainIds.length === 1
    && candidate.route.chainIds[0] === 1));
  assert.equal(report.globallyOptimal, false);
  assert.equal(report.best.executable, false);
  assert.equal(report.best.liveAuthorized, false);
});

test('whole-route simulation and per-size economics, not profitable composed quotes, pick the best size', async () => {
  const graph = pairGraph((_edge, amount) => amount * 2n);
  const seen = [];
  const actualRate = (edge, amount) => edge.from.address === A.address ? amount
    : amount + (amount <= 100n ? 20n : 25n);
  const report = await search(graph, { sizes: [10n, 100n, 200n, 100n], maxHops: 2,
    simulateRoute: simulator(actualRate, size => size === 200n ? 40n : size === 10n ? 10n : 2n),
    evaluate: args => { seen.push(args.amountIn); return evaluate(args); } });
  assert.equal(report.best.amountIn, 100n);
  assert.equal(report.best.assessment.net, 18n);
  assert.equal(report.best.simulation.amountOut, 120n);
  assert.equal(report.best.estimatedAmountOut, 400n);
  assert.deepEqual([...new Set(seen)], [10n, 100n, 200n]);
  assert.ok(report.candidates.filter(candidate => candidate.amountIn === 200n)
    .every(candidate => !candidate.paperCandidate));
});

test('without simulator/evaluator quotes remain exploratory and all modes deny live authorization', async () => {
  for (const mode of ['paper', 'readonly']) {
    const report = await search(pairGraph((_edge, amount) => amount * 2n), { mode });
    assert.equal(report.best, null);
    assert.ok(report.candidates.length > 0);
    assert.ok(report.candidates.every(candidate => !candidate.simulationValidated
      && !candidate.paperCandidate && !candidate.executable && !candidate.liveAuthorized));
  }
  await assert.rejects(search(pairGraph(), { mode: 'live' }), /readonly\/paper/);
});

test('duplicate physical pools including adapter aliases and opposite directions cannot reuse reserves', async () => {
  const base = pool(A, B, 100);
  const graph = buildRouteGraph({ pools: [base, { ...base, adapterId: 'alias' }],
    adapters: { test: adapter(), alias: adapter() }, now: NOW });
  assert.equal(graph.edges.length, 2);
  assert.match(graph.rejected[0].reason, /duplicate physical pool/);
  assert.equal((await search(graph)).candidates.length, 0);
  const report = await search(pairGraph(), { maxHops: 10 });
  assert.ok(report.candidates.every(candidate =>
    new Set(candidate.route.edges.map(edge => edge.poolId)).size === candidate.route.edges.length));
  assert.equal(report.splitRoutesSupported, false, 'alternatives must not become additive split routes');
});

test('unsupported hooks/adapters fail closed while explicitly supported differing PoolKeys work', () => {
  const base = pool(A, B, 100);
  const hooked = { ...base, poolKey: { ...base.poolKey, hooks: address(9), tickSpacing: 10 } };
  const graph = buildRouteGraph({ pools: [base, hooked, { ...base, adapterId: 'missing',
    poolKey: { ...base.poolKey, fee: 300 } }],
  adapters: { test: { ...adapter(), supports: edge => edge.poolKey.hooks === address(0) } }, now: NOW });
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.rejected.length, 2);
  assert.ok(graph.rejected.every(row => /unsupported/.test(row.reason)));
  assert.equal(graphOf([base, hooked]).edges.length, 4);
});

test('malformed, partial, wrong-chain, stale-block, stale-state and non-net quotes are tagged unusable', async () => {
  for (const mutate of [
    q => { q.status = 'partial'; }, q => { q.complete = false; },
    q => { q.amountOut = '200'; }, q => { q.amountOut = 0n; },
    q => { q.amountIn = 100; }, q => { q.edgeId = 'different'; },
    q => { q.adapterId = 'missing'; }, q => { q.from = asset(1, 2); },
    q => { q.to = asset(2, 2); }, q => { q.pins[1].blockHash = hash(9); },
    q => { q.pins[1].stateRoot = hash(9); }, q => { q.observedAt = NOW - 30_001; },
    q => { q.observedAt = NOW + 1; }, q => { q.feesIncluded = false; },
    q => { q.outputHookFeesIncluded = false; },
  ]) {
    const graph = pairGraph();
    graph.adapters.test.quote = async ({ edge, amountIn }) => {
      const quote = result(edge, amountIn, 200n); mutate(quote); return quote;
    };
    const report = await search(graph);
    assert.equal(report.candidates.length, 0);
    assert.ok(report.failures.length > 0);
    assert.ok(report.failures.every(failure => failure.stage === 'quote'
      && failure.edgeId && failure.usable === false));
  }
});

test('one quote failure does not silently poison or suppress independent healthy routes', async () => {
  const graph = graphOf([pool(A, B, 1), pool(A, B, 2), pool(A, B, 3)]);
  graph.adapters.test.quote = async ({ edge, amountIn }) => {
    if (edge.poolKey.fee === 1) throw new Error('RPC unavailable');
    return result(edge, amountIn, amountIn + 10n);
  };
  const report = await search(graph, { simulateRoute: simulator((_edge, amount) => amount + 10n), evaluate });
  assert.ok(report.failures.length);
  assert.ok(report.best);
  assert.ok(report.candidates.every(candidate => candidate.route.edges.every(edge => edge.poolKey.fee !== 1)));
});

test('simulation must bind whole sequence, amounts, current block/state, fees and gas', async () => {
  for (const mutate of [
    s => { s.executionMode = 'independent-quotes'; }, s => { s.sequentialState = false; },
    s => { s.routeId = 'other'; }, s => { s.steps.reverse(); },
    s => { s.steps.pop(); }, s => { s.steps[1].amountIn++; },
    s => { s.amountOut++; }, s => { s.pins[1].blockHash = hash(19); },
    s => { s.steps[1].pins[1].stateRoot = hash(19); },
    s => { s.outputHookFeesIncluded = false; }, s => { s.gasCosts = []; },
    s => { s.gasCosts[0].nativeCost = 1; }, s => { s.atomic = false; },
  ]) {
    const report = await search(pairGraph(), {
      simulateRoute: async args => { const s = await simulator()(args); mutate(s); return s; }, evaluate,
    });
    assert.equal(report.best, null);
    assert.ok(report.candidates.every(candidate => !candidate.paperCandidate && !candidate.executable));
    assert.ok(report.failures.some(failure => failure.stage === 'simulation/evaluation'));
  }
});

test('already net output-hook fees are not subtracted a second time, including subsequent hop input', async () => {
  const base = pool(A, B, 100);
  const hooked = { ...base, poolKey: { ...base.poolKey, hooks: address(9) } };
  const inputs = [];
  const rate = (_edge, amount) => amount - 7n;
  const graph = graphOf([base, hooked], rate);
  graph.adapters.test.quote = async ({ edge, amountIn }) => {
    inputs.push(amountIn);
    return { ...result(edge, amountIn, amountIn - 7n), outputHookFee: 7n };
  };
  const report = await search(graph, { maxHops: 2, simulateRoute: simulator(rate), evaluate });
  assert.ok(inputs.includes(93n));
  assert.ok(report.candidates.every(candidate =>
    candidate.estimatedAmountOut === 86n && candidate.simulation.amountOut === 86n));
});

const certificate = {
  id: 'verified-token', verified: true, verifiedBy: 'trusted-registry', evidenceId: 'audit-1',
  issuedAt: NOW, expiresAt: NOW + 10_000, deployments: [B, asset(2, 2)],
};
const transfer = kind => ({ id: kind, kind, from: B, to: asset(2, 2), adapterId: 'test',
  equivalenceId: certificate.id, latencyMs: 90_000 });
function crossGraph(kind, equivalences = [certificate]) {
  return buildRouteGraph({ pools: [pool(A, B, 100), pool(asset(1, 2), asset(2, 2), 100)],
    transfers: [transfer(kind)], equivalences, adapters: { test: adapter() }, now: NOW });
}

test('cross-chain inventory and bridge rebalancing routes are never atomic or live authorized', async () => {
  for (const kind of ['inventory', 'bridge']) {
    const graph = crossGraph(kind);
    const report = await search(graph, { targets: [asset(1, 2)],
      simulateRoute: simulator((_edge, amount) => amount + 10n), evaluate });
    assert.equal(report.candidates.length, 1);
    assert.equal(report.best.route.kind, kind === 'bridge' ? 'cross-chain-rebalancing' : 'cross-chain-inventory');
    assert.equal(report.best.route.nonAtomic, true);
    assert.equal(report.best.route.latencyRisk, true);
    assert.equal(report.best.route.latencyMs, 90_000);
    assert.equal(report.best.simulation.atomic, false);
    assert.equal(report.best.executable, false);
    const rejected = await search(graph, { targets: [asset(1, 2)], evaluate,
      simulateRoute: async args => ({ ...await simulator()(args), atomic: true }) });
    assert.equal(rejected.best, null);
  }
});

test('same addresses/symbols do not imply cross-chain identity; verification and deployment bindings are mandatory', () => {
  for (const certs of [[], [{ ...certificate, verified: false }],
    [{ ...certificate, verifiedBy: '' }], [{ ...certificate, evidenceId: '' }],
    [{ ...certificate, deployments: [B, asset(9, 2)] }],
    [{ ...certificate, expiresAt: NOW }], [certificate, certificate]]) {
    const graph = crossGraph('inventory', certs);
    assert.equal(graph.edges.length, 4);
    assert.equal(graph.rejected.length, 1);
    assert.equal(graph.rejected[0].kind, 'transfer');
  }
});

test('all bounded budgets disclose truncation rather than global optimality', async () => {
  const graph = graphOf([pool(A, B, 1), pool(A, B, 2), pool(B, C, 1), pool(A, C, 1)]);
  for (const limit of ['maxHops', 'maxExpansions', 'maxQuotes', 'maxCandidates', 'maxSimulations']) {
    const report = await search(graph, { [limit]: 1, simulateRoute: simulator(), evaluate });
    assert.equal(report.truncated, true, limit);
    assert.ok(report.truncationReasons.includes(limit), `${limit}: ${report.truncationReasons}`);
    assert.equal(report.globallyOptimal, false);
    if (limit === 'maxExpansions') assert.ok(report.budget.expansions <= 1);
    if (limit === 'maxQuotes') assert.ok(report.budget.quotes <= 1);
    if (limit === 'maxCandidates') assert.ok(report.candidates.length <= 1);
    if (limit === 'maxSimulations') assert.ok(report.budget.simulations <= 1);
  }
});

test('missing/stale pins, mixed numeric sizes, expired equivalence and malformed graph chains fail closed', async () => {
  await assert.rejects(search(pairGraph(), { pins: {} }), /pinned/);
  await assert.rejects(search(pairGraph(), { sizes: [1n, 2] }), /BigInt/);
  await assert.rejects(search(pairGraph(), { maxHops: 65 }), /depth/);
  const stale = structuredClone(pins); stale[1].observedAt = NOW - 30_001;
  await assert.rejects(search(pairGraph(), { pins: stale }), /pinned/);
  const malformed = pairGraph(); malformed.edges[0].to = { ...malformed.edges[0].to, chainId: 2 };
  await assert.rejects(search(malformed), /malformed pool edge/);
  await assert.rejects(search(crossGraph('inventory'), { now: NOW + 10_001 }), /equivalence/);
});
