/**
 * X: the automated bot, in the shape of openzoo's `xbot` command -- poll mentions with the app
 * bearer, answer in the user's context with OAuth 1.0a, remember `since_id` and what was answered
 * so nothing is replied to twice. The master shillbot also posts the king's shill on a cadence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { plain, type Commands } from '../commands.js';

export type XCreds = { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string; bearer: string; botUserId: string };
export type XOpts = { creds: XCreds; dataDir: string; pollMs?: number; log?: (s: string) => void; fetchImpl?: typeof fetch };

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a header. Only query params sign -- a JSON body does not (signing it yields a 401 that looks like bad creds). */
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

type XState = { sinceId: string | null; answered: Record<string, number> };

export class XSurface {
  private state: XState;
  private file: string;
  private stopped = false;
  private f: typeof fetch;
  constructor(private commands: Commands, private o: XOpts) {
    this.f = o.fetchImpl ?? fetch;
    this.file = path.join(o.dataDir, 'x-state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as XState; } catch { this.state = { sinceId: null, answered: {} }; }
  }
  private save(): void { fs.mkdirSync(this.o.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); }

  async post(text: string, inReplyTo?: string): Promise<string> {
    const url = 'https://api.x.com/2/tweets';
    const res = await this.f(url, {
      method: 'POST',
      headers: { authorization: oauth1Header({ method: 'POST', url, creds: this.o.creds }), 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 4000), ...(inReplyTo ? { reply: { in_reply_to_tweet_id: inReplyTo } } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { data?: { id: string } };
    if (!res.ok) throw new Error(`x post ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j.data?.id ?? '';
  }

  async mentions(): Promise<{ id: string; text: string; author_id: string; username: string }[]> {
    const u = new URL(`https://api.x.com/2/users/${this.o.creds.botUserId}/mentions`);
    u.searchParams.set('max_results', '25');
    u.searchParams.set('tweet.fields', 'author_id,text,created_at');
    u.searchParams.set('expansions', 'author_id');
    u.searchParams.set('user.fields', 'username');
    if (this.state.sinceId) u.searchParams.set('since_id', this.state.sinceId);
    const res = await this.f(u, { headers: { authorization: `Bearer ${this.o.creds.bearer}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) throw Object.assign(new Error('rate limited'), { reset: Number(res.headers.get('x-rate-limit-reset')) || 0 });
    if (!res.ok) throw new Error(`mentions ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data?: { id: string; text: string; author_id: string }[]; includes?: { users?: { id: string; username: string }[] }; meta?: { newest_id?: string } };
    const users = new Map((j.includes?.users ?? []).map((x) => [x.id, x.username]));
    if (j.meta?.newest_id) { this.state.sinceId = j.meta.newest_id; this.save(); }
    return (j.data ?? []).map((t) => ({ ...t, username: users.get(t.author_id) ?? t.author_id }));
  }

  async poll(): Promise<void> {
    const every = this.o.pollMs ?? 90_000;
    while (!this.stopped) {
      try {
        for (const t of await this.mentions()) {
          if (this.state.answered[t.id]) continue;
          const reply = await this.commands.handle({ surface: 'x', author: `@${t.username}`, authorId: `x:${t.author_id}`, text: t.text });
          if (reply) await this.post(plain(reply.rich), t.id);
          this.state.answered[t.id] = Date.now();
          this.save();
        }
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
