/**
 * On-chain token metadata: READ it and REWRITE it (name / symbol / uri).
 *
 * The master shill token is launched through Meteora's Dynamic Bonding Curve with
 * `tokenAuthorityOption = CreatorUpdateAuthority`. The DBC program creates the metadata as MUTABLE
 * and, in the same instruction, hands the update authority to the pool creator wallet
 * (`TokenAuthorityOption::get_update_authority` in the program's state/config.rs). That is the whole
 * reason this launchpad was chosen: after launch the creator can sign an ordinary
 *   - Metaplex `UpdateMetadataAccountV2`            (SPL Token mints), or
 *   - Token-2022 `TokenMetadata::UpdateField` x3   (Token-2022 mints)
 * and the token's name, symbol and uri change on chain. No program of ours is involved.
 *
 * Both standards are supported here because DBC can mint either; SPL Token + Metaplex is the default
 * since every wallet and indexer reads it.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTokenMetadata } from '@solana/spl-token';
import { createUpdateFieldInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import {
  Metadata, PROGRAM_ID as MPL_TOKEN_METADATA_PROGRAM_ID, createUpdateMetadataAccountV2Instruction,
} from '@metaplex-foundation/mpl-token-metadata';

export { MPL_TOKEN_METADATA_PROGRAM_ID };

/** Metaplex's hard limits, in BYTES (not characters). Token-2022 has no fixed limit but we keep the same. */
export const METADATA_LIMITS = { name: 32, symbol: 10, uri: 200 } as const;

export type MetadataFields = { name: string; symbol: string; uri: string };

