# integrations/

Plugins, adapters, and glue code that surface leCore (or leCore-backed services such
as openzoo) inside third-party applications. This directory is the home for anything
whose *runtime host is another app* — code here is loaded by that app, not imported
by the leCore engine.

## Structure

### Omniarb research integration

`omniarb/` is an isolated Node 22+ integration, not a dependency of the NumPy
engine. It monitors omnichain token venues and provides **paper/simulation-only**
atomic and non-atomic route analysis. It has no funded-trading or automatic
bridging command. Here, “curve” means **HookrLaunchpad**, not Curve Finance.

Commands from `/home/runner/work/leCore/leCore/integrations/omniarb`:

```sh
npm ci
npm test
npm run compile
npm run scan
npm run watch
```

`scan` emits JSON once; `watch` combines WebSocket invalidation with canonical
log backfills and 30-second state reconciliation. `RPC_<chainId>`,
`WS_RPC_<chainId>` and `ALCHEMY_API_KEY` select endpoints. Endpoints and keys
are not printed in reports. Robinhood is explicitly polling-only; unavailable
streams, RPC failures, stale heads and missing FX are coverage gaps, not prices.
The default token is `0x9a5baa12664c89cfbf5cfcd9d0d4805bdcab29e8`; `--token`
overrides it. `--evidence /absolute/path/deployments.local.json` supplies local
verification evidence. Local evidence files are ignored by git.

**Candidate addresses are not verified deployments.** The chain map is sourced
from commit `7819a31dee086ffe128668533af5121ae205f315` of the referenced
integration, not from a successful live audit. No trusted runtime hashes or
storage layouts are fabricated. Without independent evidence, pool reads are
blocked, even when an RPC responds.

The monitor's evidence file maps decimal chain IDs to records containing:

- `chainId`, `poolManager`, `managerCodeHash`, `sourceSha256`,
  `layout: "uniswap-v4-pool-state-v1"`, `mappingSlot` (decimal string), and
  `proxy: false`. Hashes must be derived from independently reviewed deployment
  sources; matching a hash collected from the same RPC is not verification.
- `discoveryFromBlock` (decimal string) starts historical `Initialize` discovery.
  Optional `poolKeys` seeds known keys. Arbitrary currencies, fees, tick spacings,
  and hook addresses are preserved; discovery is not limited to the original
  hooked/hookless pair. Without a start block, historical coverage is explicitly
  partial. Discovery budgets fail closed rather than silently truncating data.
- Optional `curve: { address, codeHash, units: "wei-per-whole-token" }` permits
  a curve spot read. Curve execution remains disabled until sellability,
  reserves, graduation behavior and atomic composition are verified.

Every pool's slot0/liquidity is batched at one block. Native-target USD prices
respect raw token/native orientation and token decimals; intermediate-token
pools remain available for graph routing without inventing a USD price.
USD and token arithmetic use integers, not JavaScript floating-point amounts.
Relay FX divides each side's USD valuation by that side's own token quantity,
checks native currency identity and freshness, and never defaults to 1:1.

Route search is bounded, not a claim of global optimality. Independent hop quotes
only discover candidates: an atomic route needs a whole-sequence simulation with
shared pool state, final balance checks, gas/L1 costs and a profit reserve.
Unsupported hooks/adapters are blocked. A displayed cross-chain price gap is
not an atomic route. Non-atomic inventory routes explicitly track unmatched
exposure, reservations, receipt reconciliation and recovery; a timeout does not
authorize resubmission. A delayed bridge remains reserved after the 90-second
alert. No burn or mint is submitted by this integration.

The Solidity executor's supported router-pair path is narrower than graph
discovery: new pool keys need a compatible, reviewed execution adapter rather
than being silently routed through the original 3000/60 pool. The fork test
requires a local Anvil fork and explicit deployment evidence; a skipped fork
test is **not** deployment verification. Public-network transactions are not
part of the test suite. Unit tests exercise pricing, coverage, route selection
and lifecycle logic without claiming live profitability.

