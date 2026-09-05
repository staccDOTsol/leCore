/** Rewrite name/symbol/uri of the master token (or any mint we hold authority for).
 *  Usage: update-metadata <name> <symbol> <uri> [mint] */
import { PublicKey } from '@solana/web3.js';
import { boot, explorer, loadKeypair } from './_env.js';
import { updateTokenMetadata } from '../src/metadata.js';

const { cfg, connection } = boot();
const [name, symbol, uri, mintArg] = process.argv.slice(2);
const mint = mintArg ? new PublicKey(mintArg) : cfg.masterMint;
if (!name || !symbol || !uri || !mint) { console.error('usage: update-metadata <name> <symbol> <uri> [mint]'); process.exit(2); }
const authority = loadKeypair(cfg.keypairPath);
const { signature, before, after } = await updateTokenMetadata(connection, authority, mint, { name, symbol, uri });
console.log(`before  "${before.name}" / ${before.symbol} / ${before.uri}`);
console.log(`after   "${after.name}" / ${after.symbol} / ${after.uri}`);
console.log(`tx      ${signature ? explorer(signature, cfg.rpcUrl) : '(no change)'}`);
