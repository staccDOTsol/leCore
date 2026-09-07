import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALE, NATIVE, usd, poolPriceUsd, curvePriceUsd, relayUnitPrice,
  FxBook, gasCost, profitability, compareMarkets } from '../src/pricing.mjs';
import { optimiseSizes, BridgeLedger, curveAllowed, allocateInventory } from '../src/policy.mjs';
import { CHAINS } from '../src/chains.mjs';

test('native/token orientation and decimals remain exact beyond Number precision', () => {
  assert.equal(poolPriceUsd(1n << 96n, 18, 18, usd('2000')), usd('2000'));
  assert.equal(poolPriceUsd(2n << 96n, 18, 18, usd('2000')), usd('500'));
  assert.equal(poolPriceUsd(1n << 96n, 6, 18, usd('2000')), 2_000_000_000n);
  assert.equal(poolPriceUsd(0n, 18, 18, usd('2000')), null);
  assert.throws(() => poolPriceUsd(1n << 160n, 18, 18, 1n));
  assert.throws(() => poolPriceUsd(1n, 37, 18, 1n));
  assert.equal(curvePriceUsd(10n ** 15n, usd('2000')), usd('2'));
  assert.equal(usd('9007199254740993.000000000000000001'), 9007199254740993n * SCALE + 1n);
  for (const invalid of [1.2, '-1', 'NaN', '1e6', '1.0000000000000000001']) {
    assert.throws(() => usd(invalid));
  }
});

const side = (chainId, amount, amountUsd) => ({
  currency: { chainId, address: NATIVE, decimals: 18 }, amount, amountUsd,
});

test('Relay unit FX divides each valuation by its own quantity, never bridge ratio', () => {
  const input = relayUnitPrice(side(1, (2n * SCALE).toString(), '4000'), 1);
  const output = relayUnitPrice(side(143, (180_000n * SCALE).toString(), '3960'), 143);
  assert.equal(input, usd('2000'));
  assert.equal(output, usd('0.022'));
  assert.throws(() => relayUnitPrice(side(143, '0', '1'), 143));
  assert.throws(() => relayUnitPrice(side(1, SCALE.toString(), '1'), 143));
  assert.throws(() => relayUnitPrice({ ...side(1, '1', '1'), currency: { chainId: 1 } }, 1));
});

test('FX fails closed on unavailable, stale, future and inconsistent observations', () => {
  const fx = new FxBook({ maxAgeMs: 1000 });
  assert.equal(fx.get(143, 1000), null);
  fx.set(143, usd('0.02'), 1000, 1000);
  assert.equal(fx.get(143, 2001), null);
  assert.throws(() => fx.set(143, usd('0.02'), 3000, 2000));
  assert.throws(() => fx.set(143, usd('2000'), 1001, 1001));
  assert.equal(fx.get(143, 1001), null);
});

test('BNB gas uses nonzero gas price even when base fee is zero; L1 fee is mandatory', () => {
  assert.equal(gasCost({ gasUnits: 100_000n, gasPrice: 50_000_000n,
    maxFeePerGas: 0n, l1DataFee: 10n }), 5_000_000_000_010n);
  assert.equal(gasCost({ gasUnits: 2n, gasPrice: 3n, maxFeePerGas: 4n, l1DataFee: 1n }), 9n);
  assert.throws(() => gasCost({ gasUnits: 1n, gasPrice: 0n, l1DataFee: 0n }));
  assert.throws(() => gasCost({ gasUnits: 1n, gasPrice: 1n }));
});

test('whole transaction profit includes hook fees once and applies 3x pre-gas threshold', () => {
  assert.deepEqual(profitability({ amountIn: 1000n, amountOut: 1300n, gas: 100n,
    safetyReserve: 10n }), { gross: 300n, net: 190n, eligible: true });
  assert.equal(profitability({ amountIn: 1000n, amountOut: 1299n, gas: 100n,
    safetyReserve: 0n }).eligible, false);
  assert.equal(profitability({ amountIn: 1000n, amountOut: 1300n, gas: 100n,
    safetyReserve: 200n }).eligible, false);
});

