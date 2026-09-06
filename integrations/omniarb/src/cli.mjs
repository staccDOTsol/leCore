#!/usr/bin/env node
// omniarb — arbitrage across omnichain.family's venues.
//
//   omniarb tokens                      what has launched
//   omniarb venues  --token 0x..        every pool for a CA, per chain, with live price
//   omniarb balances                    what the wallet holds where
//   omniarb scan    --token 0x..        priced opportunities, net of gas
//   omniarb deploy  --chain Pol         deploy the OmniArb helper (needed for hookless pools)
//   omniarb run     --token 0x.. --live execute the best opportunity
//   omniarb bridge  --token 0x.. --from Base --to Pol --amount 1000

import { cpus } from 'node:os';
import { formatEther, formatUnits, getAddress, parseEther } from 'viem';
import { CHAINS, chainById, HOME_CHAIN, arbHelperFor, recordDeployment } from './config.mjs';
import { publicClient, loadAccount, allChains, supportsOverrides, verifyTokenLayout } from './chain.mjs';
import { fetchIndexedTokens, fetchLaunchedTokens, discoverPools, discoverCurve, liveChains, tokenMeta } from './discovery.mjs';
import { quoteSell } from './quote.mjs';
import { findSameChain, findCrossChain, findLiquidation, findRoutes, fundableCapital, priceRelayFunding, selectDisjointRoutes } from './arb.mjs';
import { quoteNative, executeNative, supportedChains, resetRelayCache } from './relay.mjs';
import { nativePrices, toUsd, usdStr } from './prices.mjs';
import { helperFor, resetQuoteCache } from './quote.mjs';
import { deployHelper, executeAtomic, executeRoute, sellOnVenue, passesGuards } from './exec.mjs';
import { bridge } from './bridge.mjs';
import { ERC20_ABI } from './config.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};
const has = (n) => argv.includes(`--${n}`);
const eth = (v) => (v === null || v === undefined ? '—' : Number(formatEther(v)).toPrecision(6));

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

// ------------------------------------------------------------------ tokens

async function cmdTokens() {
  const indexed = await fetchIndexedTokens().catch((e) => { console.error(`  (index unavailable: ${e.message})`); return []; });
  console.log(`\nindexed by omnichain.family: ${indexed.length}`);
  for (const t of indexed) {
    console.log(`  ${t.address}  ${(t.symbol || '?').padEnd(8)} ${t.name || ''}`);
    console.log(`      ${t.tagline || ''}  · created ${t.createdAt || '?'} · site lists ${t.indexedChains.length} chain(s)`);
  }
  if (has('deep')) {
    const launched = await fetchLaunchedTokens();
    const extra = launched.filter((l) => !indexed.some((i) => i.address.toLowerCase() === l.address.toLowerCase()));
    console.log(`\nfrom launcher events but not yet in the site index: ${extra.length}`);
    for (const t of extra) console.log(`  ${t.address}  launched on chain ${t.launchChain} @ block ${t.blockNumber}`);
  }
}

// ------------------------------------------------------------------ venues

async function resolveToken() {
  const t = flag('token');
  if (t && t !== true) return getAddress(String(t));
  const list = await fetchIndexedTokens();
  if (!list.length) die('no --token given and the index is empty');
  console.log(`(no --token given; using ${list[0].symbol} ${list[0].address})`);
  return list[0].address;
}

async function gatherVenues(token, chains) {
  const byChain = new Map();
  await Promise.all(chains.map(async (c) => {
    try {
      const venues = await discoverPools(c, token);
      if (c.id === HOME_CHAIN) {
        const curve = await discoverCurve(token);
        if (curve) venues.push({ ...curve, viaOmniRouter: false, kind: 'curve' });
      }
      if (venues.length) byChain.set(c.id, { chain: c, venues });
    } catch { /* chain unreachable */ }
  }));
  return byChain;
}

