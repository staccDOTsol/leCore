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
import { findSameChain, findCrossChain, findLiquidation, findRoutes, fundableCapital, priceRelayFunding, selectDisjointRoutes, mapPool, numToWei } from './arb.mjs';
import { quoteNative, executeNative, supportedChains, resetRelayCache } from './relay.mjs';
import { nativePrices, toUsd, usdStr } from './prices.mjs';
import { helperFor, resetQuoteCache } from './quote.mjs';
import { deployHelper, executeAtomic, executeRoute, sellOnVenue, passesGuards } from './exec.mjs';
import { bridge, pendingMints, clearPendingMint, findUnmintedBurns, retryMint, mintProcessed, relayerCanMint } from './bridge.mjs';
import { fetchLiveConfig, writeLiveConfig, diffAgainst } from './refresh.mjs';
import { uploadMetadata, launchOnBase, seedAll, saltFor, recoverMeta, wallChain, RELAYER, LAUNCH_FEE_WEI } from './launch.mjs';
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

/**
 * Which tokens to work on: --token narrows to one (or a comma-separated set),
 * otherwise everything omnichain.family has indexed plus anything the launchers
 * have emitted that the site's index has not caught up to yet.
 */
async function resolveTokens() {
  const t = flag('token');
  if (t && t !== true) return String(t).split(',').map((x) => getAddress(x.trim()));
  const [indexed, launched] = await Promise.all([
    fetchIndexedTokens().catch(() => []),
    has('deep') ? fetchLaunchedTokens().catch(() => []) : Promise.resolve([]),
  ]);
  await learnSymbols(indexed);
  const seen = new Map();
  for (const x of [...indexed, ...launched]) seen.set(x.address.toLowerCase(), x.address);
  if (!seen.size) die('no tokens found — pass --token');
  return [...seen.values()];
}

