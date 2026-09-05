/**
 * Runtime configuration for King of the Hill, read from the environment once.
 *
 * Everything here has a default that lets the pure game logic run with no chain, no model and no
 * bot credentials -- the tests exercise it that way. Anything that touches money (the keypair,
 * the master mint, the play program) is empty by default and must be set explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export type KothConfig = {
  rpcUrl: string;
  /** Birdeye key for token metrics (DexScreener is the keyless fallback). */
  birdeyeApiKey: string;
  /** KOTH_KEYPAIR verbatim: bs58, JSON byte array, or a file path (see parseKeypair). */
  keypairPath: string;
  dbcConfig: PublicKey | null;
  masterMint: PublicKey | null;
  masterPool: PublicKey | null;
  /** The DBC curve's quote mint ($TOKEN by default). */
  quoteMint: PublicKey;
  /** What the inference share of every quote is converted into for the openzoo wallet: TOKEN, LEOS or USDC. */
  inferencePayMint: PublicKey;
  /** The openzoo burner wallet that pays x402 (its public key). */
  zooWallet: PublicKey | null;
  openzooBaseUrl: string;
  jupiterApiKey: string;
  pinataJwt: string;
  dataDir: string;
  publicUrl: string;
  /** Base attempt fee, in SOL worth of the deposit token (0.05 by directive). */
  entrySol: number;
  /** Per-takeover growth of the attempt fee, in percent (1 by directive). */
  entryGrowthPct: number;
  /** King handicaps, in points of the 0-100 total: an uncontested crown, and erosion per failed challenge with its cap. */
  uncontestedHandicap: number;
  erosionPerLoss: number;
  erosionMax: number;
  model: string;
  playProgramId: PublicKey | null;
  raydiumCpmmProgramId: PublicKey;
  telegram: { token: string; chatId: string };
  discord: { token: string; channelId: string };
  x: {
    apiKey: string; apiSecret: string; accessToken: string; accessSecret: string;
    bearer: string; botUserId: string;
  };
};

/** Mainnet only, by directive. */
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const ZOO_TOKEN = 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump';
export const LEOS = '5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_MINTS: Record<string, string> = { TOKEN: ZOO_TOKEN, LEOS, USDC };

/** The openzoo burner's public key: OPENZOO_WALLET_ADDRESS, or read off ~/.openzoo/wallet.json. */
export function resolveZooWallet(env: NodeJS.ProcessEnv = process.env): PublicKey | null {
  if (env.OPENZOO_WALLET_ADDRESS) return new PublicKey(env.OPENZOO_WALLET_ADDRESS);
  const file = env.OPENZOO_WALLET || path.join(process.env.HOME || '', '.openzoo', 'wallet.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey?: string; address?: string; secretKey?: number[]; solana?: number[] } | number[];
    if (Array.isArray(j)) return Keypair.fromSecretKey(Uint8Array.from(j)).publicKey;   // a solana-keygen file
    if (j.publicKey) return new PublicKey(j.publicKey);
    if (j.address) return new PublicKey(j.address);
    if (j.secretKey) return Keypair.fromSecretKey(Uint8Array.from(j.secretKey)).publicKey;
    if (j.solana) return Keypair.fromSecretKey(Uint8Array.from(j.solana)).publicKey;     // what `openzoo proxy` writes: { solana: [...], evm }
  } catch { /* no wallet on this machine */ }
  return null;
}

function pk(v: string | undefined): PublicKey | null {
  return v && v.trim() ? new PublicKey(v.trim()) : null;
}

/**
 * The RPC endpoint. Either a full SOLANA_RPC_URL (a `{key}` placeholder is substituted), or just a
 * SOLANA_RPC_KEY, which is assumed to be a Helius key. Mainnet only.
 */
