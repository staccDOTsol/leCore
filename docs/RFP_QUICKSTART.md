# Run it locally

Five minutes, then one command. Everything else is automatic.

## 1. Install

```bash
git clone https://github.com/staccDOTsol/leCore
cd leCore
git checkout claude/rfp-contract-arbitrage-er4c0f

python3 -m venv .venv          # never install into the system python
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-rfp.txt
```

Everything below assumes that venv is active — the prompt shows `(.venv)`. If you open a
new terminal, `source .venv/bin/activate` again first. A bare `pip install` outside a venv
writes into the interpreter your OS depends on; don't.

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
npx openzoo            # only to create and fund the wallet; the daemon starts it for you after that
```

It prints two funding addresses on first run and creates a burner wallet at
`~/.openzoo/wallet.json`. Send a few dollars of USDC or TOKEN to the Solana address, or
USDC on Base to the EVM one. `npx openzoo balance` shows what landed.

**It takes 60 to 90 seconds to bind and prints nothing for the first 45.** Do not kill
it. Wait for `listening on http://localhost:8402/v1`.

A read costs about $0.03, but a full pipeline round reads and drafts many at once: **budget
roughly $10-15 per hour of running**, and set `--budget` to what you are willing to lose.
The cap is enforced from the payment receipts, so it stops rather than draining the wallet.

## 4. One command

```bash
export SAM_API_KEY=...        # free: https://open.gsa.gov/api/get-opportunities-public-api/
export GITHUB_TOKEN=ghp_...   # a token with ONLY the `gist` scope — nothing else is used
export RFP_DB=rfp_arbitrage.sqlite3 RFP_CACHE=.rfp_cache

python -m rfp_arbitrage daemon --budget 25
```

That is the whole thing, and it is the only command. It starts the paying proxy, the crawler,
the conveyor and the comparable-award index, restarts whichever one dies, and every 90 seconds
rewrites **one gist, in place**, with the board and the drafts themselves. The gist id is
remembered in `.rfp_cache/gist.json`, so a restart — tomorrow, next week — keeps writing to the
same link instead of scattering new ones. A draft that drops off the board is deleted from the
gist rather than left there stale.

```
[daemon 04:11:07] starting. db=rfp_arbitrage.sqlite3 out=rfp_out
[daemon 04:11:07] starting the openzoo proxy, then leaving it alone for four minutes
[daemon 04:11:07] pump up (pid 499366) -> .rfp_cache/logs/pump.log
[daemon 04:11:07] ingest up (pid 499367) -> .rfp_cache/logs/ingest.log
[daemon 04:11:07] building the comparable-award index (holds 0 rows) -> .rfp_cache/logs/awards.log
[daemon 04:14:22] comparable-award index rebuilt: 83,061 rows (exit 0)
[daemon 04:17:40] 17,139 indexed · 2,474 gated · 2,416 eligible · 5 drafted (4 ready to send) · gist rewritten https://gist.github.com/you/8f0c…
[daemon 04:17:40] [pump] round 6: ... llm-verdicts 159 drafts 5 spent $15.13/$18
[daemon 04:19:11] 17,139 indexed · 2,474 gated · 2,416 eligible · 5 drafted (4 ready to send) · gist unchanged
```

**That heartbeat is the answer to "is it working".** The counts come from the database and
the second line is the pump's own round summary, carrying what has been spent. If the numbers
move, it is working. If they sit still while the spend climbs, something is wrong — look in
`.rfp_cache/logs/pump.log`. `gist unchanged` means the substance is identical to last round,
so no write was spent; the timestamp in the board does not count as a change.

**Watch `eligible` in particular.** If it is a handful while `gated` is in the thousands, the
comparable-award index has not finished building yet. Nothing can be priced without it — an ask
with no comparable market has no margin, so it never becomes a match and is never drafted, and
the pipeline looks like it is running fine while finding nothing. The daemon builds it at
startup and refreshes it every `--awards-every` hours (default 24); it takes a few minutes and
pulls ~85,000 awards from SEAO Québec, the Socrata portals and USAspending.

Nothing is published without `GITHUB_TOKEN`; without one the daemon says so and runs anyway,
writing `rfp_out/` locally.

### Or drive the stages yourself

```bash
export LECORE_LLM_URL=http://localhost:8402/v1 LECORE_LLM_KEY=sk-openzoo
export RFP_LLM_PROVIDER=openzoo
export RFP_LLM_MODEL=claude-fable-5-1
export RFP_LLM_MODELS=claude-fable-5-1,claude-fable-5,claude-opus-5,grok-4
export RFP_LLM_BUDGET_USD=25                 # a hard cap, read from the payment receipts

npx openzoo                                  # terminal 1
python -m rfp_arbitrage crawl --days 30      # terminal 2 — first fill, a few minutes
python -m rfp_arbitrage awards               # the price side
python -m rfp_arbitrage pump --watch --verbose   # the conveyor
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

## Daemon knobs

| flag | default | what it does |
|---|---|---|
| `--gist` | the id in `.rfp_cache/gist.json` | publish into a gist you already have |
| `--gist-every` | 90 | seconds between rewrites; a round with nothing new spends no write |
| `--gist-proposals` | 8 | how many drafts ride along in the gist beside the board |
| `--gist-public` | off | only affects the run that creates it |
| `--awards-every` | 24 | hours between rebuilds of the comparable-award index; built at startup |
| `--budget` | none | hard USD cap, read from the payment receipts |
| `--models` | built-in chain | override the fallback chain |
| `--no-proxy` | off | something else is already serving `LECORE_LLM_URL` |
| `--conveyor-workers` | 3 | opportunities carried end to end in parallel |

Leave it running detached:

```bash
setsid nohup python -m rfp_arbitrage daemon --budget 25 > .rfp_cache/daemon.log 2>&1 &
tail -f .rfp_cache/daemon.log        # stage logs are under .rfp_cache/logs/
```

Two hard-won details live in the supervisor. A proxy the daemon started gets four consecutive
failed health checks and then four minutes of silence before anything touches it again — it
binds in 60 to 90 seconds and prints nothing for the first 45, and every earlier version killed
it mid-startup, forever, which is why nothing was ever drafted. (On a cold start there is
nothing to be patient with, so it starts one immediately.) And the children are owned as process
handles, never looked up with `pgrep -f openzoo`: that pattern matches its own command line and
answers yes whether or not the service exists.

(`.rfp_cache/keep.sh` is the shell ancestor of this and still works, but `daemon` supersedes
it and is the one that publishes.)
