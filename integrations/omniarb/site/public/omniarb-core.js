// omniarb-core.js — the desk's engine.
//
// keccak256, a minimal ABI codec, Uniswap v4 pool-state reads and single-tick
// swap math, plus thin wrappers over this server's proxies. No dependencies.
//
// Two things are deliberately NOT done in the browser:
//
//   * Birdeye. The key stays in the server process; the page asks /api/be for a
//     path and gets an answer. A key shipped to the client is a published key.
//   * Raw RPC. Half the public endpoints send no CORS header and the rest rate
//     limit hard, so reads go through /api/rpc, which carries the same failover
//     list the bot uses.

/* ---------- keccak256 ---------- */
const M = (1n << 64n) - 1n;
const RC = ["1","8082","800000000000808a","8000000080008000","808b","80000001","8000000080008081",
  "8000000000008009","8a","88","80008009","8000000a","8000808b","800000000000008b","8000000000008089",
  "8000000000008003","8000000000008002","8000000000000080","800a","800000008000000a","8000000080008081",
  "8000000000008080","80000001","8000000080008008"].map(h => BigInt("0x" + h));
const ROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;

function keccakF(A) {
  for (let r = 0; r < 24; r++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    const D = new Array(5);
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++)
      B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++)
      A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & M) & B[(x + 2) % 5 + 5 * y]);
    A[0] ^= RC[r];
  }
  return A;
}

export function keccak256Bytes(bytes) {
  const rate = 136;
  const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 1) / rate) * rate);
  padded.set(bytes);
  padded[len] = 0x01;
  padded[padded.length - 1] |= 0x80;
  let A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 17; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    A = keccakF(A);
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out += Number(lane & 0xffn).toString(16).padStart(2, "0"); lane >>= 8n; }
  }
  return out;
}

export const hexToBytes = (h) => {
  h = h.replace(/^0x/, "");
  if (h.length % 2) h = "0" + h;
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
};
export const keccakHex = (hex) => "0x" + keccak256Bytes(hexToBytes(hex));
export const keccakText = (s) => "0x" + keccak256Bytes(new TextEncoder().encode(s));

/* ---------- abi bits ---------- */
export const word = (v) => {
  if (typeof v === "bigint" || typeof v === "number") return BigInt(v).toString(16).padStart(64, "0");
  return String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");
};
export const hexToBig = (h) => BigInt(h && h !== "0x" ? h : "0x0");
export const bitsOf = (w, lo, len) => (hexToBig(w) >> BigInt(lo)) & ((1n << BigInt(len)) - 1n);

