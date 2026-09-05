/**
 * The game as chat commands: the only interface there is. Telegram, Discord and X each parse their
 * own transport and hand text here; the answers are plain text (+ an image url when there is one).
 *
 *   king                    who holds the hill, their card, what the master token reads as now
 *   hall                    the hall of fame
 *   fee                     the current attempt fee and the inference estimate
 *   shill <mint> <pitch>    quote an attempt: a one-time deposit address and the exact amount
 *   paid <quote-id>         "I sent it": settle the deposit (sweep, swap, pool, lock) and fight
 *   help
 */
import fs from 'node:fs';
import path from 'node:path';
import { cardLine, type Card } from './cards.js';
import type { Entry, Quote } from './entry.js';
import type { ChallengeOutcome, Hill, KingRecord } from './hill.js';
import type { Shill } from './judge.js';
import { PITCH } from './pitch.js';

export type Surface = Shill['surface'];
export type Ctx = { surface: Surface; author: string; authorId: string; text: string };
export type Reply = { text: string; image?: string | null; announce?: string | null };

type Pending = { quoteId: string; shill: Shill; authorId: string; createdAt: number };

export class Commands {
  private pending: Record<string, Pending> = {};
  private file: string;

  constructor(private d: { hill: Hill; entry: Entry | null; dataDir: string; masterMint: string | null; explorer: (sig: string) => string; log?: (s: string) => void }) {
    this.file = path.join(d.dataDir, 'pending.json');
    try { this.pending = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Pending>; } catch { this.pending = {}; }
  }
  private save(): void { fs.mkdirSync(this.d.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.pending, null, 2)); }
  private log(s: string): void { (this.d.log ?? (() => {}))(s); }

  /** Pull the command out of a message: leading slash, bot mention, or bare word. */
  static parse(text: string): { cmd: string; args: string[] } | null {
    const cleaned = text.replace(/@\w+/g, ' ').replace(/\s+/g, ' ').trim();
    const m = cleaned.match(/^\/?(king|hall|fee|entry|shill|paid|help|start)\b(?:@\w+)?\s*(.*)$/i);
    if (!m) return null;
    const cmd = m[1].toLowerCase() === 'entry' ? 'fee' : m[1].toLowerCase() === 'start' ? 'help' : m[1].toLowerCase();
    return { cmd, args: m[2] ? m[2].split(' ').filter(Boolean) : [] };
  }

  async handle(ctx: Ctx): Promise<Reply | null> {
    const p = Commands.parse(ctx.text);
    if (!p) return null;
    try {
      switch (p.cmd) {
        case 'king': return this.king();
        case 'hall': return this.hall();
        case 'fee': return this.fee();
        case 'help': return this.help();
        case 'shill': return await this.shill(ctx, p.args);
        case 'paid': return await this.paid(ctx, p.args);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`[${ctx.surface}:${ctx.author}] ${p.cmd} failed: ${msg}`);
      return { text: `that did not work: ${msg.slice(0, 300)}` };
    }
    return null;
  }

  help(): Reply {
    return { text: `${PITCH}\n\nCOMMANDS: king · hall · fee · shill <mint> <pitch> · paid <quote-id>` };
  }

  king(): Reply {
    const k = this.d.hill.king;
    if (!k) return { text: `The hill is EMPTY. First to pay takes it. fee: ${this.d.hill.attemptFee()} SOL worth of your token.` };
    return { text: [
      `KING (reign ${k.reign}): ${k.name} ($${k.symbol}) — crowned by ${k.author} via ${k.surface}`,
      cardLine(k.card),
      `master token now reads: "${k.master.name}" $${k.master.symbol}` + (this.d.masterMint ? `  mint ${this.d.masterMint}` : ''),
      k.master.signature ? `on chain: ${this.d.explorer(k.master.signature)}` : '',
      `pitch: ${k.pitch.slice(0, 400)}`,
      `attempt fee: ${this.d.hill.attemptFee()} SOL worth + inference (~$${this.d.hill.inferenceEstimateUsd().toFixed(3)}) +5%`,
    ].filter(Boolean).join('\n'), image: k.image };
  }

  hall(): Reply {
    const hall = this.d.hill.hallOfFame;
    const k = this.d.hill.king;
    if (!hall.length && !k) return { text: 'Nobody has held the hill yet.' };
    const lines = [...hall, ...(k ? [k] : [])].slice(-15).reverse().map((r: KingRecord) =>
      `#${r.reign} ${r.name} ($${r.symbol}) by ${r.author} — ${new Date(r.crownedAt).toISOString().slice(0, 10)} — power ${r.card.power}${r === k ? '  <- sitting king' : ''}`);
    return { text: `HALL OF FAME\n${lines.join('\n')}` };
  }

  fee(): Reply {
    const s = this.d.hill.snapshot;
    return { text: [
      `attempt fee: ${this.d.hill.attemptFee()} SOL worth of any Jupiter-swappable token (0.25 SOL x 1.01^${s.takeovers})`,
      `+ inference estimate ~$${this.d.hill.inferenceEstimateUsd().toFixed(3)} (paid to the zoo), +5% buffer, quoted in YOUR token`,
      `half of the stake is swapped to the master token; the pair becomes permanent CPMM liquidity locked in the play vault.`,
    ].join('\n') };
  }

  async shill(ctx: Ctx, args: string[]): Promise<Reply> {
    const [mint, ...rest] = args;
    const pitch = rest.join(' ').trim();
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { text: 'usage: shill <mint address> <your pitch>' };
    if (pitch.length < 12) return { text: 'give the pitch at least a sentence. usage: shill <mint> <your pitch>' };
    const shill: Shill = { mint, pitch: pitch.slice(0, 2000), author: ctx.author, surface: ctx.surface };
    if (!this.d.entry) {
      // no play program configured: free play (dry runs)
      const out = await this.d.hill.challenge(shill);
      return this.outcome(out, null);
    }
    const q = await this.d.entry.quote({ player: ctx.author, surface: ctx.surface, mint, playFeeSol: this.d.hill.attemptFee() });
    this.pending[q.id] = { quoteId: q.id, shill, authorId: ctx.authorId, createdAt: Date.now() };
    this.save();
    return { text: [
      `quote ${q.id} for ${ctx.author}:`,
      `send exactly ${q.amountUi} of ${mint}`,
      `to ${q.depositAddress}`,
      `within 30 minutes, then say: paid ${q.id}`,
      `(= ${q.playFeeSol} SOL stake $${q.playFeeUsd.toFixed(2)} + inference $${q.inferenceUsd.toFixed(3)}, +${q.bufferPct}%; one-time address, never reused)`,
    ].join('\n') };
  }

  async paid(ctx: Ctx, args: string[]): Promise<Reply> {
    const id = args[0];
    if (!id) return { text: 'usage: paid <quote-id>' };
    const pend = this.pending[id];
    if (!pend || !this.d.entry) return { text: `no open quote ${id}` };
    if (pend.authorId !== ctx.authorId) return { text: `quote ${id} belongs to someone else` };
    const { quote, paid, balanceRaw } = await this.d.entry.checkDeposit(id);
    if (quote.status === 'expired') { delete this.pending[id]; this.save(); return { text: `quote ${id} expired unpaid. ask for a new one with shill.` }; }
    if (!paid) return { text: `not there yet: ${Number(balanceRaw) / 10 ** quote.decimals} of ${quote.amountUi} at ${quote.depositAddress}. try again in a minute.` };
    const settled = await this.d.entry.settle(id);
    const out = await this.d.hill.challenge(pend.shill, { prepaid: { playSignature: settled.playSignature ?? '', feeSol: settled.playFeeSol } });
    delete this.pending[id]; this.save();
    return this.outcome(out, settled);
  }

  private outcome(out: ChallengeOutcome, q: Quote | null): Reply {
    const won = out.record.result === 'won';
    const c = out.record.challenger as Card | null;
    const lines = [
      out.oneLiner,
      c ? `challenger: ${cardLine(c)}` : '',
      out.record.incumbent ? `king: ${cardLine(out.record.incumbent)}` : '',
      out.commentary,
      won && out.king ? `NEW KING. the master token now reads "${out.king.master.name}" $${out.king.master.symbol}` + (out.king.master.signature ? ` — ${this.d.explorer(out.king.master.signature)}` : '') : '',
      q?.playSignature ? `play locked: ${this.d.explorer(q.playSignature)}` : '',
      out.record.usage ? `inference this attempt: $${out.record.usage.usd.toFixed(4)} via ${out.record.usage.model}` : '',
    ].filter(Boolean);
    return { text: lines.join('\n'), image: won ? out.king?.image ?? null : null, announce: won ? `${out.oneLiner}\n${out.king ? `the master token is now "${out.king.master.name}" $${out.king.master.symbol}` : ''}` : null };
  }
}
