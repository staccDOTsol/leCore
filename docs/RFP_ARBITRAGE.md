# RFP service arbitrage: index, gate, match

`rfp_arbitrage/` indexes public-sector solicitations across the United States and Canada
(federal, state/provincial, municipal), keeps only the ones asking for **intellectual work**
(software, data, consulting, studies, writing, design, translation, training, research,
legal/finance), runs every survivor through a **legal gate** -- does the solicitation
explicitly deny delegation to subcontractors or to AI teams? -- prices the ask against what
buyers historically pay and what the work costs at market, and intersects the result with
**provably good, under-priced talent** (individuals and teams).

The product of the pipeline is a ranked dossier with evidence, not a bid. Every gate verdict
carries verbatim quotes so a human can confirm the reading in a minute.

## Quick start

    pip install -r requirements-rfp.txt
    export SAM_API_KEY=...                    # https://open.gsa.gov/api/get-opportunities-public-api/ (free)
    export LECORE_LLM_URL=http://localhost:8402/v1   # the openzoo proxy; LECORE_LLM_MODEL / LECORE_LLM_KEY as needed

    python -m rfp_arbitrage sources                                   # what is covered, and by which fetcher
    python -m rfp_arbitrage crawl --days 14                           # all implemented sources -> ./rfp_arbitrage.sqlite3
    python -m rfp_arbitrage classify --show 40                        # intellectual-work shortlist
    python -m rfp_arbitrage fetch                                     # attachments -> text (PDF/DOCX/XLSX/ZIP/HTML)
    python -m rfp_arbitrage gate                                      # LLM verdict per opportunity (openzoo by default)
    python -m rfp_arbitrage price --viable-only                       # ask, hours, market labor, overpriced ratio
    python -m rfp_arbitrage awards                                    # comparable bids/awards index (the price side)
    python -m rfp_arbitrage match --show 20
    python -m rfp_arbitrage report --out shortlist.md
    python -m rfp_arbitrage report --kind live --out live.md          # every open viable ask with its price distribution
    python -m rfp_arbitrage propose --limit 5                         # draft bids for the top matches (openzoo)
    python -m rfp_arbitrage pump --watch                              # all downstream stages concurrently, cumulatively

`python -m rfp_arbitrage run` chains crawl -> fetch -> gate -> price -> score -> match -> report.
The store is a single SQLite file (`--db` or `$RFP_DB`); every verb is resumable and idempotent.

## Sources (implemented, verified live)

| source | reach | mechanism |
|---|---|---|
| `sam_gov` | US federal, every agency | Opportunities API v2 (key), notice bodies via `noticedesc`, attachments via resource links. **A public (non-federal) key allows 10 requests/day, reset 00:00 UTC** -- one search page is 1,000 notices, so crawl small windows and fetch documents for the shortlist only |
| `canadabuys` | Canada federal (all) + provinces/municipalities/MASH bodies publishing through CanadaBuys | daily open-data CSV (open + new notices) |
| `seao_quebec` | Québec province + every Québec municipality / school service centre / health network / crown corp | OCDS weekly JSON on Données Québec |
| `merx` | Canada: provincial portals hosted on MERX (MB, NS, NB, PEI, NL...), hundreds of municipalities, private | Scrapy spider (`spiders/mets_spider.py`), public detail pages |
| `bidnet` | US: 1,300+ state, county, city, school and special-district agencies | same spider (same platform); descriptions need a free supplier login (`BIDNET_COOKIE`) |
| `socrata` | US/CA governments publishing live solicitations as open data (LA, Delaware, Montgomery Co., Winnipeg, ... `--discover` finds more) | SODA API with a column-role mapper |
| `usaspending` | US award history by NAICS / keyword (the price benchmark) | USAspending API v2 |

`python -m rfp_arbitrage sources` prints the coverage map: all 50 states + DC and all 13
provinces/territories with their portal, platform and which fetcher reaches them. The
multi-tenant municipal platforms not yet spidered (Bonfire, bids&tenders, PlanetBids,
DemandStar, OpenGov, Periscope, Ionwave, Jaggaer) are listed with their tenant counts and the
URL shape each uses -- one spider per platform covers every tenant.

## The legal gate (`clauses.py`)

    viable  <=>  delegation is not explicitly prohibited  AND  AI use is not explicitly prohibited

* **delegation** ∈ explicitly_permitted, permitted_with_consent, silent, restricted, explicitly_prohibited
* **ai_use** ∈ explicitly_permitted, silent, restricted, explicitly_prohibited
* conditions surfaced but not blocking: consent required, self-perform minimum (%), key-personnel
  lock, data-residency / export control, clearance or citizenship, other blockers (on-site
  presence, licensed stamp, local-vendor eligibility, bundled goods).

How a verdict is produced:

1. `prescreen()` pulls every passage mentioning subcontracting / assignment / personnel / AI /
   residency / clearances / location with one passage of context (bounded to ~36k chars);
   documents under 40k chars go in whole.
2. The LLM answers with a strict JSON schema and must quote verbatim evidence for anything
   other than "silent". A non-silent status without a quote is demoted to silent and noted.
