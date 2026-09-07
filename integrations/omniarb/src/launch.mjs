// Launching a token, the same way the site's own launch page does it.
//
// The flow is not a single transaction. What "launch" actually means here:
//
//   1. launch() on Base            creates the token + its bonding curve, and
//                                  mints the creator's allocation. Costs a flat
//                                  fee plus whatever the creator buys.
//   2. split the allocation by 9   every chain gets an equal slice of the
//                                  creator's post-launch balance — that slice is
//                                  what seeds the pools, so the creator funds
//                                  the liquidity out of their own supply.
//   3. move the slice to the relayer
//        - on Base: a plain transfer
//        - elsewhere: bridgeOut to the relayer, then ask it to mint
//   4. ask the relayer to "wall"   it opens BOTH the hooked and the hookless
//                                  v4 pool on that chain, single-sided, at the
//                                  Base curve's current price.
//
// Steps 3 and 4 repeat per chain and are individually resumable: each one is
// recorded before it is attempted, so a failure part-way leaves a record of
// exactly which chains still owe a mint or a wall.

import { keccak256, encodeAbiParameters, parseEther, formatEther, formatUnits, decodeEventLog } from 'viem';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { API, CHAINS, chainById, HOME_CHAIN, NATIVE, PORTAL, PORTAL_ABI, ERC20_ABI, PAD, PAD_ABI, OMNI_LAUNCHED_EVENT } from './config.mjs';
import { publicClient, walletClient } from './chain.mjs';

/** Flat fee the launcher charges, on top of the creator's own buy. */
export const LAUNCH_FEE_WEI = 200_000_000_000_000n; // 0.0002 ETH

/** Where the seeding float is sent — the relayer opens the pools from it. */
export const RELAYER = '0xdc5b2713231559bda139307e340a6d6308389548';

/** The launch page's default hook config: dynamic fee 0.3%–3%, nothing else on. */
export const DEFAULT_HOOK_PARAMS = {
  guardBlocks: 0, maxBuyBps: 0, snipeTaxPips: 0,
  baseFeePips: 3000, maxFeePips: 30000, surgeSens: 5,
  burnBps: 0, burnTriggerWei: 0n,
  lpBps: 0, potBps: 0, potEveryNBuys: 0, potMinBuyWei: 0n,
  buybackBps: 0, buybackDrawdownBps: 0, buybackCooldownBlocks: 0,
  buybackMinSpendWei: 0n, buybackMaxSpendWei: 0n,
};

export const LAUNCH_ABI = [{
  type: 'function', name: 'launch', stateMutability: 'payable',
  inputs: [{
    name: 'p', type: 'tuple', components: [
      { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' },
      { name: 'tagline', type: 'string' }, { name: 'logoURI', type: 'string' },
      { name: 'salt', type: 'bytes32' }, { name: 'intentId', type: 'bytes32' },
      { name: 'quoteToken', type: 'address' }, { name: 'targetRaiseWei', type: 'uint96' },
      { name: 'creatorBuyWei', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' },
      { name: 'blueprintId', type: 'uint32' },
      { name: 'custom', type: 'tuple', components: [
        { name: 'guardBlocks', type: 'uint32' }, { name: 'maxBuyBps', type: 'uint16' },
        { name: 'snipeTaxPips', type: 'uint24' }, { name: 'baseFeePips', type: 'uint24' },
        { name: 'maxFeePips', type: 'uint24' }, { name: 'surgeSens', type: 'uint16' },
        { name: 'burnBps', type: 'uint16' }, { name: 'burnTriggerWei', type: 'uint96' },
        { name: 'lpBps', type: 'uint16' }, { name: 'potBps', type: 'uint16' },
        { name: 'potEveryNBuys', type: 'uint32' }, { name: 'potMinBuyWei', type: 'uint96' },
        { name: 'buybackBps', type: 'uint16' }, { name: 'buybackDrawdownBps', type: 'uint16' },
        { name: 'buybackCooldownBlocks', type: 'uint32' }, { name: 'buybackMinSpendWei', type: 'uint96' },
        { name: 'buybackMaxSpendWei', type: 'uint96' }] },
      { name: 'creatorFeeBps', type: 'uint16' },
    ],
  }],
  outputs: [{ name: 'token', type: 'address' }, { name: 'initialBuyTokens', type: 'uint256' }],
}];

/** The launcher derives the CREATE2 salt from (caller, this), so it is just the ticker. */
export const saltFor = (symbol) =>
  keccak256(encodeAbiParameters([{ type: 'string' }], [symbol.toUpperCase()]));

const ZERO32 = `0x${'0'.repeat(64)}`;

// ------------------------------------------------------------------ metadata

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

/** Upload the logo and token metadata to the site's blob store. */
export async function uploadMetadata({ file, name, symbol, description, address = null, salt = null }) {
  const bytes = readFileSync(file);
  const ext = basename(file).split('.').pop().toLowerCase();
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: MIME[ext] ?? 'application/octet-stream' }), basename(file));
  form.set('name', name);
  form.set('symbol', symbol);
  form.set('description', description ?? '');
  if (address) form.set('address', address);
  if (salt) form.set('salt', salt);

  const r = await fetch(`${API}/api/metadata`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok && !body.logoURI) throw new Error(`metadata upload failed (${r.status}): ${JSON.stringify(body).slice(0, 200)}`);
  if (body.error && !body.logoURI) throw new Error(`metadata upload rejected: ${body.error}`);
  return body; // { logoURI, tokenlistURI, metadataURI? }
}

