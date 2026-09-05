import { describe, expect, it } from 'vitest';
import { MemoryChain } from '../src/chain.js';
import { Commands, html, plain, type Ctx } from '../src/commands.js';
import { Hill, MemoryStore } from '../src/hill.js';
import { MockJudge } from '../src/judge.js';
import { MemoryUriProvider } from '../src/uri.js';
import { NeedsSolError, type Entry, type Quote } from '../src/entry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const key = () => Keypair.generate().publicKey.toBase58();
/** Real-shaped addresses: the command layer parses them before sending. */
const LP1 = key(), POOL1 = key(), LPSOL = key(), POOLSOL = key(), NFT1 = key();

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
  async settle(id: string): Promise<Quote> {
    const q = this.quotes.get(id)!; q.status = 'settled'; q.playSignature = `sig-${id}`;
    if (q.kind === 'donation') { q.steps = { swapHalf: 'swap', pool: 'pool', poolId: POOLSOL, lpMint: LPSOL, lpRaw: '1000', poolCreated: 'true', lock: 'lock-sig', nftMint: NFT1, nftOwner: q.nftOwner ?? this.feePayer }; return q; }
    q.steps = { swapHalf: 'swap', pool: 'pool', poolId: POOL1, lpMint: LP1, lpRaw: '1000000', pushedRaw: '350000', play: `sig-${id}` };
    return q;
  }
  feePayer = 'FEEPAYER111';
  poolExists = true;
  async donate(a: { donor: string; surface: string; sol: number; nftOwner?: string | null }) {
    const q = { id: `q${this.quotes.size + 1}`, kind: 'donation', player: a.donor, surface: a.surface, mint: 'So11111111111111111111111111111111111111112', depositAddress: 'DEPOSIT111', playFeeSol: a.sol, playFeeUsd: a.sol * 100, inferenceUsd: 0, bufferPct: 0, totalUsd: a.sol * 100, solUsd: 100, tokenUsd: 100, decimals: 9, amountUi: a.sol + (this.poolExists ? 0 : 0.18), amountRaw: String(Math.round((a.sol + (this.poolExists ? 0 : 0.18)) * 1e9)), extraSol: this.poolExists ? 0 : 0.18, ...(a.nftOwner ? { nftOwner: a.nftOwner } : {}), createdAt: 0, expiresAt: 1e15, status: 'pending', steps: {}, playSignature: null, error: null } as Quote & { extraSol: number; poolExists: boolean };
    q.poolExists = this.poolExists; this.quotes.set(q.id, q); return q;
  }
  usdPerRaw = 0.00001;                                                       // 1,000,000 LP = $10
  async priceLp(lpMint: { toBase58(): string }) { return { pool: lpMint, usdPerRaw: this.usdPerRaw }; }
  pushes: { id: string; raw: bigint }[] = [];
  async pushToVault(q: Quote, raw: bigint) { this.pushes.push({ id: q.id, raw }); return `push-${this.pushes.length}`; }
  sentLp: { lpMint: string; raw: bigint; to: string }[] = [];
  async sendLp(lpMint: { toBase58(): string }, raw: bigint, to: { toBase58(): string }) { this.sentLp.push({ lpMint: lpMint.toBase58(), raw, to: to.toBase58() }); return `lp-${this.sentLp.length}`; }
  locks: { pool: string; raw: bigint; owner: string }[] = [];
  async lockOnRaydium(pool: { toBase58(): string }, raw: bigint, owner: { toBase58(): string }) { this.locks.push({ pool: pool.toBase58(), raw, owner: owner.toBase58() }); const nft = this.locks.length === 1 ? NFT1 : key(); return { signature: `lock-${this.locks.length}`, nftMint: { toBase58: () => nft } }; }
  sentNfts: { nft: string; to: string }[] = [];
  async sendNft(nft: { toBase58(): string }, to: { toBase58(): string }) { this.sentNfts.push({ nft: nft.toBase58(), to: to.toBase58() }); return `nft-${this.sentNfts.length}`; }
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

