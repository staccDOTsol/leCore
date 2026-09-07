// omniarb desk — eight tabs over one CA that lives on nine chains at once.
//
// Reads go straight to chain state through this server's RPC proxy; prices come
// from Birdeye through its proxy, so the key never reaches the page. Writes
// (launch, bridge, curve, swaps) are jobs: the request starts one and the page
// follows its steps, because a launch takes minutes and an HTTP request that
// dies mid-bridge leaves nobody holding the record of where it got to.

import * as C from './omniarb-core.js';

const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const S = {
  tab: 'board',
  chains: {}, nativeUsd: {}, beOk: null,
  tokens: [], live: {}, be: {}, supplies: {}, scan: '', boot: 'booting',
  sel: null, venues: [], beTok: null, dec: 18,
  charts: null, chartHours: 24, chartType: '15m', hiddenChains: new Set(), chartBusy: false,
  size: 50, bridged: true, hookless: true,
  curve: null, curveSize: '0.01', curveTok: '',
  bag: null, bagAddress: '',
  me: null, log: [], pending: null, seed: {}, seedCa: null, seedBag: null,
  bridgeBag: null, launchImage: null, launchMeta: null,
  tick: 0,
};

/** The launch everything else is measured against. */
const HERO = '0x9a5baA12664c89cFbF5cFcD9d0D4805bDcAB29E8';

const HOURS = { '1h': [1, '1m'], '6h': [6, '5m'], '24h': [24, '15m'], '7d': [168, '1H'], '30d': [720, '4H'] };

/* -------------------------------------------------------------- boot */

async function boot() {
  wireShell();
  mountAll();
  try { S.me = await C.api('/api/me'); } catch { S.me = null; }
  $('wallet').onclick = () => { if (!W.address) connect(); };
  paintWallet();
  paintLog();
  pollChains();
  prices();
  discover();
  setInterval(refresh, 30_000);
}

function refresh() {
  S.tick += 1;
  $('tickText').textContent = 'tick ' + S.tick;
  pollChains();
  prices();
  if (S.sel) loadVenues(S.sel.address);
  if (S.tab === 'chart' && S.sel) loadCharts();
}

/* --------------------------------------------------- chain heads + gas */

async function pollChains() {
  await Promise.all(C.CHAINS.map(async (ch) => {
    const t0 = performance.now();
    try {
      const [bn, gp] = await C.rpcBatch(ch, [{ method: 'eth_blockNumber' }, { method: 'eth_gasPrice' }]);
      S.chains[ch.id] = { block: Number(C.hexToBig(bn)), gas: Number(C.hexToBig(gp)) / 1e9,
        ms: Math.round(performance.now() - t0), up: true };
    } catch (e) {
      S.chains[ch.id] = { up: false, err: e.message };
    }
    paintRail();
  }));
}

// Native asset prices, one Birdeye call per feed chain. Monad has no feed at
// all, so it is left null rather than filled with a guess.
async function prices() {
  const groups = {};
  for (const c of C.CHAINS) {
    const [px, chain] = C.NATIVE_FEED[c.id] ?? [];
    if (px && chain) (groups[chain] ||= new Set()).add(px);
  }
  const out = {};
  await Promise.all(Object.entries(groups).map(async ([chain, set]) => {
    const d = await C.beMulti([...set], chain);
    if (d) for (const [a, v] of Object.entries(d)) out[chain + '|' + a.toLowerCase()] = v;
  }));
  for (const c of C.CHAINS) {
    const [px, chain] = C.NATIVE_FEED[c.id] ?? [];
    const v = px ? out[chain + '|' + px.toLowerCase()] : null;
    S.nativeUsd[c.id] = v ? v.value : null;
  }
  S.beOk = Object.keys(out).length > 0;
  $('beStatus').textContent = S.beOk === null ? '…' : S.beOk ? 'live' : 'no feed';
  paintRail();
  paintActive();
}

/* ------------------------------------------------------------ discovery */

async function discover() {
  let d = null;
  try { d = await C.api('/api/discover'); } catch { /* fall through to empty */ }
  S.tokens = (d?.tokens ?? []).map((t) => ({ ...t, ts: t.createdAt ? Math.floor(new Date(t.createdAt).getTime() / 1000) : 0 }));
  S.hidden = d?.hiddenBeforeEpoch ?? 0;
  S.scan = d ? `${d.indexed} indexed · ${d.fromEvents} from launcher events${S.hidden ? ` · ${S.hidden} pre-OMNI hidden` : ''}` : 'discovery failed';
  S.boot = S.tokens.length ? 'ready' : 'empty';
  paintBoard();
  if (!S.tokens.length) return;
  liveness(S.tokens);
  supplies(S.tokens);
  beBoard(S.tokens);
  const hero = S.tokens.find((t) => t.address.toLowerCase() === HERO.toLowerCase());
  select(hero ?? S.tokens[0]);
}

async function liveness(tokens) {
  await Promise.all(C.CHAINS.map(async (ch) => {
    try {
      const res = await C.rpcBatch(ch, tokens.map((t) => ({ method: 'eth_getCode', params: [t.address, 'latest'] })));
      tokens.forEach((t, i) => {
        S.live[t.address] = { ...(S.live[t.address] || {}), [ch.id]: res[i] == null ? null : res[i].length > 4 };
      });
      paintBoard();
    } catch { /* one chain down is not fatal */ }
  }));
}

// The portal burns on the source and mints on the destination, so the sum across
// nine chains is the real float — no single chain shows it.
async function supplies(tokens) {
  await Promise.all(C.CHAINS.map(async (ch) => {
    const calls = tokens.map((t) => ({ method: 'eth_call', params: [{ to: t.address, data: '0x18160ddd' }, 'latest'] }));
    if (ch.id === C.HOME_CHAIN) tokens.forEach((t) => calls.push({ method: 'eth_call', params: [{ to: t.address, data: '0x313ce567' }, 'latest'] }));
    try {
      const res = await C.rpcBatch(ch, calls);
      tokens.forEach((t, i) => {
        const cur = { ...(S.supplies[t.address] || {}) };
        if (res[i] != null && res[i] !== '0x') cur[ch.id] = C.hexToBig(res[i]);
        const d = res[tokens.length + i];
        if (d != null && d !== '0x') cur.dec = Number(C.hexToBig(d));
        S.supplies[t.address] = cur;
      });
      paintBoard();
      paintVenues();
    } catch { /* same */ }
  }));
}

async function beBoard(tokens) {
  const d = await C.beMulti(tokens.slice(0, 40).map((t) => t.address), 'base');
  if (!d) return;
  for (const [a, v] of Object.entries(d)) S.be[a.toLowerCase()] = v;
  paintBoard();
  // OMNI is the hero and the default: it is the launch the index starts at, the
  // one with float on all nine chains, and the only one where every panel here
  // has something real to show.
  if (!S.picked) {
    const hero = tokens.find((t) => t.address.toLowerCase() === HERO.toLowerCase());
    if (hero) select(hero);
    else {
      let best = null; let bestLiq = -1;
      for (const t of tokens) {
        const v = S.be[t.address.toLowerCase()];
        if (v && v.liquidity > bestLiq) { bestLiq = v.liquidity; best = t; }
      }
      if (best) select(best);
    }
  }
}

const supTotalOf = (t) => {
  const s = S.supplies[t.address] || {};
  return C.CHAINS.reduce((a, c) => a + (s[c.id] != null ? C.fromWei(s[c.id], s.dec || 18) : 0), 0);
};

/* ------------------------------------------------------------ selection */

function select(t, byUser) {
  if (byUser) S.picked = true;
  S.sel = t;
  S.venues = []; S.beTok = null; S.charts = null; S.curve = null;
  $('selLabel').textContent = `${t.symbol || 'token'} · ${C.short(t.address)}`;
  const ca = $('caInput'); if (ca) ca.value = t.address;
  const bca = $('brCa'); if (bca) bca.value = t.address;
  paintAll();
  loadVenues(t.address);
  loadBirdeyeToken(t.address);
  if (S.tab === 'chart') loadCharts();
  if (S.tab === 'curve') loadCurve();
  if (S.tab === 'bridge') { loadBridgeBag(); loadPending(); }
}

async function loadBirdeyeToken(address) {
  S.beTok = await C.bePrice(address, 'base');
  paintVenues();
}

async function loadVenues(address) {
  const rows = [];
  await Promise.all(C.CHAINS.map(async (ch) => {
    const idH = C.poolIdFor(address, ch.hook); const id0 = C.poolIdFor(address, '0x0');
    const sH = C.poolStateSlot(idH); const s0 = C.poolStateSlot(id0);
    try {
      const r = await C.rpcBatch(ch, [
        { method: 'eth_call', params: [{ to: ch.poolManager, data: C.extsloadData(sH) }, 'latest'] },
        { method: 'eth_call', params: [{ to: ch.poolManager, data: C.extsloadData(C.slotPlus(sH, 3)) }, 'latest'] },
        { method: 'eth_call', params: [{ to: ch.poolManager, data: C.extsloadData(s0) }, 'latest'] },
        { method: 'eth_call', params: [{ to: ch.poolManager, data: C.extsloadData(C.slotPlus(s0, 3)) }, 'latest'] },
        { method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] },
      ]);
      const dec = r[4] ? Number(C.hexToBig(r[4])) : 18;
      [['hooked', C.decodeSlot0(r[0]), C.hexToBig(r[1] || '0x0'), idH],
       ['hookless', C.decodeSlot0(r[2]), C.hexToBig(r[3] || '0x0'), id0]].forEach(([kind, s, L, pid]) => {
        if (!s) return;
        rows.push({ chain: ch, kind, poolId: pid, dec, L, ...s, price: C.priceFromSqrt(s.sqrtPriceX96, 18, dec) });
      });
    } catch { /* chain unreachable this pass */ }
  }));
  rows.sort((a, b) => C.CHAINS.indexOf(a.chain) - C.CHAINS.indexOf(b.chain) || (a.kind < b.kind ? -1 : 1));
  S.venues = rows;
  paintAll();
}

/* ---------------------------------------------------------- shell paint */

function wireShell() {
  $('refresh').onclick = refresh;
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    go(b.dataset.tab);
  });
}

