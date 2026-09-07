const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = `0x${'0'.repeat(40)}`;
export const ROUTE_VALUE_SCALE = 10n ** 18n;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const uint = value => typeof value === 'bigint' && value >= 0n;
const fresh = (time, now, age) => Number.isSafeInteger(time) && time <= now && time >= now - age;
const clone = value => structuredClone(value);

export function assetId(asset) {
  requireThat(positiveInteger(asset?.chainId) && ADDRESS.test(asset.address), 'invalid asset identity');
  return `${asset.chainId}:${asset.address.toLowerCase()}`;
}

function normalAsset(asset) {
  assetId(asset);
  return Object.freeze({ chainId: asset.chainId, address: asset.address.toLowerCase() });
}

/** Physical pool identity deliberately excludes adapterId: adapter aliases cannot reuse reserves. */
export function poolId(pool) {
  const key = pool?.poolKey;
  requireThat(positiveInteger(pool?.chainId) && ADDRESS.test(pool.manager), 'invalid pool deployment');
  requireThat(key && ADDRESS.test(key.currency0) && ADDRESS.test(key.currency1)
    && BigInt(key.currency0) < BigInt(key.currency1), 'PoolKey currencies must be canonical');
  requireThat(Number.isInteger(key.fee) && key.fee >= 0 && key.fee <= 0xffffff
    && Number.isInteger(key.tickSpacing) && key.tickSpacing > 0 && key.tickSpacing <= 32767
    && ADDRESS.test(key.hooks), 'invalid PoolKey fee/tickSpacing/hooks');
  return [pool.chainId, pool.manager.toLowerCase(), key.currency0.toLowerCase(),
    key.currency1.toLowerCase(), key.fee, key.tickSpacing, key.hooks.toLowerCase()].join(':');
}

/** Monitor snapshot binding key: chainId:manager:keccak256(abi.encode(PoolKey)). */
export function snapshotPoolId(snapshot) {
  const pool = { chainId: snapshot?.chainId, manager: snapshot?.poolManager, poolKey: snapshot?.key };
  poolId(pool);
  const key = pool.poolKey;
  const hash = keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' },
    { type: 'int24' }, { type: 'address' },
  ], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  requireThat(HASH.test(snapshot.id) && snapshot.id.toLowerCase() === hash,
    'snapshot PoolKey/id mismatch');
  return `${pool.chainId}:${pool.manager.toLowerCase()}:${hash}`;
}

/**
 * Convert scan().chains[].pools, not native/target-only markets.
 * adapterBindings maps snapshotPoolId(snapshot) to a trusted adapters registry ID.
 * Unverified quoteAdapter labels never select an adapter. Baseline fallback rows
 * remain diagnostics only; Initialize-discovered intermediates are not filtered.
 * Returned pins are observations, not evidence of adapter/simulator correctness.
 */
