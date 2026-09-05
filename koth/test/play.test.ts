import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  CONFIG_LEN, PLAY_LEN, RAYDIUM_POOL_STATE_DISC, RAYDIUM_POOL_STATE_LEN, configPda, decodeConfig, decodePlay, decodePoolState,
  awardIx, encodeAwardData, encodePlayData, initializeIx, playIx, playPda, setMasterIx, shillSide, vaultLpAta, vaultPda,
} from '../src/play.js';

const programId = new PublicKey('EWhj4iLpFxnD4w2ULdK1dgsbbGJ9s7L281rpSXgLGUmG');
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));

function poolBytes(lp: PublicKey, t0: PublicKey, t1: PublicKey): Buffer {
  const d = Buffer.alloc(RAYDIUM_POOL_STATE_LEN);
  RAYDIUM_POOL_STATE_DISC.copy(d, 0);
  lp.toBuffer().copy(d, 136); t0.toBuffer().copy(d, 168); t1.toBuffer().copy(d, 200);
  return d;
}

describe('raydium pool state', () => {
  it('decodes lp/token0/token1 at the verified offsets and rejects other accounts', () => {
    const s = decodePoolState(poolBytes(pk(7), pk(1), pk(2)));
    expect(s.lpMint.equals(pk(7))).toBe(true); expect(s.token0.equals(pk(1))).toBe(true); expect(s.token1.equals(pk(2))).toBe(true);
    const bad = poolBytes(pk(7), pk(1), pk(2)); bad[0] ^= 1;
    expect(() => decodePoolState(bad)).toThrow(/not a Raydium/);
    expect(() => decodePoolState(Buffer.alloc(100))).toThrow();
  });
  it('shillSide mirrors the program', () => {
    const s = decodePoolState(poolBytes(pk(7), pk(1), pk(2)));
    expect(shillSide(s, pk(1))?.equals(pk(2))).toBe(true);
    expect(shillSide(s, pk(2))?.equals(pk(1))).toBe(true);
    expect(shillSide(s, pk(3))).toBeNull();
    expect(shillSide(decodePoolState(poolBytes(pk(7), pk(1), pk(1))), pk(1))).toBeNull();
  });
});

describe('account layouts', () => {
  it('round-trips config and play records at the program sizes', () => {
    const c = Buffer.alloc(CONFIG_LEN); c[0] = 1; pk(9).toBuffer().copy(c, 1); pk(8).toBuffer().copy(c, 33); pk(6).toBuffer().copy(c, 65); c.writeBigUInt64LE(42n, 97); c[105] = 254;
    const cfg = decodeConfig(c);
    expect(cfg.admin.equals(pk(9))).toBe(true); expect(cfg.masterMint.equals(pk(8))).toBe(true); expect(cfg.cpmmProgram.equals(pk(6))).toBe(true); expect(cfg.plays).toBe(42n); expect(cfg.bump).toBe(254);
    const p = Buffer.alloc(PLAY_LEN); p[0] = 2; pk(1).toBuffer().copy(p, 1); pk(2).toBuffer().copy(p, 33); pk(3).toBuffer().copy(p, 65); pk(4).toBuffer().copy(p, 97);
    p.writeBigUInt64LE(1000n, 129); p.writeUInt32LE(3, 137); p.writeBigUInt64LE(10n, 141); p.writeBigUInt64LE(20n, 149); p[157] = 250;
    const play = decodePlay(p);
    expect(play.player.equals(pk(1))).toBe(true); expect(play.shillMint.equals(pk(4))).toBe(true); expect(play.amount).toBe(1000n); expect(play.count).toBe(3); expect(play.lastSlot).toBe(20n); expect(play.bump).toBe(250);
    expect(() => decodeConfig(p)).toThrow(); expect(() => decodePlay(c)).toThrow();
  });
});

describe('instructions', () => {
  it('encodes Initialize / SetMaster / Play with the program account order', () => {
    const admin = Keypair.generate().publicKey;
    const init = initializeIx({ programId, admin, masterMint: pk(8), cpmmProgram: pk(6) });
    expect(init.data[0]).toBe(0); expect(init.data).toHaveLength(65);
    expect(init.keys.map((k) => k.pubkey.toBase58())).toEqual([admin, configPda(programId)[0], SystemProgram.programId].map((k) => k.toBase58()));
    expect(init.keys[0].isSigner).toBe(true);

    const set = setMasterIx({ programId, admin, masterMint: pk(5) });
    expect(set.data[0]).toBe(2); expect(set.data.subarray(1).equals(pk(5).toBuffer())).toBe(true);

    expect(encodePlayData(42n).readBigUInt64LE(1)).toBe(42n);
    const operator = Keypair.generate().publicKey, player = Keypair.generate().publicKey, pool = pk(11), lp = pk(12), src = pk(13);
    const ix = playIx({ programId, operator, player, poolState: pool, lpMint: lp, sourceLp: src, amount: 7n });
    expect(ix.data[0]).toBe(1);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toEqual([operator, player, configPda(programId)[0], pool, lp, src, vaultLpAta(programId, lp), playPda(programId, pool, player)[0], vaultPda(programId)[0], TOKEN_PROGRAM_ID, SystemProgram.programId].map((k) => k.toBase58()));
    expect(ix.keys[0].isSigner).toBe(true); expect(ix.keys[1].isSigner).toBe(false);
    expect(ix.keys[5].isWritable).toBe(true); expect(ix.keys[6].isWritable).toBe(true); expect(ix.keys[7].isWritable).toBe(true);

    // Award: tag 3, admin signs, vault ata -> destination, signed for by the vault pda
    expect(encodeAwardData(9n)[0]).toBe(3); expect(encodeAwardData(9n).readBigUInt64LE(1)).toBe(9n);
    const dst = pk(14);
    const aw = awardIx({ programId, admin, lpMint: lp, destination: dst, amount: 9n });
    expect(aw.keys.map((k) => k.pubkey.toBase58())).toEqual([admin, configPda(programId)[0], lp, vaultLpAta(programId, lp), dst, vaultPda(programId)[0], TOKEN_PROGRAM_ID].map((k) => k.toBase58()));
    expect(aw.keys[0].isSigner).toBe(true); expect(aw.keys[3].isWritable).toBe(true); expect(aw.keys[4].isWritable).toBe(true);
  });
  it('derives pdas from the program seeds', () => {
    expect(PublicKey.isOnCurve(vaultPda(programId)[0].toBytes())).toBe(false);
    expect(playPda(programId, pk(1), pk(2))[0].equals(playPda(programId, pk(1), pk(2))[0])).toBe(true);
    expect(playPda(programId, pk(1), pk(2))[0].equals(playPda(programId, pk(2), pk(1))[0])).toBe(false);
  });
});
