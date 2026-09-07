import { SCALE, NATIVE, uint, fresh, gasCost, decimals } from './pricing.mjs';

const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const positiveTime = value => Number.isSafeInteger(value) && value > 0;
const key = (chainId, token) => `${chainId}:${token.toLowerCase()}`;
const clone = value => structuredClone(value);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function asset(value) {
  requireThat(positiveTime(value?.chainId) && address(value.token), 'invalid asset identity');
  return key(value.chainId, value.token);
}

function fundingMap(funding) {
  requireThat(Array.isArray(funding), 'explicit prefunding required');
  const result = new Map();
  for (const row of funding) {
    const id = asset(row);
    uint(row.amount, 'funding');
    requireThat(!result.has(id), 'duplicate funding asset');
    result.set(id, row.amount);
  }
  return result;
}

function validatePolicy(policy) {
  requireThat(positiveTime(policy?.maxAgeMs) && positiveTime(policy.maxExposureMs),
    'invalid freshness/exposure policy');
  for (const name of ['maxCapitalUsd', 'maxExposureUsd', 'maxLossUsd', 'minAdverseMoveBps']) {
    uint(policy[name], name);
    requireThat(policy[name] > 0n, `missing ${name}`);
  }
  requireThat(policy.minAdverseMoveBps <= 10_000n, 'invalid adverse move policy');
}

function validateLeg(leg, side, amountToken, policy, now) {
  asset(leg);
  decimals(leg.tokenDecimals);
  requireThat(leg.token.toLowerCase() !== NATIVE, 'token cannot be native currency');
  requireThat(typeof leg.venue === 'string' && leg.venue.length > 0
    && !/curve/i.test(leg.venue), 'curve execution/composition is not verified');
  const quote = leg.quote;
  requireThat(quote && quote.chainId === leg.chainId && address(quote.token)
    && quote.token.toLowerCase() === leg.token.toLowerCase()
    && quote.tokenDecimals === leg.tokenDecimals && quote.venue === leg.venue && quote.side === side
    && quote.amountToken === amountToken, 'size-dependent quote identity mismatch');
  requireThat(hash(leg.blockHash) && hash(quote.blockHash)
    && quote.blockHash.toLowerCase() === leg.blockHash.toLowerCase(),
  'quote pinned block hash mismatch');
  uint(quote.nativeAmount, 'quoted native amount');
  requireThat(quote.nativeAmount > 0n && quote.feesIncluded === true,
    'quote must include venue fees and nonzero native amount');
  requireThat(fresh(quote.observedAt, now, policy.maxAgeMs)
    && positiveTime(quote.expiresAt) && quote.expiresAt > now, 'stale/expired quote');
  const fx = leg.fx;
  requireThat(fx?.chainId === leg.chainId && fresh(fx.observedAt, now, policy.maxAgeMs),
    'missing/stale per-leg native FX');
  uint(fx.priceUsd, 'FX');
  requireThat(fx.priceUsd > 0n, 'nonpositive FX');
  requireThat(leg.gas?.chainId === leg.chainId
    && fresh(leg.gas.observedAt, now, policy.maxAgeMs), 'missing/stale per-leg gas');
  const gasNative = gasCost(leg.gas);
  return {
    gasNative,
    gasUsd: ceilDiv(gasNative * fx.priceUsd, SCALE),
    nativeUsd: quote.nativeAmount * fx.priceUsd / SCALE,
  };
}

function identity(route, now, maxAgeMs) {
  const { buy, sell } = route;
  if (buy.chainId === sell.chainId) {
    requireThat(buy.token.toLowerCase() === sell.token.toLowerCase()
      && buy.tokenDecimals === sell.tokenDecimals, 'same-chain token mismatch');
    return 'same-chain-address';
  }
  // This consumes a caller's identity assertion, not an on-chain verification.
  // Equal addresses on different chains are deliberately insufficient.
  const cert = route.identityCertificate;
  requireThat(cert?.kind === 'explicit-identity-certificate'
    && typeof cert.id === 'string' && cert.id.trim().length > 0
    && cert.attestation === 'same-economic-asset'
    && fresh(cert.issuedAt, now, maxAgeMs)
    && positiveTime(cert.expiresAt) && cert.expiresAt > now
    && Array.isArray(cert.deployments) && cert.deployments.length === 2,
  'cross-chain identity certificate required');
  for (const leg of [buy, sell]) {
    requireThat(cert.deployments.filter(deployment => deployment?.chainId === leg.chainId
      && address(deployment.token) && deployment.token.toLowerCase() === leg.token.toLowerCase()
      && deployment.decimals === leg.tokenDecimals).length === 1,
    'identity certificate deployment mismatch');
  }
  requireThat(buy.tokenDecimals === sell.tokenDecimals,
    'raw matched amounts require equal token decimals');
  return 'supplied-certificate-schema-only';
}