function go(tab) {
  S.tab = tab;
  for (const b of $('tabs').querySelectorAll('button[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  for (const t of ['board', 'chart', 'venues', 'routes', 'curve', 'launch', 'bridge', 'bag']) {
    $('tab-' + t).classList.toggle('hidden', t !== tab);
  }
  paintActive();
  if (tab === 'chart' && S.sel && !S.charts) loadCharts();
  if (tab === 'curve' && S.sel && !S.curve) loadCurve();
  if (tab === 'bridge') { loadBridgeBag(); if (!S.pending) loadPending(); }
}

function paintRail() {
  const up = C.CHAINS.filter((c) => S.chains[c.id]?.up).length;
  $('rpcUp').textContent = up + '/9';
  $('rail').innerHTML = C.CHAINS.map((c) => {
    const s = S.chains[c.id] || {};
    const usd = S.nativeUsd[c.id];
    const dot = s.up ? '#4de2a0' : s.up === false ? '#ff5f56' : '#3a4149';
    return `<div class="c">
      <div class="h"><b>${h(c.short)}</b><span class="s" style="background:${dot}"></span></div>
      <div class="kv"><span>blk</span><span>${s.block ? s.block.toLocaleString() : '…'}</span></div>
      <div class="kv"><span>gas</span><span>${s.gas != null ? (s.gas < 1 ? s.gas.toFixed(3) : s.gas.toFixed(1)) + ' gwei' : '…'}</span></div>
      <div class="kv"><span>${h(c.gas)}</span><span class="acc">${usd ? C.fmtUsd(usd) : 'no feed'}</span></div>
    </div>`;
  }).join('');
  $('statusLine').textContent =
    `${up}/9 rpc up · ${S.tokens.length} launches · ${S.venues.length} venues read · tick ${S.tick}`;
}

function mountAll() {
  mountBoard(); mountChart(); mountVenues(); mountRoutes();
  mountCurve(); mountLaunch(); mountBridge(); mountBag();
}
function paintAll() { paintRail(); paintBoard(); paintChart(); paintVenues(); paintRoutes(); paintCurve(); paintSeed(); paintBridge(); paintBag(); }
function paintActive() {
  ({ board: paintBoard, chart: paintChart, venues: paintVenues, routes: paintRoutes,
    curve: paintCurve, launch: paintSeed, bridge: paintBridge, bag: paintBag })[S.tab]?.();
}

/* ================================================================= board */

const BOARD_COLS = 'minmax(0,1.6fr) 118px 62px minmax(0,1.7fr) 86px 78px 104px 96px';

function mountBoard() {
  $('tab-board').innerHTML = `
    <div class="hero" id="hero"></div>
    <div class="cards">
      <div class="card accent">
        <div class="k">aggregate mcap · all chains</div>
        <div class="v" id="bMcap">…</div>
        <div class="n" id="bCov"></div>
      </div>
      <div class="card">
        <div class="k">aggregate liquidity</div>
        <div class="v" id="bLiq">…</div>
        <div class="n">birdeye, summed across launches</div>
      </div>
      <div class="card">
        <div class="k">launches</div>
        <div class="v" id="bCount">…</div>
        <div class="n">factory <a href="https://basescan.org/address/${C.FACTORY}" target="_blank" rel="noreferrer">0xCF8C62…fC761e</a></div>
      </div>
      <div class="card">
        <div class="k">scan window</div>
        <div class="n" style="font-size:12px;margin-top:8px;color:#a8b0bb" id="bScan">scanning</div>
      </div>
    </div>
    <div style="padding-bottom:12px">
      <input type="text" id="q" placeholder="filter ticker / name / ca" style="width:100%" />
    </div>
    <div class="table">
      <div class="th" style="grid-template-columns:${BOARD_COLS}">
        <div>token</div><div>ca</div><div>age</div><div>live on</div>
        <div class="r">px (usd)</div><div class="r">24h</div><div class="r">mcap · 9ch</div><div class="r">liq (usd)</div>
      </div>
      <div id="bRows"></div>
      <div class="note" id="bNote">reading the factory…</div>
    </div>`;
  $('q').addEventListener('input', () => paintBoardRows());
  $('bRows').addEventListener('click', (e) => {
    const r = e.target.closest('[data-ca]');
    if (!r) return;
    const t = S.tokens.find((x) => x.address === r.dataset.ca);
    if (t) { select(t, true); go('venues'); }
  });
}

function paintBoard() {
  let mcap = 0; let liq = 0; let priced = 0; let supplied = 0;
  for (const t of S.tokens) {
    const be = S.be[t.address.toLowerCase()];
    const sup = supTotalOf(t);
    if (sup) supplied += 1;
    if (be) { liq += be.liquidity || 0; if (sup) { mcap += be.value * sup; priced += 1; } }
  }
  $('bMcap').textContent = mcap ? C.fmtUsd(mcap) : '…';
  $('bLiq').textContent = liq ? C.fmtUsd(liq) : '…';
  $('bCount').textContent = S.tokens.length || '…';
  $('bCov').textContent = `${supplied}/${S.tokens.length || '…'} float read · ${priced} priced by birdeye`;
  $('bScan').textContent = S.scan || 'scanning';
  paintHero();
  paintBoardRows();
}

/**
 * OMNI, up top, always.
 *
 * It is the launch the index starts at and the only CA with float on all nine
 * chains, so it is the one the rest of the board is read against — and it is the
 * default selection rather than whichever token happens to have the deepest
 * Birdeye pool this minute.
 */
function paintHero() {
  const el = $('hero');
  if (!el) return;
  const t = S.tokens.find((x) => x.address.toLowerCase() === HERO.toLowerCase());
  if (!t) { el.innerHTML = ''; return; }
  const be = S.be[t.address.toLowerCase()];
  const sup = supTotalOf(t);
  const liveMap = S.live[t.address] || {};
  const on = C.CHAINS.filter((c) => liveMap[c.id] === true).length;
  const chg = be?.priceChange24h;
  el.innerHTML = `
    <div class="heroMark">${h((t.symbol || 'OMNI').slice(0, 4))}</div>
    <div class="heroBody">
      <div class="heroName">${h(t.symbol || 'OMNI')} <span class="dim">${h(t.name || '')}</span></div>
      <div class="dim" style="font-size:11px;margin-top:4px">
        <a href="https://basescan.org/address/${h(t.address)}" target="_blank" rel="noreferrer">${h(t.address)}</a>
        · the launch this board starts at · ${on || '…'}/9 chains live
      </div>
    </div>
    <div class="heroStats">
      <div><div class="k">price</div><div class="v">${be ? C.fmtUsd(be.value) : '…'}</div></div>
      <div><div class="k">24h</div><div class="v ${chg > 0 ? 'up' : chg < 0 ? 'down' : 'dim'}">${chg != null ? C.fmtPct(chg) : '—'}</div></div>
      <div><div class="k">mcap · 9ch</div><div class="v acc">${be && sup ? C.fmtUsd(be.value * sup) : '…'}</div></div>
      <div><div class="k">float</div><div class="v">${sup ? C.fmtNum(sup, 5) : '…'}</div></div>
    </div>
    <div class="heroActs">
      <button class="btn go" data-hero="chart">chart</button>
      <button class="btn go" data-hero="curve">trade</button>
    </div>`;
  el.onclick = (e) => {
    const b = e.target.closest('[data-hero]');
    if (!b) return;
    select(t, true);
    go(b.dataset.hero);
  };
}

function paintBoardRows() {
  const q = ($('q')?.value || '').trim().toLowerCase();
  const rows = S.tokens.filter((t) => !q
    || (t.symbol || '').toLowerCase().includes(q)
    || (t.name || '').toLowerCase().includes(q)
    || t.address.toLowerCase().includes(q));

  $('bRows').innerHTML = rows.map((t) => {
    const be = S.be[t.address.toLowerCase()];
    const liveMap = S.live[t.address] || {};
    const on = C.CHAINS.filter((c) => liveMap[c.id] === true);
    const missing = C.CHAINS.filter((c) => liveMap[c.id] === false);
    const unknown = C.CHAINS.filter((c) => liveMap[c.id] == null);
    const n = on.length;
    const sup = supTotalOf(t);
    const mc = be && sup ? be.value * sup : null;
    const liveText = !Object.keys(liveMap).length ? '…'
      : `${n}/9${missing.length ? ' · −' + missing.map((c) => c.short).join(' −') : n === 9 ? ' everywhere' : ''}` +
        `${unknown.length ? ' · ?' + unknown.map((c) => c.short).join(' ?') : ''}`;
    const liveColor = n === 9 ? '#4de2a0' : n ? '#ffb040' : '#5f6672';
    const chg = be && be.priceChange24h != null ? C.fmtPct(be.priceChange24h) : '—';
    const chgCls = be && be.priceChange24h > 0 ? 'up' : be && be.priceChange24h < 0 ? 'down' : 'dim';
    const bg = S.sel && S.sel.address === t.address ? '#111620' : 'transparent';
    return `<div class="tr pick" data-ca="${h(t.address)}" style="grid-template-columns:${BOARD_COLS};background:${bg}">
      <div style="min-width:0">
        <div style="font-weight:700;letter-spacing:.01em">${h(t.symbol || '?')}${t.source === 'launcher-event' ? ' <span class="warn" title="in the launcher’s events, missing from the site index" style="font-size:10px">unindexed</span>' : ''}</div>
        <div class="dim ell" style="font-size:10.5px">${h(t.name || 'unnamed')}</div>
      </div>
      <div class="mut ell" style="font-size:11px">${h(C.short(t.address))}</div>
      <div class="mut" style="font-size:11px">${t.ts ? C.ago(t.ts) + ' ago' : '—'}</div>
      <div class="ell" style="color:${liveColor};font-size:11px">${h(liveText)}</div>
      <div class="r">${be ? C.fmtUsd(be.value) : '—'}</div>
      <div class="r ${chgCls}">${chg}</div>
      <div class="r acc">${mc ? C.fmtUsd(mc) : '—'}</div>
      <div class="r soft">${be && be.liquidity ? C.fmtUsd(be.liquidity) : '—'}</div>
    </div>`;
  }).join('');

  $('bNote').textContent = S.boot === 'empty'
    ? 'nothing found — neither the site index nor the launcher events returned a launch.'
    : rows.length
      ? `${S.hidden ? `${S.hidden} pre-OMNI launch${S.hidden === 1 ? '' : 'es'} hidden, same as the site's own index. ` : ''}tap a row to read every pool for that CA on all nine chains. prices and 24h change are Birdeye prints on Base; liveness is eth_getCode on each chain. rows marked unindexed are on chain but missing from the site index — they trade exactly the same.`
      : S.tokens.length ? 'no launch matches that filter.' : 'reading the site index and the launcher events…';
}

/* ================================================================= chart */
//
// One CA, nine chains, one chart. Every other chart of these tokens shows a
// single venue on a single chain, which is how a token can look flat on Base
// while it is 40% richer on BNB. Here: a thin line per chain Birdeye can see,
// and a fat line for the float-weighted aggregate — the number that actually
// answers "what is this thing worth".
//
// Colour alone never has to carry it: the aggregate is thicker than everything
// else, every line is labelled at its right end, and the crosshair reads out
// every chain by name.

function mountChart() {
  $('tab-chart').innerHTML = `
    <div class="row" style="padding:16px 0 12px;justify-content:space-between">
      <div class="row" style="gap:6px">
        ${Object.keys(HOURS).map((k) => `<button class="btn small ${k === '24h' ? 'on' : 'off'}" data-win="${k}">${k}</button>`).join('')}
      </div>
      <div class="dim" style="font-size:11px" id="chWeighting"></div>
    </div>
    <div class="cards" style="padding:0 0 12px">
      <div class="card accent">
        <div class="k">aggregate price · float-weighted</div>
        <div class="v" id="chPx">…</div>
        <div class="n" id="chChg"></div>
      </div>
      <div class="card">
        <div class="k">aggregate mcap</div>
        <div class="v" id="chMcap">…</div>
        <div class="n" id="chFloat"></div>
      </div>
      <div class="card">
        <div class="k">widest cross-chain gap</div>
        <div class="v" id="chGap">…</div>
        <div class="n" id="chGapWhere"></div>
      </div>
      <div class="card">
        <div class="k">painted</div>
        <div class="v" id="chPainted">…</div>
        <div class="n" id="chUnpainted"></div>
      </div>
    </div>
    <div class="chartbox" id="chartBox"><svg id="chartSvg"></svg><div class="tip hidden" id="chartTip"></div></div>
    <div class="legend" id="chLegend"></div>
    <div class="dim" style="font-size:11px;padding:8px 2px 0;text-wrap:pretty;max-width:980px" id="chNote"></div>`;

  $('tab-chart').addEventListener('click', (e) => {
    const w = e.target.closest('[data-win]');
    if (w) {
      const [hrs, type] = HOURS[w.dataset.win];
      S.chartHours = hrs; S.chartType = type;
      for (const b of $('tab-chart').querySelectorAll('[data-win]')) {
        b.classList.toggle('on', b === w); b.classList.toggle('off', b !== w);
      }
      loadCharts();
      return;
    }
    const l = e.target.closest('[data-chain]');
    if (l) {
      const id = Number(l.dataset.chain);
      if (S.hiddenChains.has(id)) S.hiddenChains.delete(id); else S.hiddenChains.add(id);
      paintChart();
    }
  });
  addEventListener('resize', () => { if (S.tab === 'chart') drawChart(); });
}

async function loadCharts() {
  if (!S.sel || S.chartBusy) return;
  S.chartBusy = true;
  $('chNote').textContent = 'reading Birdeye candles on every covered chain…';
  try {
    S.charts = await C.api('/api/charts', { ca: S.sel.address, type: S.chartType, hours: S.chartHours });
  } catch (e) {
    S.charts = null;
    $('chNote').textContent = 'charts failed: ' + e.message;
  }
  S.chartBusy = false;
  paintChart();
}

function paintChart() {
  const d = S.charts;
  if (!d) return;
  $('chPx').textContent = d.aggPrice ? C.fmtUsd(d.aggPrice) : 'no prints';
  const chg = d.aggChangePct;
  $('chChg').innerHTML = chg == null ? 'no window change'
    : `<span class="${chg > 0 ? 'up' : chg < 0 ? 'down' : 'dim'}">${C.fmtPct(chg)}</span> over ${d.hours}h · ${d.agg.length} buckets`;
  $('chMcap').textContent = d.aggMcap ? C.fmtUsd(d.aggMcap) : '—';
  $('chFloat').textContent = `${C.fmtNum(d.float, 6)} across nine chains`;
  $('chWeighting').textContent = d.weighting;

  const spots = d.series.filter((s) => s.spotUsd > 0);
  if (spots.length > 1) {
    const lo = spots.reduce((a, b) => (a.spotUsd <= b.spotUsd ? a : b));
    const hi = spots.reduce((a, b) => (a.spotUsd >= b.spotUsd ? a : b));
    $('chGap').textContent = C.fmtPct((hi.spotUsd / lo.spotUsd - 1) * 100);
    $('chGapWhere').textContent = `cheap ${lo.short} ${C.fmtUsd(lo.spotUsd)} → rich ${hi.short} ${C.fmtUsd(hi.spotUsd)}`;
  } else {
    $('chGap').textContent = '—';
    $('chGapWhere').textContent = 'needs two priced chains';
  }
  $('chPainted').textContent = `${d.series.filter((s) => s.points.length).length}/${d.paintable.length}`;
  $('chUnpainted').textContent = `birdeye covers ${d.paintable.join(' ')} · no feed for ${d.unpaintable.join(' ')}`;

  // Legend doubles as the direct-label key and the per-line toggle.
  const agg = `<button data-agg><span class="sw fat" style="background:${C.AGG_COLOR}"></span>aggregate <span class="acc">${d.aggPrice ? C.fmtUsd(d.aggPrice) : '—'}</span></button>`;
  $('chLegend').innerHTML = agg + d.series.map((s) => {
    const c = C.byId[s.id];
    const shown = !S.hiddenChains.has(s.id);
    const px = s.spotUsd ? C.fmtUsd(s.spotUsd) : 'no print';
    const tag = s.covered ? '' : ' <span class="dim">(pool)</span>';
    return `<button data-chain="${s.id}" aria-pressed="${shown}" title="${s.covered ? 'birdeye candles' : 'no birdeye feed — live pool price only'}">
      <span class="sw" style="background:${c.color}"></span>${h(s.short)} ${px}${tag}</button>`;
  }).join('');

  $('chNote').innerHTML = `each thin line is one chain’s Birdeye close, drawn only where Birdeye actually has that chain — ` +
    `${h(d.unpaintable.join(' and '))} are not in its network list, so they get a spot marker read straight from the pool instead of an invented history. ` +
    `the fat line is the float-weighted aggregate: every chain’s print weighted by the supply sitting on that chain, because the portal moves float around and a plain mean would let an empty chain outvote a full one. ` +
    `a chain that has not printed in a bucket carries its last print forward rather than dropping out of the average.`;

  drawChart();
}

const SVGNS = 'http://www.w3.org/2000/svg';
let _chartHit = null;

function drawChart() {
  const d = S.charts;
  const svg = $('chartSvg');
  if (!svg) return;
  const box = $('chartBox');
  const W = Math.max(420, box.clientWidth - 28);
  const H = 380;
  const pad = { l: 66, r: 62, t: 14, b: 26 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);

  if (!d || !d.agg.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#5f6672" font-size="12"
      font-family="JetBrains Mono, monospace">${d ? 'no birdeye prints in this window' : 'pick a token on the board'}</text>`;
    return;
  }

  const visible = d.series.filter((s) => s.points.length && !S.hiddenChains.has(s.id));
  const t0 = d.agg[0].t; const t1 = d.agg.at(-1).t;
  const vals = [...d.agg.map((p) => p.c), ...visible.flatMap((s) => s.points.map((p) => p.c))];
  const spots = d.series.filter((s) => !s.covered && s.spotUsd > 0 && !S.hiddenChains.has(s.id));
  vals.push(...spots.map((s) => s.spotUsd));
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  if (hi === lo) { hi = lo * 1.05 || 1; lo = lo * 0.95; }
  const span = hi - lo;
  lo -= span * 0.08; hi += span * 0.08;

  const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.c).toFixed(1)}`).join(' ');

  const grid = [];
  for (let i = 0; i <= 4; i += 1) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Y(v).toFixed(1);
    grid.push(`<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#161b22" stroke-width="1"/>`);
    grid.push(`<text x="${pad.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="#5f6672"
      font-size="10" font-family="JetBrains Mono, monospace">${h(C.fmtUsd(v))}</text>`);
  }
  const ticks = [];
  for (let i = 0; i <= 4; i += 1) {
    const t = t0 + ((t1 - t0) * i) / 4;
    ticks.push(`<text x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}"
      fill="#5f6672" font-size="10" font-family="JetBrains Mono, monospace">${h(C.clock(t))}</text>`);
  }

  const area = `${path(d.agg)} L${X(t1).toFixed(1)} ${Y(lo).toFixed(1)} L${X(t0).toFixed(1)} ${Y(lo).toFixed(1)} Z`;
  const lines = visible.map((s) =>
    `<path d="${path(s.points)}" fill="none" stroke="${C.byId[s.id].color}" stroke-width="1.5" opacity="0.9"
      stroke-linejoin="round" stroke-linecap="round"/>`).join('');

  // Direct labels at the right end of each line: the secondary encoding that
  // means nobody has to resolve seven hues from memory.
  const endLabels = visible.map((s) => {
    const p = s.points.at(-1);
    return `<text x="${(X(p.t) + 6).toFixed(1)}" y="${Y(p.c).toFixed(1)}" dominant-baseline="middle"
      fill="${C.byId[s.id].color}" font-size="10" font-family="JetBrains Mono, monospace">${h(s.short)}</text>`;
  }).join('');

  // Chains Birdeye cannot see: one honest dot at the current pool price, no line.
  const spotMarks = spots.map((s) => `
    <circle cx="${(W - pad.r).toFixed(1)}" cy="${Y(s.spotUsd).toFixed(1)}" r="3" fill="#0b0d11"
      stroke="${C.byId[s.id].color}" stroke-width="1.5"/>
    <text x="${(W - pad.r + 7).toFixed(1)}" y="${Y(s.spotUsd).toFixed(1)}" dominant-baseline="middle"
      fill="#7d8590" font-size="10" font-family="JetBrains Mono, monospace">${h(s.short)} ·pool</text>`).join('');

  const aggEnd = d.agg.at(-1);
  svg.innerHTML = `
    ${grid.join('')}
    <path d="${area}" fill="${C.AGG_COLOR}" opacity="0.07"/>
    ${lines}
    <path d="${path(d.agg)}" fill="none" stroke="${C.AGG_COLOR}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>
    ${endLabels}
    ${spotMarks}
    <text x="${(X(aggEnd.t) + 6).toFixed(1)}" y="${Y(aggEnd.c).toFixed(1)}" dominant-baseline="middle"
      fill="${C.AGG_COLOR}" font-size="11" font-weight="700" font-family="JetBrains Mono, monospace">agg</text>
    ${ticks.join('')}
    <line id="chCross" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}" stroke="#3d4a5c" stroke-width="1" opacity="0"/>
    <g id="chDots"></g>`;

  _chartHit = { d, X, Y, pad, W, H, visible, t0, t1 };
  svg.onmousemove = onChartMove;
  svg.onmouseleave = () => {
    $('chartTip').classList.add('hidden');
    svg.querySelector('#chCross').setAttribute('opacity', '0');
    svg.querySelector('#chDots').innerHTML = '';
  };
}

