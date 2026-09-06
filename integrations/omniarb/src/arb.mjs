// Opportunity search.
//
// Three shapes of trade, in descending order of how much can go wrong:
//
//   1. same-chain, atomic   buy on one pool, sell into another, one transaction.
//                           Reverts unless it clears minProfit, so a miss costs gas only.
//   2. same-chain, two-step curve <-> pool. The pad and the router are separate
//                           contracts, so this is two transactions and carries real
//                           inventory risk between them.
//   3. cross-chain          buy here, bridge, sell there. The bridge is burn/mint
//                           through a permissioned relayer, so the token is in flight
//                           for as long as the relayer takes. Priced, but never atomic.

import { formatEther, parseEther } from 'viem';
import { nativePrices, toUsd } from './prices.mjs';
import { quoteNativeCached, supportedChains } from './relay.mjs';
import { NATIVE, PORTAL } from './config.mjs';
import { publicClient, simOverrides, SIM_ACCOUNT } from './chain.mjs';
import { ARTIFACT, helperFor, quoteBuy, quoteSell, arbGasCost } from './quote.mjs';

/**
 * Number of native units -> wei.
 *
 * `parseEther` rejects exponential notation, and JavaScript switches to it below
 * 1e-6 — which is squarely inside the range these trades live in, so building the
 * string with String() silently breaks on exactly the sizes that matter.
 */
export function numToWei(n) {
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return parseEther(n.toFixed(18));
}

/** Sizes probed before refining, in native units. */
const LADDER = ['0.00005', '0.0002', '0.001', '0.005', '0.02', '0.08', '0.3', '1', '3', '10'];

/**
 * Simulate one atomic same-chain arb at `sizeIn`. Returns gross profit in wei,
 * or null when the round trip reverts (no pool, no liquidity, or a loss).
 */
export async function simulateAtomic(c, token, buyVenue, sellVenue, sizeIn) {
  const h = helperFor(c);
  const override = h.deployed ? [] : [{ address: h.address, code: ARTIFACT.deployedBytecode }];

  let fn, args;
  if (buyVenue.viaOmniRouter && !sellVenue.viaOmniRouter) {
    fn = 'arbHookedToV4';
    args = [c.router, token, c.hook, c.poolManager, sellVenue.key, 0n];
  } else if (!buyVenue.viaOmniRouter && sellVenue.viaOmniRouter) {
    fn = 'arbV4ToHooked';
    args = [c.poolManager, buyVenue.key, c.router, token, c.hook, 0n];
  } else {
    return null; // two hookless or two hooked pools: not wired into the helper
  }

  try {
    const { result } = await publicClient(c).simulateContract({
      address: h.address, abi: ARTIFACT.abi, functionName: fn, args,
      value: sizeIn, account: SIM_ACCOUNT,
      stateOverride: simOverrides({ native: sizeIn + parseEther('1'), extra: override }),
    });
    return { profit: result, fn, args };
  } catch { return null; }
}

/**
 * Gas the winning atomic call actually costs, estimated against real state.
 *
 * Worth the extra round trip: these trades often land within a few percent of
 * breakeven, where the difference between a guessed 600k and a measured 550k
 * decides whether the opportunity is real.
 */
export async function estimateAtomicGas(c, call, sizeIn) {
  const h = helperFor(c);
  const override = h.deployed ? [] : [{ address: h.address, code: ARTIFACT.deployedBytecode }];
  try {
    return await publicClient(c).estimateContractGas({
      address: h.address, abi: ARTIFACT.abi, functionName: call.fn, args: call.args,
      value: sizeIn, account: SIM_ACCOUNT,
      stateOverride: simOverrides({ native: sizeIn + parseEther('1'), extra: override }),
    });
  } catch { return null; }
}

/** Non-atomic estimate: buy on one venue, sell the proceeds on another. */
export async function simulateTwoStep(c, token, buyVenue, sellVenue, sizeIn) {
  const tokens = await quoteBuy(c, token, buyVenue, sizeIn);
  if (!tokens || tokens === 0n) return null;
  const back = await quoteSell(c, token, sellVenue, tokens);
  if (back === null) return null;
  return { profit: back - sizeIn, tokens, back };
}

/**
 * Search for the size that maximises NET profit (gross minus gas). Profit here
 * is not monotonic — it climbs while the cheap pool has depth, then collapses
 * once the trade moves that pool past the expensive one — so this walks a coarse
 * log ladder and then refines around the winner.
 */
