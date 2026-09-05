import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dividends, KINGS_BPS, MIN_PAYOUT_USD, PLAYERS_BPS, PUSH_BPS, WINNER_BPS, bps, splitByWeight } from '../src/dividends.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'divs-')), 'dividends.json');

describe('the split', () => {
  it('adds up to 100% of a play: 20 kings, 10 players, 35 winner, 35 push', () => {
    expect(KINGS_BPS + PLAYERS_BPS + WINNER_BPS + PUSH_BPS).toBe(10_000);
    expect(bps(1_000_000n, KINGS_BPS)).toBe(200_000n);
  });
  it('splits by weight, floored, so two reigns take twice what one does and the dust is left over', () => {
    const s = splitByWeight(1000n, [{ id: 'a', weight: 2 }, { id: 'b', weight: 1 }, { id: 'c', weight: 0 }]);
    expect(s).toEqual([{ id: 'a', raw: 666n }, { id: 'b', raw: 333n }]);
    expect(splitByWeight(1000n, [])).toEqual([]);
  });
});

describe('the ledger', () => {
  it('pays past kings with a wallet and every past player, by their counts, and pushes the rest', () => {
    const d = new Dividends(file());
    d.recordPlay('p1', '@one', 'telegram'); d.recordWin('p1', '@one', 'telegram'); d.setWallet('p1', '@one', 'telegram', 'W1');
    d.recordPlay('p2', '@two', 'x'); d.recordWin('p2', '@two', 'x');              // a king with no wallet: not in the kings' 20%, still in the players' 10%
    d.recordPlay('p3', '@three', 'x'); d.recordPlay('p3', '@three', 'x');           // two plays, two shares
    const r = d.distribute({ lpMint: 'LP', pool: 'POOL', kingsRaw: 2000n, playersRaw: 1000n });
    expect(r.allocations.filter((a) => a.reason === 'king')).toEqual([{ id: 'p1', raw: 2000n, reason: 'king' }]);
    expect(r.allocations.filter((a) => a.reason === 'player').map((a) => [a.id, a.raw])).toEqual([['p1', 250n], ['p2', 250n], ['p3', 500n]]);
    expect(r.unallocated).toBe(0n);
    expect(d.person('p1')?.accrued.LP).toEqual({ pool: 'POOL', raw: '2250' });
    // nobody has played yet: everything pushes
    const empty = new Dividends(file());
    expect(empty.distribute({ lpMint: 'LP', pool: 'POOL', kingsRaw: 2000n, playersRaw: 1000n })).toEqual({ allocations: [], unallocated: 3000n });
  });

  it('pays only positions worth $1 that have a wallet, takes them off the books first, and puts them back on a failed send', async () => {
    const f = file();
    const d = new Dividends(f);
    d.recordPlay('a', '@a', 'x'); d.setWallet('a', '@a', 'x', 'WA');
    d.recordPlay('b', '@b', 'x');
    d.accrue('a', '@a', 'x', 'LP', 'POOL', 500n);
    d.accrue('b', '@b', 'x', 'LP', 'POOL', 5000n);
    const price = async () => 0.001;                                             // $0.50 for a, $5 for b
    expect(await d.payable(price)).toEqual([]);                                  // a is under the minimum, b has no wallet
    d.accrue('a', '@a', 'x', 'LP', 'POOL', 600n);
    expect(await d.payable(price)).toEqual([{ id: 'a', wallet: 'WA', lpMint: 'LP', pool: 'POOL', raw: 1100n, usd: 1.1 }]);
    expect(MIN_PAYOUT_USD).toBe(1);
    expect(d.beginPay('a', 'LP')).toBe(1100n);
    expect(await d.payable(price)).toEqual([]);                                  // mid-payment: never offered twice
    d.failPay('a');
    expect(d.person('a')?.accrued.LP.raw).toBe('1100');
    d.beginPay('a', 'LP');
    d.finishPay('a', { lpMint: 'LP', pool: 'POOL', raw: '1100', usd: 1.1, nftMint: 'NFT', signature: 'sig', at: 1, reason: 'dividend' });
    expect(d.person('a')?.paidUsd).toBe(1.1);
    expect(d.person('a')?.accrued.LP).toBeUndefined();
    // it is all on disk
    const again = new Dividends(f);
    expect(again.person('a')?.paid[0].nftMint).toBe('NFT');
    expect(again.person('b')?.accrued.LP.raw).toBe('5000');
  });

  it('holds a winner\'s plain LP until they name a wallet', () => {
    const d = new Dividends(file());
    d.oweLp('w', '@w', 'telegram', 'LP', 'POOL', 350n);
    expect(d.takeOwedLp('w')).toEqual([{ lpMint: 'LP', pool: 'POOL', raw: 350n }]);
    expect(d.takeOwedLp('w')).toEqual([]);
  });
});