function onChartMove(e) {
  const hit = _chartHit;
  if (!hit) return;
  const svg = $('chartSvg');
  const r = svg.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * hit.W;
  const frac = Math.min(1, Math.max(0, (x - hit.pad.l) / (hit.W - hit.pad.l - hit.pad.r)));
  const t = hit.t0 + frac * (hit.t1 - hit.t0);

  const nearest = (pts) => {
    let best = null;
    for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  const a = nearest(hit.d.agg);
  const cross = svg.querySelector('#chCross');
  cross.setAttribute('x1', hit.X(a.t)); cross.setAttribute('x2', hit.X(a.t));
  cross.setAttribute('opacity', '1');

  const rows = hit.visible.map((s) => ({ s, p: nearest(s.points) }))
    .filter((r2) => r2.p).sort((p, q) => q.p.c - p.p.c);
  svg.querySelector('#chDots').innerHTML =
    `<circle cx="${hit.X(a.t)}" cy="${hit.Y(a.c)}" r="4" fill="${C.AGG_COLOR}" stroke="#08090b" stroke-width="1.5"/>` +
    rows.map((r2) => `<circle cx="${hit.X(r2.p.t)}" cy="${hit.Y(r2.p.c)}" r="2.6"
      fill="${C.byId[r2.s.id].color}" stroke="#08090b" stroke-width="1"/>`).join('');

  const tip = $('chartTip');
  tip.innerHTML = `<div class="t">${h(C.clock(a.t))}</div>
    <div class="l"><span><span class="sw" style="background:${C.AGG_COLOR}"></span><b>aggregate</b></span><b class="acc">${h(C.fmtUsd(a.c))}</b></div>
    ${rows.map((r2) => `<div class="l"><span><span class="sw" style="background:${C.byId[r2.s.id].color}"></span>${h(r2.s.short)}</span>
      <span class="soft">${h(C.fmtUsd(r2.p.c))}</span></div>`).join('')}
    <div class="t" style="margin:6px 0 0">${a.chains} chain${a.chains === 1 ? '' : 's'} in this bucket</div>`;
  tip.classList.remove('hidden');
  const box = $('chartBox').getBoundingClientRect();
  const left = e.clientX - box.left + 16;
  tip.style.left = Math.min(left, box.width - tip.offsetWidth - 12) + 'px';
  tip.style.top = Math.max(8, e.clientY - box.top - tip.offsetHeight / 2) + 'px';
}

/* ================================================================ venues */

const VENUE_COLS = '84px 92px minmax(0,1.1fr) 96px minmax(0,1fr) 64px 84px 76px minmax(0,1.1fr)';

function mountVenues() {
  $('tab-venues').innerHTML = `
    <div class="row" style="padding:16px 0 14px">
      <input type="text" id="caInput" class="grow" placeholder="paste a launched CA (0x…) — same address on all 9 chains" />
      <button class="btn go" id="loadCa">read pools</button>
    </div>
    <div class="panel accent" style="margin-bottom:12px">
      <div class="row" style="gap:18px;align-items:baseline;justify-content:space-between">
        <div>
          <div class="k" style="font-size:10px;color:#5f6672;letter-spacing:.08em;text-transform:uppercase">aggregate mcap · nine chains</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:24px;margin-top:5px;color:#c9f24d" id="vMcap">…</div>
        </div>
        <div class="r">
          <div style="font-size:10px;color:#5f6672;letter-spacing:.08em;text-transform:uppercase">total float</div>
          <div style="font-size:14px;margin-top:7px" id="vFloat">…</div>
          <div class="dim" style="font-size:10.5px;margin-top:2px" id="vHolding"></div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(184px,1fr));gap:8px;margin-top:14px" id="vSupply"></div>
      <div class="dim" style="font-size:10.5px;margin-top:11px;text-wrap:pretty" id="vFloatNote"></div>
    </div>
    <div class="row" style="gap:10px;padding-bottom:12px;font-size:11px;color:#7d8590">
      <span class="pill">venues <b id="vCount">…</b></span>
      <span class="pill">widest spread <b class="acc" id="vSpread">—</b></span>
      <span class="pill">tick gap <b id="vTickGap">—</b></span>
      <span class="pill" id="vWhere">…</span>
    </div>
    <div class="table">
      <div class="th" style="grid-template-columns:${VENUE_COLS}">
        <div>chain</div><div>venue</div><div class="r">px (native)</div><div class="r">px (usd)</div>
        <div class="r">liquidity</div><div class="r">fee</div><div class="r">tick</div><div class="r">gap</div><div>reach</div>
      </div>
      <div id="vRows"></div>
      <div class="note" id="vNote">paste a CA or pick a launch on the board.</div>
    </div>`;
  $('loadCa').onclick = () => {
    const a = $('caInput').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { $('vNote').textContent = 'that is not a 0x address.'; return; }
    select({ address: a, symbol: 'custom', name: a }, true);
  };
}

const usdPxOf = (v) => { const nu = S.nativeUsd[v.chain.id]; return nu ? (1 / v.price) * nu : null; };

function paintVenues() {
  if (!S.sel) return;
  const sup = S.supplies[S.sel.address] || {};
  const dec = sup.dec || 18;
  const total = C.CHAINS.reduce((a, c) => a + (sup[c.id] != null ? C.fromWei(sup[c.id], dec) : 0), 0);
  const px = S.beTok ? S.beTok.value : null;

  $('vMcap').textContent = total && px ? C.fmtUsd(total * px) : 'no birdeye print';
  $('vFloat').textContent = total ? `${C.fmtNum(total, 6)} ${S.sel.symbol || ''}` : '…';
  $('vHolding').textContent = `${C.CHAINS.filter((c) => sup[c.id] > 0n).length}/9 chains hold float`;
  $('vFloatNote').textContent = total
    ? 'supply is burned on the source and minted on the destination, so no single chain shows the real float — this is the sum of nine totalSupply() reads, priced at the birdeye print.'
    : 'reading totalSupply() on all nine chains…';

  $('vSupply').innerHTML = C.CHAINS.map((c) => {
    const v = sup[c.id] != null ? C.fromWei(sup[c.id], dec) : null;
    const share = v != null && total > 0 ? (v / total) * 100 : null;
    const bar = share > 40 ? '#c9f24d' : share > 5 ? '#8fae3f' : '#3d4a24';
    return `<div style="border:1px solid #1a1f27;background:#0b0d11;border-radius:9px;padding:9px 10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px">
        <span style="font-weight:700;font-size:11px">${h(c.short)}</span>
        <span class="acc" style="font-size:11px">${share == null ? '—' : share.toFixed(1) + '%'}</span>
      </div>
      <div style="height:3px;background:#161b22;border-radius:2px;margin:7px 0 6px;overflow:hidden">
        <div style="height:3px;background:${bar};width:${(share || 0).toFixed(2)}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:6px;font-size:10px" class="mut">
        <span>${v == null ? '—' : C.fmtNum(v, 4)}</span><span class="soft">${v != null && px ? C.fmtUsd(v * px) : '—'}</span>
      </div>
    </div>`;
  }).join('');

  const priced = S.venues.filter((v) => usdPxOf(v));
  const loUsd = priced.length ? Math.min(...priced.map(usdPxOf)) : 0;
  const hiUsd = priced.length ? Math.max(...priced.map(usdPxOf)) : 0;

  $('vRows').innerHTML = S.venues.map((v) => {
    const pu = usdPxOf(v);
    const gap = pu && loUsd > 0 ? (pu / loUsd - 1) * 100 : null;
    const reach = v.kind === 'hooked' ? 'omnichain router'
      : v.chain.helper ? 'OmniArb ' + C.short(v.chain.helper) : 'unreachable — deploy OmniArb';
    const reachCls = v.kind === 'hooked' ? 'mut' : v.chain.helper ? 'up' : 'warn';
    const gapCls = gap > 5 ? 'acc' : gap > 0.5 ? 'warn' : 'dim';
    const bg = pu && (pu === loUsd || pu === hiUsd) ? '#101620' : 'transparent';
    return `<div class="tr" style="grid-template-columns:${VENUE_COLS};background:${bg}">
      <div style="font-weight:700">${h(v.chain.short)}</div>
      <div class="${v.kind === 'hooked' ? 'soft' : 'acc'}">${h(v.kind)}</div>
      <div class="r soft">${(1 / v.price).toPrecision(4)} ${h(v.chain.gas)}</div>
      <div class="r">${pu ? C.fmtUsd(pu) : 'no feed'}</div>
      <div class="r soft">${C.fmtNum(C.fromWei(v.L, 18), 4)}</div>
      <div class="r mut">${(v.lpFee / 10000).toFixed(2)}%</div>
      <div class="r mut">${v.tick.toLocaleString()}</div>
      <div class="r ${gapCls}">${gap == null ? '—' : C.fmtPct(gap)}</div>
      <div class="${reachCls}" style="font-size:10.5px">${h(reach)}</div>
    </div>`;
  }).join('');

  const vMax = S.venues.length ? S.venues.reduce((a, b) => (a.tick > b.tick ? a : b)) : null;
  const vMin = S.venues.length ? S.venues.reduce((a, b) => (a.tick < b.tick ? a : b)) : null;
  const vCheap = priced.length ? priced.reduce((a, b) => (usdPxOf(a) < usdPxOf(b) ? a : b)) : null;
  const vRich = priced.length ? priced.reduce((a, b) => (usdPxOf(a) > usdPxOf(b) ? a : b)) : null;
  $('vCount').textContent = S.venues.length || '…';
  $('vSpread').textContent = hiUsd > 0 && loUsd > 0 ? C.fmtPct((hiUsd / loUsd - 1) * 100) : '—';
  $('vTickGap').textContent = vMax && vMin ? `${Math.abs(vMax.tick - vMin.tick).toLocaleString()} ticks` : '—';
  $('vWhere').textContent = vCheap && vRich && vCheap !== vRich
    ? `buy ${vCheap.chain.short} ${vCheap.kind} → sell ${vRich.chain.short} ${vRich.kind}`
    : S.venues.length === 1 ? 'single pool — nothing to arb yet' : '…';
  $('vNote').textContent = S.venues.length
    ? 'read live with eth_call → PoolManager.extsload: pool id = keccak(PoolKey{native, token, fee 3000, spacing 60, hook}), state slot = keccak(id ‖ 6). the hooked pool carries omnichain’s dynamic fee; the hookless pool (hooks = 0x0) has the same id on every chain and no deployed periphery can reach it — which is exactly why it drifts.'
    : 'paste a CA or pick a launch on the board.';
}

/* ================================================================ routes */

function mountRoutes() {
  $('tab-routes').innerHTML = `
    <div class="row" style="padding:16px 0 14px;justify-content:space-between">
      <div class="row">
        <label class="mut" style="font-size:11px">size
          <input type="range" min="5" max="2000" step="5" value="50" id="rSize"
            style="vertical-align:middle;width:180px;accent-color:#c9f24d;margin:0 8px" />
          <span class="acc" style="font-weight:700" id="rSizeText">$50</span>
        </label>
        <button class="btn small on" id="rBridged">bridged legs</button>
        <button class="btn small on" id="rHookless">hookless pools</button>
      </div>
      <div class="dim" style="font-size:11px" id="rNote">no venues loaded</div>
    </div>
    <div id="rEmpty" class="hidden" style="border:1px dashed #232a34;border-radius:12px;padding:22px;font-size:12px;color:#7d8590;text-wrap:pretty"></div>
    <div style="display:grid;gap:10px" id="rList"></div>
    <div class="dim" style="padding:16px 2px;font-size:11px;text-wrap:pretty;max-width:900px">
      numbers are a constant-liquidity simulation of the live pool state clamped to the current tick-spacing range
      (liquidity in neighbouring ranges is not discoverable without the tick bitmap, and these pools saturate inside one
      range anyway — measured caps are ~0.0014 native on Base, ~0.0004 on Arbitrum and World, ~0.0002 on Polygon), minus
      measured gas at the current gas price, minus 0.3% for the Relay hop home on bridged legs. it does not cross tick
      boundaries, and the hooked pools’ surge fee can move under you — the CLI re-simulates against real chain state
      immediately before signing, and sets the on-chain minProfit from that fresh simulation so a stale edge reverts
      instead of settling at a loss. atomic routes cost gas when they miss; bridged routes are priced, not protected.
    </div>`;
  $('rSize').addEventListener('input', (e) => {
    S.size = Number(e.target.value);
    $('rSizeText').textContent = '$' + S.size;
    paintRoutes();
  });
  $('rBridged').onclick = () => { S.bridged = !S.bridged; toggleBtn($('rBridged'), S.bridged); paintRoutes(); };
  $('rHookless').onclick = () => { S.hookless = !S.hookless; toggleBtn($('rHookless'), S.hookless); paintRoutes(); };
}

function toggleBtn(el, on) { el.classList.toggle('on', on); el.classList.toggle('off', !on); }

function buildRoutes() {
  if (!S.venues.length) return [];
  const pool = S.venues.filter((v) => S.hookless || v.kind === 'hooked');
  const gasUnits = { atomic: 550000, swap: 250000, bridge: 180000 };
  const out = [];
  for (const buy of pool) {
    const nu = S.nativeUsd[buy.chain.id];
    if (!nu || !S.size) continue;
    const amtIn = BigInt(Math.round((S.size / nu) * 1e18));
    const b = C.buyTokenForNative(buy.sqrtPriceX96, buy.L, amtIn, buy.lpFee || 3000, buy.tick);
    if (b.out <= 0n) continue;
    const spentUsd = C.fromWei(b.used, 18) * nu;
    if (spentUsd <= 0) continue;
    for (const sell of pool) {
      if (sell === buy) continue;
      const cross = sell.chain.id !== buy.chain.id;
      if (cross && !S.bridged) continue;
      if (cross && S.live[S.sel?.address] && S.live[S.sel.address][sell.chain.id] === false) continue;
      const nu2 = S.nativeUsd[sell.chain.id];
      if (!nu2) continue;
      const s = C.sellTokenForNative(sell.sqrtPriceX96, sell.L, b.out, sell.lpFee || 3000, sell.tick);
      if (s.out <= 0n) continue;
      const soldPct = (Number(s.used) / Number(b.out)) * 100;
      const grossUsd = C.fromWei(s.out, 18) * nu2;
      const gA = (S.chains[buy.chain.id]?.gas || 0) * 1e-9;
      const gB = (S.chains[sell.chain.id]?.gas || 0) * 1e-9;
      let gasUsd; let shape;
      if (!cross) { shape = 'route-atomic'; gasUsd = gA * gasUnits.atomic * nu; }
      else { shape = 'route-bridged'; gasUsd = gA * (gasUnits.swap + gasUnits.bridge) * nu + gB * gasUnits.swap * nu2; }
      const relayUsd = cross ? grossUsd * 0.003 : 0;
      const net = grossUsd - spentUsd - gasUsd - relayUsd;
      const needsHelper = buy.kind === 'hookless' || sell.kind === 'hookless';
      const flags = [];
      if (needsHelper) {
        flags.push((buy.kind === 'hookless' ? buy.chain : sell.chain).helper
          ? 'hookless leg — OmniArb helper already deployed on that chain'
          : 'hookless leg — omnichain’s router builds the PoolKey with its own hook and rejects hooks = 0x0; needs OmniArb deployed');
      }
      if (b.saturated) flags.push(`buy side fills only ${C.fmtUsd(spentUsd)} of the requested $${S.size} inside the live tick range`);
      if (s.saturated) flags.push(`sell side saturates: ${soldPct.toFixed(1)}% of the bag clears before the range runs out — size is the binding constraint, not the spread`);
      if (cross) flags.push('not atomic: burned on source, stuck until the relayer mints; relay back-haul charged at 0.3%');
      if (gasUsd > Math.abs(net) * 0.5) flags.push('gas is a material share of the edge at the current gas price');
      out.push({ shape, buy, sell, grossUsd, gasUsd, net, size: spentUsd, requested: S.size, cross, flags,
        soldPct, tokens: C.fromWei(b.out, buy.dec), sold: C.fromWei(s.used, buy.dec) });
    }
  }
  out.sort((a, b) => b.net - a.net);
  return out.slice(0, 10);
}

function paintRoutes() {
  const routes = buildRoutes();
  $('rNote').textContent = routes.length ? `${routes.length} routes priced at ${S.venues.length} venues` : 'no venues loaded';
  const empty = $('rEmpty');
  if (S.venues.length > 0 && routes.length === 0) {
    empty.classList.remove('hidden');
    empty.textContent = S.venues.length === 1
      ? `this CA has exactly one live pool (${S.venues[0].chain.short} ${S.venues[0].kind}), so there is no second venue to trade against. pick a deeper launch on the board — the fresh ones are often only cooked on Base.`
      : 'no route clears at this size with the current toggles. widen the size, or re-enable bridged legs and hookless pools.';
  } else empty.classList.add('hidden');

  $('rList').innerHTML = routes.map((r) => {
    const netCls = r.net > 0 ? 'acc' : 'down';
    const shapeCol = r.shape === 'route-atomic' ? '#4de2a0' : '#ffb040';
    const shapeBd = r.shape === 'route-atomic' ? '#25503c' : '#4d3a17';
    return `<div class="panel" style="border-color:${r.net > 0 ? '#2a3a1c' : '#1a1f27'}">
      <div class="row" style="justify-content:space-between">
        <div class="row" style="gap:10px;min-width:0">
          <span style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;border:1px solid ${shapeBd};color:${shapeCol};border-radius:5px;padding:3px 7px">${h(r.shape)}</span>
          <span style="font-size:13px;font-weight:700">${h(`${r.buy.chain.short} ${r.buy.kind} → ${r.sell.chain.short} ${r.sell.kind}`)}</span>
          <span class="dim" style="font-size:11px">${r.cross ? 'buy · portal burn/mint · sell · relay home' : 'buy and sell in one call'}</span>
        </div>
        <div style="display:flex;gap:18px;align-items:baseline">
          <div class="r"><div class="dim" style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase">gross</div><div style="font-size:12px">${C.fmtUsd(r.grossUsd)}</div></div>
          <div class="r"><div class="dim" style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase">gas</div><div class="warn" style="font-size:12px">−${C.fmtUsd(r.gasUsd)}</div></div>
          <div class="r"><div class="dim" style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase">net</div><div class="${netCls}" style="font-family:'Space Grotesk',sans-serif;font-size:19px;font-weight:700">${r.net >= 0 ? '+' : '−'}${C.fmtUsd(Math.abs(r.net))}</div></div>
          <div class="r"><div class="dim" style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase">edge</div><div class="${netCls}" style="font-size:12px">${C.fmtPct((r.net / r.size) * 100)}</div></div>
        </div>
      </div>
      <div class="mut" style="margin-top:11px;padding-top:10px;border-top:1px solid #171b22;font-size:11px;text-wrap:pretty">
        ${C.fmtUsd(r.size)} deployable of the requested $${r.requested} → ${C.fmtNum(r.tokens, 4)} ${h(S.sel?.symbol || 'tok')} on ${h(r.buy.chain.name)}
        → ${r.soldPct < 99.5 ? `${C.fmtNum(r.sold, 4)} (${r.soldPct.toFixed(1)}%) sells` : 'sells'} into ${h(r.sell.chain.name)} ${h(r.sell.kind)} for ${C.fmtUsd(r.grossUsd)}.
        gas priced at ${(S.chains[r.buy.chain.id]?.gas || 0).toFixed(3)} gwei on ${h(r.buy.chain.short)}${r.cross ? ` + ${(S.chains[r.sell.chain.id]?.gas || 0).toFixed(3)} gwei on ${h(r.sell.chain.short)}` : ''}
      </div>
      <div style="margin-top:7px;font-size:10.5px;text-wrap:pretty;color:${r.flags.length ? '#ffb040' : '#4d545e'}">${h(r.flags.join(' · ') || 'no protection flags on this leg')}</div>
    </div>`;
  }).join('');
}

/* ================================================================ wallet */
//
// The desk holds no key. Every transaction is built by the server against live
// pool state — quote, slippage floor, calldata — and handed to whatever wallet
// the visitor has, which signs it or refuses. MetaMask, Rabby, Frame: anything
// that speaks EIP-1193.

const W = { provider: null, address: null, chainId: null, providers: [] };

// EIP-6963: wallets announce themselves rather than fighting over
// window.ethereum. Falls back to window.ethereum for anything older.
addEventListener('eip6963:announceProvider', (e) => {
  if (!W.providers.some((p) => p.info.uuid === e.detail.info.uuid)) W.providers.push(e.detail);
});
dispatchEvent(new Event('eip6963:requestProvider'));

function pickProvider() {
  if (W.providers.length === 1) return W.providers[0].provider;
  if (W.providers.length > 1) {
    const names = W.providers.map((p, i) => `${i + 1}. ${p.info.name}`).join('\n');
    const n = Number(prompt(`which wallet?\n${names}`, '1'));
    return (W.providers[n - 1] ?? W.providers[0]).provider;
  }
  return window.ethereum ?? null;
}

async function connect() {
  const p = pickProvider();
  if (!p) { alert('no wallet found — install MetaMask, Rabby, or anything EIP-1193'); return; }
  W.provider = p;
  const accounts = await p.request({ method: 'eth_requestAccounts' });
  W.address = accounts[0];
  W.chainId = Number(await p.request({ method: 'eth_chainId' }));
  p.on?.('accountsChanged', (a) => { W.address = a[0] ?? null; paintWallet(); paintAll(); });
  p.on?.('chainChanged', (c) => { W.chainId = Number(c); paintWallet(); });
  paintWallet();
  $('bagAddr').value = W.address;
  loadBag();
  loadPending();
  paintAll();
}

function paintWallet() {
  const el = $('wallet');
  if (W.address) {
    const on = C.byId[W.chainId];
    el.innerHTML = `<span class="dot"></span><b class="acc">${h(C.short(W.address))}</b> ${h(on ? on.short : 'chain ' + W.chainId)}`;
    el.title = W.address;
    el.classList.remove('btn');
    el.classList.add('pill');
  } else {
    el.textContent = 'connect wallet';
    el.classList.add('btn');
    el.classList.remove('pill');
  }
}

/**
 * Put the wallet on the right chain, adding it when the wallet has never heard
 * of it. Six of these nine are chains no wallet ships with.
 */
async function ensureChain(id) {
  const want = '0x' + Number(id).toString(16);
  if (Number(W.chainId) === Number(id)) return;
  try {
    await W.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|Unrecognized/i.test(String(e?.message))) throw e;
    const c = (S.me?.chains ?? []).find((x) => x.id === Number(id));
    const local = C.byId[Number(id)];
    if (!c) throw new Error(`no rpc known for chain ${id}`);
    await W.provider.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: want, chainName: c.name, rpcUrls: [c.rpc],
      nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
      blockExplorerUrls: [local?.explorer ?? c.explorer],
    }] });
    await W.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  }
  W.chainId = Number(id);
  paintWallet();
}

