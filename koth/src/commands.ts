/**
 * The game as chat commands: the only interface there is. Telegram, Discord and X each parse their
 * own transport and hand text here; every reply is written once as a rich message and rendered per
 * surface (HTML for Telegram, plain text elsewhere), with inline buttons where the surface has them.
 *
 *   king                    who holds the hill, their card, what the master token reads as now
 *   hall                    the hall of fame
 *   fee                     the current attempt fee and the inference estimate
 *   shill <mint> <pitch>    quote an attempt: a one-time deposit address and the exact amount
 *   paid <quote-id>         "I sent it": settle the deposit (sweep, swap, pool, lock) and fight
 *   cancel <quote-id>       drop an unpaid quote
 *   help
 */
import fs from 'node:fs';
import path from 'node:path';
import { cardLine, type Card } from './cards.js';
import type { Entry, Quote } from './entry.js';
import type { ChallengeOutcome, Hill, KingRecord } from './hill.js';
import type { Shill } from './judge.js';
import { PITCH, PITCH_SHORT } from './pitch.js';

export type Surface = Shill['surface'];

/** Markup-neutral formatting: each surface renders the same message its own way. */
export type Fmt = {
  html: boolean;
  esc: (s: string) => string;
  b: (s: string) => string;
  i: (s: string) => string;
  code: (s: string) => string;
  pre: (s: string) => string;
  link: (label: string, url: string) => string;
  muted: (s: string) => string;
};

const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export const HTML: Fmt = {
  html: true, esc: escHtml, b: (s) => `<b>${escHtml(s)}</b>`, i: (s) => `<i>${escHtml(s)}</i>`,
  code: (s) => `<code>${escHtml(s)}</code>`, pre: (s) => `<pre>${escHtml(s)}</pre>`,
  link: (label, url) => `<a href="${escHtml(url)}">${escHtml(label)}</a>`, muted: (s) => escHtml(s),
};
export const PLAIN: Fmt = {
  html: false, esc: (s) => s, b: (s) => s, i: (s) => s, code: (s) => s, pre: (s) => s,
  link: (label, url) => `${label}: ${url}`, muted: (s) => s,
};

export type Button = { label: string; data?: string; url?: string; copy?: string };
export type Rich = (f: Fmt) => string;
export type Reply = {
  rich: Rich;
  image?: string | null;
  buttons?: Button[][];
  /** Broadcast to the group/channel/feed (takeovers). */
  announce?: Rich | null;
  announceButtons?: Button[][];
};
export const plain = (r: Rich) => r(PLAIN);
export const html = (r: Rich) => r(HTML);

export type Ctx = {
  surface: Surface;
  author: string;
  authorId: string;
  text: string;
  /** Surfaces that can show a live status line (Telegram edits one message) pass this. */
  progress?: (f: Rich) => Promise<void>;
};

type Pending = { quoteId: string; shill: Shill; authorId: string; createdAt: number };

const BTN = {
  king: { label: 'Who is king', data: 'cmd:king' }, fee: { label: 'Fee', data: 'cmd:fee' }, help: { label: 'How to play', data: 'cmd:help' },
  hall: { label: 'Hall of fame', data: 'cmd:hall' }, challenge: { label: 'Challenge the king', data: 'cmd:challenge' },
};

export class Commands {
  private pending: Record<string, Pending> = {};
  private file: string;

