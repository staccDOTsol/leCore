# openzoo.fun operations manual (v0.7.80)

*Everything an operator needs, specific and current. The tool table in §2 and
every tool count on this page are pinned to `holographic_mcp._TOOLS` by
`tests/test_openzoo_operations_doc.py` — if they disagree with the code, that test
fails CI and names the drifted tool. Regenerate with
`python3 tests/test_openzoo_operations_doc.py --write` (it rewrites only the fenced
table and the counts; the prose is hand-written). This file is deliberately not in
`tools/regen_docs.py`, which owns only docs regenerated in full — an earlier version
of this page claimed that guard without having it, and drifted 26 → 40 unnoticed.*

## 1. Boot

    LECORE_PARTITION=/srv/openzoo/partition \
    python3 holographic_mcp.py           # MCP server; tool pin = 40

- **`LECORE_PARTITION`** — your operator memory (a directory holding
  `learning/state.lecore`). Absent → the shipped `release_bundle/` loads (62 generic
  entries, leakage-audited 0/4).
- **`LECORE_MODEL`** — optional model directory for `autoboot(llm="auto")` /
  `attach_runtime`; attribution is automatic, **`LECORE_NO_ATTRIBUTION=1`** disables.
- **`LECORE_MEMORIES`** — root for named memory portfolios (`memory_list`).

Build your operator memory with `tools/make_seed.py facts.md seed_dir/` (verified:
every fact answers at T0 from a fresh boot; held-out probes must escalate; leaky
seeds are refused) or distill a working partition with `tools/distill_release.py`
(every exclusion itemized by reason).

## 2. The 40 hosted tools (generated from source)

Row numbers are the count; the last row must equal the `tools/list` length and the
`_selftest()` name pin in `holographic_mcp.py`.

<!-- BEGIN GENERATED TOOL TABLE: python3 tests/test_openzoo_operations_doc.py --write -->

