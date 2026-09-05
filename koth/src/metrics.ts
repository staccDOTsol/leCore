/**
 * Token metrics: the raw material every game asset is built from.
 *
 * The directive is that a shilled token's METRICS, not its vibes, decide its card. So this module
 * pulls one snapshot per challenge: price, cap, liquidity, 24h volume, buys/sells, price changes,
 * holders and pair age. Birdeye is used when a key is present (it has holder counts); DexScreener
 * is the keyless fallback; the RPC adds supply and top-10 concentration. Every number is optional
 * downstream -- a token DexScreener has never seen still gets a (weak) card.
 */
import { Connection, PublicKey } from '@solana/web3.js';

export type TokenMetrics = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  buys24h: number;
  sells24h: number;
  priceChangePct: { h1: number; h6: number; h24: number };
  holders: number | null;
  /** Share of supply in the ten largest accounts, 0..1, when the RPC could tell us. */
  top10Share: number | null;
  ageDays: number | null;
  supply: number | null;
  imageUrl: string | null;
  links: { type: string; url: string }[];
  pairAddress: string | null;
  dexId: string | null;
  source: 'birdeye' | 'dexscreener' | 'none';
  fetchedAt: number;
};

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : d;
};
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

export function emptyMetrics(mint: string): TokenMetrics {
  return {
    mint, name: '', symbol: '', decimals: 0, priceUsd: 0, marketCapUsd: 0, fdvUsd: 0, liquidityUsd: 0,
    volume24hUsd: 0, buys24h: 0, sells24h: 0, priceChangePct: { h1: 0, h6: 0, h24: 0 }, holders: null,
    top10Share: null, ageDays: null, supply: null, imageUrl: null, links: [], pairAddress: null,
    dexId: null, source: 'none', fetchedAt: Date.now(),
  };
}

type Fetch = typeof fetch;

