import { describe, expect, it } from 'vitest';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { JupiterSwapper, MIN_TOPUP_SOL, NeedsSolError, QUOTE_BUFFER_PCT, UltraSwapper, computeQuote, jupiterPrices, waitForIncrease } from '../src/entry.js';
import { BOND_THRESHOLD_TOKEN, MASTER_CURVE_DEFAULTS, ZOO_TOKEN_MINT, masterCurveParams } from '../src/dbc.js';
import { TokenAuthorityOption, TokenType } from '@meteora-ag/dynamic-bonding-curve-sdk';

describe('quote arithmetic', () => {
  it('marks play + inference up 5% and rounds the token amount up to a whole raw unit', () => {
    const q = computeQuote({ playFeeSol: 0.25, inferenceUsd: 0.05, solUsd: 100, tokenUsd: 0.5, decimals: 6 });
    expect(q.playFeeUsd).toBe(25);
    expect(q.totalUsd).toBeCloseTo(25.05 * 1.05, 9);
    expect(q.bufferPct).toBe(QUOTE_BUFFER_PCT);
    expect(q.amountRaw).toBe(String(Math.ceil((25.05 * 1.05) / 0.5 * 1e6)));
    expect(q.amountUi).toBeCloseTo(52.605, 5);
  });
  it('ceil never quotes below the exact amount', () => {
    const q = computeQuote({ playFeeSol: 0.2525, inferenceUsd: 0.0333, solUsd: 143.21, tokenUsd: 0.000013877, decimals: 9 });
    expect(Number(q.amountRaw) / 1e9).toBeGreaterThanOrEqual(q.totalUsd / 0.000013877 - 1e-9);
  });
});

describe('jupiter prices', () => {
  it('reads usdPrice + decimals for SOL and the token from price v3', async () => {
    const f = (async () => new Response(JSON.stringify({
      So11111111111111111111111111111111111111112: { usdPrice: 101.9, decimals: 9 },
      [ZOO_TOKEN_MINT.toBase58()]: { usdPrice: 0.0042, decimals: 6 },
    }))) as unknown as typeof fetch;
    const p = await jupiterPrices(ZOO_TOKEN_MINT.toBase58(), 'https://x', f);
    expect(p).toEqual({ solUsd: 101.9, tokenUsd: 0.0042, decimals: 6 });
    const g = (async () => new Response(JSON.stringify({}))) as unknown as typeof fetch;
    await expect(jupiterPrices('nope', 'https://x', g)).rejects.toThrow(/not priced/);
  });
});

describe('master curve', () => {
  it('is quoted in $TOKEN (6 decimals), bonds at 100M, and keeps update authority with the creator', () => {
    expect(ZOO_TOKEN_MINT).toBeInstanceOf(PublicKey);
    expect(BOND_THRESHOLD_TOKEN).toBe(100_000_000);
    expect(MASTER_CURVE_DEFAULTS.migrationQuoteThreshold).toBe(100_000_000);
    const p = masterCurveParams();
    expect(p.tokenType).toBe(TokenType.SPLToken);
    expect(p.tokenUpdateAuthority).toBe(TokenAuthorityOption.CreatorUpdateAuthority);
    expect(p.tokenDecimal).toBe(6);
    expect(p.curve.length).toBeGreaterThan(0);
    expect(p.migrationQuoteThreshold.toString()).toBe(String(100_000_000 * 1e6));
    const partner = masterCurveParams({ authority: 'partner' });
    expect(partner.tokenUpdateAuthority).toBe(TokenAuthorityOption.PartnerUpdateAuthority);
  });
});

describe('NeedsSolError', () => {
  it('asks for the shortfall rounded up to a cent, never less than the minimum top-up, and names the fee payer', () => {
    const e = new NeedsSolError('FEEPAYER', 0.02, 0.18, 0.15);
    expect(e.topUpSol).toBe(0.16);
    expect(e.message).toMatch(/0.15 SOL to create the pool/);
    expect(e.message).toMatch(/FEEPAYER/);
    expect(new NeedsSolError('F', 0.17, 0.18, 0.15).topUpSol).toBe(MIN_TOPUP_SOL);
    expect(e instanceof Error).toBe(true);
  });
});

