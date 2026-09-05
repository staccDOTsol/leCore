import { describe, expect, it } from 'vitest';
import { MemoryChain } from '../src/chain.js';
import { Hill, MemoryStore, attemptFeeSol, type EntryLike } from '../src/hill.js';
import { MockJudge } from '../src/judge.js';
import { MemoryUriProvider } from '../src/uri.js';

const A = 'A'.repeat(32), B = 'B'.repeat(32), C = 'C'.repeat(32);
const profiles = {
  [A]: { name: 'Alpha', symbol: 'ALPHA', liquidityUsd: 1e6, marketCapUsd: 5e6, fdvUsd: 5e6, volume24hUsd: 2e6, buys24h: 500, sells24h: 300 },
  [B]: { name: 'Beta', symbol: 'BETA', liquidityUsd: 1e3, marketCapUsd: 5e3, fdvUsd: 5e3, volume24hUsd: 100, buys24h: 1, sells24h: 3 },
  [C]: { name: 'Gamma', symbol: 'GAMMA', liquidityUsd: 5e7, marketCapUsd: 5e9, fdvUsd: 5e9, volume24hUsd: 1e8, buys24h: 9000, sells24h: 4000, holders: 100000, top10Share: 0.1 },
};

class CountingEntry implements EntryLike {
  calls: { player: string; mint: string; feeSol: number }[] = [];
  async play(a: { player: string; mint: string; feeSol: number }) { this.calls.push(a); return { playSignature: `play-${this.calls.length}`, detail: {} }; }
}

function hill(opts: { now?: () => number } = {}) {
  const chain = new MemoryChain({ name: 'Master Shill', symbol: 'SHILL', uri: 'https://x/genesis.json' }, profiles);
  const entry = new CountingEntry();
  const uri = new MemoryUriProvider();
  const store = new MemoryStore();
  const h = new Hill({ judge: new MockJudge('power'), chain, uri, entry, store, now: opts.now });
  return { h, chain, entry, uri, store };
}

describe('attempt fee', () => {
  it('starts at 0.05 SOL and compounds 1% per takeover', () => {
    expect(attemptFeeSol(0)).toBe(0.05);
    expect(attemptFeeSol(1)).toBe(0.0505);
    expect(attemptFeeSol(10)).toBeCloseTo(0.05 * 1.01 ** 10, 6);
    expect(attemptFeeSol(2, 1, 10)).toBeCloseTo(1.21, 6);
  });
});

