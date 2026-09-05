// Transmuter tests: parsing, lowering, codegen, a real `cargo build-sbf`, and
// an end-to-end run against a local validator (skipped when unavailable).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDeployment, readVercelNode } from '../lib/vercel.js';
import { transmute, compileFunction, writeCrate, stripTypes, readModule, DEFAULT_RUNTIME_PATH } from '../lib/compile/index.js';
import { Ineligible, bindImport, functionMetaReason } from '../lib/eligibility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'next-app');
const SOLANA_BIN = '/root/.local/share/solana/install/active_release/bin';
const PATH_WITH_SOLANA = `${SOLANA_BIN}:${process.env.PATH || ''}`;
const RPC = process.env.OPENZOO_TEST_RPC || 'http://127.0.0.1:8899';

/** The fixture as Vercel sees it: Next.js pages/app routes plus the top-level api/ functions (@vercel/node). */
function fixtureDeployment() {
  const dep = readDeployment(FIXTURE);
  for (const f of readVercelNode(FIXTURE).functions) if (!dep.functions.some((g) => g.name === f.name)) dep.functions.push(f);
  return dep;
}

const fn = (name, src, extra = {}) => ({ name, routePath: '/' + name, pattern: `^/${name}$`, params: [], style: 'pages', sourceFile: `${name}.js`, environment: {}, ...extra });
const compile = (src, extra = {}) => compileFunction(fn(extra.name || 'api/t', src, extra), src, { index: extra.index ?? 0 });

// ---------------------------------------------------------------- parsing & detection

