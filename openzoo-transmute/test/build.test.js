// build(): layout of <out>/.zoo, cargo handling (missing toolchain path),
// the cost sheet, plus the CLI parser / inspect / help paths. The compiler is
// stubbed with the exact contract lib/compile/index.js implements.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  build, crateNameFor, soNameFor, packageNameOf, fixRuntimePath, findCargoBuildSbf, runCargoBuildSbf,
  estimateCost, formatCostTable, probeConnection, RUNTIME_PATH, INSTALL_HINT, LAMPORTS_PER_BYTE, ACCOUNT_OVERHEAD_BYTES,
} from '../lib/build.js';
import { parseArgs, run, inspectText, USAGE } from '../lib/cli.js';
import { resolveOutDir, isMainnet, clusterLabel, programKeypairFor } from '../lib/deploy.js';
import { readDeployment } from '../lib/vercel.js';
import { ASSET_FIXED_HEADER } from '../lib/wire.js';

const SCRATCH = process.env.CLAUDE_SCRATCHPAD || fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-build-'));
const SAMPLE = '/tmp/claude-0/-home-user-leCore/a19c7b90-72f9-553d-88b5-6caf858df17b/scratchpad/sample-site';

/** A tiny Next.js-shaped repo: one pages/api handler, one app-router route, two public files. */
function makeFixture(name = 'fixture-app') {
  const root = fs.mkdtempSync(path.join(SCRATCH, name + '-'));
  const w = (rel, s) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  w('package.json', JSON.stringify({ name: 'fixture-app', dependencies: { next: '14.2.0' } }));
  w('pages/api/hello.js', "export default function handler(req, res) { res.status(200).json({ hello: req.query.name || 'world', n: Number(req.query.n) * 2 }) }\n");
  w('app/api/counter/route.js', "export async function POST() { const n = await kv.incr('hits'); return Response.json({ hits: n }) }\nexport const maxDuration = 5;\n");
  w('app/api/stream/route.ts', "export const runtime = 'edge';\nexport async function GET() { return new Response('x') }\n");
  w('public/index.html', '<!doctype html><h1>fixture</h1>');
  w('public/app.js', 'console.log("hi")');
  w('.env.production', 'GREETING=hi\n');
  return root;
}

/** The compiler contract, answered with the hand-written sample crate. */
function stubTransmute(calls = []) {
  return async (deployment, opts) => {
    calls.push({ deployment, opts });
    const lib = fs.existsSync(path.join(SAMPLE, 'src/lib.rs')) ? fs.readFileSync(path.join(SAMPLE, 'src/lib.rs'), 'utf8') : '#![no_std]\n';
    const eligible = deployment.functions.filter((f) => !f.isEdge);
    const ineligible = deployment.functions.filter((f) => f.isEdge).map((f) => ({ name: f.name, reason: 'edge runtime is not supported', file: f.sourceFile, line: 1 }));
    return {
      crate: {
        'Cargo.toml': `[package]\nname = "${opts.name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib", "lib"]\n\n[dependencies]\npinocchio = "0.11.2"\nzoo-host = { path = "PLACEHOLDER/zoo-host" }\n\n[profile.release]\noverflow-checks = false\nlto = "fat"\ncodegen-units = 1\nopt-level = 3\n`,
        'src/lib.rs': lib,
      },
      manifest: {
        version: 1, framework: deployment.framework,
        routes: eligible.map((f, i) => ({ index: i, name: f.name, routePath: f.routePath, pattern: f.pattern, params: f.params, methods: f.methods, style: f.style, kv: f.name.includes('counter') ? ['hits'] : [] })),
        static: deployment.staticFiles.map((s) => ({ path: s.path, contentType: s.contentType, size: s.size })),
        env: [...new Set(deployment.functions.flatMap((f) => Object.keys(f.environment || {})))],
        config: deployment.config,
      },
      report: { eligible: eligible.map((f) => f.name), ineligible, warnings: ['stubbed compiler'] },
    };
  };
}

