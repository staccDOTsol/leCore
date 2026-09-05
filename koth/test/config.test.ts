import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfig, parseKeypair, resolveRpcUrl } from '../src/config.js';

describe('KOTH_KEYPAIR', () => {
  const kp = Keypair.generate();
  it('accepts a bs58 secret key', () => {
    expect(parseKeypair(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('accepts the solana-keygen JSON byte array inline', () => {
    expect(parseKeypair(JSON.stringify([...kp.secretKey])).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('accepts a path to the solana-keygen file', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koth-key-')), 'op.json');
    fs.writeFileSync(f, JSON.stringify([...kp.secretKey]));
    expect(parseKeypair(f).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('accepts a 32-byte seed and rejects junk', () => {
    const seed = kp.secretKey.slice(0, 32);
    expect(parseKeypair(bs58.encode(seed)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(() => parseKeypair('not a key at all !!!')).toThrow(/neither/);
    expect(() => parseKeypair(bs58.encode(new Uint8Array(10)))).toThrow(/10 bytes/);
  });
  it('reads KOTH_KEYPAIR or lowercase koth_keypair', () => {
    expect(loadConfig({ koth_keypair: 'x' } as NodeJS.ProcessEnv).keypairPath).toBe('x');
    expect(loadConfig({ KOTH_KEYPAIR: 'y' } as NodeJS.ProcessEnv).keypairPath).toBe('y');
  });
});

describe('rpc', () => {
  it('is mainnet only: key -> helius mainnet, url wins, default public', () => {
    expect(resolveRpcUrl({ SOLANA_RPC_KEY: 'k' })).toBe('https://mainnet.helius-rpc.com/?api-key=k');
    expect(resolveRpcUrl({ solana_rpc_key: 'k' })).toBe('https://mainnet.helius-rpc.com/?api-key=k');
    expect(resolveRpcUrl({ SOLANA_RPC_URL: 'https://rpc/{key}', SOLANA_RPC_KEY: 'k' })).toBe('https://rpc/k');
    expect(resolveRpcUrl({})).toBe('https://api.mainnet-beta.solana.com');
  });
});