export function graphFromPoolSnapshots(report, {
  adapters = {}, adapterBindings = {}, transfers = [], equivalences = [],
  now = Date.now(), maxAgeMs = 30_000,
} = {}) {
  requireThat(Array.isArray(report?.chains), 'pool snapshot report requires chains');
  const pools = [], diagnostics = [], pins = {}, provenance = new Map();
  const seenChains = new Set();
  for (const chain of report.chains) {
    requireThat(positiveInteger(chain.chainId) && !seenChains.has(chain.chainId),
      'invalid/duplicate snapshot chain');
    seenChains.add(chain.chainId);
    requireThat(Array.isArray(chain.pools), 'chain pool snapshots required');
    for (const snapshot of chain.pools) {
      try {
        requireThat(snapshot.chainId === chain.chainId, 'snapshot chain mismatch');
        const deploymentId = snapshotPoolId(snapshot);
        requireThat(!['hooked', 'hookless'].includes(snapshot.venue)
          && snapshot.discoverySource !== 'baseline', 'baseline fallback is diagnostic only');
        requireThat(HASH.test(chain.blockHash) && HASH.test(snapshot.blockHash)
          && snapshot.blockHash.toLowerCase() === chain.blockHash.toLowerCase()
          && uint(snapshot.blockNumber) && snapshot.blockNumber === chain.blockNumber,
        'snapshot block mismatch');
        const state = { chainId: chain.chainId, blockHash: chain.blockHash,
          stateRoot: chain.stateRoot, observedAt: chain.observedAt };
        validatePins({ [chain.chainId]: state }, [chain.chainId], now, maxAgeMs);
        requireThat(snapshot.initialised !== false && uint(snapshot.liquidity) && snapshot.liquidity > 0n
          && uint(snapshot.sqrtPriceX96) && snapshot.sqrtPriceX96 > 0n,
        'snapshot has no active initialized liquidity');
        const adapterId = Object.hasOwn(adapterBindings, deploymentId) && adapterBindings[deploymentId];
        requireThat(typeof adapterId === 'string' && adapterId.length > 0 && adapterId !== 'unverified',
          'explicit supported adapter binding required');
        const pool = { chainId: snapshot.chainId, manager: snapshot.poolManager,
          poolKey: clone(snapshot.key), adapterId };
        pools.push(pool);
        provenance.set(poolId(pool), { deploymentId, snapshot: clone(snapshot) });
        pins[chain.chainId] = state;
      } catch (error) {
        diagnostics.push({ kind: 'snapshot', chainId: chain.chainId, snapshot: clone(snapshot),
          reason: error.message, executable: false });
      }
    }
  }
  const graph = buildRouteGraph({ pools, adapters, transfers, equivalences, now, maxAgeMs });
  for (const edge of graph.edges) {
    if (edge.kind === 'pool') Object.assign(edge, clone(provenance.get(edge.poolId)));
  }
  return { ...graph, pins, diagnostics, discovery: report.chains.map(chain => ({
    chainId: chain.chainId, coverage: chain.discovery ?? 'unknown',
    warnings: clone(chain.warnings ?? []),
  })), executable: false, liveAuthorized: false };
}

function equivalence(record, from, to, now, maxAgeMs) {
  requireThat(record?.verified === true && typeof record.id === 'string' && record.id.length > 0
    && typeof record.verifiedBy === 'string' && record.verifiedBy.trim().length > 0
    && typeof record.evidenceId === 'string' && record.evidenceId.trim().length > 0
    && fresh(record.issuedAt, now, maxAgeMs) && Number.isSafeInteger(record.expiresAt)
    && record.expiresAt > now && Array.isArray(record.deployments),
  'explicit verified token equivalence required');
  const identities = record.deployments.map(assetId);
  requireThat(identities.includes(assetId(from)) && identities.includes(assetId(to)),
    'token equivalence deployment mismatch');
}

function supported(adapters, edge) {
  const adapter = Object.hasOwn(adapters, edge.adapterId) && adapters[edge.adapterId];
  requireThat(adapter && typeof adapter.quote === 'function' && typeof adapter.supports === 'function'
    && adapter.supports(clone(edge)) === true, 'unsupported adapter or hook');
  return adapter;
}

/**
 * adapters[id] = { supports(edge): boolean, quote({edge, amountIn, pins}): Promise<quote> }.
 * Pools use {chainId, manager, poolKey:{currency0,currency1,fee,tickSpacing,hooks}, adapterId}.
 * Transfers use {id,kind:'inventory'|'bridge',from,to,adapterId,equivalenceId,latencyMs}.
 * Equivalence verification is supplied by a trusted registry; this module does not attest tokens.
 */
