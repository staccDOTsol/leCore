import { fresh, profitability, uint } from './pricing.mjs';

// Optimise only independently simulated whole transactions, never composed spot
// quotes. Every sampled size carries its own gas, tick-crossing and hook effects.
export async function optimiseSizes(sizes, simulate, {
  chainId, token, blockHash, now = Date.now(), maxAgeMs = 30_000,
  nativeBalance, reservedNative, gasReserve, maxNotional, safetyReserve,
  maxPriceImpactBps = 100n, clock = Date.now,
}) {
  for (const value of [nativeBalance, reservedNative, gasReserve, maxNotional,
    safetyReserve, maxPriceImpactBps]) uint(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) throw new Error('missing pinned block hash');
  const results = [];
  let best = null;
  const available = nativeBalance - reservedNative - gasReserve;
  for (const size of [...new Set(sizes)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    uint(size);
    if (!size || size > maxNotional || size > available) continue;
    try {
      const quote = await simulate(size);
      const observedNow = clock();
      if (quote.chainId !== chainId || quote.token.toLowerCase() !== token.toLowerCase()
          || quote.blockHash !== blockHash || quote.amountIn !== size
          || quote.atomic !== true || quote.feesIncluded !== true
          || observedNow < now
          || !fresh(quote.observedAt, observedNow, maxAgeMs)) throw new Error('simulation identity/freshness mismatch');
      uint(quote.priceImpactBps);
      if (quote.priceImpactBps > maxPriceImpactBps) throw new Error('price impact limit');
      if (size + quote.gas > available) throw new Error('inventory/gas reserve limit');
      const profit = profitability({ amountIn: size, amountOut: quote.amountOut,
        gas: quote.gas, safetyReserve });
      const result = { size, ...profit, quote };
      results.push(result);
      if (result.eligible && (!best || result.net > best.net)) best = result;
    } catch {
      results.push({ size, eligible: false, reason: 'simulation unavailable or policy rejected' });
    }
  }
  const finishedAt = clock();
  for (const result of results) {
    if (result.quote && (finishedAt < now || !fresh(result.quote.observedAt, finishedAt, maxAgeMs))) {
      result.eligible = false;
      result.reason = 'simulation expired during size search';
    }
  }
  best = results.filter(result => result.eligible)
    .reduce((winner, result) => !winner || result.net > winner.net ? result : winner, null);
  return { best, results, fundedExecution: false };
}

export function curveAllowed(evidence, { reserveAfter, minReserve, cumulativeFlow, maxFlow }) {
  for (const amount of [reserveAfter, minReserve, cumulativeFlow, maxFlow]) uint(amount);
  // No curve execution adapter is shipped. Keep the financial guard useful for
  // monitoring without mistaking reserve checks for proof of composability.
  return { executable: false, financialLimitsPass: reserveAfter >= minReserve
    && cumulativeFlow <= maxFlow && evidence?.graduated === false,
  reason: 'curve sellability and atomic composition are not verified' };
}

export class BridgeLedger {
  constructor(records = []) {
    this.records = new Map();
    for (const record of records) this.observe(record);
  }

  observe(record) {
    const { id, sourceChainId, destinationChainId, token, amount, burnedAt, state } = record;
    if (!/^0x[0-9a-fA-F]{64}:\d+$/.test(id) || sourceChainId === destinationChainId
        || !Number.isSafeInteger(sourceChainId) || !Number.isSafeInteger(destinationChainId)
        || !/^0x[0-9a-fA-F]{40}$/.test(token) || !Number.isSafeInteger(burnedAt)
        || !['pending', 'confirmed', 'refunded'].includes(state)) throw new Error('invalid bridge record');
    uint(amount);
    if (!amount || burnedAt < 0) throw new Error('invalid bridge amount/time');
    const previous = this.records.get(id);
    if (previous && (previous.amount !== amount || previous.sourceChainId !== sourceChainId
        || previous.destinationChainId !== destinationChainId || previous.token !== token
        || previous.burnedAt !== burnedAt)) throw new Error('bridge identity changed');
    if (previous && previous.state !== 'pending' && previous.state !== state) {
      throw new Error('terminal bridge state cannot be overwritten');
    }
    if (state !== 'pending' && !/^0x[0-9a-fA-F]{64}$/.test(record.settlementTx ?? '')) {
      throw new Error('settlement transaction required');
    }
    this.records.set(id, { ...record });
  }

  status(now = Date.now()) {
    return [...this.records.values()].map(record => ({
      ...record, reserved: record.state === 'pending' ? record.amount : 0n,
      alert: record.state === 'pending' && now - record.burnedAt >= 90_000,
      retryBurn: false,
    }));
  }

  toJSON() {
    return [...this.records.values()].map(record => ({ ...record, amount: record.amount.toString() }));
  }

  static fromJSON(records) {
    return new BridgeLedger(records.map(record => ({ ...record, amount: BigInt(record.amount) })));
  }
}

// Input must be realised, executable-trade measurements, not displayed spreads.
export function allocateInventory(budget, measurements) {
  uint(budget);
  const rows = measurements.filter(m => m.realisedNet > 0n && m.capitalTime > 0n
    && Number.isSafeInteger(m.chainId));
  const weights = rows.map(m => m.realisedNet * 10n ** 18n / m.capitalTime);
  const total = weights.reduce((a, b) => a + b, 0n);
  return rows.map((row, i) => ({ chainId: row.chainId,
    allocation: total ? budget * weights[i] / total : 0n }));
}
