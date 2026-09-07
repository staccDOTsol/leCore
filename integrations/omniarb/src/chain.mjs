// Client construction, wallet loading, and the state-override helpers that let
// the bot quote every venue without holding a single token.

import { createPublicClient, createWalletClient, http, fallback, defineChain,
  keccak256, encodeAbiParameters, toHex, pad, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, rpcFor, rpcsFor, TOKEN_BALANCE_SLOT, TOKEN_ALLOWANCE_SLOT, ERC20_ABI } from './config.mjs';

export const MAX_UINT = (1n << 256n) - 1n;
/** A burner used only inside eth_call simulations. Never signs anything. */
export const SIM_ACCOUNT = '0x000000000000000000000000000000000000dead';

const _pub = new Map();

export function viemChain(c) {
  return defineChain({
    id: c.id, name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: rpcsFor(c) } },
    blockExplorers: { default: { name: c.name, url: c.explorer } },
  });
}

/** Transport that fails over across a chain's endpoints instead of giving up. */
export function transportFor(c) {
  const urls = rpcsFor(c);
  const transports = urls.map((u) => http(u, { timeout: 30_000, retryCount: 2, retryDelay: 300 }));
  return transports.length === 1 ? transports[0] : fallback(transports, { rank: false, retryCount: 1 });
}

export function publicClient(c) {
  if (!_pub.has(c.id)) {
    _pub.set(c.id, createPublicClient({ chain: viemChain(c), transport: transportFor(c) }));
  }
  return _pub.get(c.id);
}

/**
 * Load the trading wallet from STACCOVERFLOW_KP.
 * The key is read here and nowhere else, and is never logged or sent anywhere.
 */
export function loadAccount() {
  const raw = process.env.STACCOVERFLOW_KP;
  if (!raw) throw new Error('STACCOVERFLOW_KP is not set — export it before running the bot');
  const k = raw.trim();
  const hex = k.startsWith('0x') ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('STACCOVERFLOW_KP is not a 32-byte hex private key');
  return privateKeyToAccount(hex);
}

/**
 * Wallet client whose sends carry an explicitly tracked nonce.
 *
 * Every write goes through `nextNonce`, and any failure resets the cached value
 * so the following attempt re-reads it from the chain rather than compounding a
 * bad guess. Wrapping the client means every send site gets this — there is no
 * way to forget it at one of them.
 */
export function walletClient(c, account) {
  const wc = createWalletClient({ account, chain: viemChain(c), transport: transportFor(c) });
  const withNonce = (fn) => async (args = {}) => {
    const nonce = args.nonce ?? await nextNonce(c, account.address);
    try {
      return await fn({ ...args, nonce });
    } catch (e) {
      resetNonce(c);
      throw e;
    }
  };
  return Object.assign(Object.create(wc), {
    writeContract: withNonce(wc.writeContract.bind(wc)),
    sendTransaction: withNonce(wc.sendTransaction.bind(wc)),
    deployContract: withNonce(wc.deployContract.bind(wc)),
  });
}

// ------------------------------------------------------- state overrides

export const balanceSlot = (owner) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, TOKEN_BALANCE_SLOT]));

export const allowanceSlot = (owner, spender) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }],
    [spender, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, TOKEN_ALLOWANCE_SLOT]))]));

/**
 * Overrides that hand SIM_ACCOUNT `nativeAmount` of gas token, plus (optionally)
 * a token balance and an unlimited allowance to `spender`, so a swap can be
 * simulated before the bot owns anything.
 */
export function simOverrides({ token, tokenAmount = 0n, spender = null,
  native = parseEther('10000'), account = SIM_ACCOUNT, extra = [] } = {}) {
  const ov = [{ address: account, balance: native }];
  if (token && (tokenAmount > 0n || spender)) {
    const diff = [];
    if (tokenAmount > 0n) diff.push({ slot: balanceSlot(account), value: pad(toHex(tokenAmount)) });
    if (spender) diff.push({ slot: allowanceSlot(account, spender), value: pad(toHex(MAX_UINT)) });
    ov.push({ address: token, stateDiff: diff });
  }
  return [...ov, ...extra];
}

/**
 * Confirm the token really uses the storage layout `simOverrides` assumes.
 * Quoting silently produces garbage if this is wrong, so callers check it once
 * per token per chain before trusting any simulated sell.
 */
export async function verifyTokenLayout(c, token) {
  const pc = publicClient(c);
  const probe = parseEther('123456');
  try {
    const got = await pc.readContract({
      address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [SIM_ACCOUNT],
      stateOverride: [{ address: token, stateDiff: [{ slot: balanceSlot(SIM_ACCOUNT), value: pad(toHex(probe)) }] }],
    });
    return got === probe;
  } catch { return false; }
}

/** True when the RPC honours eth_call state overrides (needed for all quoting). */
export async function supportsOverrides(c) {
  const pc = publicClient(c);
  const probe = '0x000000000000000000000000000000000000c0de';
  try {
    const r = await pc.call({ to: probe, data: '0x',
      stateOverride: [{ address: probe, code: '0x4760005260206000f3', balance: 777n }] });
    return BigInt(r.data || '0x0') === 777n;
  } catch { return false; }
}

// ------------------------------------------------------------ nonce tracking
//
// Letting viem fetch the nonce per transaction breaks under a failover
// transport: consecutive sends can read eth_getTransactionCount from nodes at
// different heights, so a send lands with a nonce the chain has already used.
// That surfaces as "nonce too low" at best and an opaque "Missing or invalid
// parameters" at worst — which is what silently dropped five of eight sells in
// a bulk liquidation.
//
// So the nonce is tracked here: read once per chain, then handed out in order
// and advanced locally.

const _nonce = new Map();

/** Next nonce for this chain, reserved and advanced locally. */
export async function nextNonce(c, address) {
  if (!_nonce.has(c.id)) {
    const n = await publicClient(c).getTransactionCount({ address, blockTag: 'pending' });
    _nonce.set(c.id, n);
  }
  const n = _nonce.get(c.id);
  _nonce.set(c.id, n + 1);
  return n;
}

/** Drop the cached nonce so the next send re-reads it from the chain. */
export function resetNonce(c) { _nonce.delete(c.id); }

export const deadline = (secs = 600) => BigInt(Math.floor(Date.now() / 1000) + secs);

export async function gasPriceOf(c) {
  try { return await publicClient(c).getGasPrice(); } catch { return null; }
}

export function allChains(filter) {
  if (!filter) return CHAINS;
  const want = String(filter).split(',').map((s) => s.trim().toLowerCase());
  return CHAINS.filter((c) =>
    want.includes(String(c.id)) || want.includes(c.short.toLowerCase()) || want.includes(c.name.toLowerCase()));
}
