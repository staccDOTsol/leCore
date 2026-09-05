import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { MIN_TOPUP_SOL, NeedsSolError, QUOTE_BUFFER_PCT, computeQuote, jupiterPrices } from '../src/entry.js';
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