export function buildRouteGraph({
  pools = [], transfers = [], adapters = {}, equivalences = [], now = Date.now(), maxAgeMs = 30_000,
} = {}) {
  requireThat(positiveInteger(now) && positiveInteger(maxAgeMs), 'invalid freshness policy');
  const edges = [], rejected = [], seen = new Set();
  for (const pool of pools) {
    try {
      const id = poolId(pool);
      requireThat(!seen.has(id), 'duplicate physical pool');
      const key = clone(pool.poolKey);
      const pair = [key.currency0, key.currency1].map(address => normalAsset({ chainId: pool.chainId, address }));
      const directed = [0, 1].map(direction => ({
        id: `${id}:${direction}`, poolId: id, kind: 'pool', adapterId: pool.adapterId,
        chainId: pool.chainId, manager: pool.manager.toLowerCase(), poolKey: key,
        from: pair[direction], to: pair[1 - direction], nonAtomic: false,
        outputHook: key.hooks.toLowerCase() !== ZERO,
      }));
      for (const edge of directed) supported(adapters, edge);
      seen.add(id);
      edges.push(...directed);
    } catch (error) {
      rejected.push({ kind: 'pool', pool: clone(pool), reason: error.message });
    }
  }
  for (const transfer of transfers) {
    try {
      requireThat(['inventory', 'bridge'].includes(transfer.kind)
        && typeof transfer.id === 'string' && transfer.id.length > 0, 'invalid transfer');
      const from = normalAsset(transfer.from), to = normalAsset(transfer.to);
      requireThat(from.chainId !== to.chainId && positiveInteger(transfer.latencyMs),
        'cross-chain transfer requires explicit latency risk');
      const matches = equivalences.filter(record => record.id === transfer.equivalenceId);
      requireThat(matches.length === 1, 'explicit verified token equivalence required');
      equivalence(matches[0], from, to, now, maxAgeMs);
      const id = `transfer:${transfer.id}`;
      requireThat(!seen.has(id), 'duplicate transfer');
      const edge = {
        id, poolId: id, kind: transfer.kind, adapterId: transfer.adapterId, from, to,
        equivalence: clone(matches[0]), latencyMs: transfer.latencyMs, nonAtomic: true,
        purpose: transfer.kind === 'bridge' ? 'rebalancing' : 'prefunded-inventory',
      };
      supported(adapters, edge);
      seen.add(id);
      edges.push(edge);
    } catch (error) {
      rejected.push({ kind: 'transfer', id: transfer.id, reason: error.message });
    }
  }
  return { edges, rejected, adapters: { ...adapters } };
}

function validatePins(pins, chainIds, now, maxAgeMs) {
  requireThat(pins && typeof pins === 'object', 'missing pinned chain state');
  for (const chainId of chainIds) {
    const pin = pins[chainId];
    requireThat(pin?.chainId === chainId && HASH.test(pin.blockHash)
      && HASH.test(pin.stateRoot) && fresh(pin.observedAt, now, maxAgeMs),
    `missing/stale pinned chain state: ${chainId}`);
  }
}

function matchPins(actual, expected, chainIds) {
  for (const chainId of chainIds) {
    const a = actual?.[chainId], b = expected[chainId];
    requireThat(a?.chainId === chainId && a.blockHash?.toLowerCase() === b.blockHash.toLowerCase()
      && a.stateRoot?.toLowerCase() === b.stateRoot.toLowerCase(), 'quote/simulation pinned state mismatch');
  }
}

const edgeChains = edge => [...new Set([edge.from.chainId, edge.to.chainId])];

function validateQuote(quote, edge, amountIn, pins, now, maxAgeMs) {
  requireThat(quote?.status === 'success' && quote.complete === true
    && quote.edgeId === edge.id && quote.adapterId === edge.adapterId
    && assetId(quote.from) === assetId(edge.from) && assetId(quote.to) === assetId(edge.to)
    && quote.amountIn === amountIn && uint(quote.amountOut) && quote.amountOut > 0n,
  'malformed/partial directed quote');
  requireThat(quote.feesIncluded === true && quote.outputHookFeesIncluded === true,
    'quote must be net of all fees including output hook fees');
  requireThat(fresh(quote.observedAt, now, maxAgeMs), 'stale quote');
  matchPins(quote.pins, pins, edgeChains(edge));
}

