import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfig, parseKeypair, resolveRpcUrl, resolveZooWallet } from '../src/config.js';

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
    expect(resolveRpcUrl({ SOLANA_RPC_KEY: 'https://rpc.example/x?api-key=k' })).toBe('https://rpc.example/x?api-key=k');
    expect(resolveRpcUrl({ SOLANA_RPC_URL: 'https://rpc/{key}', SOLANA_RPC_KEY: 'k' })).toBe('https://rpc/k');
    expect(resolveRpcUrl({})).toBe('https://api.mainnet-beta.solana.com');
  });
});

describe('OPENZOO_WALLET', () => {
  const kp = Keypair.generate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koth-zoo-'));
  it("reads the { solana: [...], evm } file `openzoo proxy` writes", () => {
    const f = path.join(dir, 'w.json');
    fs.writeFileSync(f, JSON.stringify({ solana: [...kp.secretKey], evm: '0xabc' }));
    expect(resolveZooWallet({ OPENZOO_WALLET: f })?.equals(kp.publicKey)).toBe(true);
  });
  it('reads a bare solana-keygen byte array too', () => {
    const f = path.join(dir, 'k.json');
    fs.writeFileSync(f, JSON.stringify([...kp.secretKey]));
    expect(resolveZooWallet({ OPENZOO_WALLET: f })?.equals(kp.publicKey)).toBe(true);
  });
  it('is null when there is no wallet on this machine', () => {
    expect(resolveZooWallet({ OPENZOO_WALLET: path.join(dir, 'missing.json') })).toBeNull();
  });
});