describe('UltraSwapper', () => {
  const op = Keypair.generate();
  const conn = new Connection('http://localhost:8899');
  const mintA = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), mintB = new PublicKey('HgtdKCcDUKN8rZNctBrNSJzPsRfPQ6XDMtQkBiU6A9ru');
  const unsignedTx = () => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: op.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message()).serialize()).toString('base64');
  it('orders, signs, executes, and reports the routed amount', async () => {
    const seen: { url: string; body?: Record<string, unknown>; key?: string }[] = [];
    const f = (async (input: unknown, init?: RequestInit) => {
      const url = String(input); const key = (init?.headers as Record<string, string>)['x-api-key'];
      if (url.includes('/ultra/v1/order')) { seen.push({ url, key }); return Response.json({ transaction: unsignedTx(), requestId: 'r1', outAmount: '5', router: 'dflow' }); }
      if (url.endsWith('/ultra/v1/execute')) { const body = JSON.parse(String(init?.body)); seen.push({ url, body, key }); return Response.json({ status: 'Success', signature: 'SIG', outputAmountResult: '7' }); }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const r = await new UltraSwapper(conn, op, { apiKey: 'jup_x', fetchImpl: f }).swap({ inputMint: mintA, outputMint: mintB, amountRaw: 100n });
    expect(r).toEqual({ signature: 'SIG', outAmountRaw: 7n });
    expect(seen[0].url).toContain(`taker=${op.publicKey.toBase58()}`);
    expect(seen[0].key).toBe('jup_x');
    expect(seen[1].body?.requestId).toBe('r1');
    const signed = VersionedTransaction.deserialize(Buffer.from(String(seen[1].body?.signedTransaction), 'base64'));
    expect(signed.signatures[0].some((b) => b !== 0)).toBe(true);
  });
  it('falls back to the swap api when Ultra has no order', async () => {
    const f = (async () => Response.json({ transaction: null, errorMessage: 'Insufficient funds' })) as typeof fetch;
    const fallback = { swap: async () => ({ signature: 'CLASSIC', outAmountRaw: 1n }) };
    const r = await new UltraSwapper(conn, op, { apiKey: 'k', fetchImpl: f, fallback }).swap({ inputMint: mintA, outputMint: mintB, amountRaw: 1n });
    expect(r.signature).toBe('CLASSIC');
    await expect(new UltraSwapper(conn, op, { apiKey: 'k', fetchImpl: f }).swap({ inputMint: mintA, outputMint: mintB, amountRaw: 1n })).rejects.toThrow(/Insufficient funds/);
  });
});

describe('waitForIncrease', () => {
  it('re-reads until the balance rises, then returns it', async () => {
    const reads = [0n, 0n, 5192477349n];
    let slept = 0;
    const v = await waitForIncrease(async () => reads.shift() ?? 5192477349n, 0n, { sleep: async () => { slept++; }, attempts: 5 });
    expect(v).toBe(5192477349n);
    expect(slept).toBe(2);
  });
  it('gives up with a resumable message instead of returning zero', async () => {
    await expect(waitForIncrease(async () => 7n, 7n, { sleep: async () => {}, attempts: 3 })).rejects.toThrow(/say paid again/);
  });
});

/** A connection that answers what the swappers ask without a chain: mints are 6-decimal classic mints, sends succeed and are recorded. */
function fakeConn(sent: string[]): Connection {
  const conn = new Connection('http://localhost:8899');
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const stub = conn as unknown as Record<string, unknown>;
  stub.getAccountInfo = async () => ({ owner: TOKEN_PROGRAM_ID, data: mintData, lamports: 1, executable: false });
  stub.getLatestBlockhash = async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 });
  stub.sendRawTransaction = async (raw: Uint8Array) => { try { sent.push(VersionedTransaction.deserialize(raw).message.staticAccountKeys[0].toBase58()); } catch { sent.push('legacy'); } return 'SIG'; };
  stub.sendTransaction = async () => 'SIG';
  stub.confirmTransaction = async () => ({ value: { err: null } });
  stub.getBalance = async () => 1;
  return conn;
}