describe('parse (dividends, donate)', () => {
  it('knows the new words and their aliases', () => {
    expect(Commands.parse('donate 0.5')).toEqual({ cmd: 'donate', args: ['0.5'] });
    expect(Commands.parse('/divs')).toEqual({ cmd: 'dividends', args: [] });
    expect(Commands.parse('cmd:dividends')).toEqual({ cmd: 'dividends', args: [] });
  });
});

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
    const ctx: Ctx = { surface: 'telegram', author: '@alice', authorId: 'tg:1', text: '' };
    const t = async (text: string, over: Partial<typeof ctx> = {}) => { const r = await commands.handle({ ...ctx, ...over, text }); return { r, text: r ? plain(r.rich) : '' }; };
    const king0 = await t('/king');
    expect(king0.text).toMatch(/EMPTY/);
    expect(king0.text).toMatch(/POT \$0\.00 · take the hill and win HALF THE VAULT/);          // every reply carries the pot, from chain
    expect(king0.text).toMatch(/THIS is how you play: https:\/\/t\.me\/theTokenonsolana\/37167/);   // and the surface's explainer post
    expect((await t('/king', { surface: 'x' })).text).toMatch(/THIS is how you play: https:\/\/x\.com\/STACCoverflow\/status\/2096102767702016152/);
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

const W1 = 'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb', W2 = 'GMtVk2in3spHHmrvvjnWqjJkx17XdDJCokXEnRYhH4KY';

describe('dividends over plays', () => {
  it('splits every play: 20% to past kings with a wallet, 10% to every player, 35% to the winner unlocked, the rest pushed; pays lock NFTs from $1', async () => {
    const entry = new FakeEntry();
    const { commands, hill } = setup(entry);
    const as = (authorId: string, author: string) => (text: string) => commands.handle({ surface: 'telegram', author, authorId, text });
    const a = as('tg:1', '@a'), b = as('tg:2', '@b');
    // the first play: nobody before it, so the whole 30% pushes too; a wins on an empty hill
    await a(`wallet ${W1}`);
    await a(`/shill ${B} usdc the dollar coin of the internet`); entry.paid.add('q1');
    const r1 = await a('paid q1');
    expect(hill.king?.author).toBe('@a');
    expect(entry.sentLp).toEqual([{ lpMint: LP1, raw: 350_000n, to: W1 }]);                    // the winner's 35%, plain LP
    expect(entry.pushes).toEqual([{ id: 'q1', raw: 300_000n }]);                                  // kings' + players' shares with nobody to take them
    expect(plain(r1!.rich)).toMatch(/35% of the LP is yours, unlocked/);
    expect(commands.dividends.person('tg:1')).toMatchObject({ plays: 1, wins: 1, wallet: W1 });
    // b plays and loses: 20% to a (the only past king), 10% to a (the only past player), 70% pushes
    entry.pushes = [];
    await b(`/shill ${A} sol is the chain the chain is sol`); entry.paid.add('q2');
    const r2 = await b('paid q2');
    expect(hill.king?.author).toBe('@a');
    expect(entry.pushes).toEqual([{ id: 'q2', raw: 350_000n }]);                                  // the loser's 35% joins the 35% settle already pushed
    expect(plain(r2!.rich)).toMatch(/20% → 1 past king · 10% → 1 player/);
    // a's 300,000 LP is $3: locked on Raydium, NFT to a's wallet, in the same round
    expect(entry.locks).toEqual([{ pool: POOL1, raw: 300_000n, owner: W1 }]);
    expect(commands.dividends.person('tg:1')?.paid.map((x) => [x.reason, x.usd, x.nftMint])).toEqual([['win', 3.5, null], ['dividend', 3, NFT1]]);
    expect(plain(r2!.rich)).toMatch(/dividends paid this round: \$3.00/);
    // b has no wallet: their 10% player share from the next play accrues instead
    entry.locks = [];
    await a(`/shill ${A} sol again the chain the chain is sol`); entry.paid.add('q3');
    await a('paid q3');
    const pb = commands.dividends.person('tg:2')!;
    expect(BigInt(pb.accrued[LP1].raw)).toBe(50_000n);                                              // 10% split by plays: a 1, b 1
    expect(entry.locks.map((l) => l.owner)).toEqual([W1]);
    const d = await b('dividends');
    expect(plain(d!.rich)).toMatch(new RegExp(`accruing: \\$0.50 in pool ${POOL1} \\(paid at \\$1\\)`));
    expect(plain(d!.rich)).toMatch(/no payout wallet yet/);
  });

  it('a winner without a wallet is owed the plain LP and gets it, with any dividends, on wallet', async () => {
    const entry = new FakeEntry();
    const { commands } = setup(entry);
    const t = (text: string) => commands.handle({ surface: 'x', author: '@w', authorId: 'x:9', text });
    await t(`/shill ${A} sol is the chain the chain is sol`); entry.paid.add('q1');
    const r = await t('paid q1');
    expect(plain(r!.rich)).toMatch(/35% of the LP is yours, unlocked: say wallet/);
    expect(entry.sentLp).toEqual([]);
    expect(commands.dividends.person('x:9')?.owedLp[LP1].raw).toBe('350000');
    const w = await t(`wallet ${W2}`);
    expect(entry.sentLp).toEqual([{ lpMint: LP1, raw: 350_000n, to: W2 }]);
    expect(plain(w!.rich)).toMatch(new RegExp(`your win: 350000 LP ${LP1} sent`));
    expect(commands.dividends.person('x:9')?.owedLp).toEqual({});
  });
});