async function cmdVenues() {
  const token = await resolveToken();
  const chains = allChains(flag('chain'));
  const live = await liveChains(token);
  console.log(`\ntoken ${token}`);
  console.log(`deployed on ${live.length} chain(s): ${live.map((id) => chainById(id)?.short ?? id).join(', ')}\n`);

  const byChain = await gatherVenues(token, chains);
  for (const c of chains) {
    const entry = byChain.get(c.id);
    if (!entry) { console.log(`${c.short.padEnd(5)} —  no initialised pool`); continue; }
    const meta = await tokenMeta(c, token).catch(() => ({ symbol: '?', totalSupply: null }));
    console.log(`${c.short.padEnd(5)} supply ${meta.totalSupply === null ? '?' : Number(formatUnits(meta.totalSupply, 18)).toLocaleString()}`);
    for (const v of entry.venues) {
      if (v.kind === 'curve') {
        console.log(`      curve        price ${eth(v.price)} native/token  (Base pad, pre-graduation)`);
        continue;
      }
      const via = v.viaOmniRouter ? 'omni router' : 'needs OmniArb helper';
      console.log(`      ${v.kind.padEnd(12)} tick ${String(v.tick).padStart(7)}  ${v.tokensPerNative.toExponential(4)} tok/native  liq ${v.liquidity}  (${via})`);
    }
  }
}

// ---------------------------------------------------------------- balances

async function cmdBalances() {
  const account = loadAccount();
  const token = (flag('token') && flag('token') !== true) ? getAddress(String(flag('token'))) : null;
  console.log(`\nwallet ${account.address}\n`);
  for (const c of allChains(flag('chain'))) {
    const pc = publicClient(c);
    const [nat, tok, gp] = await Promise.all([
      pc.getBalance({ address: account.address }).catch(() => null),
      token ? pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }).catch(() => null) : Promise.resolve(null),
      pc.getGasPrice().catch(() => null),
    ]);
    const helper = arbHelperFor(c);
    console.log(`  ${c.short.padEnd(5)} native ${(nat === null ? '?' : formatEther(nat)).padEnd(24)}` +
      `${token ? `token ${(tok === null ? '?' : Number(formatUnits(tok, 18)).toLocaleString()).padEnd(18)}` : ''}` +
      `gas ${gp === null ? '?' : (Number(gp) / 1e9).toFixed(3) + ' gwei'}${helper ? `  helper ${helper}` : ''}`);
  }
}

// -------------------------------------------------------------------- scan