// -------------------------------------------------------------------- relay

async function relay(payload) {
  const r = await fetch(`${API}/api/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000),
  });
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Ask the relayer to open this chain's pools from the float it now holds.
 * It opens two: the hooked pool the site's router trades, and the hookless one
 * it cannot — which is the pair the whole arbitrage surface is built on.
 */
export async function wallChain({ chainId, token, sqrtPriceX96 = null }) {
  const payload = { action: 'wall', chainId: Number(chainId), token };
  if (sqrtPriceX96 != null) payload.sqrtPriceX96 = sqrtPriceX96.toString();
  const res = await relay(payload);
  const read = (v) => {
    if (!v || typeof v !== 'object') return null;
    if (typeof v.error === 'string' && v.error) return { ok: false, reason: v.error };
    if (typeof v.hash === 'string') return { ok: true, hash: v.hash };
    return null;
  };
  const hooked = read(res.data.hooked);
  const hookless = read(res.data.hookless);
  if (!hooked && !hookless) {
    const reason = res.data.error || `http ${res.status}`;
    return { hooked: { ok: res.ok, reason: res.ok ? '' : reason }, hookless: { ok: false, reason } };
  }
  return {
    hooked: hooked ?? { ok: false, reason: 'not reported by relay' },
    hookless: hookless ?? { ok: false, reason: 'not reported by relay' },
  };
}

/** The Base curve price, which every pool is opened at. */
export async function curveSqrtPrice(token) {
  const pc = publicClient(chainById(HOME_CHAIN));
  const price = await pc.readContract({ address: PAD, abi: PAD_ABI, functionName: 'currentCurvePrice', args: [token] })
    .catch(() => 0n);
  if (price === 0n) return null;
  // price is native-per-token in wei; sqrtPriceX96 = sqrt(tokensPerNative) << 96
  const tokensPerNative = (10n ** 36n) / price;      // scaled 1e18
  const scaled = tokensPerNative * (1n << 192n) / (10n ** 18n);
  return bigintSqrt(scaled);
}

function bigintSqrt(v) {
  if (v < 2n) return v;
  let x = v, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + v / x) / 2n; }
  return x;
}

// ------------------------------------------------------------------- launch

/** Create the token and its curve on Base. Returns the token address. */
export async function launchOnBase({ account, name, symbol, tagline, logoURI,
  targetRaiseEth = '0.06', creatorBuyEth = '0', dryRun = true }) {
  const c = chainById(HOME_CHAIN);
  if (!c.launcher) throw new Error('no launcher configured for the home chain');
  const pc = publicClient(c);

  const perChain = parseEther(String(creatorBuyEth)) / BigInt(CHAINS.length);
  const value = LAUNCH_FEE_WEI + perChain;

  const params = {
    name, symbol, tagline: tagline ?? '', logoURI,
    salt: saltFor(symbol), intentId: ZERO32,
    quoteToken: NATIVE,
    targetRaiseWei: parseEther(String(targetRaiseEth)),
    creatorBuyWei: perChain,
    minTokensOut: 0n,
    blueprintId: 0,
    custom: DEFAULT_HOOK_PARAMS,
    creatorFeeBps: 0,
  };

  const plan = { chain: c.name, launcher: c.launcher, value, params };
  if (dryRun) return { ...plan, dryRun: true, token: null };

  const wc = walletClient(c, account);
  const bal = await pc.getBalance({ address: account.address });
  if (bal < value) throw new Error(`need ${formatEther(value)} ETH on Base, have ${formatEther(bal)}`);

  const hash = await wc.writeContract({
    address: c.launcher, abi: LAUNCH_ABI, functionName: 'launch', args: [params], value });
  const rec = await pc.waitForTransactionReceipt({ hash });
  if (rec.status !== 'success') throw new Error(`launch reverted on Base (${hash})`);

  let token = null;
  for (const log of rec.logs) {
    try {
      const d = decodeEventLog({ abi: [OMNI_LAUNCHED_EVENT], data: log.data, topics: log.topics });
      if (d.eventName === 'OmniLaunched') { token = d.args.token; break; }
    } catch { /* not ours */ }
  }
  if (!token) throw new Error('launch succeeded but emitted no OmniLaunched event');
  return { ...plan, dryRun: false, hash, token, explorer: `${c.explorer}/tx/${hash}` };
}

/**
 * Seed one chain: get the float there, then have the relayer open both pools.
 * Base is the home chain and needs no bridge, just a transfer.
 */
export async function seedChain({ account, token, chain, amount, sqrtPriceX96, onStep = () => {} }) {
  const home = chainById(HOME_CHAIN);
  const pc = publicClient(home);
  const wc = walletClient(home, account);

  if (chain.id === HOME_CHAIN) {
    onStep(`transferring float to the relayer on ${chain.short}`);
    const hash = await wc.writeContract({
      address: token, abi: ERC20_ABI, functionName: 'transfer', args: [RELAYER, amount] });
    const rec = await pc.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error(`transfer reverted on ${chain.name}`);
  } else {
    onStep(`bridging float to ${chain.short}`);
    const hash = await wc.writeContract({
      address: PORTAL, abi: PORTAL_ABI, functionName: 'bridgeOut',
      args: [token, BigInt(chain.id), RELAYER, amount] });
    const rec = await pc.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error(`bridgeOut reverted for ${chain.name}`);

    let nonce = null;
    for (const log of rec.logs) {
      try {
        const d = decodeEventLog({ abi: PORTAL_ABI, data: log.data, topics: log.topics });
        if (d.eventName === 'BridgeOut') { nonce = d.args.nonce; break; }
      } catch { /* not ours */ }
    }
    if (nonce === null) throw new Error(`no BridgeOut event bridging to ${chain.name}`);

    onStep(`asking the relayer to mint on ${chain.short}`);
    const mint = await relay({
      action: 'bridgeIn', chainId: chain.id, srcChainId: HOME_CHAIN, token,
      sender: account.address, to: RELAYER, amount: amount.toString(),
      srcNonce: nonce.toString(), srcTxHash: hash,
    });
    // 409 means already processed, which is success for our purposes.
    if (!mint.ok && mint.status !== 409) {
      throw new Error(`relayer refused the mint on ${chain.name}: ${mint.data.error ?? mint.status}`);
    }
  }

  onStep(`opening pools on ${chain.short}`);
  return wallChain({ chainId: chain.id, token, sqrtPriceX96 });
}

/** Everything after the Base launch: split the float and seed all nine chains. */
export async function seedAll({ account, token, dryRun = true, onStep = () => {} }) {
  const home = chainById(HOME_CHAIN);
  const pc = publicClient(home);

  const held = await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  const perChain = held / BigInt(CHAINS.length);
  const sqrt = await curveSqrtPrice(token);

  const plan = { held, perChain, chains: CHAINS.length, sqrtPriceX96: sqrt };
  if (dryRun || perChain === 0n) return { ...plan, dryRun: true, results: [] };

  // Home chain first: its pools set the price the others are opened at.
  const order = [home, ...CHAINS.filter((c) => c.id !== HOME_CHAIN)];
  const results = [];
  for (const chain of order) {
    try {
      const r = await seedChain({ account, token, chain, amount: perChain, sqrtPriceX96: sqrt, onStep });
      results.push({ chain: chain.short, ...r });
      onStep(`  ${chain.short}: hooked ${r.hooked.ok ? 'ok' : r.hooked.reason}, hookless ${r.hookless.ok ? 'ok' : r.hookless.reason}`);
    } catch (e) {
      results.push({ chain: chain.short, error: e.message.split('\n')[0] });
      onStep(`  ${chain.short}: ${e.message.split('\n')[0]}`);
    }
  }
  return { ...plan, dryRun: false, results };
}
