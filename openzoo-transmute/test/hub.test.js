// The hosted explorer's routing, with a fake site so no chain is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, handleHub, COOKIE } from '../lib/hub.js';
import { makeState, normalizeManifest } from '../lib/gateway.js';
import { Keypair } from '@solana/web3.js';

const PID = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();

function fakeSite(programId) {
  const state = makeState({ programId, cluster: 'localnet', connection: null, invoke: async ({ event }) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ echo: event.path, method: event.method })), simulated: true, unitsConsumed: 1 }) });
  if (programId === OTHER) { state.noManifest = true; return state; }
  state.manifest = normalizeManifest({ version: 1, name: 'fake', routes: [{ index: 0, routePath: '/api/hello', pattern: '^/api/hello/?$', methods: null, style: 'pages' }], static: [{ path: '/index.html', contentType: 'text/html', size: 20 }], config: { routes: [{ handle: 'filesystem' }, { src: '^/api/hello/?$', dest: '/api/hello' }] } });
  state.assets.set('/index.html', { contentType: 'text/html; charset=utf-8', data: Buffer.from('<h1>fake site</h1>'), etag: '"x"', at: Date.now() });
  state.manifestAt = Date.now();
  return state;
}

const hub = () => makeHub({ cluster: 'localnet', connection: { rpcEndpoint: 'http://127.0.0.1:1' }, makeSite: async (id) => fakeSite(id) });
const req = (url, o = {}) => ({ method: o.method || 'GET', url, headers: o.headers || {}, body: o.body || Buffer.alloc(0) });
const text = (r) => Buffer.isBuffer(r.body) ? r.body.toString() : String(r.body);

test('landing page without a pinned site; 404 JSON for other paths', async () => {
  const h = hub();
  const r = await handleHub(h, req('/'));
  assert.equal(r.status, 200);
  assert.match(text(r), /openzoo sites/);
  const n = await handleHub(h, req('/app.js'));
  assert.equal(n.status, 404);
  assert.equal(JSON.parse(text(n)).error, 'no site pinned');
});

test('/s/<id> pins with a cookie and redirects to the site root', async () => {
  const h = hub();
  const r = await handleHub(h, req(`/s/${PID}`));
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  assert.match(r.headers['set-cookie'], new RegExp(`^${COOKIE}=${PID}; Path=/`));
  const bad = await handleHub(h, req('/s/nope'));
  assert.equal(bad.status, 400);
});

test('a pinned site serves its static root, root-relative links and functions', async () => {
  const h = hub();
  const cookie = `${COOKIE}=${PID}`;
  const root = await handleHub(h, req('/', { headers: { cookie } }));
  assert.equal(root.status, 200);
  assert.match(text(root), /fake site/);
  assert.equal(root.headers['x-zoo-site'], PID);
  const fn = await handleHub(h, req('/api/hello?x=1', { headers: { cookie } }));
  assert.equal(fn.status, 200);
  assert.deepEqual(JSON.parse(text(fn)), { echo: '/api/hello', method: 'GET' });
  const abs = await handleHub(h, req(`/s/${PID}/api/hello`));
  assert.equal(abs.status, 200);
  assert.match(abs.headers['set-cookie'], new RegExp(`^${COOKIE}=${PID}`));
  const zoo = await handleHub(h, req(`/s/${PID}/.zoo/manifest.json`));
  assert.equal(zoo.status, 200);
  assert.equal(JSON.parse(text(zoo)).name, 'fake');
});

test('writes without a signer answer 402; unknown program says so; hub pages', async () => {
  const h = hub();
  const cookie = `${COOKIE}=${PID}`;
  const w = await handleHub(h, req('/api/hello', { method: 'POST', headers: { cookie }, body: Buffer.from('{}') }));
  assert.equal(w.status, 402);
  const unknown = await handleHub(h, req(`/s/${OTHER}/`));
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(text(unknown)).error, 'no site at this program id');
  const sites = await handleHub(h, req('/.hub/sites.json'));
  assert.equal(sites.status, 200);
  const list = JSON.parse(text(sites)).sites.map((s) => s.programId);
  assert.ok(list.includes(PID) && list.includes(OTHER));
  const go = await handleHub(h, req(`/.hub/go?program=${PID}`));
  assert.equal(go.status, 302);
  assert.equal(go.headers.location, `/s/${PID}`);
  const leave = await handleHub(h, req('/.hub/leave', { headers: { cookie } }));
  assert.equal(leave.status, 302);
  assert.match(leave.headers['set-cookie'], /Max-Age=0/);
  const health = await handleHub(h, req('/.hub/health'));
  assert.equal(JSON.parse(text(health)).ok, true);
});

test('an LRU keeps at most maxSites sites', async () => {
  const h = makeHub({ cluster: 'localnet', connection: { rpcEndpoint: 'http://127.0.0.1:1' }, maxSites: 2, makeSite: async (id) => fakeSite(id) });
  const ids = [PID, OTHER, Keypair.generate().publicKey.toBase58()];
  for (const id of ids) await handleHub(h, req(`/s/${id}/.zoo/status`));
  assert.equal(h.sites.size, 2);
  assert.ok(!h.sites.has(PID));
});
