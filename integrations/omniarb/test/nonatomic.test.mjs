import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALE, NATIVE, usd } from '../src/pricing.mjs';
import { assessNonAtomic, PaperNonAtomicLedger } from '../src/nonatomic.mjs';

const NOW = 1_000_000;
const TOKEN = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const tx = n => `0x${n.toString(16).padStart(64, '0')}`;
const policy = {
  maxAgeMs: 30_000, maxExposureMs: 20_000, minAdverseMoveBps: 100n,
  maxCapitalUsd: usd('10000'), maxExposureUsd: usd('10000'), maxLossUsd: usd('10000'),
};
const funding = [
  { chainId: 1, token: NATIVE, amount: 100n * SCALE },
  { chainId: 2, token: NATIVE, amount: 100n * SCALE },
  { chainId: 2, token: TOKEN, amount: 1000n * SCALE },
  { chainId: 2, token: OTHER, amount: 1000n * SCALE },
];

function route(cross = true) {
  const leg = (chainId, venue, side, nativeAmount) => ({
    chainId, venue, token: TOKEN, tokenDecimals: 18, blockHash: tx(chainId),
    quote: { chainId, venue, side, token: TOKEN, tokenDecimals: 18, amountToken: 10n * SCALE,
      blockHash: tx(chainId), nativeAmount, observedAt: NOW - 100,
      expiresAt: NOW + 30_000, feesIncluded: true },
    fx: { chainId, priceUsd: usd('100'), observedAt: NOW - 100 },
    gas: { chainId, gasUnits: 10n, gasPrice: 10n ** 14n,
      l1DataFee: 10n ** 15n, observedAt: NOW - 100 },
  });
  return {
    kind: cross ? 'cross-chain-prefunded' : 'same-chain-two-tx', amountToken: 10n * SCALE,
    buy: leg(1, 'uniswap-v3', 'buy', SCALE),
    sell: leg(cross ? 2 : 1, 'uniswap-v4', 'sell', 12n * SCALE / 10n),
    bridgeCostUsd: usd('1'), rebalanceCostUsd: usd('1'), adverseMoveReserveUsd: usd('3'),
    exposureTimeoutMs: 10_000,
    identityCertificate: {
      kind: 'explicit-identity-certificate', id: 'asset-mapping-1',
      attestation: 'same-economic-asset', issuedAt: NOW - 100, expiresAt: NOW + 30_000,
      deployments: [{ chainId: 1, token: TOKEN, decimals: 18 },
        { chainId: 2, token: TOKEN, decimals: 18 }],
    },
  };
}

const assess = (value, overrides = {}) => assessNonAtomic(value, { policy, funding, now: NOW, ...overrides });
const ledger = () => new PaperNonAtomicLedger({ funding, policy });
const receipt = (id, name, r, overrides = {}) => ({
  txId: tx(id), chainId: r[name].chainId, confirmed: true, status: 'success', observedAt: NOW + 2,
  tokenAmount: r.amountToken, nativeAmount: r[name].quote.nativeAmount,
  gasNative: 2n * 10n ** 15n, ...overrides,
});
const resolution = (book, id, overrides = {}) => ({
  kind: 'paper-inventory-reconciled', confirmed: true, evidenceId: 'local-paper-reconciliation',
  residualTokens: book.residualTokens(id), additionalCostNative: 2n * SCALE / 100n, ...overrides,
});

test('cross-chain prefunded and same-chain two-tx are paper candidates, never execution authority', () => {
  for (const cross of [true, false]) {
    const result = assess(route(cross));
    assert.equal(result.paperCandidate, true, result.reason);
    assert.equal(result.executable, false);
    assert.equal(result.liveAuthorized, false);
    assert.equal(result.mode, 'paper');
    assert.equal(result.grossUsd, usd('20'));
    assert.equal(result.grossAfterCostsUsd, usd('18'));
    assert.equal(result.combinedGasUsd, usd('0.4'));
    assert.equal(result.netUsd, usd('14.6'));
    assert.equal(result.exposureUsd, usd(cross ? '220' : '100'));
    assert.equal(result.capitalUsd, usd(cross ? '225.4' : '105.4'));
    assert.equal(result.lossAtRiskUsd, result.capitalUsd);
  }
});

