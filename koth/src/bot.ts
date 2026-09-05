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
import { Entry, type Quote } from './entry.js';
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
    if (url.pathname === '/' || url.pathname === '/king') {
      // the link-preview page: X / Telegram / Discord unfurl it into the king's card (og:image must be a bitmap)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });
      res.end(kingPage(hill?.king ?? null, cfg.publicUrl, cfg.dataDir, cfg.masterMint?.toBase58() ?? null));
      return;
    }
    const q = url.pathname.match(/^\/q\/([A-Za-z0-9_-]{4,40})$/);
    if (q) {
      const file = path.join(cfg.dataDir, 'quotes', `${q[1]}.json`);
      if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no such quote'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(quotePage(JSON.parse(fs.readFileSync(file, 'utf8')) as Quote));
      return;
    }
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
    const tg = new TelegramSurface(commands, { token: cfg.telegram.token, chatId: cfg.telegram.chatId, dataDir: cfg.dataDir, log });
    surfaces.push(tg); await tg.start(); void tg.poll(); log('telegram: polling');
  }
  if (cfg.discord.token) {
    const dc = new DiscordSurface(commands, { token: cfg.discord.token, channelId: cfg.discord.channelId, log });
    surfaces.push(dc); await dc.start();
  }
  if (cfg.x.apiKey && cfg.x.apiSecret && cfg.x.accessToken && cfg.x.accessSecret) {
    const x = new XSurface(commands, {
      creds: { ...cfg.x }, dataDir: cfg.dataDir, log, publicUrl: cfg.publicUrl, rawAddresses: process.env.X_RAW_ADDRESSES === '1',
      maxChars: Number(process.env.X_MAX_CHARS || 4000), pollMs: Number(process.env.X_POLL_SECONDS || 90) * 1000,
    });
    if (await x.start()) { surfaces.push(x); void x.poll(); log('x: polling mentions'); }
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

/** Minimal HTML whose Open Graph / Twitter Card tags point at the king's PNG, so a link to the game unfurls as the card. */
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** One value with a copy button; the page's script wires the buttons. */
function copyRow(label: string, value: string): string {
  return `<div class="row"><div class="lbl">${escHtml(label)}</div><code>${escHtml(value)}</code><button data-copy="${escHtml(value)}">copy</button></div>`;
}
const PAGE_STYLE = 'body{margin:0;background:#0d0f14;color:#e6e8ec;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{max-width:640px;padding:24px;width:100%;box-sizing:border-box}h1{font-size:22px}.row{display:grid;grid-template-columns:1fr auto;gap:6px 10px;align-items:center;margin:14px 0}.lbl{grid-column:1/-1;opacity:.7;font-size:13px}code{font:15px ui-monospace,monospace;word-break:break-all;background:#151922;padding:10px;border-radius:8px}button{background:#2f80ed;color:#fff;border:0;border-radius:8px;padding:10px 14px;font:600 14px system-ui;cursor:pointer}button.ok{background:#3ab54a}.muted{opacity:.7}';
const COPY_SCRIPT = `<script>for(const b of document.querySelectorAll('[data-copy]'))b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='copied';b.classList.add('ok');setTimeout(()=>{b.textContent='copy';b.classList.remove('ok')},1500)}catch{prompt('copy:',b.dataset.copy)}}</script>`;

/** A quote, with the deposit address and amount as copyable fields: what the X reply links to (it cannot carry the address itself). */
export function quotePage(q: Quote): string {
  const left = Math.max(0, q.expiresAt - Date.now());
  const status = q.status === 'pending' ? (left ? `expires in ${Math.ceil(left / 60_000)} min` : 'expired') : q.status;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>KOTH quote ${escHtml(q.id)}</title><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head>` +
    `<body><main><h1>QUOTE ${escHtml(q.id)} · ${escHtml(q.player)}</h1><p class="muted">${escHtml(status)} · one-time address, never reused, deleted after sweep</p>` +
    copyRow('send exactly this amount', String(q.amountUi)) + copyRow('of this token (mint)', q.mint) + copyRow('to this one-time address', q.depositAddress) +
    `<p>${escHtml(`${q.playFeeSol} SOL stake ≈ $${q.playFeeUsd.toFixed(2)} + inference ≈ $${q.inferenceUsd.toFixed(2)} · +${q.bufferPct}%`)}</p>` +
    `<p>then tell the bot <code>paid ${escHtml(q.id)}</code>. Half becomes liquidity for your coin/MASTER, locked for good.</p></main>${COPY_SCRIPT}</body></html>`;
}

export function kingPage(k: { name: string; symbol: string; image?: string | null; reign: number; pitch?: string; mint?: string } | null, publicUrl: string, dataDir: string, masterMint: string | null = null): string {
  const esc = escHtml;
  const base = publicUrl.replace(/\/+$/, '');
  let image = k?.image ?? null;
  if (image?.endsWith('.svg')) {   // crawlers ignore SVG; use the PNG the provider writes beside it when it exists
    const png = image.replace(/\.svg$/, '.png');
    if (fs.existsSync(path.join(dataDir, 'assets', path.basename(png)))) image = png;
  }
  const title = k ? `${k.name} ($${k.symbol}) is KING OF THE HILL · reign ${k.reign}` : 'KING OF THE HILL · the hill is empty';
  const desc = k ? (k.pitch ?? '').slice(0, 200) || 'Shill your coin. Beat the king. The master token becomes yours.' : 'First to pay takes it. Shill your coin to the bot.';
  const og = [
    ['og:type', 'website'], ['og:title', title], ['og:description', desc], ['og:url', `${base}/king`],
    ...(image ? [['og:image', image], ['twitter:card', 'summary_large_image'], ['twitter:image', image]] : [['twitter:card', 'summary']]),
    ['twitter:title', title], ['twitter:description', desc],
  ].map(([p, c]) => `<meta property="${p}" name="${p}" content="${esc(c)}">`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>\n${og}\n<meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head>` +
    `<body><main style="text-align:center">` +
    (image ? `<img src="${esc(image)}" alt="${esc(title)}" style="max-width:100%;border-radius:16px">` : '') +
    `<h1>${esc(title)}</h1><p>${esc(desc)}</p>` +
    (k?.mint ? copyRow("the king's coin (mint)", k.mint) : '') + (masterMint ? copyRow('the master token (mint)', masterMint) : '') +
    `<p class="muted">Say <code>king</code> to the bot on Telegram or mention it on X.</p></main>${COPY_SCRIPT}</body></html>`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
