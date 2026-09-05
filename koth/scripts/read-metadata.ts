/** Print a mint's on-chain metadata (and its off-chain JSON). Usage: read-metadata [mint] */
import { PublicKey } from '@solana/web3.js';
import { boot } from './_env.js';
import { fetchOffchainJson, readTokenMetadata } from '../src/metadata.js';

const { cfg, connection } = boot();
const mint = process.argv[2] ? new PublicKey(process.argv[2]) : cfg.masterMint;
if (!mint) { console.error('usage: read-metadata <mint>  (or set KOTH_MASTER_MINT)'); process.exit(2); }
const md = await readTokenMetadata(connection, mint);
console.log(JSON.stringify({ ...md, mint: md.mint.toBase58(), tokenProgram: md.tokenProgram.toBase58(),
  metadataAddress: md.metadataAddress.toBase58(), updateAuthority: md.updateAuthority?.toBase58() ?? null }, null, 2));
const off = await fetchOffchainJson(md.uri);
if (off) console.log('off-chain:', JSON.stringify(off, null, 2).slice(0, 1500));