test('equal cross-chain addresses are insufficient; supplied identity certificate binds deployments', () => {
  for (const mutate of [
    r => { delete r.identityCertificate; },
    r => { r.identityCertificate.attestation = 'same-symbol'; },
    r => { r.identityCertificate.deployments[1].chainId = 1; },
    r => { r.identityCertificate.deployments[1].token = OTHER; },
    r => { r.identityCertificate.deployments[1].decimals = 6; },
    r => { r.identityCertificate.expiresAt = NOW; },
    r => { r.identityCertificate.issuedAt = NOW + 1; },
    r => { r.identityCertificate.issuedAt = NOW - 30_001; },
    r => { r.identityCertificate.id = ''; },
  ]) {
    const r = route(); mutate(r);
    assert.equal(assess(r).paperCandidate, false);
  }
  const mapped = route();
  mapped.sell.token = mapped.sell.quote.token = OTHER;
  mapped.identityCertificate.deployments[1].token = OTHER;
  const result = assess(mapped);
  assert.equal(result.paperCandidate, true, result.reason);
  assert.equal(result.identityAssurance, 'supplied-certificate-schema-only');
});

test('quote chain, token, decimals, venue, exact BigInt size, fees and times fail closed', () => {
  for (const name of ['buy', 'sell']) {
    for (const [field, value] of [
      ['chainId', 7], ['token', OTHER], ['tokenDecimals', 6], ['venue', 'different'],
      ['side', name === 'buy' ? 'sell' : 'buy'],
      ['amountToken', 10n * SCALE + 1n], ['amountToken', Number(10n * SCALE)],
      ['nativeAmount', '100'], ['nativeAmount', 0n], ['feesIncluded', false],
      ['observedAt', NOW + 1], ['observedAt', NOW - 30_001], ['expiresAt', NOW],
    ]) {
      const r = route(); r[name].quote[field] = value;
      assert.equal(assess(r).paperCandidate, false, `${name}.${field}`);
    }
  }
  const r = route(false);
  r.sell.token = r.sell.quote.token = OTHER;
  assert.equal(assess(r).paperCandidate, false);
});

test('each leg requires its own fresh native FX and gas with explicit L1 data fee', () => {
  for (const name of ['buy', 'sell']) {
    for (const mutate of [
      leg => { delete leg.fx; },
      leg => { leg.fx.chainId = 9; },
      leg => { leg.fx.observedAt = NOW - 30_001; },
      leg => { leg.fx.priceUsd = 0n; },
      leg => { delete leg.gas.l1DataFee; },
      leg => { leg.gas.gasPrice = 0n; },
      leg => { leg.gas.chainId = 9; },
      leg => { leg.gas.observedAt = NOW + 1; },
    ]) {
      const r = route(); mutate(r[name]);
      assert.equal(assess(r).paperCandidate, false);
    }
  }
  const r = route();
  r.sell.fx.priceUsd = usd('200');
  r.adverseMoveReserveUsd = usd('4');
  const result = assess(r);
  assert.equal(result.grossUsd, usd('140'));
  assert.equal(result.combinedGasUsd, usd('0.6'));
});

