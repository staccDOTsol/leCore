import { describe, expect, it } from 'vitest';
import { MemoryChain } from '../src/chain.js';
import { Commands, html, plain } from '../src/commands.js';
import { Hill, MemoryStore } from '../src/hill.js';
import { MockJudge } from '../src/judge.js';
import { MemoryUriProvider } from '../src/uri.js';
import type { Entry, Quote } from '../src/entry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const A = 'So11111111111111111111111111111111111111112', B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const profiles = {
  [A]: { name: 'Wrapped SOL', symbol: 'SOL', liquidityUsd: 5e7, marketCapUsd: 7e10, fdvUsd: 7e10, volume24hUsd: 5e8, buys24h: 6e4, sells24h: 4e4 },
  [B]: { name: 'USD Coin', symbol: 'USDC', liquidityUsd: 1e8, marketCapUsd: 6e10, fdvUsd: 6e10, volume24hUsd: 1e9, buys24h: 1e5, sells24h: 1e5, holders: 3e6, top10Share: 0.2 },
};

class FakeEntry {
  quotes = new Map<string, Quote>();
  paid = new Set<string>();
  async quote(a: { player: string; surface: string; mint: string; playFeeSol: number }): Promise<Quote> {
    const q = { id: `q${this.quotes.size + 1}`, player: a.player, surface: a.surface, mint: a.mint, depositAddress: 'DEPOSIT111', playFeeSol: a.playFeeSol, playFeeUsd: 25, inferenceUsd: 0.05, bufferPct: 5, totalUsd: 26.3, solUsd: 100, tokenUsd: 1, decimals: 6, amountUi: 26.3, amountRaw: '26300000', createdAt: 0, expiresAt: 1e15, status: 'pending', steps: {}, playSignature: null, error: null } as Quote;
    this.quotes.set(q.id, q); return q;
  }
  async checkDeposit(id: string) { const q = this.quotes.get(id)!; const paid = this.paid.has(id); return { quote: q, paid, balanceRaw: paid ? 26300000n : 0n }; }
  async settle(id: string): Promise<Quote> { const q = this.quotes.get(id)!; q.status = 'settled'; q.playSignature = `sig-${id}`; return q; }
}

function setup(entry: FakeEntry | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koth-'));
  const hill = new Hill({ judge: new MockJudge('power'), chain: new MemoryChain({ name: 'Master Shill', symbol: 'SHILL', uri: 'u' }, profiles), uri: new MemoryUriProvider(), entry: { play: async () => ({ playSignature: 'free', detail: {} }) }, store: new MemoryStore() });
  const commands = new Commands({ hill, entry: entry as unknown as Entry | null, dataDir: dir, masterMint: 'MASTER', explorer: (s) => `https://x/${s}` });
  return { hill, commands };
}

describe('command parsing', () => {
  it('accepts slashes, bot mentions and bare words', () => {
    expect(Commands.parse('/king')).toEqual({ cmd: 'king', args: [] });
    expect(Commands.parse('@kothbot king')).toEqual({ cmd: 'king', args: [] });
    expect(Commands.parse('/shill@kothbot MINT hello there')).toEqual({ cmd: 'shill', args: ['MINT', 'hello', 'there'] });
    expect(Commands.parse('entry')).toEqual({ cmd: 'fee', args: [] });
    expect(Commands.parse('lol what')).toBeNull();
    expect(Commands.parse('cmd:king')).toEqual({ cmd: 'king', args: [] });
    expect(Commands.parse('paid:a1b2c3')).toEqual({ cmd: 'paid', args: ['a1b2c3'] });
    expect(Commands.parse('cancel:a1b2c3')).toEqual({ cmd: 'cancel', args: ['a1b2c3'] });
  });
});

describe('commands over the hill', () => {
  it('quotes, refuses unpaid, then settles and fights on paid', async () => {
    const entry = new FakeEntry();
    const { hill, commands } = setup(entry);
    const ctx = { surface: 'telegram' as const, author: '@alice', authorId: 'tg:1', text: '' };
    const t = async (text: string, over: Partial<typeof ctx> = {}) => { const r = await commands.handle({ ...ctx, ...over, text }); return { r, text: r ? plain(r.rich) : '' }; };
    expect((await t('/king')).text).toMatch(/EMPTY/);
    const q = await t(`/shill ${A} sol is the chain the chain is sol`);
    expect(q.text).toMatch(/send exactly 26.3/); expect(q.text).toMatch(/DEPOSIT111/); expect(q.text).toMatch(/paid q1/);
    expect(q.r?.buttons?.[0]?.[0]?.copy).toBe('DEPOSIT111');
    expect(q.r?.buttons?.[0]?.[1]?.data).toBe('paid:q1');
    expect(html(q.r!.rich)).toMatch(/<pre>DEPOSIT111<\/pre>/);
    expect((await t('paid q1')).text).toMatch(/not there yet/);
    expect((await t('paid q1', { authorId: 'tg:2' })).text).toMatch(/someone else/);
    entry.paid.add('q1');
    const progress: string[] = [];
    const r = await commands.handle({ ...ctx, text: 'paid:q1', progress: async (rich) => { progress.push(plain(rich)); } });
    const rt = plain(r!.rich);
    expect(rt).toMatch(/takes the empty hill/); expect(plain(r!.announce!)).toMatch(/master token is now/);
    expect(rt).toMatch(/play locked · tx: https:\/\/x\/sig-q1/);
    expect(hill.king?.mint).toBe(A);
    expect(hill.king?.playSignature).toBe('sig-q1');
    expect((await t('paid q1')).text).toMatch(/no open quote/);
    expect((await t('king')).text).toMatch(/KING · REIGN 1\nWrapped SOL \$SOL/);
    expect((await t('hall')).text).toMatch(/#1 Wrapped SOL/);
    expect((await t('fee')).text).toMatch(/1.01\^1/);
  });
  it('plays for free when no entry flow is configured', async () => {
    const { commands } = setup(null);
    const r = await commands.handle({ surface: 'discord', author: 'bob', authorId: 'dc:1', text: `shill ${B} stable is the new volatile ok` });
    expect(plain(r!.rich)).toMatch(/takes the empty hill/);
  });
  it('validates shill arguments', async () => {
    const { commands } = setup(null);
    expect(plain((await commands.handle({ surface: 'x', author: '@c', authorId: 'x:1', text: 'shill nope' }))!.rich)).toMatch(/usage/);
    expect(plain((await commands.handle({ surface: 'x', author: '@c', authorId: 'x:1', text: `shill ${A} hi` }))!.rich)).toMatch(/at least a sentence/);
    expect(html((await commands.handle({ surface: 'x', author: '@c', authorId: 'x:1', text: `shill ${A} <b>hi</b> there friends` }))!.rich)).not.toMatch(/<b>hi/);
  });
});
