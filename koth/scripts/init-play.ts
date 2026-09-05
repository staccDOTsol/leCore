/** After `solana program deploy`: initialize the play program's config with the master mint + CPMM program. */
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { boot, explorer, loadKeypair } from './_env.js';
import { configPda, fetchConfig, initializeIx } from '../src/play.js';

const { cfg, connection } = boot();
if (!cfg.playProgramId || !cfg.masterMint) { console.error('set KOTH_PLAY_PROGRAM_ID and KOTH_MASTER_MINT'); process.exit(2); }
const admin = loadKeypair(cfg.keypairPath);
const existing = await fetchConfig(connection, cfg.playProgramId);
if (existing) {
  console.log(`already initialized: admin ${existing.admin.toBase58()} master ${existing.masterMint.toBase58()} cpmm ${existing.cpmmProgram.toBase58()} plays ${existing.plays}`);
  process.exit(0);
}
const tx = new Transaction().add(initializeIx({ programId: cfg.playProgramId, admin: admin.publicKey, masterMint: cfg.masterMint, cpmmProgram: cfg.raydiumCpmmProgramId }));
const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: 'confirmed' });
console.log(`config ${configPda(cfg.playProgramId)[0].toBase58()} initialized  ${explorer(sig, cfg.rpcUrl)}`);