test('explicit bridge/rebalance costs, reserves, expiry and conservative risk bounds', () => {
  for (const field of ['bridgeCostUsd', 'rebalanceCostUsd', 'adverseMoveReserveUsd']) {
    const r = route(); delete r[field];
    assert.equal(assess(r).paperCandidate, false, field);
  }
  for (const mutate of [
    r => { r.adverseMoveReserveUsd = 0n; },
    r => { r.exposureTimeoutMs = 0; },
    r => { r.exposureTimeoutMs = 20_001; },
    r => { r.sell.quote.expiresAt = NOW + 9_999; },
    r => { r.bridgeCostUsd = usd('100'); },
    r => { r.buy.venue = r.buy.quote.venue = 'Curve'; },
    r => { r.kind = 'atomic'; },
    r => { r.amountToken = 0n; },
  ]) {
    const r = route(); mutate(r);
    assert.equal(assess(r).paperCandidate, false);
  }
  for (const field of ['maxCapitalUsd', 'maxExposureUsd', 'maxLossUsd']) {
    assert.equal(assess(route(), { policy: { ...policy, [field]: usd('1') } }).paperCandidate, false);
  }
});

test('three-times combined gas is independent of positive net, with exact boundary', () => {
  const r = route(false);
  r.bridgeCostUsd = r.rebalanceCostUsd = 0n;
  r.adverseMoveReserveUsd = 1n;
  const p = { ...policy, minAdverseMoveBps: 1n };
  r.adverseMoveReserveUsd = usd('0.01');
  r.sell.quote.nativeAmount = SCALE + 12n * SCALE / 1000n;
  assert.equal(assess(r, { policy: p }).paperCandidate, true);
  r.sell.quote.nativeAmount -= 1n;
  const result = assess(r, { policy: p });
  assert.ok(result.netUsd > 0n);
  assert.equal(result.paperCandidate, false);
});

test('prefunding includes native gas on each chain, same-chain combined gas and sell inventory', () => {
  for (const missing of [0, 1, 2]) {
    assert.equal(assess(route(), { funding: funding.filter((_, i) => i !== missing) }).paperCandidate, false);
  }
  const r = route(false);
  assert.equal(assess(r, { funding: [{ chainId: 1, token: NATIVE, amount: SCALE }] }).paperCandidate, false);
  assert.equal(assess(r, { funding: [funding[0]] }).paperCandidate, true);
  assert.equal(assess(r, { funding: [funding[0], funding[0]] }).paperCandidate, false);
});

test('reserve and pending lifecycle survives serialization and cannot duplicate tx or retry', () => {
  let book = ledger();
  const r = route();
  assert.equal(book.reserve('r', r, NOW).state, 'reserved');
  const free = book.availableFunding();
  assert.equal(book.recordPending('r', 'buy', tx(1), NOW + 1).state, 'buy-pending');
  book = PaperNonAtomicLedger.restore(book.serialize());
  assert.throws(() => book.recordPending('r', 'buy', tx(2), NOW + 1), /already submitted/);
  assert.throws(() => book.reserve('r', r, NOW + 1), /duplicate/);
  book.reserve('s', r, NOW + 1);
  assert.throws(() => book.recordPending('s', 'buy', tx(1), NOW + 1), /duplicate transaction/);
  assert.equal(book.recordPending('r', 'sell', tx(2), NOW + 1).state, 'buy-sell-pending');
  book.tick(NOW + 10_000);
  assert.equal(book.get('r').state, 'recovery-required');
  assert.throws(() => book.recordPending('r', 'buy', tx(3), NOW + 10_001), /never retry/);
  assert.throws(() => book.close('r', resolution(book, 'r'), NOW + 10_001), /retain reservations/);
  assert.ok(book.availableFunding()[0].amount < free[0].amount);
  book = PaperNonAtomicLedger.restore(book.serialize());
  book.recordReceipt('r', 'buy', receipt(1, 'buy', r), NOW + 10_001);
  book.recordReceipt('r', 'sell', receipt(2, 'sell', r), NOW + 10_001);
  assert.equal(book.get('r').state, 'recovery-required');
  assert.equal(book.close('r', resolution(book, 'r'), NOW + 10_001).state, 'closed');
});

