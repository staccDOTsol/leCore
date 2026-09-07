import { graphFromPoolSnapshots, searchRoutes } from './routes.mjs';
import { fresh } from './pricing.mjs';
export { assessNonAtomic, PaperNonAtomicLedger } from './nonatomic.mjs';
export { verifyDeployment, simulateRoundTrip, assertSupportedAtomicRoute,
  atomicRoutingConstraints } from './execution.mjs';
export { updateJournal } from './journal.mjs';

/**
 * Connect canonical monitor snapshots to registered quoting/execution adapters.
 * Assignments use chainId:PoolManager:poolId, never symbols or hook presence.
 * No adapters are implicitly trusted, and no returned result authorizes a send.
 */
export async function researchRoutes(report, {
  adapters = {}, assignments = {}, transfers = [], equivalences = [],
  searches = [], simulateRoute, evaluate, now = Date.now(), maxAgeMs = 30_000,
} = {}) {
  const chains = [];
  const excludedChains = [];
  for (const chain of report.chains) {
    if (chain.coverage !== 'fresh' || !fresh(chain.observedAt, now, maxAgeMs)
        || !/^0x[0-9a-fA-F]{64}$/.test(chain.stateRoot ?? '')) {
      excludedChains.push(chain.chainId);
      chains.push({ ...chain, pools: [] });
      continue;
    }
    chains.push(chain);
  }
  const graph = graphFromPoolSnapshots({ ...report, chains }, {
    adapters, adapterBindings: assignments, transfers, equivalences, now, maxAgeMs,
  });
  const results = [];
  for (const search of searches) {
    try {
      results.push(await searchRoutes({
        ...search, graph, pins: graph.pins, simulateRoute, evaluate, now, maxAgeMs, mode: 'paper',
      }));
    } catch {
      results.push({ mode: 'paper', best: null, executable: false,
        reason: 'route search blocked by missing/stale pins or invalid policy' });
    }
  }
  return {
    mode: 'paper', fundedTrading: false, automaticBridging: false,
    supportedDirectedEdges: graph.edges.length, rejectedPools: [...graph.rejected, ...graph.diagnostics],
    discovery: graph.discovery, excludedChains, results,
  };
}
