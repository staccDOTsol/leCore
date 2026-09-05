/** Step 1 of the launch: create the DBC partner config that grants the creator metadata authority. */
import { boot, explorer, loadKeypair } from './_env.js';
import { createMasterConfig } from '../src/dbc.js';

const { cfg, connection } = boot();
const payer = loadKeypair(cfg.keypairPath);
const authority = (process.argv[2] === 'partner' ? 'partner' : 'creator') as 'creator' | 'partner';
const { config, quoteMint, signature } = await createMasterConfig(connection, payer, { authority, quoteMint: cfg.quoteMint });
console.log(`config     ${config.toBase58()}`);
console.log(`quote      ${quoteMint.toBase58()} (bonds at 100M)`);
console.log(`authority  ${authority} (${payer.publicKey.toBase58()})`);
console.log(`tx         ${explorer(signature, cfg.rpcUrl)}`);
console.log(`\nadd to .env:\nKOTH_DBC_CONFIG=${config.toBase58()}`);
