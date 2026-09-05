/**
 * Metrics -> game asset. A token's numbers become a monster-rancher card, deterministically.
 *
 * The mapping is deliberately legible so a player can argue with it:
 *   HP    liquidity (log scale; $10M ~ 100)        -- how much it takes to kill the pair
 *   ATK   24h turnover = volume / liquidity        -- how hard it trades relative to its depth
 *   DEF   distribution: 1 - top-10 share, else holder count on a log scale
 *   SPD   |24h price change| -- volatility is speed, and its sign is a trait (pumping / dumping)
 *   LUCK  buy pressure = buys / (buys + sells), plus a little for age
 * Element comes from the dominant signal, rarity from market cap. Everything is seeded from a hash
 * of the mint plus the rounded snapshot, so the same token at the same moment yields the same card
 * anywhere, and the seed also drives the creature body the renderer draws.
 */
import { createHash } from 'node:crypto';
import type { TokenMetrics } from './metrics.js';

export type Element = 'fire' | 'water' | 'earth' | 'air' | 'void';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type Stats = { hp: number; atk: number; def: number; spd: number; luck: number };

export type CreatureSpec = {
  /** Spine length in engine units (leCore quadruped_spec scale) and segment count. */
  spine: { length: number; segments: number; curve: number };
  /** Limb pairs; empty means a serpent. */
  limbs: { at: number; length: number; radius: number; segments: number }[];
  head: { radius: number };
  /** Skin taxon for leCore's creature_material: scales, chitin, mucus, fur. */
  taxon: 'scales' | 'chitin' | 'mucus' | 'fur';
  pattern: 'spots' | 'stripes' | 'bands' | 'plain';
  /** RGB in 0..1 for the base coat. */
  tint: [number, number, number];
};

export type Card = {
  mint: string;
  name: string;
  symbol: string;
  element: Element;
  rarity: Rarity;
  stats: Stats;
  /** Weighted 1..100 summary used by the battle. */
  power: number;
  traits: string[];
  seed: string;
  creature: CreatureSpec;
  snapshot: Pick<TokenMetrics, 'priceUsd' | 'marketCapUsd' | 'liquidityUsd' | 'volume24hUsd' | 'holders' | 'ageDays' | 'source' | 'fetchedAt'>;
};

const clamp = (x: number, lo = 1, hi = 100) => Math.max(lo, Math.min(hi, Math.round(x)));
const log10p = (x: number) => Math.log10(Math.max(0, x) + 1);

export function cardSeed(m: TokenMetrics): string {
  const round = (x: number) => Number(x.toPrecision(3));
  const s = [m.mint, round(m.priceUsd), round(m.marketCapUsd), round(m.liquidityUsd), round(m.volume24hUsd),
    m.buys24h, m.sells24h, round(m.priceChangePct.h24), m.holders ?? -1].join('|');
  return createHash('sha256').update(s).digest('hex');
}

