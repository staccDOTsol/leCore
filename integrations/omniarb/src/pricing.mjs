export const SCALE = 10n ** 18n;
export const NATIVE = '0x0000000000000000000000000000000000000000';

export function uint(value, label = 'amount') {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`invalid ${label}`);
  return value;
}

export function decimals(value) {
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error('invalid decimals');
  return value;
}

export function usd(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(value)) {
    throw new Error('USD must be a nonnegative decimal string with at most 18 places');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}

export function fresh(timestamp, now, maxAgeMs) {
  return Number.isSafeInteger(timestamp) && Number.isSafeInteger(now)
    && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0
    && timestamp <= now && now - timestamp <= maxAgeMs;
}

// sqrtPriceX96^2 is token raw units / native raw units, not its inverse.
export function poolPriceUsd(sqrtPriceX96, tokenDecimals, nativeDecimals, nativeUsd) {
  uint(sqrtPriceX96); uint(nativeUsd);
  decimals(tokenDecimals); decimals(nativeDecimals);
  if (sqrtPriceX96 === 0n) return null;
  if (sqrtPriceX96 >= 1n << 160n || nativeUsd === 0n) throw new Error('invalid pool price');
  return nativeUsd * (1n << 192n) * 10n ** BigInt(tokenDecimals)
    / (sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(nativeDecimals));
}

export function curvePriceUsd(weiPerWholeToken, nativeUsd) {
  uint(weiPerWholeToken); uint(nativeUsd);
  if (!weiPerWholeToken || !nativeUsd) throw new Error('invalid curve price');
  return weiPerWholeToken * nativeUsd / SCALE;
}

// Each USD valuation is paired with ITS OWN raw amount. Bridge fees reduce both
// output amount and output USD; they must not become an exchange-rate haircut.
export function relayUnitPrice(side, expectedChainId) {
  if (side?.currency?.chainId !== expectedChainId
      || side.currency.address?.toLowerCase() !== NATIVE
      || side.currency.decimals !== 18
      || typeof side.amount !== 'string' || !/^[1-9]\d*$/.test(side.amount)) {
    throw new Error('Relay native currency identity/amount mismatch');
  }
  const price = usd(side.amountUsd) * SCALE / BigInt(side.amount);
  if (price <= 0n) throw new Error('nonpositive FX');
  return price;
}

export class FxBook {
  constructor({ maxAgeMs = 60_000, maxDeviationBps = 300n } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0
        || typeof maxDeviationBps !== 'bigint' || maxDeviationBps < 0n) {
      throw new Error('invalid FX policy');
    }
    this.maxAgeMs = maxAgeMs;
    this.maxDeviationBps = maxDeviationBps;
    this.entries = new Map();
  }

  set(chainId, price, observedAt, now = Date.now()) {
    uint(price);
    if (price === 0n || !fresh(observedAt, now, this.maxAgeMs)) throw new Error('stale FX');
    const previous = this.get(chainId, now);
    if (previous && (price > previous ? price - previous : previous - price) * 10_000n
        > previous * this.maxDeviationBps) {
      this.entries.delete(chainId);
      throw new Error('inconsistent FX');
    }
    this.entries.set(chainId, { price, observedAt });
  }

  get(chainId, now = Date.now()) {
    const entry = this.entries.get(chainId);
    return entry && fresh(entry.observedAt, now, this.maxAgeMs) ? entry.price : null;
  }
}

export function gasCost({ gasUnits, gasPrice, maxFeePerGas = 0n, l1DataFee }) {
  for (const value of [gasUnits, gasPrice, maxFeePerGas, l1DataFee]) uint(value, 'gas');
  if (!gasUnits || !gasPrice) throw new Error('missing nonzero eth_gasPrice');
  return gasUnits * (gasPrice > maxFeePerGas ? gasPrice : maxFeePerGas) + l1DataFee;
}

export function profitability({ amountIn, amountOut, gas, safetyReserve }) {
  for (const value of [amountIn, amountOut, gas, safetyReserve]) uint(value);
  if (!amountIn || !gas) throw new Error('missing notional/gas');
  // amountOut is a whole-transaction balance result, already net of venue fees.
  const gross = amountOut - amountIn;
  const net = gross - gas - safetyReserve;
  return { gross, net, eligible: gross >= 3n * gas && net > 0n };
}

export function classifyPair(buy, sell) {
  if (buy.token.toLowerCase() !== sell.token.toLowerCase()) throw new Error('different tokens');
  if (buy.chainId !== sell.chainId) return 'rebalance-signal';
  if (buy.venue === sell.venue) throw new Error('same venue');
  return 'same-chain-candidate';
}

export function marketComparisons(markets, now, maxAgeMs = 60_000, {
  maxSignals = 2000, maxComparisons = 250_000,
} = {}) {
  if (![maxSignals, maxComparisons].every(limit => Number.isSafeInteger(limit) && limit > 0)) {
    throw new Error('invalid comparison budget');
  }
  const valid = markets.filter(m => m.coverage === 'fresh' && m.priceUsd > 0n
    && fresh(m.observedAt, now, maxAgeMs) && fresh(m.fxObservedAt, now, maxAgeMs));
  const signals = [];
  let comparisons = 0;
  for (const buy of valid) for (const sell of valid) {
    if (comparisons++ >= maxComparisons || signals.length >= maxSignals) {
      return { signals, truncated: true };
    }
    if (buy.token.toLowerCase() !== sell.token.toLowerCase() || buy.priceUsd >= sell.priceUsd) continue;
    if (buy.chainId === sell.chainId && buy.venue === sell.venue) continue;
    signals.push({
      type: classifyPair(buy, sell), executable: false,
      buy: { chainId: buy.chainId, venue: buy.venue },
      sell: { chainId: sell.chainId, venue: sell.venue },
      token: buy.token, spreadBps: (sell.priceUsd - buy.priceUsd) * 10_000n / buy.priceUsd,
    });
  }
  return { signals, truncated: false };
}

export function compareMarkets(markets, now, maxAgeMs = 60_000) {
  return marketComparisons(markets, now, maxAgeMs).signals;
}