describe('SOL on either side never touches the operator\'s wrapped-SOL account', () => {
  const op = Keypair.generate();
  const sent: string[] = [];
  const conn = fakeConn(sent);
  const SOL = new PublicKey('So11111111111111111111111111111111111111112'), USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const unsignedTx = (payer: PublicKey) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message()).serialize()).toString('base64');
  const runnerFor = (spawned: Keypair[], swept: number[]) => async (lamports: bigint) => { const keypair = Keypair.generate(); spawned.push(keypair); swept.push(0); return { keypair, sweep: async () => { swept[swept.length - 1]++; }, lamports }; };

  it('ultra: a one-time taker signs a SOL-in order; the sweep runs even when the swap fails', async () => {
    const spawned: Keypair[] = [], swept: number[] = [];
    const takers: string[] = [];
    let fail = false;
    const f = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/ultra/v1/order')) { const t = new URL(url).searchParams.get('taker')!; takers.push(t); return fail ? Response.json({ transaction: null, errorMessage: 'nope' }) : Response.json({ transaction: unsignedTx(new PublicKey(t)), requestId: 'r', outAmount: '9' }); }
      if (url.endsWith('/ultra/v1/execute')) {
        const signed = VersionedTransaction.deserialize(Buffer.from(JSON.parse(String(init?.body)).signedTransaction, 'base64'));
        expect(signed.signatures[0].some((b) => b !== 0)).toBe(true);
        return Response.json({ status: 'Success', signature: 'SIG', outputAmountResult: '9' });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    // SOL -> USDC, output for the operator itself: no forward needed, so nothing hits the chain
    const s = new UltraSwapper(conn, op, { apiKey: 'k', fetchImpl: f, solRunner: runnerFor(spawned, swept) });
    const r = await s.swap({ inputMint: SOL, outputMint: USDC, amountRaw: 1_000_000n, destinationOwner: op.publicKey });
    expect(r.outAmountRaw).toBe(9n);
    expect(spawned).toHaveLength(1);
    expect(takers[0]).toBe(spawned[0].publicKey.toBase58());
    expect(takers[0]).not.toBe(op.publicKey.toBase58());
    expect(swept).toEqual([1]);
    fail = true;
    await expect(s.swap({ inputMint: SOL, outputMint: USDC, amountRaw: 1n })).rejects.toThrow(/nope/);
    expect(swept).toEqual([1, 1]);                                       // swept after the failure too
  });

  it('classic: SOL-in swaps run as the one-time signer with wrapping on; token swaps run as the operator with wrapping off', async () => {
    const spawned: Keypair[] = [], swept: number[] = [];
    const bodies: { userPublicKey: string; wrapAndUnwrapSol: boolean }[] = [];
    const f = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/swap/v1/quote')) return Response.json({ outAmount: '5', inputMint: 'x' });
      if (url.endsWith('/swap/v1/swap')) { const b = JSON.parse(String(init?.body)); bodies.push(b); return Response.json({ swapTransaction: unsignedTx(new PublicKey(b.userPublicKey)) }); }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    sent.length = 0;
    const s = new JupiterSwapper(conn, op, { fetchImpl: f, solRunner: runnerFor(spawned, swept) });
    await s.swap({ inputMint: SOL, outputMint: USDC, amountRaw: 7n });                        // SOL in
    expect(bodies[0].userPublicKey).toBe(spawned[0].publicKey.toBase58());
    expect(bodies[0].wrapAndUnwrapSol).toBe(true);
    expect(sent).toContain(spawned[0].publicKey.toBase58());                                  // the swap itself was signed and sent by the runner
    expect(swept).toEqual([1]);
    await s.swap({ inputMint: USDC, outputMint: new PublicKey('HgtdKCcDUKN8rZNctBrNSJzPsRfPQ6XDMtQkBiU6A9ru'), amountRaw: 7n });   // no SOL
    expect(bodies[1].userPublicKey).toBe(op.publicKey.toBase58());
    expect(bodies[1].wrapAndUnwrapSol).toBe(false);
    expect(spawned).toHaveLength(1);
  });
});