test('same-chain sell waits for full buy; normal receipts settle exact balances once closed', () => {
  let book = ledger();
  const r = route(false);
  book.reserve('r', r, NOW);
  const held = book.availableFunding();
  assert.throws(() => book.recordPending('r', 'sell', tx(2), NOW + 1), /confirmed full buy/);
  book.recordPending('r', 'buy', tx(1), NOW + 1);
  assert.throws(() => book.recordReceipt('r', 'buy', receipt(9, 'buy', r), NOW + 2), /mismatch/);
  assert.throws(() => book.recordReceipt('r', 'buy',
    receipt(1, 'buy', r, { confirmed: false }), NOW + 2), /unconfirmed/);
  assert.equal(book.recordReceipt('r', 'buy', receipt(1, 'buy', r), NOW + 2).state, 'buy-filled');
  assert.deepEqual(book.availableFunding(), held);
  book.recordPending('r', 'sell', tx(2), NOW + 2);
  assert.equal(book.recordReceipt('r', 'sell', receipt(2, 'sell', r), NOW + 2).state, 'filled');
  assert.deepEqual(book.residualTokens('r'), []);
  book = PaperNonAtomicLedger.restore(book.serialize());
  book.close('r', resolution(book, 'r'), NOW + 3);
  assert.equal(book.get('r').realizedCashDeltaUsd, usd('17.6'));
  assert.equal(book.availableFunding().find(row => row.chainId === 1 && row.token === NATIVE).amount,
    100n * SCALE + SCALE / 5n - 4n * 10n ** 15n - 2n * SCALE / 100n);
  assert.throws(() => book.recordReceipt('r', 'sell', receipt(2, 'sell', r), NOW + 3), /closed/);
  assert.throws(() => book.close('r', resolution(book, 'r'), NOW + 3), /pending/);
  assert.equal(PaperNonAtomicLedger.restore(book.serialize()).serialize(), book.serialize());
});

test('partial fills retain all reservations and require explicit residual inventory reconciliation', () => {
  const book = ledger();
  const r = route();
  book.reserve('r', r, NOW);
  book.recordPending('r', 'buy', tx(1), NOW + 1);
  book.recordPending('r', 'sell', tx(2), NOW + 1);
  const held = book.availableFunding();
  assert.equal(book.recordReceipt('r', 'buy', receipt(1, 'buy', r,
    { tokenAmount: 5n * SCALE, nativeAmount: SCALE / 2n }), NOW + 2).state, 'partial');
  assert.deepEqual(book.availableFunding(), held);
  assert.throws(() => book.close('r', resolution(book, 'r'), NOW + 2), /retain reservations/);
  book.recordReceipt('r', 'sell', receipt(2, 'sell', r), NOW + 2);
  assert.equal(book.get('r').state, 'recovery-required');
  assert.throws(() => book.close('r', resolution(book, 'r', { residualTokens: [] }), NOW + 3),
    /residual inventory/);
  book.close('r', resolution(book, 'r'), NOW + 3);
  assert.equal(book.availableFunding().find(row => row.chainId === 1 && row.token === TOKEN).amount,
    5n * SCALE);
  assert.equal(book.availableFunding().find(row => row.chainId === 2 && row.token === TOKEN).amount,
    990n * SCALE);
});

test('reverts, worse-than-quote fills, excess gas and partial same-chain buys require recovery', () => {
  for (const overrides of [
    { status: 'reverted', tokenAmount: 0n, nativeAmount: 0n },
    { tokenAmount: 5n * SCALE, nativeAmount: SCALE / 2n },
    { nativeAmount: SCALE + 1n },
    { gasNative: SCALE },
  ]) {
    const book = ledger();
    const r = route(false);
    book.reserve('r', r, NOW);
    book.recordPending('r', 'buy', tx(1), NOW + 1);
    book.recordReceipt('r', 'buy', receipt(1, 'buy', r, overrides), NOW + 2);
    assert.equal(book.get('r').state, 'recovery-required');
    assert.throws(() => book.recordPending('r', 'sell', tx(2), NOW + 2), /never retry/);
    book.close('r', resolution(book, 'r'), NOW + 3);
  }
});