function validateSimulation(simulation, route, amountIn, pins, now, maxAgeMs) {
  requireThat(simulation?.status === 'success' && simulation.executionMode === 'whole-route'
    && simulation.sequentialState === true && simulation.routeId === route.id
    && simulation.amountIn === amountIn && simulation.feesIncluded === true
    && simulation.outputHookFeesIncluded === true && fresh(simulation.observedAt, now, maxAgeMs)
    && simulation.atomic === !route.nonAtomic, 'whole-route sequential simulation required');
  matchPins(simulation.pins, pins, route.chainIds);
  requireThat(Array.isArray(simulation.steps) && simulation.steps.length === route.edges.length,
    'simulation must execute every route step');
  let amount = amountIn;
  for (let i = 0; i < route.edges.length; i++) {
    validateQuote(simulation.steps[i], route.edges[i], amount, pins, now, maxAgeMs);
    amount = simulation.steps[i].amountOut;
  }
  requireThat(simulation.amountOut === amount, 'simulation final output mismatch');
  requireThat(Array.isArray(simulation.gasCosts)
    && simulation.gasCosts.length === route.chainIds.length, 'per-chain simulated gas required');
  for (const chainId of route.chainIds) {
    const costs = simulation.gasCosts.filter(cost => cost.chainId === chainId);
    requireThat(costs.length === 1 && uint(costs[0].nativeCost) && costs[0].nativeCost > 0n,
      'invalid simulated gas');
  }
  if (route.nonAtomic) {
    requireThat(simulation.inventoryVerified === true && simulation.latencyRiskAccepted === true,
      'non-atomic simulation requires inventory and latency risk checks');
  }
}

/**
 * Amount-dependent bounded DFS. Independent edge quotes are exploration only.
 * simulateRoute({route,amountIn,pins}) must execute the actual sequence with evolving
 * reserves, not compose cached quotes. No exploratory quotes are passed to it.
 * evaluate({route,amountIn,simulation,pins}) returns
 * {eligible:boolean,net:bigint,numeraire:'USD',scale:ROUTE_VALUE_SCALE};
 * it must value currencies, per-size gas/slippage and non-atomic capital/latency risk.
 * No default economics are inferred for unlike assets or cross-chain native gas.
 * Results are alternatives, never additive split allocations or live authorization.
 * clock() is rechecked after asynchronous work and at final selection; inject a
 * fixed clock alongside now for deterministic tests. RPC deadlines belong to adapters.
 */
