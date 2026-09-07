import {
  createPublicClient, http, webSocket, encodeAbiParameters, keccak256,
  parseAbi, toHex,
} from 'viem';
import { CHAINS, endpoints } from './chains.mjs';
import { NATIVE, SCALE, FxBook, relayUnitPrice, fresh, poolPriceUsd,
  curvePriceUsd, marketComparisons } from './pricing.mjs';

const POOL_ABI = parseAbi(['function extsload(bytes32[] slots) view returns (bytes32[])']);
const TOKEN_ABI = parseAbi(['function decimals() view returns (uint8)']);
const CURVE_ABI = parseAbi(['function currentCurvePrice(address token) view returns (uint256)']);
const EVENTS = parseAbi([
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)',
]);
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function curveRegistrations(chain, evidence) {
  // Sewn/launchpad listings are chain-neutral. No Base/Robinhood allowlist:
  // deployment identity, quote currency and pricing ABI are per registration.
  const records = evidence?.curves ?? (evidence?.curve
    ? [{ id: 'legacy', protocol: 'hookrlaunchpad',
      priceMethod: 'currentCurvePrice', ...evidence.curve }]
    : [{ id: 'hookrlaunchpad', protocol: 'hookrlaunchpad' }, { id: 'sewn', protocol: 'sewn' }]);
  if (!Array.isArray(records) || records.length > 256) throw new Error('invalid curve registration budget');
  const ids = new Set();
  for (const record of records) {
    if (typeof record?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(record.id)
        || ids.has(record.id) || typeof record.protocol !== 'string') {
      throw new Error('invalid or duplicate curve registration');
    }
    ids.add(record.id);
  }
  return records;
}

export async function readCurves(client, chain, token, evidence, blockNumber, fx, now) {
  const markets = [];
  for (const curve of curveRegistrations(chain, evidence)) {
    const nativeUsd = fx.get(curve.quoteChainId, now);
    const market = { chainId: chain.id, token, venue: `curve:${curve.protocol}:${curve.id}`,
      protocol: curve.protocol, address: curve.address ?? null,
      observedAt: now, fxObservedAt: fx.entries.get(curve.quoteChainId)?.observedAt ?? null,
      quoteChainId: curve.quoteChainId ?? null, priceUsd: null, coverage: 'unverified', executable: false };
    // No inference that a new Sewn ABI or a non-ETH curve uses ETH wei.
    if (curve.units === 'wei-per-whole-token' && curve.priceMethod === 'currentCurvePrice'
        && CHAINS.some(c => c.id === curve.quoteChainId) && HASH.test(curve.codeHash ?? '')
        && /^0x[0-9a-fA-F]{40}$/.test(curve.address ?? '')) {
      try {
        const code = await client.getCode({ address: curve.address, blockNumber });
        if (!code || code === '0x' || keccak256(code) !== curve.codeHash.toLowerCase()) {
          throw new Error('curve identity mismatch');
        }
        const value = await client.readContract({ address: curve.address, abi: CURVE_ABI,
          functionName: 'currentCurvePrice', args: [token], blockNumber });
        market.priceUsd = nativeUsd ? curvePriceUsd(value, nativeUsd) : null;
        market.coverage = nativeUsd ? 'fresh' : 'missing-fx';
      } catch { market.coverage = 'unknown'; }
    }
    markets.push(market);
  }
  return markets;
}

export function poolId(token, hook) {
  return keyId({ currency0: NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: hook });
}

export function keyId(key) {
  return keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint24' },
    { type: 'int24' }, { type: 'address' },
  ], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

export function validateKey(key) {
  for (const field of ['currency0', 'currency1', 'hooks']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(key?.[field] ?? '')) throw new Error('invalid PoolKey address');
  }
  if (BigInt(key.currency0) >= BigInt(key.currency1)
      || !Number.isInteger(key.fee) || key.fee < 0 || key.fee > 0xffffff
      || !Number.isInteger(key.tickSpacing) || key.tickSpacing <= 0 || key.tickSpacing > 32767) {
    throw new Error('invalid PoolKey order/fee/tick spacing');
  }
  return { currency0: key.currency0.toLowerCase(), currency1: key.currency1.toLowerCase(),
    hooks: key.hooks.toLowerCase(), fee: key.fee, tickSpacing: key.tickSpacing };
}

