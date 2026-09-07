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
