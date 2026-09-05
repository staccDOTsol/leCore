/**
 * The entry flow: how "send X of your token" becomes a locked play in the vault.
 *
 * By directive:
 *   - no hosted wallets: every attempt gets a ONE-TIME throwaway deposit address whose key lives
 *     only until the deposit is swept, then is deleted
 *   - the quote is the play stake (0.25 SOL worth, x1.01 per takeover) PLUS an inference estimate,
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
import type { EntryLike } from './hill.js';
import { createVaultLpAtaIx, decodePoolState, playIx } from './play.js';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export { ZOO_TOKEN_MINT };
export const LEOS_MINT = new PublicKey('5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e');

export const QUOTE_BUFFER_PCT = 5;
export const QUOTE_TTL_MS = 30 * 60_000;

export type Quote = {
  id: string;
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
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'deposited' | 'settling' | 'settled' | 'expired' | 'failed';
  steps: Record<string, string>;
  playSignature: string | null;
  error: string | null;
};

export type Prices = { solUsd: number; tokenUsd: number; decimals: number };

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

export interface Swapper {
  /** Swap `amountRaw` of `inputMint` into `outputMint`; output lands in `destination`'s ATA (or the operator's). */
  swap(a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }>;
}

/** Jupiter swap API (lite-api needs no key; api.jup.ag takes one). */
export class JupiterSwapper implements Swapper {
  constructor(private connection: Connection, private operator: Keypair, private opts: { baseUrl?: string; apiKey?: string; slippageBps?: number; fetchImpl?: typeof fetch } = {}) {}
  async swap(a: { inputMint: PublicKey; outputMint: PublicKey; amountRaw: bigint; destinationOwner?: PublicKey }): Promise<{ signature: string; outAmountRaw: bigint }> {
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
    const body: Record<string, unknown> = {
      quoteResponse: quote, userPublicKey: this.operator.publicKey.toBase58(), wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto',
    };
    if (a.destinationOwner) {
      const outProgram = await tokenProgramFor(this.connection, a.outputMint);
      body.destinationTokenAccount = getAssociatedTokenAddressSync(a.outputMint, a.destinationOwner, true, outProgram).toBase58();
    }
    const sr = await f(`${base}/swap/v1/swap`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const s = (await sr.json()) as { swapTransaction?: string; error?: string };
    if (!sr.ok || !s.swapTransaction) throw new Error(`jupiter swap failed: ${s.error ?? sr.status}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
    tx.sign([this.operator]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const latest = await this.connection.getLatestBlockhash('confirmed');
    await this.connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    return { signature, outAmountRaw: BigInt(String(quote.outAmount)) };
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
    this.swapper = d.swapper ?? new JupiterSwapper(d.connection, d.operator, { slippageBps: d.slippageBps });
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
    const throwaway = Keypair.generate();
    const q: Quote = {
      id: randomBytes(6).toString('hex'), player: a.player, surface: a.surface, mint: a.mint,
      depositAddress: throwaway.publicKey.toBase58(), playFeeSol: a.playFeeSol, ...math,
      solUsd: p.solUsd, tokenUsd: p.tokenUsd, decimals: p.decimals,
      createdAt: this.now(), expiresAt: this.now() + QUOTE_TTL_MS, status: 'pending', steps: {}, playSignature: null, error: null,
    };
    fs.writeFileSync(this.keyPath(q.id), JSON.stringify([...throwaway.secretKey]), { mode: 0o600 });
    this.saveQuote(q);
    this.log(`[quote ${q.id}] ${q.amountUi} ${a.mint.slice(0, 6)} -> ${q.depositAddress} (play $${q.playFeeUsd.toFixed(2)} + inference $${inferenceUsd.toFixed(3)}, +${q.bufferPct}%)`);
    return q;
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
      const inferenceShare = q.totalUsd > 0 ? (swept * BigInt(Math.round((q.inferenceUsd / q.totalUsd) * 1e6))) / 1_000_000n : 0n;
      const playShare = swept - inferenceShare;
      const half = playShare / 2n;

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

      // 3e. the play: LP into the vault, recorded for the player
      if (!q.steps.play) {
        const lpMint = new PublicKey(q.steps.lpMint), poolId = new PublicKey(q.steps.poolId), lpRaw = BigInt(q.steps.lpRaw);
        const player = this.playerKey(q);
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          createVaultLpAtaIx(op.publicKey, this.d.playProgramId, lpMint),
          playIx({ programId: this.d.playProgramId, operator: op.publicKey, player, poolState: poolId, lpMint, sourceLp: getAssociatedTokenAddressSync(lpMint, op.publicKey), amount: lpRaw }),
        );
        const sig = await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
        q.steps.play = sig; q.playSignature = sig; this.saveQuote(q);
        this.log(`[quote ${id}] play locked ${lpRaw} LP, tx ${sig}`);
      }
      step('LP locked in the vault', q.steps.play);
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
    const lpBalance = async (lpMint: PublicKey) => {
      try { return (await getAccount(conn, getAssociatedTokenAddressSync(lpMint, op.publicKey))).amount; } catch { return 0n; }
    };

    if (!info) {
      // Raydium's creation fee comes out of the operator's SOL: say so, with the number, instead of a simulation error
      const poolFeeSol = Number(feeConfig.createPoolFee ?? 0) / LAMPORTS_PER_SOL;
      const needSol = poolFeeSol + POOL_RENT_SOL;
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
      const after = await lpBalance(lpMint);
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
    const after = await lpBalance(sides.lpMint);
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
