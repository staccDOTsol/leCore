/** Shared bootstrap for the operator scripts: .env, connection, keypair. No dotenv dependency. */
import fs from 'node:fs';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { loadConfig, loadKeypair, type KothConfig } from '../src/config.js';

export function loadDotenv(file = path.resolve('.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function boot(): { cfg: KothConfig; connection: Connection } {
  loadDotenv();
  const cfg = loadConfig();
  return { cfg, connection: new Connection(cfg.rpcUrl, 'confirmed') };
}

export function explorer(sig: string, _rpcUrl?: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export { loadKeypair };
