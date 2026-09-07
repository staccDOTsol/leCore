# omniview

A working explorer for omnichain.family tokens.

```bash
cd integrations/omniarb && npm install
BIRDEYE_KEY=<key> node site/server.mjs     # http://localhost:8787
```

The key falls back to the one this was built with if the env var is unset. It is
read server-side only — every Birdeye call goes through this process, so the
browser never sees it. Don't move it into the frontend.

## What it shows that the official /explore does not

**Charts at all.** Theirs returns `503 {"error":"birdeye unset"}`.

**Both pools per chain.** Every CA gets two Uniswap-v4 pools on each chain: one
carrying omnichain's hook, one with no hook. Their router builds the PoolKey with
its own hook and cannot reach the hookless pool, so their UI cannot show it —
and that is frequently where the price differs.

**Cross-chain spread.** The same contract address trades independently on nine
chains. Measured 21.9× between Linea and Base while building this.

**Supply reconciliation.** Per-chain supply swings hard as people bridge, so
watching one explorer makes a token look like it is inflating. The invariant that
actually holds is `sum(totalSupply) − (minted − burned) = original supply`, and
it reconciles to the wei.

**Bridges that never landed.** Burned on the source, unminted on the destination.
Those balances exist on neither side, so nothing else displays them — but they
are somebody's tokens. It found 450,886,228 of them on the first run.

## Endpoints

| route | notes |
|---|---|
| `/api/tokens` | every launch, with price/liquidity/volume/holders |
| `/api/token?ca=` | per chain: supply, both pools, price, spread |
| `/api/supply?ca=` | the reconciliation above |
| `/api/stuck?ca=` | burns whose `processed()` is still false |
| `/api/chart?ca=&chain=&type=&hours=` | OHLCV proxy |

Birdeye covers 7 of the 9 chains (not World or Linea). Prices there are derived
from pool state instead, and the response says which source each number came
from rather than mixing them silently.

---

## the desk

`/desk.html` is the trading surface: eight tabs over one CA that lives on nine
chains at once.

| tab | what it reads |
|---|---|
| board | the site index **and** the launcher's own events — a launch missing from the index still trades, and gets flagged `unindexed` rather than hidden |
| chart | one Birdeye line per covered chain plus a fat float-weighted aggregate |
| venues | both v4 pools per chain, straight out of `PoolManager.extsload` |
| routes | tick-bounded swap sim across every pair of venues, atomic and bridged |
| curve | the Base pad priced against both Base pools at the same size |
| launch | name, ticker, mark, raise → launch on Base and seed nine chains |
| bridge | portal burn on one chain, relayer mint on another |
| bag | native + token on all nine, with a best-exit sim per chain |

### the chart

Every other chart of these tokens shows one venue on one chain, which is how a
token looks flat on Base while it is 40% richer on BNB. Here each Birdeye-covered
chain gets its own thin line, the aggregate gets a fat one, and the two chains
Birdeye does not cover get a spot marker read from the pool instead of an
invented history.

The aggregate is **float-weighted**: each chain's print weighted by the supply
sitting on that chain. The portal moves float around, so a plain mean would let
an empty chain outvote a full one. A chain that has not printed in a bucket
carries its last print forward rather than dropping out of the average.

Line colours are a categorical palette validated for the dark surface — OKLCH
lightness inside the dark band, chroma above the gray floor, adjacent pairs
separated under simulated protanopia and deuteranopia, every line at least 3:1
against the card. Colour never carries it alone: the aggregate is thicker,
every line is labelled at its right end, and the crosshair names every chain.

### running it

```
npm run desk                      # read-only, 127.0.0.1:8787
npm run desk:live                 # + launch / bridge / trade, needs STACCOVERFLOW_KP
```

Writes are off unless **both** `OMNIVIEW_WRITE=1` and `STACCOVERFLOW_KP` are set,
and the server binds loopback unless `HOST` says otherwise. A dashboard that can
spend money should not be one misconfigured bind away from the open internet.

Long writes are jobs: `POST /api/launch` returns an id, `GET /api/job?id=`
follows the steps. A launch is metadata upload → sign on Base → deploy the CA on
eight more chains → split the float → eight bridges → eight relayer mints →
eighteen pools. Holding an HTTP request open across that is how you get a proxy
timeout mid-bridge with nobody holding the record.

### deploying

Both targets deploy the **read-only** desk. Neither gets the key.

```
cd integrations/omniarb
vercel --prod            # omniarb.fun — one function, static served through it
fly deploy               # long-lived process, fly.toml is here
```

`vercel.json` routes everything through `api/index.mjs`, which re-exports the
same handler `site/server.mjs` binds locally — there is no second
implementation. Set `BIRDEYE_KEY` in the host's env so the key is not the
in-repo fallback.

Do not set `STACCOVERFLOW_KP` or `OMNIVIEW_WRITE` on either host. The launch,
bridge and trade tabs are for the machine that holds the key; on a public
deployment they refuse with a 403 and the UI says so.