/**
 * Quotes are exact-token-amount buy costs / sell proceeds, net of venue fees.
 * USD values use pricing.SCALE; native amounts use 18 decimals. This is a local
 * paper candidate assessment, never verification of quotes or live permission.
 */
export function assessNonAtomic(route, { policy, funding, now = Date.now() } = {}) {
  const rejected = reason => ({
    mode: 'paper', paperCandidate: false, executable: false, liveAuthorized: false,
    reason,
  });
  try {
    validatePolicy(policy);
    requireThat(positiveTime(now), 'invalid clock');
    uint(route.amountToken);
    requireThat(route.amountToken > 0n, 'zero token amount');
    const crossChain = route.buy.chainId !== route.sell.chainId;
    requireThat(route.kind === (crossChain ? 'cross-chain-prefunded' : 'same-chain-two-tx'),
      'route kind mismatch');
    requireThat(crossChain || route.buy.venue !== route.sell.venue, 'same venue');
    requireThat(positiveTime(route.exposureTimeoutMs)
      && route.exposureTimeoutMs <= policy.maxExposureMs
      && Number.isSafeInteger(now + route.exposureTimeoutMs), 'exposure duration limit');
    const buy = validateLeg(route.buy, 'buy', route.amountToken, policy, now);
    const sell = validateLeg(route.sell, 'sell', route.amountToken, policy, now);
    requireThat(crossChain || route.buy.blockHash.toLowerCase() === route.sell.blockHash.toLowerCase(),
      'same-chain quotes require a shared pinned block');
    const identityAssurance = identity(route, now, policy.maxAgeMs);
    const expiresAt = Math.min(route.buy.quote.expiresAt, route.sell.quote.expiresAt,
      crossChain ? route.identityCertificate.expiresAt : Number.MAX_SAFE_INTEGER);
    requireThat(now + route.exposureTimeoutMs <= expiresAt, 'insufficient quote/certificate lifetime');
    for (const field of ['bridgeCostUsd', 'rebalanceCostUsd', 'adverseMoveReserveUsd']) {
      uint(route[field], field);
    }
    const buyUsd = ceilDiv(route.buy.quote.nativeAmount * route.buy.fx.priceUsd, SCALE);
    const sellUsd = sell.nativeUsd;
    const combinedGasUsd = buy.gasUsd + sell.gasUsd;
    const exposureUsd = buyUsd + (crossChain ? sellUsd : 0n);
    const minAdverseReserveUsd = ceilDiv(exposureUsd * policy.minAdverseMoveBps, 10_000n);
    requireThat(route.adverseMoveReserveUsd >= minAdverseReserveUsd, 'adverse move reserve too small');
    const otherCostsUsd = route.bridgeCostUsd + route.rebalanceCostUsd;
    const capitalUsd = exposureUsd + combinedGasUsd + otherCostsUsd + route.adverseMoveReserveUsd;
    // Conservative at-risk capital, NOT a guarantee against MEV, depegs or losses.
    const lossAtRiskUsd = capitalUsd;
    requireThat(exposureUsd <= policy.maxExposureUsd, 'exposure limit');
    requireThat(capitalUsd <= policy.maxCapitalUsd, 'capital limit');
    requireThat(lossAtRiskUsd <= policy.maxLossUsd, 'loss limit');
    const reservations = new Map();
    const add = (chainId, token, amount) => {
      const id = key(chainId, token);
      reservations.set(id, { chainId, token: token.toLowerCase(),
        amount: (reservations.get(id)?.amount ?? 0n) + amount });
    };
    add(route.buy.chainId, NATIVE, route.buy.quote.nativeAmount + buy.gasNative);
    add(route.sell.chainId, NATIVE, sell.gasNative);
    if (crossChain) add(route.sell.chainId, route.sell.token, route.amountToken);
    // Hold the USD reserves as extra native capital on the buy chain.
    add(route.buy.chainId, NATIVE,
      ceilDiv((otherCostsUsd + route.adverseMoveReserveUsd) * SCALE, route.buy.fx.priceUsd));
    const balances = fundingMap(funding);
    for (const [id, hold] of reservations) {
      requireThat((balances.get(id) ?? 0n) >= hold.amount, 'insufficient prefunded inventory/gas');
    }
    const grossUsd = sellUsd - buyUsd;
    const grossAfterCostsUsd = grossUsd - otherCostsUsd;
    const netUsd = grossAfterCostsUsd - combinedGasUsd - route.adverseMoveReserveUsd;
    const paperCandidate = grossAfterCostsUsd >= 3n * combinedGasUsd && netUsd > 0n;
    return {
      mode: 'paper', paperCandidate, executable: false, liveAuthorized: false,
      reason: paperCandidate ? 'paper candidate only; external evidence is not independently verified'
        : 'net profit / three-times combined gas hurdle failed',
      identityAssurance, grossUsd, grossAfterCostsUsd, netUsd, combinedGasUsd, exposureUsd, capitalUsd,
      lossAtRiskUsd, expiresAt, reservations: [...reservations.values()],
      gasNative: { buy: buy.gasNative, sell: sell.gasNative },
    };
  } catch (error) {
    return rejected(error.message);
  }
}