describe('hill', () => {
  it('first challenger takes the empty hill, pays the fee, and the master token is rewritten', async () => {
    const { h, chain, entry, uri } = hill();
    const out = await h.challenge({ mint: A, pitch: 'alpha wins', author: 'p1', surface: 'telegram' });
    expect(out.record.result).toBe('won');
    expect(out.king?.reign).toBe(1);
    expect(entry.calls[0]).toEqual({ player: 'p1', mint: A, feeSol: 0.05 });
    expect(chain.updates).toHaveLength(1);
    expect(chain.master.name).toBe('KING Alpha');
    expect(chain.master.symbol).toBe('KALPHA');
    expect(chain.master.uri).toBe('memory://koth/1.json');
    const doc = uri.docs.get(1)!;
    expect(doc.name).toBe('KING Alpha');
    expect(doc.properties.koth.king_mint).toBe(A);
    expect(doc.properties.koth.play_signature).toBe('play-1');
    expect(doc.attributes.find((a) => a.trait_type === 'HP')?.value).toBe(out.king?.card.stats.hp);
    expect(h.attemptFee()).toBe(0.0505);
  });

  it('a weaker challenger loses, pays, and the king stays; a stronger one takes over and the old king enters the hall', async () => {
    const { h, chain, entry } = hill();
    await h.challenge({ mint: A, pitch: 'alpha', author: 'p1', surface: 'telegram' });
    const lost = await h.challenge({ mint: B, pitch: 'beta', author: 'p2', surface: 'discord' });
    expect(lost.record.result).toBe('lost');
    expect(lost.record.verdict?.winner).toBe('incumbent');
    expect(lost.record.playSignature).toBe('play-2');
    expect(h.king?.mint).toBe(A);
    expect(chain.updates).toHaveLength(1);
    expect(entry.calls[1].feeSol).toBe(0.0505);

    const won = await h.challenge({ mint: C, pitch: 'gamma', author: 'p3', surface: 'x' });
    expect(won.record.result).toBe('won');
    expect(h.king?.mint).toBe(C);
    expect(h.king?.reign).toBe(2);
    expect(h.hallOfFame.map((k) => k.mint)).toEqual([A]);
    expect(chain.master.name).toBe('KING Gamma');
    expect(h.attemptFee()).toBeCloseTo(0.05 * 1.01 ** 2, 6);
    expect(h.snapshot.challenges).toHaveLength(3);
    expect(won.record.usage?.usd).toBeGreaterThan(0);
  });

  it('the pot is read from chain when someone wins: recorded on the challenge and in the awards ledger', async () => {
    let onChain = 0;                                                   // what half the vault is worth right now, per the chain
    const chain = new MemoryChain({ name: 'Master Shill', symbol: 'SHILL', uri: 'https://x/genesis.json' }, profiles);
    const h = new Hill({ judge: new MockJudge('power'), chain, uri: new MemoryUriProvider(), entry: new CountingEntry(), store: new MemoryStore(), potUsd: async () => onChain });
    expect(await h.potUsd()).toBe(0);
    onChain = 5;
    const first = await h.challenge({ mint: B, pitch: 'beta', author: 'p1', surface: 'telegram' }, { prepaid: { playSignature: 's1', feeSol: 0.05, stakeUsd: 10 } });
    expect(first.potUsd).toBe(5);                                      // the empty-hill winner takes half of what is there
    onChain = 7.5;
    const lost = await h.challenge({ mint: B, pitch: 'beta again', author: 'p2', surface: 'x' }, { prepaid: { playSignature: 's2', feeSol: 0.05, stakeUsd: 10 } });
    expect(lost.record.result).toBe('lost'); expect(lost.potUsd).toBeNull();
    onChain = 12.5;
    const won = await h.challenge({ mint: C, pitch: 'gamma', author: 'p3', surface: 'x' }, { prepaid: { playSignature: 's3', feeSol: 0.0505, stakeUsd: 10 } });
    expect(won.record.result).toBe('won'); expect(won.potUsd).toBe(12.5);
    expect(h.snapshot.awards.map((a) => [a.author, a.potUsd])).toEqual([['p1', 5], ['p3', 12.5]]);
    // a pricing failure never breaks a reply: the pot reads 0
    const broken = new Hill({ judge: new MockJudge('power'), chain, uri: new MemoryUriProvider(), entry: new CountingEntry(), store: new MemoryStore(), potUsd: async () => { throw new Error('rpc down'); } });
    expect(await broken.potUsd()).toBe(0);
  });

  it('reuses the master shillbot pitch within its ttl and rewrites it after', async () => {
    let t = 1_000_000;
    const { h } = hill({ now: () => t });
    await h.challenge({ mint: C, pitch: 'gamma', author: 'p', surface: 'cli' });
    await h.challenge({ mint: B, pitch: 'beta', author: 'p', surface: 'cli' });
    const first = h.snapshot.masterShill;
    expect(first?.reign).toBe(1);
    t += 3600_000;
    await h.challenge({ mint: B, pitch: 'beta again', author: 'p', surface: 'cli' });
    expect(h.snapshot.masterShill?.at).toBe(first?.at);
    t += 7 * 3600_000;
    await h.challenge({ mint: B, pitch: 'beta thrice', author: 'p', surface: 'cli' });
    expect(h.snapshot.masterShill?.at).toBe(t);
  });

  it('records an error and rethrows when the entry flow fails, without touching the king', async () => {
    const failing: EntryLike = { play: async () => { throw new Error('underfunded'); } };
    const h2 = new Hill({ judge: new MockJudge(), chain: new MemoryChain({ name: 'M', symbol: 'M', uri: 'u' }, profiles), uri: new MemoryUriProvider(), entry: failing, store: new MemoryStore() });
    await expect(h2.challenge({ mint: A, pitch: 'x', author: 'p', surface: 'cli' })).rejects.toThrow('underfunded');
    expect(h2.king).toBeNull();
    expect(h2.snapshot.challenges[0].result).toBe('error');
  });

  it('serializes concurrent challenges', async () => {
    const { h } = hill();
    const [a, b] = await Promise.all([
      h.challenge({ mint: A, pitch: 'a', author: 'p1', surface: 'cli' }),
      h.challenge({ mint: C, pitch: 'c', author: 'p2', surface: 'cli' }),
    ]);
    expect(a.king?.reign).toBe(1);
    expect(b.king?.reign).toBe(2);
    expect(h.snapshot.takeovers).toBe(2);
  });
});
