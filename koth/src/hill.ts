/**
 * The hill itself: who is king, what an attempt costs, and what happens when someone takes it.
 *
 * One challenge, in order:
 *   1. the attempt fee is quoted: 0.25 SOL worth of the player's token, x1.01 per takeover so far
 *   2. the entry flow collects it (swap half to the master token, create/deposit the CPMM pool,
 *      lock the LP in the play vault) -- the player only sees "send X"; the LP is the receipt
 *   3. the challenger's token is profiled and turned into a card; so is the king's, fresh
 *   4. the master shillbot writes the king's pitch (cached per reign), then the arbiter judges
 *   5. if the challenger wins: the king's metadata is duped into the master token through
 *      inference, hosted, and written on chain; the old king goes to the hall of fame
 * Every step's cost and outcome is recorded so the ledger and the bots can show it.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cardFromMetrics, type Card } from './cards.js';
import type { ChainLike } from './chain.js';
import { decide, type Contender, type Handicap, type JudgeLike, type Remix, type Shill, type Verdict } from './judge.js';
import type { MetadataFields } from './metadata.js';
import { sumUsage, type Usage } from './openzoo.js';
import { buildKingJson, type UriProvider } from './uri.js';

export type KingRecord = {
  reign: number;
  mint: string;
  name: string;
  symbol: string;
  card: Card;
  pitch: string;
  author: string;
  surface: string;
  crownedAt: number;
  /** True when the hill was empty: an uncontested crown carries a handicap until it is defended for real. */
  uncontested: boolean;
  /** What the master token became: the remixed name/symbol and the hosted uri, plus the tx. */
  master: MetadataFields & { signature: string | null };
  remix: Remix | null;
  image: string | null;
  playSignature: string | null;
  feeSol: number;
  usage: Usage | null;
};

export type ChallengeRecord = {
  id: string;
  at: number;
  /** The reign this challenge was fought against (0 for an empty hill). */
  reign: number;
  mint: string;
  author: string;
  surface: string;
  pitch: string;
  feeSol: number;
  result: 'won' | 'lost' | 'error';
  verdict: Verdict | null;
  usage: Usage | null;
  playSignature: string | null;
  error: string | null;
  challenger: Card | null;
  incumbent: Card | null;
};

export type HillState = {
  king: KingRecord | null;
  hallOfFame: KingRecord[];
  challenges: ChallengeRecord[];
  /** Successful takeovers so far; drives the fee schedule. */
  takeovers: number;
  masterShill: { reign: number; text: string; at: number } | null;
};

export function emptyState(): HillState {
  return { king: null, hallOfFame: [], challenges: [], takeovers: 0, masterShill: null };
}

/** 0.25 SOL worth, +1% per successful takeover (compounding), by directive. */
export function attemptFeeSol(takeovers: number, baseSol = 0.25, growthPct = 1): number {
  return Number((baseSol * Math.pow(1 + growthPct / 100, Math.max(0, takeovers))).toFixed(6));
}

export interface Store {
  load(): HillState;
  save(state: HillState): void;
}

export class MemoryStore implements Store {
  constructor(private state: HillState = emptyState()) {}
  load(): HillState { return structuredClone(this.state); }
  save(state: HillState): void { this.state = structuredClone(state); }
}