/** Symbols for the tokens in play, so multi-token output stays readable. */
const _symbols = new Map();
export const symbolOf = (addr) => _symbols.get(addr.toLowerCase()) ?? '?';
async function learnSymbols(list) {
  for (const t of list) {
    if (t.symbol) _symbols.set(t.address.toLowerCase(), t.symbol);
  }
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
async function routePass({ tokens, chains, minUsd, capUsd, relay = false, quiet = false,
  concurrency = Number(flag('concurrency', String(Math.max(4, cpus().length * 4)))) }) {
  resetQuoteCache();
  resetRelayCache();
  const account = loadAccount();

  // Discover venues for every token at once. Each token is an independent set of
  // pools, so this fans out cleanly.
  const discovered = (await mapPool(tokens,
    async (t) => ({ token: t, byChain: await gatherVenues(t, chains) }),
    Math.max(2, Math.floor(concurrency / 4)))).filter((d) => d && d.byChain.size);

  if (!discovered.length) { if (!quiet) console.log('no venues found for any token'); return { routes: [], account }; }

  // One wallet funds all of them, so capital is measured once per chain.
  const funds = await fundableCapital(chains, account.address);

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

  let routes = [];
  for (const d of discovered) {
    const found = await findRoutes(d.token, d.byChain, funds, { minUsd, capUsd, mobileUsd, concurrency });
    routes.push(...found);
  }
  // Rank across every token together — the best trade is the best trade.
  routes.sort((a, b) => b.netUsd - a.netUsd);
  if (relay) routes = await priceRelayFunding(routes, funds, account.address);
  return { routes, account, discovered };
}

function printRoutes(routes, limit = 10) {
  if (!routes.length) { console.log('no funded route clears gas right now.'); return; }
  console.log(`${routes.length} funded route${routes.length === 1 ? '' : 's'}:\n`);
  for (const r of routes.slice(0, limit)) {
    const hop = r.src.id === r.dst.id ? r.src.short : `${r.src.short} -> bridge -> ${r.dst.short}`;
    console.log(`  [${r.type}] ${hop}   NET ${usdStr(r.netUsd)}   ${symbolOf(r.token)} ${r.token.slice(0, 10)}…`);
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
    else if (!r.mintable) {
      console.log(`     not takeable: omnichain's relayer is out of gas on ${r.dst.short}` +
        ` — bridging there would burn the tokens with no mint`);
    } else if (!r.dstCanPayGas) {
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
  const tokens = await resolveTokens();
  const chains = allChains(flag('chain'));
  const minUsd = Number(flag('min-usd', '0'));
  const capUsd = flag('max-usd') ? Number(flag('max-usd')) : null;
  console.log(`\nrouting ${tokens.length} token${tokens.length === 1 ? '' : 's'} over ${chains.length} chains`);
  console.log(`${chains.map((c) => c.short).join(', ')}${capUsd ? ` · cap ${usdStr(capUsd)}/trade` : ''} · floor ${usdStr(minUsd)}\n`);
  const { routes } = await routePass({ tokens, chains, minUsd, capUsd, relay: has('relay') });
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

/** Execute the best route the router finds — atomic or not, any indexed token. */
async function cmdFire() {
  const tokens = await resolveTokens();
  const chains = allChains(flag('chain'));
  const minUsd = Number(flag('min-usd', '0.25'));
  const capUsd = flag('max-usd') ? Number(flag('max-usd')) : null;
  const live = has('live');
  const wantAtomic = has('atomic');
  const wantBridged = has('bridged');

  console.log(`\nfiring across ${tokens.length} token(s)`);
  const { routes, account } = await routePass({ tokens, chains, minUsd, capUsd, relay: has('relay') });
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
    const r = await executeAtomic({ ...pick, gas: 0n, net: 0n }, account, { dryRun: false });
    console.log(`sent ${r.fn} on ${r.chain}: ${r.status} — ${r.explorer}`);
    return;
  }
  const r = await executeRoute(pick, account, { dryRun: false, onStep: (m) => console.log(`  ${m}`) });
  console.log(`\ndone — ${r.legs.length} leg(s)`);
  for (const l of r.legs) console.log(`  ${l.leg}: ${l.explorer ?? l.hash ?? ''}`);
}

// ------------------------------------------------------------------- mints

/** Burns whose mint never landed: list, recover from chain, and retry. */
async function cmdMints() {
  const account = loadAccount();
  const token = await resolveToken();
  let claims = pendingMints();
  console.log(`\n${claims.length} pending mint(s) on record`);

  if (has('recover')) {
    // Trust the chain over the local file — a loop that died mid-route never
    // got to write anything down.
    const chains = allChains(flag('chain'));
    console.log('scanning for burns the destination never processed...');
    for (const src of chains) {
      for (const dst of chains) {
        if (src.id === dst.id) continue;
        const found = await findUnmintedBurns({ src, dst, address: account.address }).catch(() => []);
        for (const f of found) {
          if (claims.some((c) => c.srcTxHash === f.srcTxHash && c.srcNonce === f.srcNonce)) continue;
          claims.push(f);
          console.log(`  found ${formatUnits(BigInt(f.amount), 18)} burned ${src.short} -> ${dst.short} (${f.srcTxHash.slice(0, 12)}…)`);
        }
      }
    }
  }

  if (!claims.length) { console.log('nothing owed.'); return; }

  for (const c of claims) {
    const src = chainById(c.srcChainId); const dst = chainById(c.dstChainId);
    const done = c.messageId ? await mintProcessed(dst, c.messageId) : false;
    console.log(`\n  ${formatUnits(BigInt(c.amount), 18)} ${src.short} -> ${dst.short}` +
      `  nonce ${c.srcNonce}  ${done ? 'ALREADY MINTED' : 'unminted'}`);
    console.log(`    burn: ${src.explorer}/tx/${c.srcTxHash}`);
    if (done) { clearPendingMint(c); continue; }
    if (!has('retry')) continue;
    try {
      await retryMint(c);
      console.log('    relayer accepted — mint requested');
      clearPendingMint(c);
    } catch (e) {
      console.log(`    still refused: ${e.message.split('\n')[0].slice(0, 140)}`);
    }
  }
  if (!has('retry')) console.log('\nre-run with --retry to ask the relayer again');
}

// ----------------------------------------------------------------- refresh

/** Re-scrape the deployed app's contract map. Their addresses move. */
async function cmdRefresh() {
  const cfg = await fetchLiveConfig();
  const diff = diffAgainst(CHAINS, cfg);
  console.log(`\nlive build ${cfg.deployment ?? '?'} (${cfg.chunk})`);
  console.log(`factory ${cfg.factory}\nportal  ${cfg.portal}\nlauncher ${cfg.launcher}`);
  if (!diff.length) console.log('\nnothing changed — built-ins already match the live app');
  else {
    console.log(`\n${diff.length} address(es) moved since the built-in map:`);
    for (const r of diff) console.log(`  ${r.chain.padEnd(5)} ${r.field.padEnd(12)} ${r.from} -> ${r.to}`);
  }
  writeLiveConfig(cfg);
  console.log('\nsaved to live-config.json — every command now uses these');
}

// ----------------------------------------------------------- fund-relayer

/**
 * Top up omnichain's relayer on chains where it cannot afford to open pools.
 *
 * The relayer pays for the mint and for both pool-opening transactions out of
 * its own wallet. When it is short, a launch's float arrives on the chain and
 * simply sits there — the supply is already the relayer's, so the only way to
 * get pools out of it is for that wallet to be able to transact.
 *
 * This sends to a third party's address. It is opt-in, per chain, capped, and
 * always shows the plan before moving anything.
 */
async function cmdFundRelayer() {
  const account = loadAccount();
  const from = allChains(flag('from', 'Base'))[0];
  if (!from) die('pass a valid --from chain');
  const buffer = Number(flag('buffer', '1.4'));
  const capUsd = Number(flag('max-usd', '15'));
  const live = has('live');
  const prices = await nativePrices();

  const targets = allChains(flag('chains', 'Arb,BNB,Wld,Lin'));
  console.log(`\nfunding relayer ${RELAYER}`);
  console.log(`from ${from.name} · ${buffer}x the shortfall · cap ${usdStr(capUsd)} total\n`);

  // Ask the relayer what it is actually short of, rather than guessing from
  // gas price. Its own refusal carries the number — "has N wei, needs ~M wei;
  // send K more" — and that figure is far larger than gas x price, so an
  // estimate here funds it to a level that still cannot open a pool.
  const token = (flag('token') && flag('token') !== true) ? getAddress(String(flag('token'))) : null;
  const askRelayer = async (c) => {
    if (!token) return null;
    const r = await wallChain({ chainId: c.id, token }).catch(() => null);
    const text = `${r?.hooked?.reason ?? ''} ${r?.hookless?.reason ?? ''}`;
    const m = text.match(/send\s+(\d+)\s+more/);
    return m ? BigInt(m[1]) : null;
  };

  const plan = [];
  let totalUsd = 0;
  for (const c of targets) {
    const st = await relayerCanMint(c, { gasUnits: 2_000_000n });
    if (st.balance === null) { console.log(`  ${c.short.padEnd(5)} unreadable, skipping`); continue; }

    const reported = await askRelayer(c);
    const short = reported ?? (st.needed > st.balance ? st.needed - st.balance : 0n);
    if (short === 0n) { console.log(`  ${c.short.padEnd(5)} already funded (${formatEther(st.balance)} ${c.nativeSymbol})`); continue; }
    const send = (short * BigInt(Math.round(buffer * 100))) / 100n;
    const usd = toUsd(prices, c.id, send) ?? 0;
    totalUsd += usd;
    plan.push({ chain: c, send, usd, have: st.balance, need: st.needed });
    console.log(`  ${c.short.padEnd(5)} has ${formatEther(st.balance).padEnd(22)} short ${formatEther(short).padEnd(22)} send ${formatEther(send)} ${c.nativeSymbol} (${usdStr(usd)})${reported ? '  [relayer-reported]' : '  [estimated]'}`);
  }

  if (!plan.length) { console.log('\nnothing to fund.'); return; }
  console.log(`\ntotal ${usdStr(totalUsd)}`);
  if (totalUsd > capUsd) die(`plan costs ${usdStr(totalUsd)}, above the ${usdStr(capUsd)} cap — raise --max-usd to proceed`);
  if (!live) { console.log('\ndry run — re-run with --live to send'); return; }

  for (const p of plan) {
    try {
      // The shortfall is denominated in the DESTINATION chain's asset, but Relay
      // is given an amount in the ORIGIN's. On a cross-asset hop those are not
      // the same number — sending a BNB-denominated figure as ETH overfunds by
      // the price ratio — so convert before quoting.
      const pxFrom = prices.byChain.get(from.id)?.usd;
      const pxTo = prices.byChain.get(p.chain.id)?.usd;
      if (!pxFrom || !pxTo) throw new Error('no price to convert the hop amount with');
      const amountIn = pxFrom === pxTo
        ? p.send
        : numToWei((Number(formatEther(p.send)) * pxTo) / pxFrom);

      const q = await quoteNative({ from, to: p.chain, amount: amountIn, address: account.address, recipient: RELAYER });
      console.log(`\n${p.chain.short}: ${eth(q.amountIn)} ${from.nativeSymbol} -> ${eth(q.amountOut)} ${p.chain.nativeSymbol} (fee ${usdStr(q.costUsd)}, ~${q.timeEstimate}s)`);
      const r = await executeNative({ from, to: p.chain, quote: q, account, wait: false });
      for (const s of r.sent) console.log(`  ${s.step}: ${from.explorer}/tx/${s.hash}`);
    } catch (e) {
      console.log(`\n${p.chain.short}: ${e.message.split('\n')[0].slice(0, 160)}`);
    }
  }
  console.log('\nsent. give the relayer a minute, then re-run the seed:');
  console.log(`  omniarb launch --seed-only --token <CA> --live`);
}

// ------------------------------------------------------------------ launch

/**
 * Launch a token: upload art + metadata, create it on Base, then seed all nine
 * chains. `--seed-only` resumes the seeding for a token that already exists.
 */
async function cmdLaunch() {
  const account = loadAccount();
  const name = flag('name');
  const symbol = flag('symbol');
  const image = flag('image');
  const tagline = flag('tagline', '') === true ? '' : String(flag('tagline', ''));
  const live = has('live');

  if (has('seed-only')) {
    const token = getAddress(String(flag('token') ?? die('pass --token with --seed-only')));
    // A resumed seed still needs metadata: chains missing the token have to be
    // deployed before anything can be bridged to them.
    const meta = await recoverMeta(token);
    if (meta && flag('logo') && flag('logo') !== true) meta.logoURI = String(flag('logo'));
    console.log(`\nseeding ${token} across ${CHAINS.length} chains`);
    if (meta) console.log(`  ${meta.name} (${meta.symbol})${meta.logoURI ? '' : ' — no logo found; pass --logo for chains needing a deploy'}\n`);
    else console.log('  could not recover metadata — chains without the token cannot be deployed\n');
    const r = await seedAll({ account, token, meta, dryRun: !live, onStep: (m) => console.log(`  ${m}`) });
    console.log(`\nfloat: ${formatUnits(r.held, 18)} held, ${formatUnits(r.perChain, 18)} per chain`);
    if (r.dryRun) console.log('dry run — re-run with --live');
    return;
  }

  if (!name || name === true || !symbol || symbol === true) die('pass --name and --symbol');
  if (!image || image === true) die('pass --image <path to png/jpg/svg>');

  console.log(`\nlaunching ${name} (${symbol})`);
  console.log(`creator ${account.address}\n`);

  console.log('uploading art + metadata…');
  const meta = await uploadMetadata({
    file: String(image), name: String(name), symbol: String(symbol),
    description: tagline, salt: saltFor(String(symbol)),
  });
  console.log(`  logo ${meta.logoURI}`);

  const opts = {
    account, name: String(name), symbol: String(symbol), tagline,
    logoURI: meta.logoURI,
    targetRaiseEth: String(flag('target', '0.06')),
    creatorBuyEth: String(flag('buy', '0.018')),
    dryRun: !live,
  };
  const p = await launchOnBase({ ...opts, dryRun: true });
  console.log(`\nlaunch on ${p.chain} via ${p.launcher}`);
  console.log(`  value ${eth(p.value)} ETH = ${eth(LAUNCH_FEE_WEI)} fee + ${eth(p.params.creatorBuyWei)} creator buy`);
  console.log(`  target raise ${eth(p.params.targetRaiseWei)} ETH · salt ${p.params.salt.slice(0, 18)}…`);
  console.log(`  the creator buy is what funds the pool seeding — a zero buy leaves no float and opens no pools`);

  if (!live) { console.log('\ndry run — re-run with --live to launch'); return; }

  const r = await launchOnBase(opts);
  console.log(`\nlaunched: ${r.token}`);
  console.log(`  ${r.explorer}`);

  // Re-key the metadata to the real CA now that it is known.
  await uploadMetadata({
    file: String(image), name: String(name), symbol: String(symbol),
    description: tagline, address: r.token, salt: p.params.salt,
  }).catch((e) => console.log(`  (metadata re-key failed: ${e.message.slice(0, 90)})`));

  console.log('\nseeding all chains…');
  const s = await seedAll({ account, token: r.token, dryRun: false, onStep: (m) => console.log(`  ${m}`) });
  console.log(`\nfloat ${formatUnits(s.perChain, 18)} per chain`);
  const ok = s.results.filter((x) => x.hooked?.ok && x.hookless?.ok).map((x) => x.chain);
  console.log(`both pools open on: ${ok.length ? ok.join(', ') : 'none yet'}`);
  console.log(`resume any stragglers with: omniarb launch --seed-only --token ${r.token} --live`);
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
  const tokens = await resolveTokens();
  const chains = allChains(flag('chain'));
  const interval = Number(flag('interval', '60')) * 1000;
  const minUsd = Number(flag('min-usd', '0.25'));
  const capUsd = flag('max-usd') ? Number(flag('max-usd')) : null;
  const live = has('live');
  const useRelay = has('relay');
  const atomicOnly = has('atomic');
  const maxFails = Number(flag('max-fails', '3'));
  const parallelTrades = Number(flag('parallel', '4'));

  console.log(`\nwatching ${tokens.length} token(s) — rescanned every pass, so a fresh launch is picked up on its own`);
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
      const { routes, account } = await routePass({ tokens, chains, minUsd, capUsd, relay: useRelay, quiet: true });
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
              const x = await executeAtomic({ ...r, gas: 0n, net: 0n }, account, { dryRun: false });
              console.log(`${stamp}    [${tag}] sent ${x.fn}: ${x.status} — ${x.explorer}`);
            } else {
              const x = await executeRoute(r, account,
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
  const tokens = await resolveTokens();
  const chains = allChains(flag('chain'));
  console.log(`\nwallet ${account.address}\nchecking ${tokens.length} token(s) across ${chains.length} chains\n`);

  // Find every token this wallet actually holds, anywhere, before pricing exits.
  const held = await mapPool(tokens, async (token) => {
    const holdings = new Map();
    await Promise.all(chains.map(async (c) => {
      const bal = await publicClient(c).readContract({
        address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }).catch(() => null);
      if (bal && bal > 0n) holdings.set(c.id, bal);
    }));
    return holdings.size ? { token, holdings } : null;
  }, 6);

  const positions = held.filter(Boolean);
  if (!positions.length) { console.log('holding none of these tokens anywhere.'); return; }

  for (const p of positions) {
    const where = [...p.holdings.entries()]
      .map(([id, amt]) => `${Number(formatUnits(amt, 18)).toLocaleString()} on ${chainById(id).short}`).join(', ');
    console.log(`  ${symbolOf(p.token).padEnd(10)} ${p.token.slice(0, 10)}…  ${where}`);
  }
  console.log('');

  const all = [];
  for (const p of positions) {
    const byChain = await gatherVenues(p.token, chains);
    if (!byChain.size) continue;
    const routes = await findLiquidation(p.token, byChain, p.holdings, { minUsd: 0 });
    all.push(...routes);
  }
  if (!all.length) { console.log('no venue will take any of these bags for more than gas.'); return; }

  all.sort((a, b) => b.netUsd - a.netUsd);
  console.log(`best exits (${all.length} priced, ranked across every token):\n`);
  for (const r of all.slice(0, Number(flag('top', '10')))) {
    console.log(`  [${r.type}] ${symbolOf(r.token)} ${chainById(r.from).short} -> ${r.dst.short} · ${r.sell.kind}`);
    console.log(`     ${Number(formatUnits(r.amount, 18)).toLocaleString()} tok -> ${eth(r.back)} ${r.dst.nativeSymbol}` +
      `  gross ${usdStr(r.grossUsd)}  gas ${usdStr(r.gasUsd)}  NET ${usdStr(r.netUsd)}`);
    console.log(`     ${r.note}\n`);
  }

  // ------------------------------------------------------------- liquidate
  //
  // One exit per (token, chain) position: the best venue for that specific bag.
  // Bridged exits are excluded unless asked for — they depend on the relayer
  // minting, and a bulk liquidation should not hand a dozen positions to a
  // third party that might be out of gas.
  const allowBridged = has('bridged');
  const best = new Map();
  for (const r of all) {
    if (!allowBridged && r.type !== 'liquidate-local') continue;
    const key = `${r.token.toLowerCase()}:${r.from}`;
    if (!best.has(key) || best.get(key).netUsd < r.netUsd) best.set(key, r);
  }
  const plan = [...best.values()]
    .filter((r) => r.netUsd >= Number(flag('min-usd', '0.01')))
    .sort((a, b) => b.netUsd - a.netUsd);

  if (!plan.length) { console.log('nothing clears the floor to liquidate.'); return; }

  const totalUsd = plan.reduce((a, r) => a + r.netUsd, 0);
  console.log(`\nliquidation plan: ${plan.length} position(s), ${usdStr(totalUsd)} total\n`);
  for (const r of plan) {
    console.log(`  ${symbolOf(r.token).padEnd(11)} ${chainById(r.from).short.padEnd(5)} ${r.sell.kind.padEnd(12)}` +
      ` ${Number(formatUnits(r.amount, 18)).toLocaleString().padStart(16)} tok -> ${usdStr(r.netUsd)}`);
  }

  if (!has('live')) { console.log('\ndry run — re-run with --live to sell'); return; }

  // Biggest first: each sell tops the wallet's gas back up for the next one,
  // which matters when the balance is too thin to cover them all up front.
  console.log('');
  let done = 0; let got = 0;
  for (const r of plan) {
    const c = chainById(r.from);
    const tag = `${symbolOf(r.token)} on ${c.short}`;
    try {
      const x = await sellOnVenue(c, account, r.token, r.sell, r.amount);
      done += 1; got += r.netUsd;
      console.log(`  sold ${tag}: ${eth(x.received)} ${c.nativeSymbol} — ${x.explorer}`);
    } catch (e) {
      console.log(`  skipped ${tag}: ${e.message.split('\n')[0].slice(0, 130)}`);
    }
  }
  console.log(`\n${done}/${plan.length} liquidated · ~${usdStr(got)} expected`);
}

// -------------------------------------------------------------------- main

const commands = { tokens: cmdTokens, venues: cmdVenues, balances: cmdBalances, bag: cmdBag,
  route: cmdRoute, watch: cmdWatch, move: cmdMove, fire: cmdFire, sell: cmdSell, mints: cmdMints,
  refresh: cmdRefresh, launch: cmdLaunch, 'fund-relayer': cmdFundRelayer, scan, deploy: cmdDeploy, run: cmdRun, bridge: cmdBridge };

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
  mints     --token 0x.. [--recover] [--retry]                 burns whose mint never landed
  refresh                                                      re-scrape the live contract map (their routers move)
  launch    --name "x" --symbol X --image a.png [--buy 0.018] [--target 0.06] [--live]
            upload art, create on Base, seed hooked+hookless pools on all 9 chains
  launch    --seed-only --token 0x.. [--logo URL] [--live]      resume seeding an existing token
  fund-relayer [--chains Arb,BNB,Wld,Lin] [--buffer 1.4] [--max-usd 15] [--live]
            top up omnichain's relayer where it cannot afford to open pools

Nothing sends a transaction unless you pass --live.
The wallet key is read from STACCOVERFLOW_KP and is never logged.`);
  const unknown = cmd && !cmd.startsWith('--') && !commands[cmd];
  if (unknown) console.error(`\nunknown command: ${cmd}`);
  process.exit(unknown ? 1 : 0);
}

commands[cmd]().catch((e) => { console.error(`\nerror: ${e.message}`); process.exit(1); });
