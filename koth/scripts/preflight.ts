/**
 * Read-only mainnet checks before (and after) the launch. Sends nothing.
 *   - the operator wallet exists and has SOL for rent + fees
 *   - the quote mint ($TOKEN) is a 6-decimal Token-2022 mint without transfer fee / hook extensions
 *   - if KOTH_MASTER_MINT is set: its pool + config resolve, the metadata is mutable, and the update
 *     authority is the operator -- i.e. the on-chain rewrite will go through
 *   - if KOTH_PLAY_PROGRAM_ID is set: the program is deployed and its config pda is initialized
 */
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, ExtensionType, getExtensionTypes, getMint } from '@solana/spl-token';
import { boot, loadKeypair } from './_env.js';
import { expectedUpdateAuthority, getMasterPool } from '../src/dbc.js';
import { readTokenMetadata } from '../src/metadata.js';
import { fetchConfig } from '../src/play.js';

const { cfg, connection } = boot();
let ok = true;
const check = (cond: boolean, line: string) => { ok = ok && cond; console.log(`${cond ? 'ok  ' : 'FAIL'} ${line}`); };

const operator = loadKeypair(cfg.keypairPath);
const lamports = await connection.getBalance(operator.publicKey);
check(lamports >= 0.5 * LAMPORTS_PER_SOL, `operator ${operator.publicKey.toBase58()} has ${lamports / LAMPORTS_PER_SOL} SOL (want >= 0.5 for config + pool rent)`);

const qInfo = await connection.getAccountInfo(cfg.quoteMint);
check(Boolean(qInfo && qInfo.owner.equals(TOKEN_2022_PROGRAM_ID)), `quote mint ${cfg.quoteMint.toBase58()} is Token-2022`);
if (qInfo) {
  const m = await getMint(connection, cfg.quoteMint, 'confirmed', qInfo.owner);
  const exts = m.tlvData.length ? getExtensionTypes(m.tlvData) : [];
  const bad = exts.filter((e) => e === ExtensionType.TransferFeeConfig || e === ExtensionType.TransferHook);
  check(m.decimals === 6, `quote mint has ${m.decimals} decimals (curve expects 6)`);
  check(bad.length === 0, `quote mint extensions: ${exts.map((e) => ExtensionType[e]).join(', ') || 'none'} (no transfer fee / hook)`);
}

if (cfg.masterMint) {
  const pool = await getMasterPool(connection, cfg.masterMint);
  check(Boolean(pool), `master ${cfg.masterMint.toBase58()} has a DBC pool${pool ? ` ${pool.pool.toBase58()}` : ''}`);
  const md = await readTokenMetadata(connection, cfg.masterMint);
  check(md.isMutable, `master metadata (${md.standard}) is mutable: "${md.name}" $${md.symbol} ${md.uri}`);
  check(Boolean(md.updateAuthority?.equals(operator.publicKey)), `update authority ${md.updateAuthority?.toBase58() ?? 'none'} is the operator`);
  if (pool) {
    const exp = expectedUpdateAuthority(pool.state, pool.config);
    check(Boolean(exp && md.updateAuthority && exp.equals(md.updateAuthority)), `DBC config says authority ${exp?.toBase58() ?? 'immutable'}; chain agrees`);
  }
} else {
  console.log('skip KOTH_MASTER_MINT not set (run create-config + launch-master)');
}

if (cfg.playProgramId) {
  const prog = await connection.getAccountInfo(cfg.playProgramId);
  check(Boolean(prog?.executable), `play program ${cfg.playProgramId.toBase58()} is deployed`);
  const c = await fetchConfig(connection, cfg.playProgramId);
  check(Boolean(c), `play config initialized${c ? `: master ${c.masterMint.toBase58()} cpmm ${c.cpmmProgram.toBase58()} plays ${c.plays}` : ' (run init-play)'}`);
  if (c && cfg.masterMint) check(c.masterMint.equals(cfg.masterMint), 'play config master mint matches KOTH_MASTER_MINT');
} else {
  console.log('skip KOTH_PLAY_PROGRAM_ID not set (deploy koth/program, then init-play)');
}

console.log(ok ? '\npreflight OK' : '\npreflight FAILED');
process.exit(ok ? 0 : 1);
