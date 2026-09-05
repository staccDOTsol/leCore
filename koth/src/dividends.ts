/**
 * DIVIDENDS: every play pays the people who came before.
 *
 * Each attempt's stake becomes LP in the <coin>/MASTER pool. Of that LP:
 *   20%  every past king, split by how many times they have won (two reigns, two shares) -- kings with a wallet
 *   10%  every past player, split by how many times they have played (same idea)
 *   35%  the winner, when the attempt wins, as plain LP tokens they can remove; into the vault when it loses
 *   35%  pushes: into the vault, the pot the next king takes half of
 *
 * Shares accrue per person per LP mint (a share is of one pool). Nothing is minted until a person
 * has a wallet and a pool position worth at least MIN_PAYOUT_USD (both sides of the LP); then that
 * LP is locked for good with Raydium's lock program and the lock NFT, which claims the position's
 * trading fees, is sent to them. A share with nobody to receive it pushes into the vault instead.
 *
 * The ledger lives on the always-on volume (dividends.json beside the rest of the state).
 */
import fs from 'node:fs';
import path from 'node:path';

export const KINGS_BPS = 2000;
export const PLAYERS_BPS = 1000;
export const WINNER_BPS = 3500;
export const PUSH_BPS = 3500;
export const MIN_PAYOUT_USD = 1;

export type Accrual = { pool: string; raw: string };
export type Payout = { lpMint: string; pool: string; raw: string; usd: number; nftMint: string | null; signature: string; at: number; reason: 'dividend' | 'win' };
export type Person = {
  author: string;
  surface: string;
  wallet: string | null;
  plays: number;
  wins: number;
  /** Unpaid dividend LP per LP mint: paid as a lock NFT once it is worth MIN_PAYOUT_USD. */
  accrued: Record<string, Accrual>;
  /** A winner's 35% won before they named a wallet: sent as plain LP the moment they do. */
  owedLp: Record<string, Accrual>;
  /** A payout whose lock transaction was sent but not recorded: never paid twice, looked at by a human. */
  paying: { lpMint: string; raw: string; at: number } | null;
  paid: Payout[];
  paidUsd: number;
};
export type Ledger = { people: Record<string, Person>; updatedAt: number };

export type Allocation = { id: string; raw: bigint; reason: 'king' | 'player' };
export type Payable = { id: string; wallet: string; lpMint: string; pool: string; raw: bigint; usd: number };

export const bps = (raw: bigint, b: number): bigint => (raw * BigInt(b)) / 10_000n;

/** `total` split by weight, floored: the dust is the caller's (it pushes into the vault). */
export function splitByWeight(total: bigint, weights: { id: string; weight: number }[]): { id: string; raw: bigint }[] {
  const sum = weights.reduce((a, w) => a + Math.max(0, w.weight), 0);
  if (total <= 0n || sum <= 0) return [];
  return weights.filter((w) => w.weight > 0).map((w) => ({ id: w.id, raw: (total * BigInt(w.weight)) / BigInt(sum) })).filter((s) => s.raw > 0n);
}

