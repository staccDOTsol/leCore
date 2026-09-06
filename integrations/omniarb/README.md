# omniarb

An arbitrage bot for tokens launched by [omnichain.family](https://omnichain.family) —
across its nine chains, the two Uniswap-v4 pools that exist per contract address on
each of them, the Base bonding curve, and the 1:1 burn/mint bridge that connects it all.

Nothing sends a transaction unless you pass `--live`.

---

## What the system actually looks like

Reverse-engineered from the site's bundle and then verified against every chain's RPC.
Worth reading before trusting any number the bot prints.

**One address everywhere.** A launched token has the *same contract address* on all nine
chains — Robinhood (4663), Base, Ethereum, Arbitrum, BNB, Polygon, World, Linea, Monad.
Supply moves between them through the Portal
(`0xa3324d514708049883167ad817db97aefe29c96c`, same address on every chain), which burns
on the source and mints the identical amount on the destination. Total supply across all
chains never changes, and nothing is ever wrapped.

**The bridge is permissioned in one direction.** `bridgeOut` is public; `bridgeIn` is
gated to a relayer. The bot therefore burns for itself and then asks the site's relayer to
mint, through the exact `POST /api/relay` call the bridge page makes. There is no way to
self-mint, and no way to make the hop atomic.

**Two pools per token per chain.** The launcher creates a `native/token` v4 pool with
omnichain's own hook, *and* a second one with `hooks == address(0)`. Both are fee 3000,
tickSpacing 60. The hookless pool has the same pool id on every chain
(`0x32b7b885…`) because its PoolKey contains no chain-specific address.

This is where most of the edge lives, because **omnichain's router can only ever trade the
hooked pool** — it builds the PoolKey with its own hook and rejects `hook = 0x0`. Uniswap's
own UniversalRouter is not deployed on Robinhood, World or Monad. So the hookless pool is
unreachable through any deployed periphery, and it drifts. Observed live: on Polygon the
two pools sat 1,949 ticks apart (a 21.5% price gap) with the hookless side holding
~1,600x more liquidity than any other pool in the system.

`contracts/OmniArb.sol` exists to reach it.

**Spot price lies here.** The hooked pools carry a dynamic fee with a surge component,
and their sell side saturates hard. On Base the pool quotes ~8.7e-6 native/token at spot,
yet selling *any* size into it returns at most ~0.0014 native. A bot that reasons from
`sqrtPriceX96` would read a fortune and execute a loss. Every number this bot acts on comes
from simulating the real call against real chain state.

**The chains do not share a gas asset.** Base, Ethereum, Arbitrum, Robinhood, World and
Linea settle in ETH; Polygon in POL; BNB in BNB; Monad in MON. At the time of writing that
is $2,494 against $0.098 — a factor of ~25,000. Any cross-chain leg that compares "native
in" to "native out" numerically is wrong by orders of magnitude, so every cross-chain
figure here is converted to USD first.

---

## The route space

```
native you actually hold on chain A
   -> buy the token on a venue on A        curve | hooked pool | hookless pool
   -> optionally bridge it 1:1 to chain B  Portal: burn on A, relayer mints on B
   -> sell it on a venue on B
   -> native on chain B
   -> optionally Relay the native back      relay.link, all 9 chains, ~0.3%, seconds
```

Three shapes, in descending order of how much can go wrong:

| shape | transactions | protection |
|---|---|---|
| `route-atomic` | one | reverts unless it clears `minProfit`, so a miss costs gas only |
| `route-same-chain` | two, one chain | none — inventory risk between the legs |
| `route-bridged` | two + relayer mint | none — token is in the bridge until the relayer acts |

The Portal moves launched tokens only, never native, so an arbitrage leg is one-way on its
own: you finish holding a different chain's gas asset than you started with. Relay closes
that loop, which also means capital is not pinned to whichever chain it happens to sit on —
`--relay` lets every chain be a candidate entry point and prices the hop for real.

---

## Install

```bash
cd integrations/omniarb
npm install
npm run compile          # builds build/OmniArb.json from contracts/OmniArb.sol
export STACCOVERFLOW_KP=0x...   # trading key; read here and nowhere else, never logged
```

Optional environment: `RPC_<chainId>` overrides an endpoint, `ARB_<chainId>` points at an
already-deployed helper, `PRICE_<SYMBOL>` overrides a price feed.

**Your RPC must support `eth_call` state overrides.** All quoting depends on it — it is how
the bot prices a sell before it owns a single token, and how it simulates the helper on
chains where it is not deployed. `scan` and `route` warn per chain when an endpoint ignores
them.

## Use

```bash
omniarb tokens                       # what has launched (add --deep for launcher events)
omniarb venues  --token 0x…          # every pool per chain, live price and liquidity
omniarb balances --token 0x…         # what the wallet holds where, and gas prices
omniarb bag     --token 0x…          # what tokens you already hold are worth, and where to sell
omniarb route   --token 0x… --relay  # funded routes, ranked in USD
omniarb watch   --token 0x… --relay --interval 60
omniarb move    --from RH --to ETH --amount 0.005   # reposition native via Relay
omniarb bridge  --token 0x… --from Base --to Pol --amount 1000
omniarb deploy  --chain Pol --live   # deploy OmniArb (needed only for hookless-pool trades)
omniarb run     --token 0x… --live   # execute the best atomic route
```

`bag` is usually the first thing worth running: it needs no capital, and a bag sitting on a
chain whose pool saturates at a fraction of a cent can often be bridged somewhere deeper.

## Safety

- Dry run everywhere. `--live` is required to sign anything.
- `run` re-simulates immediately before signing and aborts if the edge moved.
- The on-chain `minProfit` argument is set from that fresh simulation, so a stale
  opportunity reverts on chain rather than settling at a loss.
- Trade size is capped by real balances minus a gas reserve (`--max-usd` caps it further).
- `OmniArb` holds no balances between transactions; everything is swept to the caller in
  the same call.
- The private key is read once from `STACCOVERFLOW_KP` and is never logged or transmitted.

## Honest limits

- **Capacity is small.** The hooked pools' sell side saturates at a fixed cap per pool —
  measured at ~0.0014 native on Base, ~0.0004 on Arbitrum and World, ~0.0002 on Polygon.
  The edge is often several hundred percent on a tiny size, and the size is the binding
  constraint, not the spread.
- **Gas can exceed the edge.** Polygon's arb peaked at 0.1607 POL gross against 0.1673 POL
  of gas at 279 gwei — a real 21% spread that is not worth taking. The bot estimates gas
  for the winning call specifically, because at these margins a guessed 600k vs a measured
  550k flips the sign.
- **Bridged and two-step routes are not atomic.** They are priced, not protected.
- **The relayer is a dependency.** If it stops minting, tokens are burned on the source and
  the position is stuck until it resumes.