/** DexScreener: keyless. Picks the deepest pair on Solana. */
export async function fetchDexScreener(mint: string, f: Fetch = fetch): Promise<TokenMetrics | null> {
  const res = await f(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const j = (await res.json()) as { pairs?: Record<string, unknown>[] };
  const pairs = (j.pairs ?? []).filter((p) => p.chainId === 'solana');
  if (!pairs.length) return null;
  const liq = (p: Record<string, unknown>) => num((p.liquidity as Record<string, unknown> | undefined)?.usd);
  const p = pairs.sort((a, b) => liq(b) - liq(a))[0];
  const base = (p.baseToken ?? {}) as Record<string, unknown>;
  const txns = ((p.txns ?? {}) as Record<string, Record<string, unknown>>).h24 ?? {};
  const vol = (p.volume ?? {}) as Record<string, unknown>;
  const chg = (p.priceChange ?? {}) as Record<string, unknown>;
  const info = (p.info ?? {}) as Record<string, unknown>;
  const links: { type: string; url: string }[] = [];
  for (const w of (info.websites as { url: string }[] | undefined) ?? []) links.push({ type: 'website', url: w.url });
  for (const s of (info.socials as { type: string; url: string }[] | undefined) ?? []) links.push({ type: s.type, url: s.url });
  const created = num(p.pairCreatedAt, 0);
  return {
    ...emptyMetrics(mint),
    name: String(base.name ?? ''), symbol: String(base.symbol ?? ''),
    priceUsd: num(p.priceUsd), marketCapUsd: num(p.marketCap), fdvUsd: num(p.fdv), liquidityUsd: liq(p),
    volume24hUsd: num(vol.h24), buys24h: num(txns.buys), sells24h: num(txns.sells),
    priceChangePct: { h1: num(chg.h1), h6: num(chg.h6), h24: num(chg.h24) },
    ageDays: created ? (Date.now() - created) / 86_400_000 : null,
    imageUrl: (info.imageUrl as string | undefined) ?? null, links,
    pairAddress: (p.pairAddress as string | undefined) ?? null, dexId: (p.dexId as string | undefined) ?? null,
    source: 'dexscreener',
  };
}

/** Birdeye token_overview: needs a key, brings holder counts. Field names vary by API version, so read defensively. */
export async function fetchBirdeye(mint: string, apiKey: string, f: Fetch = fetch): Promise<TokenMetrics | null> {
  const res = await f(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
    headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { success?: boolean; data?: Record<string, unknown> };
  const d = j.data;
  if (!j.success || !d || !pick(d, 'price')) return null;
  const ext = (d.extensions ?? {}) as Record<string, unknown>;
  const links: { type: string; url: string }[] = [];
  for (const k of ['website', 'twitter', 'telegram', 'discord']) {
    if (typeof ext[k] === 'string' && ext[k]) links.push({ type: k, url: String(ext[k]) });
  }
  return {
    ...emptyMetrics(mint),
    name: String(d.name ?? ''), symbol: String(d.symbol ?? ''), decimals: num(d.decimals),
    priceUsd: num(d.price),
    marketCapUsd: num(pick(d, 'mc', 'marketCap', 'market_cap')),
    fdvUsd: num(pick(d, 'fdv', 'realMc')),
    liquidityUsd: num(d.liquidity),
    volume24hUsd: num(pick(d, 'v24hUSD', 'v24hUsd', 'volume_24h_usd')),
    buys24h: num(pick(d, 'buy24h', 'buy_24h')), sells24h: num(pick(d, 'sell24h', 'sell_24h')),
    priceChangePct: {
      h1: num(pick(d, 'priceChange1hPercent', 'price_change_1h_percent')),
      h6: num(pick(d, 'priceChange6hPercent', 'price_change_6h_percent')),
      h24: num(pick(d, 'priceChange24hPercent', 'price_change_24h_percent')),
    },
    holders: pick(d, 'holder', 'holders') !== undefined ? num(pick(d, 'holder', 'holders')) : null,
    supply: pick(d, 'supply', 'circulatingSupply') !== undefined ? num(pick(d, 'supply', 'circulatingSupply')) : null,
    imageUrl: (d.logoURI as string | undefined) ?? null, links,
    source: 'birdeye',
  };
}

/** RPC facts: decimals, supply, and how much of it the ten largest accounts hold. */
export async function fetchOnchainFacts(connection: Connection, mint: PublicKey): Promise<{ decimals: number; supply: number; top10Share: number | null }> {
  const supply = await connection.getTokenSupply(mint);
  const total = Number(supply.value.uiAmount ?? 0);
  let top10Share: number | null = null;
  try {
    const largest = await connection.getTokenLargestAccounts(mint);
    const top = largest.value.slice(0, 10).reduce((s, a) => s + Number(a.uiAmount ?? 0), 0);
    top10Share = total > 0 ? Math.min(1, top / total) : null;
  } catch {
    top10Share = null;
  }
  return { decimals: supply.value.decimals, supply: total, top10Share };
}

export type MetricsOptions = { birdeyeApiKey?: string; connection?: Connection; fetchImpl?: Fetch };

/** One snapshot of a token, best source first. Never throws: a token nobody indexes gets an empty card. */
export async function fetchTokenMetrics(mint: string, opts: MetricsOptions = {}): Promise<TokenMetrics> {
  const f = opts.fetchImpl ?? fetch;
  let m: TokenMetrics | null = null;
  if (opts.birdeyeApiKey) m = await fetchBirdeye(mint, opts.birdeyeApiKey, f).catch(() => null);
  if (!m) m = await fetchDexScreener(mint, f).catch(() => null);
  if (!m) {
    // Birdeye may have price but not the pair age; DexScreener may know the pair. Merge when both exist.
    m = emptyMetrics(mint);
  } else if (m.source === 'birdeye' && m.ageDays === null) {
    const ds = await fetchDexScreener(mint, f).catch(() => null);
    if (ds) {
      m.ageDays = ds.ageDays; m.pairAddress = ds.pairAddress; m.dexId = ds.dexId;
      if (!m.liquidityUsd) m.liquidityUsd = ds.liquidityUsd;
      if (!m.links.length) m.links = ds.links;
    }
  }
  if (opts.connection) {
    try {
      const facts = await fetchOnchainFacts(opts.connection, new PublicKey(mint));
      m.decimals = facts.decimals; m.supply = m.supply ?? facts.supply; m.top10Share = facts.top10Share;
    } catch { /* keep what we have */ }
  }
  m.fetchedAt = Date.now();
  return m;
}