async function scan() {
  const token = await resolveToken();
  const chains = allChains(flag('chain'));
  const cap = parseEther(String(flag('max', '1')));
  const minNet = parseEther(String(flag('min-net', '0')));

  console.log(`\nscanning ${token}`);
  console.log(`chains: ${chains.map((c) => c.short).join(', ')} · size cap ${formatEther(cap)} native · min net ${formatEther(minNet)}\n`);

  const byChain = await gatherVenues(token, chains);
  if (!byChain.size) die('no venues found on any requested chain');

  // Quoting depends on eth_call state overrides and on the token's storage layout.
  for (const [id, { chain }] of byChain) {
    const [ov, layout] = await Promise.all([supportsOverrides(chain), verifyTokenLayout(chain, token)]);
    if (!ov) console.log(`  ! ${chain.short}: RPC ignores state overrides — quotes here are unreliable (set RPC_${id})`);
    else if (!layout) console.log(`  ! ${chain.short}: token storage layout unrecognised — sell-side quotes may be wrong`);
  }

  const prices = await nativePrices();
  if (prices.missing.length) console.log(`  ! no USD price for ${prices.missing.join(', ')} — set PRICE_<SYMBOL>`);

  const all = [];
  for (const [, { chain, venues }] of byChain) {
    const found = await findSameChain(chain, token, venues, { cap, minNet });
    for (const o of found) o.netUsd = toUsd(prices, o.chainId, o.net);
    all.push(...found);
  }
  if (has('cross')) all.push(...await findCrossChain(token, byChain, { cap, minUsd: 0 }));

  // One ranking for every route shape, settled in USD.
  all.sort((a, b) => (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity));

  if (!all.length) { console.log('no opportunity clears gas right now.'); return { token, opps: [] }; }

  console.log(`${all.length} opportunit${all.length === 1 ? 'y' : 'ies'}:\n`);
  for (const o of all.slice(0, 12)) {
    const where = o.type === 'cross-chain' ? `${o.src.short} -> ${o.dst.short}` : o.chain.short;
    console.log(`  [${o.type}] ${where}   NET ${usdStr(o.netUsd)}`);
    console.log(`     ${o.buy.kind} -> ${o.sell.kind}`);
    if (o.type === 'cross-chain') {
      console.log(`     in ${eth(o.sizeIn)} ${o.src.nativeSymbol} (${usdStr(o.spentUsd)}) -> ${Number(formatUnits(o.tokens, 18)).toLocaleString()} tok` +
        ` -> ${eth(o.back)} ${o.dst.nativeSymbol} (${usdStr(o.gotUsd)})  gas ${usdStr(o.gasUsd)}`);
    } else {
      console.log(`     size ${eth(o.sizeIn)} ${o.chain.nativeSymbol}  gross ${eth(o.gross)}  gas ${eth(o.gas)}  net ${eth(o.net)}` +
        `  (${(Number(o.net) / Number(o.sizeIn) * 100).toFixed(2)}% on size)`);
    }
    if (o.note) console.log(`     note: ${o.note}`);
    if (o.type === 'same-chain-atomic' && !helperFor(o.chain).deployed) {
      console.log(`     needs: omniarb deploy --chain ${o.chain.short}`);
    }
    console.log('');
  }
  return { token, opps: all };
}

// ------------------------------------------------------------------ deploy

async function cmdDeploy() {
  const account = loadAccount();
  const chains = allChains(flag('chain'));
  if (!flag('chain')) die('pass --chain (e.g. --chain Pol)');
  for (const c of chains) {
    const existing = arbHelperFor(c);
    if (existing) { console.log(`${c.short}: already configured at ${existing} (ARB_${c.id})`); continue; }
    if (!has('live')) {
      console.log(`${c.short}: would deploy OmniArb from ${account.address} — re-run with --live to send`);
      continue;
    }
    console.log(`${c.short}: deploying...`);
    const r = await deployHelper(c, account);
    recordDeployment(c.id, r.address);
    console.log(`${c.short}: deployed at ${r.address} (gas ${r.gasUsed}) — saved to deployments.json`);
  }
}

// --------------------------------------------------------------------- run

async function cmdRun() {
  const { opps } = await scan();
  if (!opps.length) return;
  const account = loadAccount();
  const limits = {
    minNetWei: parseEther(String(flag('min-net', '0'))),
    maxSizeWei: parseEther(String(flag('max', '1'))),
    allowCrossChain: has('allow-cross'),
    allowTwoStep: has('allow-two-step'),
  };
  const live = has('live');
  console.log(live ? '*** LIVE — this will sign and send ***\n' : 'dry run (add --live to send)\n');

  for (const opp of opps) {
    const g = passesGuards(opp, limits);
    if (!g.ok) { console.log(`skip [${opp.type}] ${opp.chain?.short ?? ''}: ${g.reasons.join('; ')}`); continue; }
    if (opp.type !== 'same-chain-atomic') { console.log(`skip [${opp.type}]: only atomic same-chain trades are auto-executed`); continue; }
    try {
      const r = await executeAtomic(opp, account, { dryRun: !live });
      if (r.dryRun) {
        console.log(`would send ${r.fn} on ${r.chain}: size ${eth(r.sizeIn)}, sim gross ${eth(r.simulatedGross)}, net ${eth(r.net)}, on-chain floor ${eth(r.minProfitOnChain)}`);
      } else {
        console.log(`sent ${r.fn} on ${r.chain}: ${r.status} — ${r.explorer}`);
      }
      return;
    } catch (e) { console.log(`skip: ${e.message}`); }
  }
}