test('naming helpers', () => {
  assert.equal(crateNameFor('/x/My App.v2'), 'my-app-v2');
  assert.equal(crateNameFor('/x/123'), 'site-123');
  assert.equal(crateNameFor('/x/foo', 'Bar_Baz'), 'bar_baz');
  assert.equal(soNameFor('my-app'), 'my_app.so');
  assert.equal(packageNameOf('[package]\nname = "abc"\nversion="1"\n[lib]\nname = "zzz"', 'f'), 'abc');
  assert.equal(packageNameOf('nothing', 'f'), 'f');
  const fixed = fixRuntimePath('[dependencies]\nzoo-host = { path = "PLACEHOLDER/zoo-host" }\n', RUNTIME_PATH);
  assert.match(fixed, new RegExp(`path = "${RUNTIME_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(fixRuntimePath(`zoo-host = { path = "${RUNTIME_PATH}" }`, '/elsewhere'), `zoo-host = { path = "${RUNTIME_PATH}" }`, 'an existing absolute path is left alone');
  assert.match(fixRuntimePath('[dependencies]\npinocchio = "0.11"\n', '/rt'), /\[dependencies\.zoo-host\]\npath = "\/rt"/);
});

test('build: writes .zoo/{crate,manifest,report,static-plan,build} with --skip-cargo and prints the cost sheet', async () => {
  const root = makeFixture();
  const out = path.join(root, 'dist-out');
  const logs = [];
  const calls = [];
  const r = await build(root, { out, skipCargo: true, transmute: stubTransmute(calls), connection: null, log: (s) => logs.push(String(s)) });
  assert.equal(r.outDir, out);
  assert.equal(r.soPath, null);
  assert.equal(r.arch, 'v0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.name, path.basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'));
  assert.equal(calls[0].opts.runtimePath, RUNTIME_PATH);
  for (const f of ['crate/Cargo.toml', 'crate/src/lib.rs', 'manifest.json', 'report.json', 'static-plan.json', 'build.json']) assert.ok(fs.existsSync(path.join(out, '.zoo', f)), f);
  const cargo = fs.readFileSync(path.join(out, '.zoo/crate/Cargo.toml'), 'utf8');
  assert.match(cargo, new RegExp(`zoo-host = \\{ path = "${RUNTIME_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" \\}`), 'runtime path patched into the generated Cargo.toml');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, '.zoo/manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.framework, 'nextjs');
  assert.equal(manifest.routes.length, 2, 'edge route is ineligible and not in the manifest');
  assert.deepEqual(manifest.routes.map((x) => x.routePath), ['/api/hello', '/api/counter']);
  assert.deepEqual(manifest.routes[1].methods, ['POST']);
  assert.deepEqual(manifest.static.map((s) => s.path).sort(), ['/app.js', '/index.html']);
  assert.deepEqual(manifest.env, ['GREETING']);
  assert.ok(manifest.config.routes.some((x) => x.handle === 'filesystem'));
  const report = JSON.parse(fs.readFileSync(path.join(out, '.zoo/report.json'), 'utf8'));
  assert.equal(report.ineligible.length, 1);
  assert.equal(report.ineligible[0].name, 'api/stream');
  const plan = JSON.parse(fs.readFileSync(path.join(out, '.zoo/static-plan.json'), 'utf8'));
  assert.equal(plan.length, 2);
  for (const p of plan) { assert.ok(fs.existsSync(p.file), 'plan carries the source file path'); assert.equal(p.size, fs.statSync(p.file).size); }
  const info = JSON.parse(fs.readFileSync(path.join(out, '.zoo/build.json'), 'utf8'));
  assert.equal(info.arch, 'v0');
  assert.equal(info.soPath, null);
  assert.deepEqual(info.cargo, { skipped: true });
  assert.equal(info.soName, soNameFor(info.crateName));
  // cost sheet
  assert.equal(r.costEstimate.source, 'rule-of-thumb');
  assert.ok(r.costEstimate.unknownProgram);
  const idx = r.costEstimate.items.find((i) => i.label === '/index.html');
  const ct = 'text/html; charset=utf-8';
  assert.equal(idx.bytes, ASSET_FIXED_HEADER + ct.length + fs.statSync(path.join(root, 'public/index.html')).size);
  assert.equal(idx.lamports, (ACCOUNT_OVERHEAD_BYTES + idx.bytes) * LAMPORTS_PER_BYTE);
  const text = logs.join('\n');
  assert.match(text, /TOTAL/);
  assert.match(text, /\/index\.html/);
  assert.match(text, /rule of thumb/);
  assert.match(text, /no --arch given/);
  assert.match(text, /1 ineligible/);
  assert.match(text, /api\/stream: edge runtime/);
  assert.ok(r.notes.some((n) => /skipped/.test(n)));
  assert.equal(resolveOutDir(out), out);
  assert.equal(resolveOutDir(path.join(out, '.zoo')), out, 'the .zoo dir itself resolves to its parent');
  assert.throws(() => resolveOutDir(root), /run `openzoo-transmute build` first/);
  const kp = programKeypairFor(path.join(out, '.zoo'));
  assert.ok(kp.created);
  assert.equal(programKeypairFor(path.join(out, '.zoo')).keypair.publicKey.toBase58(), kp.keypair.publicKey.toBase58(), 'program keypair is stable across runs');
});

test('build: missing cargo-build-sbf prints the install one-liner and continues without a .so', async () => {
  const root = makeFixture();
  const logs = [];
  const env = { ...process.env, PATH: '/nonexistent-bin' };
  assert.equal(findCargoBuildSbf(env), null);
  const r = await build(root, { transmute: stubTransmute(), connection: null, env, log: (s) => logs.push(String(s)) });
  assert.equal(r.soPath, null);
  assert.equal(r.outDir, path.join(root, '.zoo-out'), 'default out dir');
  const text = logs.join('\n');
  assert.match(text, /cargo-build-sbf not found/);
  assert.ok(text.includes(INSTALL_HINT), 'install hint printed');
  assert.ok(r.notes.some((n) => n.includes(INSTALL_HINT)));
  const info = JSON.parse(fs.readFileSync(path.join(root, '.zoo-out/.zoo/build.json'), 'utf8'));
  assert.deepEqual(info.cargo, { ok: false, missing: true });
  // A bogus cargo binary (ENOENT on spawn) is reported the same way.
  const r2 = await runCargoBuildSbf(path.join(root, '.zoo-out/.zoo/crate'), { cargo: 'definitely-not-cargo-xyz', log: () => {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.missing, true);
  assert.equal(r2.soPath, null);
  await assert.rejects(runCargoBuildSbf(root, { arch: 'v9', log: () => {} }), /unknown --arch v9/);
});

test('build: transmute contract violations fail loudly', async () => {
  const root = makeFixture();
  await assert.rejects(build(root, { transmute: async () => ({ manifest: {} }), connection: null, skipCargo: true, log: () => {} }), /returned no crate/);
  await assert.rejects(build(path.join(root, 'does-not-exist'), { transmute: stubTransmute(), connection: null, skipCargo: true, log: () => {} }), /no such directory/);
});

test('estimateCost: rpc rent when a cluster is reachable, formatted table', async () => {
  const connection = await probeConnection('localnet', { timeoutMs: 2000 });
  const est = await estimateCost({ staticFiles: [{ path: '/a.html', size: 1000, contentType: 'text/html' }], soSize: 100_000, manifestBytes: 500, connection });
  assert.ok(est.items.some((i) => /program data/.test(i.label)));
  assert.equal(est.items.find((i) => /program data/.test(i.label)).bytes, 45 + 200_000);
  assert.equal(est.items.find((i) => i.label === 'program account').bytes, 36);
  assert.ok(est.sol > 1 && est.sol < 3, `2×100KB program ≈ 1.4 SOL, got ${est.sol}`);
  assert.ok(est.totalSol > est.sol, 'fees added');
  if (connection) {
    assert.equal(est.source, 'rpc');
    const a = est.items.find((i) => i.label === '/a.html');
    assert.equal(a.lamports, await connection.getMinimumBalanceForRentExemption(a.bytes));
  } else assert.equal(est.source, 'rule-of-thumb');
  const up = await estimateCost({ staticFiles: [], soSize: 100_000, manifestBytes: 10, connection: null, upgrade: true });
  assert.ok(up.transientLamports > 0 && up.items[0].transient);
  const table = formatCostTable(est);
  assert.match(table, /item\s+bytes\s+SOL/);
  assert.match(table, /TOTAL/);
  assert.match(table, /\/a\.html/);
  const many = await estimateCost({ staticFiles: Array.from({ length: 60 }, (_, i) => ({ path: `/f${i}.js`, size: 10 })), soSize: 10, connection: null });
  assert.match(formatCostTable(many), /… \d+ more files/);
});

test('deploy helpers: mainnet detection and cluster labels', () => {
  assert.equal(isMainnet('mainnet'), true);
  assert.equal(isMainnet('mainnet-beta'), true);
  assert.equal(isMainnet(undefined, 'https://api.mainnet-beta.solana.com'), true);
  assert.equal(isMainnet('devnet'), false);
  assert.equal(isMainnet('localnet'), false);
  assert.equal(isMainnet('http://127.0.0.1:8899'), false);
  assert.equal(isMainnet('https://api.devnet.solana.com'), false);
  assert.equal(isMainnet('https://eu.fluxrpc.com?key=x'), true);
  assert.equal(clusterLabel('http://127.0.0.1:8899'), 'localnet');
  assert.equal(clusterLabel('devnet'), 'devnet');
});

test('cli: parseArgs', () => {
  const a = parseArgs(['deploy', 'out', '--cluster', 'devnet', '--yes', '--program=Abc', '--concurrency', '2', '--no-color']);
  assert.equal(a.cmd, 'deploy');
  assert.deepEqual(a.positionals, ['out']);
  assert.equal(a.flags.cluster, 'devnet');
  assert.equal(a.flags.yes, true);
  assert.equal(a.flags.program, 'Abc');
  assert.equal(a.flags.concurrency, '2');
  assert.equal(a.flags.color, false);
  const b = parseArgs(['build', '--skip-cargo', 'dir', '--arch', 'v3']);
  assert.equal(b.flags.skipCargo, true);
  assert.equal(b.flags['skip-cargo'], true);
  assert.deepEqual(b.positionals, ['dir']);
  assert.equal(b.flags.arch, 'v3');
  assert.equal(parseArgs([]).cmd, 'help');
  assert.equal(parseArgs(['-h']).flags.help, true);
});

test('cli: help / unknown / inspect / status argument errors', async () => {
  const out = [], err = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
  assert.equal(await run(['help'], io), 0);
  assert.equal(out.at(-1), USAGE);
  assert.equal(await run(['bogus'], io), 1);
  assert.match(err.join('\n'), /unknown command: bogus/);
  process.exitCode = 0;
  assert.equal(await run(['status'], io), 1);
  assert.match(err.at(-1), /usage: status/);
  process.exitCode = 0;
  const root = makeFixture();
  out.length = 0;
  assert.equal(await run(['inspect', root], io), 0);
  const text = out.join('\n');
  assert.match(text, /source: nextjs/);
  assert.match(text, /\/api\/hello\s+pages\s+nodejs20\.x\s+10s\s+1024MB\s+any/);
  assert.match(text, /\/api\/counter\s+app\s+nodejs20\.x\s+5s\s+1024MB\s+POST/);
  assert.match(text, /\/api\/stream\s+app\s+edge/);
  assert.match(text, /static files \(2/);
  assert.match(text, /\/index\.html/);
  assert.match(text, /\[handle: filesystem\]/);
  const dep = readDeployment(root);
  const withReport = inspectText(dep, { eligible: ['api/hello'], ineligible: [{ name: 'api/stream', reason: 'edge', line: 3 }], warnings: ['w'] });
  assert.match(withReport, /✓ \/api\/hello/);
  assert.match(withReport, /✗ \/api\/stream/);
  assert.match(withReport, /ineligible: edge \(line 3\)/);
  assert.match(withReport, /1 eligible, 1 ineligible, 1 warning/);
  out.length = 0;
  assert.equal(await run(['inspect', root, '--json'], io), 0);
  const j = JSON.parse(out.join('\n'));
  assert.equal(j.functions.length, 3);
  assert.equal(await run(['deploy', root, '--cluster', 'localnet'], io), 1, 'deploy without a build fails clearly');
  assert.match(err.at(-1), /run `openzoo-transmute build` first/);
  process.exitCode = 0;
});
