/**
 * Client for the koth-play program (koth/program): the vault that turns an attempt at the hill into
 * permanently locked Raydium CPMM liquidity for a MASTER/<token> pair.
 *
 * Layout constants mirror program/src/lib.rs exactly; the Raydium offsets were verified against
 * live mainnet pools (discriminator f7ede3f5d7c3de46, lp_mint @136, token_0 @168, token_1 @200,
 * account length 637).
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const RAYDIUM_POOL_STATE_DISC = Buffer.from('f7ede3f5d7c3de46', 'hex');
export const RAYDIUM_POOL_STATE_LEN = 637;
export const RAYDIUM_LP_MINT_OFFSET = 136;
export const RAYDIUM_TOKEN_0_OFFSET = 168;
export const RAYDIUM_TOKEN_1_OFFSET = 200;

export const CONFIG_SEED = Buffer.from('config');
export const VAULT_SEED = Buffer.from('vault');
export const PLAY_SEED = Buffer.from('play');
export const CONFIG_LEN = 106;
export const PLAY_LEN = 158;
export const CONFIG_DISC = 1;
export const PLAY_DISC = 2;

export enum KothError {
  InvalidInstruction = 0, MissingSigner = 1, InvalidPda = 2, AlreadyInitialized = 3, NotInitialized = 4, Unauthorized = 5,
  NotACpmmPool = 6, PoolLacksMaster = 7, LpMintMismatch = 8, TokenAccountMismatch = 9, ZeroAmount = 10, WrongProgram = 11, Overflow = 12,
}

export type PoolSides = { lpMint: PublicKey; token0: PublicKey; token1: PublicKey };

export function decodePoolState(data: Buffer | Uint8Array): PoolSides {
  const d = Buffer.from(data);
  if (d.length < RAYDIUM_TOKEN_1_OFFSET + 32 || !d.subarray(0, 8).equals(RAYDIUM_POOL_STATE_DISC)) {
    throw new Error('not a Raydium CPMM PoolState');
  }
  const pk = (at: number) => new PublicKey(d.subarray(at, at + 32));
  return { lpMint: pk(RAYDIUM_LP_MINT_OFFSET), token0: pk(RAYDIUM_TOKEN_0_OFFSET), token1: pk(RAYDIUM_TOKEN_1_OFFSET) };
}

/** The non-master side of the pair, or null when the master token is not in it (same rule as the program). */
export function shillSide(sides: PoolSides, master: PublicKey): PublicKey | null {
  if (sides.token0.equals(sides.token1)) return null;
  if (sides.token0.equals(master)) return sides.token1;
  if (sides.token1.equals(master)) return sides.token0;
  return null;
}