// ------------------------------------------------------------------ bridge

async function cmdBridge() {
  const account = loadAccount();
  const token = await resolveToken();
  const src = allChains(flag('from'))[0];
  const dst = allChains(flag('to'))[0];
  if (!src || !dst) die('pass --from and --to (e.g. --from Base --to Pol)');
  const amount = parseEther(String(flag('amount') ?? die('pass --amount')));
  if (!has('live')) {
    console.log(`would bridge ${formatEther(amount)} of ${token} from ${src.name} to ${dst.name} for ${account.address}`);
    console.log('re-run with --live to burn on the source and ask the relayer to mint');
    return;
  }
  console.log(`burning on ${src.name}...`);
  const r = await bridge({ src, dst, account, token, amount });
  console.log(`burned: ${src.explorer}/tx/${r.hash} (nonce ${r.nonce})`);
  console.log(r.arrived ? `minted on ${dst.name}` : `relayer accepted, mint not yet visible on ${dst.name}`);
}

// ------------------------------------------------------------------- route

/** One funded pass: discover venues, price every route the wallet can pay for. */
async function routePass({ token, chains, minUsd, capUsd, relay = false, quiet = false }) {
  resetQuoteCache();
  resetRelayCache();
  const account = loadAccount();
  const byChain = await gatherVenues(token, chains);
  if (!byChain.size) { if (!quiet) console.log('no venues found'); return { routes: [], account }; }
  const funds = await fundableCapital([...byChain.values()].map((v) => v.chain), account.address);

  if (!quiet) {
    const prices = await nativePrices();
    console.log('funding available:');
    let any = false;
    for (const [id, f] of funds) {
      if (f.usable === 0n) continue;
      any = true;
      console.log(`  ${chainById(id).short.padEnd(5)} ${formatEther(f.usable)} ${chainById(id).nativeSymbol}` +
        ` (${usdStr(toUsd(prices, id, f.usable))} usable of ${formatEther(f.balance)})`);
    }
    if (!any) console.log('  none — every chain is at or below its gas reserve');
    console.log('');
  }

  // With Relay wired in, capital is not pinned to the chain it happens to sit on:
  // every chain becomes a candidate entry, and the hop is priced afterwards.
  let mobileUsd = 0;
  if (relay) {
    const prices = await nativePrices();
    for (const [id, f] of funds) mobileUsd += toUsd(prices, id, f.usable) ?? 0;
    if (!quiet) console.log(`mobile capital over Relay: ${usdStr(mobileUsd)}\n`);
  }

  const concurrency = Number(flag('concurrency', String(Math.max(4, cpus().length * 4))));
  let routes = await findRoutes(token, byChain, funds, { minUsd, capUsd, mobileUsd, concurrency });
  if (relay) routes = await priceRelayFunding(routes, funds, account.address);
  return { routes, account, byChain };
}