| # | Tool | Description |
|---|---|---|
| 1 | `lecore_map` | THE TERRITORY IN ONE CALL: leCore's capability families, what you should never hand-roll in ... |
| 2 | `lecore_find` | BEFORE implementing any algorithm, math routine, data structure, or file format yourself ... |
| 3 | `lecore_describe` | Full contract for one faculty: what it does, a runnable example, and its parameters. |
| 4 | `corpus_bind` | Bind a corpus once: pass documents (or one long text, auto-chunked) and get a handle. The zoo ... |
| 5 | `corpus_ask` | Ask a bound corpus anything: BM25-ranked chunks with scores, best first. leCore retrieves; the ... |
| 6 | `corpus_delta` | Chunk-level DELTA bind (the rsync move): probe with chunk_hashes=[sha256 hex,...] to learn ... |
| 7 | `study` | MACRO comprehension of a directory ON THE SERVER (the limitless-context door): one call walks ... |
| 8 | `study_ask` | Ask a studied tree a question: idf-weighted lexical retrieval with a DECLARED verdict ... |
| 9 | `wisdom_record` | Bequeath a lesson to the persistent memory with AUTHORSHIP: provenance wisdom:<author> travels ... |
| 10 | `wisdom_ask` | Inherit bequeathed lessons with attribution -- what past models chose to pass on, in their own ... |
| 11 | `series_analyze` | Market/telemetry series analysis in one call: DEMUX hidden components (stride table), detect ... |
| 12 | `dataset_decompose` | Take UNLABELED data apart: a 1-D series returns the additive LAW that generates it (MDL-gated ... |
| 13 | `fact_check` | Check claims instead of vibing them: every 'expr == value' is COMPUTED (wrong ones come back ... |
| 14 | `scene_create` | TEXT -> 3D -> IMAGE: describe a scene in plain words ('a red metal sphere and a small blue ... |
| 15 | `scene_adjust` | Talk to a live scene: 'make the sphere bigger', 'change the box to glass', 'move the light ... |
| 16 | `scene_export` | Realize a scene's objects to meshes and return ASCII STL text -- the open exchange format ... |
| 17 | `image_tool` | 2D create & edit: op=pattern generates procedural fields (fbm/checker/stripes/dots/gradient) ... |
| 18 | `math_eval` | Check math instead of vibing it: 'expr == value' claims are parsed and COMPUTED (wrong ones ... |
| 19 | `chart_make` | Numbers -> a readable chart: deterministic SVG line \| bar \| scatter with axes, ticks ... |
| 20 | `void_explore` | THE DISCOVERY TOOL: find what a bound corpus's own structure LICENSES but the corpus LACKS -- ... |
| 21 | `zoo_ask` | THE HOSTED ANSWER LADDER: the server walks its FREE rungs first -- reflex trace, then the bound ... |
| 22 | `zoo_panel` | DELIBERATION UNDER THE CONTRAST LAW: give a question and a map of {member: position}. When the ... |
| 23 | `zoo_tools` | CONTEXTUAL TOOL DISCOVERY AND USE: op='find' ranks the whole toolset (operator-registered ... |
| 24 | `zoo_void` | LEAP ON PURPOSE, WITH RECEIPTS: explore the gaps between known items. op='propose' maps items ... |
| 25 | `zoo_teach` | CLOSE THE LOOP: after you (the model rung) answer an escalated zoo_ask, teach the answer back. ... |
| 26 | `zoo_do` | THE HOSTED TASK PATH: pass a request; if the server has a LEARNED PLAN for a similar goal ... |
| 27 | `zoo_synthesize` | SYNTHESIZE A TOOL ON THE HOSTED SERVICE: compose a typed chain of catalog capabilities into ONE ... |
| 28 | `zoo_query` | HOSTED DATA SUPERPOWERS, both dialects: dialect='sql' runs the optimizer-free SQL-ish layer ... |
| 29 | `zoo_report` | THE FULL-ADVANTAGE DASHBOARD for this tenant: per-tier serves, estimated tokens saved, mined ... |
| 30 | `receipt_verify` | Re-run a prior call and check its receipt: pass the original tool name, its exact arguments ... |
| 31 | `memory_write` | Write to YOUR external memory -- a persistent leCore partition managed for you (indexed ... |
| 32 | `memory_search` | Search YOUR external memory partition (ranked, best first). Check here before claiming you ... |
| 33 | `zoo_model3d` | Model a 3D scene from a shape spec and render it through leCore's own SDF+raymarch faculties ... |
| 34 | `zoo_research` | LOSSLESS research archive: give texts (+sources) to preserve them in full under a topic (notes ... |
| 35 | `zoo_backtest` | Walk-forward market backtest (no lookahead): routed-forecaster d-grid sweep, MAE vs naive ... |
| 36 | `zoo_assimilate` | Assimilate API/framework documentation: archive the doc losslessly, extract call recipes, teach ... |
| 37 | `zoo_feedback` | CLOSE THE LEARNING LOOP over the wire: report whether an answer was right (ok=true strengthens ... |
| 38 | `zoo_boot` | BOOT this hosted substrate and receive your operating screen: POST (measured checks incl. ... |
| 39 | `zoo_agent` | Run one round of a long-running agent loop: gather from the substrate first, resume-or-create ... |
| 40 | `lecore_invoke` | Run any public leCore faculty. args is a JSON object of keyword arguments; results return as ... |

<!-- END GENERATED TOOL TABLE -->

## 3. Security boundaries (enforced in code, stated here)
- **SSRF**: hosted callers cannot register API URLs. Only operator-registered
  services are callable through `zoo_tools op=call`. Register server-side:
  `service.mind.api_learn(spec)` at boot.
- **Memory upload/import is local-runtime only** — an abuse surface hosted; the
  swarm-audit matrix records this as a deliberate gap with its reason.
- Per-user teachings are session-salted; `taught_only` callers are never served
  model output.

## 4. Cost levers (measured; see docs/OPENZOO_INTEGRATION.md §2/§8 for numbers)
- Memory-first answering: **97×** cheaper than generating; scales with teaching.
- One generation per unique question (model-cached provenance).
- The grounding gate: ungrounded model output refused — no paid retry loops.
- `zoo_tools op=status`: saturation + taught rows + registered services — watch the
  model arm shrink in `decision_report` as memory grows.
- Attribution shortcuts (operator-side, model-dir access): early-address cues run
  truncated schedules, measured 3.0× at exit-L7.

## 5. Adopting a new build
1. Unzip the release over your deployment (additive; generated docs regenerate).
2. `python3 tools/swarm_audit.py` — must be 0 unintended gaps.
3. `python3 holographic_mcp.py --selftest` (or `python3 -c "from holographic_mcp import _selftest; _selftest()"`) — tool pin 40: the name list asserted inside `_selftest()` is the same length as the §2 table, and `python3 -m pytest tests/test_openzoo_operations_doc.py -q` proves the page agrees.
4. `python3 tools/bench_ladder.py && python3 tools/bench_longmem.py` — 0.75/1.00 and 1.000.
5. Point `LECORE_PARTITION` at your operator memory; restart.

## 6. Troubleshooting
- **A tool answered with token-noise marked model-cached** — an untrained/weak rung;
  memory still wins where taught, vetoes kill the noise durably, and the grounding
  gate blocks it from fuzzy serving. Attach a capable model or none.
- **`teach` returned `taught: False`** — the control-token guard (standalone
  `__word__` reserved); rephrase. The refusal reason is in the return.
- **A question that should answer, escalates** — check `zoo_tools op=status`
  saturation; `nearing-cliff` means margins are thinning (the cp59 early warning).
- **Slow first call** — the runtime rung loads weights lazily on first use.

## 7. Integration status (x402-tokens gateway)

What the paid gateway in front of this service actually consumes today, per leCore
surface. "Integrated" means a gateway route exists and is tested there; "not yet"
means the surface is served by this MCP/HTTP service but no gateway route reaches it.
Everything in the second group is being landed through ONE generic bridge rather than
a route per tool: leCore HTTP `POST /door {name, arguments}` → gateway
`POST /v1/lecore/door/<name>`, with an `x-hrr-gate` abstain gate (an honest abstain
is not billed) and `_meta.lecore.cost` (`elapsed_ms`, `payload_bytes`, stamped on
every `tools/call`) surfaced as metering headers.

| leCore surface | Gateway status | How it reaches the gateway |
|---|---|---|
| `corpus_bind` | integrated | `POST /v1/hrr/bind` → HRR sidecar `/internal/v1/hrr/bind` |
| `corpus_delta` | integrated | `POST /v1/hrr/delta` → sidecar `/internal/v1/hrr/delta` |
| `corpus_ask` (plain, no gate) | integrated | `POST /v1/hrr/recall` → sidecar `/internal/v1/hrr/recall` |
| `lecore_find` | integrated | `POST /v1/lecore/find` → lecore-front `POST /tools {query, top}` |
| `lecore_invoke` | integrated | `POST /v1/lecore/invoke` → lecore-front `POST /invoke {name, args}` |
| `memory_write` / `memory_search` | integrated | `POST /v1/memory/write`, `/v1/memory/search` → sidecar `/internal/v1/memory/*` |
| `corpus_ask gate=dispatch` (exact → dense → BM25 → abstain, payment-gate verdict) | not yet | `/door` bridge + `x-hrr-gate` |
| `transcript_prefix_route` | not yet | `/door` bridge |
| `_meta.lecore.cost` billing (`elapsed_ms`, `payload_bytes`) | not yet | metering headers on every `/door` response |
| `receipt_verify` | not yet | `/door` bridge |
| `void_explore` | not yet | `/door` bridge |
| `study` / `study_ask` | not yet | `/door` bridge |
| `wisdom_record` / `wisdom_ask` | not yet | `/door` bridge |
| `scene_create` / `scene_adjust` / `scene_export`, `image_tool`, `chart_make` | not yet | `/door` bridge |
| `math_eval`, `fact_check`, `series_analyze`, `dataset_decompose` | not yet | `/door` bridge (memo-pure: hash-replay eligible) |
| `zoo_*` ladder (16 tools, `zoo_ask` … `zoo_agent`) | not yet | `/door` bridge |
| `lecore_map` / `lecore_describe` | not yet | `/door` bridge (`/v1/lecore/describe` exists but only proxies lecore-front `/tools`) |
| saturation / `decision_report` (`zoo_tools op=status`) | not yet | `/door` bridge |
| `tool_memo` ledger | not yet | `/door` bridge |
| hash-replay (memoised pure tools, `LECORE_MCP_MEMO`) | not yet | `/door` bridge |
| `cold_store` dial | not yet | `/door` bridge |
| `api_learn` / `api_use` | not yet | `/door` bridge; registration stays operator-side (§3 SSRF boundary) |