describe('parse: route detection', () => {
  test('readDeployment finds the pages, app and api routes of the fixture', () => {
    const dep = fixtureDeployment();
    const byName = Object.fromEntries(dep.functions.map((f) => [f.name, f]));
    assert.equal(dep.framework, 'nextjs');
    assert.ok(byName['api/hello'] && byName['api/hello'].style === 'pages');
    assert.equal(byName['api/users/[id]'].routePath, '/api/users/[id]');
    assert.deepEqual(byName['api/users/[id]'].params, ['id']);
    assert.match('/api/users/7', new RegExp(byName['api/users/[id]'].pattern));
    assert.equal(byName['api/counter'].style, 'app');
    assert.deepEqual([...byName['api/counter'].methods].sort(), ['GET', 'POST']);
    assert.equal(byName['api/counter'].runtime, 'edge');
    assert.equal(byName['api/echo'].style, 'app');
    assert.equal(byName['api/time'].style, 'vercel-node');
    assert.equal(byName['api/bad-fetch'].style, 'vercel-node');
    assert.equal(byName['api/hello'].environment.ZOO_NAME, 'fixture');
    assert.deepEqual(dep.staticFiles.map((s) => s.path).sort(), ['/app.js', '/index.html']);
  });

  test('readModule: ESM default export, named methods, CommonJS, wrapped handlers', () => {
    const esm = readModule(`import { kv } from '@vercel/kv';\nexport default async function handler(req, res) { res.json({}) }`, { file: 'a.js' });
    assert.equal(esm.kind, 'esm');
    assert.ok(esm.handlers.default);
    assert.deepEqual(esm.imports, [{ source: '@vercel/kv', specifiers: [{ local: 'kv', imported: 'kv' }], line: 1 }]);
    const app = readModule(`export const GET = async () => Response.json({});\nasync function post(r) {}\nexport { post as POST };\nexport const revalidate = 60;`, { file: 'route.js' });
    assert.deepEqual(Object.keys(app.handlers.methods).sort(), ['GET', 'POST']);
    assert.equal(app.meta.revalidate, 60);
    const cjs = readModule(`const { kv } = require('@vercel/kv');\nmodule.exports = (req, res) => res.json({});`, { file: 'c.js' });
    assert.equal(cjs.kind, 'cjs');
    assert.ok(cjs.handlers.default);
    assert.equal(cjs.imports[0].source, '@vercel/kv');
    const wrapped = compile(`import { withAuth } from 'next-auth';\nexport default withAuth((req, res) => res.json({}))`);
    assert.equal(wrapped.eligible, false);
    assert.match(wrapped.reason, /next-auth/);
  });

  test('stripTypes removes TypeScript syntax and preserves line numbers', () => {
    const src = `import type { A } from 'x';\nimport { NextResponse, type NextRequest } from 'next/server';\ninterface Foo { a: number; b?: string }\ntype Bar = { x: 1 } | null;\nexport async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {\n  const n = (await get<number>('k')) as number;\n  const f = (a: number, b?: string): number => a + (b ? 1 : 0);\n  const x: string[] = [];\n  return NextResponse.json({ n, y: params!.id } satisfies object, { status: 200 });\n}\nfunction get<T>(k: string): T | undefined { return undefined; }\n`;
    const out = stripTypes(src);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.doesNotMatch(out, /interface|NextRequest|Promise<|satisfies|: number|as number|<number>|type Bar/);
    assert.match(out, /export async function GET\(request\s*,\s*\{ params \}\s*\)\s*\{/);
    assert.match(out, /b \? 1 : 0/);
    assert.ok(out.includes("import { NextResponse,") && !out.includes('type NextRequest'));
    const mod = readModule(src, { file: 'route.ts' });
    assert.deepEqual(Object.keys(mod.handlers.methods), ['GET']);
  });

  test('parse errors are reported as ineligible with a line', () => {
    const r = compile(`export default function handler(req, res) {\n  res.json({ a: });\n}`);
    assert.equal(r.eligible, false);
    assert.match(r.reason, /parse error/);
    assert.equal(r.line, 2);
  });
});

// ---------------------------------------------------------------- lowering / codegen

describe('compileFunction: eligible handlers', () => {
  test('pages/api handler: req.query, res.status().json() chain, helpers, callbacks', () => {
    const r = compile(`function pick(x) { return x || 'd'; }\nexport default function handler(req, res) {\n  const { name = 'w' } = req.query;\n  const n = Number(req.query.n) * 2;\n  const up = [name].map((s) => s.toUpperCase());\n  return res.status(200).json({ name, n, up, m: req.method, url: req.url, p: pick(req.query.p) });\n}`);
    assert.equal(r.eligible, true, r.reason);
    assert.equal(r.style, 'node');
    assert.match(r.rust, /fn route_0\(cx: &mut Ctx\) -> Result<\(\), Val>/);
    assert.match(r.rust, /cx\.res_status\(/);
    assert.match(r.rust, /cx\.res_json\(/);
    assert.match(r.rust, /__zoo_query\(cx, PARAMS_0\)/);
    assert.match(r.rust, /zv::global_call\("Number"/);
    assert.match(r.rust, /\.call\("map", &__a, Some\(&mut __f/);
    assert.match(r.rust, /fn h_0_pick\(cx: &mut Ctx, __args: &\[Val\]\) -> Result<Val, Val>/);
    assert.match(r.rust, /return Ok\(\(\)\);/);
  });

  test('dynamic segments: params.id and req.query.id come from the x-zoo-param-* headers', () => {
    const pages = compile(`export default (req, res) => res.json({ id: req.query.id })`, { name: 'api/users/[id]', params: ['id'], sourceFile: 'pages/api/users/[id].js' });
    assert.equal(pages.eligible, true, pages.reason);
    assert.match(pages.rust, /const PARAMS_0: &\[\(&str, bool\)\] = &\[\("id", false\)\];/);
    assert.match(pages.rust, /__zoo_query\(cx, PARAMS_0\)/);
    const app = compile(`export async function GET(request, { params }) { const { id } = await params; return Response.json({ id, all: params }) }`, { name: 'api/items/[id]', style: 'app', params: ['id'], sourceFile: 'app/api/items/[id]/route.js' });
    assert.equal(app.eligible, true, app.reason);
    assert.match(app.rust, /__zoo_param\(cx, "id", false\)/);
    assert.match(app.rust, /__zoo_params\(cx, PARAMS_0\)/);
    const catchAll = compile(`export function GET(req, ctx) { return Response.json({ s: ctx.params.slug }) }`, { name: 'api/docs/[...slug]', routePath: '/api/docs/[...slug]', style: 'app', params: ['slug'], sourceFile: 'app/api/docs/[...slug]/route.js' });
    assert.equal(catchAll.eligible, true, catchAll.reason);
    assert.match(catchAll.rust, /__zoo_param\(cx, "slug", true\)/);
  });

  test('app router: method dispatch, Response.json / NextResponse / new Response / redirect', () => {
    const r = compile(`import { NextResponse } from 'next/server';\nexport async function GET(request) {\n  const { searchParams } = new URL(request.url);\n  const q = searchParams.get('q');\n  if (!q) return NextResponse.redirect(new URL('/login', request.url), 307);\n  return NextResponse.json({ q, m: request.method, h: request.headers.get('x-a') }, { status: 200, headers: { 'x-b': '1' } });\n}\nexport async function POST(request) {\n  const body = await request.json();\n  const text = await request.text();\n  return new Response(JSON.stringify(body), { status: 201 });\n}`, { style: 'app', sourceFile: 'app/api/x/route.js' });
    assert.equal(r.eligible, true, r.reason);
    assert.equal(r.style, 'web');
    assert.deepEqual(r.methods, ['GET', 'POST']);
    assert.match(r.rust, /match __m\.as_str\(\) \{/);
    assert.match(r.rust, /Some\("GET"\) => route_0_get\(cx\)/);
    assert.match(r.rust, /Some\("HEAD"\) => route_0_get\(cx\)/);
    assert.match(r.rust, /405\.0/);
    assert.match(r.rust, /"GET, POST, HEAD, OPTIONS"/);
    assert.match(r.rust, /cx\.req_query_get\(/);
    assert.match(r.rust, /__zoo_resp\("redirect"/);
    assert.match(r.rust, /__zoo_resp\("json"/);
    assert.match(r.rust, /__zoo_resp\("raw"/);
    assert.match(r.rust, /cx\.req_json\(\)\?/);
    assert.match(r.rust, /cx\.req_text\(\)/);
    assert.match(r.rust, /__zoo_send\(cx, &__rv\)\?/);
  });

  test('@vercel/kv maps to cx.kv_* with ? propagation and flags the route', () => {
    const r = compile(`import { kv } from '@vercel/kv';\nexport async function POST() {\n  const n = await kv.incr('hits');\n  await kv.set('last', { n });\n  const last = await kv.get('last');\n  const e = await kv.exists('hits');\n  await kv.del('tmp');\n  await kv.decrby('hits', 2);\n  return Response.json({ n, last, e });\n}`, { style: 'app', sourceFile: 'app/api/c/route.js' });
    assert.equal(r.eligible, true, r.reason);
    assert.equal(r.kv, true);
    assert.match(r.rust, /cx\.kv_incrby\(&__a\d+, &__a\d+\)\?/);
    assert.match(r.rust, /cx\.kv_set\(/);
    assert.match(r.rust, /cx\.kv_get\(/);
    assert.match(r.rust, /cx\.kv_exists\(/);
    assert.match(r.rust, /cx\.kv_del\(/);
    const client = compile(`import { createClient } from '@vercel/kv';\nconst store = createClient({ url: process.env.KV_URL, token: process.env.KV_TOKEN });\nexport default async (req, res) => res.json({ v: await store.get('k') })`);
    assert.equal(client.eligible, true, client.reason);
    assert.equal(client.kv, true);
  });

  test('TypeScript route file compiles', () => {
    const r = compile(`import { kv } from '@vercel/kv';\nimport type { NextRequest } from 'next/server';\nconst KEY: string = 'hits';\nexport async function GET(req: NextRequest): Promise<Response> {\n  const hits = (await kv.get<number>(KEY)) ?? 0;\n  return Response.json({ hits } as { hits: number });\n}`, { style: 'app', sourceFile: 'app/api/c/route.ts' });
    assert.equal(r.eligible, true, r.reason);
    assert.match(r.rust, /fn c_0_KEY\(cx: &mut Ctx\) -> Result<Val, Val>/);
  });

  test('process.env, Date, Math, JSON, Object, console, template literals, control flow', () => {
    const r = compile(`export default function handler(req, res) {\n  const site = process.env.SITE_NAME || 'x';\n  const t = Date.now();\n  const iso = new Date().toISOString();\n  let s = 0;\n  for (let i = 0; i < 3; i++) { if (i === 1) continue; s += i; }\n  while (s > 100) { s -= 1; break; }\n  const o = { a: 1, ...{ b: 2 } };\n  for (const k in o) s += o[k];\n  switch (req.query.k) { case 'a': s = 1; break; default: s = 2; }\n  const keys = Object.keys(o).filter((k) => k !== 'a');\n  console.log('hi', o);\n  res.status(200).json({ site, t, iso, s, keys, r: Math.round(1.5), j: JSON.parse('{"x":1}').x, tpl: \`s=\${s}\` });\n}`);
    assert.equal(r.eligible, true, r.reason);
    assert.deepEqual(r.env, ['SITE_NAME']);
    assert.match(r.rust, /cx\.env\(&__a\d+\)/);
    assert.match(r.rust, /cx\.now_ms\(\)/);
    assert.match(r.rust, /cx\.now_iso\(\)/);
    assert.match(r.rust, /zv::math\("round"/);
    assert.match(r.rust, /zjson::parse\(/);
    assert.match(r.rust, /__zoo_log\(cx/);
    assert.match(r.rust, /'l\d+: loop \{/);
  });

  test('try/catch/finally with returns, throw, local closures and array-callback mutation', () => {
    const r = compile(`export default function handler(req, res) {\n  let total = 0;\n  const base = 10;\n  const addBase = (x) => x + base;\n  [1, 2].forEach((x) => { total += addBase(x); });\n  try {\n    if (!req.query.ok) throw new Error('nope');\n    return res.status(200).json({ total });\n  } catch (e) {\n    return res.status(400).json({ error: e.message });\n  } finally {\n    res.setHeader('x-total', String(total));\n  }\n}`);
    assert.equal(r.eligible, true, r.reason);
    assert.match(r.rust, /Result<Option<Val>, Val>/);
    assert.match(r.rust, /return Ok\(Some\(Val::Undef\)\);/);
    assert.match(r.rust, /return Err\(/);
    assert.match(r.rust, /move \|cx: &mut Ctx, __args: &\[Val\]\|/);
  });
});

describe('compileFunction: ineligible handlers report a reason with file:line', () => {
  const cases = [
    ['fetch', `export default async (req, res) => { const r = await fetch('https://x'); res.json(await r.json()) }`, /fetch\(\): network access/],
    ['Math.random', `export default (req, res) => res.json({ r: Math.random() })`, /nondeterministic/],
    ['regex literal', `export default (req, res) => res.json({ r: /a+/.test('aa') })`, /regular expressions/],
    ['class', `class A {}\nexport default (req, res) => res.json({ a: new A() })`, /classes are not supported/],
    ['generator', `export default (req, res) => { function* g() { yield 1 } g(); res.json({}) }`, /generator/],
    ['node import', `import fs from 'node:fs';\nexport default (req, res) => res.json({ f: fs.readFileSync('x') })`, /Node built-in/],
    ['unknown package', `import dayjs from 'dayjs';\nexport default (req, res) => res.json({ d: dayjs() })`, /import of `dayjs`/],
    ['local import', `import { db } from '../lib/db';\nexport default (req, res) => res.json({ db })`, /local module/],
    ['require', `export default (req, res) => { const p = require('path'); res.json({ p }) }`, /require\(\)/],
    ['setTimeout', `export default (req, res) => { setTimeout(() => res.json({}), 1) }`, /timers/],
    ['res.write streaming', `export default (req, res) => { res.write('x'); res.end() }`, /streaming/],
    ['kv unsupported method', `import { kv } from '@vercel/kv';\nexport default async (req, res) => res.json({ v: await kv.hgetall('h') })`, /kv\.hgetall\(\)/],
    ['waitUntil', `import { waitUntil } from '@vercel/functions';\nexport default (req, res) => { waitUntil(Promise.resolve()); res.json({}) }`, /@vercel\/functions/],
    ['closure mutating capture', `export default (req, res) => { let n = 0; const inc = () => { n++ }; inc(); res.json({ n }) }`, /mutates captured variable `n`/],
    ['break across try', `export default (req, res) => { for (const x of [1]) { try { break } catch (e) {} } res.json({}) }`, /break cannot cross a try/],
    ['unknown identifier', `export default (req, res) => res.json({ x: nothingHere })`, /unknown identifier `nothingHere`/],
    ['module state mutation', `let count = 0;\nexport default (req, res) => { count++; res.json({ count }) }`, /module-level `count`/],
    ['no handler', `export const config = { runtime: 'edge' };`, /no handler export/],
    ['new Date(value)', `export default (req, res) => res.json({ d: new Date('2020-01-01').getFullYear() })`, /new Date\(value\)/],
    ['request.formData', `export async function POST(request) { const f = await request.formData(); return Response.json({}) }`, /formData/],
    ['unsupported runtime method', `export default (req, res) => res.json({ v: 'abc'.localeCompare('b') })`, /\.localeCompare\(\) is not implemented/],
    ['enum in ts', `enum E { A }\nexport default (req, res) => res.json({ e: E.A })`, /enum/],
  ];
  for (const [label, src, re] of cases) {
    test(label, () => {
      const isTs = label.includes('ts');
      const r = compile(src, isTs ? { sourceFile: 'api/t.ts' } : {});
      assert.equal(r.eligible, false, `expected ineligible: ${label}`);
      assert.match(r.reason, re);
      assert.ok(r.file, 'file is reported');
      assert.ok(Number.isInteger(r.line) && r.line >= 1, `line is reported (${r.line})`);
    });
  }

  test('functionMetaReason and bindImport', () => {
    assert.match(functionMetaReason({ middleware: true, sourceFile: 'm.js' }), /middleware/);
    assert.match(functionMetaReason({ supportsResponseStreaming: true, sourceFile: 'm.js' }), /streaming/);
    assert.match(functionMetaReason({ prerender: {}, sourceFile: 'm.js' }), /ISR/);
    assert.equal(functionMetaReason({ sourceFile: 'm.js', runtime: 'edge' }), null);
    assert.throws(() => bindImport('next/server', [{ local: 'after', imported: 'after' }], {}), Ineligible);
    assert.deepEqual(bindImport('@vercel/kv', [{ local: 'store', imported: 'kv' }], {})[0], { local: 'store', imported: 'kv', special: { t: 'Kv' } });
  });
});

// ---------------------------------------------------------------- transmute + build + e2e

const state = { out: null, crateDir: null, so: null, programId: null };

describe('transmute the fixture app', () => {
  test('report, manifest and crate', () => {
    const dep = fixtureDeployment();
    const out = transmute(dep, { name: 'zoo-fixture' });
    state.out = out;
    assert.deepEqual(out.report.eligible, ['api/hello', 'api/users/[id]', 'api/counter', 'api/echo', 'api/time']);
    assert.equal(out.report.ineligible.length, 1);
    const bad = out.report.ineligible[0];
    assert.equal(bad.name, 'api/bad-fetch');
    assert.match(bad.reason, /fetch\(\): network access/);
    assert.equal(bad.file, 'api/bad-fetch.js');
    assert.equal(bad.line, 3);
    assert.ok(out.report.warnings.some((w) => /baked into the program/.test(w)));
    // manifest
    const m = out.manifest;
    assert.equal(m.version, 1);
    assert.equal(m.framework, 'nextjs');
    assert.deepEqual(m.routes.map((r) => r.index), [0, 1, 2, 3, 4]);
    const byName = Object.fromEntries(m.routes.map((r) => [r.name, r]));
    assert.equal(byName['api/hello'].style, 'pages');
    assert.equal(byName['api/hello'].methods, null);
    assert.deepEqual(byName['api/users/[id]'].params, ['id']);
    assert.equal(byName['api/counter'].style, 'app');
    assert.equal(byName['api/counter'].kv, true);
    assert.deepEqual(byName['api/counter'].methods, ['GET', 'POST']);
    assert.equal(byName['api/echo'].kv, false);
    assert.equal(byName['api/time'].style, 'vercel-node');
    assert.deepEqual(m.env, ['ZOO_NAME']);
    assert.deepEqual(m.static.map((s) => s.path).sort(), ['/app.js', '/index.html']);
    assert.ok(m.static.every((s) => s.contentType && s.size > 0));
    assert.equal(m.config.version, 3);
    // crate
    assert.match(out.crate['Cargo.toml'], /name = "zoo_fixture"/);
    assert.match(out.crate['Cargo.toml'], /crate-type = \["cdylib", "lib"\]/);
    assert.match(out.crate['Cargo.toml'], /lto = "fat"/);
    assert.ok(out.crate['Cargo.toml'].includes(`zoo-host = { path = ${JSON.stringify(DEFAULT_RUNTIME_PATH)} }`));
    assert.ok(path.isAbsolute(DEFAULT_RUNTIME_PATH) && fs.existsSync(path.join(DEFAULT_RUNTIME_PATH, 'Cargo.toml')));
    const lib = out.crate['src/lib.rs'];
    assert.match(lib, /#!\[no_std\]/);
    assert.match(lib, /pinocchio::program_entrypoint!\(process_instruction\);/);
    assert.match(lib, /pinocchio::default_allocator!\(\);/);
    assert.match(lib, /pinocchio::nostd_panic_handler!\(\);/);
    assert.match(lib, /const ENV: &\[\(&str, &str\)\] = &\[\("ZOO_NAME", "fixture"\)\];/);
    assert.doesNotMatch(lib, /UNUSED_SECRET/);
    assert.match(lib, /const ROUTES: &\[Route\] = &\[route_0, route_1, route_2, route_3, route_4\];/);
    for (let i = 0; i < 5; i++) assert.match(lib, new RegExp(`fn route_${i}\\(cx: &mut Ctx\\) -> Result<\\(\\), Val>`));
  });
});

describe('cargo build-sbf', () => {
  test('the generated crate builds for the local validator (--arch v3)', (t) => {
    const which = spawnSync('cargo-build-sbf', ['--version'], { env: { ...process.env, PATH: PATH_WITH_SOLANA }, encoding: 'utf8' });
    if (which.error || which.status !== 0) {
      t.skip('cargo-build-sbf is not installed (expected in ' + SOLANA_BIN + '); install the Solana platform tools to run the build test');
      return;
    }
    assert.ok(state.out, 'transmute ran');
    const crateDir = path.join(os.tmpdir(), 'openzoo-transmute-test', 'fixture-crate');
    fs.rmSync(path.join(crateDir, 'src'), { recursive: true, force: true });
    writeCrate(state.out.crate, crateDir);
    state.crateDir = crateDir;
    const res = spawnSync('cargo', ['build-sbf', '--arch', 'v3'], { cwd: crateDir, env: { ...process.env, PATH: PATH_WITH_SOLANA }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) {
      const errs = (res.stderr || '').split('\n').filter((l) => /^error/.test(l) || /-->/.test(l)).slice(0, 40).join('\n');
      assert.fail(`cargo build-sbf failed:\n${errs}\n${(res.stderr || '').slice(-3000)}`);
    }
    const so = path.join(crateDir, 'target', 'deploy', `${state.out.crateName}.so`);
    assert.ok(fs.existsSync(so), `built ${so}`);
    state.so = fs.readFileSync(so);
    assert.ok(state.so.length > 10_000);
  });
});

describe('end to end on a local validator', () => {
  test('deploy the transmuted program and invoke every fixture route', async (t) => {
    if (!state.so) { t.skip('no built program (build test skipped or failed)'); return; }
    let healthy = false;
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), signal: AbortSignal.timeout(3000) });
      healthy = (await r.json()).result === 'ok';
    } catch { healthy = false; }
    if (!healthy) { t.skip(`no validator at ${RPC} (start solana-test-validator, or set OPENZOO_TEST_RPC)`); return; }
    const { connect, deployProgram, invoke, readKv } = await import('../lib/solana.js');
    const { loadWallet } = await import('../lib/wallet.js');
    const c = connect(RPC);
    const { keypair: payer } = loadWallet();
    const { programId } = await deployProgram(c, { payer, so: state.so });
    state.programId = programId;
    const route = (name) => state.out.manifest.routes.find((r) => r.name === name).index;
    const json = (r) => JSON.parse(r.body.toString());

    const hello = await invoke(c, { programId, payer, event: { route: route('api/hello'), method: 'GET', path: '/api/hello', query: 'name=zoo&n=21' } });
    assert.equal(hello.status, 200);
    assert.match(hello.headers['content-type'], /application\/json/);
    const h = json(hello);
    assert.equal(h.hello, 'zoo');
    assert.equal(h.n, 42);
    assert.equal(h.greeting, 'hello zoo!');
    assert.equal(h.shout, 'ZOO FROM ZOO');
    assert.equal(h.letters, 10);
    assert.equal(h.method, 'GET');
    const helloDefault = await invoke(c, { programId, payer, event: { route: route('api/hello'), method: 'GET', path: '/api/hello', query: 'lang=fr' } });
    assert.deepEqual(json(helloDefault).hello, 'world');
    assert.equal(json(helloDefault).n, null);
    assert.equal(json(helloDefault).greeting, 'bonjour world!');

    const users = route('api/users/[id]');
    const u7 = await invoke(c, { programId, payer, event: { route: users, method: 'GET', path: '/api/users/7', headers: { 'x-zoo-param-id': '7' } } });
    assert.equal(u7.status, 200);
    assert.deepEqual(json(u7), { id: '7', name: 'Ada', isAdmin: true });
    const nope = await invoke(c, { programId, payer, event: { route: users, method: 'GET', path: '/api/users/nope', headers: { 'x-zoo-param-id': 'nope' } } });
    assert.equal(nope.status, 404);
    assert.deepEqual(json(nope), { error: 'user nope not found' });
    const post7 = await invoke(c, { programId, payer, event: { route: users, method: 'POST', path: '/api/users/7', headers: { 'x-zoo-param-id': '7' } } });
    assert.equal(post7.status, 405);
    assert.equal(post7.headers.allow, 'GET');

    const counter = route('api/counter');
    const c0 = await invoke(c, { programId, payer, event: { route: counter, method: 'GET', path: '/api/counter' } });
    assert.deepEqual(json(c0), { hits: 0, label: 'total' });
    const c1 = await invoke(c, { programId, payer, event: { route: counter, method: 'POST', path: '/api/counter' }, mutate: true });
    assert.equal(c1.status, 200);
    assert.deepEqual(json(c1), { hits: 1 });
    assert.ok(c1.signature, 'a real transaction was sent');
    const c2 = await invoke(c, { programId, payer, event: { route: counter, method: 'POST', path: '/api/counter' }, mutate: true });
    assert.deepEqual(json(c2), { hits: 2 });
    const c3 = await invoke(c, { programId, payer, event: { route: counter, method: 'POST', path: '/api/counter', headers: { 'content-type': 'application/json' }, body: '{"by":5}' }, mutate: true });
    assert.deepEqual(json(c3), { hits: 7 });
    assert.equal(await readKv(c, programId, 'hits'), 7);
    const cget = await invoke(c, { programId, payer, event: { route: counter, method: 'GET', path: '/api/counter', query: 'label=x' } });
    assert.deepEqual(json(cget), { hits: 7, label: 'x' });
    const cdel = await invoke(c, { programId, payer, event: { route: counter, method: 'DELETE', path: '/api/counter' } });
    assert.equal(cdel.status, 405);
    assert.equal(cdel.headers.allow, 'GET, POST, HEAD, OPTIONS');

    const echo = await invoke(c, { programId, payer, event: { route: route('api/echo'), method: 'POST', path: '/api/echo', query: 'upper=1', headers: { 'content-type': 'application/json', 'user-agent': 'zoo-test' }, body: JSON.stringify({ a: 1, b: 'two' }) } });
    assert.equal(echo.status, 201);
    assert.equal(echo.headers['x-echo-count'], '2');
    assert.match(echo.headers['content-type'], /application\/json/);
    assert.deepEqual(json(echo), { echo: { a: 1, b: 'two' }, keys: ['a', 'b'], upper: '{"A":1,"B":"TWO"}', ua: 'zoo-test' });
    const echoGet = await invoke(c, { programId, payer, event: { route: route('api/echo'), method: 'GET', path: '/api/echo' } });
    assert.equal(echoGet.status, 200);
    assert.equal(echoGet.headers['content-type'], 'text/plain');
    assert.equal(echoGet.body.toString(), 'POST a JSON body to this route');

    const time = await invoke(c, { programId, payer, event: { route: route('api/time'), method: 'GET', path: '/api/time', query: 'x=1' } });
    assert.equal(time.status, 200);
    assert.equal(time.headers['cache-control'], 'no-store');
    const tj = json(time);
    assert.match(tj.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(tj.site, 'fixture');
    assert.equal(typeof tj.now, 'number');
    assert.ok(tj.now > 1_600_000_000_000);
    assert.equal(tj.isNumber, true);
    assert.equal(tj.date, tj.iso.slice(0, 10));
    assert.equal(tj.path, '/api/time?x=1');
  });
});
