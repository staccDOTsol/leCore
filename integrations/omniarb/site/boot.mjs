// Start the desk with a fresh contract map.
//
// omnichain.family redeploys. Between two runs of this thing it has moved every
// router on nine chains, and — the reason this file exists — the launcher, which
// turned every launch into a bare "execution reverted" against a dead address.
// Nothing about that failure says "your addresses are stale"; it looks like a
// bad parameter, and it costs an hour.
//
// So the map is refreshed off the deployed frontend BEFORE anything imports it.
// config.mjs reads live-config.json at import time, which is why this is a
// separate entry point and not a call inside the server: the dynamic import
// below happens after the file on disk is already current.

import { fetchLiveConfig, readLiveConfig, writeLiveConfig } from '../src/refresh.mjs';

const before = readLiveConfig();
try {
  const live = await fetchLiveConfig();
  const moved = before && before.launcher?.toLowerCase() !== live.launcher?.toLowerCase();
  writeLiveConfig(live);
  console.log(`live config ${live.deployment} · launcher ${live.launcher}` +
    (moved ? `  (MOVED from ${before.launcher})` : ''));
} catch (e) {
  console.warn(`live config refresh failed (${e.message}) — using live-config.json as it stands, ` +
    `fetched ${before?.fetchedAt ?? 'never'}`);
}

const { start } = await import('./server.mjs');
start();