const encode = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? { $bigint: item.toString() } : item);
const decode = text => JSON.parse(text, (_key, item) => {
  if (item && typeof item === 'object' && '$bigint' in item) {
    requireThat(Object.keys(item).length === 1 && typeof item.$bigint === 'string'
      && /^-?(?:0|[1-9]\d*)$/.test(item.$bigint), 'invalid serialized integer');
    return BigInt(item.$bigint);
  }
  return item;
});

/**
 * Single-writer, event-sourced local paper ledger. No provider, signer or network
 * is used. Persist serialize() after every accepted event, before any external
 * action. restore() replays validation; this is not a crash-safe execution DB.
 * Receipt finality and reconciliation are caller assertions, not verified facts.
 */
export class PaperNonAtomicLedger {
  #funding;
  #policy;
  #events = [];
  #records = new Map();
  #txIds = new Set();
  #clock = 0;

  constructor({ funding, policy }) {
    fundingMap(funding);
    validatePolicy(policy);
    this.#funding = clone(funding);
    this.#policy = clone(policy);
  }

  #time(now) {
    requireThat(positiveTime(now) && now >= this.#clock, 'clock must be monotonic');
  }

  #record(id) {
    const record = this.#records.get(id);
    requireThat(record, 'unknown reservation');
    return record;
  }

  #event(type, args, now) {
    this.#clock = now;
    this.#events.push(clone({ type, args, now }));
  }

  #deltas(record) {
    const deltas = new Map();
    const add = (chainId, token, amount) => {
      const id = key(chainId, token);
      const previous = deltas.get(id);
      deltas.set(id, { chainId, token: token.toLowerCase(), amount: (previous?.amount ?? 0n) + amount });
    };
    for (const name of ['buy', 'sell']) {
      const receipt = record.legs[name].receipt;
      if (!receipt) continue;
      const leg = record.route[name];
      add(leg.chainId, NATIVE, -receipt.gasNative);
      if (receipt.status === 'success') {
        add(leg.chainId, leg.token, name === 'buy' ? receipt.tokenAmount : -receipt.tokenAmount);
        add(leg.chainId, NATIVE, name === 'buy' ? -receipt.nativeAmount : receipt.nativeAmount);
      }
    }
    return [...deltas.values()];
  }

  availableFunding() {
    const balances = new Map(this.#funding.map(row => [asset(row), clone(row)]));
    const add = row => {
      const id = asset(row);
      balances.set(id, { ...row, amount: (balances.get(id)?.amount ?? 0n) + row.amount });
    };
    for (const record of this.#records.values()) {
      if (record.state === 'closed') {
        for (const delta of this.#deltas(record)) add(delta);
        add({ chainId: record.route.buy.chainId, token: NATIVE,
          amount: -record.resolution.additionalCostNative });
      } else {
        for (const hold of record.assessment.reservations) add({ ...hold, amount: -hold.amount });
      }
    }
    return [...balances.values()];
  }

  reserve(id, route, now = Date.now()) {
    this.#time(now);
    requireThat(typeof id === 'string' && id.trim().length > 0 && !this.#records.has(id),
      'duplicate/invalid reservation id');
    requireThat(![...this.#records.values()].some(record => record.state !== 'closed'
      && (record.recoveryReason || (record.state !== 'filled' && now >= record.deadline))),
    'unresolved exposure requires reconciliation before new reservations');
    const assessment = assessNonAtomic(route, {
      funding: this.availableFunding(), policy: this.#policy, now,
    });
    requireThat(assessment.paperCandidate, assessment.reason);
    // Simultaneous routes must satisfy aggregate USD risk budgets too.
    const active = [...this.#records.values()].filter(record => record.state !== 'closed');
    for (const [field, limit] of [['capitalUsd', 'maxCapitalUsd'],
      ['exposureUsd', 'maxExposureUsd'], ['lossAtRiskUsd', 'maxLossUsd']]) {
      requireThat(active.reduce((sum, record) => sum + record.assessment[field], assessment[field])
        <= this.#policy[limit], `aggregate ${limit}`);
    }
    const snapshot = clone(route);
    this.#records.set(id, {
      id, mode: 'paper', executable: false, liveAuthorized: false, state: 'reserved',
      route: snapshot, assessment, reservedAt: now,
      deadline: now + route.exposureTimeoutMs, recoveryReason: null,
      legs: { buy: { state: 'unsubmitted' }, sell: { state: 'unsubmitted' } },
    });
    this.#event('reserve', [id, snapshot], now);
    return this.get(id);
  }

  recordPending(id, name, txId, now = Date.now()) {
    this.#time(now);
    const record = this.#record(id);
    requireThat(['buy', 'sell'].includes(name), 'invalid leg');
    requireThat(record.state !== 'closed' && !record.recoveryReason
      && now < record.deadline && now < record.assessment.expiresAt,
    'expired/recovery reservation; never retry');
    requireThat(record.legs[name].state === 'unsubmitted', 'leg already submitted; never retry');
    validateLeg(record.route[name], name, record.route.amountToken, this.#policy, now);
    identity(record.route, now, this.#policy.maxAgeMs);
    requireThat(hash(txId), 'invalid transaction id');
    const transactionKey = `${record.route[name].chainId}:${txId.toLowerCase()}`;
    requireThat(!this.#txIds.has(transactionKey), 'duplicate transaction id');
    if (name === 'sell' && record.route.kind === 'same-chain-two-tx') {
      requireThat(record.legs.buy.state === 'filled', 'same-chain sell requires confirmed full buy');
    }
    record.legs[name] = { state: 'pending', txId: txId.toLowerCase(), pendingAt: now };
    this.#txIds.add(transactionKey);
    record.state = record.legs.buy.state === 'pending' && record.legs.sell.state === 'pending'
      ? 'buy-sell-pending' : `${name}-pending`;
    this.#event('pending', [id, name, txId], now);
    return this.get(id);
  }

  recordReceipt(id, name, receipt, now = Date.now()) {
    this.#time(now);
    const record = this.#record(id);
    requireThat(['buy', 'sell'].includes(name) && record.state !== 'closed', 'invalid/closed leg');
    const leg = record.legs[name];
    requireThat(leg.state === 'pending' && hash(receipt?.txId)
      && receipt.txId.toLowerCase() === leg.txId
      && receipt.chainId === record.route[name].chainId,
    'receipt transaction mismatch/already finalized');
    requireThat(receipt.confirmed === true && ['success', 'reverted'].includes(receipt.status)
      && Number.isSafeInteger(receipt.observedAt) && receipt.observedAt >= leg.pendingAt
      && receipt.observedAt <= now, 'unconfirmed/invalid receipt');
    for (const field of ['tokenAmount', 'nativeAmount', 'gasNative']) uint(receipt[field], field);
    requireThat(receipt.tokenAmount <= record.route.amountToken, 'receipt exceeds quoted token amount');
    requireThat(receipt.status !== 'reverted'
      || (receipt.tokenAmount === 0n && receipt.nativeAmount === 0n), 'revert cannot fill');
    requireThat(receipt.status !== 'success' || receipt.tokenAmount > 0n, 'success requires actual fill');
    requireThat(name !== 'sell' || record.route.kind !== 'same-chain-two-tx'
      || receipt.tokenAmount <= record.legs.buy.receipt.tokenAmount, 'sell exceeds acquired inventory');
    const quote = record.route[name].quote;
    const violated = receipt.gasNative > record.assessment.gasNative[name]
      || (name === 'buy' && receipt.nativeAmount * record.route.amountToken
        > quote.nativeAmount * receipt.tokenAmount)
      || (name === 'sell' && receipt.nativeAmount * record.route.amountToken
        < quote.nativeAmount * receipt.tokenAmount);
    leg.receipt = clone(receipt);
    leg.state = receipt.status === 'reverted' ? 'reverted'
      : receipt.tokenAmount === record.route.amountToken ? 'filled' : 'partial';
    if (violated || leg.state !== 'filled' || now >= record.deadline) {
      record.recoveryReason ||= violated ? 'receipt exceeded cost/output bounds'
        : leg.state !== 'filled' ? 'partial/reverted leg' : 'exposure timeout';
    }
    const bothFilled = Object.values(record.legs).every(item => item.state === 'filled');
    const pending = Object.values(record.legs).some(item => item.state === 'pending');
    record.state = record.recoveryReason
      ? (leg.state === 'partial' && pending ? 'partial' : 'recovery-required')
      : bothFilled ? 'filled' : `${name}-filled`;
    this.#event('receipt', [id, name, receipt], now);
    return this.get(id);
  }

  tick(now = Date.now()) {
    this.#time(now);
    for (const record of this.#records.values()) {
      if (!['closed', 'filled'].includes(record.state) && now >= record.deadline) {
        record.recoveryReason ||= 'exposure timeout; no automatic retries';
        record.state = 'recovery-required';
      }
    }
    this.#event('tick', [], now);
    return [...this.#records.keys()].map(id => this.get(id));
  }

  residualTokens(id) {
    return this.#deltas(this.#record(id)).filter(row => row.token !== NATIVE && row.amount !== 0n)
      .sort((a, b) => asset(a).localeCompare(asset(b)));
  }

  close(id, resolution, now = Date.now()) {
    this.#time(now);
    const record = this.#record(id);
    requireThat(record.state !== 'closed'
      && !Object.values(record.legs).some(leg => leg.state === 'pending'),
    'unresolved pending transaction; retain reservations');
    requireThat(resolution?.kind === 'paper-inventory-reconciled' && resolution.confirmed === true
      && typeof resolution.evidenceId === 'string' && resolution.evidenceId.trim().length > 0,
    'explicit confirmed paper reconciliation required');
    uint(resolution.additionalCostNative, 'realized bridge/rebalancing/recovery costs');
    requireThat(Array.isArray(resolution.residualTokens), 'explicit residual inventory required');
    const actual = this.residualTokens(id);
    const supplied = resolution.residualTokens.map(row => {
      asset(row);
      requireThat(typeof row.amount === 'bigint' && row.amount !== 0n, 'invalid residual amount');
      return { chainId: row.chainId, token: row.token.toLowerCase(), amount: row.amount };
    }).sort((a, b) => asset(a).localeCompare(asset(b)));
    requireThat(encode(actual) === encode(supplied), 'residual inventory must be explicitly acknowledged');
    record.resolution = clone(resolution);
    // Cash movement is not profit when partial fills leave token inventory.
    record.realizedCashDeltaUsd = ['buy', 'sell'].reduce((sum, name) => {
      const receipt = record.legs[name].receipt;
      if (!receipt) return sum;
      const fx = record.route[name].fx.priceUsd;
      const nativeFlow = receipt.status === 'success'
        ? (name === 'buy' ? -receipt.nativeAmount : receipt.nativeAmount) : 0n;
      const flowUsd = nativeFlow >= 0n ? nativeFlow * fx / SCALE
        : -ceilDiv(-nativeFlow * fx, SCALE);
      return sum + flowUsd - ceilDiv(receipt.gasNative * fx, SCALE);
    }, -ceilDiv(resolution.additionalCostNative * record.route.buy.fx.priceUsd, SCALE));
    record.state = 'closed';
    this.#event('close', [id, resolution], now);
    return this.get(id);
  }

  get(id) {
    return clone(this.#record(id));
  }

  serialize() {
    return encode({ version: 1, funding: this.#funding, policy: this.#policy, events: this.#events });
  }

  static restore(text) {
    const data = decode(text);
    requireThat(data?.version === 1 && Array.isArray(data.events), 'invalid paper ledger schema');
    const ledger = new PaperNonAtomicLedger({ funding: data.funding, policy: data.policy });
    const methods = { reserve: 'reserve', pending: 'recordPending', receipt: 'recordReceipt',
      tick: 'tick', close: 'close' };
    const arity = { reserve: 2, pending: 3, receipt: 3, tick: 0, close: 2 };
    for (const event of data.events) {
      requireThat(Object.hasOwn(methods, event.type) && Array.isArray(event.args)
        && event.args.length === arity[event.type] && positiveTime(event.now), 'invalid ledger event');
      ledger[methods[event.type]](...event.args, event.now);
    }
    return ledger;
  }
}