export async function optimiseSize(evaluate, gasCost, { cap = null } = {}) {
  const tried = [];
  let best = null;

  const consider = async (spec) => {
    const size = typeof spec === 'bigint' ? spec : parseEther(spec);
    if (size <= 0n) return;
    if (cap && size > cap) return;
    if (tried.some((t) => t.size === size)) return;
    const r = await evaluate(size);
    const net = r ? r.profit - gasCost : null;
    tried.push({ size, gross: r?.profit ?? null, net });
    if (net !== null && (!best || net > best.net)) best = { size, gross: r.profit, net, detail: r };
  };

  for (const s of LADDER) await consider(s);
  if (!best) return { best: null, tried };

  // Refine: walk a geometric neighbourhood around the winner.
  for (const mult of [0.4, 0.6, 0.8, 1.25, 1.6, 2.2, 3]) {
    const w = numToWei(Number(formatEther(best.size)) * mult);
    if (w > 0n) await consider(w);
  }
  return { best, tried };
}

/**
 * Every profitable same-chain opportunity for one token on one chain.
 * `venues` must come from discovery so the hookless pool is included.
 */
export async function findSameChain(c, token, venues, { cap = null, minNet = 0n } = {}) {
  const gas = await arbGasCost(c);
  if (!gas) return [];
  const out = [];

  for (const buyV of venues) {
    for (const sellV of venues) {
      if (buyV === sellV) continue;
      if (buyV.poolId && sellV.poolId && buyV.poolId === sellV.poolId) continue;

      const atomic = buyV.viaOmniRouter !== sellV.viaOmniRouter
        && buyV.kind !== 'curve' && sellV.kind !== 'curve';

      const evaluate = atomic
        ? (size) => simulateAtomic(c, token, buyV, sellV, size)
        : (size) => simulateTwoStep(c, token, buyV, sellV, size);

      const { best } = await optimiseSize(evaluate, gas.cost, { cap });
      if (!best) continue;

      // Re-price the winner against a measured gas figure before judging it.
      let gasUnits = gas.gas;
      let gasWei = gas.cost;
      let net = best.net;
      const call = best.detail?.fn ? { fn: best.detail.fn, args: best.detail.args } : null;
      if (call) {
        const measured = await estimateAtomicGas(c, call, best.size);
        if (measured) {
          gasUnits = measured;
          gasWei = measured * gas.price;
          net = best.gross - gasWei;
        }
      }
      if (net <= minNet) continue;

      out.push({
        type: atomic ? 'same-chain-atomic' : 'same-chain-two-step',
        chainId: c.id, chain: c, token,
        buy: buyV, sell: sellV,
        sizeIn: best.size, gross: best.gross, gas: gasWei, net,
        gasUnits, gasPrice: gas.price, call,
      });
    }
  }
  return out.sort((a, b) => (b.net > a.net ? 1 : -1));
}


// ------------------------------------------------------- non-atomic routes
//
// Everything below spans more than one transaction, and usually more than one
// chain. Two things make that materially different from the atomic case:
//
//   * There is no revert to protect you. Between the buy, the bridge and the
//     sell, the far pool can move. Size and latency are the only real controls.
//   * Chains here do not share a gas asset. Buying with ETH on Ethereum and
//     selling for POL on Polygon are separated by ~25,000x in unit value, so
//     every figure below is settled in USD rather than in "native".

/** Gas, in wei of each chain's own asset, for the legs of a bridged route. */
const LEG_GAS = { buy: 300_000n, bridgeOut: 200_000n, sell: 300_000n };

async function gasWei(c, units) {
  try { return units * (await publicClient(c).getGasPrice()); } catch { return null; }
}

/** Maximise a Number-valued score over trade size, same coarse-then-refine walk. */
async function optimiseUsd(evaluate, { cap = null } = {}) {
  const tried = [];
  let best = null;
  const consider = async (spec) => {
    const size = typeof spec === 'bigint' ? spec : parseEther(spec);
    if (size <= 0n) return;
    if (cap && size > cap) return;
    if (tried.some((t) => t.size === size)) return;
    const r = await evaluate(size);
    tried.push({ size, score: r?.score ?? null });
    if (r && Number.isFinite(r.score) && (!best || r.score > best.score)) best = { size, ...r };
  };
  for (const s of LADDER) await consider(s);
  if (!best) return null;
  for (const mult of [0.4, 0.6, 0.8, 1.25, 1.6, 2.2, 3]) {
    const w = numToWei(Number(formatEther(best.size)) * mult);
    if (w > 0n) await consider(w);
  }
  return best;
}