Programmatic entry points:

- `src/aggregator.mjs`: `researchRoutes` connects monitor snapshots to explicit
  adapter assignments keyed by `chainId:poolManager:poolId`. `adapters` supply
  supported directed quotes; a whole-route simulator and economic evaluator
  are required to select a paper candidate. All intermediate pools are retained;
  missing adapters appear in `rejectedPools`. The CLI exposes this coverage but
  does not install or trust arbitrary adapter code.
- `src/routes.mjs`: `buildRouteGraph` and `searchRoutes` support arbitrary
  PoolKeys, bounded multi-hop cycles, and explicit inventory/rebalancing edges.
  Budgets and truncation are reported. Alternative routes cannot be summed as
  split allocations; joint split execution is not implemented.
- `src/execution.mjs`: `verifyDeployment` and `simulateRoundTrip` verify the
  restricted executor's runtime, immutable configuration and reviewed contract
  identities, then simulate the exact transaction at a pinned block.
- `src/nonatomic.mjs`: `assessNonAtomic` and `PaperNonAtomicLedger` cover
  prefunded cross-chain matched trades and same-chain two-transaction trades.
  Identity certificates and final receipt observations are explicitly external
  assertions, not automatic proof. Quotes must match per-leg block pins;
  same-chain legs must share a pin. Venue identifiers may name any discovered
  pool, while curve execution remains blocked.
- `src/journal.mjs`: `updateJournal` persists `serialize()`/`restore()` ledger
  transitions using exclusive locks, file and directory fsync, and atomic
  rename. Reducers are bookkeeping only. A failed or interrupted update leaves
  the lock in place for reconciliation; restart cannot silently retry a leg.
  This is a single-writer paper journal, not a funded transaction dispatcher.

The gas hurdle means **profit after trading and bridge/rebalancing costs,
before gas, must cover at least three times gas**. Costs already inside
simulated outputs are not charged again. Cross-chain assessments additionally
reserve adverse-move capital and require explicit inventory, gas, exposure and
loss limits. A relayer outage does not disable local paper opportunities when
their own inventory and gas reserves remain sufficient.

One subfolder per target application, named after the app:

```
integrations/
├── README.md                      ← this file
├── openzoo/                       ← THE OTHER DIRECTION: how openzoo, as the HOST,
│   └── PLATFORM_GUIDE.md            runs leCore server-side — booting with both ends,
│                                    per-user partitions, /tools + /invoke, teaching,
│                                    sharing, early exit. Every other folder here points
│                                    a CLIENT AT openzoo; this one is openzoo USING
│                                    leCore, so rule 3 (no engine imports) does not
│                                    apply to it: openzoo is the host, not a client.
├── OpenWebUI/                     ← self-hosted AI chat harness (plugin: Pipe function)
│   ├── README.md
│   └── openzoo_pipe.py            ← manifold Pipe: openzoo as a model provider
├── LibreChat/                     ← multi-user AI chat platform (config: yaml)
│   ├── README.md
│   └── librechat.openzoo.yaml     ← ready-to-merge custom endpoint block
├── Continue/                      ← AI coding assistant, VS Code/JetBrains (config: yaml)
│   ├── README.md
│   └── config.openzoo.yaml        ← ready-to-merge models entries
├── aider/                         ← terminal AI pair programmer (config: env)
│   ├── README.md
│   └── openzoo.env                ← source-able OPENAI_API_BASE/KEY exports
├── SillyTavern/                   ← LLM chat frontend (UI-config only; README documents it)
│   └── README.md
├── AnythingLLM/                   ← document chat / RAG app (UI-config only; README documents it)
│   └── README.md
├── Hermes/                        ← Nous Research agent harness (config: yaml)
│   ├── README.md
│   └── config.openzoo.yaml        ← provider: custom block; `hermes model` interactive alt
├── Cursor/                        ← AI code editor (UI-config only; README documents it)
│   └── README.md                  ← incl. known limits: autocomplete stays on Cursor's backend
├── Cline/                         ← VS Code/JetBrains coding agent (UI-config only; README)
│   └── README.md                  ← also covers Roo Code (same provider form)
└── GrokCLI/                       ← superagent-ai grok-cli terminal agent (config: json/env)
    ├── README.md
    └── models.openzoo.json        ← provider entry for ~/.grok/models.json
```