function printRoutes(routes, limit = 10) {
  if (!routes.length) { console.log('no funded route clears gas right now.'); return; }
  console.log(`${routes.length} funded route${routes.length === 1 ? '' : 's'}:\n`);
  for (const r of routes.slice(0, limit)) {
    const hop = r.src.id === r.dst.id ? r.src.short : `${r.src.short} -> bridge -> ${r.dst.short}`;
    console.log(`  [${r.type}] ${hop}   NET ${usdStr(r.netUsd)}`);
    console.log(`     ${r.buy.kind} -> ${r.sell.kind}`);
    if (r.tokens) {
      console.log(`     ${eth(r.sizeIn)} ${r.src.nativeSymbol} (${usdStr(r.spentUsd)})` +
        ` -> ${Number(formatUnits(r.tokens, 18)).toLocaleString()} tok` +
        ` -> ${eth(r.back)} ${r.dst.nativeSymbol} (${usdStr(r.gotUsd)})   gas ${usdStr(r.gasUsd)}`);
    } else {
      console.log(`     ${eth(r.sizeIn)} ${r.src.nativeSymbol} in, atomic round trip   gas ${usdStr(r.gasUsd)}`);
    }
    if (r.funding === 'relay' && r.relay) {
      console.log(`     capital: ${eth(r.relay.quote.amountIn)} ${r.relay.from.nativeSymbol} from ${r.relay.from.short}` +
        ` --Relay--> ${eth(r.relay.quote.amountOut)} ${r.src.nativeSymbol} (${usdStr(r.relay.costUsd)}, ~${r.relay.seconds}s)`);
    } else {
      console.log(`     funded locally on ${r.fundedBy.chain}`);
    }
    console.log(`     ${r.note}`);
    if (r.atomic && !helperFor(r.chain).deployed) console.log(`     needs: omniarb deploy --chain ${r.chain.short} --live`);
    else if (!r.dstCanPayGas) {
      console.log(`     not takeable: no ${r.dst.nativeSymbol} on ${r.dst.short} to pay for the sell` +
        ` — fund it first ("omniarb move --to ${r.dst.short} --amount ..")`);
    } else if (!r.executable) {
      const where = r.buyNeedsHelper ? r.src.short : r.dst.short;
      console.log(`     not takeable yet: hookless leg needs "omniarb deploy --chain ${where} --live"`);
    }
    console.log('');
  }
}

async function cmdRoute() {
  const token = await resolveToken();
  const chains = allChains(flag('chain'));
  const minUsd = Number(flag('min-usd', '0'));
  const capUsd = flag('max-usd') ? Number(flag('max-usd')) : null;
  console.log(`\nrouting ${token}`);
  console.log(`chains: ${chains.map((c) => c.short).join(', ')}${capUsd ? ` · cap ${usdStr(capUsd)}/trade` : ''} · floor ${usdStr(minUsd)}\n`);
  const { routes } = await routePass({ token, chains, minUsd, capUsd, relay: has('relay') });
  printRoutes(routes, Number(flag('top', '10')));
}

// -------------------------------------------------------------------- sell

/** Sell a holding directly on one chain's best venue. */
async function cmdSell() {
  const account = loadAccount();
  const token = await resolveToken();
  const c = allChains(flag('chain'))[0];
  if (!c) die('pass --chain');
  const venues = await discoverPools(c, token);
  if (c.id === HOME_CHAIN) {
    const curve = await discoverCurve(token);
    if (curve) venues.push({ ...curve, viaOmniRouter: false, kind: 'curve' });
  }
  const usable = venues.filter((v) => v.kind === 'curve' || v.viaOmniRouter);
  if (!usable.length) die(`no directly sellable venue on ${c.name} (hookless pools need the OmniArb helper)`);

  const held = await publicClient(c).readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  const amount = flag('amount') ? parseEther(String(flag('amount'))) : held;
  if (amount > held) die(`holding only ${formatUnits(held, 18)} on ${c.name}`);

  console.log(`\nholding ${Number(formatUnits(held, 18)).toLocaleString()} on ${c.name}, selling ${Number(formatUnits(amount, 18)).toLocaleString()}\n`);

  let best = null;
  for (const v of usable) {
    const q = await quoteSell(c, token, v, amount);
    console.log(`  ${v.kind.padEnd(12)} -> ${q === null ? 'no quote' : `${eth(q)} ${c.nativeSymbol}`}`);
    if (q !== null && (!best || q > best.q)) best = { v, q };
  }
  if (!best) die('no venue quotes this size');
  console.log(`\nbest: ${best.v.kind} at ${eth(best.q)} ${c.nativeSymbol}`);

  if (!has('live')) { console.log('\ndry run — re-run with --live to send'); return; }
  const r = await sellOnVenue(c, account, token, best.v, amount);
  console.log(`sold: ${r.explorer}`);
  console.log(`received ${eth(r.received)} ${c.nativeSymbol} · gas ${eth(r.gasPaid)} · net ${eth(r.delta)} ${c.nativeSymbol}`);
}

