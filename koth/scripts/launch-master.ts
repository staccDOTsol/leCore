/** Step 2: mint the master shill token on the curve. Usage: launch-master <name> <symbol> <uri> */
import { boot, explorer, loadKeypair } from './_env.js';
import { launchMasterToken } from '../src/dbc.js';
import { readTokenMetadata } from '../src/metadata.js';

const { cfg, connection } = boot();
const [name, symbol, uri] = process.argv.slice(2);
if (!name || !symbol || !uri) { console.error('usage: launch-master <name> <symbol> <uri>'); process.exit(2); }
if (!cfg.dbcConfig) { console.error('KOTH_DBC_CONFIG is not set; run create-config first'); process.exit(2); }
const payer = loadKeypair(cfg.keypairPath);
const { baseMint, pool, signature } = await launchMasterToken(connection, payer, cfg.dbcConfig, { name, symbol, uri });
console.log(`mint  ${baseMint.toBase58()}`);
console.log(`pool  ${pool.toBase58()}`);
console.log(`tx    ${explorer(signature, cfg.rpcUrl)}`);
const md = await readTokenMetadata(connection, baseMint);
console.log(`metadata  ${md.standard}  name="${md.name}" symbol="${md.symbol}" uri="${md.uri}"`);
console.log(`update authority  ${md.updateAuthority?.toBase58()}  mutable=${md.isMutable}`);
console.log(`\nadd to .env:\nKOTH_MASTER_MINT=${baseMint.toBase58()}\nKOTH_MASTER_POOL=${pool.toBase58()}`);