/**
 * Buy on one chain, bridge the token 1:1, sell on another.
 *
 * The Portal mints exactly what it burned, so the token amount survives the hop
 * intact — the entire edge is the price gap between the two chains' pools, and
 * the entire risk is how long the relayer takes to mint.
 */
export async function findCrossChain(token, byChain, { cap = null, minUsd = 0 } = {}) {
  const prices = await nativePrices();
  const out = [];
  const entries = [...byChain.entries()];

  const gasCache = new Map();
  const gasFor = async (c, units) => {
    const k = `${c.id}:${units}`;
    if (!gasCache.has(k)) gasCache.set(k, await gasWei(c, units));
    return gasCache.get(k);
  };

  for (const [srcId, src] of entries) {
    for (const [dstId, dst] of entries) {
      if (srcId === dstId) continue;
      const srcBuyGas = await gasFor(src.chain, LEG_GAS.buy);
      const srcBridgeGas = await gasFor(src.chain, LEG_GAS.bridgeOut);
      const dstSellGas = await gasFor(dst.chain, LEG_GAS.sell);
      if (srcBuyGas === null || srcBridgeGas === null || dstSellGas === null) continue;

      const srcGasUsd = toUsd(prices, srcId, srcBuyGas + srcBridgeGas);
      const dstGasUsd = toUsd(prices, dstId, dstSellGas);
      if (srcGasUsd === null || dstGasUsd === null) continue;

      for (const buyV of src.venues) {
        for (const sellV of dst.venues) {
          const evaluate = async (size) => {
            const tokens = await quoteBuy(src.chain, token, buyV, size);
            if (!tokens || tokens === 0n) return null;
            const back = await quoteSell(dst.chain, token, sellV, tokens);
            if (back === null || back === 0n) return null;
            const spentUsd = toUsd(prices, srcId, size);
            const gotUsd = toUsd(prices, dstId, back);
            if (spentUsd === null || gotUsd === null) return null;
            const score = gotUsd - spentUsd - srcGasUsd - dstGasUsd;
            return { score, tokens, back, spentUsd, gotUsd };
          };
          const best = await optimiseUsd(evaluate, { cap });
          if (!best || best.score <= minUsd) continue;
          out.push({
            type: 'cross-chain', token,
            chain: src.chain, src: src.chain, dst: dst.chain, buy: buyV, sell: sellV,
            sizeIn: best.size, tokens: best.tokens, back: best.back,
            spentUsd: best.spentUsd, gotUsd: best.gotUsd,
            gasUsd: srcGasUsd + dstGasUsd, netUsd: best.score,
            note: 'not atomic — the token sits in the bridge until the relayer mints',
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.netUsd - a.netUsd);
}

/**
 * What the tokens already in the wallet are worth, and where.
 *
 * This needs no capital and no buy leg, so it is usually the first thing worth
 * acting on: a bag sitting on a chain whose pool saturates at a fraction of a
 * cent can often be bridged to a deep pool and sold for many times as much.
 */
export async function findLiquidation(token, byChain, holdings, { minUsd = 0 } = {}) {
  const prices = await nativePrices();
  const routes = [];

  for (const [heldChainId, amount] of holdings) {
    if (!amount || amount === 0n) continue;
    const held = byChain.get(heldChainId);

    for (const [dstId, dst] of byChain.entries()) {
      const needsBridge = dstId !== heldChainId;
      // Bridging costs a bridgeOut on the chain the tokens are on today.
      let bridgeUsd = 0;
      if (needsBridge) {
        if (!held) continue; // cannot bridge from a chain we know nothing about
        const w = await gasWei(held.chain, LEG_GAS.bridgeOut);
        if (w === null) continue;
        bridgeUsd = toUsd(prices, heldChainId, w) ?? 0;
      }
      const sellW = await gasWei(dst.chain, LEG_GAS.sell);
      if (sellW === null) continue;
      const sellUsd = toUsd(prices, dstId, sellW);
      if (sellUsd === null) continue;

      for (const sellV of dst.venues) {
        const back = await quoteSell(dst.chain, token, sellV, amount);
        if (back === null || back === 0n) continue;
        const grossUsd = toUsd(prices, dstId, back);
        if (grossUsd === null) continue;
        const netUsd = grossUsd - bridgeUsd - sellUsd;
        if (netUsd <= minUsd) continue;
        routes.push({
          type: needsBridge ? 'liquidate-bridged' : 'liquidate-local',
          token, amount, from: heldChainId, dst: dst.chain, sell: sellV,
          back, grossUsd, gasUsd: bridgeUsd + sellUsd, netUsd,
          note: needsBridge ? 'bridge then sell — not atomic' : 'single sell on the chain you already hold',
        });
      }
    }
  }
  return routes.sort((a, b) => b.netUsd - a.netUsd);
}

// ------------------------------------------------------------ funded routes
//
// The general shape of every trade this system supports:
//
//     native you actually hold on chain A
//        -> buy the token on some venue on A          (curve, hooked pool, or hookless pool)
//        -> optionally bridge it 1:1 to chain B       (burn on A, relayer mints on B)
//        -> sell it on some venue on B
//        -> native on chain B
//
// Two constraints make this different from the abstract scan:
//
//   * You can only start where you have money. A route that opens with 0.8 ETH
//     on Ethereum mainnet is worthless if the wallet holds nothing there, so the
//     search is capped per chain by the real balance minus a gas reserve.
//   * You do not end where you started. The proceeds land in chain B's native
//     asset, and the Portal bridges launched tokens only — never native — so
//     there is no closing leg back to A. Profit is therefore booked in USD.

/** Native held per chain, minus a reserve so the wallet can still pay for gas. */
export async function fundableCapital(chains, address, { reserveMultiple = 3n } = {}) {
  const funds = new Map();
  await Promise.all(chains.map(async (c) => {
    try {
      const pc = publicClient(c);
      const [bal, gp] = await Promise.all([pc.getBalance({ address }), pc.getGasPrice()]);
      const reserve = LEG_GAS.buy * gp * reserveMultiple;
      const usable = bal > reserve ? bal - reserve : 0n;
      funds.set(c.id, { chain: c, balance: bal, reserve, usable, gasPrice: gp });
    } catch { /* unreachable chain contributes nothing */ }
  }));
  return funds;
}

/**
 * Search the full route space, restricted to what the wallet can actually fund.
 * Returns routes ranked by USD profit, each annotated with whether it is atomic.
 */
export async function findRoutes(token, byChain, funds, { minUsd = 0, capUsd = null, mobileUsd = 0 } = {}) {
  const prices = await nativePrices();
  const out = [];
  const entries = [...byChain.entries()];

  const gasCache = new Map();
  const gasFor = async (c, units) => {
    const k = `${c.id}:${units}`;
    if (!gasCache.has(k)) gasCache.set(k, await gasWei(c, units));
    return gasCache.get(k);
  };

  for (const [srcId, src] of entries) {
    const fund = funds.get(srcId) ?? { usable: 0n, balance: 0n };
    const px = prices.byChain.get(srcId)?.usd;

    // Capital is mobile: Relay can move native onto this chain in seconds, so a
    // chain with no balance is still a candidate entry point. The relay hop is
    // priced for real once a route is worth quoting (see priceRelayFunding).
    let cap = fund.usable;
    if (mobileUsd > 0 && px) {
      const mobileWei = numToWei(mobileUsd / px);
      if (mobileWei > cap) cap = mobileWei;
    }
    if (cap === 0n) continue;

    if (capUsd && px) {
      const capWei = numToWei(capUsd / px);
      if (capWei < cap) cap = capWei;
    }

    for (const [dstId, dst] of entries) {
      const sameChain = srcId === dstId;
      const buyGas = await gasFor(src.chain, LEG_GAS.buy);
      const bridgeGas = sameChain ? 0n : await gasFor(src.chain, LEG_GAS.bridgeOut);
      const sellGas = await gasFor(dst.chain, LEG_GAS.sell);
      if (buyGas === null || bridgeGas === null || sellGas === null) continue;

      const srcGasUsd = toUsd(prices, srcId, buyGas + bridgeGas);
      const dstGasUsd = toUsd(prices, dstId, sellGas);
      if (srcGasUsd === null || dstGasUsd === null) continue;

      for (const buyV of src.venues) {
        for (const sellV of dst.venues) {
          if (sameChain && buyV === sellV) continue;
          if (sameChain && buyV.poolId && buyV.poolId === sellV.poolId) continue;

          // On one chain between a hooked and a hookless pool the whole round
          // trip fits in a single transaction, which removes the timing risk.
          const atomic = sameChain && buyV.kind !== 'curve' && sellV.kind !== 'curve'
            && buyV.viaOmniRouter !== sellV.viaOmniRouter;

          const evaluate = async (size) => {
            if (atomic) {
              const r = await simulateAtomic(src.chain, token, buyV, sellV, size);
              if (!r) return null;
              const grossUsd = toUsd(prices, srcId, r.profit);
              if (grossUsd === null) return null;
              return { score: grossUsd - srcGasUsd, atomicDetail: r, tokens: null, back: null };
            }
            const tokens = await quoteBuy(src.chain, token, buyV, size);
            if (!tokens || tokens === 0n) return null;
            const back = await quoteSell(dst.chain, token, sellV, tokens);
            if (back === null || back === 0n) return null;
            const spentUsd = toUsd(prices, srcId, size);
            const gotUsd = toUsd(prices, dstId, back);
            if (spentUsd === null || gotUsd === null) return null;
            return { score: gotUsd - spentUsd - srcGasUsd - dstGasUsd, tokens, back, spentUsd, gotUsd };
          };

          const best = await optimiseUsd(evaluate, { cap });
          if (!best || best.score <= minUsd) continue;

          out.push({
            type: atomic ? 'route-atomic' : (sameChain ? 'route-same-chain' : 'route-bridged'),
            atomic, token,
            chain: src.chain, src: src.chain, dst: dst.chain,
            buy: buyV, sell: sellV,
            sizeIn: best.size, tokens: best.tokens, back: best.back,
            spentUsd: best.spentUsd ?? toUsd(prices, srcId, best.size),
            gotUsd: best.gotUsd ?? null,
            gasUsd: srcGasUsd + (sameChain ? 0 : dstGasUsd),
            netUsd: best.score,
            fundedBy: { chain: src.chain.short, usable: fund.usable, balance: fund.balance },
            needsFunding: fund.usable < best.size ? best.size - fund.usable : 0n,
            call: best.atomicDetail ? { fn: best.atomicDetail.fn, args: best.atomicDetail.args } : null,
            note: atomic
              ? 'single transaction — reverts instead of losing if the edge moves'
              : sameChain
                ? 'two transactions on one chain — no bridge, but not atomic'
                : 'buy, bridge, sell — the token is in the bridge until the relayer mints',
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.netUsd - a.netUsd);
}

/**
 * Price the Relay hop for routes whose entry chain does not hold enough native.
 *
 * Routes are quoted, not estimated: Relay's fee depends on the pair and the
 * size, and at these trade sizes a wrong assumption about it is the difference
 * between a profit and a loss. Anything Relay will not route is dropped.
 */
export async function priceRelayFunding(routes, funds, address, { top = 25 } = {}) {
  const prices = await nativePrices();
  const supported = await supportedChains();
  const priced = [];

  for (const r of routes.slice(0, top)) {
    if (!r.needsFunding || r.needsFunding === 0n) { priced.push({ ...r, funding: 'local' }); continue; }
    if (!supported.has(r.src.id)) continue;

    // Cheapest chain that can actually cover the shortfall.
    let bestHop = null;
    for (const [fromId, f] of funds) {
      if (fromId === r.src.id || f.usable === 0n || !supported.has(fromId)) continue;
      const srcUsd = toUsd(prices, r.src.id, r.needsFunding);
      const fromPx = prices.byChain.get(fromId)?.usd;
      if (srcUsd === null || !fromPx) continue;
      // Send ~2% extra so fees do not leave the entry leg short.
      const sendWei = numToWei((srcUsd / fromPx) * 1.02);
      if (sendWei > f.usable) continue;
      const chain = f.chain;
      if (!chain) continue;
      const q = await quoteNativeCached({ from: chain, to: r.src, amount: sendWei, address });
      if (!q || q.amountOut < r.needsFunding) continue;
      if (!bestHop || q.costUsd < bestHop.costUsd) {
        bestHop = { from: chain, quote: q, costUsd: q.costUsd, seconds: q.timeEstimate };
      }
    }
    if (!bestHop) continue;
    priced.push({
      ...r, funding: 'relay', relay: bestHop,
      netUsd: r.netUsd - bestHop.costUsd,
      note: `${r.note} · funded from ${bestHop.from.short} over Relay (~${bestHop.seconds}s, ${usdCost(bestHop.costUsd)})`,
    });
  }
  return priced.filter((r) => r.netUsd > 0).sort((a, b) => b.netUsd - a.netUsd);
}

const usdCost = (v) => (Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