// -------------------------------------------------------------------- fire

/** Execute the best route the router finds — atomic or not. */
async function cmdFire() {
  const token = await resolveToken();
  const chains = allChains(flag('chain'));
  const minUsd = Number(flag('min-usd', '0.25'));
  const capUsd = flag('max-usd') ? Number(flag('max-usd')) : null;
  const live = has('live');
  const wantAtomic = has('atomic');
  const wantBridged = has('bridged');

  console.log(`\nfiring on ${token}`);
  const { routes, account } = await routePass({ token, chains, minUsd, capUsd, relay: has('relay') });
  if (!routes.length) { console.log('nothing clears the floor right now.'); return; }

  const wanted = routes.filter((r) => {
    if (wantAtomic && !r.atomic) return false;
    if (wantBridged && r.atomic) return false;
    if (r.funding === 'relay') return false; // reposition with `move` first, deliberately
    // Hookless legs need the helper on that chain; atomic ones need it too.
    if (r.atomic) return helperFor(r.chain).deployed;
    return r.executable;
  });
  if (!wanted.length) { console.log('no route matches those filters.'); return; }

  printRoutes(wanted, 3);
  const pick = wanted[0];
  console.log(`taking: [${pick.type}] ${pick.src.short} -> ${pick.dst.short}  ${usdStr(pick.netUsd)}\n`);

  if (!live) { console.log('dry run — re-run with --live to send'); return; }

  if (pick.atomic) {
    const r = await executeAtomic({ ...pick, token, gas: 0n, net: 0n }, account, { dryRun: false });
    console.log(`sent ${r.fn} on ${r.chain}: ${r.status} — ${r.explorer}`);
    return;
  }
  const r = await executeRoute({ ...pick, token }, account, { dryRun: false, onStep: (m) => console.log(`  ${m}`) });
  console.log(`\ndone — ${r.legs.length} leg(s)`);
  for (const l of r.legs) console.log(`  ${l.leg}: ${l.explorer ?? l.hash ?? ''}`);
}

// -------------------------------------------------------------------- move

async function cmdMove() {
  const account = loadAccount();
  const from = allChains(flag('from'))[0];
  const to = allChains(flag('to'))[0];
  if (!from || !to) die('pass --from and --to (e.g. --from RH --to ETH)');
  const amount = parseEther(String(flag('amount') ?? die('pass --amount')));

  const supported = await supportedChains();
  if (!supported.has(from.id) || !supported.has(to.id)) die(`Relay does not route ${from.short} -> ${to.short}`);

  const q = await quoteNative({ from, to, amount, address: account.address });
  console.log(`\n${eth(q.amountIn)} ${from.nativeSymbol} on ${from.name} -> ${eth(q.amountOut)} ${to.nativeSymbol} on ${to.name}`);
  console.log(`cost ${usdStr(q.costUsd)} (${q.impactPct}%) · ~${q.timeEstimate}s · ${q.steps.length} step(s)`);

  if (!has('live')) { console.log('\ndry run — re-run with --live to send'); return; }
  console.log('\nsending...');
  const r = await executeNative({ from, to, quote: q, account });
  for (const s of r.sent) console.log(`  ${s.step}: ${from.explorer}/tx/${s.hash}`);
  console.log(r.filled ? `credited on ${to.name}` : `sent; not yet confirmed on ${to.name}`);
}

// ------------------------------------------------------------------- watch

