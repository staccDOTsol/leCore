/**
 * X: the mirror of the Telegram surface, in X's shape. Mentions are the commands; every reply is
 * the same rich message Telegram gets, rendered plain and posted as a thread when it is longer
 * than one post; the king's card rides along as native media (PNG, uploaded to X — SVG is
 * rasterized first); takeovers and the master shillbot's cadence posts go out as standalone posts
 * with the card attached. What X cannot do is edit a message, so settlement progress is one
 * "settling…" reply that the outcome then threads under. `since_id` and the answered set live in
 * <dataDir>/x-state.json so nothing is answered twice across restarts.
 *
 * Auth: OAuth 1.0a user context for everything (post, media upload, mentions, who-am-i); the app
 * bearer is optional and only used for reading mentions when present.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { svgToPng } from '../assets.js';
import { plain, type Button, type Commands, type Reply, type Rich } from '../commands.js';

export type XCreds = { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string; bearer: string; botUserId: string };
export type XOpts = {
  creds: XCreds;
  dataDir: string;
  /** Seconds between mention polls. The free tier allows very few mention reads; 429s are honoured. */
  pollMs?: number;
  /** Characters per post: 4000 with Premium (the default here), 280 on a plain account. Longer replies become threads. */
  maxChars?: number;
  /** The bot's public url: replies link to its /king and /q/<id> pages, which carry the full addresses. */
  publicUrl?: string;
  /** Post raw Solana addresses. Off by default: X forbids crypto addresses for an app's first 7 days (403), and the pages have copy buttons anyway. */
  rawAddresses?: boolean;
  log?: (s: string) => void;
  fetchImpl?: typeof fetch;
};

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a header. Only query params sign -- a JSON or multipart body does not (signing it yields a 401 that looks like bad creds). */
export function oauth1Header(a: { method: string; url: string; params?: Record<string, string>; creds: XCreds; nonce?: string; timestamp?: string }): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: a.creds.apiKey, oauth_nonce: a.nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: a.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: a.creds.accessToken, oauth_version: '1.0',
  };
  const all = { ...(a.params ?? {}), ...oauth };
  const paramStr = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&');
  const base = [a.method.toUpperCase(), enc(a.url), enc(paramStr)].join('&');
  const key = `${enc(a.creds.apiSecret)}&${enc(a.creds.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

/**
 * Split a message into posts of at most `max` characters, breaking on line boundaries (a single
 * line longer than `max` is cut). Pure, so the threading is testable.
 */
export function chunkPost(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const rawLine of text.split('\n')) {
    const pieces: string[] = [];
    for (let i = 0; i < Math.max(1, rawLine.length); i += max) pieces.push(rawLine.slice(i, i + max));
    for (const line of pieces) {
      const next = cur ? `${cur}\n${line}` : line;
      if (next.length <= max) { cur = next; continue; }
      if (cur) out.push(cur);
      cur = line;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [''];
}

/** Base58 runs of Solana-address length as whole words; signatures (86-88 chars) and hex ids do not match. */
const ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/** `Hgtd…A9ru`: the address is recognizable but no longer an address. Text inside urls is left alone. */
export function shortenAddresses(text: string): string {
  return text.split(/(https?:\/\/\S+)/).map((part, i) => i % 2 ? part : part.replace(ADDRESS, (a) => `${a.slice(0, 4)}…${a.slice(-4)}`)).join('');
}

/**
 * The plain rendering of a reply plus what X cannot show: url buttons become "label: url" lines; the
 * rest are already in the text. Without `rawAddresses`, addresses are shortened and the reply's page
 * (full addresses, copy buttons) is linked instead.
 */
export function renderForX(rich: Rich, buttons?: Button[][], opts: { page?: string; publicUrl?: string; rawAddresses?: boolean } = {}): string {
  const links = (buttons ?? []).flat().filter((b) => b.url).map((b) => `${b.label}: ${b.url}`);
  let text = plain(rich).trim();
  if (!opts.rawAddresses && ADDRESS.test(text)) {
    text = shortenAddresses(text);
    if (opts.page && opts.publicUrl) links.unshift(`full addresses + copy buttons: ${opts.publicUrl.replace(/\/+$/, '')}${opts.page}`);
  }
  return [text, ...links].join('\n').trim();
}

/** X allows one cashtag per post: the first `$SYMBOL` keeps its dollar sign, the rest lose it (the symbol stays readable). */
export function oneCashtag(text: string): string {
  let seen = false;
  return text.replace(/\$(?=[A-Za-z])/g, () => { if (seen) return ''; seen = true; return '$'; });
}

/** The same image on other gateways when it is an IPFS url; public gateways rate-limit bots (429) unpredictably. */
export function imageCandidates(url: string): string[] {
  const m = url.match(/^https?:\/\/[^/]+\/ipfs\/([A-Za-z0-9]+)(\/.*)?$/) ?? url.match(/^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/);
  if (!m) return [url];
  const rest = m[2] ?? '';
  const alts = ['https://ipfs.io', 'https://dweb.link', 'https://cloudflare-ipfs.com', 'https://gateway.pinata.cloud', 'https://nftstorage.link'].map((g) => `${g}/ipfs/${m[1]}${rest}`);
  return [url, ...alts.filter((a) => a !== url)];
}

type Mention = { id: string; text: string; author_id: string; username: string; created_at?: string };
type XState = { sinceId: string | null; answered: Record<string, number>; media?: Record<string, { id: string; at: number }>; retry?: { t: Mention; attempts: number }[] };
const ANSWERED_TTL_MS = 7 * 24 * 3600_000;
/** X media ids are good for about a day; reuse one for the same image url within that. */
const MEDIA_TTL_MS = 20 * 3600_000;
const MAX_ATTEMPTS = 3;

export class XSurface {
  private state: XState;
  private file: string;
  private stopped = false;
  private f: typeof fetch;
  private username = '';
  /** Posts made so far; a failed mention is retried only when nothing was posted for it. */
  private posted = 0;

  constructor(private commands: Commands, private o: XOpts) {
    this.f = o.fetchImpl ?? fetch;
    this.file = path.join(o.dataDir, 'x-state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as XState; } catch { this.state = { sinceId: null, answered: {} }; }
  }

  private save(): void {
    const cutoff = Date.now() - ANSWERED_TTL_MS;
    for (const [id, t] of Object.entries(this.state.answered)) if (t < cutoff) delete this.state.answered[id];
    for (const [u, m] of Object.entries(this.state.media ?? {})) if (m.at < Date.now() - MEDIA_TTL_MS) delete this.state.media![u];
    fs.mkdirSync(this.o.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  private get max(): number { return this.o.maxChars ?? 4000; }

  private async json(res: Response): Promise<Record<string, unknown>> {
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /** Confirm the credentials and learn the bot's own id/handle (X_BOT_USER_ID is optional). */
  async start(): Promise<{ id: string; username: string } | null> {
    const url = 'https://api.x.com/2/users/me';
    const res = await this.f(url, { headers: { authorization: oauth1Header({ method: 'GET', url, creds: this.o.creds }) }, signal: AbortSignal.timeout(30_000) });
    const j = await this.json(res);
    const me = j.data as { id?: string; username?: string } | undefined;
    if (!res.ok || !me?.id) { this.o.log?.(`x users/me failed ${res.status}: ${JSON.stringify(j).slice(0, 200)}`); return null; }
    if (!this.o.creds.botUserId) this.o.creds.botUserId = me.id;
    this.username = me.username ?? '';
    this.o.log?.(`x: @${this.username} ready (${this.max} chars/post)`);
    return { id: me.id, username: this.username };
  }

  /** Fetch the image bytes, trying the other IPFS gateways when the first answers 429/5xx or times out. */
  private async fetchImage(imageUrl: string): Promise<{ bytes: Buffer; type: string }> {
    let last = 'no candidates';
    for (const url of imageCandidates(imageUrl)) {
      try {
        const r = await this.f(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'image/*' } });
        if (!r.ok) { last = `${url} -> ${r.status}`; continue; }
        const bytes = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get('content-type')?.split(';')[0] || (url.endsWith('.png') ? 'image/png' : url.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg');
        return { bytes, type };
      } catch (e) { last = `${url} -> ${e instanceof Error ? e.message : e}`; }
    }
    throw new Error(`fetch ${last}`);
  }

  /** Upload one image as post media. SVGs are rasterized to PNG first; X only takes bitmaps. A media id is reused for the same url for a day. */
  async uploadMedia(imageUrl: string): Promise<string | null> {
    const cached = this.state.media?.[imageUrl];
    if (cached && cached.at > Date.now() - MEDIA_TTL_MS) return cached.id;
    try {
      let { bytes, type } = await this.fetchImage(imageUrl);
      if (type === 'image/svg+xml' || bytes.subarray(0, 5).toString() === '<?xml' || bytes.subarray(0, 4).toString() === '<svg') {
        const png = await svgToPng(bytes.toString('utf8'));
        if (!png) throw new Error('no rasterizer for svg');
        bytes = png; type = 'image/png';
      }
      const url = 'https://api.x.com/2/media/upload';
      const form = new FormData();
      form.set('media', new Blob([new Uint8Array(bytes)], { type }), `card.${type.split('/')[1]}`);
      form.set('media_category', 'tweet_image');
      form.set('media_type', type);
      const res = await this.f(url, { method: 'POST', headers: { authorization: oauth1Header({ method: 'POST', url, creds: this.o.creds }) }, body: form, signal: AbortSignal.timeout(60_000) });
      const j = await this.json(res);
      const id = (j.data as { id?: string } | undefined)?.id ?? (j.media_id_string as string | undefined);
      if (!res.ok || !id) throw new Error(`${res.status} ${JSON.stringify(j).slice(0, 200)}`);
      (this.state.media ??= {})[imageUrl] = { id, at: Date.now() }; this.save();
      return id;
    } catch (e) {
      this.o.log?.(`x media upload failed (${e instanceof Error ? e.message : e}); posting without the image`);
      return null;
    }
  }

  /** One post. Returns its id. */
  async post(text: string, opts: { inReplyTo?: string; mediaIds?: string[] } = {}): Promise<string> {
    const url = 'https://api.x.com/2/tweets';
    const body: Record<string, unknown> = { text: oneCashtag(text.slice(0, this.max)) };
    if (opts.inReplyTo) body.reply = { in_reply_to_tweet_id: opts.inReplyTo };
    if (opts.mediaIds?.length) body.media = { media_ids: opts.mediaIds };
    const res = await this.f(url, {
      method: 'POST',
      headers: { authorization: oauth1Header({ method: 'POST', url, creds: this.o.creds }), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await this.json(res);
    if (!res.ok) throw new Error(`x post ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    this.posted++;
    return (j.data as { id?: string } | undefined)?.id ?? '';
  }

  /** A message of any length: split into posts, the first carrying the image, each threading under the last. Returns the ids. */
  async postThread(text: string, opts: { inReplyTo?: string; image?: string | null } = {}): Promise<string[]> {
    const mediaIds = opts.image && /^https?:\/\//.test(opts.image) ? [await this.uploadMedia(opts.image)].filter((x): x is string => Boolean(x)) : [];
    const ids: string[] = [];
    let anchor = opts.inReplyTo;
    for (const [i, chunk] of chunkPost(text, this.max).entries()) {
      const id = await this.post(chunk, { inReplyTo: anchor, mediaIds: i === 0 ? mediaIds : [] });
      ids.push(id); anchor = id || anchor;
    }
    return ids;
  }

  /** Send a reply the way Telegram does: text (threaded if long) with the card attached. */
  async send(reply: Reply, inReplyTo?: string): Promise<string | undefined> {
    const ids = await this.postThread(renderForX(reply.rich, reply.buttons, { page: reply.page, publicUrl: this.o.publicUrl, rawAddresses: this.o.rawAddresses }), { inReplyTo, image: reply.image });
    return ids[0];
  }

  /** A standalone post to the feed: takeover announcements and the master shillbot's cadence posts. */
  async broadcast(text: string | Rich, image?: string | null, buttons?: Button[][]): Promise<void> {
    const rich: Rich = typeof text === 'string' ? (f) => f.esc(text) : text;
    await this.postThread(renderForX(rich, buttons, { page: '/king', publicUrl: this.o.publicUrl, rawAddresses: this.o.rawAddresses }), { image });
  }

  /** Mentions older than this on the very first poll (no since_id yet) are history, not commands. */
  static readonly FIRST_POLL_WINDOW_MS = 10 * 60_000;

  async mentions(): Promise<{ id: string; text: string; author_id: string; username: string; created_at?: string }[]> {
    const url = `https://api.x.com/2/users/${this.o.creds.botUserId}/mentions`;
    const params: Record<string, string> = {
      max_results: '25', 'tweet.fields': 'author_id,text,created_at', expansions: 'author_id', 'user.fields': 'username',
      ...(this.state.sinceId ? { since_id: this.state.sinceId } : {}),
    };
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const authorization = this.o.creds.bearer ? `Bearer ${this.o.creds.bearer}` : oauth1Header({ method: 'GET', url, params, creds: this.o.creds });
    const res = await this.f(u, { headers: { authorization }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) throw Object.assign(new Error('rate limited'), { reset: Number(res.headers.get('x-rate-limit-reset')) || 0 });
    if (!res.ok) throw new Error(`mentions ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data?: { id: string; text: string; author_id: string; created_at?: string }[]; includes?: { users?: { id: string; username: string }[] }; meta?: { newest_id?: string } };
    const users = new Map((j.includes?.users ?? []).map((x) => [x.id, x.username]));
    const firstPoll = !this.state.sinceId;
    if (j.meta?.newest_id) { this.state.sinceId = j.meta.newest_id; this.save(); }
    const cutoff = Date.now() - XSurface.FIRST_POLL_WINDOW_MS;
    return (j.data ?? [])
      .filter((t) => !firstPoll || !t.created_at || Date.parse(t.created_at) >= cutoff)
      .map((t) => ({ ...t, username: users.get(t.author_id) ?? t.author_id }));
  }

  /**
   * Answer one mention: reply thread, and a standalone post for a takeover. Marked answered before
   * anything is posted so a crash mid-thread cannot double-post; when the failure happened before
   * any post went out, the mention is queued and retried on later polls (up to MAX_ATTEMPTS).
   * Exposed so tests can drive it.
   */
  async dispatch(t: Mention, attempt = 1): Promise<void> {
    if (this.state.answered[t.id] || t.author_id === this.o.creds.botUserId) return;
    this.state.answered[t.id] = Date.now(); this.save();
    const before = this.posted;
    try {
      await this.answer(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.posted === before && attempt < MAX_ATTEMPTS) {
        delete this.state.answered[t.id];
        (this.state.retry ??= []).push({ t, attempts: attempt }); this.save();
        this.o.log?.(`x mention ${t.id} failed (attempt ${attempt}, will retry): ${msg}`);
      } else {
        this.o.log?.(`x mention ${t.id} failed for good: ${msg}`);
      }
    }
  }

  private async answer(t: Mention): Promise<void> {
    let anchor: string = t.id;
    let acked = false;
    const progress = async (rich: Rich) => {
      if (acked) return;                                    // X cannot edit: one "settling…" post, the outcome threads under it
      acked = true;
      const id = await this.post(chunkPost(this.o.rawAddresses ? plain(rich) : shortenAddresses(plain(rich)), this.max)[0], { inReplyTo: anchor }).catch((e) => { this.o.log?.(`x progress post failed: ${e}`); return ''; });
      if (id) anchor = id;
    };
    const reply = await this.commands.handle({ surface: 'x', author: `@${t.username}`, authorId: `x:${t.author_id}`, text: t.text, progress });
    if (!reply) { this.o.log?.(`x: @${t.username} ${t.id} "${t.text.slice(0, 60)}" is not a command`); return; }
    const ids = await this.send(reply, anchor);
    this.o.log?.(`x: answered @${t.username} ${t.id} "${t.text.slice(0, 60)}" -> ${ids ?? 'no id'}${reply.image ? ' +card' : ''}`);
    if (reply.announce) await this.broadcast(reply.announce, reply.image, reply.announceButtons).catch((e) => this.o.log?.(`x announce failed: ${e}`));
  }

  async pollOnce(): Promise<number> {
    const queued = (this.state.retry ?? []).splice(0);
    if (queued.length) this.save();
    for (const q of queued) await this.dispatch(q.t, q.attempts + 1);
    const ts = await this.mentions();
    for (const t of ts) await this.dispatch(t);
    return ts.length;
  }

  async poll(): Promise<void> {
    const every = this.o.pollMs ?? 90_000;
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        const reset = (e as { reset?: number }).reset;
        this.o.log?.(`x poll: ${e instanceof Error ? e.message : e}`);
        if (reset) await new Promise((r) => setTimeout(r, Math.max(0, reset * 1000 - Date.now()) + 1000));
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }

  stop(): void { this.stopped = true; }
}
