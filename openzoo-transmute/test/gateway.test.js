// Gateway routing (unit, via handleRequest + fake invoke) and an end-to-end
// run against the local validator with the pre-built sample program.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeState, handleRequest, startGateway, staticCandidates, resolveDest, routePhases, etagOf, BODY_LIMIT } from '../lib/gateway.js';
import { MANIFEST_PATH, FORWARDED_HEADERS } from '../lib/wire.js';
import { connect, deployProgram, putAsset, getProgramInfo } from '../lib/solana.js';
import { loadWallet } from '../lib/wallet.js';

const PROGRAM = '11111111111111111111111111111112';

const manifest = {
  version: 1, framework: 'nextjs', name: 'unit-site',
  routes: [
    { index: 0, name: 'api/hello', routePath: '/api/hello', pattern: '^/api/hello/?$', params: [], methods: null, style: 'pages', kv: [] },
    { index: 1, name: 'api/counter', routePath: '/api/counter', pattern: '^/api/counter/?$', params: [], methods: ['POST'], style: 'app', kv: ['hits'] },
    { index: 2, name: 'api/users/[id]', routePath: '/api/users/[id]', pattern: '^/api/users/([^/]+)/?$', params: ['id'], methods: ['GET', 'DELETE'], style: 'app', kv: [] },
  ],
  static: [
    { path: '/index.html', contentType: 'text/html; charset=utf-8', size: 20 },
    { path: '/about.html', contentType: 'text/html; charset=utf-8', size: 20 },
    { path: '/docs/index.html', contentType: 'text/html; charset=utf-8', size: 20 },
    { path: '/app.js', contentType: 'text/javascript; charset=utf-8', size: 10 },
    { path: '/ghost.html', contentType: 'text/html; charset=utf-8', size: 5 },
  ],
  env: ['GREETING'],
  config: {
    routes: [
      { src: '^/old-hello$', dest: '/api/hello?legacy=1' },
      { src: '^/go$', status: 308, headers: { Location: '/' } },
      { src: '^/(.*)$', headers: { 'x-frame-options': 'DENY' }, continue: true },
      { handle: 'filesystem' },
      { src: '^/about$', dest: '/api/hello' },                 // static must win over this
      { src: '^/api/hello/?$', dest: '/api/hello' },
      { src: '^/api/counter/?$', dest: '/api/counter' },
      { src: '^/api/users/([^/]+)/?$', dest: '/api/users/[id]' },
      { src: '^/u/(?<id>[^/]+)$', dest: '/api/users/$id' },
      { handle: 'error' },
      { src: '^/(.*)$', dest: '/index.html', status: 404 },
    ],
  },
};

function fakeInvoke(calls) {
  return async (args) => {
    calls.push(args);
    const { event, mutate } = args;
    const body = Buffer.from(JSON.stringify({ route: event.route, method: event.method, path: event.path, query: event.query, headers: event.headers, body: event.body.toString(), mutate }));
    return { status: event.path === '/api/users/500' ? 500 : 200, headers: { 'content-type': 'application/json', 'x-custom': 'yes' }, body, simulated: !mutate, signature: mutate ? 'sig-' + event.route : undefined, unitsConsumed: 4321 };
  };
}

function unitState({ keypair = { publicKey: { toBase58: () => 'GateWay1111111111111111111111111111111111111' }, secretKey: new Uint8Array(64) }, calls = [], errorRoutes = false } = {}) {
  const m = errorRoutes ? manifest : { ...manifest, config: { routes: manifest.config.routes.filter((r) => r.handle !== 'error' && r.status !== 404) } };
  const state = makeState({ programId: PROGRAM, cluster: 'localnet', manifest: m, keypair, invoke: fakeInvoke(calls) });
  const put = (p, text, ct = 'text/html; charset=utf-8') => { const data = Buffer.from(text); state.assets.set(p, { contentType: ct, data, etag: etagOf(data), at: Date.now() }); };
  put('/index.html', '<h1>index</h1>');
  put('/about.html', '<h1>about</h1>');
  put('/docs/index.html', '<h1>docs</h1>');
  put('/app.js', 'console.log(1)', 'text/javascript; charset=utf-8');
  return { state, calls };
}

const req = (method, url, extra = {}) => ({ method, url, headers: extra.headers || {}, body: extra.body ?? null });
const parse = (r) => JSON.parse(r.body.toString());

