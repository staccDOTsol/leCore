# Run it locally

Five minutes, three terminals. Everything else is automatic.

## 1. Install

```bash
git clone https://github.com/staccDOTsol/leCore
cd leCore
git checkout claude/rfp-contract-arbitrage-er4c0f
pip install -r requirements-rfp.txt
```

## 2. Tell it who is bidding

`.rfp_bidder.json` in the repo root. It is gitignored: a tax id and a home address are
not repository content.

```json
{
  "legal_name": "Your Company, LLC",
  "short_name": "YOURCO",
  "entity_type": "limited liability company",
  "state_of_incorporation": "Delaware",
  "contact_name": "Your Name",
  "contact_email": "you@example.com",
  "contact_phone": "(555) 555-5555",
  "address": "1 Main Street, Somewhere",
  "country": "US",
  "uei": "",
  "set_asides": ""
}
```

`uei` empty means US federal work is drafted but never marked submittable — a federal
award needs a SAM.gov Unique Entity ID. `set_asides` is what you can actually claim,
comma separated: `small_business,8a,sdvosb,wosb,hubzone,indigenous`. Small business is
self-certified in SAM.gov; the rest need third-party certification. Claim nothing you do
not hold: the matcher uses this to decide what is even worth reading.

## 3. Money for the model

Every clause read and every drafted bid is a paid call. The gateway takes crypto per
request, no account and no API key.

```bash
npx openzoo            # terminal 1 — leave it running
```

It prints two funding addresses on first run and creates a burner wallet at
`~/.openzoo/wallet.json`. Send a few dollars of USDC or TOKEN to the Solana address, or
USDC on Base to the EVM one. `npx openzoo balance` shows what landed.

**It takes 60 to 90 seconds to bind and prints nothing for the first 45.** Do not kill
it. Wait for `listening on http://localhost:8402/v1`.

A read costs about $0.03. Twenty-five dollars covers most of an open market.

## 4. Run it

```bash
export SAM_API_KEY=...                       # free: https://open.gsa.gov/api/get-opportunities-public-api/
export RFP_DB=rfp_arbitrage.sqlite3 RFP_CACHE=.rfp_cache
export LECORE_LLM_URL=http://localhost:8402/v1 LECORE_LLM_KEY=sk-openzoo
export RFP_LLM_PROVIDER=openzoo
export RFP_LLM_MODEL=claude-fable-5-1
export RFP_LLM_MODELS=claude-fable-5-1,claude-fable-5,claude-opus-5,grok-4
export RFP_LLM_BUDGET_USD=25                 # a hard cap, read from the payment receipts

python -m rfp_arbitrage crawl --days 30      # terminal 2 — first fill, a few minutes
python -m rfp_arbitrage awards               # comparable awards, the price side
python -m rfp_arbitrage pump --watch --verbose   # the conveyor: leave it running

python -m rfp_arbitrage ingest --watch       # terminal 3 — keeps crawling for new work
```

The pump prints one line per opportunity carried:

```
[pump:conveyor] BID $261,500 clean -- RPOSD RFSQ For As-Needed Consultant Services
[pump:conveyor] ineligible: Service-Disabled Veteran-Owned Small Business Set-Aside -- ...
[pump:conveyor] drafting held: US federal award requires a SAM.gov UEI -- ...
```

## 5. What comes out

| file | what it is |
|---|---|
| `rfp_out/board.html` | the bid board: what is ready to send, what is blocked and why. Open it in a browser |
| `rfp_out/proposals/*.md` | one drafted bid each, with two Mermaid diagrams and a compliance matrix |
| `rfp_out/live.md` | every open, viable, eligible opportunity with its comparable price distribution |
| `rfp_out/gate.md` | every clause verdict with the quotes it was based on |

A bid marked **READY TO SEND** is clean: it asserts nothing the bidder profile does not
support. It is still a draft. Nothing is ever transmitted for you.

## Model chain

`RFP_LLM_MODELS` is tried in order. The x402 door network flaps — a model that sold a
minute ago may be unsellable now — so the chain is not a preference, it is what keeps the
pipeline moving. A 503 costs nothing (refused before payment) and is retried; a 502 means
the payment settled and the seller then failed, so it is never retried and three of them
detach the model until a door recovers.

## Knobs

| var | default | what it does |
|---|---|---|
| `RFP_LLM_BUDGET_USD` | none | hard spend cap from the payment receipts |
| `RFP_ZOO_USD_PER_HOUR` | 4 | delivery cost per hour-equivalent, the margin model's main assumption |
| `RFP_REVIEW_SHARE` / `RFP_REVIEW_USD_PER_HOUR` | 0.10 / 120 | human review share of every engagement |
| `RFP_MIN_MARGIN` | 0.35 | below this an opportunity is not a match |
| `--conveyor-workers` | 2 | opportunities carried end to end in parallel |
| `--threshold` | 0.6 | how confidently intellectual the work must be |

## Running it as one thing

`.rfp_cache/keep.sh` in this repo keeps the proxy, the pump and the ingest loop alive and
restarts whichever dies. Point it at your paths and run it once:

```bash
setsid nohup .rfp_cache/keep.sh > .rfp_cache/keep.log 2>&1 &
```

Two hard-won details are in that script: the proxy gets four minutes to bind before
anything touches it, and status is checked with `ps`, never `pgrep -fc openzoo` — that
matches its own command line and answers 1 whether or not the service exists.
