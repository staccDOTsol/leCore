import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XSurface, chunkPost, oauth1Header, renderForX } from '../src/surfaces/x.js';
import type { Commands, Ctx, Reply } from '../src/commands.js';

const creds = { apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts', bearer: '', botUserId: '' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>';

type Call = { url: string; method: string; body?: unknown; auth?: string };
function fakeX(mentions: unknown[]): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let n = 1000;
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (url.endsWith('/card.png')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/card.svg')) return new Response(SVG, { headers: { 'content-type': 'image/svg+xml' } });
    if (url.endsWith('/2/users/me')) { calls.push({ url, method, auth }); return Response.json({ data: { id: '99', username: 'openzoobot' } }); }
    if (url.includes('/mentions')) { calls.push({ url, method, auth }); return Response.json({ data: mentions, includes: { users: [{ id: '7', username: 'alice' }] }, meta: { newest_id: '2' } }); }
    if (url.endsWith('/2/media/upload')) {
      const form = init?.body as FormData;
      const file = form.get('media') as Blob;
      calls.push({ url, method, auth, body: { type: file.type, size: file.size, category: form.get('media_category') } });
      return Response.json({ data: { id: `m${++n}` } });
    }
    if (url.endsWith('/2/tweets')) { calls.push({ url, method, auth, body: JSON.parse(String(init?.body)) }); return Response.json({ data: { id: String(++n) } }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { f, calls };
}

describe('x helpers', () => {
  it('signs OAuth 1.0a deterministically', () => {
    const h = oauth1Header({ method: 'POST', url: 'https://api.x.com/2/tweets', creds, nonce: 'n', timestamp: '1' });
    expect(h).toMatch(/^OAuth oauth_consumer_key="k", oauth_nonce="n", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1", oauth_token="t", oauth_version="1.0"$/);
  });
  it('threads long text on line boundaries and cuts oversized lines', () => {
    expect(chunkPost('a\nb\nc', 3)).toEqual(['a\nb', 'c']);
    expect(chunkPost('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(chunkPost('short', 280)).toEqual(['short']);
    expect(chunkPost('', 280)).toEqual(['']);
  });
  it('renders url buttons as lines and drops the rest', () => {
    expect(renderForX((f) => f.b('hi'), [[{ label: 'Copy', copy: 'X' }, { label: 'Solscan', url: 'https://s/1' }]])).toBe('hi\nSolscan: https://s/1');
  });
});

describe('x surface', () => {
  const seen: Ctx[] = [];
  const commands = {
    handle: async (ctx: Ctx): Promise<Reply | null> => {
      seen.push(ctx);
      if (/king/.test(ctx.text)) return { rich: (f) => `${f.b('KING')} is bonk\n${'x'.repeat(300)}`, image: 'https://host/assets/card.png', buttons: [[{ label: 'Hall', data: 'cmd:hall' }]] };
      if (/paid/.test(ctx.text)) {
        await ctx.progress?.(() => 'SETTLING q1\n✓ swept');
        await ctx.progress?.(() => 'SETTLING q1\n✓ swept\n✓ locked');
        return { rich: () => 'won', image: 'https://host/assets/card.svg', announce: () => 'NEW KING', announceButtons: [[{ label: 'Solscan', url: 'https://s/tx' }]] };
      }
      return null;
    },
  } as unknown as Commands;

  it('learns its id, threads long replies with the card as media, acks settlement once, announces takeovers', async () => {
    const { f, calls } = fakeX([
      { id: '1', text: '@openzoobot king', author_id: '7' },
      { id: '2', text: '@openzoobot paid q1', author_id: '7' },
      { id: '3', text: 'something the bot itself said', author_id: '99' },
    ]);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koth-x-'));
    const x = new XSurface(commands, { creds: { ...creds }, dataDir, fetchImpl: f, maxChars: 280 });
    expect(await x.start()).toEqual({ id: '99', username: 'openzoobot' });
    expect(await x.pollOnce()).toBe(3);

    expect(seen.map((c) => c.text)).toEqual(['@openzoobot king', '@openzoobot paid q1']);   // its own post is skipped
    expect(seen[0]).toMatchObject({ surface: 'x', author: '@alice', authorId: 'x:7' });

    const uploads = calls.filter((c) => c.url.endsWith('/2/media/upload'));
    expect(uploads[0].body).toMatchObject({ type: 'image/png', category: 'tweet_image' });
    const tweets = calls.filter((c) => c.url.endsWith('/2/tweets')).map((c) => c.body as { text: string; reply?: { in_reply_to_tweet_id: string }; media?: { media_ids: string[] } });
    // king: two posts (the second line is 300 chars), the first replying to the mention and carrying the media, the second threading under the first
    expect(tweets[0]).toMatchObject({ text: 'KING is bonk', reply: { in_reply_to_tweet_id: '1' }, media: { media_ids: ['m1001'] } });
    expect(tweets[1].text).toBe('x'.repeat(280));
    expect(tweets[1].reply?.in_reply_to_tweet_id).toBe(tweets[0] && '1002');
    expect(tweets[1].media).toBeUndefined();
    expect(tweets[2]).toMatchObject({ text: 'x'.repeat(20) });
    // paid: exactly one "settling" ack under the mention, the outcome under the ack, then the takeover as a standalone post with the SVG rasterized
    expect(tweets[3]).toMatchObject({ text: 'SETTLING q1\n✓ swept', reply: { in_reply_to_tweet_id: '2' } });
    expect(tweets[4]).toMatchObject({ text: 'won', reply: { in_reply_to_tweet_id: '1005' } });   // 1005 = the settling ack; 1006 was the svg upload
    expect(tweets[5]).toMatchObject({ text: 'NEW KING\nSolscan: https://s/tx' });
    expect(tweets[5].reply).toBeUndefined();
    expect(tweets.length).toBe(6);
    const svgUpload = uploads[1].body as { type: string; size: number };
    expect(svgUpload.type).toBe('image/png');
    expect(svgUpload.size).toBeGreaterThan(PNG.length);

    // answered set + since_id persisted; a second poll answers nothing again
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'x-state.json'), 'utf8')) as { sinceId: string; answered: Record<string, number> };
    expect(state.sinceId).toBe('2');
    expect(Object.keys(state.answered).sort()).toEqual(['1', '2']);
    await x.pollOnce();
    expect(seen.length).toBe(2);
  });

  it('uses OAuth user context for mentions when no bearer is set', async () => {
    const { f, calls } = fakeX([]);
    const x = new XSurface(commands, { creds: { ...creds, botUserId: '99' }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'koth-x-')), fetchImpl: f });
    await x.pollOnce();
    expect(calls[0].auth).toMatch(/^OAuth /);
  });
});