/** Poll for a receipt through this server's proxy: the wallet's own node lags. */
async function waitReceipt(chainId, hash, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await C.rpc(chainId, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`no receipt for ${hash} after ${Math.round(timeoutMs / 1000)}s`);
}

/* ------------------------------------------------------------- the log */
//
// One transcript, shown on every tab that can start something. No job ids and
// no server state: the page ran it, so the page has it.

function log(text, cls) {
  S.log.unshift({ at: Date.now(), text: String(text), cls: cls || '' });
  S.log = S.log.slice(0, 200);
  paintLog();
}

function paintLog() {
  const html = !S.log.length
    ? `<div class="log dim">nothing yet. every transaction here is built by the server against live pool state and signed by your wallet — this page never sees a key.</div>`
    : `<div class="log">${S.log.map((l) =>
      `<div class="s"><time>${new Date(l.at).toLocaleTimeString()}</time><span class="${l.cls}">${linkify(l.text)}</span></div>`).join('')}</div>`;
  for (const id of ['cvLog', 'lnLog', 'brLog']) { const el = $(id); if (el) el.innerHTML = html; }
}

// Explorer links inside a line should be clickable; the rest is escaped.
function linkify(text) {
  return h(text).replace(/https?:\/\/[^\s)]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
}

/**
 * Run a server-built step list through the wallet.
 *
 * A sell is an approve and then a swap, so steps come as a list; each one is
 * confirmed before the next is offered, because the second is invalid until the
 * first has landed.
 */