An integration takes whatever the smallest sufficient form is: a real plugin file
(OpenWebUI), a mergeable config snippet (LibreChat, Continue, aider), or — when the
host app is configured entirely through its UI — a README alone (SillyTavern,
AnythingLLM). A README-only folder is a legitimate integration; the folder existing
is what makes it discoverable.

Future subfolders that belong here: `ComfyUI/` (if the node pack ever moves
in-repo), `Cursor/`, `Cline/`, `Slack/` — always the app's own name, matching its
official capitalization.

## The openzoo platform: two surfaces, one wallet

Every integration here targets one or both of openzoo's surfaces:

1. **OpenAI-compatible chat proxy** — `npx openzoo` → `http://localhost:8402/v1`.
   Model ids are provider-prefixed (e.g. `nvidia/nemotron-3.5-lightning`) and come
   from `GET /v1/models` (free, no payment). Streaming (SSE) is passed through
   unbuffered. Oversized bodies are priced at a counterfactual discount because
   the zoo's leCore memory spills them server-side (~10× cheaper than direct);
   short prompts price at a 3× passthrough markup — receipts name which base
   applied, and print on the proxy console per call.
2. **MCP server** — `npx openzoo mcp` (stdio). Tools: `zoo_ask` (corpus up to
   ~1M tokens + question → answer + receipt), `zoo_models`, `zoo_wallet`. MCP
   hosts (Cursor, Cline, Claude Desktop, Windsurf) should wire BOTH surfaces —
   chat for ordinary completions, MCP for the giant-corpus flagship.

Both surfaces share the burner wallet at `~/.openzoo/wallet.json`. Spend safety:
the proxy refuses any single quote above `OPENZOO_MAX_USD_PER_CALL` (default
$0.50). Fund with plain USDC; `npx openzoo address` / `npx openzoo balance`.

## Rules for this directory

These differ deliberately from the core engine rules, because the host app — not
leCore — dictates the environment:

1. **Host conventions win.** A file here follows the target app's plugin format
   (frontmatter, class shapes, required method names) even where that conflicts
   with leCore style. E.g. OpenWebUI functions require `pydantic` — acceptable
   here, never in core.
2. **Core constraints still bleed through where possible.** WHY-comments, a
   `_selftest()` that runs the pure logic without a network, and kept negatives
   recorded in comments. An integration file should still read like leCore code.
3. **No engine imports.** Integrations talk to leCore over HTTP (`/invoke`, the
   OpenAI facade) or to openzoo's endpoint — never `import lecore`. This keeps
   them installable inside the host app with zero leCore install.
4. **Each subfolder is self-documenting.** Every app folder carries its own
   `README.md` with install steps, configuration, and troubleshooting. A user
   should be able to land in `integrations/<App>/` and succeed without reading
   anything else in the repo.
5. **Not part of the test suite or the wheel.** Nothing here ships in the
   `leos-core` PyPI package, and CI does not import it (host-app dependencies
   aren't installed there). Each file's `python3 <file>` selftest is the
   verification contract.

## Why a separate top-level folder

`tools/` is for scripts *we* run against the repo; `holographic/` is the engine;
`integrations/` is code *other apps* run. Keeping the boundary hard prevents the
engine from ever growing a dependency on a host app's SDK, and makes it obvious at
a glance what is safe to vendor elsewhere.