export async function searchRoutes({
  graph, start, targets = [start], sizes, pins, simulateRoute, evaluate,
  maxHops = 4, maxExpansions = 10_000, maxQuotes = 10_000, maxCandidates = 1_000,
  maxSimulations = 1_000, now = Date.now(), clock = () => Date.now(),
  maxAgeMs = 30_000, mode = 'paper',
} = {}) {
  requireThat(['paper', 'readonly'].includes(mode), 'route search is readonly/paper only');
  requireThat(positiveInteger(now) && positiveInteger(maxAgeMs), 'invalid freshness policy');
  for (const limit of [maxHops, maxExpansions, maxQuotes, maxCandidates, maxSimulations]) {
    requireThat(positiveInteger(limit), 'invalid search budget');
  }
  // Bound recursion independently of caller-supplied graph size.
  requireThat(maxHops <= 64, 'maxHops exceeds safe search depth');
  const startId = assetId(start), targetIds = new Set(targets.map(assetId));
  requireThat(Array.isArray(sizes) && sizes.length > 0
    && sizes.every(size => uint(size) && size > 0n), 'sizes must be positive BigInt amounts');
  requireThat(graph && Array.isArray(graph.edges), 'invalid route graph');
  const chainIds = [...new Set(graph.edges.flatMap(edgeChains))];
  const pinned = clone(pins);
  validatePins(pinned, chainIds, now, maxAgeMs);
  requireThat(typeof clock === 'function', 'invalid clock');
  let lastTime = now;
  const currentTime = () => {
    const time = clock();
    requireThat(positiveInteger(time) && time >= lastTime, 'invalid/nonmonotonic clock');
    lastTime = time;
    validatePins(pinned, chainIds, time, maxAgeMs);
    return time;
  };
  currentTime();
  const adjacency = new Map();
  const graphEdges = clone(graph.edges), identities = new Set();
  for (const edge of graphEdges) {
    requireThat(!identities.has(edge.id), 'duplicate directed edge');
    identities.add(edge.id);
    if (edge.kind === 'pool') {
      requireThat(edge.poolId === poolId(edge) && edge.id.startsWith(`${edge.poolId}:`)
        && edge.from.chainId === edge.chainId && edge.to.chainId === edge.chainId
        && [edge.poolKey.currency0.toLowerCase(), edge.poolKey.currency1.toLowerCase()]
          .every(address => [edge.from.address.toLowerCase(), edge.to.address.toLowerCase()].includes(address))
        && edge.nonAtomic === false, 'malformed pool edge');
    } else {
      requireThat(['bridge', 'inventory'].includes(edge.kind) && edge.nonAtomic === true
        && edge.id.startsWith('transfer:') && edge.poolId === edge.id
        && edge.from.chainId !== edge.to.chainId && positiveInteger(edge.latencyMs),
      'malformed transfer edge');
      equivalence(edge.equivalence, edge.from, edge.to, now, maxAgeMs);
    }
    const id = assetId(edge.from);
    assetId(edge.to);
    if (!adjacency.has(id)) adjacency.set(id, []);
    adjacency.get(id).push(edge);
  }
  const candidates = [], failures = [], limits = new Set();
  const budget = { expansions: 0, quotes: 0, simulations: 0, completedRoutes: 0 };
  let best = null, stopped = false;
  const fail = (stage, route, amountIn, error, edge) => failures.push({
    stage, routeId: route?.id, edgeId: edge?.id, amountIn,
    reason: error.message, usable: false, executable: false,
  });
  const routeFresh = (route, time) => {
    for (const edge of route.edges) {
      if (edge.nonAtomic) equivalence(edge.equivalence, edge.from, edge.to, time, maxAgeMs);
    }
  };
  async function visit(node, amount, size, path, used) {
    for (const edge of adjacency.get(node) ?? []) {
      if (stopped) return;
      if (used.has(edge.poolId)) continue;
      if (budget.expansions >= maxExpansions) { limits.add('maxExpansions'); stopped = true; return; }
      budget.expansions++;
      if (budget.quotes >= maxQuotes) { limits.add('maxQuotes'); stopped = true; return; }
      let quote;
      try {
        const before = currentTime();
        if (edge.nonAtomic) equivalence(edge.equivalence, edge.from, edge.to, before, maxAgeMs);
        const adapter = supported(graph.adapters, edge);
        budget.quotes++;
        quote = await adapter.quote({ edge: clone(edge), amountIn: amount, pins: clone(pinned) });
        const after = currentTime();
        validateQuote(quote, edge, amount, pinned, after, maxAgeMs);
        if (edge.nonAtomic) equivalence(edge.equivalence, edge.from, edge.to, after, maxAgeMs);
      } catch (error) {
        fail('quote', null, amount, error, edge);
        continue;
      }
      const next = [...path, edge], nextUsed = new Set([...used, edge.poolId]);
      const end = assetId(edge.to), nonAtomic = next.some(item => item.nonAtomic);
      if (targetIds.has(end) && (end !== startId || next.length >= 2)) {
        if (budget.completedRoutes >= maxCandidates) { limits.add('maxCandidates'); stopped = true; return; }
        budget.completedRoutes++;
        const route = {
          id: JSON.stringify(next.map(item => item.id)), edges: next,
          from: normalAsset(start), to: edge.to, nonAtomic,
          kind: nonAtomic ? (next.some(item => item.kind === 'bridge')
            ? 'cross-chain-rebalancing' : 'cross-chain-inventory') : 'local-cycle',
          chainIds: [...new Set(next.flatMap(edgeChains))],
          latencyRisk: nonAtomic, latencyMs: next.reduce((sum, item) => sum + (item.latencyMs ?? 0), 0),
        };
        if (!nonAtomic && end !== startId) route.kind = 'local-path';
        const candidate = { route: clone(route), amountIn: size, estimatedAmountOut: quote.amountOut,
          mode, executable: false, liveAuthorized: false, simulationValidated: false,
          paperCandidate: false, status: 'exploratory-only' };
        candidates.push(candidate);
        if (typeof simulateRoute === 'function') {
          if (budget.simulations >= maxSimulations) {
            limits.add('maxSimulations');
            candidate.status = 'simulation-budget-exhausted';
          } else {
            budget.simulations++;
            try {
              const simulation = await simulateRoute({ route: clone(route), amountIn: size, pins: clone(pinned) });
              const simulatedAt = currentTime();
              routeFresh(route, simulatedAt);
              validateSimulation(simulation, route, size, pinned, simulatedAt, maxAgeMs);
              candidate.simulation = clone(simulation);
              candidate.simulationValidated = true;
              candidate.status = 'simulated-paper-only';
              if (typeof evaluate === 'function') {
                const assessment = await evaluate({
                  route: clone(route), amountIn: size, simulation: clone(simulation), pins: clone(pinned),
                });
                const evaluatedAt = currentTime();
                routeFresh(route, evaluatedAt);
                validateSimulation(simulation, route, size, pinned, evaluatedAt, maxAgeMs);
                requireThat(typeof assessment?.eligible === 'boolean' && typeof assessment.net === 'bigint'
                  && assessment.numeraire === 'USD' && assessment.scale === ROUTE_VALUE_SCALE,
                  'invalid per-size economic assessment');
                candidate.assessment = clone(assessment);
                candidate.paperCandidate = assessment.eligible && assessment.net > 0n;
                if (candidate.paperCandidate && (!best || assessment.net > best.assessment.net)) best = candidate;
              }
            } catch (error) {
              candidate.status = 'rejected';
              candidate.paperCandidate = false;
              fail('simulation/evaluation', route, size, error);
            }
          }
        }
      }
      if (next.length < maxHops) await visit(end, quote.amountOut, size, next, nextUsed);
      else if ((adjacency.get(end) ?? []).some(item => !nextUsed.has(item.poolId))) limits.add('maxHops');
    }
  }
  for (const size of [...new Set(sizes)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!stopped) await visit(startId, size, size, [], new Set());
  }
  // A winner from an early branch can expire while later branches are explored.
  best = null;
  let completedAt;
  try { completedAt = currentTime(); } catch (error) {
    fail('expiry', null, null, error);
  }
  for (const candidate of candidates) {
    if (!candidate.simulationValidated) continue;
    try {
      requireThat(completedAt !== undefined, 'pinned state expired before search completion');
      routeFresh(candidate.route, completedAt);
      validateSimulation(candidate.simulation, candidate.route, candidate.amountIn,
        pinned, completedAt, maxAgeMs);
      if (candidate.paperCandidate && (!best || candidate.assessment.net > best.assessment.net)) best = candidate;
    } catch (error) {
      candidate.status = 'expired';
      candidate.paperCandidate = false;
      candidate.simulationValidated = false;
      fail('expiry', candidate.route, candidate.amountIn, error);
    }
  }
  try {
    const finalTime = currentTime();
    if (best) {
      routeFresh(best.route, finalTime);
      validateSimulation(best.simulation, best.route, best.amountIn, pinned, finalTime, maxAgeMs);
    }
  } catch (error) {
    for (const candidate of candidates) {
      if (candidate.simulationValidated) {
        candidate.status = 'expired';
        candidate.paperCandidate = false;
        candidate.simulationValidated = false;
      }
    }
    best = null;
    fail('expiry', null, null, error);
  }
  return { mode, candidates, best, failures, graphRejections: clone(graph.rejected ?? []), budget,
    truncated: limits.size > 0, truncationReasons: [...limits], globallyOptimal: false,
    optimality: 'best eligible sampled size among simulated bounded routes only',
    splitRoutesSupported: false, executable: false, liveAuthorized: false };
}
import { encodeAbiParameters, keccak256 } from 'viem';