test('expiry without submissions can be reconciled but cannot be retried', () => {
  const book = ledger();
  const r = route();
  book.reserve('r', r, NOW);
  book.tick(NOW + 10_000);
  assert.throws(() => book.recordPending('r', 'buy', tx(1), NOW + 10_000), /never retry/);
  assert.throws(() => book.close('r', resolution(book, 'r', { confirmed: false }), NOW + 10_000),
    /confirmed paper reconciliation/);
  book.close('r', resolution(book, 'r', { additionalCostNative: 0n }), NOW + 10_000);
  assert.deepEqual(book.availableFunding(), funding);
});

test('aggregate capital limits and inventory reservations prevent overbooking', () => {
  const r = route();
  const book = new PaperNonAtomicLedger({ funding, policy: { ...policy, maxCapitalUsd: usd('400') } });
  book.reserve('a', r, NOW);
  assert.throws(() => book.reserve('b', r, NOW), /aggregate maxCapitalUsd/);
  const small = new PaperNonAtomicLedger({
    policy, funding: funding.map(row => row.chainId === 1 ? { ...row, amount: 2n * SCALE } : row),
  });
  small.reserve('a', r, NOW);
  assert.throws(() => small.reserve('b', r, NOW), /insufficient prefunded/);
});

test('snapshots do not expose mutable state; event replay validates malformed data and time', () => {
  const book = ledger();
  const r = route();
  book.reserve('r', r, NOW);
  r.amountToken = 1n;
  const copy = book.get('r');
  copy.legs.buy.state = 'filled';
  assert.equal(book.get('r').legs.buy.state, 'unsubmitted');
  assert.equal(book.get('r').route.amountToken, 10n * SCALE);
  assert.throws(() => book.tick(NOW - 1), /monotonic/);
  const data = JSON.parse(book.serialize());
  data.events.push({ type: 'constructor', args: [], now: NOW });
  assert.throws(() => PaperNonAtomicLedger.restore(JSON.stringify(data)), /invalid ledger event/);
  assert.throws(() => PaperNonAtomicLedger.restore('{"version":2,"events":[]}'), /schema/);
  assert.throws(() => PaperNonAtomicLedger.restore('{"$bigint":"1e18"}'), /integer/);
});

test('pending records recheck quote and FX freshness rather than relying on reservation time', () => {
  for (const field of ['quote', 'fx', 'gas']) {
    const book = ledger();
    const r = route();
    r.buy[field].observedAt = NOW - 29_999;
    book.reserve('r', r, NOW);
    assert.throws(() => book.recordPending('r', 'buy', tx(1), NOW + 2), /stale/);
    assert.equal(book.get('r').legs.buy.state, 'unsubmitted');
  }
});

test('receipts bind chain and tx; invalid and duplicate receipts do not mutate persisted state', () => {
  const book = ledger();
  const r = route();
  book.reserve('r', r, NOW);
  book.recordPending('r', 'buy', tx(1), NOW + 1);
  const before = book.serialize();
  for (const overrides of [
    { chainId: 2 }, { tokenAmount: r.amountToken + 1n }, { nativeAmount: -1n },
    { status: 'reverted' }, { observedAt: NOW + 3 }, { observedAt: NOW },
  ]) {
    assert.throws(() => book.recordReceipt('r', 'buy', receipt(1, 'buy', r, overrides), NOW + 2));
    assert.equal(book.serialize(), before);
  }
  book.recordReceipt('r', 'buy', receipt(1, 'buy', r), NOW + 2);
  const finalized = book.serialize();
  assert.throws(() => book.recordReceipt('r', 'buy', receipt(1, 'buy', r), NOW + 2), /already finalized/);
  assert.equal(book.serialize(), finalized);
});

test('unresolved timeouts or receipt-bound overruns freeze new paper capital allocations', () => {
  for (const timeout of [true, false]) {
    const book = ledger();
    const r = route();
    book.reserve('r', r, NOW);
    if (timeout) {
      assert.throws(() => book.reserve('s', r, NOW + 10_000), /unresolved exposure/);
    } else {
      book.recordPending('r', 'buy', tx(1), NOW + 1);
      book.recordReceipt('r', 'buy', receipt(1, 'buy', r, { gasNative: SCALE }), NOW + 2);
      assert.throws(() => book.reserve('s', r, NOW + 2), /unresolved exposure/);
    }
  }
});