export function configPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}
export function vaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], programId);
}
export function playPda(programId: PublicKey, pool: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLAY_SEED, pool.toBuffer(), player.toBuffer()], programId);
}
/** The vault's LP token account: the ATA of the vault pda (off-curve owner). */
export function vaultLpAta(programId: PublicKey, lpMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(lpMint, vaultPda(programId)[0], true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}
export function createVaultLpAtaIx(payer: PublicKey, programId: PublicKey, lpMint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(payer, vaultLpAta(programId, lpMint), vaultPda(programId)[0], lpMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export type ConfigAccount = { admin: PublicKey; masterMint: PublicKey; cpmmProgram: PublicKey; plays: bigint; bump: number };
export type PlayAccount = { player: PublicKey; poolState: PublicKey; lpMint: PublicKey; shillMint: PublicKey; amount: bigint; count: number; firstSlot: bigint; lastSlot: bigint; bump: number };

export function decodeConfig(data: Buffer | Uint8Array): ConfigAccount {
  const d = Buffer.from(data);
  if (d.length !== CONFIG_LEN || d[0] !== CONFIG_DISC) throw new Error('not a koth config account');
  return { admin: new PublicKey(d.subarray(1, 33)), masterMint: new PublicKey(d.subarray(33, 65)), cpmmProgram: new PublicKey(d.subarray(65, 97)), plays: d.readBigUInt64LE(97), bump: d[105] };
}
export function decodePlay(data: Buffer | Uint8Array): PlayAccount {
  const d = Buffer.from(data);
  if (d.length !== PLAY_LEN || d[0] !== PLAY_DISC) throw new Error('not a koth play account');
  return {
    player: new PublicKey(d.subarray(1, 33)), poolState: new PublicKey(d.subarray(33, 65)), lpMint: new PublicKey(d.subarray(65, 97)),
    shillMint: new PublicKey(d.subarray(97, 129)), amount: d.readBigUInt64LE(129), count: d.readUInt32LE(137),
    firstSlot: d.readBigUInt64LE(141), lastSlot: d.readBigUInt64LE(149), bump: d[157],
  };
}

export function initializeIx(a: { programId: PublicKey; admin: PublicKey; masterMint: PublicKey; cpmmProgram: PublicKey }): TransactionInstruction {
  const data = Buffer.concat([Buffer.from([0]), a.masterMint.toBuffer(), a.cpmmProgram.toBuffer()]);
  return new TransactionInstruction({
    programId: a.programId, data,
    keys: [
      { pubkey: a.admin, isSigner: true, isWritable: true },
      { pubkey: configPda(a.programId)[0], isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function setMasterIx(a: { programId: PublicKey; admin: PublicKey; masterMint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId, data: Buffer.concat([Buffer.from([2]), a.masterMint.toBuffer()]),
    keys: [
      { pubkey: a.admin, isSigner: true, isWritable: false },
      { pubkey: configPda(a.programId)[0], isSigner: false, isWritable: true },
    ],
  });
}

export function encodePlayData(amount: bigint): Buffer {
  const d = Buffer.alloc(9);
  d[0] = 1;
  d.writeBigUInt64LE(amount, 1);
  return d;
}

/** The Play instruction. `operator` holds the LP and pays; `player` is who the play is recorded for. */
export function playIx(a: { programId: PublicKey; operator: PublicKey; player: PublicKey; poolState: PublicKey; lpMint: PublicKey; sourceLp: PublicKey; amount: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.programId, data: encodePlayData(a.amount),
    keys: [
      { pubkey: a.operator, isSigner: true, isWritable: true },
      { pubkey: a.player, isSigner: false, isWritable: false },
      { pubkey: configPda(a.programId)[0], isSigner: false, isWritable: true },
      { pubkey: a.poolState, isSigner: false, isWritable: false },
      { pubkey: a.lpMint, isSigner: false, isWritable: false },
      { pubkey: a.sourceLp, isSigner: false, isWritable: true },
      { pubkey: vaultLpAta(a.programId, a.lpMint), isSigner: false, isWritable: true },
      { pubkey: playPda(a.programId, a.poolState, a.player)[0], isSigner: false, isWritable: true },
      { pubkey: vaultPda(a.programId)[0], isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export async function fetchConfig(connection: Connection, programId: PublicKey): Promise<ConfigAccount | null> {
  const info = await connection.getAccountInfo(configPda(programId)[0]);
  return info ? decodeConfig(info.data) : null;
}
export async function fetchPlay(connection: Connection, programId: PublicKey, pool: PublicKey, player: PublicKey): Promise<PlayAccount | null> {
  const info = await connection.getAccountInfo(playPda(programId, pool, player)[0]);
  return info ? decodePlay(info.data) : null;
}

export type CpmmPool = PoolSides & { pool: PublicKey };

/** Every CPMM pool that pairs `master` with anything, straight from the RPC (two memcmp scans). */
export async function findCpmmPoolsWithMaster(connection: Connection, cpmmProgram: PublicKey, master: PublicKey): Promise<CpmmPool[]> {
  const out = new Map<string, CpmmPool>();
  for (const offset of [RAYDIUM_TOKEN_0_OFFSET, RAYDIUM_TOKEN_1_OFFSET]) {
    const accs = await connection.getProgramAccounts(cpmmProgram, {
      filters: [{ dataSize: RAYDIUM_POOL_STATE_LEN }, { memcmp: { offset, bytes: master.toBase58() } }],
      dataSlice: { offset: 0, length: RAYDIUM_TOKEN_1_OFFSET + 32 },
    });
    for (const a of accs) out.set(a.pubkey.toBase58(), { pool: a.pubkey, ...decodePoolState(a.account.data) });
  }
  return [...out.values()];
}

/** The CPMM pool for the (master, other) pair in either order, or null. */
export async function findCpmmPool(connection: Connection, cpmmProgram: PublicKey, master: PublicKey, other: PublicKey): Promise<CpmmPool | null> {
  for (const [a, b] of [[master, other], [other, master]] as const) {
    const accs = await connection.getProgramAccounts(cpmmProgram, {
      filters: [
        { dataSize: RAYDIUM_POOL_STATE_LEN },
        { memcmp: { offset: RAYDIUM_TOKEN_0_OFFSET, bytes: a.toBase58() } },
        { memcmp: { offset: RAYDIUM_TOKEN_1_OFFSET, bytes: b.toBase58() } },
      ],
      dataSlice: { offset: 0, length: RAYDIUM_TOKEN_1_OFFSET + 32 },
    });
    if (accs[0]) return { pool: accs[0].pubkey, ...decodePoolState(accs[0].account.data) };
  }
  return null;
}

export type PlayProof = { player: PublicKey; pool: PublicKey; amount: bigint; slot: number };

/** Read a confirmed transaction and extract the Play it carried, if any. */
export function playFromTransaction(tx: VersionedTransactionResponse, programId: PublicKey): PlayProof | null {
  if (!tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  for (const ix of tx.transaction.message.compiledInstructions) {
    const pid = keys.get(ix.programIdIndex);
    if (!pid || !pid.equals(programId)) continue;
    const data = Buffer.from(ix.data);
    if (data[0] !== 1 || data.length < 9) continue;
    const player = keys.get(ix.accountKeyIndexes[1]);
    const pool = keys.get(ix.accountKeyIndexes[3]);
    if (!player || !pool) continue;
    return { player, pool, amount: data.readBigUInt64LE(1), slot: tx.slot };
  }
  return null;
}

export async function verifyPlaySignature(connection: Connection, programId: PublicKey, signature: string): Promise<PlayProof | null> {
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  return tx ? playFromTransaction(tx, programId) : null;
}