export function decodeString(data, slot = 0) {
  const h = data.replace(/^0x/, "");
  const off = Number(BigInt("0x" + h.slice(slot * 64, slot * 64 + 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(off, off + 64)));
  const body = h.slice(off + 64, off + 64 + len * 2);
  return new TextDecoder().decode(hexToBytes(body));
}
export const decodeStringPair = (data) => [decodeString(data, 0), decodeString(data, 1)];
export const addr = (w) => "0x" + w.replace(/^0x/, "").slice(-40);
export const toInt24 = (v) => (v >= 1n << 23n ? Number(v - (1n << 24n)) : Number(v));

/* ---------- chains (integrations/omniarb/live-config.json, verified live) ---------- */
export const FACTORY = "0xCF8C621000514043bC7AdFd3afD2fCF391fC761e";
export const PORTAL = "0xa3324d514708049883167aD817Db97Aefe29c96c";
export const PAD = "0xd21cff13e2d2d9a39e450e97e29dd930108a327c";
export const TOPIC_DEPLOY = "0x03900b19b57eae1ba0347c51f7e5d3725c7eccc4ca914d44035b2023c0ed2d3b";
export const FEE = 3000, TICK_SPACING = 60;
export const HOME_CHAIN = 8453;

// One line per chain on the price chart needs a categorical palette, not a ramp.
// These seven are the Birdeye-covered chains, in this order, validated for the
// dark surface: OKLCH lightness inside the dark band, chroma above the gray
// floor, adjacent pairs separated under simulated protanopia and deuteranopia,
// and every one of them at least 3:1 against the card background. The aggregate
// keeps the interface accent (#c9f24d) and is drawn thick, so it never has to be
// told apart from a chain line by hue alone.
export const AGG_COLOR = "#c9f24d";

export const CHAINS = [
  { id: 4663, name: "Robinhood", short: "RH", explorer: "https://rh-scan.com", poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", hook: "0x816b4043fE55B9a982C2BaeFB746c9F541C380Cc", router: "0xca60e703598aE645Fc2a99456004096c1577084C", launcher: "0x62B0Bc3aE794fC6A4D7a3809063Bf777a9947345", from: 55377450, gas: "ETH", be: "robinhood", color: "#4a86e8", helper: null, fullScan: true },
  { id: 8453, name: "Base", short: "Base", explorer: "https://basescan.org", poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b", hook: "0xCe5d52C0C2345260502872b6108d0cE2559280cc", router: "0x3EC4d75F9fE806155f10B75AD8787d09fAb81229", launcher: "0xe3DCd4B6fE0B7B86234036E6d37bf5D2f2bdB857", from: 50927698, gas: "ETH", be: "base", color: "#d95f2b", helper: "0x189e4849a12c0ed6e6ef0486afe9d5760c125aee", curve: true },
  { id: 1, name: "Ethereum", short: "ETH", explorer: "https://etherscan.io", poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90", hook: "0xF1233150D60D96f4f9086a535738B53625a980cC", router: "0x40622206731b1Ae558E2De70a0144ba77E23a082", launcher: null, from: 25913286, gas: "ETH", be: "ethereum", color: "#0fa58f", helper: null },
  { id: 42161, name: "Arbitrum", short: "Arb", explorer: "https://arbiscan.io", poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32", hook: "0x552658E4Dcb00C069aB97244489C830a87b380cc", router: "0x184FF6D1601Dc1a8B2F42AcB37959519B3313C75", launcher: null, from: 502103226, gas: "ETH", be: "arbitrum", color: "#b3901f", helper: null },
  { id: 56, name: "BNB", short: "BNB", explorer: "https://bscscan.com", poolManager: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF", hook: "0x2E119e43217CEe9ba42bB153C4F8A81226D400cC", router: "0x074c69eDa671f05fC89c130Be78B5e4b8e8a65C9", launcher: null, from: 120168189, gas: "BNB", be: "bsc", color: "#dd5f9e", helper: null },
  { id: 137, name: "Polygon", short: "Pol", explorer: "https://polygonscan.com", poolManager: "0x67366782805870060151383F4BbFF9daB53e5cD6", hook: "0xd14B20a40B605879D250902b024cC41B677500cc", router: "0x78Ff5aC7987096faa0e161C0445c0A9b5A86272f", launcher: null, from: 93288779, gas: "POL", be: "polygon", color: "#9370e0", helper: null },
  { id: 480, name: "World", short: "Wld", explorer: "https://worldscan.org", poolManager: "0xb1860D529182ac3BC1F51Fa2ABd56662b7D13f33", hook: "0x03f4051e621EE3F3652aDeF2c453458a777e40cc", router: "0x028F91F642cB4e1cbe0f5b6361356b55b843E918", launcher: null, from: 34651246, gas: "ETH", be: null, color: "#7d8590", helper: "0x9ff204baeeedf2f6cc9951f8ab182ccebf7ade35" },
  { id: 59144, name: "Linea", short: "Lin", explorer: "https://lineascan.build", poolManager: "0x248083Fb965359d82b06C1F5322480Dcfc1AD857", hook: "0xB8dD684F503C3386595D4A8886F29e0388B100cC", router: "0xCFF35Fad62B292108817d572f231a190B309dcA9", launcher: null, from: 31944078, gas: "ETH", be: null, color: "#7d8590", helper: null },
  { id: 143, name: "Monad", short: "Mon", explorer: "https://monadvision.com", poolManager: "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e", hook: "0xe89ab12A7DcA7B4cB269002826Dab40B04D440cC", router: "0x11494b3f427F9D36b220878f0d6a2cEF7C6Bdb9c", launcher: null, from: 102273109, gas: "MON", be: "monad", color: "#7ea310", helper: null },
];
export const byId = Object.fromEntries(CHAINS.map(c => [c.id, c]));
export const painted = () => CHAINS.filter(c => c.be);

// Native asset price feeds, by chain. Wrapped-native on a chain Birdeye covers.
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const NATIVE_FEED = {
  4663: [WETH, "ethereum"], 8453: ["0x4200000000000000000000000000000000000006", "base"],
  1: [WETH, "ethereum"], 42161: ["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "arbitrum"],
  56: ["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "bsc"],
  137: ["0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "polygon"],
  480: [WETH, "ethereum"], 59144: [WETH, "ethereum"], 143: [null, null],
};

/* ---------- rpc (through this server's proxy) ---------- */
let rid = 0;
const chainIdOf = (c) => Number(typeof c === "object" ? c.id : c);

async function post(chain, payload) {
  const r = await fetch(`/api/rpc?chain=${chainIdOf(chain)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error("rpc " + r.status);
  return r.json();
}

export async function rpc(chain, method, params = []) {
  const j = await post(chain, { jsonrpc: "2.0", id: ++rid, method, params });
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

// Public RPCs cap batch size, so chunk and fall back to single calls when a node
// refuses batching outright.
export async function rpcBatch(chain, calls, chunk = 10) {
  if (!calls.length) return [];
  if (calls.length > chunk) {
    const parts = [];
    for (let i = 0; i < calls.length; i += chunk) parts.push(calls.slice(i, i + chunk));
    const res = await Promise.all(parts.map(p => rpcBatch(chain, p, chunk)));
    return res.flat();
  }
  const body = calls.map(c => ({ jsonrpc: "2.0", id: ++rid, method: c.method, params: c.params || [] }));
  const j = await post(chain, body);
  if (!Array.isArray(j)) {
    return Promise.all(calls.map(c => rpc(chain, c.method, c.params || []).catch(() => null)));
  }
  const map = new Map(j.map(x => [x.id, x]));
  return body.map(b => { const x = map.get(b.id); return x && !x.error ? x.result : null; });
}
export const call = (chain, to, data) => rpc(chain, "eth_call", [{ to, data }, "latest"]);

/* ---------- this server's own api ---------- */
export async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const r = await fetch(path + (qs ? "?" + qs : ""));
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `${path} ${r.status}`);
  return j;
}
export async function apiPost(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `${path} ${r.status}`);
  return j;
}

/* ---------- v4 pool state ---------- */
export const poolIdFor = (token, hooks) => {
  const [c0, c1] = ["0x0000000000000000000000000000000000000000", token];
  return keccakHex(word(c0) + word(c1) + word(FEE) + word(TICK_SPACING) + word(hooks || "0x0"));
};
export const poolStateSlot = (pid) => keccakHex(word(pid) + word(6));
export const slotPlus = (slot, n) => "0x" + (BigInt(slot) + BigInt(n)).toString(16).padStart(64, "0");
export const extsloadData = (slot) => "0x1e2eaeaf" + word(slot);

export function decodeSlot0(w) {
  if (!w || /^0x0*$/.test(w)) return null;
  const sqrtPriceX96 = bitsOf(w, 0, 160);
  if (sqrtPriceX96 === 0n) return null;
  const pf = bitsOf(w, 184, 24);
  return { sqrtPriceX96, tick: toInt24(bitsOf(w, 160, 24)),
    protocolFee0: Number(pf & 0xfffn), protocolFee1: Number(pf >> 12n), lpFee: Number(bitsOf(w, 208, 24)) };
}

const Q96 = 1n << 96n;
export const priceFromSqrt = (sq, d0 = 18, d1 = 18) => {
  const x = Number(sq) / Number(Q96);
  return x * x * 10 ** (d0 - d1); // token1 per token0, decimal-adjusted
};
export const tickToPrice = (t) => Math.pow(1.0001, t);

// currency0 = native, currency1 = token.
// Swaps are clamped to the CURRENT tick-spacing range: liquidity beyond it is not
// discoverable without the tick bitmap, and these pools saturate inside one range anyway.
export const sqrtAtTick = (t) => BigInt(Math.floor(Math.pow(1.0001, t / 2) * 2 ** 96));
export const rangeOf = (tick, spacing = TICK_SPACING) => {
  const lower = Math.floor(tick / spacing) * spacing;
  return [sqrtAtTick(lower), sqrtAtTick(lower + spacing)];
};

// native in -> token out (price falls toward the range's lower bound)
export function buyTokenForNative(sqrtP, L, amountInNative, feePpm, tick) {
  if (L <= 0n || amountInNative <= 0n) return { out: 0n, used: 0n, saturated: false };
  const [lo] = rangeOf(tick);
  const feeMul = BigInt(1e6 - feePpm);
  let amt = amountInNative * feeMul / 1000000n;
  const num = L * Q96;
  let next = num * sqrtP / (num + amt * sqrtP);
  let saturated = false;
  if (next < lo) {
    next = lo; saturated = true;
    amt = num * (sqrtP - next) / (next * sqrtP); // exact native the range can absorb
  }
  const used = amt * 1000000n / feeMul;
  return { out: L * (sqrtP - next) / Q96, used: used > amountInNative ? amountInNative : used, saturated };
}

// token in -> native out (price rises toward the range's upper bound)
export function sellTokenForNative(sqrtP, L, amountInToken, feePpm, tick) {
  if (L <= 0n || amountInToken <= 0n) return { out: 0n, used: 0n, saturated: false };
  const [, hi] = rangeOf(tick);
  const feeMul = BigInt(1e6 - feePpm);
  let amt = amountInToken * feeMul / 1000000n;
  let next = sqrtP + (amt * Q96) / L;
  let saturated = false;
  if (next > hi) { next = hi; saturated = true; amt = L * (next - sqrtP) / Q96; }
  const used = amt * 1000000n / feeMul;
  return { out: L * Q96 * (next - sqrtP) / (next * sqrtP),
    used: used > amountInToken ? amountInToken : used, saturated };
}

/* ---------- birdeye, through the server ---------- */
const beCache = new Map();
export async function birdeye(path, params = {}, chain = "base", ttl = 20000) {
  const key = chain + "|" + path + "|" + new URLSearchParams(params).toString();
  const hit = beCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  let v = null;
  try { v = await api("/api/be", { path, chain, ...params }); } catch { v = null; }
  beCache.set(key, { t: Date.now(), v });
  return v;
}
export const bePrice = (address, chain) => birdeye("/defi/price", { address, include_liquidity: "true" }, chain);
export const beMulti = (list, chain) => birdeye("/defi/multi_price", { list_address: list.join(","), include_liquidity: "true" }, chain);
export const beHistory = (address, chain, hours = 24, type = "15m") =>
  birdeye("/defi/history_price", { address, address_type: "token", type,
    time_from: Math.floor(Date.now() / 1000) - hours * 3600, time_to: Math.floor(Date.now() / 1000) }, chain, 60000);
export const beOverview = (address, chain) => birdeye("/defi/token_overview", { address }, chain, 60000);

/* ---------- formatting ---------- */
export const fmtUsd = (v) => v == null || !isFinite(v) ? "—" :
  Math.abs(v) >= 1000 ? "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 }) :
  Math.abs(v) >= 1 ? "$" + v.toFixed(2) :
  Math.abs(v) >= 0.01 ? "$" + v.toFixed(4) :
  v === 0 ? "$0" : "$" + v.toPrecision(3);
export const fmtNum = (v, p = 4) => v == null || !isFinite(v) ? "—" :
  v === 0 ? "0" : Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toPrecision(p);
export const fmtPct = (v) => v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
export const short = (a) => !a ? "" : a.slice(0, 6) + "…" + a.slice(-4);
export const fromWei = (v, d = 18) => Number(v) / 10 ** d;
export const ago = (ts) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};
export const clock = (ts) => new Date(ts * 1000).toLocaleString(undefined,
  { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