test('helpers: staticCandidates / resolveDest / routePhases', () => {
  assert.deepEqual(staticCandidates('/'), ['/index.html']);
  assert.deepEqual(staticCandidates('/foo'), ['/foo', '/foo.html', '/foo/index.html']);
  assert.deepEqual(staticCandidates('/foo/'), ['/foo/index.html', '/foo.html', '/foo']);
  assert.equal(resolveDest('/api/users/$1?x=$2', ['/u/7/8', '7', '8']), '/api/users/7?x=8');
  const m = /^\/u\/(?<id>[^/]+)$/.exec('/u/42');
  assert.equal(resolveDest('/api/users/$id', m), '/api/users/42');
  const ph = routePhases(manifest.config.routes);
  assert.equal(ph.pre.length, 3);
  assert.equal(ph.post.length, 5);
  assert.equal(ph.error.length, 1);
});

test('static: / → index.html with etag, cleanUrls fallbacks, 304 on If-None-Match', async () => {
  const { state } = unitState();
  const r = await handleRequest(state, req('GET', '/'));
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.body.toString(), '<h1>index</h1>');
  assert.match(r.headers.etag, /^"[0-9a-f]{32}"$/);
  assert.equal(r.headers['x-frame-options'], 'DENY', 'continue-route headers apply to static hits');
  const about = await handleRequest(state, req('GET', '/about'));
  assert.equal(about.body.toString(), '<h1>about</h1>', '/about → /about.html');
  const docs = await handleRequest(state, req('GET', '/docs'));
  assert.equal(docs.body.toString(), '<h1>docs</h1>', '/docs → /docs/index.html');
  const docsSlash = await handleRequest(state, req('GET', '/docs/'));
  assert.equal(docsSlash.body.toString(), '<h1>docs</h1>');
  const js = await handleRequest(state, req('GET', '/app.js?v=1'));
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  const notMod = await handleRequest(state, req('GET', '/', { headers: { 'if-none-match': r.headers.etag } }));
  assert.equal(notMod.status, 304);
  assert.equal(notMod.body.length, 0);
  const traversal = await handleRequest(state, req('GET', '/docs/../about'));
  assert.equal(traversal.body.toString(), '<h1>about</h1>', 'dot segments are resolved, never passed through');
});

test('filesystem precedence: static beats a post-filesystem rewrite; pre-filesystem rewrite hits the function', async () => {
  const { state, calls } = unitState();
  const r = await handleRequest(state, req('GET', '/about'));
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), '<h1>about</h1>');
  assert.equal(calls.length, 0, 'the /about → /api/hello route after handle:filesystem must not fire');
  const old = await handleRequest(state, req('GET', '/old-hello?a=1'));
  assert.equal(old.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event.route, 0);
  assert.equal(calls[0].event.path, '/api/hello');
  assert.equal(calls[0].event.query, 'a=1&legacy=1', 'dest query merges with the request query');
});

test('redirect routes answer with status + location', async () => {
  const { state } = unitState();
  const r = await handleRequest(state, req('GET', '/go'));
  assert.equal(r.status, 308);
  assert.equal(r.headers.location, '/');
});

test('function routes: method → mutate mapping and x-zoo-* headers', async () => {
  const { state, calls } = unitState();
  const get = await handleRequest(state, req('GET', '/api/hello?name=zoo'));
  assert.equal(get.status, 200);
  assert.equal(calls.at(-1).mutate, false);
  assert.equal(get.headers['x-zoo-simulated'], 'true');
  assert.equal(get.headers['x-zoo-program'], PROGRAM);
  assert.equal(get.headers['x-zoo-route'], '0');
  assert.equal(get.headers['x-zoo-cu'], '4321');
  assert.equal(get.headers['x-custom'], 'yes', 'wire response headers pass through');
  assert.equal(get.headers['x-frame-options'], 'DENY');
  assert.equal('x-zoo-signature' in get.headers, false);
  assert.equal(parse(get).query, 'name=zoo');

  const head = await handleRequest(state, req('HEAD', '/api/hello'));
  assert.equal(head.status, 200);
  assert.equal(calls.at(-1).mutate, false);
  const opt = await handleRequest(state, req('OPTIONS', '/api/hello'));
  assert.equal(opt.status, 200);
  assert.equal(calls.at(-1).mutate, false);

  const post = await handleRequest(state, req('POST', '/api/counter', { body: Buffer.from('{"a":1}'), headers: { 'content-type': 'application/json' } }));
  assert.equal(post.status, 200);
  assert.equal(calls.at(-1).mutate, true);
  assert.equal(calls.at(-1).event.route, 1);
  assert.equal(calls.at(-1).event.method, 'POST');
  assert.equal(post.headers['x-zoo-simulated'], 'false');
  assert.equal(post.headers['x-zoo-signature'], 'sig-1');
  assert.equal(parse(post).body, '{"a":1}');
  assert.equal(parse(post).headers['content-type'], 'application/json');

  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    await handleRequest(state, req(m, '/api/users/9'));
    if (m === 'DELETE') { assert.equal(calls.at(-1).mutate, true, m); }
  }
  assert.equal(calls.filter((c) => c.event.route === 2 && c.mutate).length, 1, 'only DELETE is allowed on users; PUT/PATCH are 405 and never invoked');
});

