import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getAddress } from 'viem';
import { DEFAULT_TOKEN } from './chains.mjs';
import { createMonitors, scan } from './monitor.mjs';
import { researchRoutes } from './aggregator.mjs';

const { values } = parseArgs({ options: {
  token: { type: 'string', default: DEFAULT_TOKEN },
  evidence: { type: 'string' },
  watch: { type: 'boolean', default: false },
} });
const token = getAddress(values.token.toLowerCase());
const evidence = values.evidence ? JSON.parse(await readFile(values.evidence, 'utf8')) : {};
const monitors = createMonitors(token, evidence);
let running = false;
let stopped = false;
let timer;
async function update() {
  if (running || stopped) return;
  running = true;
  try {
    const report = await scan(monitors);
    // Default scan has no trusted quote adapters: expose the coverage gap, do
    // not promote newly initialized pools into executable opportunities.
    report.routing = await researchRoutes(report);
    console.log(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  } finally { running = false; }
}
if (values.watch) {
  for (const monitor of monitors) monitor.start(() => void update());
  timer = setInterval(() => void update(), 30_000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopped = true; clearInterval(timer);
    for (const monitor of monitors) monitor.stop();
  });
}
await update();