describe('donations', () => {
  it('quotes SOL to a one-time address, settles into a Raydium lock, and sends the NFT to the registered wallet', async () => {
    const entry = new FakeEntry();
    const { commands } = setup(entry);
    const t = (text: string) => commands.handle({ surface: 'telegram', author: '@d', authorId: 'tg:5', text });
    expect(plain((await t('donate'))!.rich)).toMatch(/usage: donate <sol>/);
    expect(plain((await t('donate 0.001'))!.rich)).toMatch(/usage: donate <sol>/);
    await t(`wallet ${W2}`);
    const q = await t('donate 0.5');
    expect(plain(q!.rich)).toMatch(/DONATION q1 · @d\nsend exactly 0.5 SOL\nto this one-time address\nDEPOSIT111/);
    expect(plain(q!.rich)).toMatch(/joins the SOL\/MASTER pool/);
    expect(plain(q!.rich)).toMatch(new RegExp(`lock NFT .* goes to ${W2}`));
    expect(q?.page).toBe('/q/q1');
    expect(q?.buttons?.[0]?.[0]).toMatchObject({ copy: '0.5' });
    expect(plain((await t('paid q1'))!.rich)).toMatch(/not there yet/);
    entry.paid.add('q1');
    const r = await t('paid q1');
    expect(plain(r!.rich)).toMatch(/0.5 SOL donated by @d/);
    expect(plain(r!.rich)).toMatch(/LP locked for good on Raydium/);
    expect(plain(r!.rich)).toMatch(new RegExp(`your lock NFT ${NFT1}`));
    expect(plain(r!.rich)).toMatch(new RegExp(`sent to ${W2}`));
    expect(r?.announce).toBeTruthy();
    expect(commands.dividends.person('tg:5')?.plays).toBe(1);                                      // a donor is a player: in on the 10%
    expect(plain((await t('paid q1'))!.rich)).toMatch(/no open quote/);
  });

  it('asks for Raydium\'s fee on top when there is no SOL/MASTER pool, and holds the NFT for a donor with no wallet until they name one', async () => {
    const entry = new FakeEntry();
    entry.poolExists = false;
    const { commands } = setup(entry);
    const t = (text: string) => commands.handle({ surface: 'x', author: '@e', authorId: 'x:6', text });
    const q = await t('donate 1');
    expect(plain(q!.rich)).toMatch(/send exactly 1.18 SOL/);
    expect(plain(q!.rich)).toMatch(/\+ 0.18 SOL because there is no SOL\/MASTER pool yet/);
    expect(plain(q!.rich)).toMatch(/goes to the wallet that sends the SOL/);
    entry.paid.add('q1');
    const r = await t('paid q1');
    expect(plain(r!.rich)).toMatch(/we are holding it for you/);
    expect(plain(r!.rich)).toMatch(/0.18 SOL of it paid Raydium's pool creation/);
    const w = await t(`wallet ${W1}`);
    expect(entry.sentNfts).toEqual([{ nft: NFT1, to: W1 }]);
    expect(plain(w!.rich)).toMatch(new RegExp(`lock NFT ${NFT1} sent`));
  });
});