  constructor(private d: { hill: Hill; entry: Entry | null; dataDir: string; masterMint: string | null; explorer: (sig: string) => string; log?: (s: string) => void }) {
    this.file = path.join(d.dataDir, 'pending.json');
    try { this.pending = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Pending>; } catch { this.pending = {}; }
  }
  private save(): void { fs.mkdirSync(this.d.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.pending, null, 2)); }
  private log(s: string): void { (this.d.log ?? (() => {}))(s); }

  /** Pull the command out of a message: leading slash, bot mention, bare word, or a button's callback data. */
  static parse(text: string): { cmd: string; args: string[] } | null {
    const cb = text.match(/^cmd:(\w+)$/) ?? text.match(/^(paid|cancel|addr):([A-Za-z0-9_-]+)$/);
    if (cb) return cb[2] ? { cmd: cb[1], args: [cb[2]] } : { cmd: cb[1], args: [] };
    // drop mentions, then anything before the first word (the ".@bot king" convention, quotes, dashes) -- a leading slash survives
    const cleaned = text.replace(/@\w+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z/]+/, '');
    const m = cleaned.match(/^\/?(king|hall|fee|entry|shill|paid|cancel|help|start|challenge)\b(?:@\w+)?\s*(.*)$/i);
    if (!m) return null;
    const raw = m[1].toLowerCase();
    const cmd = raw === 'entry' ? 'fee' : raw === 'start' ? 'help' : raw;
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
        case 'challenge': return { rich: (f) => `${f.b('to challenge the king:')}\n${f.code('shill <mint> <your pitch>')}\n${f.muted('any Jupiter-tradable coin. sell it.')}`, buttons: [[BTN.king, BTN.fee]] };
        case 'shill': return await this.shill(ctx, p.args);
        case 'paid': return await this.paid(ctx, p.args);
        case 'cancel': return this.cancel(ctx, p.args);
        case 'addr': return this.addr(ctx, p.args);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`[${ctx.surface}:${ctx.author}] ${p.cmd} failed: ${msg}`);
      return { rich: (f) => `that did not work: ${f.esc(msg.slice(0, 300))}` };
    }
    return null;
  }

  help(): Reply {
    return {
      rich: (f) => f.html
        ? `${f.b('KING OF THE HILL')}\n\nOne coin wears the crown. The crown is a real token whose ${f.b('name, ticker and image get rewritten on-chain')} to whoever holds the hill.\n\nShill your coin. Beat the king. The master token becomes yours, remixed by the AI. Lose and you are in the hall of fame.\n\n${f.muted('Every attempt is permanent liquidity for <yourcoin>/MASTER. Nobody can pull it, including us.')}\n\n${f.b('How to play')} (each line is its own message):\n${f.code('shill <mint> <your pitch>')}  ${f.muted('start an attempt: you get a deposit address, an amount, and a quote id')}\n${f.code('paid <quote-id>')}  ${f.muted('the quote id from your shill, once you have sent the coins')}\n${f.code('king')}  ${f.muted('who holds the hill')}\n${f.code('hall')}  ${f.muted('hall of fame: every king so far')}\n${f.code('fee')}  ${f.muted('the current attempt fee')}`
        : `${PITCH}\n\nHOW TO PLAY (each line is its own message):\n  shill <mint> <your pitch>   start an attempt: you get a deposit address, an amount, and a quote id\n  paid <quote-id>             the quote id from your shill, once you have sent the coins\n  king                        who holds the hill\n  hall                        hall of fame: every king so far\n  fee                         the current attempt fee`,
      buttons: [[BTN.king, BTN.fee], [{ label: 'How to play', data: 'cmd:help' }]],
    };
  }

  king(): Reply {
    const k = this.d.hill.king;
    const fee = this.d.hill.attemptFee();
    if (!k) return { rich: (f) => `The hill is ${f.b('EMPTY')}. First to pay takes it.\n${PITCH_SHORT}\n\nattempt fee: ${f.b(`${fee} SOL`)} worth of your coin`, buttons: [[BTN.challenge], [BTN.fee, BTN.help]] };
    const s = k.card.stats;
    const buttons: Button[][] = [[BTN.challenge], [BTN.hall, ...(k.master.signature ? [{ label: 'Solscan', url: this.d.explorer(k.master.signature) }] : [])]];
    return {
      rich: (f) => [
        f.muted(`KING · REIGN ${k.reign}`),
        f.b(`${k.name} $${k.symbol}`),
        f.code(`HP ${s.hp} · ATK ${s.atk} · DEF ${s.def} · SPD ${s.spd} · LUCK ${s.luck} · power ${k.card.power}`),
        f.muted(`${k.card.rarity} ${k.card.element}${k.card.traits.length ? ' · ' + k.card.traits.join(', ') : ''}`),
        '',
        `The master token now reads ${f.b(k.master.name)} ${f.code('$' + k.master.symbol)}` + (this.d.masterMint ? `\n${f.code(this.d.masterMint)}` : ''),
        f.muted(`crowned by ${k.author} via ${k.surface} · ${ago(k.crownedAt)}`),
        '',
        `attempt fee ${f.b(`${fee} SOL`)} worth + inference ~$${this.d.hill.inferenceEstimateUsd().toFixed(2)}, +5%`,
        f.i(k.pitch.slice(0, 300)),
      ].join('\n'),
      image: k.image, buttons,
    };
  }

  hall(): Reply {
    const hall = this.d.hill.hallOfFame;
    const k = this.d.hill.king;
    if (!hall.length && !k) return { rich: () => 'Nobody has held the hill yet.', buttons: [[BTN.challenge]] };
    const rows = [...hall, ...(k ? [k] : [])].slice(-15).reverse();
    const snap = this.d.hill.snapshot;
    const locked = snap.challenges.filter((c) => c.result !== 'error').reduce((a, c) => a + c.feeSol, 0);
    return {
      rich: (f) => [
        f.muted('HALL OF FAME'),
        ...rows.map((r: KingRecord) => `#${r.reign} ${f.b(r.name)} ${f.code('$' + r.symbol)} · ${f.esc(r.author)} · ${day(r.crownedAt)} · power ${r.card.power}${r === k ? ` ${f.b('← sitting king')}` : ''}`),
        '',
        f.muted(`${snap.takeovers} reigns · ${snap.challenges.length} attempts · ${locked.toFixed(2)} SOL worth locked as liquidity`),
      ].join('\n'),
      buttons: [[BTN.king, BTN.challenge]],
    };
  }

  fee(): Reply {
    const s = this.d.hill.snapshot;
    return {
      rich: (f) => [
        `attempt fee: ${f.b(`${this.d.hill.attemptFee()} SOL`)} worth of any Jupiter-swappable coin ${f.muted(`(0.25 SOL × 1.01^${s.takeovers})`)}`,
        `+ inference ~$${this.d.hill.inferenceEstimateUsd().toFixed(3)} (paid to the zoo), +5% buffer, quoted in ${f.b('your')} coin`,
        f.muted('half the stake is swapped to the master token; the pair becomes permanent CPMM liquidity locked in the play vault.'),
      ].join('\n'),
      buttons: [[BTN.challenge], [BTN.king, BTN.help]],
    };
  }

  async shill(ctx: Ctx, args: string[]): Promise<Reply> {
    const [mint, ...rest] = args;
    const pitch = rest.join(' ').trim();
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { rich: (f) => `usage: ${f.code('shill <mint address> <your pitch>')}` };
    if (pitch.length < 12) return { rich: (f) => `give the pitch at least a sentence.\nusage: ${f.code('shill <mint> <your pitch>')}` };
    const shill: Shill = { mint, pitch: pitch.slice(0, 2000), author: ctx.author, surface: ctx.surface };
    if (!this.d.entry) {
      const out = await this.d.hill.challenge(shill);          // no play program configured: free play (dry runs)
      return this.outcome(out, null);
    }
    const q = await this.d.entry.quote({ player: ctx.author, surface: ctx.surface, mint, playFeeSol: this.d.hill.attemptFee() });
    this.pending[q.id] = { quoteId: q.id, shill, authorId: ctx.authorId, createdAt: Date.now() };
    this.save();
    return {
      rich: (f) => [
        f.muted(`QUOTE ${q.id} · ${ctx.author}`),
        `send exactly ${f.code(`${q.amountUi}`)} of ${f.code(mint)}`,
        'to this one-time address',
        f.pre(q.depositAddress),
        f.muted('never reused · deleted after sweep · expires in 30 min'),
        f.code(`${q.playFeeSol} SOL stake ≈ $${q.playFeeUsd.toFixed(2)} + inference ≈ $${q.inferenceUsd.toFixed(2)} · +${q.bufferPct}%`),
        `then say ${f.code(`paid ${q.id}`)}. half becomes liquidity for your coin/MASTER, locked for good.`,
      ].join('\n'),
      buttons: [[{ label: 'Copy amount', copy: `${q.amountUi}`, data: `amt:${q.id}` }, { label: 'Copy address', copy: q.depositAddress, data: `addr:${q.id}` }], [{ label: 'I paid', data: `paid:${q.id}` }], [{ label: 'Cancel', data: `cancel:${q.id}` }]],
    };
  }

  addr(ctx: Ctx, args: string[]): Reply {
    const pend = this.pending[args[0] ?? ''];
    const q = pend && this.d.entry ? this.d.entry.loadQuote(pend.quoteId) : null;
    if (!q) return { rich: () => `no open quote ${args[0] ?? ''}` };
    return { rich: (f) => f.pre(q.depositAddress) };
  }

  cancel(ctx: Ctx, args: string[]): Reply {
    const id = args[0];
    const pend = id ? this.pending[id] : undefined;
    if (!pend) return { rich: () => `no open quote ${id ?? ''}` };
    if (pend.authorId !== ctx.authorId) return { rich: () => `quote ${id} belongs to someone else` };
    delete this.pending[id]; this.save();
    return { rich: (f) => `quote ${f.code(id)} cancelled. nothing was moved.`, buttons: [[BTN.king]] };
  }

  async paid(ctx: Ctx, args: string[]): Promise<Reply> {
    const id = args[0];
    if (!id) return { rich: (f) => `usage: ${f.code('paid <quote-id>')}` };
    const pend = this.pending[id];
    if (!pend || !this.d.entry) return { rich: () => `no open quote ${id}` };
    if (pend.authorId !== ctx.authorId) return { rich: () => `quote ${id} belongs to someone else` };
    const { quote, paid, balanceRaw } = await this.d.entry.checkDeposit(id);
    if (quote.status === 'expired') { delete this.pending[id]; this.save(); return { rich: () => `quote ${id} expired unpaid. ask for a new one with shill.`, buttons: [[BTN.challenge]] }; }
    if (!paid) return { rich: (f) => `not there yet: ${f.b(`${Number(balanceRaw) / 10 ** quote.decimals}`)} of ${quote.amountUi} at ${f.code(quote.depositAddress)}. try again in a minute.`, buttons: [[{ label: 'I paid', data: `paid:${id}` }]] };

    const steps: { label: string; sig?: string }[] = [];
    const show = async () => {
      if (!ctx.progress) return;
      await ctx.progress((f) => [f.muted(`SETTLING ${id}`), ...steps.map((s) => `✓ ${f.esc(s.label)}${s.sig ? ' · ' + f.link('tx', this.d.explorer(s.sig)) : ''}`)].join('\n'));
    };
    const settled = await this.d.entry.settle(id, { onStep: (label, sig) => { steps.push({ label, sig }); void show(); } });
    const out = await this.d.hill.challenge(pend.shill, { prepaid: { playSignature: settled.playSignature ?? '', feeSol: settled.playFeeSol } });
    delete this.pending[id]; this.save();
    return this.outcome(out, settled);
  }

  private outcome(out: ChallengeOutcome, q: Quote | null): Reply {
    const won = out.record.result === 'won';
    const c = out.record.challenger as Card | null;
    const k = out.record.incumbent as Card | null;
    const v = out.record.verdict;
    const score = (f: Fmt, label: string, s: { persuasion: number; originality: number; coherence: number; degeneracy: number }) =>
      `${f.muted(label)}\n${f.code(`persuasion ${pad(s.persuasion)}  originality ${pad(s.originality)}\ncoherence  ${pad(s.coherence)}  degeneracy  ${pad(s.degeneracy)}`)}`;
    const rich: Rich = (f) => [
      c && k ? `${f.b(c.name)} vs ${f.b('KING ' + k.name)}` : '',
      v && c ? score(f, `CHALLENGER · ${c.name} · power ${c.power}`, v.challenger) : c ? f.code(cardLine(c)) : '',
      v && k ? score(f, `KING · ${k.name} · power ${k.power}`, v.incumbent) : '',
      '',
      f.b(out.oneLiner),
      f.esc(out.commentary),
      won && out.king ? `\n${f.b('NEW KING.')} the master token now reads ${f.b(out.king.master.name)} ${f.code('$' + out.king.master.symbol)}` + (out.king.master.signature ? ` · ${f.link('tx', this.d.explorer(out.king.master.signature))}` : '') : '',
      q?.playSignature ? f.muted(`play locked · `) + f.link('tx', this.d.explorer(q.playSignature)) : '',
      out.record.usage ? f.muted(`inference this attempt $${out.record.usage.usd.toFixed(3)} · via openzoo → ${out.record.usage.model}`) : '',
    ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
    const announce: Rich | null = won && out.king ? (f) => [
      f.muted(`NEW KING · REIGN ${out.king!.reign}`),
      f.b(out.oneLiner),
      `The master token is now ${f.b(out.king!.master.name)} ${f.code('$' + out.king!.master.symbol)} — name, ticker and image rewritten on chain.` + (out.king!.master.signature ? ` ${f.link('tx', this.d.explorer(out.king!.master.signature))}` : ''),
      f.muted(`by ${out.king!.author} · ${out.king!.card.rarity} ${out.king!.card.element} · power ${out.king!.card.power}`),
      `attempt fee is now ${f.b(`${this.d.hill.attemptFee()} SOL`)} worth`,
    ].join('\n') : null;
    return {
      rich, image: won ? out.king?.image ?? null : null,
      buttons: [[BTN.king, BTN.hall]],
      announce, announceButtons: [[BTN.challenge], [BTN.hall, ...(out.king?.master.signature ? [{ label: 'Solscan', url: this.d.explorer(out.king.master.signature) }] : [])]],
    };
  }
}

const pad = (n: number) => String(Math.round(n)).padStart(3, ' ');
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
function ago(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
