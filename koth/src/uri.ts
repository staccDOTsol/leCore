/**
 * Hosting for the master token's off-chain JSON. The on-chain `uri` (<= 200 bytes) points here.
 *
 * There is no website by directive, but wallets and explorers still fetch the JSON behind the uri,
 * so it has to live somewhere: a directory served by the bot process (FileUriProvider) or IPFS via
 * Pinata (PinataUriProvider). Each reign gets its own immutable document; `king.json` is a moving
 * alias for whoever holds the hill now.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Card } from './cards.js';

export type KingJson = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  attributes: { trait_type: string; value: string | number }[];
  properties: {
    koth: {
      reign: number; king_mint: string; king_name: string; king_symbol: string; author: string; surface: string;
      pitch: string; tagline: string; crowned_at: string; play_signature: string | null;
      card: { element: string; rarity: string; power: number; stats: Card['stats']; traits: string[]; seed: string };
    };
  };
};

export interface UriProvider {
  host(reign: number, json: KingJson): Promise<string>;
}

export function buildKingJson(args: {
  reign: number; fields: { name: string; symbol: string }; description: string; tagline: string; image: string;
  externalUrl?: string; card: Card; author: string; surface: string; pitch: string; crownedAt: number; playSignature: string | null;
}): KingJson {
  const c = args.card;
  return {
    name: args.fields.name,
    symbol: args.fields.symbol,
    description: args.description,
    image: args.image,
    ...(args.externalUrl ? { external_url: args.externalUrl } : {}),
    attributes: [
      { trait_type: 'reign', value: args.reign },
      { trait_type: 'king', value: `${c.name} ($${c.symbol})` },
      { trait_type: 'element', value: c.element },
      { trait_type: 'rarity', value: c.rarity },
      { trait_type: 'power', value: c.power },
      { trait_type: 'HP', value: c.stats.hp }, { trait_type: 'ATK', value: c.stats.atk }, { trait_type: 'DEF', value: c.stats.def },
      { trait_type: 'SPD', value: c.stats.spd }, { trait_type: 'LUCK', value: c.stats.luck },
      ...c.traits.map((t) => ({ trait_type: 'trait', value: t })),
    ],
    properties: {
      koth: {
        reign: args.reign, king_mint: c.mint, king_name: c.name, king_symbol: c.symbol, author: args.author, surface: args.surface,
        pitch: args.pitch, tagline: args.tagline, crowned_at: new Date(args.crownedAt).toISOString(), play_signature: args.playSignature,
        card: { element: c.element, rarity: c.rarity, power: c.power, stats: c.stats, traits: c.traits, seed: c.seed },
      },
    },
  };
}

/** Writes `<dir>/metadata/<reign>.json` (+ `king.json`) and returns `<publicUrl>/metadata/<reign>.json`. */
export class FileUriProvider implements UriProvider {
  constructor(private dir: string, private publicUrl: string) {}
  async host(reign: number, json: KingJson): Promise<string> {
    const mdDir = path.join(this.dir, 'metadata');
    fs.mkdirSync(mdDir, { recursive: true });
    const body = JSON.stringify(json, null, 2);
    fs.writeFileSync(path.join(mdDir, `${reign}.json`), body);
    fs.writeFileSync(path.join(mdDir, 'king.json'), body);
    return `${this.publicUrl.replace(/\/+$/, '')}/metadata/${reign}.json`;
  }
}

/** Pins the JSON to IPFS through Pinata; returns a gateway https url so every wallet can render it. */
export class PinataUriProvider implements UriProvider {
  constructor(private jwt: string, private gateway = 'https://gateway.pinata.cloud/ipfs', private fetchImpl: typeof fetch = fetch) {}
  async host(reign: number, json: KingJson): Promise<string> {
    const res = await this.fetchImpl('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinataMetadata: { name: `koth-reign-${reign}` }, pinataContent: json }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`pinata ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { IpfsHash: string };
    return `${this.gateway}/${j.IpfsHash}`;
  }
}

/** Keeps documents in memory; for tests and dry runs. */
export class MemoryUriProvider implements UriProvider {
  readonly docs = new Map<number, KingJson>();
  async host(reign: number, json: KingJson): Promise<string> {
    this.docs.set(reign, json);
    return `memory://koth/${reign}.json`;
  }
}
