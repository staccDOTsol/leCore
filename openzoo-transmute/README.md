# openzoo-transmute

Transmute a Vercel-shaped app — Next.js `pages/api`, app-router `route.ts`, or
a Vite repo with `api/*.js` — into **(a)** a Rust [Pinocchio](https://github.com/anza-xyz/pinocchio)
Solana program that hosts the `/api/*` Lambdas as instruction routes and
**(b)** the static build stored in program-derived accounts; deploy it to
Solana; serve it through a local gateway that speaks the same routes Vercel
would.

```
vercel build  ─►  .vercel/output/{config.json, static/, functions/*.func}
                                    │
openzoo build ─►  .zoo-out/.zoo/{crate/ (Rust), manifest.json, deploy/<site>.so, static-plan.json}
openzoo deploy ─► program id + one asset account per file + /.zoo/manifest.json
openzoo serve ─►  http://127.0.0.1:4402/  (GET = free simulation, POST = signed transaction)
```

The whole reverse-engineering — what `vercel build` emits, what the Lambda
receives from `@vercel/node-bridge`, what Fluid Compute changes, the term-by-term
mapping, the limits, the cost model and the security notes — is in
[`docs/VERCEL_TO_SOLANA.md`](docs/VERCEL_TO_SOLANA.md). The patch that mounts
these commands in `npx openzoo` is [`docs/OPENZOO_CLI_PATCH.md`](docs/OPENZOO_CLI_PATCH.md).

## How it works

* **The Lambda contract becomes instruction data.** Vercel's bridge hands a
  function `{method, path, headers, body}` and expects `{statusCode, headers,
  body}`. `lib/wire.js` and `runtime/zoo-host/src/wire.rs` are that pair as
  bytes: `[tag][route][method][path][query][headers][body]` in, `[status][headers][body]`
  out via `set_return_data` plus `sol_log_data` chunks.
* **Each handler becomes a Rust route.** The compiler (`lib/compile/`) lowers
  the JS subset it accepts onto `zoo_host::{Ctx, Val}` — a JS-semantics dynamic
  value with `req.query`/`req.body`/`res.json`/`Response.json`/`kv.*`/`process.env`
  implemented in `runtime/zoo-host/src/{ctx,val,json,kv}.rs`. Anything outside
  the subset (network, fs, timers, regex, classes…) is reported with `file:line`
  and the rest of the app still builds.
* **`static/` becomes asset PDAs.** One rent-exempt account per file, written in
  900-byte chunks, writes gated by the program's upgrade authority
  (`runtime/zoo-host/src/assets.rs`). `@vercel/kv` becomes KV PDAs the program
  discovers by dry run.
* **Reads are free, writes are transactions.** `GET/HEAD/OPTIONS` run as
  `simulateTransaction` (no signature, no fee); everything else is a signed
  transaction paid by the gateway wallet. Without a wallet the gateway answers
  `402` — the seam where openzoo's x402 flow plugs in.

## Install

```sh
# stand-alone
npx openzoo-transmute help

# or through the openzoo CLI once docs/OPENZOO_CLI_PATCH.md is applied
npx openzoo build | deploy | serve | inspect
```

Requirements: Node ≥ 18, and for `build`/`deploy` the Solana toolchain
(`cargo build-sbf`): `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`.
`build --skip-cargo` works without it (you get the crate and the cost sheet, no `.so`).

## Quickstart

```sh
cd my-next-app                      # or a Vite repo with api/*.js, or a .vercel/output
npx openzoo-transmute inspect       # the app in Vercel terms + eligibility report
npx openzoo-transmute build         # → .zoo-out/.zoo/{crate,manifest.json,deploy/*.so}
npx openzoo-transmute deploy --cluster devnet
npx openzoo-transmute serve <programId> --cluster devnet
open http://127.0.0.1:4402/         # explorer at /.zoo/, manifest at /.zoo/manifest.json
```

`inspect` prints one line per function with its route, style, runtime,
`maxDuration`, `memory` and methods, marks each `✓`/`✗` and says why:

```
functions (2):
  ✓ /api/hello                       pages        nodejs20.x  10s   1024MB  any
      pages/api/hello.js  env=GREETING
  ✓ /api/counter                     app          nodejs20.x  10s   1024MB  POST
      app/api/counter/route.js  env=GREETING
```

`deploy` prints the rent sheet before spending anything and refuses mainnet
without `--yes`:

```
  item                                bytes       SOL
  program account                        36    0.0011
  program data (2×.so = 382,048 B)  382,093    2.6603
  /app.js                                60    0.0013
  /index.html                           101    0.0016
  /.zoo/manifest.json (manifest)        939    0.0074
  rent total                                   2.6717
  + tx fees (approx.)                          0.0011
  TOTAL                                        2.6728
```

Then `serve` maps HTTP onto the program:

```
GET /                    → 200 text/html          (asset PDA, etag, 304 on If-None-Match)
GET /api/hello?name=zoo  → 200 {"hello":"zoo",...}  x-zoo-simulated: true, x-zoo-cu: 16595
POST /api/counter        → 200 {"hits":1}           x-zoo-signature: <tx>, x-zoo-simulated: false
POST /api/counter        → 402 payment required     (gateway started without a keypair)
```

## CLI reference

| command | what it does |
|---|---|
| `build [dir] [--out .zoo-out] [--name <crate>] [--arch v0\|v3] [--cluster <c>] [--skip-cargo] [--json]` | read the app (`lib/vercel.js`), transmute (`lib/compile/`), write `<out>/.zoo/{crate/, manifest.json, report.json, static-plan.json, build.json}`, run `cargo build-sbf --arch <arch>` → `.zoo/deploy/<name>.so`, print the cost sheet. Default arch is `v0` (mainnet); `deploy` re-detects the cluster's SBPF version and rebuilds if needed. Exit code 2 when nothing was eligible |
| `deploy [dir\|outDir] [--cluster mainnet\|devnet\|testnet\|localnet\|<url>] [--keypair <path>] [--yes] [--program <id>] [--concurrency 4] [--skip-assets] [--force] [--json]` | deploy or upgrade the program (keypair kept at `.zoo/program-keypair.json`, so redeploys upgrade in place), upload every static file (unchanged ones skipped by comparing bytes on chain), write `/.zoo/manifest.json`, record `.zoo/deploy.json` |
| `serve [programId] [--cluster <c>] [--port 4402] [--host 127.0.0.1] [--keypair <path>] [--quiet]` | the local gateway; `programId` defaults to the last `.zoo/deploy.json`. Reads are simulated, writes are signed by the wallet; without a wallet writes answer 402 |
| `inspect [dir] [--json]` | the Vercel model (functions, static files, routes, crons) plus the eligibility report |
| `status <programId> [--cluster <c>] [--json]` | program account, authority, `maxDataLen`, deploy slot, and the on-chain manifest |
| `help`, `--version` | |

Environment: `OPENZOO_CLUSTER` (default `mainnet`), `OPENZOO_RPC` (mainnet RPC
URL), `OPENZOO_KEYPAIR` / `OPENZOO_WALLET` (signer path), `OPENZOO_DEBUG=1`
(stack traces). Signer discovery order (`lib/wallet.js`): `--keypair` →
`OPENZOO_KEYPAIR` → `OPENZOO_WALLET` or `~/.openzoo/wallet.json` (the openzoo
burner, `{solana:[64 bytes]}` or a bare `solana-keygen` array) → `~/.config/solana/id.json`.

Gateway responses carry `x-zoo-program`, `x-zoo-route`, `x-zoo-simulated`,
`x-zoo-cu`, `x-zoo-signature` (writes) and `x-zoo-asset` (static); route params
reach the handler as `x-zoo-param-<name>` headers. `413` above 900 body bytes,
`405` when an app-router file does not export the method, `502` with the last
program log lines when the instruction fails, `404` JSON (or the app's
`handle: error` route) otherwise.

## The generated crate

`build` writes a crate that depends on the runtime by path. For the sample app
above (`pages/api/hello.js` + `app/api/counter/route.js`) it looks like this:

```toml
# .zoo-out/.zoo/crate/Cargo.toml
[package]
name = "my-site"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
pinocchio = "0.11.2"
zoo-host = { path = "<openzoo-transmute>/runtime/zoo-host" }

[profile.release]
overflow-checks = false
lto = "fat"
codegen-units = 1
opt-level = 3
```

```rust
// .zoo-out/.zoo/crate/src/lib.rs (excerpt)
#![no_std]
extern crate alloc;
use pinocchio::{AccountView, Address, ProgramResult};
use zoo_host::{Ctx, Val, Route};

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

const ENV: &[(&str, &str)] = &[("GREETING", "hi")];        // .env.production, baked in
const ROUTES: &[Route] = &[route_0, route_1];                // index = manifest.routes[i].index

// pages/api/hello.js:
//   export default function handler(req, res) {
//     res.status(200).json({ hello: req.query.name || 'world', n: Number(req.query.n) * 2 })
//   }
fn route_0(cx: &mut Ctx) -> Result<(), Val> {
    let mut o = Val::obj();
    let q = cx.req_query();
    let name = { let l = q.get_str("name"); if l.truthy() { l } else { Val::str("world") } };
    o.set_str("hello", name);
    o.set_str("n", Val::Num(q.get_str("n").to_num()).mul(&Val::Num(2.0)));
    cx.res_status(&Val::Num(200.0));
    cx.res_json(&o);
    Ok(())
}

// app/api/counter/route.js:
//   export async function POST() { const n = await kv.incr('hits'); return Response.json({ hits: n }) }
fn route_1(cx: &mut Ctx) -> Result<(), Val> {
    let n = cx.kv_incrby(&Val::str("hits"), &Val::Num(1.0))?;   // `?` = the KV account is missing → discovery
    let mut o = Val::obj();
    o.set_str("hits", n);
    cx.respond_json(&o, &Val::Undef);
    Ok(())
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    zoo_host::dispatch(program_id, accounts, data, ROUTES, ENV)
}
```

`Route = fn(&mut Ctx) -> Result<(), Val>`; `Err(v)` is a thrown JS value and
answers 500 like a crashed Lambda; returning without responding answers 504 like
a Lambda that never ended its response. The `.so` for this crate is ~190 KB and
`GET /api/hello` costs ~16.6 k compute units.

## Tests

```sh
cd openzoo-transmute
npm install --no-audit --no-fund
npm test                                   # node --test test/*.test.js
```

The unit tests need no chain. The end-to-end tests deploy the sample program
and drive the gateway against a **local validator**; they skip themselves with a
reason when either is missing:

```sh
# 1. toolchain (once)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 2. a validator with a funded wallet (keep it running in another shell)
solana-test-validator --reset
solana airdrop 100 --url http://127.0.0.1:8899   # ~/.config/solana/id.json

# 3. the sample site program (test validator = SBPF v3; mainnet = v0)
cd <sample-site>; cargo build-sbf --arch v3      # → target/deploy/sample_site.so

# 4. run
OPENZOO_TEST_RPC=http://127.0.0.1:8899 npm test
```

`test/gateway.test.js` looks for the sample `.so` and a validator at
`OPENZOO_TEST_RPC` (default `http://127.0.0.1:8899`); `test/build.test.js`
probes `localnet` for real rent numbers and falls back to the 6.96 SOL/MB rule.
The runtime crate also builds on the host (`cd runtime/zoo-host && cargo build`;
its `Cargo.toml` pulls the sha2/curve25519 fallbacks for non-SBF targets), and
for the chain: `cargo build-sbf --arch v3` (test validator) or `--arch v0` (mainnet).

## Repository layout

```
bin/openzoo-transmute.js     the executable (→ lib/cli.js run())
lib/cli.js                   build · deploy · serve · inspect · status
lib/vercel.js                the Vercel deployment model (Build Output API v3 reader / synthesizer)
lib/eligibility.js           what can run on chain, with reasons
lib/compile/                 JS → Rust (parse.js: acorn + TS stripping; lowering onto zoo_host)
lib/build.js                 crate + manifest + cargo build-sbf + cost sheet
lib/deploy.js                deploy / upgrade + assets + manifest
lib/gateway.js               the local HTTP front (routes, static, 402/413 seams, explorer)
lib/solana.js                loader (deploy/upgrade in pure JS), assets, KV, invoke + discovery
lib/wire.js                  the bridge contract as bytes, PDAs
lib/wallet.js                signer discovery, cluster URLs
runtime/zoo-host/            the no_std pinocchio runtime the generated crate links
docs/VERCEL_TO_SOLANA.md     the reverse-engineering document
docs/OPENZOO_CLI_PATCH.md    mounting build/deploy/serve in npx openzoo
```

## Limits at a glance

| | |
|---|---|
| request body | 900 B (one transaction is 1232 B) |
| response | ≤ 1024 B in return data, ≈ 7 KB through log chunks |
| KV value | 10 000 B JSON per key |
| compute | 400 k CU requested, 1.4 M max |
| clock | seconds |
| rent | 6.96 SOL per MB of static + program bytes, 2 × the `.so` reserved |
| not supported | network, fs, timers, randomness, regex, classes, streaming, `waitUntil`, ISR, crons, middleware, local imports |

## Roadmap

* **Browser fork / `sol://` scheme** — a browser that resolves
  `sol://<programId>/path` straight from the RPC (assets from PDAs, `/api/*`
  through `simulateTransaction`), so a site needs no gateway and no domain.
* **x402-paid writes through the openzoo proxy** — the gateway already answers
  `402` with an `x402` stub for mutating requests when it has no signer; next is
  letting the openzoo proxy pay per request from the burner wallet so a public
  gateway never holds keys.
* **Chunked request bodies** — bodies > 900 B staged into a request account over
  several transactions (the same mechanism assets already use), then referenced
  by the invoke.
* **Response accounts** — responses > ~7 KB written into a per-request account
  and read back by the gateway, instead of the log buffer.
* Compiler coverage: local imports, `RegExp`, base64 (`atob`/`btoa`), `cookies()`,
  `URLSearchParams`, more of `@vercel/kv` (`hget`, lists, `expire`).

License: MIT.