test('all lifecycle checkpoints round-trip exactly, including partial receipts and late recovery', () => {
  let book = ledger();
  const r = route();
  const roundTrip = () => {
    const encoded = book.serialize();
    book = PaperNonAtomicLedger.restore(encoded);
    assert.equal(book.serialize(), encoded);
  };
  book.reserve('r', r, NOW); roundTrip();
  book.recordPending('r', 'buy', tx(1), NOW + 1); roundTrip();
  book.recordPending('r', 'sell', tx(2), NOW + 1); roundTrip();
  book.recordReceipt('r', 'buy', receipt(1, 'buy', r,
    { tokenAmount: SCALE, nativeAmount: SCALE / 10n }), NOW + 2); roundTrip();
  book.tick(NOW + 10_000); roundTrip();
  book.recordReceipt('r', 'sell', receipt(2, 'sell', r,
    { status: 'reverted', tokenAmount: 0n, nativeAmount: 0n }), NOW + 10_001); roundTrip();
  book.close('r', resolution(book, 'r'), NOW + 10_002); roundTrip();
});

test('every quote is pinned to its leg block; same-chain pins match and cross-chain pins are independent', () => {
  for (const name of ['buy', 'sell']) {
    for (const mutate of [
      leg => { delete leg.blockHash; },
      leg => { delete leg.quote.blockHash; },
      leg => { leg.blockHash = '0x123'; },
      leg => { leg.quote.blockHash = '0x123'; },
      leg => { leg.quote.blockHash = tx(99); },
    ]) {
      const r = route(); mutate(r[name]);
      assert.equal(assess(r).paperCandidate, false, name);
    }
  }
  const same = route(false);
  same.sell.blockHash = same.sell.quote.blockHash = tx(99);
  assert.equal(assess(same).paperCandidate, false);
  const cross = route();
  cross.sell.blockHash = cross.sell.quote.blockHash = tx(99);
  assert.equal(assess(cross).paperCandidate, true);
  const caseInsensitive = route(false);
  caseInsensitive.buy.blockHash = caseInsensitive.buy.quote.blockHash = `0x${'ab'.repeat(32)}`;
  caseInsensitive.sell.blockHash = caseInsensitive.sell.quote.blockHash = `0x${'AB'.repeat(32)}`;
  assert.equal(assess(caseInsensitive).paperCandidate, true);
});

test('three-times gas hurdle applies after bridge and rebalancing costs, including its exact boundary', () => {
  const r = route(false);
  const p = { ...policy, minAdverseMoveBps: 1n };
  r.adverseMoveReserveUsd = usd('0.01');
  r.bridgeCostUsd = usd('0.7');
  r.rebalanceCostUsd = usd('0.3');
  r.sell.quote.nativeAmount = SCALE + 22n * SCALE / 1000n;
  const boundary = assess(r, { policy: p });
  assert.equal(boundary.paperCandidate, true);
  assert.equal(boundary.grossAfterCostsUsd, 3n * boundary.combinedGasUsd);
  r.sell.quote.nativeAmount -= 1n;
  const below = assess(r, { policy: p });
  assert.ok(below.grossUsd >= 3n * below.combinedGasUsd);
  assert.ok(below.netUsd > 0n);
  assert.equal(below.paperCandidate, false);
});

test('distinct arbitrary pool IDs for one coin are valid venue identities', () => {
  const r = route(false);
  r.buy.venue = r.buy.quote.venue = `uniswap-v4:pool:${tx(51)}`;
  r.sell.venue = r.sell.quote.venue = `uniswap-v4:pool:${tx(52)}`;
  assert.equal(assess(r).paperCandidate, true);
});
