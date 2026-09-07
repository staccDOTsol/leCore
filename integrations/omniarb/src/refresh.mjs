// Pulling the live contract map off omnichain.family.
//
// The addresses are not stable. Between two sessions of this bot the site
// redeployed every router on all nine chains while leaving the factory, the
// launcher and the hooks alone — and a bot holding stale routers keeps quoting
// and trading against contracts the app has already moved off.
//
// So the addresses are scraped from the deployed frontend, which is the one
// place guaranteed to match what the app itself is using, and written to
// live-config.json for config.mjs to overlay on the built-in defaults.

import { writeFileSync, readFileSync } from 'node:fs';
import { API } from './config.mjs';

const STORE = new URL('../live-config.json', import.meta.url);

/** The app's config lives in a shared chunk; find it by what it contains. */
async function findConfigChunk() {
  const page = await fetch(`${API}/launch`, { signal: AbortSignal.timeout(25_000) });
  if (!page.ok) throw new Error(`GET /launch -> ${page.status}`);
  const html = await page.text();

  const dpl = html.match(/dpl_[A-Za-z0-9]+/)?.[0] ?? null;
  const chunks = [...html.matchAll(/\/_next\/static\/chunks\/([^"?]+\.js)/g)].map((m) => m[1]);

  for (const name of [...new Set(chunks)]) {
    const url = `${API}/_next/static/chunks/${name}${dpl ? `?dpl=${dpl}` : ''}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!r?.ok) continue;
    const js = await r.text();
    if (js.includes('poolManager:') && js.includes('factoryFromBlock:')) return { js, name, dpl };
  }
  throw new Error('could not find the config chunk in the deployed bundle');
}

/** Pull one `{id:…, poolManager:…, hook:…, router:…}` entry per chain. */
function parseChains(js) {
  const out = [];
  const re = /\{id:(\d+),name:"([^"]+)",short:"([^"]+)",rpc:"([^"]+)",explorer:"([^"]+)",poolManager:"(0x[0-9a-fA-F]{40})",hook:"(0x[0-9a-fA-F]{40})",router:"(0x[0-9a-fA-F]{40})",launcher:([^,]+),factoryFromBlock:(\d+)n\}/g;
  for (const m of js.matchAll(re)) {
    const launcherRaw = m[9];
    const launcher = /^"0x[0-9a-fA-F]{40}"$/.test(launcherRaw)
      ? launcherRaw.slice(1, -1)
      : null; // a bare identifier means a shared constant, resolved below
    out.push({
      id: Number(m[1]), name: m[2], short: m[3], rpc: m[4], explorer: m[5],
      poolManager: m[6], hook: m[7], router: m[8],
      launcherRef: launcher ? null : launcherRaw,
      launcher,
      factoryFromBlock: m[10],
    });
  }
  return out;
}

/** The factory / launcher / portal defaults, which sit behind NEXT_PUBLIC_* fallbacks. */
function parseConstants(js) {
  const grab = (name) => js.match(
    new RegExp(`${name},"(0x[0-9a-fA-F]{40})"`))?.[1] ?? null;
  const factory = grab('NEXT_PUBLIC_FACTORY');
  const portal = grab('NEXT_PUBLIC_PORTAL');

  // The launcher default is a minified identifier assigned earlier; resolve the
  // first `let x="0x…"` binding that the chain list refers to.
  const launcherVar = js.match(/NEXT_PUBLIC_LAUNCHER,([A-Za-z_$][\w$]*)\)/)?.[1] ?? null;
  let launcher = null;
  if (launcherVar) {
    launcher = js.match(new RegExp(`\\b${launcherVar.replace(/\$/g, '\\$')}="(0x[0-9a-fA-F]{40})"`))?.[1] ?? null;
  }
  const pad = js.match(/let [A-Za-z_$][\w$]*="(0x[0-9a-fA-F]{40})",[A-Za-z_$][\w$]*="(0x[0-9a-fA-F]{40})"/);
  return { factory, portal, launcher, padCandidate: pad?.[2] ?? null };
}

/**
 * Scrape the live app and return the current contract map. Never writes on a
 * partial parse — a half-read config is worse than a stale one.
 */
export async function fetchLiveConfig() {
  const { js, name, dpl } = await findConfigChunk();
  const chains = parseChains(js);
  if (chains.length < 5) throw new Error(`only parsed ${chains.length} chains — bundle shape changed`);

  const consts = parseConstants(js);
  for (const c of chains) {
    if (!c.launcher && c.launcherRef) {
      // Bare identifier: either the shared launcher constant or the zero address.
      const val = js.match(new RegExp(`\\b${c.launcherRef.replace(/[.$]/g, '\\$&')}="?(0x[0-9a-fA-F]{40})"?`))?.[1];
      c.launcher = val && !/^0x0{40}$/.test(val) ? val : (consts.launcher ?? null);
      if (c.launcherRef.includes('.X')) c.launcher = null; // t.X is the zero address
    }
    delete c.launcherRef;
  }

  return {
    fetchedAt: new Date().toISOString(),
    deployment: dpl, chunk: name,
    factory: consts.factory, portal: consts.portal, launcher: consts.launcher,
    chains,
  };
}

export function readLiveConfig() {
  try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return null; }
}

export function writeLiveConfig(cfg) {
  writeFileSync(STORE, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** What changed between the built-in defaults and what the app is using now. */
export function diffAgainst(builtin, live) {
  const rows = [];
  for (const lc of live.chains) {
    const bc = builtin.find((x) => x.id === lc.id);
    if (!bc) { rows.push({ chain: lc.short, field: 'chain', from: '—', to: 'new' }); continue; }
    for (const f of ['poolManager', 'hook', 'router']) {
      if (bc[f].toLowerCase() !== lc[f].toLowerCase()) {
        rows.push({ chain: lc.short, field: f, from: bc[f], to: lc[f] });
      }
    }
  }
  return rows;
}
