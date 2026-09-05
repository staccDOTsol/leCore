/** Step 2: mint the master shill token on the curve. Usage: launch-master <name> <symbol> <uri> */
import { boot, explorer, loadKeypair } from './_env.js';
import { launchMasterToken } from '../src/dbc.js';
import { readTokenMetadata } from '../src/metadata.js';

const { cfg, connection } = boot();
// Arguments win; else KOTH_MASTER_NAME / KOTH_MASTER_SYMBOL / KOTH_MASTER_URI; else the genesis identity in koth/genesis/.
// The identity is MUTABLE (that is the point); the mint, config and curve are not.
const GENESIS_URI = 'https://raw.githubusercontent.com/staccDOTsol/leCore/claude/shill-token-metadata-onchain-9fhodc/koth/genesis/genesis.json';
const [argName, argSymbol, argUri] = process.argv.slice(2);
const name = argName || process.env.KOTH_MASTER_NAME || 'Master Shill';
const symbol = argSymbol || process.env.KOTH_MASTER_SYMBOL || 'SHILL';
const uri = argUri || process.env.KOTH_MASTER_URI || GENESIS_URI;
if (!cfg.dbcConfig) { console.error('KOTH_DBC_CONFIG is not set; run create-config first'); process.exit(2); }
const payer = loadKeypair(cfg.keypairPath);
console.log(`launching "${name}" $${symbol} uri ${uri}\n  config ${cfg.dbcConfig.toBase58()} quote ${cfg.quoteMint.toBase58()} creator ${payer.publicKey.toBase58()}`);
const { baseMint, pool, signature } = await launchMasterToken(connection, payer, cfg.dbcConfig, { name, symbol, uri }, { quoteMint: cfg.quoteMint });
console.log(`mint  ${baseMint.toBase58()}`);
console.log(`pool  ${pool.toBase58()}`);
console.log(`tx    ${explorer(signature, cfg.rpcUrl)}`);
const md = await readTokenMetadata(connection, baseMint);
console.log(`metadata  ${md.standard}  name="${md.name}" symbol="${md.symbol}" uri="${md.uri}"`);
console.log(`update authority  ${md.updateAuthority?.toBase58()}  mutable=${md.isMutable}`);
console.log(`\nadd to .env:\nKOTH_MASTER_MINT=${baseMint.toBase58()}\nKOTH_MASTER_POOL=${pool.toBase58()}`);