async function runSteps(steps) {
  if (!W.address) { await connect(); if (!W.address) return []; }
  const done = [];
  for (const s of steps) {
    await ensureChain(s.chainId);
    log(`${s.label} on ${s.chainName}${s.note ? ` — ${s.note}` : ''}…`);
    const hash = await W.provider.request({ method: 'eth_sendTransaction', params: [{
      from: W.address, to: s.to, data: s.data, value: s.value }] });
    const ex = C.byId[s.chainId]?.explorer;
    log(`sent ${ex ? `${ex}/tx/${hash}` : hash}`);
    const rec = await waitReceipt(s.chainId, hash);
    if (Number(rec.status) !== 1 && rec.status !== '0x1') throw new Error(`${s.label} reverted (${hash})`);
    log(`${s.label} confirmed`, 'up');
    done.push({ ...s, hash, receipt: rec });
  }
  return done;
}

/** Wrap a flow so a rejected signature reads as a rejected signature. */
async function guard(fn) {
  try { await fn(); } catch (e) {
    const m = String(e?.message ?? e);
    log(/user rejected|denied|4001/i.test(m) ? 'you rejected the transaction' : m, 'down');
  }
}

/* ================================================================= curve */
//
// The bonding curve lives on Base only, and only until the token graduates. It
// is the "buy cheap on the pad" half of the trade — so this prices the pad and
// both Base pools at the same size and says which one is actually cheaper.

