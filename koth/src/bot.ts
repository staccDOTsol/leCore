/**
 * The runner: one process that is the game. No website -- the surfaces are the bots, plus a tiny
 * static server for the metadata JSON and card images the on-chain uri points at.
 *
 *   npx tsx src/bot.ts            # reads .env; starts every surface that has credentials
 *   KOTH_DRY_RUN=1 ...            # no chain, no entry: in-memory master token, free play, for rehearsal
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { FileImageProvider } from './assets.js';
import { MasterChain, MemoryChain, type ChainLike } from './chain.js';
import { Commands } from './commands.js';
import { loadConfig, loadKeypair } from './config.js';
import { Entry } from './entry.js';
import { FileStore, FreeEntry, Hill, type EntryLike } from './hill.js';
import { Judge, MockJudge, type JudgeLike } from './judge.js';
import { OpenzooClient } from './openzoo.js';
import { DiscordSurface } from './surfaces/discord.js';
import { TelegramSurface } from './surfaces/telegram.js';
import { XSurface } from './surfaces/x.js';
import { FileUriProvider, PinataUriProvider, type UriProvider } from './uri.js';

function loadDotenv(file = path.resolve('.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

export async function main(): Promise<void> {
  loadDotenv();
  const cfg = loadConfig();
  const dry = process.env.KOTH_DRY_RUN === '1';
  const explorer = (sig: string) => `https://solscan.io/tx/${sig}`;
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // inference: the zoo, always. A mock only for rehearsal.
  const judge: JudgeLike = process.env.KOTH_MOCK_JUDGE === '1'
    ? new MockJudge()
    : new Judge(new OpenzooClient({ baseUrl: cfg.openzooBaseUrl, model: cfg.model }));

  let chain: ChainLike;
  let entry: Entry | null = null;
  let entryLike: EntryLike = new FreeEntry();
  if (dry || !cfg.masterMint || !cfg.keypairPath) {
    log(`dry run: in-memory master token, free play${!dry ? ' (KOTH_MASTER_MINT / KOTH_KEYPAIR not set)' : ''}`);
    chain = new MemoryChain({ name: 'Master Shill', symbol: 'SHILL', uri: `${cfg.publicUrl}/metadata/genesis.json` });
  } else {
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const operator = loadKeypair(cfg.keypairPath);
    chain = new MasterChain(connection, operator, cfg.masterMint, { birdeyeApiKey: cfg.birdeyeApiKey });
    log(`operator ${operator.publicKey.toBase58()} master ${cfg.masterMint.toBase58()} on mainnet`);
    if (cfg.playProgramId) {
      // the hill is built below; the entry reads its inference estimate lazily through this closure
      entry = new Entry({
        connection, operator, masterMint: cfg.masterMint, playProgramId: cfg.playProgramId, cpmmProgramId: cfg.raydiumCpmmProgramId,
        dataDir: cfg.dataDir, zooWallet: cfg.zooWallet, inferencePayMint: cfg.inferencePayMint,
        estimateInferenceUsd: () => hill?.inferenceEstimateUsd() ?? 0.05, log,
      });
      entryLike = entry;
    } else {
      log('KOTH_PLAY_PROGRAM_ID not set: attempts are FREE (deploy koth/program and run scripts/init-play.ts)');
    }
  }

  const uri: UriProvider = cfg.pinataJwt ? new PinataUriProvider(cfg.pinataJwt) : new FileUriProvider(cfg.dataDir, cfg.publicUrl);
  const image = new FileImageProvider(cfg.dataDir, cfg.publicUrl, { python: process.env.KOTH_RENDER_PYTHON === '1' });
  let hill: Hill | undefined;
  hill = new Hill({
    judge, chain, uri, entry: entryLike, store: new FileStore(path.join(cfg.dataDir, 'hill.json')),
    image: (card, reign) => image.image(card, reign), baseFeeSol: cfg.entrySol, feeGrowthPct: cfg.entryGrowthPct, log,
  });
  const commands = new Commands({ hill, entry, dataDir: cfg.dataDir, masterMint: cfg.masterMint?.toBase58() ?? null, explorer, log });

  // the static server for /metadata and /assets (what wallets fetch when they resolve the uri)
  const port = Number(process.env.KOTH_PORT || 8787);
  http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/(metadata|assets)\/([A-Za-z0-9_.-]+)$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    const file = path.join(cfg.dataDir, m[1], m[2]);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const type = file.endsWith('.json') ? 'application/json' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => log(`metadata server on :${port} -> ${cfg.publicUrl}/metadata/king.json`));

  const surfaces: { broadcast(text: string, image?: string | null): Promise<void> }[] = [];
  if (cfg.telegram.token) {
    const tg = new TelegramSurface(commands, { token: cfg.telegram.token, chatId: cfg.telegram.chatId, log });
    surfaces.push(tg); void tg.poll(); log('telegram: polling');
  }
  if (cfg.discord.token) {
    const dc = new DiscordSurface(commands, { token: cfg.discord.token, channelId: cfg.discord.channelId, log });
    surfaces.push(dc); await dc.start();
  }
  if (cfg.x.bearer && cfg.x.apiKey && cfg.x.botUserId) {
    const x = new XSurface(commands, { creds: cfg.x, dataDir: cfg.dataDir, log });
    surfaces.push({ broadcast: (t) => x.post(t).then(() => undefined) }); void x.poll(); log('x: polling mentions');
  }
  if (!surfaces.length) log('no surface credentials set: only the metadata server is running');

  // the master shillbot's cadence: shill the king everywhere, every N hours
  const everyMs = Number(process.env.KOTH_SHILL_EVERY_HOURS || 6) * 3600_000;
  const cadence = async () => {
    const k = hill.king;
    if (!k) return;
    try {
      const p = await chain.profile(k.mint);
      const { cardFromMetrics } = await import('./cards.js');
      const { text } = await hill.masterShill({ card: cardFromMetrics(p.metrics), shill: { mint: k.mint, pitch: k.pitch, author: k.author, surface: k.surface as 'cli' }, offchain: p.offchain });
      for (const s of surfaces) await s.broadcast(`${text}\n\n— the master shillbot, for ${k.name} ($${k.symbol}), reign ${k.reign}`, k.image).catch((e) => log(`broadcast failed: ${e}`));
    } catch (e) { log(`cadence failed: ${e instanceof Error ? e.message : e}`); }
  };
  setInterval(() => void cadence(), everyMs).unref();
  if (process.env.KOTH_SHILL_ON_START === '1') void cadence();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
