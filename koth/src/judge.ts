/**
 * The inference layer, all of it through openzoo (openzoo.fun) by directive:
 *
 *   shillFor        the master shillbot writes the CURRENT KING's pitch -- it shills the previous
 *                   winner's bullshit, which is the whole loop
 *   judge           scores challenger vs incumbent and names a winner, as a typed verdict
 *   remixMetadata   "the current king gets his metadata duped into ours, ran thru inference":
 *                   the king's name/symbol/description become the master token's, rewritten
 *
 * Every call returns its receipt (routed model, tokens, USD billed by the zoo) so the ledger shows
 * what an attempt cost. The attempt FEE is separate and fixed by directive (hill.ts).
 */
import { z } from 'zod';
import { cardLine, type Card } from './cards.js';
import { clampMetadata, type MetadataFields } from './metadata.js';
import { OpenzooClient, sumUsage, type ChatMessage, type Usage } from './openzoo.js';

export type { Usage } from './openzoo.js';

/** What a player brings to the hill: a token and their pitch for it. */
export type Shill = { mint: string; pitch: string; author: string; surface: 'telegram' | 'discord' | 'x' | 'cli' };

export type Contender = {
  card: Card;
  shill: Shill;
  /** The token's own off-chain JSON (description, image, links) when it has one. */
  offchain: Record<string, unknown> | null;
};

const score = z.coerce.number().min(0).max(100);
const SideScore = z.object({ persuasion: score, originality: score, coherence: score, degeneracy: score });