export type OnchainMetadata = MetadataFields & {
  mint: PublicKey;
  standard: 'metaplex' | 'token2022';
  tokenProgram: PublicKey;
  /** Where the metadata lives: the Metaplex PDA, or the Token-2022 mint itself. */
  metadataAddress: PublicKey;
  updateAuthority: PublicKey | null;
  isMutable: boolean;
};

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Cut a string down to a UTF-8 byte budget without splitting a code point. */
export function fitBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (utf8Bytes(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/** Enforce Metaplex's byte limits. Throws with the offending field named. */
export function assertMetadataLimits(f: MetadataFields): MetadataFields {
  for (const k of ['name', 'symbol', 'uri'] as const) {
    const n = utf8Bytes(f[k]);
    if (n > METADATA_LIMITS[k]) {
      throw new Error(`${k} is ${n} bytes; the on-chain limit is ${METADATA_LIMITS[k]}`);
    }
  }
  return f;
}

/** Clamp every field to its byte limit (the inference remix may overshoot). */
export function clampMetadata(f: MetadataFields): MetadataFields {
  return {
    name: fitBytes(f.name.trim(), METADATA_LIMITS.name),
    symbol: fitBytes(f.symbol.trim(), METADATA_LIMITS.symbol),
    uri: fitBytes(f.uri.trim(), METADATA_LIMITS.uri),
  };
}

export function metaplexMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

/** Metaplex pads strings with NULs to their fixed width. */
export function stripNul(s: string): string {
  return s.replace(/\0+$/g, '');
}

export async function tokenProgramOf(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} does not exist`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`${mint.toBase58()} is not a token mint (owner ${info.owner.toBase58()})`);
}

/** Decode a raw Metaplex metadata account. Exposed for tests. */
export function decodeMetaplexMetadata(mint: PublicKey, data: Buffer): OnchainMetadata {
  const [md] = Metadata.deserialize(data);
  return {
    mint,
    standard: 'metaplex',
    tokenProgram: TOKEN_PROGRAM_ID,
    metadataAddress: metaplexMetadataPda(mint),
    name: stripNul(md.data.name),
    symbol: stripNul(md.data.symbol),
    uri: stripNul(md.data.uri),
    updateAuthority: md.updateAuthority,
    isMutable: md.isMutable,
  };
}

/**
 * Read a mint's metadata whichever standard it uses. A Token-2022 mint is checked for the
 * TokenMetadata extension first and falls back to a Metaplex PDA (DBC uses the extension).
 */
export async function readTokenMetadata(connection: Connection, mint: PublicKey): Promise<OnchainMetadata> {
  const tokenProgram = await tokenProgramOf(connection, mint);
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const md = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    if (md) {
      return {
        mint, standard: 'token2022', tokenProgram, metadataAddress: mint,
        name: md.name, symbol: md.symbol, uri: md.uri,
        updateAuthority: md.updateAuthority ?? null,
        isMutable: Boolean(md.updateAuthority),
      };
    }
  }
  const pda = metaplexMetadataPda(mint);
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error(`no metadata for mint ${mint.toBase58()}`);
  const out = decodeMetaplexMetadata(mint, info.data);
  out.tokenProgram = tokenProgram;
  return out;
}

/** Fetch the off-chain JSON a `uri` points at (image, description, socials). Never throws. */
export async function fetchOffchainJson(uri: string, timeoutMs = 10_000): Promise<Record<string, unknown> | null> {
  if (!/^https?:\/\//i.test(uri) && !/^ipfs:\/\//i.test(uri)) return null;
  const url = uri.replace(/^ipfs:\/\//i, 'https://ipfs.io/ipfs/');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as unknown;
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The Metaplex instruction: one `UpdateMetadataAccountV2` that keeps everything but name/symbol/uri. */
export function buildMetaplexUpdateIx(current: Buffer, mint: PublicKey, updateAuthority: PublicKey, fields: MetadataFields): TransactionInstruction {
  const [md] = Metadata.deserialize(current);
  const f = assertMetadataLimits(fields);
  return createUpdateMetadataAccountV2Instruction(
    { metadata: metaplexMetadataPda(mint), updateAuthority },
    {
      updateMetadataAccountArgsV2: {
        data: {
          name: f.name, symbol: f.symbol, uri: f.uri,
          sellerFeeBasisPoints: md.data.sellerFeeBasisPoints,
          creators: md.data.creators, collection: md.collection, uses: md.uses,
        },
        updateAuthority: null, primarySaleHappened: null, isMutable: null,
      },
    },
  );
}

/**
 * The Token-2022 instructions: top up rent for the (possibly larger) TLV entry, then one UpdateField
 * per changed field. The token program reallocs the mint itself but refuses if it would leave the
 * account under rent exemption, so the transfer comes first.
 */
export async function buildToken2022UpdateIxs(
  connection: Connection, mint: PublicKey, current: TokenMetadata, payer: PublicKey,
  updateAuthority: PublicKey, fields: MetadataFields,
): Promise<TransactionInstruction[]> {
  const f = assertMetadataLimits(fields);
  const next: TokenMetadata = { ...current, name: f.name, symbol: f.symbol, uri: f.uri };
  const ixs: TransactionInstruction[] = [];
  const growth = pack(next).length - pack(current).length;
  if (growth > 0) {
    const info = await connection.getAccountInfo(mint);
    if (!info) throw new Error('mint vanished');
    const need = await connection.getMinimumBalanceForRentExemption(info.data.length + growth);
    if (need > info.lamports) {
      ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: mint, lamports: need - info.lamports }));
    }
  }
  for (const [field, value] of [['name', f.name], ['symbol', f.symbol], ['uri', f.uri]] as const) {
    if (current[field] === value) continue;
    ixs.push(createUpdateFieldInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority, field, value,
    }));
  }
  return ixs;
}

/**
 * Rewrite name/symbol/uri on chain. `authority` must be the metadata update authority (the DBC pool
 * creator, for the master token) and also pays. Returns the signature and the metadata read back.
 */
export async function updateTokenMetadata(
  connection: Connection, authority: Keypair, mint: PublicKey, fields: MetadataFields,
): Promise<{ signature: string; before: OnchainMetadata; after: OnchainMetadata }> {
  const before = await readTokenMetadata(connection, mint);
  if (!before.isMutable) throw new Error(`metadata of ${mint.toBase58()} is immutable`);
  if (!before.updateAuthority || !before.updateAuthority.equals(authority.publicKey)) {
    throw new Error(
      `update authority is ${before.updateAuthority?.toBase58() ?? 'none'}, signer is ${authority.publicKey.toBase58()}`,
    );
  }
  const ixs: TransactionInstruction[] = [];
  if (before.standard === 'metaplex') {
    const info = await connection.getAccountInfo(before.metadataAddress);
    if (!info) throw new Error('metadata account vanished');
    ixs.push(buildMetaplexUpdateIx(info.data, mint, authority.publicKey, fields));
  } else {
    const current = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    if (!current) throw new Error('token-2022 metadata vanished');
    ixs.push(...await buildToken2022UpdateIxs(connection, mint, current, authority.publicKey, authority.publicKey, fields));
  }
  if (ixs.length === 0) {
    return { signature: '', before, after: before };
  }
  const tx = new Transaction().add(...ixs);
  const signature = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
  const after = await readTokenMetadata(connection, mint);
  return { signature, before, after };
}