test('27-price discovery never authorizes a route and excludes missing FX', () => {
  const market = { token: NATIVE, observedAt: 1000, fxObservedAt: 1000,
    coverage: 'fresh', venue: 'hooked', priceUsd: 10n, chainId: 8453 };
  const result = compareMarkets([market, { ...market, venue: 'hookless', priceUsd: 20n },
    { ...market, chainId: 143, priceUsd: 30n },
    { ...market, chainId: 56, priceUsd: 500n, fxObservedAt: null }], 1000);
  assert.equal(result.length, 3);
  assert.ok(result.every(signal => signal.executable === false));
  assert.equal(result.filter(signal => signal.type === 'same-chain-candidate').length, 1);
  assert.equal(result.filter(signal => signal.type === 'rebalance-signal').length, 2);
  assert.equal(compareMarkets([market, { ...market, priceUsd: 20n }], 1000).length, 0);
});

const hash = `0x${'a'.repeat(64)}`;
const policy = {
  chainId: 8453, token: NATIVE, blockHash: hash, now: 1000,
  nativeBalance: 1000n, reservedNative: 0n, gasReserve: 100n,
  maxNotional: 800n, safetyReserve: 10n,
};
const quote = size => ({ chainId: 8453, token: NATIVE, blockHash: hash, amountIn: size,
  amountOut: size + 100n, gas: 10n, priceImpactBps: 20n, atomic: true,
  feesIncluded: true, observedAt: 1000 });

test('size selection uses size-specific net profit, not biggest spread or input', async () => {
  const r = await optimiseSizes([100n, 200n, 300n, 300n, 1000n], async size => ({
    ...quote(size), gas: size === 300n ? 90n : 10n,
    amountOut: size + (size === 200n ? 150n : 100n),
  }), policy);
  assert.equal(r.best.size, 200n);
  assert.equal(r.results.length, 3);
  assert.equal(r.fundedExecution, false);
});

test('size selection rejects mismatched, stale, high-impact or unaffordable simulation', async () => {
  for (const override of [{ chainId: 143 }, { blockHash: `0x${'b'.repeat(64)}` },
    { amountIn: 1n }, { feesIncluded: false }, { atomic: false }, { observedAt: 1001 },
    { priceImpactBps: 101n }, { gas: 1000n }, { token: '0x1' }]) {
    const result = await optimiseSizes([100n], async size => ({ ...quote(size), ...override }), policy);
    assert.equal(result.best, null);
  }
  assert.equal((await optimiseSizes([100n], async () => { throw Error('RPC'); }, policy)).best, null);
});

test('bridge delay keeps funds reserved and never enables another burn', () => {
  const record = { id: `${hash}:0`, sourceChainId: 8453, destinationChainId: 143,
    token: NATIVE, amount: 10n, burnedAt: 1000, state: 'pending' };
  const ledger = new BridgeLedger([record]);
  assert.equal(ledger.status(90_999)[0].alert, false);
  assert.equal(ledger.status(91_000)[0].alert, true);
  assert.equal(ledger.status(1_000_000)[0].reserved, 10n);
  assert.equal(ledger.status(1_000_000)[0].retryBurn, false);
  assert.deepEqual(BridgeLedger.fromJSON(ledger.toJSON()).toJSON(), ledger.toJSON());
  assert.throws(() => ledger.observe({ ...record, amount: 20n }));
  assert.throws(() => ledger.observe({ ...record, state: 'confirmed' }));
  ledger.observe({ ...record, state: 'confirmed', settlementTx: hash });
  assert.equal(ledger.status(1_000_000)[0].reserved, 0n);
  assert.throws(() => ledger.observe(record));
});

test('curve guard remains disabled; allocation is based on realised capital turnover', () => {
  assert.equal(curveAllowed({ graduated: false }, {
    reserveAfter: 100n, minReserve: 50n, cumulativeFlow: 10n, maxFlow: 20n,
  }).executable, false);
  assert.deepEqual(allocateInventory(90n, [
    { chainId: 1, realisedNet: 20n, capitalTime: 10n },
    { chainId: 56, realisedNet: 10n, capitalTime: 10n },
    { chainId: 143, realisedNet: -1n, capitalTime: 1n },
  ]), [{ chainId: 1, allocation: 60n }, { chainId: 56, allocation: 30n }]);
});

test('nine-chain manifest correctly identifies World as ETH native', () => {
  assert.equal(CHAINS.length, 9);
  assert.equal(new Set(CHAINS.map(chain => chain.id)).size, 9);
  assert.equal(CHAINS.find(chain => chain.id === 480).nativeSymbol, 'ETH');
  assert.deepEqual(CHAINS.filter(chain => chain.hasCurve).map(chain => chain.id), [4663, 8453]);
  assert.ok(CHAINS.every(chain => chain.verification === 'unverified'));
});