function mountCurve() {
  $('tab-curve').innerHTML = `
    <div class="cards">
      <div class="card accent"><div class="k">curve price · base</div><div class="v" id="cvPx">…</div><div class="n" id="cvState"></div></div>
      <div class="card"><div class="k">tokens still on the curve</div><div class="v" id="cvHeld">…</div><div class="n">held by the pad contract</div></div>
      <div class="card"><div class="k">pad vs pools · this size</div><div class="v" id="cvEdge">…</div><div class="n" id="cvEdgeNote">quote a size to compare</div></div>
      <div class="card"><div class="k">pad</div><div class="n" style="font-size:12px;margin-top:8px;color:#a8b0bb">
        <a href="https://basescan.org/address/${C.PAD}" target="_blank" rel="noreferrer">${h(C.short(C.PAD))}</a> · base only</div></div>
    </div>
    <div class="panel" style="margin-bottom:12px">
      <div class="row" style="align-items:flex-end">
        <div style="flex:1;min-width:150px"><label class="f">buy size (ETH)</label>
          <input type="text" id="cvEth" value="0.01" style="width:100%" /></div>
        <div style="flex:1;min-width:150px"><label class="f">sell size (tokens)</label>
          <input type="text" id="cvTok" placeholder="0" style="width:100%" /></div>
        <div style="min-width:120px"><label class="f">slippage bps</label>
          <input type="text" id="cvSlip" value="1000" style="width:100%" /></div>
        <button class="btn go" id="cvQuote">quote</button>
      </div>
      <div class="table" style="margin-top:14px">
        <div class="th" style="grid-template-columns:130px minmax(0,1fr) minmax(0,1fr) 170px">
          <div>venue</div><div class="r">tokens for the buy</div><div class="r">eth for the sell</div><div>act</div>
        </div>
        <div id="cvRows"></div>
        <div class="note" id="cvNote">the pad is a fixed curve; the pools move. when the pad hands you more tokens than the hooked pool for the same ETH, that is the "buy the pad, sell the dex" trade — same wallet, same chain, two transactions, no bridge.</div>
      </div>
    </div>
    <div id="cvLog"></div>`;
  $('cvQuote').onclick = loadCurve;
  $('cvRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trade]');
    if (!b) return;
    const [venue, side] = b.dataset.trade.split(':');
    const amount = side === 'buy' ? $('cvEth').value.trim() : $('cvTok').value.trim();
    if (!amount || Number(amount) <= 0) { $('cvNote').textContent = 'set a size first.'; return; }
    guard(async () => {
      if (!W.address) { await connect(); if (!W.address) return; }
      const tx = await C.apiPost('/api/tx/trade', { ca: S.sel.address, chain: C.HOME_CHAIN,
        venue, side, amount, from: W.address, slippageBps: Number($('cvSlip').value) || undefined });
      log(`${side} ${amount} on Base ${venue}: quoted ${C.fmtNum(tx.quoted, 6)}, floor ${C.fmtNum(tx.minOut, 6)} at ${tx.slippageBps}bps`);
      await runSteps(tx.steps);
      loadCurve(); loadBag();
    });
  });
}

async function loadCurve() {
  if (!S.sel) return;
  const eth = $('cvEth')?.value.trim() || '';
  const tok = $('cvTok')?.value.trim() || '';
  try {
    S.curve = await C.api('/api/curve', { ca: S.sel.address, eth: eth || null, tok: tok || null });
  } catch (e) {
    S.curve = null;
    $('cvNote').textContent = 'curve read failed: ' + e.message;
  }
  paintCurve();
}

function paintCurve() {
  const d = S.curve;
  if (!d) return;
  $('cvPx').textContent = d.onCurve ? `${C.fmtNum(d.priceNative, 6)} ETH` : 'graduated';
  $('cvState').textContent = d.onCurve
    ? 'still on the pad — buys mint from the curve'
    : 'off the pad: currentCurvePrice() is zero, so the pools are the only venue';
  $('cvHeld').textContent = d.padHolds != null ? C.fmtNum(d.padHolds, 5) : '—';

  const padBuy = d.buy?.tokensOut ?? null;
  const dexBest = d.dex.reduce((a, b) => ((b.tokensOut ?? 0) > (a?.tokensOut ?? 0) ? b : a), null);
  if (padBuy && dexBest?.tokensOut) {
    const edge = (padBuy / dexBest.tokensOut - 1) * 100;
    $('cvEdge').innerHTML = `<span class="${edge > 0 ? 'up' : 'down'}">${C.fmtPct(edge)}</span>`;
    $('cvEdgeNote').textContent = edge > 0
      ? `the pad hands you ${C.fmtPct(edge)} more tokens than ${dexBest.kind} for the same ETH`
      : `${dexBest.kind} is the cheaper buy right now`;
  } else { $('cvEdge').textContent = '—'; $('cvEdgeNote').textContent = 'quote a size to compare'; }

  const act = (venue) =>
    `<button class="btn small" data-trade="${venue}:buy">buy</button> <button class="btn small" data-trade="${venue}:sell">sell</button>`;
  const rows = [];
  if (d.onCurve) {
    rows.push(`<div class="tr" style="grid-template-columns:130px minmax(0,1fr) minmax(0,1fr) 170px">
      <div class="acc" style="font-weight:700">curve</div>
      <div class="r">${d.buy ? C.fmtNum(d.buy.tokensOut, 6) : '—'}</div>
      <div class="r">${d.sell ? C.fmtNum(d.sell.nativeOut, 6) : '—'}</div>
      <div>${act('curve')}</div></div>`);
  }
  for (const q of d.dex) {
    const venue = q.kind === 'v4-hooked' ? 'hooked' : 'hookless';
    rows.push(`<div class="tr" style="grid-template-columns:130px minmax(0,1fr) minmax(0,1fr) 170px">
      <div style="font-weight:700">${h(venue)}</div>
      <div class="r">${q.tokensOut != null ? C.fmtNum(q.tokensOut, 6) : '—'}</div>
      <div class="r">${q.nativeOut != null ? C.fmtNum(q.nativeOut, 6) : '—'}</div>
      <div>${act(venue)}</div></div>`);
  }
  $('cvRows').innerHTML = rows.join('') || '<div class="note">no venue on Base yet.</div>';
}

