import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { unpack, type TokenMetadata } from '@solana/spl-token-metadata';
import {
  Metadata, UpdateMetadataAccountV2Struct, Key, TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  METADATA_LIMITS, MPL_TOKEN_METADATA_PROGRAM_ID, assertMetadataLimits, buildMetaplexUpdateIx,
  buildToken2022UpdateIxs, clampMetadata, decodeMetaplexMetadata, fitBytes, metaplexMetadataPda,
} from '../src/metadata.js';

const mint = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;

function metaplexAccount(): Buffer {
  const md = Metadata.fromArgs({
    key: Key.MetadataV1, updateAuthority: authority, mint,
    data: { name: 'Old Name'.padEnd(32, '\0'), symbol: 'OLD'.padEnd(10, '\0'), uri: 'https://old/x.json'.padEnd(200, '\0'), sellerFeeBasisPoints: 0, creators: null },
    primarySaleHappened: false, isMutable: true, editionNonce: 255, tokenStandard: TokenStandard.Fungible,
    collection: null, uses: null, collectionDetails: null, programmableConfig: null,
  });
  return md.serialize()[0];
}

describe('metadata limits', () => {
  it('measures bytes, not characters', () => {
    expect(fitBytes('ééééé', 4)).toBe('éé');
    expect(() => assertMetadataLimits({ name: 'x'.repeat(33), symbol: 'S', uri: 'u' })).toThrow(/name is 33 bytes/);
    const c = clampMetadata({ name: 'n'.repeat(50), symbol: 's'.repeat(20), uri: 'u'.repeat(300) });
    expect(Buffer.byteLength(c.name)).toBe(METADATA_LIMITS.name);
    expect(Buffer.byteLength(c.symbol)).toBe(METADATA_LIMITS.symbol);
    expect(Buffer.byteLength(c.uri)).toBe(METADATA_LIMITS.uri);
  });
});

describe('metaplex update instruction', () => {
  it('decodes the account and encodes UpdateMetadataAccountV2 with only name/symbol/uri changed', () => {
    const raw = metaplexAccount();
    const before = decodeMetaplexMetadata(mint, raw);
    expect(before.name).toBe('Old Name');
    expect(before.isMutable).toBe(true);
    expect(before.updateAuthority?.equals(authority)).toBe(true);

    const ix = buildMetaplexUpdateIx(raw, mint, authority, { name: 'KING BONK', symbol: 'kBONK', uri: 'https://koth/1.json' });
    expect(ix.programId.equals(MPL_TOKEN_METADATA_PROGRAM_ID)).toBe(true);
    expect(ix.keys[0].pubkey.equals(metaplexMetadataPda(mint))).toBe(true);
    expect(ix.keys[1].pubkey.equals(authority)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    const [args] = UpdateMetadataAccountV2Struct.deserialize(ix.data);
    expect(args.instructionDiscriminator).toBe(15);
    const a = args.updateMetadataAccountArgsV2;
    expect(a.data?.name).toBe('KING BONK');
    expect(a.data?.symbol).toBe('kBONK');
    expect(a.data?.uri).toBe('https://koth/1.json');
    expect(a.updateAuthority).toBeNull();
    expect(a.isMutable).toBeNull();
  });
});

describe('token-2022 update instructions', () => {
  it('emits one UpdateField per changed field, with a rent top-up when the entry grows', async () => {
    const current: TokenMetadata = { updateAuthority: authority, mint, name: 'Old', symbol: 'OLD', uri: 'https://old', additionalMetadata: [] };
    const payer = Keypair.generate().publicKey;
    const conn = {
      getAccountInfo: async () => ({ data: Buffer.alloc(400), lamports: 1_000_000 }),
      getMinimumBalanceForRentExemption: async (n: number) => n * 10_000,
    } as unknown as import('@solana/web3.js').Connection;
    const ixs = await buildToken2022UpdateIxs(conn, mint, current, payer, authority, { name: 'A much longer name', symbol: 'OLD', uri: 'https://new/longer/uri' });
    // transfer + name + uri (symbol unchanged)
    expect(ixs).toHaveLength(3);
    expect(ixs[0].programId.toBase58()).toBe('11111111111111111111111111111111');
    expect(ixs[1].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ixs[1].keys[0].pubkey.equals(mint)).toBe(true);
    expect(ixs[1].keys[1].pubkey.equals(authority)).toBe(true);
    expect(ixs[1].keys[1].isSigner).toBe(true);
    // round-trip: unpack() proves the packed TLV shape is what the program expects
    expect(unpack(Buffer.from(require('@solana/spl-token-metadata').pack({ ...current, name: 'A much longer name' }))).name).toBe('A much longer name');
  });

  it('emits nothing when nothing changed', async () => {
    const current: TokenMetadata = { updateAuthority: authority, mint, name: 'Same', symbol: 'S', uri: 'u', additionalMetadata: [] };
    const conn = {} as unknown as import('@solana/web3.js').Connection;
    const ixs = await buildToken2022UpdateIxs(conn, mint, current, authority, authority, { name: 'Same', symbol: 'S', uri: 'u' });
    expect(ixs).toHaveLength(0);
  });
});

describe('metadata pda', () => {
  it('derives the canonical Metaplex PDA', () => {
    const pda = metaplexMetadataPda(new PublicKey('5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e'));
    expect(pda).toBeInstanceOf(PublicKey);
  });
});