export class PoolRegistry {
  constructor(keys = []) {
    this.pools = new Map();
    for (const key of keys) this.add(key, null);
  }

  add(raw, blockNumber, expectedId = null) {
    const key = validateKey(raw);
    const id = keyId(key);
    if (expectedId && id !== expectedId.toLowerCase()) throw new Error('Initialize PoolKey/id mismatch');
    if (!this.pools.has(id) && this.pools.size >= 4096) throw new Error('pool discovery budget exceeded');
    this.pools.set(id, { id, key, blockNumber,
      venue: `${key.hooks === NATIVE ? 'hookless' : 'hooked'}:${id}` });
  }

  rewind(fromBlock) {
    for (const [id, pool] of this.pools) {
      if (pool.blockNumber !== null && pool.blockNumber >= fromBlock) this.pools.delete(id);
    }
  }

  apply(logs) {
    for (const log of logs) {
      if (log.eventName !== 'Initialize') continue;
      if (log.removed) { this.pools.delete(log.args.id.toLowerCase()); continue; }
      if (typeof log.blockNumber !== 'bigint') throw new Error('Initialize missing block number');
      this.add(log.args, log.blockNumber, log.args.id);
    }
  }

  values() { return [...this.pools.values()].sort((a, b) => a.id.localeCompare(b.id)); }
}

export function stateSlots(id, mappingSlot) {
  if (typeof mappingSlot !== 'bigint' || mappingSlot < 0n || mappingSlot >= 1n << 256n) {
    throw new Error('invalid verified mapping slot');
  }
  const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }],
    [id, mappingSlot]));
  return [base, toHex((BigInt(base) + 3n) % (1n << 256n), { size: 32 })];
}

export function decodeState(words) {
  if (!Array.isArray(words) || words.length !== 2 || words.some(w => !HASH.test(w))) {
    throw new Error('malformed pool storage response');
  }
  const slot = BigInt(words[0]);
  const sqrtPriceX96 = slot & ((1n << 160n) - 1n);
  const tickRaw = Number((slot >> 160n) & ((1n << 24n) - 1n));
  return { sqrtPriceX96, tick: tickRaw >= 1 << 23 ? tickRaw - (1 << 24) : tickRaw,
    liquidity: BigInt(words[1]) & ((1n << 128n) - 1n),
    initialised: sqrtPriceX96 !== 0n };
}

// Trust roots are explicit local evidence, never learned from the current RPC.
// An RPC-provided hash checked against itself would "verify" any deployment.
export async function verifiedLayout(client, chain, evidence, blockNumber) {
  if (!evidence || evidence.chainId !== chain.id
      || evidence.poolManager?.toLowerCase() !== chain.poolManager
      || !HASH.test(evidence.managerCodeHash ?? '')
      || !HASH.test(evidence.sourceSha256 ?? '')
      || typeof evidence.mappingSlot !== 'string' || !/^\d+$/.test(evidence.mappingSlot)
      || evidence.layout !== 'uniswap-v4-pool-state-v1'
      || evidence.proxy !== false) throw new Error('missing verified PoolManager layout');
  const code = await client.getCode({ address: chain.poolManager, blockNumber });
  if (!code || code === '0x' || keccak256(code) !== evidence.managerCodeHash.toLowerCase()) {
    throw new Error('PoolManager runtime identity mismatch');
  }
  return BigInt(evidence.mappingSlot);
}

export async function readPools(client, chain, token, evidence, blockNumber, registered = null) {
  const mappingSlot = await verifiedLayout(client, chain, evidence, blockNumber);
  const pools = registered ?? ['hooked', 'hookless'].map(venue => {
    const key = { currency0: NATIVE, currency1: token, fee: 3000, tickSpacing: 60,
      hooks: venue === 'hooked' ? chain.hook : NATIVE };
    return { venue, id: keyId(key), key };
  });
  if (pools.length === 0) return [];
  const slots = pools.flatMap(pool => stateSlots(pool.id, mappingSlot));
  const words = await client.readContract({
    address: chain.poolManager, abi: POOL_ABI, functionName: 'extsload',
    args: [slots], blockNumber,
  });
  if (words.length !== slots.length) throw new Error('incomplete pool batch');
  return pools.map((pool, i) => ({ ...pool, ...decodeState(words.slice(i * 2, i * 2 + 2)) }));
}

