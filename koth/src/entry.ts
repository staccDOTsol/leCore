/**
 * The entry flow: how "send X of your token" becomes a locked play in the vault.
 *
 * By directive:
 *   - no hosted wallets: every attempt gets a ONE-TIME throwaway deposit address whose key lives
 *     only until the deposit is swept, then is deleted
 *   - the quote is the play stake (0.05 SOL worth, x1.01 per takeover) PLUS an inference estimate,
 *     both marked up 5%, denominated in the player's own token
 *   - the people never see LP: after the deposit lands the operator sweeps it, converts the
 *     inference share to TOKEN (or USDC / LEOS) for the openzoo wallet, swaps half of the stake
 *     to the master token on Jupiter, creates the Raydium CPMM pool for <token>/MASTER if it does
 *     not exist yet (else deposits into it), and locks the LP in the koth-play program
 *
 * Settlement is idempotent per quote: every step records what it did, so a crash mid-way can be
 * resumed with `settle(quoteId)` again without double-spending.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BN from 'bn.js';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync, getMint,
} from '@solana/spl-token';
import {
  CREATE_CPMM_POOL_FEE_ACC, CREATE_CPMM_POOL_PROGRAM, Percent, Raydium, TxVersion, getCpmmPdaPoolId, type ApiCpmmConfigInfo,
} from '@raydium-io/raydium-sdk-v2';
import { NATIVE_SOL_MINT, ZOO_TOKEN_MINT } from './dbc.js';
import { PUSH_BPS, bps } from './dividends.js';
import type { EntryLike } from './hill.js';
import { awardIx, createVaultLpAtaIx, decodePoolState, findCpmmPoolsWithMaster, playIx, vaultPda } from './play.js';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export { ZOO_TOKEN_MINT };
export const LEOS_MINT = new PublicKey('5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e');

export const QUOTE_BUFFER_PCT = 5;
export const QUOTE_TTL_MS = 30 * 60_000;

export type Quote = {
  id: string;
  /** A play (the default) fights for the hill; a donation only grows the pot. */
  kind?: 'play' | 'donation';
  player: string;
  surface: string;
  mint: string;
  /** The one-time deposit address. Its secret is stored beside the quote until the sweep. */
  depositAddress: string;
  playFeeSol: number;
  playFeeUsd: number;
  inferenceUsd: number;
  bufferPct: number;
  totalUsd: number;
  solUsd: number;
  tokenUsd: number;
  decimals: number;
  amountUi: number;
  amountRaw: string;
  /** SOL included in the deposit to pay Raydium's pool creation (the first SOL/MASTER donation); not part of the stake. */
  extraSol?: number;
  /** Donations: who receives the Raydium lock NFT (the donor's registered wallet; else whoever paid the deposit). */
  nftOwner?: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'deposited' | 'settling' | 'settled' | 'expired' | 'failed';
  steps: Record<string, string>;
  playSignature: string | null;
  error: string | null;
};

export type Prices = { solUsd: number; tokenUsd: number; decimals: number };

/**
 * Read a balance until it rises above `before`. A confirmed transaction is not always visible on the
 * next read from a load-balanced RPC; reading once right after `sendAndConfirm` once recorded 0 LP
 * for a pool that had just been created, and the vault then refused to lock 0.
 */