export function resolveRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.SOLANA_RPC_KEY || env.solana_rpc_key || '';
  if (env.SOLANA_RPC_URL) return env.SOLANA_RPC_URL.replace('{key}', key);
  if (/^https?:\/\//i.test(key)) return key;                       // a full endpoint URL stored under the key name
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return 'https://api.mainnet-beta.solana.com';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KothConfig {
  const rpcUrl = resolveRpcUrl(env);
  return {
    rpcUrl,
    birdeyeApiKey: env.BIRDEYE_API_KEY || env.birdeye_api_key || '',
    keypairPath: env.KOTH_KEYPAIR || env.koth_keypair || '',
    dbcConfig: pk(env.KOTH_DBC_CONFIG),
    masterMint: pk(env.KOTH_MASTER_MINT),
    masterPool: pk(env.KOTH_MASTER_POOL),
    quoteMint: pk(env.KOTH_QUOTE_MINT) ?? new PublicKey(ZOO_TOKEN),
    inferencePayMint: new PublicKey(PAY_MINTS[(env.KOTH_INFERENCE_PAY || 'TOKEN').toUpperCase()] ?? env.KOTH_INFERENCE_PAY ?? ZOO_TOKEN),
    zooWallet: resolveZooWallet(env),
    openzooBaseUrl: env.OPENZOO_BASE_URL || 'http://localhost:8402/v1',
    jupiterApiKey: env.JUPITER_API_KEY || '',
    pinataJwt: env.PINATA_JWT || '',
    dataDir: env.KOTH_DATA_DIR || path.resolve('data'),
    publicUrl: (env.KOTH_PUBLIC_URL || 'http://localhost:8787').replace(/\/+$/, ''),
    entrySol: Number(env.KOTH_ENTRY_SOL || 0.05),
    entryGrowthPct: Number(env.KOTH_ENTRY_GROWTH_PCT || 1),
    uncontestedHandicap: Number(env.KOTH_UNCONTESTED_HANDICAP || 10),
    erosionPerLoss: Number(env.KOTH_EROSION_PER_LOSS || 3),
    erosionMax: Number(env.KOTH_EROSION_MAX || 30),
    model: env.KOTH_MODEL || 'openzoo/auto',
    playProgramId: pk(env.KOTH_PLAY_PROGRAM_ID),
    raydiumCpmmProgramId: new PublicKey(env.RAYDIUM_CPMM_PROGRAM_ID || RAYDIUM_CPMM_PROGRAM),
    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },
    discord: { token: env.DISCORD_BOT_TOKEN || '', channelId: env.DISCORD_CHANNEL_ID || '' },
    x: {
      apiKey: env.X_API_KEY || '', apiSecret: env.X_API_SECRET || '',
      accessToken: env.X_ACCESS_TOKEN || '', accessSecret: env.X_ACCESS_SECRET || '',
      bearer: env.X_BEARER_TOKEN || '', botUserId: env.X_BOT_USER_ID || '',
    },
  };
}

/**
 * The operator keypair, from KOTH_KEYPAIR in whichever form is at hand:
 *   - a bs58 string (what Phantom / Solflare export)             KOTH_KEYPAIR=4vJ9...
 *   - the JSON uint8 array solana-keygen writes                   KOTH_KEYPAIR=[12,34,...]
 *   - a path to that JSON file                                    KOTH_KEYPAIR=./keys/operator.json
 * A 64-byte value is the full secret key; a 32-byte value is treated as the seed.
 */
export function parseKeypair(value: string): Keypair {
  const v = value.trim();
  if (!v) throw new Error('KOTH_KEYPAIR is empty');
  let bytes: Uint8Array;
  if (v.startsWith('[')) {
    bytes = Uint8Array.from(JSON.parse(v) as number[]);
  } else if (fs.existsSync(v)) {
    bytes = Uint8Array.from(JSON.parse(fs.readFileSync(v, 'utf8')) as number[]);
  } else {
    try {
      bytes = bs58.decode(v);
    } catch {
      throw new Error('KOTH_KEYPAIR is neither a file path, a JSON byte array, nor a bs58 secret key');
    }
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`KOTH_KEYPAIR decodes to ${bytes.length} bytes; expected 64 (secret key) or 32 (seed)`);
}

export function loadKeypair(value: string): Keypair {
  if (!value) throw new Error('KOTH_KEYPAIR is not set (bs58 secret, JSON byte array, or path to a solana-keygen file)');
  return parseKeypair(value);
}
