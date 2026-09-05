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
 *   wallet <address>        where the pot is sent when you win (LP of every pool in the vault, half of each)
 *   donate <sol>            half is swapped to the master token, the pair becomes SOL/MASTER liquidity locked for good on Raydium; the donor gets the lock NFT
 *   dividends               what every play has paid you: 20% of each play's LP to past kings, 10% to every player, as Raydium lock NFTs
 *   help
 *
 * Every reply ends with the pot: half the vault's book value, what the next winner takes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { cardLine, type Card } from './cards.js';
import { Dividends, KINGS_BPS, MIN_PAYOUT_USD, PLAYERS_BPS, PUSH_BPS, WINNER_BPS, bps, type Payout } from './dividends.js';
import { MIN_DONATION_SOL, NeedsSolError, type Entry, type Quote } from './entry.js';
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
  /** A page on the bot's public url with this reply's addresses and copy buttons (X cannot carry raw addresses on a fresh app). */
  page?: string;
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

type Pending = { quoteId: string; shill?: Shill; kind?: 'play' | 'donation'; authorId: string; createdAt: number };
/** A pot won before its winner told us a wallet: paid the moment they do. */
type Owed = { author: string; potUsd: number; reign: number; at: number };
/** How one play's LP was split after the fight (for the reply). */
type Shares = { lpRaw: bigint; kings: number; players: number; kingsRaw: bigint; playersRaw: bigint; winnerRaw: bigint; winnerTx: string | null; winnerOwed: boolean; pushTx: string | null; pushedRaw: bigint; payouts: Payout[] };

export const isPubkey = (s: string): boolean => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false; try { new PublicKey(s); return true; } catch { return false; } };

const BTN = {
  king: { label: 'Who is king', data: 'cmd:king' }, fee: { label: 'Fee', data: 'cmd:fee' }, help: { label: 'How to play', data: 'cmd:help' },
  hall: { label: 'Hall of fame', data: 'cmd:hall' }, challenge: { label: 'Challenge the king', data: 'cmd:challenge' },
  donate: { label: 'Donate to the pot', data: 'cmd:donate' }, dividends: { label: 'My dividends', data: 'cmd:dividends' },
};

/** The post that explains the game, per surface: every reply on that surface points at it. Override with KOTH_HOWTO_X / KOTH_HOWTO_TELEGRAM / KOTH_HOWTO_DISCORD. */
export const HOWTO: Record<string, string> = {
  x: process.env.KOTH_HOWTO_X || 'https://x.com/STACCoverflow/status/2096102767702016152',
  telegram: process.env.KOTH_HOWTO_TELEGRAM || 'https://t.me/theTokenonsolana/37167',
  discord: process.env.KOTH_HOWTO_DISCORD || '',
  cli: '',
};

export class Commands {
  private pending: Record<string, Pending> = {};
  private wallets: Record<string, string> = {};
  private owed: Record<string, Owed> = {};
  /** Lock NFTs held for donors who had not named a wallet: forwarded the moment they do. */
  private owedNfts: Record<string, string[]> = {};
  private file: string;
  private walletsFile: string;
  private owedFile: string;
  private nftsFile: string;
  readonly dividends: Dividends;