3. A regex heuristic runs independently. Disagreement on an explicit prohibition caps confidence
   at 0.55 and writes both readings into `other_blockers`.
4. No LLM reachable -> heuristic verdict, `method="heuristic"`, confidence ≤ 0.5. Triage only.

LLM back ends (`RFP_LLM_PROVIDER`): `openzoo` (default; `LECORE_LLM_URL`, default
`http://localhost:8402/v1`, OpenAI-compatible, JSON mode with graceful fallback) or
`anthropic` (official SDK, `claude-opus-5`, structured outputs, server-side refusal fallback
on by default -- `RFP_LLM_FALLBACKS=0` to disable).

## Pricing (`pricing.py`)

* **ask**: stated estimated value on the notice, else a budget/NTE/ceiling figure the LLM or
  regex finds in the text, else the USAspending median award for the NAICS (US), else unknown.
* **hours + skill mix**: LLM scope estimate (deliverables -> skill families -> hours range); a
  size-based heuristic when no LLM.
* **market labor** = hours × reference rate for the mix; **overpriced ratio** = ask / (market
  labor × (1 + overhead)). Reference rates live in `talent/scoring.py::REFERENCE_RATES` and
  are inputs, not facts -- edit them for your market.

## Delivery: openzoo only

There is no marketplace in the loop. The delivery plan for every viable opportunity is an
openzoo AI team: scope hours × `RFP_ZOO_USD_PER_HOUR` (default $4 per delivered
hour-equivalent, a knob until the first delivered contract measures it) plus a human
review share (`RFP_REVIEW_SHARE`, default 10 % of hours at `RFP_REVIEW_USD_PER_HOUR`,
default $120). `propose` drafts the bid from the same bound context (understanding,
approach, deliverables with acceptance criteria, schedule, compliance matrix from the
solicitation's own mandatory requirements, assumptions, questions for the buyer, price).
Next stages on the same context: submission packaging, buyer Q&A, the deliverables, and
revision to acceptance.

## Matching (`match.py`)

For every opportunity that is intellectual, gate-viable and priced: delivery cost through
openzoo, margin after overhead, and

    score = gate_conf × (0.6·margin + 0.4·log-size)

with hard cuts: margin ≥ `RFP_MIN_MARGIN` (0.35) and a known ask. A regex-found ask halves
the score. `match --include-blocked` also ranks gate-failed opportunities for review.

## openzoo wiring (`llm.py`)

Per openzoo's INTEGRATION.md: each solicitation is bound once (free, `/v1/hrr/bind`) and
gets its own context id, stored in `contexts`; every gate, scope and proposal question is
sent as a small body with `X-HRR-Context` and `x-hrr-top-k`, so the proxy never auto-spills
a large prompt or mixes documents. The JSON rule rides in the user turn as well as the
system prompt; a prose answer is salvaged into the schema with one cheap context-free pass.
Spend is read from the `x402` receipts and capped by `RFP_LLM_BUDGET_USD`; a paid read that
yields nothing usable is recorded (`llm-failed:`) and never auto-retried. `npx openzoo`
runs the paying proxy; fund its wallet in TOKEN or USDC and set `OPENZOO_TOKEN` to the
asset you funded.

## Environment

| var | purpose |
|---|---|
| `SAM_API_KEY` | SAM.gov opportunities API |
| `LECORE_LLM_URL` / `LECORE_LLM_MODEL` / `LECORE_LLM_KEY` | openzoo / OpenAI-compatible LLM (default provider) |
| `RFP_LLM_PROVIDER` (`openzoo`\|`anthropic`), `RFP_LLM_MODEL`, `RFP_LLM_EFFORT`, `RFP_LLM_FALLBACKS` | LLM selection |
| `ANTHROPIC_API_KEY` | only with `RFP_LLM_PROVIDER=anthropic` |
| `RFP_ZOO_USD_PER_HOUR`, `RFP_REVIEW_SHARE`, `RFP_REVIEW_USD_PER_HOUR`, `RFP_LLM_BUDGET_USD` | delivery cost model and spend cap |
| `BIDNET_COOKIE`, `MERX_COOKIE` | logged-in session for locked detail fields |
| `SOCRATA_APP_TOKEN` | higher Socrata rate limits |
| `RFP_DB`, `RFP_CACHE`, `RFP_DELAY`, `RFP_USER_AGENT`, `RFP_OVERHEAD`, `RFP_MIN_MARGIN` | store, cache, politeness, economics |

## Honest limits

* The gate reads what it is given. If attachments fail to download (login-walled portals,
  broken links) the verdict is on the notice alone and says so (`text_chars`, confidence cap).
* "Silent" is treated as non-denial per the operating rule. Silence is not consent: the
  contract you sign may still contain an assignment or subcontracting clause -- the dossier
  is the start of diligence, not the end.
* French-language notices (SEAO, parts of CanadaBuys) classify on codes; the LLM gate reads
  French, the regex triage mostly does not.
* Reference rates, overhead and minimum margin are knobs. Change them to your business.