async function cmdWatch() {
  const token = await resolveToken();
  const chains = allChains(flag('chain'));
  const interval = Number(flag('interval', '60')) * 1000;
  const minUsd = Number(flag('min-usd', '0.25'));
  const capUsd = flag('max-usd') ? Number(flag('max-usd')) : null;
  const live = has('live');
  const useRelay = has('relay');
  const atomicOnly = has('atomic');
  const maxFails = Number(flag('max-fails', '3'));
  const parallelTrades = Number(flag('parallel', '4'));

  console.log(`\nwatching ${token}`);
  console.log(`chains: ${chains.map((c) => c.short).join(', ')} · every ${interval / 1000}s · floor ${usdStr(minUsd)}` +
    `${capUsd ? ` · cap ${usdStr(capUsd)}/trade` : ''} · ${live ? '*** LIVE ***' : 'dry run'}`);
  console.log(`${atomicOnly ? 'atomic routes only' : 'atomic and bridged routes'}` +
    ` · up to ${parallelTrades} disjoint-chain trades at once\n`);

  let pass = 0;
  let fired = 0;
  let expectedUsd = 0;
  let fails = 0;
  let lastKey = null;

  for (;;) {
    pass += 1;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try {
      const { routes, account } = await routePass({ token, chains, minUsd, capUsd, relay: useRelay, quiet: true });
      // Relay-funded routes need a deliberate `move` first, so they are not
      // something the loop should take on its own.
      const usable = routes.filter((r) =>
        (atomicOnly ? r.atomic : true)
        && r.funding !== 'relay'          // needs a deliberate `move` first
        && (r.executable || (r.atomic && helperFor(r.chain).deployed)));
      const best = usable[0] ?? null;

      if (!best) {
        if (lastKey !== 'none') console.log(`${stamp}  pass ${pass}: nothing clears ${usdStr(minUsd)}`);
        lastKey = 'none';
      } else {
        const hop = best.src.id === best.dst.id ? best.src.short : `${best.src.short}->${best.dst.short}`;
        lastKey = `${best.type}:${hop}`;
        console.log(`${stamp}  pass ${pass}: ${usable.length} route(s), best ${usdStr(best.netUsd)} ` +
          `[${best.type}] ${hop} ${best.buy.kind}->${best.sell.kind}`);

        if (live) {
          // Fire every route that shares no chain with a better one, all at once.
          const batch = selectDisjointRoutes(usable, parallelTrades);
          if (batch.length > 1) {
            console.log(`${stamp}    firing ${batch.length} in parallel: ` +
              batch.map((r) => `${r.src.short}->${r.dst.short} ${usdStr(r.netUsd)}`).join(' | '));
          }

          const results = await Promise.allSettled(batch.map(async (r) => {
            const tag = `${r.src.short}->${r.dst.short}`;
            if (r.atomic) {
              const x = await executeAtomic({ ...r, token, gas: 0n, net: 0n }, account, { dryRun: false });
              console.log(`${stamp}    [${tag}] sent ${x.fn}: ${x.status} — ${x.explorer}`);
            } else {
              const x = await executeRoute({ ...r, token }, account,
                { dryRun: false, onStep: (m) => console.log(`${stamp}    [${tag}] ${m}`) });
              for (const l of x.legs) if (l.explorer) console.log(`${stamp}    [${tag}] ${l.leg}: ${l.explorer}`);
            }
            return r.netUsd;
          }));

          const won = results.filter((x) => x.status === 'fulfilled');
          for (const x of results) {
            if (x.status === 'rejected') {
              console.log(`${stamp}    failed: ${String(x.reason?.message ?? x.reason).split('\n')[0]}`);
            }
          }

          if (won.length) {
            fired += won.length;
            expectedUsd += won.reduce((a, x) => a + x.value, 0);
            fails = 0;
            console.log(`${stamp}    ${won.length}/${batch.length} filled · ${fired} total · running ${usdStr(expectedUsd)}`);
            // A fill moves the pools it touched, so this pass's numbers are stale
            // the moment it lands. Re-price rather than firing again on them.
            continue;
          }

          fails += 1;
          console.log(`${stamp}    nothing filled (${fails}/${maxFails})`);
          if (fails >= maxFails) {
            console.log(`${stamp}  stopping after ${fails} passes with no fill — check "bag" and "balances"`);
            return;
          }
        }
      }
    } catch (e) {
      console.log(`${stamp}  pass ${pass}: error — ${e.message.split('\n')[0]}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// --------------------------------------------------------------------- bag

async function cmdBag() {
  const account = loadAccount();
  const token = await resolveToken();
  const chains = allChains(flag('chain'));
  console.log(`\nwallet ${account.address}\ntoken  ${token}\n`);

  const byChain = await gatherVenues(token, chains);
  const holdings = new Map();
  for (const c of chains) {
    const bal = await publicClient(c).readContract({
      address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }).catch(() => null);
    if (bal && bal > 0n) holdings.set(c.id, bal);
  }
  if (!holdings.size) { console.log('holding none of this token anywhere.'); return; }

  for (const [id, amt] of holdings) {
    console.log(`  holding ${Number(formatUnits(amt, 18)).toLocaleString()} on ${chainById(id).name}`);
  }
  console.log('');

  const routes = await findLiquidation(token, byChain, holdings, { minUsd: 0 });
  if (!routes.length) { console.log('no venue will take this bag for more than gas.'); return; }

  console.log(`best exits (${routes.length} priced):\n`);
  for (const r of routes.slice(0, 8)) {
    console.log(`  [${r.type}] ${chainById(r.from).short} -> ${r.dst.short} · ${r.sell.kind}`);
    console.log(`     ${Number(formatUnits(r.amount, 18)).toLocaleString()} tok -> ${eth(r.back)} ${r.dst.nativeSymbol}` +
      `  gross ${usdStr(r.grossUsd)}  gas ${usdStr(r.gasUsd)}  NET ${usdStr(r.netUsd)}`);
    console.log(`     ${r.note}\n`);
  }
}

// -------------------------------------------------------------------- main

const commands = { tokens: cmdTokens, venues: cmdVenues, balances: cmdBalances, bag: cmdBag,
  route: cmdRoute, watch: cmdWatch, move: cmdMove, fire: cmdFire, sell: cmdSell, scan, deploy: cmdDeploy, run: cmdRun, bridge: cmdBridge };

if (!cmd || !commands[cmd] || has('help')) {
  console.log(`omniarb — arbitrage across omnichain.family

  tokens    [--deep]                       what has launched
  venues    --token 0x.. [--chain Pol]     every pool per CA per chain, with live price
  balances  [--token 0x..]                 wallet balances and gas prices
  bag       --token 0x..                   what your existing tokens are worth, and where to sell them
  route     --token 0x.. [--relay] [--max-usd 5] [--min-usd 0] [--concurrency N]
            funded routes: native you hold -> token -> bridge -> token -> native
            --relay also positions capital across chains through relay.link
  watch     --token 0x.. [--interval 60] [--parallel 4] [--relay] [--atomic] [--live]
            loop: fires every route that shares no chain with a better one, then re-prices
  move      --from RH --to ETH --amount 0.005 [--live]        move native between chains via Relay
  fire      --token 0x.. [--atomic|--bridged] [--live]        execute the best route end to end
  sell      --token 0x.. --chain Base [--amount N] [--live]    sell a holding on that chain's best venue
  scan      --token 0x.. [--max 1] [--min-net 0] [--cross]
  deploy    --chain Pol [--live]           deploy the OmniArb helper
  run       --token 0x.. [--live] [--max 1]
  bridge    --token 0x.. --from Base --to Pol --amount 1000 [--live]

Nothing sends a transaction unless you pass --live.
The wallet key is read from STACCOVERFLOW_KP and is never logged.`);
  const unknown = cmd && !cmd.startsWith('--') && !commands[cmd];
  if (unknown) console.error(`\nunknown command: ${cmd}`);
  process.exit(unknown ? 1 : 0);
}

commands[cmd]().catch((e) => { console.error(`\nerror: ${e.message}`); process.exit(1); });
