// Moving the native leg between chains, via Relay (relay.link).
//
// The Portal bridges launched tokens only — it will not move ETH, POL or BNB —
// so on its own an arbitrage route is one-way: you end holding a different
// chain's gas asset than you started with. Relay closes that loop. It covers all
// nine chains here, Robinhood and Monad included, and settles a native transfer
// in seconds for a few tenths of a percent.
//
// That turns two things on:
//   * positioning capital onto whichever chain currently has the cheap entry,
//     rather than being stuck trading from wherever the balance happens to sit;
//   * recycling proceeds back to the start chain so the same money can go again.

import { CHAINS } from './config.mjs';
import { publicClient, walletClient } from './chain.mjs';

const RELAY = process.env.RELAY_API || 'https://api.relay.link';
const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';

let _supported = null;

/** Chain ids Relay can route, intersected with the chains this bot knows. */
export async function supportedChains() {
  if (_supported) return _supported;
  try {
    const r = await fetch(`${RELAY}/chains`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`chains ${r.status}`);
    const j = await r.json();
    const list = j.chains ?? (Array.isArray(j) ? j : []);
    const ids = new Set(list.map((c) => Number(c.id)));
    _supported = new Set(CHAINS.map((c) => c.id).filter((id) => ids.has(id)));
  } catch { _supported = new Set(); }
  return _supported;
}

/**
 * Quote a native -> native transfer. Returns the amount that lands, the total
 * cost in USD, and the transaction steps needed to execute it.
 */
export async function quoteNative({ from, to, amount, address, recipient = null }) {
  const body = {
    user: address,
    recipient: recipient ?? address,
    originChainId: from.id,
    destinationChainId: to.id,
    originCurrency: NATIVE_CURRENCY,
    destinationCurrency: NATIVE_CURRENCY,
    amount: amount.toString(),
    tradeType: 'EXACT_INPUT',
  };
  const r = await fetch(`${RELAY}/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`relay quote ${from.short}->${to.short} failed (${r.status}): ${t.slice(0, 160)}`);
  }
  const j = await r.json();
  const d = j.details ?? {};
  const out = BigInt(d.currencyOut?.amount ?? '0');
  return {
    amountIn: amount,
    amountOut: out,
    usdIn: Number(d.currencyIn?.amountUsd ?? 0),
    usdOut: Number(d.currencyOut?.amountUsd ?? 0),
    costUsd: Number(d.currencyIn?.amountUsd ?? 0) - Number(d.currencyOut?.amountUsd ?? 0),
    impactPct: Number(d.totalImpact?.percent ?? 0),
    timeEstimate: Number(d.timeEstimate ?? 0),
    steps: j.steps ?? [],
    raw: j,
  };
}

/** Cached quotes — a route sweep asks for the same hop repeatedly. */
const _qcache = new Map();
export function resetRelayCache() { _qcache.clear(); }

export async function quoteNativeCached(args) {
  const k = `${args.from.id}:${args.to.id}:${args.amount}:${args.address}`;
  if (!_qcache.has(k)) {
    _qcache.set(k, await quoteNative(args).catch(() => null));
  }
  return _qcache.get(k);
}

/** Send the quote's transactions and wait for the destination to be credited. */
export async function executeNative({ from, to, quote, account, wait = true, timeoutMs = 180_000 }) {
  const wc = walletClient(from, account);
  const pc = publicClient(from);
  const sent = [];

  for (const step of quote.steps) {
    for (const item of step.items ?? []) {
      if (item.status === 'complete') continue;
      const d = item.data;
      if (!d?.to) continue;
      const hash = await wc.sendTransaction({
        to: d.to, data: d.data, value: BigInt(d.value ?? '0'), chain: wc.chain,
      });
      const rec = await pc.waitForTransactionReceipt({ hash });
      if (rec.status !== 'success') throw new Error(`relay ${step.id} reverted on ${from.name} (${hash})`);
      sent.push({ step: step.id, hash, check: item.check ?? null });
    }
  }
  if (!wait) return { sent, filled: null };

  const filled = await waitForFill({ sent, to, account, expect: quote.amountOut, timeoutMs });
  return { sent, filled };
}

/** Poll Relay's status endpoint, falling back to watching the balance rise. */
async function waitForFill({ sent, to, account, expect, timeoutMs }) {
  const until = Date.now() + timeoutMs;
  const check = sent.map((s) => s.check).filter(Boolean)[0];
  const pc = publicClient(to);
  const before = await pc.getBalance({ address: account.address }).catch(() => null);

  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    if (check?.endpoint) {
      try {
        const r = await fetch(`${RELAY}${check.endpoint}`, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) {
          const j = await r.json();
          const status = j.status ?? j.state;
          if (status === 'success' || status === 'complete') return true;
          if (status === 'failure' || status === 'refund') return false;
        }
      } catch { /* fall through to the balance check */ }
    }
    if (before !== null) {
      const now = await pc.getBalance({ address: account.address }).catch(() => null);
      if (now !== null && now >= before + (expect * 9n) / 10n) return true;
    }
  }
  return false;
}