/** JSON on disk, written atomically. */
export class FileStore implements Store {
  constructor(private file: string) {}
  load(): HillState {
    if (!fs.existsSync(this.file)) return emptyState();
    return { ...emptyState(), ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<HillState>) };
  }
  save(state: HillState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** The entry flow as the hill sees it: collect the fee as locked LP, return the proof. */
export interface EntryLike {
  play(args: { player: string; mint: string; feeSol: number }): Promise<{ playSignature: string; detail: Record<string, unknown> }>;
}

export class FreeEntry implements EntryLike {
  async play(): Promise<{ playSignature: string; detail: Record<string, unknown> }> {
    return { playSignature: '', detail: { free: true } };
  }
}

export type HillDeps = {
  judge: JudgeLike;
  chain: ChainLike;
  uri: UriProvider;
  entry: EntryLike;
  store: Store;
  /** Renders an image url for a king whose token has none; may return null. */
  image?: (card: Card, reign: number) => Promise<string | null>;
  baseFeeSol?: number;
  feeGrowthPct?: number;
  /** How long the master shillbot's pitch for a reign is reused before it is rewritten. */
  shillTtlMs?: number;
  /** Points the king loses per failed challenge against it (the hill erodes under concerted effort). */
  erosionPerLoss?: number;
  /** Cap on erosion. */
  erosionMax?: number;
  /** Points an uncontested crown (took an empty hill) carries until dethroned. */
  uncontestedHandicap?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export type ChallengeOutcome = { record: ChallengeRecord; king: KingRecord | null; oneLiner: string; commentary: string };

export class Hill {
  private state: HillState;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private deps: HillDeps) {
    this.state = deps.store.load();
  }

  get snapshot(): HillState { return structuredClone(this.state); }
  get king(): KingRecord | null { return this.state.king ? structuredClone(this.state.king) : null; }
  get hallOfFame(): KingRecord[] { return structuredClone(this.state.hallOfFame); }
  attemptFee(): number { return attemptFeeSol(this.state.takeovers, this.deps.baseFeeSol, this.deps.feeGrowthPct); }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /**
   * What the sitting king carries into the next fight. Erosion is read off the ledger (every lost
   * challenge since the crowning), so it applies retroactively to a reign already under siege.
   */
  handicap(): Handicap {
    const k = this.state.king;
    if (!k) return { total: 0, erosion: 0, uncontested: 0, failedDefenses: 0 };
    const failedDefenses = this.state.challenges.filter((c) => c.result === 'lost' && (c.reign === undefined ? c.at > k.crownedAt : c.reign === k.reign)).length;
    const erosion = Math.min(this.deps.erosionMax ?? 40, failedDefenses * (this.deps.erosionPerLoss ?? 5));
    const uncontested = (k.uncontested ?? k.reign === 1) ? (this.deps.uncontestedHandicap ?? 15) : 0;
    return { total: erosion + uncontested, erosion, uncontested, failedDefenses };
  }
  private log(line: string): void { (this.deps.log ?? (() => {}))(line); }
  private save(): void { this.deps.store.save(this.state); }

  private async contender(shill: Shill): Promise<Contender> {
    const p = await this.deps.chain.profile(shill.mint);
    return { card: cardFromMetrics(p.metrics), shill, offchain: p.offchain };
  }

  /** The master shillbot's pitch for the sitting king, rewritten only when stale. */
  async masterShill(incumbent: Contender): Promise<{ text: string; usage: Usage | null }> {
    const k = this.state.king;
    if (!k) return { text: '', usage: null };
    const ttl = this.deps.shillTtlMs ?? 6 * 3600_000;
    const cached = this.state.masterShill;
    if (cached && cached.reign === k.reign && this.now() - cached.at < ttl) return { text: cached.text, usage: null };
    const r = await this.deps.judge.shillFor(incumbent);
    this.state.masterShill = { reign: k.reign, text: r.text, at: this.now() };
    this.save();
    return { text: r.text, usage: r.usage };
  }

  /**
   * What inference has been costing per attempt lately, for the quote: the mean of the last twenty
   * attempts' receipts, or a floor when the ledger is empty.
   */
  inferenceEstimateUsd(floor = 0.05): number {
    const recent = this.state.challenges.slice(-20).map((c) => c.usage?.usd ?? 0).filter((u) => u > 0);
    if (!recent.length) return floor;
    return Math.max(floor, recent.reduce((a, b) => a + b, 0) / recent.length);
  }

  /**
   * Serialized: one battle at a time, so two challengers cannot both dethrone the same king.
   * `prepaid` carries the proof of an entry the bots already settled (throwaway deposit -> locked LP).
   */
  challenge(shill: Shill, opts: { prepaid?: { playSignature: string; feeSol: number } } = {}): Promise<ChallengeOutcome> {
    const run = this.busy.then(() => this.runChallenge(shill, opts));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async runChallenge(shill: Shill, opts: { prepaid?: { playSignature: string; feeSol: number } }): Promise<ChallengeOutcome> {
    const id = randomBytes(6).toString('hex');
    const feeSol = opts.prepaid?.feeSol ?? this.attemptFee();
    const rec: ChallengeRecord = {
      id, at: this.now(), reign: this.state.king?.reign ?? 0, mint: shill.mint, author: shill.author, surface: shill.surface, pitch: shill.pitch, feeSol,
      result: 'error', verdict: null, usage: null, playSignature: null, error: null, challenger: null, incumbent: null,
    };
    const usages: Usage[] = [];
    try {
      // 1-2. the fee, as locked LP (already settled by the bots when prepaid)
      const entry = opts.prepaid ?? await this.deps.entry.play({ player: shill.author, mint: shill.mint, feeSol });
      rec.playSignature = entry.playSignature || null;
      this.log(`[${id}] entry ok fee=${feeSol} SOL play=${rec.playSignature ?? 'free'}`);

      // 3. cards
      const challenger = await this.contender(shill);
      rec.challenger = challenger.card;

      if (!this.state.king) {
        // an empty hill: the first challenger takes it, still paying the fee
        const king = await this.crown(challenger, rec, usages);
        rec.result = 'won';
        rec.usage = usages.length ? sumUsage(usages) : null;
        this.finish(rec);
        return { record: rec, king, oneLiner: `${king.name} takes the empty hill.`, commentary: 'Nobody was home.' };
      }

      const incumbent = await this.contender({ mint: this.state.king.mint, pitch: this.state.king.pitch, author: this.state.king.author, surface: this.state.king.surface as Shill['surface'] });
      rec.incumbent = incumbent.card;

      // 4. the master shillbot speaks for the king, then the arbiter scores; the decision is ours, from the scores
      const ms = await this.masterShill(incumbent);
      if (ms.usage) usages.push(ms.usage);
      const h = this.handicap();
      const j = await this.deps.judge.judge(challenger, incumbent, ms.text, h);
      usages.push(j.usage);
      const d = decide(j.verdict, h);
      if (d.winner !== j.verdict.winner) {
        this.log(`[${id}] arbiter said ${j.verdict.winner}, the scores say ${d.winner} (${d.challengerTotal} vs ${d.incumbentTotal} after a ${h.total}-point handicap)`);
        j.verdict.one_liner = d.winner === 'challenger'
          ? `${challenger.card.name} takes the hill on points: ${d.challengerTotal} to ${d.incumbentTotal} after ${h.total} points of erosion.`
          : `${incumbent.card.name} holds on points: ${d.incumbentTotal} to ${d.challengerTotal}.`;
      }
      j.verdict.winner = d.winner;
      rec.verdict = j.verdict;

      if (d.winner === 'challenger') {
        const king = await this.crown(challenger, rec, usages);
        rec.result = 'won';
        rec.usage = sumUsage(usages);
        this.finish(rec);
        return { record: rec, king, oneLiner: j.verdict.one_liner, commentary: j.verdict.commentary };
      }
      rec.result = 'lost';
      rec.usage = sumUsage(usages);
      this.finish(rec);
      return { record: rec, king: this.king, oneLiner: j.verdict.one_liner, commentary: j.verdict.commentary };
    } catch (e) {
      rec.result = 'error';
      rec.error = e instanceof Error ? e.message : String(e);
      rec.usage = usages.length ? sumUsage(usages) : null;
      this.finish(rec);
      this.log(`[${id}] error ${rec.error}`);
      throw e;
    }
  }

  private finish(rec: ChallengeRecord): void {
    this.state.challenges.push(rec);
    if (this.state.challenges.length > 500) this.state.challenges = this.state.challenges.slice(-500);
    this.save();
  }

  /** 5. the takeover: remix -> host -> rewrite on chain -> record. */
  private async crown(winner: Contender, rec: ChallengeRecord, usages: Usage[]): Promise<KingRecord> {
    const reign = (this.state.king?.reign ?? 0) + 1;
    const current = await this.deps.chain.readMasterMetadata();
    const r = await this.deps.judge.remixMetadata(winner, { name: current.name, symbol: current.symbol });
    usages.push(r.usage);
    const off = winner.offchain ?? {};
    let image = typeof off.image === 'string' ? off.image : null;
    if (!image && this.deps.image) image = await this.deps.image(winner.card, reign);
    const crownedAt = this.now();
    const json = buildKingJson({
      reign, fields: r.fields, description: r.remix.description, tagline: r.remix.tagline, image: image ?? '',
      card: winner.card, author: winner.shill.author, surface: winner.shill.surface, pitch: winner.shill.pitch, crownedAt,
      playSignature: rec.playSignature,
    });
    const uri = await this.deps.uri.host(reign, json);
    const fields: MetadataFields = { name: r.fields.name, symbol: r.fields.symbol, uri };
    const tx = await this.deps.chain.updateMasterMetadata(fields);
    this.log(`[${rec.id}] crowned reign ${reign}: "${fields.name}" $${fields.symbol} ${uri} tx=${tx.signature}`);

    if (this.state.king) this.state.hallOfFame.push(this.state.king);
    const king: KingRecord = {
      reign, mint: winner.card.mint, name: winner.card.name, symbol: winner.card.symbol, card: winner.card,
      pitch: winner.shill.pitch, author: winner.shill.author, surface: winner.shill.surface, crownedAt, uncontested: !this.state.king,
      master: { ...fields, signature: tx.signature || null }, remix: r.remix, image, playSignature: rec.playSignature,
      feeSol: rec.feeSol, usage: usages.length ? sumUsage(usages) : null,
    };
    this.state.king = king;
    this.state.takeovers += 1;
    this.state.masterShill = null;
    this.save();
    return king;
  }
}
