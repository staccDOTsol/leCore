/**
 * The on-chain proof, end to end, on devnet: quote mint -> config -> launch -> rewrite metadata -> read back.
 * $TOKEN does not exist on devnet, so a throwaway Token-2022 mint with the same shape (6 decimals) stands in
 * as the quote mint. Needs a devnet SOLANA_RPC_URL / SOLANA_CLUSTER=devnet and a funded KOTH_KEYPAIR (~0.5 SOL).
 */
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction, getMintLen } from '@solana/spl-token';
import { boot, explorer, loadKeypair } from './_env.js';
import { createMasterConfig, launchMasterToken, getMasterPool, expectedUpdateAuthority } from '../src/dbc.js';
import { readTokenMetadata, updateTokenMetadata } from '../src/metadata.js';

const { cfg, connection } = boot();
if (!/devnet/i.test(cfg.rpcUrl)) { console.error('refusing: this script only runs against devnet'); process.exit(2); }
const payer = loadKeypair(cfg.keypairPath);
const bal = await connection.getBalance(payer.publicKey);
console.log(`payer ${payer.publicKey.toBase58()} balance ${bal / 1e9} SOL`);
if (bal < 0.3e9) { console.error('need at least 0.3 SOL of devnet SOL'); process.exit(2); }

// 0. a Token-2022 stand-in for $TOKEN (6 decimals)
const quote = Keypair.generate();
const len = getMintLen([]);
const tx0 = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: quote.publicKey, space: len, lamports: await connection.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeMint2Instruction(quote.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
);
const s0 = await sendAndConfirmTransaction(connection, tx0, [payer, quote], { commitment: 'confirmed' });
console.log(`0. quote mint (token-2022, 6 dp) ${quote.publicKey.toBase58()}  ${explorer(s0, cfg.rpcUrl)}`);

const c = await createMasterConfig(connection, payer, { authority: 'creator', quoteMint: quote.publicKey });
console.log(`1. config ${c.config.toBase58()} quoted in ${c.quoteMint.toBase58()}, bonds at 100M  ${explorer(c.signature, cfg.rpcUrl)}`);

const l = await launchMasterToken(connection, payer, c.config, { name: 'Master Shill', symbol: 'SHILL', uri: 'https://example.com/koth/genesis.json' }, { quoteMint: quote.publicKey });
console.log(`2. mint ${l.baseMint.toBase58()} pool ${l.pool.toBase58()}  ${explorer(l.signature, cfg.rpcUrl)}`);

const pool = await getMasterPool(connection, l.baseMint);
if (!pool) throw new Error('pool not found by base mint');
const expect = expectedUpdateAuthority(pool.state, pool.config);
const md0 = await readTokenMetadata(connection, l.baseMint);
console.log(`   metadata authority on chain ${md0.updateAuthority?.toBase58()} expected ${expect?.toBase58()} mutable=${md0.isMutable}`);
if (!md0.updateAuthority?.equals(payer.publicKey)) throw new Error('creator did not receive update authority');

const u = await updateTokenMetadata(connection, payer, l.baseMint, { name: 'KING BONK', symbol: 'KBONK', uri: 'https://example.com/koth/1.json' });
console.log(`3. rewrite  ${explorer(u.signature, cfg.rpcUrl)}`);
console.log(`   before "${u.before.name}" / ${u.before.symbol} / ${u.before.uri}`);
console.log(`   after  "${u.after.name}" / ${u.after.symbol} / ${u.after.uri}`);
if (u.after.name !== 'KING BONK' || u.after.symbol !== 'KBONK') throw new Error('metadata did not change');
console.log('PROOF OK: the master token metadata was rewritten on chain by the creator wallet.');