  constructor(private d: { hill: Hill; entry: Entry | null; dataDir: string; masterMint: string | null; explorer: (sig: string) => string; log?: (s: string) => void }) {
    this.file = path.join(d.dataDir, 'pending.json');
    this.walletsFile = path.join(d.dataDir, 'wallets.json');
    this.owedFile = path.join(d.dataDir, 'owed.json');
    this.nftsFile = path.join(d.dataDir, 'nfts.json');
    this.dividends = new Dividends(path.join(d.dataDir, 'dividends.json'), (s) => this.log(s));
    const read = <T,>(f: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return fallback; } };
    this.pending = read(this.file, {});
    this.wallets = read(this.walletsFile, {});
    this.owed = read(this.owedFile, {});
    this.owedNfts = read(this.nftsFile, {});
  }
  private save(): void {
    fs.mkdirSync(this.d.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.pending, null, 2));
    fs.writeFileSync(this.walletsFile, JSON.stringify(this.wallets, null, 2));
    fs.writeFileSync(this.owedFile, JSON.stringify(this.owed, null, 2));
    fs.writeFileSync(this.nftsFile, JSON.stringify(this.owedNfts, null, 2));
  }
  private log(s: string): void { (this.d.log ?? (() => {}))(s); }

  /** Pull the command out of a message: leading slash, bot mention, bare word, or a button's callback data. */
  static parse(text: string): { cmd: string; args: string[] } | null {
    const cb = text.match(/^cmd:(\w+)$/) ?? text.match(/^(paid|cancel|addr):([A-Za-z0-9_-]+)$/);
    if (cb) return cb[2] ? { cmd: cb[1], args: [cb[2]] } : { cmd: cb[1], args: [] };
    // drop mentions, then anything before the first word (the ".@bot king" convention, quotes, dashes) -- a leading slash survives
    const cleaned = text.replace(/@\w+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z/]+/, '');
    const m = cleaned.match(/^\/?(king|hall|fee|entry|shill|paid|cancel|help|start|challenge|wallet|pot|donate|dividends|divs|earnings)\b(?:@\w+)?\s*(.*)$/i);
    if (!m) return null;
    const raw = m[1].toLowerCase();
    const cmd = raw === 'entry' ? 'fee' : raw === 'start' ? 'help' : raw === 'divs' || raw === 'earnings' ? 'dividends' : raw;
    return { cmd, args: m[2] ? m[2].split(' ').filter(Boolean) : [] };
  }

  /** The pot line every reply ends with: what the next winner takes, in dollars from chain, and the rule. */
  potLine(f: Fmt, pot: number): string {
    return `🏆 ${f.b(`POT $${pot.toFixed(2)}`)} · ${f.muted('take the hill and win HALF THE VAULT: half of every bid locked in it so far (every failed shill\'s liquidity). the other half keeps stacking for the next king.')}`;
  }

  /** "THIS is how you play" + the surface's own explainer post; every reply on X and Telegram ends with it. */
  howtoLine(f: Fmt, surface: string): string {
    const url = HOWTO[surface] ?? '';
    return url ? `👉 ${f.b('THIS is how you play')}: ${f.link(url, url)}` : '';
  }

  async handle(ctx: Ctx): Promise<Reply | null> {
    const r = await this.handleInner(ctx);
    if (!r) return null;
    const pot = await this.d.hill.potUsd();
    const inner = r.rich;
    return { ...r, rich: (f) => [inner(f), '', this.potLine(f, pot), this.howtoLine(f, ctx.surface)].filter((l, i) => i < 2 || l).join('\n') };
  }

  private async handleInner(ctx: Ctx): Promise<Reply | null> {
    const p = Commands.parse(ctx.text);
    if (!p) return null;
    try {
      switch (p.cmd) {
        case 'pot': return { rich: (f) => `${f.b('THE POT')}: half of every LP position in the vault, sent to the winner's wallet. ${this.walletLine(ctx, f)}\n${f.muted(`back the master token: ${f.code('donate <sol>')} · half becomes the master token, the pair is locked for good as SOL/MASTER liquidity on Raydium, and you keep the lock NFT (its trading fees).`)}`, buttons: [[BTN.challenge, BTN.donate], [BTN.king, BTN.fee]] };
        case 'wallet': return await this.wallet(ctx, p.args);
        case 'king': return this.king();
        case 'hall': return this.hall();
        case 'fee': return this.fee();
        case 'help': return this.help();
        case 'challenge': return { rich: (f) => `${f.b('to challenge the king:')}\n${f.code('shill <mint> <your pitch>')}\n${f.muted('any Jupiter-tradable coin. sell it.')}`, buttons: [[BTN.king, BTN.fee]] };
        case 'shill': return await this.shill(ctx, p.args);
        case 'donate': return await this.donate(ctx, p.args);
        case 'dividends': return await this.dividendsReply(ctx);
        case 'paid': return await this.paid(ctx, p.args);
        case 'cancel': return this.cancel(ctx, p.args);
        case 'addr': return this.addr(ctx, p.args);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`[${ctx.surface}:${ctx.author}] ${p.cmd} failed: ${msg}`);
      if (e instanceof NeedsSolError) return this.needsSol(e, p.args[0] ?? '');
      return { rich: (f) => `that did not work: ${f.esc(msg.slice(0, 300))}` };
    }
    return null;
  }

  help(): Reply {
    return {
      rich: (f) => f.html
        ? `${f.b('KING OF THE HILL')}\n\nOne coin wears the crown. The crown is a real token whose ${f.b('name, ticker and image get rewritten on-chain')} to whoever holds the hill.\n\nShill your coin. Beat the king. The master token becomes yours, remixed by the AI, ${f.b('and you win the pot: half of every bid locked in the vault before you')}. Lose and you are in the hall of fame, and your bid stays in the pot.\n\n${f.muted('Every attempt becomes <yourcoin>/MASTER liquidity in the vault. LP only ever leaves it to a winner, half of everything at once.')}\n\n${f.b('How to play')} (each line is its own message):\n${f.code('shill <mint> <your pitch>')}  ${f.muted('start an attempt: you get a deposit address, an amount, and a quote id')}\n${f.code('paid <quote-id>')}  ${f.muted('the quote id from your shill, once you have sent the coins')}\n${f.code('wallet <address>')}  ${f.muted('where your pot is sent when you win')}\n${f.code('donate <sol>')}  ${f.muted('half is swapped to the master token, the pair is locked for good as SOL/MASTER liquidity on Raydium; you get the lock NFT (its trading fees)')}\n${f.code('dividends')}  ${f.muted('every play pays the people before it: 20% of its LP to past kings, 10% to every player, as lock NFTs once yours is worth $1')}\n${f.code('king')}  ${f.muted('who holds the hill')}\n${f.code('hall')}  ${f.muted('hall of fame: every king so far')}\n${f.code('fee')}  ${f.muted('the current attempt fee')}`
        : `${PITCH}\n\nHOW TO PLAY (each line is its own message):\n  shill <mint> <your pitch>   start an attempt: you get a deposit address, an amount, and a quote id\n  paid <quote-id>             the quote id from your shill, once you have sent the coins\n  wallet <address>            where your pot is sent when you win\n  donate <sol>                half is swapped to the master token, the pair is locked for good as SOL/MASTER liquidity on Raydium; you get the lock NFT (its trading fees)\n  dividends                   every play pays the people before it: 20% of its LP to past kings, 10% to every player, as lock NFTs once yours is worth $1\n  king                        who holds the hill\n  hall                        hall of fame: every king so far\n  fee                         the current attempt fee`,
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
      image: k.image, buttons, page: '/king',
    };
  }

  /** The pool could not be created because the fee payer is short of SOL: say how much, where, and that `paid` resumes. */
  needsSol(e: NeedsSolError, quoteId: string): Reply {
    const donation = this.pending[quoteId]?.kind === 'donation';
    return {
      rich: (f) => [
        f.b(donation ? 'one more thing before it lands in the pot' : 'one more thing before the fight'),
        `Raydium charges ${f.b(`${e.poolFeeSol} SOL`)} to create the ${donation ? 'SOL' : 'your coin'}/MASTER pool, and the fee payer has ${e.haveSol.toFixed(3)} SOL.`,
        `send ${f.b(`${e.topUpSol} SOL`)} to the fee payer`,
        f.pre(e.feePayer),
        quoteId ? `then say ${f.code(`paid ${quoteId}`)} again. your deposit, the swap and everything settled so far are kept; it resumes at the pool.` : 'then say paid again; everything settled so far is kept.',
      ].join('\n'),
      buttons: [[{ label: 'Copy fee payer', copy: e.feePayer, data: 'cmd:king' }, ...(quoteId ? [{ label: 'Try again', data: `paid:${quoteId}` }] : [])]],
      page: '/king',
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
        `attempt fee: ${f.b(`${this.d.hill.attemptFee()} SOL`)} worth of any Jupiter-swappable coin ${f.muted(`(${this.d.hill.baseFeeSol} SOL × 1.01^${s.takeovers})`)}`,
        `+ inference ~$${this.d.hill.inferenceEstimateUsd().toFixed(3)} (paid to the zoo), +5% buffer, quoted in ${f.b('your')} coin`,
        f.muted(`half the stake is swapped to the master token; the pair becomes CPMM liquidity. ${PUSH_BPS / 100}% of it goes to the vault (the pot: the winner takes half of it), ${KINGS_BPS / 100}% to past kings and ${PLAYERS_BPS / 100}% to every player as Raydium lock NFTs, ${WINNER_BPS / 100}% to the winner as plain LP (to the vault on a loss).`),
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
        `then say ${f.code(`paid ${q.id}`)}. half becomes liquidity for your coin/MASTER, in the vault.`,
        this.walletLine(ctx, f),
      ].join('\n'),
      buttons: [[{ label: 'Copy amount', copy: `${q.amountUi}`, data: `amt:${q.id}` }, { label: 'Copy address', copy: q.depositAddress, data: `addr:${q.id}` }], [{ label: 'I paid', data: `paid:${q.id}` }], [{ label: 'Cancel', data: `cancel:${q.id}` }]],
      page: `/q/${q.id}`,
    };
  }

  /** `donate <sol>`: a one-time SOL address; on `paid` half is swapped to master and the pair becomes vault liquidity. */
  async donate(ctx: Ctx, args: string[]): Promise<Reply> {
    const sol = Number((args[0] ?? '').replace(/sol$/i, ''));
    const usage = (f: Fmt) => [
      `usage: ${f.code('donate <sol>')} ${f.muted(`(at least ${MIN_DONATION_SOL} SOL)`)}`,
      f.muted('half is swapped to the master token, the pair becomes SOL/MASTER liquidity locked for good on Raydium. you get the lock NFT: it claims that position\'s share of the pool\'s trading fees, forever.'),
    ].join('\n');
    if (!args[0] || !Number.isFinite(sol) || sol < MIN_DONATION_SOL) return { rich: usage, buttons: [[BTN.king, BTN.fee]] };
    if (!this.d.entry) return { rich: (f) => `donations need the live game (no play program configured).\n${usage(f)}` };
    const q = await this.d.entry.donate({ donor: ctx.author, surface: ctx.surface, sol, nftOwner: this.wallets[ctx.authorId] ?? null });
    this.pending[q.id] = { quoteId: q.id, kind: 'donation', authorId: ctx.authorId, createdAt: Date.now() };
    this.save();
    return {
      rich: (f) => [
        f.muted(`DONATION ${q.id} · ${ctx.author}`),
        `send exactly ${f.code(`${q.amountUi}`)} SOL`,
        'to this one-time address',
        f.pre(q.depositAddress),
        f.muted('never reused · deleted after sweep · expires in 30 min'),
        q.extraSol
          ? `${f.b(`${q.playFeeSol} SOL`)} to the pot ≈ $${q.playFeeUsd.toFixed(2)} ${f.b(`+ ${q.extraSol} SOL`)} because there is no SOL/MASTER pool yet: yours creates it (Raydium's fee + rent), and the fee payer cannot cover that alone.`
          : `${f.b(`${q.playFeeSol} SOL`)} ≈ $${q.playFeeUsd.toFixed(2)} · ${q.poolExists ? 'joins the SOL/MASTER pool' : 'creates the SOL/MASTER pool'}`,
        `then say ${f.code(`paid ${q.id}`)}. half is swapped to the master token, the pair becomes SOL/MASTER liquidity locked for good with Raydium's lock program.`,
        q.nftOwner ? f.muted(`the lock NFT (your claim on that position's trading fees) goes to ${q.nftOwner}`) : f.muted('the lock NFT (your claim on that position\'s trading fees) goes to the wallet that sends the SOL. sending from an exchange? say wallet <your address> first.'),
      ].join('\n'),
      buttons: [[{ label: 'Copy amount', copy: `${q.amountUi}`, data: `amt:${q.id}` }, { label: 'Copy address', copy: q.depositAddress, data: `addr:${q.id}` }], [{ label: 'I sent it', data: `paid:${q.id}` }], [{ label: 'Cancel', data: `cancel:${q.id}` }]],
      page: `/q/${q.id}`,
    };
  }

  /** A settled donation: what went where, and the pot it grew. */
  private donated(ctx: Ctx, q: Quote): Reply {
    const nftMint = q.steps.nftMint ?? '', nftOwner = q.steps.nftOwner ?? '';
    const heldByUs = Boolean(nftMint) && this.d.entry !== null && nftOwner === this.d.entry.feePayer;
    if (heldByUs) { (this.owedNfts[ctx.authorId] ??= []).push(nftMint); this.save(); }
    const rich: Rich = (f) => [
      f.b(`🎁 ${q.playFeeSol} SOL donated by ${f.esc(ctx.author)}`),
      `half → master token${q.steps.swapHalf ? ' · ' + f.link('tx', this.d.explorer(q.steps.swapHalf)) : ''}`,
      `SOL/MASTER pool ${q.steps.poolCreated === 'true' ? 'created' : 'deposited'}${q.steps.pool ? ' · ' + f.link('tx', this.d.explorer(q.steps.pool)) : ''}`,
      `LP locked for good on Raydium${q.steps.lock ? ' · ' + f.link('tx', this.d.explorer(q.steps.lock)) : ''}`,
      nftMint ? `${f.b('your lock NFT')} ${f.code(nftMint)}` : '',
      heldByUs ? `${f.b('we are holding it for you')}: say ${f.code('wallet <your solana address>')} and it is sent there. it claims that position's trading fees, forever.` : nftOwner ? f.muted(`sent to ${nftOwner}. it claims that position's share of the pool's trading fees, forever (collect on raydium.io › portfolio).`) : '',
      f.muted(q.extraSol ? `${q.extraSol} SOL of it paid Raydium's pool creation. thank you.` : 'thank you.'),
    ].filter(Boolean).join('\n');
    const announce: Rich = (f) => [
      f.b(`🎁 ${q.playFeeSol} SOL donated to the master token`),
      `by ${f.esc(ctx.author)} via ${ctx.surface} · half swapped to the master token, the pair is now SOL/MASTER liquidity locked for good on Raydium. the donor holds the fee NFT.`,
    ].join('\n');
    return { rich, buttons: [[BTN.challenge, BTN.donate], [BTN.king]], announce, announceButtons: [[BTN.challenge, BTN.donate]] };
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
    if (quote.status === 'expired') { delete this.pending[id]; this.save(); return { rich: () => `quote ${id} expired unpaid. ask for a new one with ${pend.kind === 'donation' ? 'donate' : 'shill'}.`, buttons: [[pend.kind === 'donation' ? BTN.donate : BTN.challenge]] }; }
    // once swept, the deposit address is empty by design: a settlement that failed part-way resumes from its last step
    const resumable = Boolean(quote.steps?.sweep) || quote.status === 'settling' || quote.status === 'failed';
    if (!paid && !resumable) return { rich: (f) => `not there yet: ${f.b(`${Number(balanceRaw) / 10 ** quote.decimals}`)} of ${quote.amountUi} at ${f.code(quote.depositAddress)}. try again in a minute.`, buttons: [[{ label: pend.kind === 'donation' ? 'I sent it' : 'I paid', data: `paid:${id}` }]] };

    const steps: { label: string; sig?: string }[] = [];
    const show = async () => {
      if (!ctx.progress) return;
      await ctx.progress((f) => [f.muted(`SETTLING ${id}`), ...steps.map((s) => `✓ ${f.esc(s.label)}${s.sig ? ' · ' + f.link('tx', this.d.explorer(s.sig)) : ''}`)].join('\n'));
    };
    const settled = await this.d.entry.settle(id, { onStep: (label, sig) => { steps.push({ label, sig }); void show(); } });
    if (pend.kind === 'donation' || !pend.shill) {
      delete this.pending[id]; this.save();
      this.dividends.recordPlay(ctx.authorId, ctx.author, ctx.surface);   // a donor is a player of the other type: in on the 10%
      this.log(`[${ctx.surface}:${ctx.author}] donated ${settled.playFeeSol} SOL (quote ${id})`);
      return this.donated(ctx, settled);
    }
    const out = await this.d.hill.challenge(pend.shill, { prepaid: { playSignature: settled.playSignature ?? '', feeSol: settled.playFeeSol, stakeUsd: settled.playFeeUsd } });
    delete this.pending[id]; this.save();
    const shares = await this.settleShares(ctx, settled, out.record.result === 'won');
    const payout = out.record.result === 'won' ? await this.payout(ctx, out) : null;
    return this.outcome(out, settled, payout, shares);
  }

  /**
   * After the fight, the LP the play left in the operator's account (everything but the 35% push):
   *   20% to past kings (with a wallet) by wins, 10% to every past player by plays: accrued, paid as lock NFTs from $1
   *   35% to the winner as plain LP (owed until they name a wallet); on a loss it pushes into the vault
   * Anything with no one to take it pushes too. Then everyone who is due a payout gets it.
   */
  private async settleShares(ctx: Ctx, q: Quote, won: boolean): Promise<Shares | null> {
    const entry = this.d.entry;
    const lpRaw = BigInt(q.steps.lpRaw ?? '0'), pushed = BigInt(q.steps.pushedRaw ?? '0');
    if (!entry || lpRaw <= 0n || pushed <= 0n || pushed >= lpRaw || !q.steps.lpMint || !q.steps.poolId) {
      this.dividends.recordPlay(ctx.authorId, ctx.author, ctx.surface);
      if (won) this.dividends.recordWin(ctx.authorId, ctx.author, ctx.surface);
      return null;
    }
    const lpMint = q.steps.lpMint, pool = q.steps.poolId;
    const kingsRaw = bps(lpRaw, KINGS_BPS), playersRaw = bps(lpRaw, PLAYERS_BPS), winnerRaw = bps(lpRaw, WINNER_BPS);
    const { allocations, unallocated } = this.dividends.distribute({ lpMint, pool, kingsRaw, playersRaw });
    const kings = allocations.filter((a) => a.reason === 'king').length, players = allocations.filter((a) => a.reason === 'player').length;
    let toVault = lpRaw - pushed - kingsRaw - playersRaw - winnerRaw + unallocated;   // rounding dust and unclaimed shares
    const shares: Shares = { lpRaw, kings, players, kingsRaw, playersRaw, winnerRaw: won ? winnerRaw : 0n, winnerTx: null, winnerOwed: false, pushTx: null, pushedRaw: pushed, payouts: [] };
    if (won) {
      const wallet = this.wallets[ctx.authorId];
      if (wallet) {
        try {
          shares.winnerTx = await entry.sendLp(new PublicKey(lpMint), winnerRaw, new PublicKey(wallet));
          this.dividends.recordPaid(ctx.authorId, ctx.author, ctx.surface, { lpMint, pool, raw: winnerRaw.toString(), usd: await this.lpUsd(lpMint, winnerRaw), nftMint: null, signature: shares.winnerTx, at: Date.now(), reason: 'win' });
        } catch (e) {
          this.log(`winner LP ${winnerRaw} -> ${wallet} failed, owed instead: ${e instanceof Error ? e.message : e}`);
          this.dividends.oweLp(ctx.authorId, ctx.author, ctx.surface, lpMint, pool, winnerRaw); shares.winnerOwed = true;
        }
      } else { this.dividends.oweLp(ctx.authorId, ctx.author, ctx.surface, lpMint, pool, winnerRaw); shares.winnerOwed = true; }
    } else {
      toVault += winnerRaw;
    }
    this.dividends.recordPlay(ctx.authorId, ctx.author, ctx.surface);
    if (won) this.dividends.recordWin(ctx.authorId, ctx.author, ctx.surface);
    if (toVault > 0n) {
      try { shares.pushTx = await entry.pushToVault(q, toVault); shares.pushedRaw += toVault; }
      catch (e) { this.log(`second push ${toVault} LP failed (stays in the operator account): ${e instanceof Error ? e.message : e}`); }
    }
    shares.payouts = await this.payDividends();
    return shares;
  }

  private async lpUsd(lpMint: string, raw: bigint): Promise<number> {
    try { return Math.round(Number(raw) * (await this.d.entry!.priceLp(new PublicKey(lpMint))).usdPerRaw * 100) / 100; } catch { return 0; }
  }

  /** Lock and send every dividend position that is worth paying (a wallet, $1 or more). */
  private async payDividends(onlyId?: string): Promise<Payout[]> {
    const entry = this.d.entry;
    if (!entry) return [];
    const out: Payout[] = [];
    const due = await this.dividends.payable(async (m) => (await entry.priceLp(new PublicKey(m))).usdPerRaw, onlyId);
    for (const d of due) {
      const raw = this.dividends.beginPay(d.id, d.lpMint);
      if (raw <= 0n) continue;
      try {
        const r = await entry.lockOnRaydium(new PublicKey(d.pool), raw, new PublicKey(d.wallet));
        const payout: Payout = { lpMint: d.lpMint, pool: d.pool, raw: raw.toString(), usd: d.usd, nftMint: r.nftMint.toBase58(), signature: r.signature, at: Date.now(), reason: 'dividend' };
        this.dividends.finishPay(d.id, payout);
        out.push(payout);
        this.log(`dividend $${d.usd} (${raw} LP ${d.lpMint}) locked for ${d.id} -> ${d.wallet}, nft ${payout.nftMint}, tx ${r.signature}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // a rejected or never-sent transaction goes back on the books; anything else stays flagged for a human
        if (/simulation|insufficient|blockhash|rejected|failed to send|0x/i.test(msg)) this.dividends.failPay(d.id);
        this.log(`dividend for ${d.id} (${raw} LP ${d.lpMint}) failed: ${msg}`);
      }
    }
    return out;
  }

  /** `dividends`: what every play has paid this person, and what is still accruing. */
  private async dividendsReply(ctx: Ctx): Promise<Reply> {
    const p = this.dividends.person(ctx.authorId);
    const entry = this.d.entry;
    const accrued = entry ? await this.dividends.accruedUsd(ctx.authorId, async (m) => (await entry.priceLp(new PublicKey(m))).usdPerRaw) : [];
    const owed = Object.entries(p?.owedLp ?? {}).filter(([, a]) => BigInt(a.raw) > 0n);
    const rule = (f: Fmt) => f.muted(`every play: ${KINGS_BPS / 100}% of its LP to past kings (by reigns), ${PLAYERS_BPS / 100}% to every player (by plays), locked for good on Raydium; the lock NFT claims that liquidity's trading fees forever. paid once a position is worth $${MIN_PAYOUT_USD}. on a win ${WINNER_BPS / 100}% goes to the winner as plain LP and ${PUSH_BPS / 100}% pushes into the pot.`);
    if (!p) return { rich: (f) => `${f.b('no dividends yet')}: play once and every play after yours pays you.\n${rule(f)}`, buttons: [[BTN.challenge], [BTN.king]] };
    return {
      rich: (f) => [
        f.b(`DIVIDENDS · ${f.esc(ctx.author)}`),
        `${p.plays} play${p.plays === 1 ? '' : 's'} · ${p.wins} reign${p.wins === 1 ? '' : 's'} · paid so far $${p.paidUsd.toFixed(2)} (${p.paid.length} payout${p.paid.length === 1 ? '' : 's'})`,
        ...accrued.map((a) => `accruing: ${a.usd === null ? `${a.raw} LP` : `$${a.usd.toFixed(2)}`} in pool ${f.code(a.pool)}${a.usd !== null && a.usd < MIN_PAYOUT_USD ? f.muted(` (paid at $${MIN_PAYOUT_USD})`) : ''}`),
        ...owed.map(([lpMint, a]) => `${f.b('won, waiting for your wallet')}: ${a.raw} LP ${f.code(lpMint)}`),
        ...p.paid.slice(-5).map((x) => `paid $${x.usd.toFixed(2)} · ${x.reason === 'win' ? 'your win, plain LP' : `lock NFT ${f.code(x.nftMint ?? '')}`} · ${f.link('tx', this.d.explorer(x.signature))}`),
        p.paying ? f.muted(`one payout of ${p.paying.raw} LP is being checked by a human.`) : '',
        this.walletLine(ctx, f),
        rule(f),
      ].filter(Boolean).join('\n'),
      buttons: [[BTN.challenge], [BTN.king, BTN.hall]],
    };
  }

  /** Where a winner's pot goes, or what to say so it can. */
  private walletLine(ctx: Ctx, f: Fmt): string {
    const w = this.wallets[ctx.authorId];
    return w ? f.muted(`payout wallet: ${w}`) : `${f.b('no payout wallet yet')}: say ${f.code('wallet <your solana address>')} so the pot can be sent to you when you win.`;
  }

  /** `wallet <address>`: remember where this player's winnings go; settle anything already owed. */
  async wallet(ctx: Ctx, args: string[]): Promise<Reply> {
    const addr = args[0] ?? '';
    if (!addr) {
      const w = this.wallets[ctx.authorId];
      return { rich: (f) => w ? `your payout wallet is ${f.code(w)}. change it with ${f.code('wallet <address>')}.` : `usage: ${f.code('wallet <your solana address>')}` };
    }
    if (!isPubkey(addr)) return { rich: (f) => `${f.code(addr)} is not a Solana address.` };
    this.wallets[ctx.authorId] = addr; this.save();
    this.dividends.setWallet(ctx.authorId, ctx.author, ctx.surface, addr);
    const nfts = await this.sendNfts(ctx.authorId, addr);
    const lp = await this.sendOwedLp(ctx, addr);
    const divs = await this.payDividends(ctx.authorId);
    const extra = (f: Fmt) => [
      ...nfts.map((n) => `lock NFT ${f.code(n.nftMint)} sent · ${f.link('tx', this.d.explorer(n.signature))}`),
      ...lp.map((x) => `your win: ${x.raw} LP ${f.code(x.lpMint)} sent · ${f.link('tx', this.d.explorer(x.signature))}`),
      ...divs.map((x) => `dividends $${x.usd.toFixed(2)} locked for you · NFT ${f.code(x.nftMint ?? '')} · ${f.link('tx', this.d.explorer(x.signature))}`),
    ];
    const owed = this.owed[ctx.authorId];
    if (!owed) return { rich: (f) => [`payout wallet set: ${f.code(addr)}. win the hill and the pot lands there.`, ...extra(f)].join('\n'), buttons: [[BTN.challenge], [BTN.king]] };
    const paid = await this.sendPot(ctx.authorId, addr);
    return {
      rich: (f) => [
        `payout wallet set: ${f.code(addr)}.`,
        ...extra(f),
        paid.length ? `${f.b(`your pot from reign ${owed.reign} (~$${owed.potUsd.toFixed(2)}) is on its way:`)}\n${paid.map((x) => `LP ${f.code(x.lpMint)} × ${x.amount} · ${f.link('tx', this.d.explorer(x.signature))}`).join('\n')}` : f.muted('the vault holds nothing to send right now.'),
      ].join('\n'),
      buttons: [[BTN.king, BTN.hall]],
    };
  }

  /** A winner's plain LP, won before they had a wallet -> the wallet they just named. */
  private async sendOwedLp(ctx: Ctx, wallet: string): Promise<{ lpMint: string; raw: string; signature: string }[]> {
    const out: { lpMint: string; raw: string; signature: string }[] = [];
    if (!this.d.entry) return out;
    for (const o of this.dividends.takeOwedLp(ctx.authorId)) {
      try {
        const signature = await this.d.entry.sendLp(new PublicKey(o.lpMint), o.raw, new PublicKey(wallet));
        this.dividends.recordPaid(ctx.authorId, ctx.author, ctx.surface, { lpMint: o.lpMint, pool: o.pool, raw: o.raw.toString(), usd: await this.lpUsd(o.lpMint, o.raw), nftMint: null, signature, at: Date.now(), reason: 'win' });
        out.push({ lpMint: o.lpMint, raw: o.raw.toString(), signature });
      } catch (e) {
        this.dividends.oweLp(ctx.authorId, ctx.author, ctx.surface, o.lpMint, o.pool, o.raw);
        this.log(`owed LP ${o.raw} ${o.lpMint} -> ${wallet} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  /** Lock NFTs held for a donor -> the wallet they just named. Each one is forgotten once it is sent. */
  private async sendNfts(authorId: string, wallet: string): Promise<{ nftMint: string; signature: string }[]> {
    const out: { nftMint: string; signature: string }[] = [];
    const held = this.owedNfts[authorId] ?? [];
    if (!held.length || !this.d.entry) return out;
    for (const nftMint of [...held]) {
      try {
        const signature = await this.d.entry.sendNft(new PublicKey(nftMint), new PublicKey(wallet));
        out.push({ nftMint, signature });
        this.owedNfts[authorId] = (this.owedNfts[authorId] ?? []).filter((m) => m !== nftMint);
        this.log(`lock nft ${nftMint} -> ${wallet}, tx ${signature}`);
      } catch (e) {
        this.log(`lock nft ${nftMint} -> ${wallet} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!this.owedNfts[authorId]?.length) delete this.owedNfts[authorId];
    this.save();
    return out;
  }

  /** Half of every LP position in the vault -> the wallet. Clears what was owed. */
  private async sendPot(authorId: string, wallet: string): Promise<{ lpMint: string; amount: string; signature: string }[]> {
    if (!this.d.entry) return [];
    const paid = await this.d.entry.awardHalf(new PublicKey(wallet));
    delete this.owed[authorId]; this.save();
    return paid;
  }

  /** A win: pay the pot now when we know the wallet, else hold it until `wallet <address>`. */
  private async payout(ctx: Ctx, out: ChallengeOutcome): Promise<{ paid: { lpMint: string; amount: string; signature: string }[]; wallet: string | null; error?: string }> {
    const wallet = this.wallets[ctx.authorId] ?? null;
    const reign = out.king?.reign ?? 0, potUsd = out.potUsd ?? 0;
    if (!wallet) { this.owed[ctx.authorId] = { author: ctx.author, potUsd, reign, at: Date.now() }; this.save(); return { paid: [], wallet: null }; }
    try {
      return { paid: await this.sendPot(ctx.authorId, wallet), wallet };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.owed[ctx.authorId] = { author: ctx.author, potUsd, reign, at: Date.now() }; this.save();
      this.log(`payout to ${wallet} failed, held: ${error}`);
      return { paid: [], wallet, error };
    }
  }

  private outcome(out: ChallengeOutcome, q: Quote | null, payout: { paid: { lpMint: string; amount: string; signature: string }[]; wallet: string | null; error?: string } | null = null, shares: Shares | null = null): Reply {
    const sharesLines = (f: Fmt): string => {
      if (!shares) return '';
      const pct = (raw: bigint) => `${Math.round((Number(raw) / Number(shares.lpRaw)) * 100)}%`;
      return [
        f.muted(`YOUR LP, SPLIT · ${pct(shares.kingsRaw)} → ${shares.kings} past king${shares.kings === 1 ? '' : 's'} · ${pct(shares.playersRaw)} → ${shares.players} player${shares.players === 1 ? '' : 's'} (locked for good, lock NFTs from $${MIN_PAYOUT_USD}) · ${pct(shares.pushedRaw)} → the vault`),
        shares.winnerRaw > 0n ? (shares.winnerTx ? `${f.b(`${pct(shares.winnerRaw)} of the LP is yours, unlocked`)} · ${f.link('tx', this.d.explorer(shares.winnerTx))}` : `${f.b(`${pct(shares.winnerRaw)} of the LP is yours, unlocked`)}: say ${f.code('wallet <your solana address>')} and it is sent.`) : '',
        shares.payouts.length ? f.muted(`dividends paid this round: ${shares.payouts.map((x) => `$${x.usd.toFixed(2)}`).join(', ')}`) : '',
      ].filter(Boolean).join('\n');
    };
    const won = out.record.result === 'won';
    const potLines = (f: Fmt): string => {
      if (!won) return f.muted(`your bid stays in the vault: it is part of the pot for whoever takes the hill next.`);
      const head = `${f.b(`🏆 YOU WIN THE POT ≈ $${(out.potUsd ?? 0).toFixed(2)}`)}: half of every LP position in the vault.`;
      if (!payout) return head;
      if (payout.paid.length) return `${head}\n${payout.paid.map((x) => `LP ${f.code(x.lpMint)} × ${x.amount} · ${f.link('tx', this.d.explorer(x.signature))}`).join('\n')}\n${f.muted(`sent to ${payout.wallet}. remove the liquidity on Raydium to cash out each pair.`)}`;
      if (payout.error) return `${head}\n${f.b('held for you')}: the transfer failed (${f.esc(payout.error.slice(0, 120))}). say ${f.code('wallet <address>')} again to retry.`;
      return `${head}\n${f.b('held for you')}: say ${f.code('wallet <your solana address>')} and it is sent right away.`;
    };
    const c = out.record.challenger as Card | null;
    const k = out.record.incumbent as Card | null;
    const v = out.record.verdict;
    const score = (f: Fmt, label: string, s: { persuasion: number; originality: number; coherence: number; degeneracy: number }, t?: { pitch: number; fundamentals: number; total: number }) =>
      `${f.muted(label)}\n${f.code(`persuasion ${pad(s.persuasion)}  originality ${pad(s.originality)}\ncoherence  ${pad(s.coherence)}  degeneracy  ${pad(s.degeneracy)}`)}` +
      (t ? `\n${f.code(`pitch ${t.pitch} ×80% + card ${t.fundamentals} ×20% = ${t.total}`)}` : '');
    const rich: Rich = (f) => [
      c && k ? `${f.b(c.name)} vs ${f.b('KING ' + k.name)}` : '',
      v && c ? score(f, `CHALLENGER · ${c.name} · power ${c.power}`, v.challenger, v.scores?.challenger) : c ? f.code(cardLine(c)) : '',
      v && k ? score(f, `KING · ${k.name} · power ${k.power}`, v.incumbent, v.scores?.incumbent) : '',
      '',
      f.b(out.oneLiner),
      f.esc(out.commentary),
      won && out.king ? `\n${f.b('NEW KING.')} the master token now reads ${f.b(out.king.master.name)} ${f.code('$' + out.king.master.symbol)}` + (out.king.master.signature ? ` · ${f.link('tx', this.d.explorer(out.king.master.signature))}` : '') : '',
      potLines(f),
      sharesLines(f),
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