/* ================================================================ launch */

function mountLaunch() {
  $('tab-launch').innerHTML = `
    <div class="panel" style="margin:16px 0 12px">
      <div class="row" style="align-items:flex-start">
        <div style="flex:2;min-width:280px">
          <div class="row">
            <div style="flex:1;min-width:150px"><label class="f">name</label><input type="text" id="lnName" placeholder="Stacc Wif Omni" style="width:100%" /></div>
            <div style="flex:1;min-width:110px"><label class="f">ticker</label><input type="text" id="lnSymbol" placeholder="SWO" style="width:100%" /></div>
          </div>
          <div style="margin-top:12px"><label class="f">tagline</label><input type="text" id="lnTagline" placeholder="one line, shows on the site" style="width:100%" /></div>
          <div style="margin-top:12px"><label class="f">description</label><textarea id="lnDesc" rows="3" placeholder="goes into the token metadata" style="width:100%"></textarea></div>
          <div class="row" style="margin-top:12px">
            <div style="flex:1;min-width:140px"><label class="f">target raise (ETH)</label><input type="text" id="lnRaise" value="0.06" style="width:100%" /></div>
            <div style="flex:1;min-width:140px"><label class="f">creator buy (ETH, split 9 ways)</label><input type="text" id="lnBuy" value="0" style="width:100%" /></div>
          </div>
        </div>
        <div style="flex:1;min-width:210px">
          <label class="f">mark</label>
          <div style="border:1px solid #1e2530;background:#0d1014;border-radius:10px;padding:12px;text-align:center">
            <img id="lnPreview" alt="" style="width:120px;height:120px;border-radius:12px;background:#101319;object-fit:cover" src="/mark.svg" />
            <div style="margin-top:10px"><input type="file" id="lnFile" accept="image/*" style="font-size:11px;color:#7d8590;width:100%" /></div>
            <div class="dim" style="font-size:10.5px;margin-top:8px;text-wrap:pretty" id="lnImgNote">no file: a mark is generated from the ticker, deterministically, so a retry keeps the same logo.</div>
          </div>
        </div>
      </div>
      <div class="row" style="margin-top:14px;justify-content:space-between">
        <div class="dim" style="font-size:10.5px;max-width:640px;text-wrap:pretty">
          two signatures: the metadata upload is a server-side forward (their endpoint sends no CORS header), then your
          wallet signs the launch on Base. 0.0002 ETH fee plus whatever creator buy you set.
        </div>
        <button class="btn go" id="lnGo">launch</button>
      </div>
    </div>

    <div class="panel" style="margin-bottom:12px">
      <div class="row" style="justify-content:space-between;align-items:flex-end">
        <div class="grow"><label class="f">seed a launched CA across nine chains</label>
          <input type="text" id="lnSeedCa" placeholder="0x…" style="width:100%" /></div>
        <button class="btn go" id="lnSeedLoad">read state</button>
      </div>
      <div class="table" style="margin-top:14px">
        <div class="th" style="grid-template-columns:90px 110px minmax(0,1fr) minmax(0,1.6fr)">
          <div>chain</div><div>deployed</div><div>pools</div><div>steps</div>
        </div>
        <div id="lnSeedRows"></div>
        <div class="note">seeding is three moves per chain and they are ordered: the relayer deploys the CA, you bridge
          that chain's share of the float to it, then the relayer opens both pools from what it now holds. bridging to a
          chain with no contract burns supply that cannot be minted — so deploy is not optional, and the state here is
          read from the chain rather than from what the relay claims.</div>
      </div>
    </div>
    <div id="lnLog"></div>`;

  $('lnFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    S.launchImage = { data: b64, name: f.name };
    $('lnPreview').src = b64;
    $('lnImgNote').textContent = `${f.name} · ${(f.size / 1024).toFixed(0)} kB`;
  });

  $('lnGo').onclick = () => guard(async () => {
    const name = $('lnName').value.trim(); const symbol = $('lnSymbol').value.trim();
    if (!name || !symbol) { alert('name and ticker are required'); return; }
    if (!W.address) { await connect(); if (!W.address) return; }
    log(`uploading metadata for ${symbol}…`);
    const meta = await C.apiPost('/api/metadata', { name, symbol,
      description: $('lnDesc').value.trim() || $('lnTagline').value.trim(),
      image: S.launchImage?.data ?? null, imageName: S.launchImage?.name ?? null });
    log(`${meta.generated ? 'generated a mark · ' : ''}${meta.logoURI}`);
    const tx = await C.apiPost('/api/tx/launch', { name, symbol,
      tagline: $('lnTagline').value.trim(), logoURI: meta.logoURI,
      targetRaiseEth: $('lnRaise').value.trim() || '0.06',
      creatorBuyEth: $('lnBuy').value.trim() || '0' });
    const done = await runSteps(tx.steps);
    if (!done.length) return;
    const r = await C.apiPost('/api/launched', { hash: done[0].hash });
    log(`launched ${r.token}`, 'acc');
    $('lnSeedCa').value = r.token;
    S.launchMeta = { name, symbol, tagline: $('lnTagline').value.trim(), logoURI: meta.logoURI };
    discover();
    loadSeedState(r.token);
  });

  $('lnSeedLoad').onclick = () => {
    const ca = $('lnSeedCa').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) { alert('need a 0x address'); return; }
    loadSeedState(ca);
  };

  $('lnSeedRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seed]');
    if (!b) return;
    const [act, id] = b.dataset.seed.split(':');
    const ca = $('lnSeedCa').value.trim();
    guard(() => seedStep(act, Number(id), ca));
  });
}

async function loadSeedState(ca) {
  S.seedCa = ca;
  S.seed = {};
  paintSeed();
  await Promise.all(C.CHAINS.map(async (c) => {
    S.seed[c.id] = await C.api('/api/pools', { ca, chain: c.id }).catch(() => null);
    paintSeed();
  }));
  if (W.address) {
    S.seedBag = await C.api('/api/bag', { address: W.address, ca }).catch(() => null);
    paintSeed();
  }
}

function paintSeed() {
  const rows = $('lnSeedRows');
  if (!rows) return;
  if (!S.seedCa) { rows.innerHTML = ''; return; }
  rows.innerHTML = C.CHAINS.map((c) => {
    const s = S.seed[c.id];
    const bag = S.seedBag?.chains.find((x) => x.id === c.id);
    const dep = !s ? '…' : s.deployed ? '<span class="up">yes</span>' : '<span class="warn">no</span>';
    const pools = !s ? '…' : `${s.hooked ? '<span class="up">hooked</span>' : '<span class="dim">hooked</span>'} · ${s.hookless ? '<span class="up">hookless</span>' : '<span class="dim">hookless</span>'}`;
    const btn = (act, label, on) =>
      `<button class="btn small ${on ? '' : 'off'}" data-seed="${act}:${c.id}"${on ? '' : ' disabled'}>${label}</button>`;
    const acts = [
      btn('deploy', 'deploy', s && !s.deployed),
      c.id === C.HOME_CHAIN ? '' : btn('bridge', 'bridge share', Boolean(s?.deployed)),
      btn('wall', 'open pools', Boolean(s?.deployed && (!s.hooked || !s.hookless))),
      btn('check', 'recheck', true),
    ].filter(Boolean).join(' ');
    return `<div class="tr" style="grid-template-columns:90px 110px minmax(0,1fr) minmax(0,1.6fr)">
      <div style="font-weight:700">${h(c.short)}${bag?.token ? `<div class="dim" style="font-size:10px;font-weight:400">${C.fmtNum(bag.token, 4)}</div>` : ''}</div>
      <div>${dep}</div><div style="font-size:11px">${pools}</div><div>${acts}</div>
    </div>`;
  }).join('');
}

async function seedStep(act, chainId, ca) {
  const c = C.byId[chainId];
  if (act === 'check') { S.seed[chainId] = await C.api('/api/pools', { ca, chain: chainId }); paintSeed(); return; }

  if (act === 'deploy') {
    const meta = S.launchMeta ?? await recoverLaunchMeta(ca);
    log(`asking the relayer to deploy ${ca} on ${c.short}…`);
    const r = await C.apiPost('/api/relay', { action: 'deploy', chainId, token: ca,
      name: meta.name, symbol: meta.symbol, tagline: meta.tagline ?? '', logoURI: meta.logoURI,
      creator: W.address });
    log(r.skipped ? `${c.short}: already deployed` : `${c.short}: deploy ${r.hash ?? 'requested'}`, 'up');
  } else if (act === 'bridge') {
    if (!W.address) { await connect(); if (!W.address) return; }
    const bag = await C.api('/api/bag', { address: W.address, ca });
    const home = bag.chains.find((x) => x.id === C.HOME_CHAIN);
    const share = (home?.token ?? 0) / C.CHAINS.filter((x) => x.id !== C.HOME_CHAIN).length;
    const amount = prompt(`how much to bridge to ${c.short}?`, String(share.toFixed(6)));
    if (!amount) return;
    const tx = await C.apiPost('/api/tx/bridge', { ca, from: C.HOME_CHAIN, to: chainId,
      amount, recipient: W.address });
    const done = await runSteps(tx.steps);
    if (done.length) await requestMintFor(C.HOME_CHAIN, done[0].hash);
  } else if (act === 'wall') {
    log(`asking the relayer to open ${c.short}’s pools…`);
    const r = await C.apiPost('/api/relay', { action: 'wall', chainId, token: ca });
    log(`${c.short}: hooked ${r.hooked?.ok ? 'ok' : r.hooked?.reason ?? '—'}, hookless ${r.hookless?.ok ? 'ok' : r.hookless?.reason ?? '—'}`);
  }
  // The relay's answer is not evidence: it has reported failures for pools that
  // opened and successes for pools that did not. Read the chain.
  S.seed[chainId] = await C.api('/api/pools', { ca, chain: chainId }).catch(() => null);
  paintSeed();
}

async function recoverLaunchMeta(ca) {
  const t = S.tokens.find((x) => x.address.toLowerCase() === ca.toLowerCase());
  if (!t) throw new Error('no metadata for that CA — launch it here, or fill the launch form first');
  return { name: t.name ?? t.symbol, symbol: t.symbol, tagline: t.tagline ?? '', logoURI: t.logoURI ?? '' };
}

/* ================================================================ bridge */