export const Verdict = z.object({
  winner: z.enum(['challenger', 'incumbent']),
  challenger: SideScore,
  incumbent: SideScore,
  commentary: z.string(),
  one_liner: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

export const Remix = z.object({
  name: z.string(),
  symbol: z.string(),
  description: z.string(),
  tagline: z.string(),
});
export type Remix = z.infer<typeof Remix>;

export interface JudgeLike {
  shillFor(c: Contender, opts?: { maxChars?: number }): Promise<{ text: string; usage: Usage }>;
  judge(challenger: Contender, incumbent: Contender, incumbentPitch: string): Promise<{ verdict: Verdict; usage: Usage }>;
  remixMetadata(king: Contender, master: { name: string; symbol: string }): Promise<{ remix: Remix; fields: Omit<MetadataFields, 'uri'>; usage: Usage }>;
}

export const SYSTEM = `You are the MASTER SHILLBOT, the arbiter and hype-man of King of the Hill: a game where people shill
their token to knock the current king off the hill. Tokens are turned into monster-rancher cards from their real
on-chain metrics (HP=liquidity, ATK=turnover, DEF=distribution, SPD=volatility, LUCK=buy pressure). You judge
pitches, not prices: a pitch that lies about its numbers loses coherence. You are funny, sharp, a little cruel, and
never generic. You never invent metrics. Financial advice is not a thing you give; this is a game.`;

export function describeContender(c: Contender): string {
  const off = c.offchain ?? {};
  const desc = typeof off.description === 'string' ? off.description.slice(0, 600) : '';
  const s = c.card.snapshot;
  return [
    `Token: ${c.card.name} ($${c.card.symbol}) mint ${c.card.mint}`,
    `Card: ${cardLine(c.card)}`,
    `Snapshot: price $${s.priceUsd}, mcap $${Math.round(s.marketCapUsd)}, liquidity $${Math.round(s.liquidityUsd)}, ` +
      `24h volume $${Math.round(s.volume24hUsd)}, holders ${s.holders ?? 'unknown'}, age ${s.ageDays === null ? 'unknown' : Math.round(s.ageDays) + 'd'}`,
    desc ? `Their own description: ${desc}` : '',
    `Pitch by ${c.shill.author} (${c.shill.surface}): """${c.shill.pitch.slice(0, 2000)}"""`,
  ].filter(Boolean).join('\n');
}

const VERDICT_SHAPE = `{"winner":"challenger"|"incumbent","challenger":{"persuasion":0-100,"originality":0-100,"coherence":0-100,"degeneracy":0-100},"incumbent":{same},"commentary":"3-6 sentences of ring-announcer play-by-play","one_liner":"one sentence under 200 chars announcing the result"}`;
const REMIX_SHAPE = `{"name":"at most 32 bytes","symbol":"at most 10 bytes, uppercase, no $","description":"2-3 sentences in the master shillbot's voice, grounded in the numbers","tagline":"under 120 characters"}`;

export class Judge implements JudgeLike {
  readonly zoo: OpenzooClient;
  constructor(zoo?: OpenzooClient) { this.zoo = zoo ?? new OpenzooClient(); }

  private msgs(user: string): ChatMessage[] {
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  }

  async shillFor(c: Contender, opts: { maxChars?: number } = {}): Promise<{ text: string; usage: Usage }> {
    const maxChars = opts.maxChars ?? 900;
    const r = await this.zoo.chat(this.msgs(
      `You currently hold the hill for this token. Write its shill as the master shillbot: under ${maxChars} characters, ` +
      `plain text, no hashtag spam, no markdown, one killer angle grounded in the card and numbers below. Output only the shill.\n\n${describeContender(c)}`,
    ), { maxTokens: 600, temperature: 0.9 });
    return { text: r.text.slice(0, maxChars), usage: r.usage };
  }

  async judge(challenger: Contender, incumbent: Contender, incumbentPitch: string): Promise<{ verdict: Verdict; usage: Usage }> {
    const inc: Contender = { ...incumbent, shill: { ...incumbent.shill, pitch: incumbentPitch, author: 'the master shillbot' } };
    const r = await this.zoo.chatJson(this.msgs(
      `Judge this battle for the hill. Score both sides 0-100 on each axis, then pick the winner: the higher total wins, ` +
      `but a challenger only takes the hill if it clearly beats the incumbent (ties go to the king). The cards' power is ` +
      `context, not the verdict. Reply with ONLY a JSON object shaped exactly like:\n${VERDICT_SHAPE}\n\n` +
      `== CHALLENGER ==\n${describeContender(challenger)}\n\n== INCUMBENT (king) ==\n${describeContender(inc)}`,
    ), Verdict, { maxTokens: 900 });
    return { verdict: r.value, usage: r.usage };
  }

  async remixMetadata(king: Contender, master: { name: string; symbol: string }): Promise<{ remix: Remix; fields: Omit<MetadataFields, 'uri'>; usage: Usage }> {
    const r = await this.zoo.chatJson(this.msgs(
      `${king.card.name} ($${king.card.symbol}) just took the hill. The master token (currently "${master.name}" / $${master.symbol}) ` +
      `now wears the king's identity: dupe the king's metadata into the master token, run through you. The name must read as ` +
      `"${king.card.name}" crowned (at most 32 bytes), the symbol derived from $${king.card.symbol} (at most 10 bytes, uppercase, no $). ` +
      `Reply with ONLY a JSON object shaped exactly like:\n${REMIX_SHAPE}\n\n${describeContender(king)}`,
    ), Remix, { maxTokens: 500 });
    const remix = r.value;
    const f = clampMetadata({ name: remix.name, symbol: remix.symbol.replace(/^\$+/, '').toUpperCase(), uri: '' });
    return { remix, fields: { name: f.name, symbol: f.symbol }, usage: r.usage };
  }
}

/** Deterministic stand-in for tests and dry runs: no network, no zoo. */
export class MockJudge implements JudgeLike {
  constructor(private bias: 'power' | 'challenger' | 'incumbent' = 'power') {}
  private usage(): Usage { return { model: 'mock', inputTokens: 1000, outputTokens: 200, usd: 0.01, billed: false }; }
  async shillFor(c: Contender): Promise<{ text: string; usage: Usage }> {
    return { text: `${c.card.name} sits on the hill with ${c.card.stats.hp} HP of liquidity. Come and take it.`, usage: this.usage() };
  }
  async judge(challenger: Contender, incumbent: Contender): Promise<{ verdict: Verdict; usage: Usage }> {
    const cw = this.bias === 'challenger' || (this.bias === 'power' && challenger.card.power > incumbent.card.power);
    const side = (p: number) => ({ persuasion: p, originality: p, coherence: p, degeneracy: p });
    return {
      verdict: {
        winner: cw ? 'challenger' : 'incumbent', challenger: side(challenger.card.power), incumbent: side(incumbent.card.power),
        commentary: `${challenger.card.name} (${challenger.card.power}) vs ${incumbent.card.name} (${incumbent.card.power}).`,
        one_liner: cw ? `${challenger.card.name} takes the hill!` : `${incumbent.card.name} holds the hill.`,
      },
      usage: this.usage(),
    };
  }
  async remixMetadata(king: Contender): Promise<{ remix: Remix; fields: Omit<MetadataFields, 'uri'>; usage: Usage }> {
    const remix: Remix = { name: `KING ${king.card.name}`, symbol: `K${king.card.symbol}`, description: `${king.card.name} rules the hill.`, tagline: 'long live the king' };
    const f = clampMetadata({ name: remix.name, symbol: remix.symbol.toUpperCase(), uri: '' });
    return { remix, fields: { name: f.name, symbol: f.symbol }, usage: this.usage() };
  }
}

export { sumUsage };