export async function fetchFx(chain, fx, fetcher = fetch, now = Date.now()) {
  const destination = chain.id === 1 ? 8453 : 1;
  const response = await fetcher('https://api.relay.link/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: '0x0000000000000000000000000000000000000001',
      originChainId: chain.id, destinationChainId: destination,
      originCurrency: NATIVE, destinationCurrency: NATIVE,
      amount: SCALE.toString(), tradeType: 'EXACT_INPUT',
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('Relay quote unavailable');
  const details = (await response.json()).details;
  const input = relayUnitPrice(details?.currencyIn, chain.id);
  const output = relayUnitPrice(details?.currencyOut, destination);
  const elapsed = Date.now() - now;
  if (elapsed < 0 || elapsed > fx.maxAgeMs) throw new Error('expired FX request');
  if (chain.nativeSymbol === 'ETH' && (input > output ? input - output : output - input)
      * 10_000n > output * fx.maxDeviationBps) throw new Error('inconsistent ETH FX');
  fx.set(chain.id, input, now);
  // Destination data is checked but must not overwrite a conflicting observation.
  fx.set(destination, output, now);
}

export async function backfill(client, address, from, to, span = 1000n, events = EVENTS) {
  if (span <= 0n || from < 0n || to < from) throw new Error('invalid log range');
  const logs = [];
  for (let start = from; start <= to; start += span) {
    const end = start + span - 1n > to ? to : start + span - 1n;
    const batch = await client.getLogs({ address, events, fromBlock: start, toBlock: end });
    if (!Array.isArray(batch)) throw new Error('unknown log coverage');
    if (logs.length + batch.length > 100_000) throw new Error('log discovery budget exceeded');
    logs.push(...batch);
  }
  return logs;
}

export class ChainMonitor {
  constructor(chain, token, { client, wsClient = null, evidence = null, fx = new FxBook(),
    maxAgeMs = 60_000 } = {}) {
    this.chain = chain; this.token = token; this.client = client; this.wsClient = wsClient;
    this.evidence = evidence; this.fx = fx; this.maxAgeMs = maxAgeMs;
    this.cursor = null; this.invalidated = false;
    this.streamHealthy = false; this.unwatch = null;
    this.reorgDetected = false;
    this.registry = new PoolRegistry(evidence?.poolKeys ?? []);
    this.discoveryComplete = false;
  }

  start(onChange = () => {}) {
    if (!this.wsClient || this.chain.id === 4663) return;
    this.unwatch = this.wsClient.watchEvent({
      address: this.chain.poolManager, events: EVENTS, poll: false,
      onLogs: logs => {
        this.streamHealthy = true;
        if (logs.some(log => log.removed)) this.reorgDetected = true;
        this.invalidated = true; onChange();
      },
      onError: () => { this.streamHealthy = false; this.invalidated = true; onChange(); },
    });
  }

  stop() { this.unwatch?.(); }

  async snapshot(now = Date.now()) {
    const base = { chainId: this.chain.id, chain: this.chain.name, token: this.token,
      observedAt: now, executionEnabled: false,
      transport: this.wsClient ? 'websocket+reconciliation' : 'polling',
      coverageGap: this.chain.id === 4663 ? 'Robinhood: polling only; no Alchemy stream'
        : this.streamHealthy ? null : 'websocket unavailable or not yet observed',
      markets: [], pools: [], warnings: [] };
    try {
      if (await this.client.getChainId() !== this.chain.id) throw new Error('RPC chain mismatch');
      const head = await this.client.getBlock({ blockTag: 'latest' });
      if (head.number === null || !HASH.test(head.hash) || !fresh(Number(head.timestamp) * 1000,
        now, this.maxAgeMs)) throw new Error('stale or malformed chain head');
      if (this.cursor) {
        const previous = await this.client.getBlock({ blockNumber: this.cursor.number });
        if (previous.hash !== this.cursor.hash || head.number < this.cursor.number) this.reorgDetected = true;
      }
      // Revisit recent blocks even after a successful subscription: reconnects
      // and removed logs are hints, never a replacement for canonical state.
      let start = this.cursor && !this.reorgDetected && head.number >= this.cursor.number
        ? this.cursor.number : head.number > 20n ? head.number - 20n : 0n;
      const origin = this.evidence?.discoveryFromBlock;
      if (this.reorgDetected || !this.cursor) {
        if (typeof origin === 'string' && /^\d+$/.test(origin) && BigInt(origin) <= head.number) {
          start = BigInt(origin);
          this.discoveryComplete = true;
        } else this.discoveryComplete = false;
      }
      const logs = await backfill(this.client, this.chain.poolManager, start, head.number, 1000n,
        !this.cursor || this.reorgDetected ? [EVENTS[0]] : EVENTS);
      this.registry.rewind(start);
      this.registry.apply(logs);
      base.discovery = this.discoveryComplete ? 'configured-range' : 'partial-recent-blocks';
      if (!this.discoveryComplete) base.warnings.push('historical pool discovery incomplete');
      const tokenDecimals = await this.client.readContract({
        address: this.token, abi: TOKEN_ABI, functionName: 'decimals', blockNumber: head.number,
      });
      const nativeUsd = this.fx.get(this.chain.id, now);
      const fxObservedAt = this.fx.entries.get(this.chain.id)?.observedAt ?? null;
      let pools = [];
      try {
        // Include arbitrary PoolKeys discovered by Initialize, not just 3000/60.
        // Legacy pair candidates remain diagnostics when history is unavailable.
        const registered = this.registry.values();
        pools = await readPools(this.client, this.chain, this.token, this.evidence, head.number,
          registered.length ? registered : null);
      } catch {
        base.warnings.push('pool prices blocked: layout/runtime verification missing or RPC read failed');
      }
      for (const pool of pools) {
        base.pools.push({ ...pool, chainId: this.chain.id, poolManager: this.chain.poolManager,
          blockNumber: head.number,
          blockHash: head.hash, executable: false,
          quoteAdapter: 'unverified',
        });
        // Keep all intermediate-token pools in the graph, but never assign them
        // a target/native USD price without the required currency observations.
        if (pool.key.currency0 !== NATIVE || pool.key.currency1 !== this.token.toLowerCase()) continue;
        const priceUsd = nativeUsd && pool.initialised
          ? poolPriceUsd(pool.sqrtPriceX96, tokenDecimals, 18, nativeUsd) : null;
        base.markets.push({ ...pool, chainId: this.chain.id, token: this.token,
          observedAt: now, fxObservedAt, priceUsd,
          coverage: !pool.initialised ? 'no-market' : !nativeUsd ? 'missing-fx'
            : pool.liquidity === 0n ? 'no-active-liquidity' : 'fresh' });
      }
      base.markets.push(...await readCurves(this.client, this.chain, this.token, this.evidence,
        head.number, this.fx, now));
      const canonical = await this.client.getBlock({ blockNumber: head.number });
      if (canonical.hash !== head.hash) throw new Error('reorg during snapshot');
      base.blockNumber = head.number; base.blockHash = head.hash; base.stateRoot = head.stateRoot;
      base.reorgDetected = this.reorgDetected;
      base.coverage = pools.length > 0 && nativeUsd ? 'fresh' : 'incomplete';
      this.cursor = { number: head.number, hash: head.hash };
      this.reorgDetected = false; this.invalidated = false;
    } catch {
      base.coverage = 'unknown'; base.markets = []; base.pools = [];
      base.warnings.push('RPC/state coverage unknown; excluded from comparisons');
    }
    return base;
  }
}

export function createMonitors(token, evidence = {}, env = process.env) {
  const fx = new FxBook();
  return CHAINS.map(chain => {
    const urls = endpoints(chain, env);
    return new ChainMonitor(chain, token, {
      client: createPublicClient({ transport: http(urls.http, { timeout: 12_000, retryCount: 2 }) }),
      wsClient: urls.ws ? createPublicClient({ transport: webSocket(urls.ws, {
        timeout: 12_000, retryCount: 2,
      }) }) : null,
      evidence: evidence[String(chain.id)], fx,
    });
  });
}

export async function scan(monitors) {
  // Serial FX requests avoid a quote burst and conflicting shared ETH updates.
  for (const monitor of monitors) {
    try { await fetchFx(monitor.chain, monitor.fx); }
    catch { monitor.fx.entries.delete(monitor.chain.id); }
  }
  const chains = await Promise.all(monitors.map(monitor => monitor.snapshot()));
  const comparisons = marketComparisons(chains.flatMap(chain => chain.markets), Date.now());
  return { mode: 'read-only', fundedTrading: false, automaticBridging: false,
    chains, signals: comparisons.signals, signalSearchTruncated: comparisons.truncated };
}