test('405 when the app-router export list excludes the method', async () => {
  const { state, calls } = unitState();
  const r = await handleRequest(state, req('GET', '/api/counter'));
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'POST');
  assert.equal(calls.length, 0);
  const put = await handleRequest(state, req('PUT', '/api/users/1'));
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, DELETE, HEAD');
  const head = await handleRequest(state, req('HEAD', '/api/users/1'));
  assert.equal(head.status, 200, 'HEAD is implied by GET');
});

test('param headers from the pattern groups (direct + via rewrite), client-supplied params dropped', async () => {
  const { state, calls } = unitState();
  const r = await handleRequest(state, req('GET', '/api/users/42?x=1', { headers: { 'x-zoo-param-id': 'evil', cookie: 'a=b', host: 'localhost', accept: 'text/plain', 'x-trace': 't1', authorization: 'Bearer z' } }));
  assert.equal(r.status, 200);
  const ev = calls.at(-1).event;
  assert.equal(ev.route, 2);
  assert.equal(ev.headers['x-zoo-param-id'], '42');
  assert.equal(ev.headers.cookie, 'a=b');
  assert.equal(ev.headers.accept, 'text/plain');
  assert.equal(ev.headers['x-trace'], 't1');
  assert.equal(ev.headers.authorization, 'Bearer z');
  assert.equal('host' in ev.headers, false, 'non-forwarded headers are dropped');
  for (const k of Object.keys(ev.headers)) assert.ok(FORWARDED_HEADERS.includes(k) || k.startsWith('x-'), k);
  const via = await handleRequest(state, req('GET', '/u/7'));
  assert.equal(via.status, 200);
  assert.equal(calls.at(-1).event.route, 2);
  assert.equal(calls.at(-1).event.path, '/api/users/7', 'rewritten path is what the handler sees');
  assert.equal(calls.at(-1).event.headers['x-zoo-param-id'], '7');
  const enc = await handleRequest(state, req('GET', '/api/users/a%20b'));
  assert.equal(calls.at(-1).event.headers['x-zoo-param-id'], 'a b');
  assert.equal(enc.status, 200);
});

