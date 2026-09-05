import { describe, expect, it } from 'vitest';
import { cardFromMetrics, cardLine, rng, statsFromMetrics } from '../src/cards.js';
import { emptyMetrics, type TokenMetrics } from '../src/metrics.js';

function metrics(over: Partial<TokenMetrics> = {}): TokenMetrics {
  return {
    ...emptyMetrics('So11111111111111111111111111111111111111112'),
    name: 'Wrapped SOL', symbol: 'SOL', priceUsd: 150, marketCapUsd: 70e9, fdvUsd: 80e9, liquidityUsd: 50e6,
    volume24hUsd: 500e6, buys24h: 60_000, sells24h: 40_000, priceChangePct: { h1: 1, h6: 3, h24: 12 },
    holders: 2_000_000, top10Share: 0.1, ageDays: 1500, supply: 500e6, source: 'dexscreener', fetchedAt: 1,
    ...over,
  };
}

describe('cards', () => {
  it('is deterministic for the same snapshot', () => {
    const a = cardFromMetrics(metrics());
    const b = cardFromMetrics(metrics());
    expect(a).toEqual(b);
    expect(a.seed).toHaveLength(64);
  });

  it('changes when the metrics change', () => {
    const a = cardFromMetrics(metrics());
    const b = cardFromMetrics(metrics({ liquidityUsd: 1000 }));
    expect(a.seed).not.toEqual(b.seed);
    expect(b.stats.hp).toBeLessThan(a.stats.hp);
  });

  it('keeps every stat inside 1..100 across extreme inputs', () => {
    const cases = [
      metrics(), metrics({ liquidityUsd: 0, volume24hUsd: 0, marketCapUsd: 0, fdvUsd: 0, buys24h: 0, sells24h: 0, holders: null, top10Share: null, ageDays: null }),
      metrics({ liquidityUsd: 1e12, volume24hUsd: 1e15, priceChangePct: { h1: 0, h6: 0, h24: 100000 }, buys24h: 1e9, sells24h: 0 }),
      metrics({ priceChangePct: { h1: 0, h6: 0, h24: -99 }, buys24h: 0, sells24h: 10 }),
    ];
    for (const m of cases) {
      const c = cardFromMetrics(m);
      for (const v of Object.values(c.stats)) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(100); }
      expect(c.power).toBeGreaterThanOrEqual(1); expect(c.power).toBeLessThanOrEqual(100);
    }
  });

  it('maps signals to elements, rarity and traits legibly', () => {
    expect(cardFromMetrics(metrics()).rarity).toBe('legendary');
    expect(cardFromMetrics(metrics({ marketCapUsd: 5e5, fdvUsd: 5e5 })).rarity).toBe('uncommon');
    expect(cardFromMetrics(metrics({ priceChangePct: { h1: 0, h6: 0, h24: 60 } })).element).toBe('fire');
    expect(cardFromMetrics(metrics({ priceChangePct: { h1: 0, h6: 0, h24: -60 } })).element).toBe('water');
    expect(cardFromMetrics(metrics({ liquidityUsd: 0, marketCapUsd: 0, fdvUsd: 0 })).element).toBe('void');
    const c = cardFromMetrics(metrics({ priceChangePct: { h1: 0, h6: 0, h24: 60 }, top10Share: 0.7 }));
    expect(c.traits).toContain('parabolic');
    expect(c.traits).toContain('whale-held');
    expect(cardLine(c)).toMatch(/power \d+/);
  });

  it('distribution raises DEF and thin liquidity lowers HP', () => {
    expect(statsFromMetrics(metrics({ top10Share: 0.05 })).def).toBeGreaterThan(statsFromMetrics(metrics({ top10Share: 0.8 })).def);
    expect(statsFromMetrics(metrics({ liquidityUsd: 100 })).hp).toBeLessThan(30);
  });

  it('rng is a deterministic stream in [0,1)', () => {
    const a = rng('deadbeef'); const b = rng('deadbeef');
    for (let i = 0; i < 100; i++) { const x = a(); expect(x).toBe(b()); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
});

describe('card images', async () => {
  const { FileImageProvider, svgToPng } = await import('../src/assets.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  it('rasterizes the SVG card to a PNG beside it and returns the PNG url', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koth-img-'));
    const card = cardFromMetrics(metrics({ name: 'Bonk', symbol: 'BONK', liquidityUsd: 1e6, volume24hUsd: 2e5, holders: 1000, marketCapUsd: 1e7 }));
    const url = await new FileImageProvider(dir, 'https://host/').image(card, 3);
    expect(url).toBe('https://host/assets/3.png');
    expect(fs.readFileSync(path.join(dir, 'assets', '3.png')).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(fs.existsSync(path.join(dir, 'assets', '3.svg'))).toBe(true);
    expect((await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'))?.length).toBeGreaterThan(30);
  });
});