export class Dividends {
  private ledger: Ledger;
  constructor(private file: string, private log: (s: string) => void = () => {}) {
    try { this.ledger = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger; } catch { this.ledger = { people: {}, updatedAt: 0 }; }
    this.ledger.people ??= {};
  }
  private save(): void {
    this.ledger.updatedAt = Date.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.ledger, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get people(): Record<string, Person> { return this.ledger.people; }
  person(id: string): Person | null { return this.ledger.people[id] ?? null; }
  private ensure(id: string, author = id, surface = ''): Person {
    const p = (this.ledger.people[id] ??= { author, surface, wallet: null, plays: 0, wins: 0, accrued: {}, owedLp: {}, paying: null, paid: [], paidUsd: 0 });
    p.owedLp ??= {};
    return p;
  }

  setWallet(id: string, author: string, surface: string, wallet: string): void {
    const p = this.ensure(id, author, surface);
    p.wallet = wallet; p.author = author; p.surface = surface;
    this.save();
  }
  recordPlay(id: string, author: string, surface: string): void { const p = this.ensure(id, author, surface); p.plays += 1; p.author = author; this.save(); }
  recordWin(id: string, author: string, surface: string): void { const p = this.ensure(id, author, surface); p.wins += 1; p.author = author; this.save(); }

  accrue(id: string, author: string, surface: string, lpMint: string, pool: string, raw: bigint): void {
    if (raw <= 0n) return;
    const p = this.ensure(id, author, surface);
    const cur = p.accrued[lpMint] ?? { pool, raw: '0' };
    p.accrued[lpMint] = { pool, raw: (BigInt(cur.raw) + raw).toString() };
    this.save();
  }

  /**
   * The kings' and players' shares of one play's LP, by the counts before this play. Returns every
   * allocation made and how much of the two shares found nobody (it pushes into the vault).
   */
  distribute(a: { lpMint: string; pool: string; kingsRaw: bigint; playersRaw: bigint }): { allocations: Allocation[]; unallocated: bigint } {
    const people = Object.entries(this.ledger.people);
    const kings = splitByWeight(a.kingsRaw, people.filter(([, p]) => p.wins > 0 && p.wallet).map(([id, p]) => ({ id, weight: p.wins })));
    const players = splitByWeight(a.playersRaw, people.filter(([, p]) => p.plays > 0).map(([id, p]) => ({ id, weight: p.plays })));
    const allocations: Allocation[] = [...kings.map((s) => ({ ...s, reason: 'king' as const })), ...players.map((s) => ({ ...s, reason: 'player' as const }))];
    let allocated = 0n;
    for (const s of allocations) {
      const p = this.ledger.people[s.id];
      const cur = p.accrued[a.lpMint] ?? { pool: a.pool, raw: '0' };
      p.accrued[a.lpMint] = { pool: a.pool, raw: (BigInt(cur.raw) + s.raw).toString() };
      allocated += s.raw;
    }
    if (allocations.length) this.save();
    return { allocations, unallocated: a.kingsRaw + a.playersRaw - allocated };
  }

  /** Positions worth paying now: a wallet, nothing mid-payment, and at least MIN_PAYOUT_USD in the pool. */
  async payable(usdPerRaw: (lpMint: string) => Promise<number>, onlyId?: string): Promise<Payable[]> {
    const out: Payable[] = [];
    for (const [id, p] of Object.entries(this.ledger.people)) {
      if (onlyId && id !== onlyId) continue;
      if (!p.wallet || p.paying) continue;
      for (const [lpMint, acc] of Object.entries(p.accrued)) {
        const raw = BigInt(acc.raw);
        if (raw <= 0n) continue;
        let usd = 0;
        try { usd = Number(raw) * (await usdPerRaw(lpMint)); } catch (e) { this.log(`dividends: cannot price ${lpMint}: ${e instanceof Error ? e.message : e}`); continue; }
        if (usd >= MIN_PAYOUT_USD) out.push({ id, wallet: p.wallet, lpMint, pool: acc.pool, raw, usd: Math.round(usd * 100) / 100 });
      }
    }
    return out;
  }

  /** What a person has coming, priced; for the `dividends` reply. */
  async accruedUsd(id: string, usdPerRaw: (lpMint: string) => Promise<number>): Promise<{ lpMint: string; pool: string; raw: bigint; usd: number | null }[]> {
    const p = this.ledger.people[id];
    if (!p) return [];
    const out: { lpMint: string; pool: string; raw: bigint; usd: number | null }[] = [];
    for (const [lpMint, acc] of Object.entries(p.accrued)) {
      const raw = BigInt(acc.raw);
      if (raw <= 0n) continue;
      let usd: number | null = null;
      try { usd = Math.round(Number(raw) * (await usdPerRaw(lpMint)) * 100) / 100; } catch { /* unpriced */ }
      out.push({ lpMint, pool: acc.pool, raw, usd });
    }
    return out;
  }

  /** A win with no wallet yet: the LP waits, unlocked, for `wallet <address>`. */
  oweLp(id: string, author: string, surface: string, lpMint: string, pool: string, raw: bigint): void {
    if (raw <= 0n) return;
    const p = this.ensure(id, author, surface);
    const cur = p.owedLp[lpMint] ?? { pool, raw: '0' };
    p.owedLp[lpMint] = { pool, raw: (BigInt(cur.raw) + raw).toString() };
    this.save();
  }
  /** Take an owed LP position off the books to send it (put back with `oweLp` if the send fails). */
  takeOwedLp(id: string): { lpMint: string; pool: string; raw: bigint }[] {
    const p = this.ledger.people[id];
    if (!p) return [];
    p.owedLp ??= {};
    const out = Object.entries(p.owedLp).map(([lpMint, a]) => ({ lpMint, pool: a.pool, raw: BigInt(a.raw) })).filter((x) => x.raw > 0n);
    p.owedLp = {};
    if (out.length) this.save();
    return out;
  }

  /** The payout is being sent: the accrual is taken off the books first so a crash can never pay twice. */
  beginPay(id: string, lpMint: string): bigint {
    const p = this.ledger.people[id];
    const raw = BigInt(p?.accrued[lpMint]?.raw ?? '0');
    if (!p || raw <= 0n) return 0n;
    delete p.accrued[lpMint];
    p.paying = { lpMint, raw: raw.toString(), at: Date.now() };
    this.save();
    return raw;
  }
  finishPay(id: string, payout: Payout): void {
    const p = this.ledger.people[id];
    if (!p) return;
    p.paying = null;
    p.paid.push(payout);
    p.paidUsd = Math.round((p.paidUsd + payout.usd) * 100) / 100;
    this.save();
  }
  /** The lock transaction never went out: put the accrual back. */
  failPay(id: string): void {
    const p = this.ledger.people[id];
    if (!p?.paying) return;
    const { lpMint, raw } = p.paying;
    const cur = p.accrued[lpMint];
    p.accrued[lpMint] = { pool: cur?.pool ?? p.paid.find((x) => x.lpMint === lpMint)?.pool ?? '', raw: (BigInt(cur?.raw ?? '0') + BigInt(raw)).toString() };
    p.paying = null;
    this.save();
  }
  /** A direct payout (the winner's 35%): recorded without an accrual. */
  recordPaid(id: string, author: string, surface: string, payout: Payout): void {
    const p = this.ensure(id, author, surface);
    p.paid.push(payout);
    p.paidUsd = Math.round((p.paidUsd + payout.usd) * 100) / 100;
    this.save();
  }
}