/** A small deterministic PRNG (mulberry32) seeded from the card hash. */
export function rng(seedHex: string): () => number {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function statsFromMetrics(m: TokenMetrics): Stats {
  const hp = clamp((log10p(m.liquidityUsd) / 7) * 100);
  const turnover = m.liquidityUsd > 0 ? m.volume24hUsd / m.liquidityUsd : 0;
  const atk = clamp(turnover <= 0 ? 5 : 60 + 15 * Math.log2(turnover));
  let def: number;
  if (m.top10Share !== null) def = clamp((1 - m.top10Share) * 100);
  else if (m.holders !== null) def = clamp((log10p(m.holders) / 5) * 100);
  else def = 20;
  const move = Math.abs(m.priceChangePct.h24);
  const spd = clamp(30 + 30 * Math.log10(1 + move / 5));
  const trades = m.buys24h + m.sells24h;
  const pressure = trades > 0 ? m.buys24h / trades : 0.5;
  const age = m.ageDays ?? 0;
  const luck = clamp(pressure * 90 + Math.min(10, log10p(age) * 4));
  return { hp, atk, def, spd, luck };
}

export function elementOf(m: TokenMetrics, s: Stats): Element {
  if (m.liquidityUsd <= 0 && m.marketCapUsd <= 0) return 'void';
  const chg = m.priceChangePct.h24;
  if (chg >= 20) return 'fire';
  if (chg <= -20) return 'water';
  if (s.atk >= 65) return 'air';
  return 'earth';
}

export function rarityOf(m: TokenMetrics): Rarity {
  const mc = Math.max(m.marketCapUsd, m.fdvUsd);
  if (mc >= 100_000_000) return 'legendary';
  if (mc >= 10_000_000) return 'epic';
  if (mc >= 1_000_000) return 'rare';
  if (mc >= 100_000) return 'uncommon';
  return 'common';
}

export function traitsOf(m: TokenMetrics, s: Stats, element: Element): string[] {
  const t: string[] = [];
  if (m.priceChangePct.h24 >= 50) t.push('parabolic');
  else if (m.priceChangePct.h24 >= 20) t.push('pumping');
  else if (m.priceChangePct.h24 <= -50) t.push('capitulating');
  else if (m.priceChangePct.h24 <= -20) t.push('dumping');
  if (m.top10Share !== null && m.top10Share >= 0.5) t.push('whale-held');
  if (m.top10Share !== null && m.top10Share <= 0.15) t.push('well-distributed');
  if ((m.ageDays ?? 0) >= 365) t.push('ancient');
  else if ((m.ageDays ?? 0) < 1 && m.ageDays !== null) t.push('newborn');
  if (s.atk >= 85) t.push('hyperactive');
  if (s.hp <= 20) t.push('paper-thin');
  if (element === 'void') t.push('unindexed');
  if (m.buys24h + m.sells24h === 0) t.push('dormant');
  return t;
}

export function powerOf(s: Stats): number {
  return clamp(0.3 * s.hp + 0.25 * s.atk + 0.2 * s.def + 0.15 * s.spd + 0.1 * s.luck);
}

const TINTS: Record<Element, [number, number, number]> = {
  fire: [0.85, 0.30, 0.12], water: [0.15, 0.40, 0.80], earth: [0.45, 0.36, 0.22],
  air: [0.75, 0.80, 0.88], void: [0.20, 0.12, 0.28],
};

export function creatureOf(s: Stats, element: Element, rarity: Rarity, seed: string): CreatureSpec {
  const r = rng(seed);
  const jitter = (base: number, pct: number) => base * (1 + (r() * 2 - 1) * pct);
  const length = jitter(0.8 + (s.hp / 100) * 1.4, 0.1);
  const segments = 4 + Math.round((s.hp / 100) * 4);
  const limbs: CreatureSpec['limbs'] = [];
  const pairs = element === 'water' ? 0 : element === 'earth' ? 3 : element === 'void' ? 1 : 2;
  const limbLen = jitter(0.5 + (s.spd / 100) * 0.6, 0.15);
  const radius = 0.035 + (s.def / 100) * 0.03;
  for (let i = 0; i < pairs; i++) {
    limbs.push({ at: 0.2 + (0.6 * i) / Math.max(1, pairs - 1), length: limbLen, radius, segments: 3 });
  }
  const taxon: CreatureSpec['taxon'] = element === 'water' ? 'mucus' : element === 'earth' ? 'chitin' : element === 'air' ? 'fur' : 'scales';
  const pattern: CreatureSpec['pattern'] = rarity === 'legendary' ? 'bands' : rarity === 'epic' ? 'stripes' : rarity === 'rare' ? 'spots' : 'plain';
  const base = TINTS[element];
  const tint: [number, number, number] = [
    Math.min(1, jitter(base[0], 0.15)), Math.min(1, jitter(base[1], 0.15)), Math.min(1, jitter(base[2], 0.15)),
  ];
  return {
    spine: { length, segments, curve: (s.luck / 100) * 0.3 },
    limbs, head: { radius: 0.1 + (s.luck / 100) * 0.1 }, taxon, pattern, tint,
  };
}

/** The whole card, from one metrics snapshot. Pure and deterministic. */
export function cardFromMetrics(m: TokenMetrics): Card {
  const seed = cardSeed(m);
  const stats = statsFromMetrics(m);
  const element = elementOf(m, stats);
  const rarity = rarityOf(m);
  return {
    mint: m.mint,
    name: m.name || m.mint.slice(0, 6),
    symbol: m.symbol || '???',
    element, rarity, stats,
    power: powerOf(stats),
    traits: traitsOf(m, stats, element),
    seed,
    creature: creatureOf(stats, element, rarity, seed),
    snapshot: {
      priceUsd: m.priceUsd, marketCapUsd: m.marketCapUsd, liquidityUsd: m.liquidityUsd, volume24hUsd: m.volume24hUsd,
      holders: m.holders, ageDays: m.ageDays, source: m.source, fetchedAt: m.fetchedAt,
    },
  };
}

/** One-line card summary for chat surfaces. */
export function cardLine(c: Card): string {
  const s = c.stats;
  return `${c.name} ($${c.symbol}) · ${c.rarity} ${c.element} · HP ${s.hp} ATK ${s.atk} DEF ${s.def} SPD ${s.spd} LUCK ${s.luck} · power ${c.power}` +
    (c.traits.length ? ` · ${c.traits.join(', ')}` : '');
}
