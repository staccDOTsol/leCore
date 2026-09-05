/**
 * The master token's on-chain side, as the hill sees it: read its metadata, rewrite it, and profile
 * any challenger token (metrics + its own metadata + off-chain JSON). Everything the game needs from
 * Solana goes through this one interface so tests can swap in a fake.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { fetchOffchainJson, readTokenMetadata, updateTokenMetadata, type MetadataFields, type OnchainMetadata } from './metadata.js';
import { fetchTokenMetrics, type TokenMetrics } from './metrics.js';

export type TokenProfile = { metrics: TokenMetrics; onchain: OnchainMetadata | null; offchain: Record<string, unknown> | null };

export interface ChainLike {
  readMasterMetadata(): Promise<MetadataFields>;
  updateMasterMetadata(fields: MetadataFields): Promise<{ signature: string }>;
  profile(mint: string): Promise<TokenProfile>;
}

export class MasterChain implements ChainLike {
  constructor(
    readonly connection: Connection,
    readonly authority: Keypair,
    readonly masterMint: PublicKey,
    private opts: { birdeyeApiKey?: string } = {},
  ) {}

  async readMasterMetadata(): Promise<MetadataFields> {
    const md = await readTokenMetadata(this.connection, this.masterMint);
    return { name: md.name, symbol: md.symbol, uri: md.uri };
  }

  async updateMasterMetadata(fields: MetadataFields): Promise<{ signature: string }> {
    const r = await updateTokenMetadata(this.connection, this.authority, this.masterMint, fields);
    return { signature: r.signature };
  }

  async profile(mint: string): Promise<TokenProfile> {
    const pk = new PublicKey(mint);
    const metrics = await fetchTokenMetrics(mint, { birdeyeApiKey: this.opts.birdeyeApiKey, connection: this.connection });
    let onchain: OnchainMetadata | null = null;
    try { onchain = await readTokenMetadata(this.connection, pk); } catch { onchain = null; }
    if (onchain) {
      if (!metrics.name) metrics.name = onchain.name;
      if (!metrics.symbol) metrics.symbol = onchain.symbol;
    }
    const offchain = onchain?.uri ? await fetchOffchainJson(onchain.uri) : null;
    if (!metrics.imageUrl && offchain && typeof offchain.image === 'string') metrics.imageUrl = offchain.image;
    return { metrics, onchain, offchain };
  }
}

/** In-memory chain for tests and dry runs: metadata updates are recorded, never sent. */
export class MemoryChain implements ChainLike {
  master: MetadataFields;
  readonly updates: MetadataFields[] = [];
  constructor(master: MetadataFields, private profiles: Record<string, Partial<TokenMetrics>> = {}) { this.master = master; }
  async readMasterMetadata(): Promise<MetadataFields> { return { ...this.master }; }
  async updateMasterMetadata(fields: MetadataFields): Promise<{ signature: string }> {
    this.master = { ...fields }; this.updates.push({ ...fields });
    return { signature: `memory-sig-${this.updates.length}` };
  }
  async profile(mint: string): Promise<TokenProfile> {
    const { emptyMetrics } = await import('./metrics.js');
    return { metrics: { ...emptyMetrics(mint), ...(this.profiles[mint] ?? {}) }, onchain: null, offchain: null };
  }
}
