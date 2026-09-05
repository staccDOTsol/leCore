import { describe, expect, it } from 'vitest';
import { MemoryChain } from '../src/chain.js';
import { Commands, html, plain } from '../src/commands.js';
import { Hill, MemoryStore } from '../src/hill.js';
import { MockJudge } from '../src/judge.js';
import { MemoryUriProvider } from '../src/uri.js';
import { NeedsSolError, type Entry, type Quote } from '../src/entry.js';
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
  awarded: string[] = [];
  async awardHalf(winner: { toBase58(): string }) { this.awarded.push(winner.toBase58()); return [{ lpMint: 'LPMINT1', amount: '2596238674', signature: 'award-1' }]; }
}

/** What the chain says half the vault is worth; tests move it. */
let potOnChain = 0;
function setup(entry: FakeEntry | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koth-'));
  const hill = new Hill({ judge: new MockJudge('power'), chain: new MemoryChain({ name: 'Master Shill', symbol: 'SHILL', uri: 'u' }, profiles), uri: new MemoryUriProvider(), entry: { play: async () => ({ playSignature: 'free', detail: {} }) }, store: new MemoryStore(), potUsd: async () => potOnChain });
  const commands = new Commands({ hill, entry: entry as unknown as Entry | null, dataDir: dir, masterMint: 'MASTER', explorer: (s) => `https://x/${s}` });
  return { hill, commands };
}

describe('parse', async () => {
  const { Commands } = await import('../src/commands.js');
  it('reads the command through mentions, the ".@bot" convention and leading punctuation', () => {
    expect(Commands.parse('.@openzoobot king')).toEqual({ cmd: 'king', args: [] });
    expect(Commands.parse('@openzoobot shill So111 the chain is sol')).toEqual({ cmd: 'shill', args: ['So111', 'the', 'chain', 'is', 'sol'] });
    expect(Commands.parse('/fee@openzoobotbot')).toEqual({ cmd: 'fee', args: [] });
    expect(Commands.parse('"paid q1"')).toEqual({ cmd: 'paid', args: ['q1"'] });
    expect(Commands.parse('gm @openzoobot')).toBeNull();
  });
});

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
    const king0 = await t('/king');
    expect(king0.text).toMatch(/EMPTY/);
    expect(king0.text).toMatch(/POT \$0\.00 · take the hill and win HALF THE VAULT/);          // every reply carries the pot, from chain
    potOnChain = 12.5;
    const q = await t(`/shill ${A} sol is the chain the chain is sol`);
    expect(q.text).toMatch(/no payout wallet yet/);
    expect(q.text).toMatch(/send exactly 26.3/); expect(q.text).toMatch(/DEPOSIT111/); expect(q.text).toMatch(/paid q1/);
    expect(q.r?.buttons?.[0]?.[0]?.copy).toBe('26.3');
    expect(q.r?.buttons?.[0]?.[1]?.copy).toBe('DEPOSIT111');
    expect(q.r?.buttons?.[1]?.[0]?.data).toBe('paid:q1');
    expect(html(q.r!.rich)).toMatch(/<pre>DEPOSIT111<\/pre>/);
    expect((await t('paid q1')).text).toMatch(/not there yet/);
    expect((await t('paid q1', { authorId: 'tg:2' })).text).toMatch(/someone else/);
    entry.paid.add('q1');
    const progress: string[] = [];
    const r = await commands.handle({ ...ctx, text: 'paid:q1', progress: async (rich) => { progress.push(plain(rich)); } });
    const rt = plain(r!.rich);
    expect(rt).toMatch(/takes the empty hill/); expect(plain(r!.announce!)).toMatch(/master token is now/);
    expect(rt).toMatch(/play locked · tx: https:\/\/x\/sig-q1/);
    // the win: the pot is whatever the chain says half the vault is worth; no wallet yet so it is held
    expect(rt).toMatch(/YOU WIN THE POT ≈ \$12\.50/); expect(rt).toMatch(/held for you/); expect(rt).toMatch(/POT \$12\.50/);
    expect(entry.awarded).toEqual([]);
    const w = await t('wallet WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb');
    expect(w.text).toMatch(/payout wallet set/); expect(w.text).toMatch(/pot from reign 1 \(~\$12\.50\) is on its way/); expect(w.text).toMatch(/award-1/);
    expect(entry.awarded).toEqual(['WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb']);
    expect((await t('wallet WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb')).text).not.toMatch(/on its way/);   // nothing owed twice
    expect((await t('wallet nope')).text).toMatch(/not a Solana address/);
    expect(hill.king?.mint).toBe(A);
    expect(hill.king?.playSignature).toBe('sig-q1');
    expect((await t('paid q1')).text).toMatch(/no open quote/);
    expect((await t('king')).text).toMatch(/KING · REIGN 1\nWrapped SOL \$SOL/);
    expect((await t('hall')).text).toMatch(/#1 Wrapped SOL/);
    expect((await t('fee')).text).toMatch(/1.01\^1/);
  });
  it('resumes a settlement that failed after the sweep, even though the deposit address is empty now', async () => {
    const entry = new FakeEntry();
    let calls = 0;
    entry.settle = async (id: string) => { const q = entry.quotes.get(id)!; calls++; q.status = 'settled'; q.playSignature = `sig-${id}`; return q; };
    const { commands } = setup(entry);
    const t = (text: string) => commands.handle({ surface: 'telegram', author: '@a', authorId: 'tg:1', text });
    await t(`/shill ${A} sol is the chain the chain is sol`);
    const q = entry.quotes.get('q1')!;
    q.status = 'failed'; q.steps.sweep = 'swept-sig';                 // swept, then died at the swap; not in entry.paid: the address is empty
    const r = await t('paid q1');
    expect(calls).toBe(1);
    expect(plain(r!.rich)).not.toMatch(/not there yet/);
  });

  it('tells the player to top up the fee payer when the pool cannot be created, and offers a retry', async () => {
    const entry = new FakeEntry();
    entry.settle = async () => { throw new NeedsSolError('FEEPAYER111', 0.02, 0.18, 0.15); };
    const { commands } = setup(entry);
    const t = (text: string) => commands.handle({ surface: 'telegram', author: '@a', authorId: 'tg:1', text });
    await t(`/shill ${A} sol is the chain the chain is sol`);
    entry.paid.add('q1');
    const r = await t('paid q1');
    expect(plain(r!.rich)).toMatch(/0.15 SOL/);
    expect(plain(r!.rich)).toMatch(/send 0.16 SOL to the fee payer\nFEEPAYER111/);
    expect(plain(r!.rich)).toMatch(/paid q1/);
    expect(r?.buttons?.[0]?.[0]).toMatchObject({ copy: 'FEEPAYER111' });
    expect(r?.buttons?.[0]?.[1]).toEqual({ label: 'Try again', data: 'paid:q1' });
    expect(r?.page).toBe('/king');
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