test('413 above the on-chain body limit, exact limit passes', async () => {
  const { state, calls } = unitState();
  const big = await handleRequest(state, req('POST', '/api/counter', { body: Buffer.alloc(BODY_LIMIT + 1, 0x61) }));
  assert.equal(big.status, 413);
  assert.equal(parse(big).limit, 900);
  assert.match(parse(big).message, /transaction/);
  assert.equal(calls.length, 0);
  const ok = await handleRequest(state, req('POST', '/api/counter', { body: Buffer.alloc(BODY_LIMIT, 0x61) }));
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

test('402 for mutating requests without a gateway keypair; reads still work', async () => {
  const { state, calls } = unitState({ keypair: null });
  const post = await handleRequest(state, req('POST', '/api/counter'));
  assert.equal(post.status, 402);
  assert.equal(post.headers['x-zoo-needs-signer'], 'true');
  const b = parse(post);
  assert.equal(b.error, 'payment required');
  assert.match(b.message, /--keypair/);
  assert.equal(b.x402.network, 'localnet');
  assert.equal(calls.length, 0, 'never invoked');
  const get = await handleRequest(state, req('GET', '/api/hello'));
  assert.equal(get.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mutate, false);
  assert.equal(calls[0].payer.toBase58(), PROGRAM, 'falls back to a chain-derived payer when unsigned');
});

test('404 JSON for unknown paths; error-phase route serves a custom 404 page', async () => {
  const { state } = unitState();
  const r = await handleRequest(state, req('GET', '/nope'));
  assert.equal(r.status, 404);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(parse(r).error, 'not found');
  assert.equal(parse(r).path, '/nope');
  const ghost = await handleRequest(state, req('GET', '/ghost'));
  assert.equal(ghost.status, 404, 'listed in the manifest but absent on chain');
  assert.equal(parse(ghost).error, 'asset missing on chain');
  const { state: spa } = unitState({ errorRoutes: true });
  const fallback = await handleRequest(spa, req('GET', '/some/client/route'));
  assert.equal(fallback.status, 404);
  assert.equal(fallback.body.toString(), '<h1>index</h1>', 'error-phase dest served with the route status');
  const bad = await handleRequest(state, req('BREW', '/'));
  assert.equal(bad.status, 405);
});

test('invoke failures become 502 with the program logs', async () => {
  const { state } = unitState();
  state.invoke = async () => { const e = new Error('program failed: {"InstructionError":[2,{"Custom":7}]}\nProgram log: boom'); e.logs = ['Program log: boom']; throw e; };
  const r = await handleRequest(state, req('GET', '/api/hello'));
  assert.equal(r.status, 502);
  assert.equal(parse(r).error, 'invoke failed');
  assert.deepEqual(parse(r).logs, ['Program log: boom']);
});

test('/.zoo/manifest.json, /.zoo/status and the explorer', async () => {
  const { state } = unitState();
  const m = await handleRequest(state, req('GET', '/.zoo/manifest.json'));
  assert.equal(m.status, 200);
  assert.equal(parse(m).routes.length, 3);
  assert.equal(parse(m).programId, PROGRAM);
  const alias = await handleRequest(state, req('GET', MANIFEST_PATH));
  assert.equal(alias.status, 200);
  const s = await handleRequest(state, req('GET', '/.zoo/status'));
  assert.equal(s.status, 200);
  const st = parse(s);
  assert.equal(st.programId, PROGRAM);
  assert.equal(st.manifest.routes, 3);
  assert.equal(st.manifest.static, 5);
  assert.equal(st.bodyLimit, 900);
  assert.ok(st.stats.requests >= 2);
  const x = await handleRequest(state, req('GET', '/.zoo/'));
  assert.equal(x.status, 200);
  assert.equal(x.headers['content-type'], 'text/html; charset=utf-8');
  const htmlText = x.body.toString();
  assert.match(htmlText, /<a href="\/api\/hello">\/api\/hello<\/a>/);
  assert.match(htmlText, /\/api\/users\/\[id\]/);
  assert.match(htmlText, /<a href="\/index\.html">/);
  assert.match(htmlText, /GREETING/);
  const nope = await handleRequest(state, req('GET', '/.zoo/other'));
  assert.equal(nope.status, 404);
});

// ---------------------------------------------------------------- end to end

const SAMPLE_SO = '/tmp/claude-0/-home-user-leCore/a19c7b90-72f9-553d-88b5-6caf858df17b/scratchpad/sample-site/target/deploy/sample_site.so';
const RPC = process.env.OPENZOO_TEST_RPC || 'http://127.0.0.1:8899';
const CACHE = path.join(path.dirname(SAMPLE_SO), 'gateway-e2e-program.json');

async function validatorUp() {
  try {
    const c = connect(RPC);
    await Promise.race([c.getSlot(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
    return true;
  } catch { return false; }
}

const e2eReady = fs.existsSync(SAMPLE_SO) && await validatorUp();

test('e2e: deploy sample_site.so, put assets + manifest, serve through the gateway', { skip: e2eReady ? false : `needs ${SAMPLE_SO} and a validator at ${RPC}`, timeout: 240_000 }, async (t) => {
  const connection = connect(RPC);
  const { keypair: payer } = loadWallet();
  const so = fs.readFileSync(SAMPLE_SO);

  // Reuse a program deployed by an earlier run when it is still there (keeps re-runs fast).
  let programId = null;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const info = await getProgramInfo(connection, cached.programId);
    if (info.exists && cached.soLength === so.length && info.authority?.equals(payer.publicKey)) programId = cached.programId;
  } catch { /* none */ }
  if (!programId) {
    const t0 = Date.now();
    const r = await deployProgram(connection, { payer, so });
    programId = r.programId.toBase58();
    t.diagnostic(`deployed ${programId} in ${Date.now() - t0} ms`);
    fs.writeFileSync(CACHE, JSON.stringify({ programId, soLength: so.length }));
  } else t.diagnostic(`reusing ${programId}`);

  const html = Buffer.from('<!doctype html><title>zoo</title><h1>hello from solana</h1>');
  await putAsset(connection, { authority: payer, programId, path: '/index.html', contentType: 'text/html; charset=utf-8', data: html });
  const e2eManifest = {
    version: 1, framework: 'nextjs', name: 'sample-site',
    routes: [
      { index: 0, name: 'api/hello', routePath: '/api/hello', pattern: '^/api/hello/?$', params: [], methods: null, style: 'pages', kv: [] },
      { index: 1, name: 'api/counter', routePath: '/api/counter', pattern: '^/api/counter/?$', params: [], methods: ['POST'], style: 'app', kv: ['hits'] },
    ],
    static: [{ path: '/index.html', contentType: 'text/html; charset=utf-8', size: html.length }],
    env: ['GREETING'],
    config: { routes: [{ handle: 'filesystem' }, { src: '^/api/hello/?$', dest: '/api/hello' }, { src: '^/api/counter/?$', dest: '/api/counter' }] },
    programId, deployedAt: new Date().toISOString(),
  };
  await putAsset(connection, { authority: payer, programId, path: MANIFEST_PATH, contentType: 'application/json; charset=utf-8', data: Buffer.from(JSON.stringify(e2eManifest)), force: true });

  const gw = await startGateway({ programId, cluster: RPC, port: 0, keypair: payer, connection, quiet: true });
  t.after(() => gw.close());
  assert.ok(gw.port > 0);
  assert.ok(gw.state.manifest.routes.length === 2, 'manifest read from chain');

  const root = await fetch(`${gw.url}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /^text\/html/);
  assert.equal(await root.text(), html.toString());
  assert.match(root.headers.get('etag'), /^"[0-9a-f]{32}"$/);

  const hello = await fetch(`${gw.url}/api/hello?name=zoo&n=21`);
  assert.equal(hello.status, 200);
  assert.equal(hello.headers.get('x-zoo-simulated'), 'true');
  assert.equal(hello.headers.get('x-zoo-program'), programId);
  assert.ok(Number(hello.headers.get('x-zoo-cu')) > 0, 'compute units reported');
  const hj = await hello.json();
  assert.equal(hj.hello, 'zoo');
  assert.equal(hj.n, 42);
  assert.equal(hj.greeting, 'hi');
  t.diagnostic(`GET /api/hello → ${JSON.stringify(hj)} (${hello.headers.get('x-zoo-cu')} CU)`);

  const c1 = await fetch(`${gw.url}/api/counter`, { method: 'POST' });
  assert.equal(c1.status, 200);
  assert.equal(c1.headers.get('x-zoo-simulated'), 'false');
  assert.ok(c1.headers.get('x-zoo-signature')?.length > 40, 'signed tx signature exposed');
  const j1 = await c1.json();
  const c2 = await fetch(`${gw.url}/api/counter`, { method: 'POST' });
  assert.equal(c2.status, 200);
  const j2 = await c2.json();
  assert.equal(j2.hits, j1.hits + 1, `hits increments (${j1.hits} → ${j2.hits})`);
  t.diagnostic(`POST /api/counter twice → hits ${j1.hits}, ${j2.hits}; sig ${c2.headers.get('x-zoo-signature').slice(0, 12)}…`);

  const getCounter = await fetch(`${gw.url}/api/counter`);
  assert.equal(getCounter.status, 405);

  const mf = await fetch(`${gw.url}/.zoo/manifest.json`);
  assert.equal(mf.status, 200);
  const mj = await mf.json();
  assert.equal(mj.programId, programId);
  assert.equal(mj.routes.length, 2);

  const status = await fetch(`${gw.url}/.zoo/status`);
  const sj = await status.json();
  assert.equal(sj.program.exists, true);
  assert.equal(sj.program.authority, payer.publicKey.toBase58());
  assert.ok(sj.slot > 0);

  const explorer = await fetch(`${gw.url}/.zoo/`);
  assert.match(await explorer.text(), /sample-site/);

  const nope = await fetch(`${gw.url}/nope`);
  assert.equal(nope.status, 404);
  assert.equal((await nope.json()).error, 'not found');

  const big = await fetch(`${gw.url}/api/counter`, { method: 'POST', body: 'x'.repeat(2000) });
  assert.equal(big.status, 413);

  // An unsigned gateway on the same program: reads work, writes are 402.
  const ro = await startGateway({ programId, cluster: RPC, port: 0, connection, quiet: true });
  t.after(() => ro.close());
  const roHello = await fetch(`${ro.url}/api/hello?name=x&n=1`);
  assert.equal(roHello.status, 200);
  assert.equal((await roHello.json()).n, 2);
  const roPost = await fetch(`${ro.url}/api/counter`, { method: 'POST' });
  assert.equal(roPost.status, 402);
});