function mountBridge() {
  const opts = C.CHAINS.map((c) => `<option value="${c.id}">${h(c.short)} · ${h(c.name)}</option>`).join('');
  $('tab-bridge').innerHTML = `
    <div class="panel" style="margin:16px 0 12px">
      <div class="row" style="align-items:flex-end">
        <div class="grow"><label class="f">token</label><input type="text" id="brCa" placeholder="0x…" style="width:100%" /></div>
        <div style="min-width:170px"><label class="f">from</label><select id="brFrom" style="width:100%">${opts}</select></div>
        <div style="min-width:170px"><label class="f">to</label><select id="brTo" style="width:100%">${opts}</select></div>
        <div style="min-width:170px"><label class="f">amount</label><input type="text" id="brAmt" placeholder="0" style="width:100%" /></div>
        <button class="btn go" id="brGo">bridge</button>
      </div>
      <div class="dim" style="margin-top:10px;font-size:10.5px;max-width:860px;text-wrap:pretty">
        your wallet signs the burn. the mint on the destination is a permissioned call only the relayer can make, so this
        asks for it straight afterwards — and if the relayer is down, the burn is still recorded on chain and shows up
        below as unminted, re-requestable, until it lands. that is the whole index: BridgeOut logs on the source,
        processed() on the destination. no database.
      </div>
    </div>
    <div class="table" style="margin-bottom:12px">
      <div class="th" style="grid-template-columns:110px minmax(0,1fr) minmax(0,1fr) 120px">
        <div>chain</div><div class="r">token balance</div><div class="r">native</div><div>use as source</div>
      </div>
      <div id="brRows"></div>
      <div class="note" id="brNote">connect a wallet to read balances.</div>
    </div>
    <div class="table" style="margin-bottom:12px">
      <div class="th" style="grid-template-columns:150px minmax(0,1fr) minmax(0,1.4fr) 140px">
        <div>burned → owed</div><div class="r">amount</div><div>message</div><div>act</div>
      </div>
      <div id="brPending"></div>
      <div class="note" id="brPendNote">burns that never minted, for the connected wallet.</div>
    </div>
    <div id="brLog"></div>`;
  $('brTo').value = String(C.HOME_CHAIN);
  $('brGo').onclick = () => guard(async () => {
    const ca = $('brCa').value.trim();
    const from = Number($('brFrom').value); const to = Number($('brTo').value);
    const amount = $('brAmt').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) { alert('need a token address'); return; }
    if (from === to) { alert('source and destination are the same chain'); return; }
    if (!amount || Number(amount) <= 0) { alert('set an amount'); return; }
    if (!W.address) { await connect(); if (!W.address) return; }
    const tx = await C.apiPost('/api/tx/bridge', { ca, from, to, amount, recipient: W.address });
    const done = await runSteps(tx.steps);
    if (done.length) await requestMintFor(from, done[0].hash);
    loadBridgeBag(); loadPending();
  });
  $('brRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    $('brFrom').value = b.dataset.src;
    const row = S.bridgeBag?.chains.find((c) => String(c.id) === b.dataset.src);
    if (row?.token) $('brAmt').value = String(row.token);
  });
  $('brPending').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mint]');
    if (!b) return;
    const [chain, hash] = b.dataset.mint.split(':');
    guard(() => requestMintFor(Number(chain), hash));
  });
}

/** Ask the relayer to mint a burn that already happened, then verify on chain. */
async function requestMintFor(chainId, hash) {
  log('asking the relayer to mint…');
  const r = await C.apiPost('/api/mint', { chain: chainId, hash });
  log(`mint requested: ${C.fmtNum(r.amount, 6)} ${r.from} → ${r.to}`);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((res) => setTimeout(res, 5000));
    const dst = C.CHAINS.find((c) => c.short === r.to);
    const m = await C.api('/api/minted', { chain: dst.id, messageId: r.messageId }).catch(() => null);
    if (m?.processed) { log(`minted on ${r.to}`, 'up'); loadPending(); return; }
  }
  log(`not minted yet — the burn is on chain and stays re-requestable (message ${C.short(r.messageId)})`, 'warn');
  loadPending();
}

async function loadBridgeBag() {
  if (!W.address || !S.sel) return;
  try { S.bridgeBag = await C.api('/api/bag', { address: W.address, ca: S.sel.address }); }
  catch { S.bridgeBag = null; }
  paintBridge();
}

async function loadPending() {
  if (!W.address) return;
  try { S.pending = await C.api('/api/pending', { address: W.address }); }
  catch { S.pending = null; }
  paintBridge();
}

function paintBridge() {
  const rows = $('brRows');
  if (!rows) return;
  const d = S.bridgeBag;
  if (!d) {
    rows.innerHTML = '';
    $('brNote').textContent = W.address ? 'pick a token on the board to read balances.' : 'connect a wallet to read balances.';
  } else {
    rows.innerHTML = d.chains.map((c) => `<div class="tr" style="grid-template-columns:110px minmax(0,1fr) minmax(0,1fr) 120px">
      <div style="font-weight:700">${h(c.short)}</div>
      <div class="r ${c.token > 0 ? '' : 'dim'}">${c.token != null ? C.fmtNum(c.token, 6) : '—'}</div>
      <div class="r soft">${c.native != null ? `${C.fmtNum(c.native, 5)} ${h(c.nativeSymbol)}` : '—'}</div>
      <div><button class="btn small" data-src="${c.id}">from ${h(c.short)}</button></div>
    </div>`).join('');
    $('brNote').textContent = `balances for ${C.short(d.address)} · ${C.fmtUsd(d.nativeUsdTotal)} of gas across nine chains`;
  }

  const p = $('brPending');
  if (!p) return;
  const stuck = S.pending?.stuck ?? [];
  p.innerHTML = stuck.map((s) => `<div class="tr" style="grid-template-columns:150px minmax(0,1fr) minmax(0,1.4fr) 140px">
    <div style="font-weight:700">${h(s.from)} → ${h(s.to ?? '?')}</div>
    <div class="r warn">${C.fmtNum(s.amount, 6)}</div>
    <div class="dim ell" style="font-size:10.5px">${h(C.short(s.messageId))}${s.txUrl ? ` · <a href="${h(s.txUrl)}" target="_blank" rel="noreferrer">burn</a>` : ''}</div>
    <div>${s.txHash ? `<button class="btn small" data-mint="${s.fromId}:${h(s.txHash)}">request mint</button>` : ''}</div>
  </div>`).join('');
  $('brPendNote').textContent = !W.address ? 'connect a wallet to scan for unminted burns.'
    : !S.pending ? 'scanning BridgeOut logs on all nine chains…'
    : stuck.length ? `${stuck.length} burn${stuck.length === 1 ? '' : 's'} owed a mint, ${C.fmtNum(S.pending.total, 6)} tokens, over the last ${S.pending.scannedBlocks.toLocaleString()} blocks per chain`
    : `nothing owed: every burn in the last ${S.pending.scannedBlocks.toLocaleString()} blocks per chain has been minted.`;
}

/* =================================================================== bag */

function mountBag() {
  $('tab-bag').innerHTML = `
    <div class="row" style="padding:16px 0 14px">
      <input type="text" id="bagAddr" class="grow" placeholder="wallet 0x… — reads native + token balance on all nine chains" />
      <button class="btn go" id="bagGo">read balances</button>
    </div>
    <div class="table">
      <div class="th" style="grid-template-columns:100px minmax(0,1fr) 100px minmax(0,1fr) 100px minmax(0,1.4fr)">
        <div>chain</div><div class="r">native</div><div class="r">usd</div><div class="r">token</div><div class="r">usd</div><div style="padding-left:14px">best exit</div>
      </div>
      <div id="bagRows"></div>
      <div class="row" style="padding:14px;font-size:11px;color:#5f6672;justify-content:space-between">
        <span style="flex:1;min-width:240px;text-wrap:pretty" id="bagNote">paste an address. read-only: this reads balances, it does not move them.</span>
        <span style="color:#e8e6e1;white-space:nowrap" id="bagTotal"></span>
      </div>
    </div>`;
  $('bagGo').onclick = loadBag;
}

async function loadBag() {
  const a = $('bagAddr').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { $('bagNote').textContent = 'need a 0x address'; return; }
  try { S.bag = await C.api('/api/bag', { address: a, ca: S.sel?.address }); }
  catch (e) { S.bag = null; $('bagNote').textContent = 'read failed: ' + e.message; return; }
  paintBag();
}

function paintBag() {
  const rows = $('bagRows');
  if (!rows || !S.bag) return;
  const px = S.beTok ? S.beTok.value : null;
  rows.innerHTML = S.bag.chains.map((c) => {
    const venues = S.venues.filter((v) => v.chain.id === c.id);
    let exit = 'no pool read'; let cls = 'dim';
    const tok = c.token ?? 0;
    if (tok > 0 && venues.length) {
      const raw = BigInt(Math.floor(tok * 1e18));
      let bestUsd = null; let bestV = null;
      for (const v of venues) {
        const s = C.sellTokenForNative(v.sqrtPriceX96, v.L, raw, v.lpFee || 3000, v.tick);
        const usd = C.fromWei(s.out, 18) * (S.nativeUsd[c.id] || 0);
        if (bestUsd == null || usd > bestUsd) { bestUsd = usd; bestV = v; }
      }
      exit = `${bestV.kind} → ${C.fmtUsd(bestUsd)}`; cls = 'acc';
    } else if (tok === 0) { exit = 'no bag here'; }
    return `<div class="tr" style="grid-template-columns:100px minmax(0,1fr) 100px minmax(0,1fr) 100px minmax(0,1.4fr)">
      <div style="font-weight:700">${h(c.short)}</div>
      <div class="r soft">${c.native != null ? `${C.fmtNum(c.native, 5)} ${h(c.nativeSymbol)}` : '—'}</div>
      <div class="r">${c.nativeUsd != null ? C.fmtUsd(c.nativeUsd) : '—'}</div>
      <div class="r soft">${c.token != null ? C.fmtNum(c.token, 4) : '—'}</div>
      <div class="r">${c.token != null && px ? C.fmtUsd(c.token * px) : '—'}</div>
      <div class="${cls}" style="font-size:10.5px;padding-left:14px">${h(exit)}</div>
    </div>`;
  }).join('');
  $('bagTotal').textContent = `total gas across nine chains ${C.fmtUsd(S.bag.nativeUsdTotal)}`;
  $('bagNote').textContent = 'native via eth_getBalance, token via balanceOf, both on all nine chains. “best exit” simulates selling the whole bag into each pool on that chain and keeps the better one — a bag on a chain whose pool saturates at a fraction of a cent is usually worth bridging somewhere deeper.';
}

boot();