export async function waitForIncrease(read: () => Promise<bigint>, before: bigint, opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<bigint> {
  const attempts = opts.attempts ?? 12, delayMs = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last = before;
  for (let i = 0; i < attempts; i++) {
    last = await read().catch(() => before);
    if (last > before) return last;
    await sleep(delayMs);
  }
  throw new Error(`the LP tokens have not shown up yet (${last} of at least ${before + 1n}); the pool transaction is recorded, say paid again in a minute`);
}

/** Rent for the accounts a CPMM pool creates (vaults, lp mint, observation state), on top of Raydium's creation fee. */
export const POOL_RENT_SOL = 0.03;
/** The least we ever ask for, so a top-up covers a few pools and the fees around them. */
export const MIN_TOPUP_SOL = 0.1;

/**
 * The operator (the fee payer) cannot afford to create the <coin>/MASTER pool: Raydium charges a
 * creation fee in SOL. Everything settled so far is kept; `paid <quote-id>` again after a top-up
 * resumes at the pool step.
 */
export class NeedsSolError extends Error {
  readonly topUpSol: number;
  constructor(readonly feePayer: string, readonly haveSol: number, readonly needSol: number, readonly poolFeeSol: number) {
    const shortfall = Math.max(0, needSol - haveSol);
    const topUpSol = Math.max(MIN_TOPUP_SOL, Math.ceil(shortfall * 100) / 100);
    super(`Raydium charges ${poolFeeSol} SOL to create the pool and the fee payer ${feePayer} has ${haveSol.toFixed(4)} SOL (needs ~${needSol.toFixed(2)}). Send it ${topUpSol} SOL and say paid again.`);
    this.name = 'NeedsSolError';
    this.topUpSol = topUpSol;
  }
}

/** The least a donation can be: below this the swap and the pool deposit are mostly fees. */
export const MIN_DONATION_SOL = 0.01;

/**
 * How a swept deposit is split: the inference share (nothing for a donation), the pool-creation SOL
 * that rode along in the deposit (nothing for a play), and the stake, half of which is swapped to
 * the master token while the other half stays as it is; the pair becomes liquidity.
 */
export function splitDeposit(q: Pick<Quote, 'inferenceUsd' | 'totalUsd' | 'extraSol' | 'mint'>, swept: bigint): { inferenceShare: bigint; extra: bigint; stake: bigint; half: bigint } {
  const extra = q.mint === NATIVE_SOL_MINT.toBase58() && q.extraSol ? BigInt(Math.round(q.extraSol * LAMPORTS_PER_SOL)) : 0n;
  const net = swept > extra ? swept - extra : 0n;
  const inferenceShare = q.totalUsd > 0 && q.inferenceUsd > 0 ? (net * BigInt(Math.round((q.inferenceUsd / q.totalUsd) * 1e6))) / 1_000_000n : 0n;
  const stake = net - inferenceShare;
  return { inferenceShare, extra, stake, half: stake / 2n };
}

/** Jupiter price v3: usd per token for any tradable mint, in one call. */
export async function jupiterPrices(mint: string, baseUrl = 'https://lite-api.jup.ag', f: typeof fetch = fetch): Promise<Prices> {
  const sol = NATIVE_SOL_MINT.toBase58();
  const res = await f(`${baseUrl}/price/v3?ids=${sol},${mint}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`jupiter price ${res.status}`);
  const j = (await res.json()) as Record<string, { usdPrice?: number; decimals?: number }>;
  const solUsd = j[sol]?.usdPrice, tokenUsd = j[mint]?.usdPrice, decimals = j[mint]?.decimals;
  if (!solUsd || !tokenUsd || decimals === undefined) throw new Error(`${mint} is not priced on Jupiter (not swappable?)`);
  return { solUsd, tokenUsd, decimals };
}

/** The pure arithmetic of a quote, kept separate so it is testable to the lamport. */
export function computeQuote(a: { playFeeSol: number; inferenceUsd: number; solUsd: number; tokenUsd: number; decimals: number; bufferPct?: number }): Pick<Quote, 'playFeeUsd' | 'inferenceUsd' | 'bufferPct' | 'totalUsd' | 'amountUi' | 'amountRaw'> {
  const bufferPct = a.bufferPct ?? QUOTE_BUFFER_PCT;
  const playFeeUsd = a.playFeeSol * a.solUsd;
  const totalUsd = (playFeeUsd + a.inferenceUsd) * (1 + bufferPct / 100);
  const amountUi = totalUsd / a.tokenUsd;
  const amountRaw = BigInt(Math.ceil(amountUi * 10 ** a.decimals));
  return { playFeeUsd, inferenceUsd: a.inferenceUsd, bufferPct, totalUsd, amountUi: Number(amountRaw) / 10 ** a.decimals, amountRaw: amountRaw.toString() };
}

export type VaultPosition = { lpMint: string; pool: string | null; lp: string; share: number; usd: number; priced: boolean };
const POT_CACHE_MS = 60_000;

/**
 * A ONE-TIME SIGNER FOR ANYTHING THAT TOUCHES SOL.
 *
 * The operator's canonical wrapped-SOL account is squatted: the address every wallet and router
 * derives for it is owned by someone else, so any swap that wraps or unwraps SOL "for the user"
 * fails with `Token account … is owned by … instead of the user`. So the operator never wraps.
 * A fresh keypair is funded with the lamports plus a fee cushion, it is the swap's user (its
 * wrapped-SOL account is brand new and its own), the output is delivered to whoever it was for,
 * and whatever SOL is left is swept back. The keypair is used once and forgotten.
 */
export type SolRunner = { keypair: Keypair; sweep: () => Promise<void> };
export const SOL_FEE_CUSHION = 8_000_000n;   // rent for a wrapped-SOL account + priority fees + the sweep

export async function spawnSolRunner(connection: Connection, operator: Keypair, lamports: bigint, log?: (s: string) => void): Promise<SolRunner> {
  const keypair = Keypair.generate();
  const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: keypair.publicKey, lamports: lamports + SOL_FEE_CUSHION }));
  await sendAndConfirmTransaction(connection, fund, [operator], { commitment: 'confirmed' });
  log?.(`sol runner ${keypair.publicKey.toBase58()} funded with ${lamports + SOL_FEE_CUSHION} lamports`);
  return {
    keypair,
    sweep: async () => {
      const bal = BigInt(await connection.getBalance(keypair.publicKey, 'confirmed'));
      const back = bal - 5_000n;
      if (back <= 0n) return;
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: operator.publicKey, lamports: back }));
      await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
      log?.(`sol runner ${keypair.publicKey.toBase58()} swept ${back} lamports back`);
    },
  };
}

const involvesSol = (a: { inputMint: PublicKey; outputMint: PublicKey }) => a.inputMint.equals(NATIVE_SOL_MINT) || a.outputMint.equals(NATIVE_SOL_MINT);

export interface Swapper {
  /** Swap `amountRaw` of `inputMint` into `outputMint`; output lands in `destination`'s ATA (or the operator's). */
  swap(a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }>;
}

/** Jupiter swap API (lite-api needs no key; api.jup.ag takes one). */
export class JupiterSwapper implements Swapper {
  constructor(private connection: Connection, private operator: Keypair, private opts: { baseUrl?: string; apiKey?: string; slippageBps?: number; fetchImpl?: typeof fetch; solRunner?: (lamports: bigint) => Promise<SolRunner>; log?: (s: string) => void } = {}) {}

  async swap(a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }> {
    if (!involvesSol(a)) return this.swapAs(this.operator, a);
    // SOL on either side: a one-time signer wraps and unwraps with its own fresh account (see spawnSolRunner)
    const runner = await (this.opts.solRunner ?? ((l) => spawnSolRunner(this.connection, this.operator, l, this.opts.log)))(a.inputMint.equals(NATIVE_SOL_MINT) ? a.amountRaw : 0n);
    try {
      return await this.swapAs(runner.keypair, { ...a, destinationOwner: a.outputMint.equals(NATIVE_SOL_MINT) ? undefined : (a.destinationOwner ?? this.operator.publicKey) });
    } finally {
      await runner.sweep().catch((e) => this.opts.log?.(`sol runner sweep failed: ${e instanceof Error ? e.message : e}`));
    }
  }

  private async swapAs(user: Keypair, a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }> {
    const base = (this.opts.baseUrl ?? (this.opts.apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag')).replace(/\/+$/, '');
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}) };
    const q = new URL(`${base}/swap/v1/quote`);
    q.searchParams.set('inputMint', a.inputMint.toBase58());
    q.searchParams.set('outputMint', a.outputMint.toBase58());
    q.searchParams.set('amount', a.amountRaw.toString());
    q.searchParams.set('slippageBps', String(this.opts.slippageBps ?? 100));
    const qr = await f(q, { headers, signal: AbortSignal.timeout(20_000) });
    const quote = (await qr.json()) as Record<string, unknown>;
    if (!qr.ok || !quote.outAmount) throw new Error(`jupiter quote failed: ${JSON.stringify(quote).slice(0, 200)}`);
    // wrapAndUnwrapSol is only ever true for a one-time signer; the operator's own wrapped-SOL account is never used
    const body: Record<string, unknown> = {
      quoteResponse: quote, userPublicKey: user.publicKey.toBase58(), wrapAndUnwrapSol: !user.publicKey.equals(this.operator.publicKey),
      dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto',
    };
    if (a.destinationOwner && !a.outputMint.equals(NATIVE_SOL_MINT)) {
      const outProgram = await tokenProgramFor(this.connection, a.outputMint);
      const dst = getAssociatedTokenAddressSync(a.outputMint, a.destinationOwner, true, outProgram);
      if (!user.publicKey.equals(a.destinationOwner)) {
        // Jupiter delivers into an existing account only: make sure it is there (the operator pays the rent)
        const mk = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(this.operator.publicKey, dst, a.destinationOwner, a.outputMint, outProgram));
        await sendAndConfirmTransaction(this.connection, mk, [this.operator], { commitment: 'confirmed' });
      }
      body.destinationTokenAccount = dst.toBase58();
    }
    const sr = await f(`${base}/swap/v1/swap`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const s = (await sr.json()) as { swapTransaction?: string; error?: string };
    if (!sr.ok || !s.swapTransaction) throw new Error(`jupiter swap failed: ${s.error ?? sr.status}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
    tx.sign([user]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const latest = await this.connection.getLatestBlockhash('confirmed');
    await this.connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    return { signature, outAmountRaw: BigInt(String(quote.outAmount)) };
  }
}

/**
 * Jupiter Ultra: one `order` (a signed-by-us transaction routed across Jupiter's routers, dflow
 * included, which is what reaches a Meteora DBC curve quoted in $TOKEN) and one `execute`. Ultra
 * has no destination account, so a swap for someone else lands in the operator's wallet and is
 * forwarded. When Ultra cannot build an order the classic swap API is tried.
 */
export class UltraSwapper implements Swapper {
  constructor(
    private connection: Connection, private operator: Keypair,
    private opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; fallback?: Swapper; log?: (s: string) => void; solRunner?: (lamports: bigint) => Promise<SolRunner> },
  ) {}

  async swap(a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }> {
    try {
      return await this.ultra(a);
    } catch (e) {
      if (!this.opts.fallback) throw e;
      this.opts.log?.(`jupiter ultra: ${e instanceof Error ? e.message : e}; trying the swap api`);
      return this.opts.fallback.swap(a);
    }
  }

  private async ultra(a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }> {
    if (!involvesSol(a)) return this.ultraAs(this.operator, a);
    // SOL on either side: a one-time taker (see spawnSolRunner); its output is forwarded, its leftover SOL swept back
    const runner = await (this.opts.solRunner ?? ((l) => spawnSolRunner(this.connection, this.operator, l, this.opts.log)))(a.inputMint.equals(NATIVE_SOL_MINT) ? a.amountRaw : 0n);
    try {
      return await this.ultraAs(runner.keypair, { ...a, destinationOwner: a.destinationOwner ?? this.operator.publicKey });
    } finally {
      await runner.sweep().catch((e) => this.opts.log?.(`sol runner sweep failed: ${e instanceof Error ? e.message : e}`));
    }
  }

  private async ultraAs(taker: Keypair, a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }> {
    const base = (this.opts.baseUrl ?? 'https://api.jup.ag').replace(/\/+$/, '');
    const f = this.opts.fetchImpl ?? fetch;
    const headers = { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey };
    const u = new URL(`${base}/ultra/v1/order`);
    u.searchParams.set('inputMint', a.inputMint.toBase58());
    u.searchParams.set('outputMint', a.outputMint.toBase58());
    u.searchParams.set('amount', a.amountRaw.toString());
    u.searchParams.set('taker', taker.publicKey.toBase58());
    const or = await f(u, { headers, signal: AbortSignal.timeout(20_000) });
    const order = (await or.json().catch(() => ({}))) as { transaction?: string | null; requestId?: string; outAmount?: string; router?: string; errorMessage?: string; error?: string };
    if (!or.ok || !order.transaction || !order.requestId) throw new Error(`order: ${order.errorMessage ?? order.error ?? or.status}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    tx.sign([taker]);
    const er = await f(`${base}/ultra/v1/execute`, {
      method: 'POST', headers, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: order.requestId }),
    });
    const ex = (await er.json().catch(() => ({}))) as { status?: string; signature?: string; outputAmountResult?: string; error?: string; code?: number };
    if (!er.ok || ex.status !== 'Success' || !ex.signature) throw new Error(`execute: ${ex.error ?? ex.code ?? er.status}`);
    const outAmountRaw = BigInt(ex.outputAmountResult ?? order.outAmount ?? '0');
    this.opts.log?.(`jupiter ultra via ${order.router ?? '?'}: ${a.amountRaw} ${a.inputMint.toBase58().slice(0, 6)} -> ${outAmountRaw} ${a.outputMint.toBase58().slice(0, 6)}, tx ${ex.signature}`);
    // SOL out lands as lamports on the taker and the runner's sweep carries it home; tokens are forwarded
    if (a.destinationOwner && !a.destinationOwner.equals(taker.publicKey) && outAmountRaw > 0n && !a.outputMint.equals(NATIVE_SOL_MINT)) {
      await this.forward(taker, a.outputMint, outAmountRaw, a.destinationOwner);
    }
    return { signature: ex.signature, outAmountRaw };
  }

  /** Ultra always pays the taker: move the output on to whoever it was for. The operator pays the rent for the destination account. */
  private async forward(from: Keypair, mint: PublicKey, amount: bigint, to: PublicKey): Promise<string> {
    const program = await tokenProgramFor(this.connection, mint);
    const decimals = (await getMint(this.connection, mint, 'confirmed', program)).decimals;
    const src = getAssociatedTokenAddressSync(mint, from.publicKey, false, program);
    const dst = getAssociatedTokenAddressSync(mint, to, true, program);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(this.operator.publicKey, dst, to, mint, program),
      createTransferCheckedInstruction(src, mint, dst, from.publicKey, amount, decimals, [], program),
    );
    const signers = from.publicKey.equals(this.operator.publicKey) ? [this.operator] : [this.operator, from];
    return sendAndConfirmTransaction(this.connection, tx, signers, { commitment: 'confirmed' });
  }
}

export async function tokenProgramFor(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  if (mint.equals(NATIVE_SOL_MINT)) return TOKEN_PROGRAM_ID;
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export type EntryDeps = {
  connection: Connection;
  operator: Keypair;
  masterMint: PublicKey;
  playProgramId: PublicKey;
  cpmmProgramId: PublicKey;
  dataDir: string;
  /** Where the inference share goes: the openzoo burner wallet's owner. */
  zooWallet: PublicKey | null;
  /** TOKEN by default; USDC or LEOS by config. */
  inferencePayMint: PublicKey;
  /** From the ledger: what an attempt has been costing in inference. */
  estimateInferenceUsd: () => number;
  swapper?: Swapper;
  /** With a key, swaps go through Jupiter Ultra (the swap api as fallback); without, the keyless swap api. */
  jupiterApiKey?: string;
  prices?: (mint: string) => Promise<Prices>;
  slippageBps?: number;
  log?: (line: string) => void;
  now?: () => number;
};

export class Entry implements EntryLike {
  private swapper: Swapper;
  private prices: (mint: string) => Promise<Prices>;
  private raydium: Promise<Raydium> | null = null;
  constructor(private d: EntryDeps) {
    const classic = new JupiterSwapper(d.connection, d.operator, { apiKey: d.jupiterApiKey, slippageBps: d.slippageBps, log: d.log });
    this.swapper = d.swapper ?? (d.jupiterApiKey ? new UltraSwapper(d.connection, d.operator, { apiKey: d.jupiterApiKey, fallback: classic, log: d.log }) : classic);
    this.prices = d.prices ?? ((mint) => jupiterPrices(mint));
    fs.mkdirSync(this.quotesDir, { recursive: true });
  }

  private get quotesDir(): string { return path.join(this.d.dataDir, 'quotes'); }
  private quotePath(id: string): string { return path.join(this.quotesDir, `${id}.json`); }
  private keyPath(id: string): string { return path.join(this.quotesDir, `${id}.key`); }
  private now(): number { return this.d.now ? this.d.now() : Date.now(); }
  private log(s: string): void { (this.d.log ?? (() => {}))(s); }

  loadQuote(id: string): Quote | null {
    const p = this.quotePath(id);
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Quote) : null;
  }
  private saveQuote(q: Quote): void { fs.writeFileSync(this.quotePath(q.id), JSON.stringify(q, null, 2)); }

  /** Step 1: a one-time deposit address and the amount of the player's token to send there. */
  async quote(a: { player: string; surface: string; mint: string; playFeeSol: number }): Promise<Quote> {
    const mint = new PublicKey(a.mint);
    if (mint.equals(this.d.masterMint)) throw new Error('the master token cannot challenge itself');
    const p = await this.prices(a.mint);
    const inferenceUsd = this.d.estimateInferenceUsd();
    const math = computeQuote({ playFeeSol: a.playFeeSol, inferenceUsd, solUsd: p.solUsd, tokenUsd: p.tokenUsd, decimals: p.decimals });
    const q = this.newQuote({
      kind: 'play', player: a.player, surface: a.surface, mint: a.mint, playFeeSol: a.playFeeSol, ...math,
      solUsd: p.solUsd, tokenUsd: p.tokenUsd, decimals: p.decimals,
    });
    this.log(`[quote ${q.id}] ${q.amountUi} ${a.mint.slice(0, 6)} -> ${q.depositAddress} (play $${q.playFeeUsd.toFixed(2)} + inference $${inferenceUsd.toFixed(3)}, +${q.bufferPct}%)`);
    return q;
  }

  /**
   * A donation to the pot: SOL, any amount. It settles like a play without the fight or the inference
   * share: half is swapped to the master token, the pair becomes SOL/MASTER liquidity in the vault.
   * The first donation also creates that pool, so when the fee payer cannot cover Raydium's creation
   * fee the quote asks for it on top (`extraSol`), and that part never enters the stake. The LP is
   * locked for good with Raydium's lock program and the lock NFT (the fee claim) goes to the donor.
   */
  async donate(a: { donor: string; surface: string; sol: number; nftOwner?: string | null }): Promise<Quote & { extraSol: number; poolExists: boolean }> {
    if (!(a.sol >= MIN_DONATION_SOL)) throw new Error(`a donation is at least ${MIN_DONATION_SOL} SOL`);
    const sol = Math.round(a.sol * 1e6) / 1e6;
    const p = await this.prices(NATIVE_SOL_MINT.toBase58());
    const need = await this.poolCreationNeed(NATIVE_SOL_MINT);
    const extraSol = need.exists ? 0 : Math.max(0, Math.ceil(need.shortfallSol * 100) / 100);
    const amountUi = Math.round((sol + extraSol) * 1e6) / 1e6;
    const q = this.newQuote({
      kind: 'donation', player: a.donor, surface: a.surface, mint: NATIVE_SOL_MINT.toBase58(), playFeeSol: sol,
      playFeeUsd: Math.round(sol * p.solUsd * 100) / 100, inferenceUsd: 0, bufferPct: 0, totalUsd: Math.round(sol * p.solUsd * 100) / 100,
      amountUi, amountRaw: String(Math.round(amountUi * LAMPORTS_PER_SOL)), extraSol, ...(a.nftOwner ? { nftOwner: a.nftOwner } : {}),
      solUsd: p.solUsd, tokenUsd: p.solUsd, decimals: 9,
    });
    this.log(`[quote ${q.id}] donation ${sol} SOL${extraSol ? ` + ${extraSol} SOL pool creation` : ''} -> ${q.depositAddress}`);
    return { ...q, extraSol, poolExists: need.exists };
  }

  private newQuote(a: Omit<Quote, 'id' | 'depositAddress' | 'createdAt' | 'expiresAt' | 'status' | 'steps' | 'playSignature' | 'error'>): Quote {
    const throwaway = Keypair.generate();
    const q: Quote = {
      id: randomBytes(6).toString('hex'), ...a, depositAddress: throwaway.publicKey.toBase58(),
      createdAt: this.now(), expiresAt: this.now() + QUOTE_TTL_MS, status: 'pending', steps: {}, playSignature: null, error: null,
    };
    fs.writeFileSync(this.keyPath(q.id), JSON.stringify([...throwaway.secretKey]), { mode: 0o600 });
    this.saveQuote(q);
    return q;
  }

  /**
   * Does the <mint>/MASTER pool exist, and if not, can the fee payer create it? `shortfallSol` is what
   * it is missing for Raydium's fee plus the pool's rent (0 when the pool is there or the SOL is).
   */
  async poolCreationNeed(mint: PublicKey): Promise<{ exists: boolean; poolFeeSol: number; needSol: number; haveSol: number; shortfallSol: number }> {
    const feeConfig = await this.cpmmFeeConfig();
    const poolId = this.poolIdFor(new PublicKey(feeConfig.id), mint);
    const info = await this.d.connection.getAccountInfo(poolId);
    const poolFeeSol = Number(feeConfig.createPoolFee ?? 0) / LAMPORTS_PER_SOL;
    const needSol = poolFeeSol + POOL_RENT_SOL;
    const haveSol = (await this.d.connection.getBalance(this.d.operator.publicKey)) / LAMPORTS_PER_SOL;
    return { exists: Boolean(info), poolFeeSol, needSol, haveSol, shortfallSol: info ? 0 : Math.max(0, needSol - haveSol) };
  }

  /** How much of the quoted token sits at the deposit address right now (raw units). */
  async depositBalance(q: Quote): Promise<bigint> {
    const addr = new PublicKey(q.depositAddress);
    const mint = new PublicKey(q.mint);
    if (mint.equals(NATIVE_SOL_MINT)) return BigInt(await this.d.connection.getBalance(addr));
    const program = await tokenProgramFor(this.d.connection, mint);
    try {
      const acc = await getAccount(this.d.connection, getAssociatedTokenAddressSync(mint, addr, false, program), 'confirmed', program);
      return acc.amount;
    } catch {
      return 0n;
    }
  }

  /** Step 2: has the player paid? Accepts a little under the quote (the buffer absorbs rounding). */
  async checkDeposit(id: string): Promise<{ quote: Quote; paid: boolean; balanceRaw: bigint }> {
    const q = this.loadQuote(id);
    if (!q) throw new Error(`unknown quote ${id}`);
    const balanceRaw = await this.depositBalance(q);
    const paid = balanceRaw >= (BigInt(q.amountRaw) * 98n) / 100n;
    if (paid && q.status === 'pending') { q.status = 'deposited'; this.saveQuote(q); }
    else if (!paid && q.status === 'pending' && this.now() > q.expiresAt) { q.status = 'expired'; this.saveQuote(q); }
    return { quote: q, paid, balanceRaw };
  }

  /** Step 3: sweep, convert, pool, lock. Resumable: each completed step is recorded on the quote. */
  async settle(id: string, opts: { onStep?: (label: string, sig?: string) => void } = {}): Promise<Quote> {
    const step = (label: string, sig?: string) => { try { opts.onStep?.(label, sig); } catch { /* observers never break settlement */ } };
    const q = this.loadQuote(id);
    if (!q) throw new Error(`unknown quote ${id}`);
    if (q.status === 'settled') return q;
    const { paid, balanceRaw } = await this.checkDeposit(id);
    if (!paid && !q.steps.sweep) throw new Error(`quote ${id} is not paid (${balanceRaw} of ${q.amountRaw})`);
    q.status = 'settling'; this.saveQuote(q);
    try {
      const mint = new PublicKey(q.mint);
      const conn = this.d.connection, op = this.d.operator;
      const isSol = mint.equals(NATIVE_SOL_MINT);
      const program = await tokenProgramFor(conn, mint);

      // 3a. sweep the deposit into the operator wallet and retire the throwaway key
      if (!q.steps.sweep) {
        const secret = JSON.parse(fs.readFileSync(this.keyPath(id), 'utf8')) as number[];
        const throwaway = Keypair.fromSecretKey(Uint8Array.from(secret));
        const tx = new Transaction();
        let swept: bigint;
        if (isSol) {
          const lamports = await conn.getBalance(throwaway.publicKey);
          swept = BigInt(lamports);
          tx.add(SystemProgram.transfer({ fromPubkey: throwaway.publicKey, toPubkey: op.publicKey, lamports }));
        } else {
          const from = getAssociatedTokenAddressSync(mint, throwaway.publicKey, false, program);
          const to = getAssociatedTokenAddressSync(mint, op.publicKey, false, program);
          const acc = await getAccount(conn, from, 'confirmed', program);
          const decimals = (await getMint(conn, mint, 'confirmed', program)).decimals;
          swept = acc.amount;
          tx.add(
            createAssociatedTokenAccountIdempotentInstruction(op.publicKey, to, op.publicKey, mint, program),
            createTransferCheckedInstruction(from, mint, to, throwaway.publicKey, acc.amount, decimals, [], program),
            createCloseAccountInstruction(from, op.publicKey, throwaway.publicKey, [], program),
          );
        }
        tx.feePayer = op.publicKey;
        const sig = await sendAndConfirmTransaction(conn, tx, [op, throwaway], { commitment: 'confirmed' });
        q.steps.sweep = sig; q.steps.sweptRaw = swept.toString(); this.saveQuote(q);
        fs.rmSync(this.keyPath(id), { force: true });
        this.log(`[quote ${id}] swept ${swept} raw, key deleted, tx ${sig}`);
      }
      step(`swept ${Number(q.steps.sweptRaw) / 10 ** q.decimals} · key deleted`, q.steps.sweep);
      const swept = BigInt(q.steps.sweptRaw);
      // the shares, from what actually arrived (the buffer means this is >= the quote in the normal case)
      const { inferenceShare, stake: playShare, half } = splitDeposit(q, swept);

      // 3b. the inference share -> TOKEN/USDC/LEOS for the openzoo wallet
      if (!q.steps.inference) {
        if (inferenceShare > 0n && this.d.zooWallet && !mint.equals(this.d.inferencePayMint)) {
          const r = await this.swapper.swap({ inputMint: mint, outputMint: this.d.inferencePayMint, amountRaw: inferenceShare, destinationOwner: this.d.zooWallet });
          q.steps.inference = r.signature;
        } else if (inferenceShare > 0n && this.d.zooWallet && mint.equals(this.d.inferencePayMint)) {
          q.steps.inference = await this.sendTokens(mint, program, inferenceShare, this.d.zooWallet);
        } else {
          q.steps.inference = 'skipped';
        }
        this.saveQuote(q);
      }
      step(`inference share → ${this.d.inferencePayMint.equals(ZOO_TOKEN_MINT) ? '$TOKEN' : 'the zoo wallet'}`, q.steps.inference === 'skipped' ? undefined : q.steps.inference);

      // 3c. half the stake -> master token
      if (!q.steps.swapHalf) {
        const r = await this.swapper.swap({ inputMint: mint, outputMint: this.d.masterMint, amountRaw: half });
        q.steps.swapHalf = r.signature; q.steps.masterRaw = r.outAmountRaw.toString(); this.saveQuote(q);
        this.log(`[quote ${id}] swapped ${half} -> ${r.outAmountRaw} master, tx ${r.signature}`);
      }
      const masterRaw = BigInt(q.steps.masterRaw);
      step('half → master token on Jupiter', q.steps.swapHalf);

      // 3d. the pool: create <token>/MASTER if it is not there, else deposit into it
      if (!q.steps.pool) {
        const r = await this.ensurePoolAndDeposit(mint, program, playShare - half, masterRaw);
        q.steps.pool = r.signature; q.steps.poolId = r.poolId.toBase58(); q.steps.lpMint = r.lpMint.toBase58(); q.steps.lpRaw = r.lpRaw.toString(); q.steps.poolCreated = String(r.created);
        this.saveQuote(q);
        this.log(`[quote ${id}] pool ${r.poolId.toBase58()} ${r.created ? 'created' : 'deposited'}, lp ${r.lpRaw}, tx ${r.signature}`);
      }
      step(`pool ${q.steps.poolCreated === 'true' ? 'created' : 'deposited'} on Raydium`, q.steps.pool);

      const lpMint = new PublicKey(q.steps.lpMint), poolId = new PublicKey(q.steps.poolId);
      if (!q.steps.play && !q.steps.lock && BigInt(q.steps.lpRaw || '0') <= 0n) {
        // the pool step went through but its LP was read too early: whatever LP the operator holds for this
        // pool is this quote's (every earlier quote's LP is already in the vault or locked)
        const lpRaw = await waitForIncrease(() => this.lpHeld(lpMint), 0n, { attempts: 8 });
        q.steps.lpRaw = lpRaw.toString(); this.saveQuote(q);
        this.log(`[quote ${id}] re-measured LP: ${lpRaw}`);
      }

      // 3e (donation). the LP is locked for good on Raydium; the lock NFT, which claims the pool's fees, goes to the donor
      if (q.kind === 'donation') {
        if (!q.steps.lock) {
          const owner = q.nftOwner ? new PublicKey(q.nftOwner) : (await this.payerOf(q)) ?? op.publicKey;
          const r = await this.lockOnRaydium(poolId, BigInt(q.steps.lpRaw), owner);
          q.steps.lock = r.signature; q.steps.nftMint = r.nftMint.toBase58(); q.steps.nftOwner = owner.toBase58(); q.playSignature = r.signature; this.saveQuote(q);
          this.log(`[quote ${id}] locked ${q.steps.lpRaw} LP on Raydium, nft ${q.steps.nftMint} -> ${q.steps.nftOwner}, tx ${r.signature}`);
        }
        step(`LP locked for good on Raydium · fee NFT → ${q.steps.nftOwner}`, q.steps.lock);
        q.status = 'settled'; this.saveQuote(q);
        return q;
      }

      // 3e. the play: the push share (35%) of the LP into the vault, recorded for the player. The rest waits
      // in the operator's LP account for the fight: dividends to past kings and players, and the winner's
      // share or, on a loss, a second push (`settleShares` in the command layer).
      if (!q.steps.play) {
        const lpRaw = BigInt(q.steps.lpRaw);
        const pushRaw = bps(lpRaw, PUSH_BPS);
        const sig = await this.pushToVault(q, pushRaw > 0n ? pushRaw : lpRaw);
        q.steps.play = sig; q.steps.pushedRaw = (pushRaw > 0n ? pushRaw : lpRaw).toString(); q.playSignature = sig; this.saveQuote(q);
        this.log(`[quote ${id}] play locked ${q.steps.pushedRaw} of ${lpRaw} LP, tx ${sig}`);
      }
      step(`${PUSH_BPS / 100}% of the LP locked in the vault`, q.steps.play);
      q.status = 'settled'; this.saveQuote(q);
      return q;
    } catch (e) {
      q.status = 'failed'; q.error = e instanceof Error ? e.message : String(e); this.saveQuote(q);
      throw e;
    }
  }

  /** The player's on-chain identity for the play record: a wallet if they gave one, else a pda-like hash of their handle. */
  private playerKey(q: Quote): PublicKey {
    try { return new PublicKey(q.player); } catch { /* not a pubkey */ }
    const h = Buffer.from(createHash('sha256').update(`${q.surface}:${q.player}`).digest());
    return new PublicKey(h);
  }

  private async sendTokens(mint: PublicKey, program: PublicKey, amount: bigint, to: PublicKey): Promise<string> {
    const op = this.d.operator, conn = this.d.connection;
    const decimals = (await getMint(conn, mint, 'confirmed', program)).decimals;
    const src = getAssociatedTokenAddressSync(mint, op.publicKey, false, program);
    const dst = getAssociatedTokenAddressSync(mint, to, true, program);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(op.publicKey, dst, to, mint, program),
      createTransferCheckedInstruction(src, mint, dst, op.publicKey, amount, decimals, [], program),
    );
    return sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
  }

  /** LP of this quote's pool into the vault, recorded for the quote's player. Used for the play and, on a loss, the second push. */
  async pushToVault(q: Quote, raw: bigint): Promise<string> {
    if (raw <= 0n) throw new Error('nothing to push');
    const op = this.d.operator;
    const lpMint = new PublicKey(q.steps.lpMint), poolId = new PublicKey(q.steps.poolId);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createVaultLpAtaIx(op.publicKey, this.d.playProgramId, lpMint),
      playIx({ programId: this.d.playProgramId, operator: op.publicKey, player: this.playerKey(q), poolState: poolId, lpMint, sourceLp: getAssociatedTokenAddressSync(lpMint, op.publicKey), amount: raw }),
    );
    const sig = await sendAndConfirmTransaction(this.d.connection, tx, [op], { commitment: 'confirmed' });
    this.invalidatePot();
    return sig;
  }

  /** Plain LP tokens to a wallet: the winner's share, unlocked, theirs to remove on Raydium. */
  async sendLp(lpMint: PublicKey, raw: bigint, to: PublicKey): Promise<string> {
    return this.sendTokens(lpMint, TOKEN_PROGRAM_ID, raw, to);
  }

  /** A one-of-one token (the Raydium lock NFT) to a wallet: where a donor's fee claim is forwarded once they name one. */
  async sendNft(nftMint: PublicKey, to: PublicKey): Promise<string> {
    return this.sendTokens(nftMint, TOKEN_PROGRAM_ID, 1n, to);
  }

  /**
   * Who funded a one-time deposit address: the fee payer of the oldest transaction that touched it
   * and was not ours. A donor who never named a wallet still gets their lock NFT this way.
   */
  async payerOf(q: Quote): Promise<PublicKey | null> {
    try {
      const deposit = new PublicKey(q.depositAddress);
      const sigs = await this.d.connection.getSignaturesForAddress(deposit, { limit: 25 }, 'confirmed');
      for (const s of [...sigs].reverse()) {
        if (s.err) continue;
        const tx = await this.d.connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) continue;
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
        const payer = keys.get(0);
        if (!payer || payer.equals(deposit) || payer.equals(this.d.operator.publicKey)) continue;
        return payer;
      }
    } catch (e) {
      this.log(`[quote ${q.id}] could not read who paid the deposit: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }

  /**
   * Lock LP with Raydium's lock program (LockrWmn…): the position can never be withdrawn; the NFT it
   * mints claims the position's share of trading fees, and it belongs to `nftOwner`.
   */
  async lockOnRaydium(poolId: PublicKey, lpRaw: bigint, nftOwner: PublicKey): Promise<{ signature: string; nftMint: PublicKey }> {
    if (lpRaw <= 0n) throw new Error('nothing to lock');
    const raydium = await this.getRaydium();
    const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
    const { execute, extInfo } = await raydium.cpmm.lockLp({ poolInfo, poolKeys, lpAmount: new BN(lpRaw.toString()), feeNftOwner: nftOwner, withMetadata: true, txVersion: TxVersion.V0 });
    const { txId } = await execute({ sendAndConfirm: true });
    return { signature: txId, nftMint: extInfo.nftMint };
  }

  /** Everything the vault holds, per LP mint: the pot. */
  async vaultHoldings(): Promise<{ lpMint: PublicKey; amount: bigint }[]> {
    const r = await this.d.connection.getParsedTokenAccountsByOwner(vaultPda(this.d.playProgramId)[0], { programId: TOKEN_PROGRAM_ID }, 'confirmed');
    return r.value
      .map((a) => ({ lpMint: new PublicKey(a.account.data.parsed.info.mint as string), amount: BigInt(a.account.data.parsed.info.tokenAmount.amount as string) }))
      .filter((h) => h.amount > 0n);
  }

  /**
   * The prize: half of every LP position in the vault, moved to the winner (the config admin, our
   * operator key, signs `Award`). A few pools per transaction; each transfer is logged and returned.
   */
  async awardHalf(winner: PublicKey): Promise<{ lpMint: string; amount: string; signature: string }[]> {
    const op = this.d.operator, conn = this.d.connection;
    const holdings = (await this.vaultHoldings()).filter((h) => h.amount >= 2n);
    const out: { lpMint: string; amount: string; signature: string }[] = [];
    for (let i = 0; i < holdings.length; i += 3) {
      const batch = holdings.slice(i, i + 3);
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 * batch.length + 40_000 }));
      for (const h of batch) {
        const dst = getAssociatedTokenAddressSync(h.lpMint, winner, true);
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(op.publicKey, dst, winner, h.lpMint),
          awardIx({ programId: this.d.playProgramId, admin: op.publicKey, lpMint: h.lpMint, destination: dst, amount: h.amount / 2n }),
        );
      }
      const signature = await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
      for (const h of batch) {
        out.push({ lpMint: h.lpMint.toBase58(), amount: (h.amount / 2n).toString(), signature });
        this.log(`award ${h.amount / 2n} of LP ${h.lpMint.toBase58()} -> ${winner.toBase58()}, tx ${signature}`);
      }
    }
    this.invalidatePot();
    return out;
  }

  private potCache: { at: number; usd: number; detail: VaultPosition[] } | null = null;
  private lpPriceCache = new Map<string, { at: number; pool: PublicKey; usdPerRaw: number }>();

  /**
   * What one raw unit of an LP mint is worth: its share of the pool's reserves, both sides (twice the
   * side Jupiter can price). Only pools with the master token on one side. Cached for a minute.
   */
  async priceLp(lpMint: PublicKey): Promise<{ pool: PublicKey; usdPerRaw: number }> {
    const hit = this.lpPriceCache.get(lpMint.toBase58());
    if (hit && Date.now() - hit.at < POT_CACHE_MS) return hit;
    const conn = this.d.connection;
    const pools = await findCpmmPoolsWithMaster(conn, this.d.cpmmProgramId, this.d.masterMint);
    const pool = pools.find((p) => p.lpMint.equals(lpMint));
    if (!pool) throw new Error(`LP ${lpMint.toBase58()} is not a pool with the master token`);
    const raydium = await this.getRaydium();
    const other = pool.token0.equals(this.d.masterMint) ? pool.token1 : pool.token0;
    const otherIsA = pool.token0.equals(other);
    const [{ rpcData }, supply, price] = await Promise.all([
      raydium.cpmm.getPoolInfoFromRpc(pool.pool.toBase58()),
      getMint(conn, lpMint, 'confirmed').then((m) => m.supply),
      this.prices(other.toBase58()),
    ]);
    if (supply === 0n) throw new Error(`LP ${lpMint.toBase58()} has no supply`);
    const reserveOther = BigInt((otherIsA ? rpcData.baseReserve : rpcData.quoteReserve).toString());
    const usdPerRaw = (2 * (Number(reserveOther) / 10 ** price.decimals) * price.tokenUsd) / Number(supply);
    const out = { at: Date.now(), pool: pool.pool, usdPerRaw };
    this.lpPriceCache.set(lpMint.toBase58(), out);
    return out;
  }

  /**
   * What the vault holds, priced from chain: for each LP position, its share of the pool's reserves,
   * valued as twice the priced side (the non-master side, priced by Jupiter; an AMM position is two
   * equal halves). Positions nobody can price count as 0 rather than a guess. Cached for a minute:
   * every reply shows the pot.
   */
  async vaultValueUsd(): Promise<{ usd: number; positions: VaultPosition[] }> {
    if (this.potCache && Date.now() - this.potCache.at < POT_CACHE_MS) return { usd: this.potCache.usd, positions: this.potCache.detail };
    const conn = this.d.connection;
    const holdings = await this.vaultHoldings();
    const positions: VaultPosition[] = [];
    if (holdings.length) {
      const pools = await findCpmmPoolsWithMaster(conn, this.d.cpmmProgramId, this.d.masterMint);
      const byLp = new Map(pools.map((p) => [p.lpMint.toBase58(), p]));
      for (const h of holdings) {
        const pool = byLp.get(h.lpMint.toBase58());
        const pos: VaultPosition = { lpMint: h.lpMint.toBase58(), pool: pool?.pool.toBase58() ?? null, lp: h.amount.toString(), share: 0, usd: 0, priced: false };
        positions.push(pos);
        if (!pool) continue;
        try {
          const [{ usdPerRaw }, supply] = await Promise.all([this.priceLp(h.lpMint), getMint(conn, h.lpMint, 'confirmed').then((m) => m.supply)]);
          pos.share = supply === 0n ? 0 : Number(h.amount) / Number(supply);
          pos.usd = Math.round(Number(h.amount) * usdPerRaw * 100) / 100;
          pos.priced = true;
        } catch (e) {
          this.log(`pot: could not price LP ${h.lpMint.toBase58()}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    const usd = Math.round(positions.reduce((a, p) => a + p.usd, 0) * 100) / 100;
    this.potCache = { at: Date.now(), usd, detail: positions };
    return { usd, positions };
  }

  /** The pot: half of what the vault holds, in USD, from chain. */
  async potUsd(): Promise<number> {
    return Math.round(((await this.vaultValueUsd()).usd / 2) * 100) / 100;
  }

  /** Forget the cached valuation (after a deposit or an award changed the vault). */
  invalidatePot(): void { this.potCache = null; }

  /** LP of `lpMint` in the operator's associated account (where Raydium mints and deposits it). */
  private async lpHeld(lpMint: PublicKey): Promise<bigint> {
    try { return (await getAccount(this.d.connection, getAssociatedTokenAddressSync(lpMint, this.d.operator.publicKey), 'confirmed')).amount; } catch { return 0n; }
  }

  /** The wallet that pays Raydium's pool-creation fee and every transaction fee: where a top-up goes. */
  get feePayer(): string { return this.d.operator.publicKey.toBase58(); }

  private async getRaydium(): Promise<Raydium> {
    if (!this.raydium) {
      this.raydium = Raydium.load({ connection: this.d.connection, owner: this.d.operator, cluster: 'mainnet', disableLoadToken: true, disableFeatureCheck: true });
    }
    return this.raydium;
  }

  /** Raydium's CPMM fee configs; the lowest index is the standard tier. */
  async cpmmFeeConfig(): Promise<ApiCpmmConfigInfo> {
    const raydium = await this.getRaydium();
    const configs = await raydium.api.getCpmmConfigs();
    const cfg = configs.sort((a, b) => a.index - b.index)[0];
    if (!cfg) throw new Error('no CPMM fee config');
    return cfg;
  }

  /** The deterministic pool id for (token, master): Raydium sorts the mints, so we do the same. */
  poolIdFor(configId: PublicKey, mint: PublicKey): PublicKey {
    const [a, b] = Buffer.compare(mint.toBuffer(), this.d.masterMint.toBuffer()) <= 0 ? [mint, this.d.masterMint] : [this.d.masterMint, mint];
    return getCpmmPdaPoolId(this.d.cpmmProgramId, configId, a, b).publicKey;
  }

  async ensurePoolAndDeposit(mint: PublicKey, program: PublicKey, tokenRaw: bigint, masterRaw: bigint): Promise<{ poolId: PublicKey; lpMint: PublicKey; lpRaw: bigint; signature: string; created: boolean }> {
    const raydium = await this.getRaydium();
    const conn = this.d.connection, op = this.d.operator;
    const feeConfig = await this.cpmmFeeConfig();
    const poolId = this.poolIdFor(new PublicKey(feeConfig.id), mint);
    const info = await conn.getAccountInfo(poolId);
    const masterProgram = await tokenProgramFor(conn, this.d.masterMint);
    const tokenDecimals = mint.equals(NATIVE_SOL_MINT) ? 9 : (await getMint(conn, mint, 'confirmed', program)).decimals;
    const masterDecimals = (await getMint(conn, this.d.masterMint, 'confirmed', masterProgram)).decimals;
    const lpBalance = (lpMint: PublicKey) => this.lpHeld(lpMint);

    if (!info) {
      // Raydium's creation fee comes out of the operator's SOL: say so, with the number, instead of a simulation error
      const poolFeeSol = Number(feeConfig.createPoolFee ?? 0) / LAMPORTS_PER_SOL;
      // when SOL is the token side it leaves the fee payer too: it must be there on top of the fee
      const committedSol = mint.equals(NATIVE_SOL_MINT) ? Number(tokenRaw) / LAMPORTS_PER_SOL : 0;
      const needSol = poolFeeSol + POOL_RENT_SOL + committedSol;
      const haveSol = (await conn.getBalance(op.publicKey)) / LAMPORTS_PER_SOL;
      if (haveSol < needSol) throw new NeedsSolError(op.publicKey.toBase58(), haveSol, needSol, poolFeeSol);
      const { execute, extInfo } = await raydium.cpmm.createPool({
        programId: CREATE_CPMM_POOL_PROGRAM, poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
        mintA: { address: mint.toBase58(), decimals: tokenDecimals, programId: program.toBase58() },
        mintB: { address: this.d.masterMint.toBase58(), decimals: masterDecimals, programId: masterProgram.toBase58() },
        mintAAmount: new BN(tokenRaw.toString()), mintBAmount: new BN(masterRaw.toString()),
        startTime: new BN(0), feeConfig, associatedOnly: false,
        ownerInfo: { useSOLBalance: mint.equals(NATIVE_SOL_MINT) }, txVersion: TxVersion.V0,
      });
      const lpMint = extInfo.address.lpMint;
      const before = await lpBalance(lpMint);
      let txId: string;
      try {
        ({ txId } = await execute({ sendAndConfirm: true }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/insufficient (lamports|funds)|InsufficientFundsForRent|0x1\b/i.test(msg)) throw new NeedsSolError(op.publicKey.toBase58(), haveSol, needSol, poolFeeSol);
        throw e;
      }
      const after = await waitForIncrease(() => lpBalance(lpMint), before);
      return { poolId: extInfo.address.poolId, lpMint, lpRaw: after - before, signature: txId, created: true };
    }

    const sides = decodePoolState(info.data);
    const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
    // which side binds: the pool's ratio decides how much master a given token amount needs
    const tokenIsA = sides.token0.equals(mint);
    const reserveToken = tokenIsA ? rpcData.baseReserve : rpcData.quoteReserve;
    const reserveMaster = tokenIsA ? rpcData.quoteReserve : rpcData.baseReserve;
    const masterNeeded = (tokenRaw * BigInt(reserveMaster.toString())) / BigInt(reserveToken.toString());
    const useTokenAsInput = masterNeeded <= masterRaw;
    const inputAmount = new BN((useTokenAsInput ? tokenRaw : masterRaw).toString());
    const baseIn = useTokenAsInput ? tokenIsA : !tokenIsA;
    const before = await lpBalance(sides.lpMint);
    const { execute } = await raydium.cpmm.addLiquidity({ poolInfo, poolKeys, inputAmount, baseIn, slippage: new Percent(this.d.slippageBps ?? 100, 10_000), txVersion: TxVersion.V0 });
    const { txId } = await execute({ sendAndConfirm: true });
    const after = await waitForIncrease(() => lpBalance(sides.lpMint), before);
    return { poolId, lpMint: sides.lpMint, lpRaw: after - before, signature: txId, created: false };
  }

  /** Blocking convenience for the CLI: quote, wait for the deposit, settle. The bots use the three steps. */
  async play(a: { player: string; mint: string; feeSol: number }): Promise<{ playSignature: string; detail: Record<string, unknown> }> {
    const q = await this.quote({ player: a.player, surface: 'cli', mint: a.mint, playFeeSol: a.feeSol });
    this.log(`send ${q.amountUi} of ${a.mint} to ${q.depositAddress} (quote ${q.id}); waiting up to ${QUOTE_TTL_MS / 60_000} minutes`);
    const deadline = this.now() + QUOTE_TTL_MS;
    while (this.now() < deadline) {
      const { paid } = await this.checkDeposit(q.id);
      if (paid) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const settled = await this.settle(q.id);
    return { playSignature: settled.playSignature ?? '', detail: { quote: settled.id, steps: settled.steps } };
  }
}

export const solToLamports = (sol: number): number => Math.round(sol * LAMPORTS_PER_SOL);
