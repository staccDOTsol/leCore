# King of the Hill (`koth/`)

Shill your token. Beat the king. The **master shill token's on-chain metadata becomes yours.**

## For degens

One coin wears the crown. The crown is a real token on Solana whose **name, ticker and image get rewritten
on-chain** to whoever is holding the hill. Take it and the master token literally becomes your coin, remixed
by the AI. Lose it and you're in the hall of fame.

1. `shill <mint> <your pitch>` — any Jupiter-tradable coin. Sell it.
2. You get a **burner address and a number**. Send that much of *your* coin. Entry is 0.25 SOL worth, +1 %
   every time the hill flips, plus the AI's tab, plus 5 % slop. One-time address; we don't hold your bags.
3. `paid <quote-id>` — your coin's **real numbers** (liquidity, volume, holders, chart) become a monster card.
   The master shillbot shills the sitting king. The AI judge scores both pitches. Cards are context; the
   pitch wins.
4. **Win:** the master token's metadata is rewritten on-chain to your coin. Your name on the crown.
   **Lose:** the king stays. Your entry stays too.

Where the money goes: half your entry is swapped into the master token, paired with your coin in a Raydium
pool `<yourcoin>/MASTER`, and the LP is locked in a vault with **no withdraw instruction**. Every attempt is
permanent liquidity for the crown, paired with your coin. Nobody can pull it, including us. The AI's cut goes
to openzoo in `$TOKEN`. No website: it lives in Telegram, Discord and on X.

There is no website. The game exists as the bots (Telegram, Discord, an automated X account) and as
three things on Solana:

| thing | where | why it is this |
|---|---|---|
| the master shill token | Meteora **Dynamic Bonding Curve**, quoted in `$TOKEN` (`EVUL…pump`, Token-2022), bonds at **100M** | DBC's config has `tokenAuthorityOption = CreatorUpdateAuthority`: the program creates the metadata as **mutable** and hands the update authority to the pool creator inside `initialize_virtual_pool` (`TokenAuthorityOption::get_update_authority` in the program). So the launcher wallet can rewrite `name` / `symbol` / `uri` on chain, from day one, with a plain Metaplex `UpdateMetadataAccountV2` (or Token-2022 `UpdateField`). |
| the play vault | `koth/program` — a **Pinocchio** program | A *play* is Raydium CPMM LP deposited into a program PDA, accepted only when the pool pairs the master token with something. No withdraw instruction: every attempt is permanent liquidity for `<token>/MASTER`. |
| inference | **openzoo** (openzoo.fun) | Every model call — the judge, the master shillbot, the metadata remix — goes through the zoo's OpenAI-compatible, x402-paid gateway. The receipt (routed model, USD billed) is on the ledger. |

## The loop

1. A player says `shill <mint> <pitch>` to a bot.
2. They get a **one-time throwaway deposit address** and an exact amount of *their* token: the attempt
   fee (**0.25 SOL worth, ×1.01 per successful takeover**) plus an inference estimate, both **+5 %**.
   No wallets are hosted for anyone; the throwaway key is deleted the moment the deposit is swept.
3. They say `paid <quote-id>`. The operator sweeps the deposit, converts the inference share into
   `$TOKEN` / LEOS / USDC for the openzoo wallet, swaps **half** the stake into the master token on
   Jupiter, **creates the Raydium CPMM pool `<token>/MASTER` if it does not exist** (else deposits into
   it), and locks the LP in the play vault. The player never sees LP.
4. The token's **metrics become a card** (HP = liquidity, ATK = turnover, DEF = distribution,
   SPD = volatility, LUCK = buy pressure; element and rarity from the dominant signal and market cap),
   and a creature body grown from the same numbers — rendered by leCore (`render_asset.py`) or as an SVG.
5. The **master shillbot** writes the sitting king's pitch, the **arbiter** judges challenger vs king.
6. If the challenger wins: **the king's metadata is duped into the master token, run through
   inference** — name, symbol, description remixed, image kept — hosted as the new `uri`, and written
   on chain. The old king goes to the hall of fame. The fee steps up 1 %.

## Layout

```
src/dbc.ts        Meteora DBC: config (creator keeps metadata authority; quote = $TOKEN; bond = 100M) + launch
src/metadata.ts   read + rewrite name/symbol/uri (Metaplex and Token-2022), byte-limit clamps
src/metrics.ts    Birdeye (key) / DexScreener (keyless) / RPC facts -> TokenMetrics
src/cards.ts      metrics -> deterministic card + creature spec
src/assets.ts     SVG card, and the leCore PNG bridge (render_asset.py)
src/openzoo.ts    the inference lane: chat completions + receipts (x402.billedUsd)
src/judge.ts      master shillbot, arbiter (typed verdict), metadata remix
src/hill.ts       the state machine: fee schedule, challenge, crown, hall of fame (JSON store)
src/uri.ts        hosting for the uri JSON: files served by the bot, or Pinata
src/entry.ts      throwaway quotes, deposit detection, sweep, Jupiter half-swap, CPMM pool, lock
src/play.ts       client for the play program (PDAs, instructions, decoders, pool discovery, proofs)
src/commands.ts   king / hall / fee / shill / paid / help
src/surfaces/     telegram.ts (Bot API long-poll), discord.ts (discord.js), x.ts (openzoo-xbot shape)
src/bot.ts        the runner: surfaces + the /metadata + /assets static server + the shill cadence
program/          koth-play (Pinocchio, no_std): Initialize / Play / SetMaster
scripts/          create-config, launch-master, read-metadata, update-metadata, init-play, challenge, preflight
```

## Run it (Telegram first)

Telegram is the first surface. Two values from BotFather / your group, and the bot is live:

1. `@BotFather` → `/newbot` → `TELEGRAM_BOT_TOKEN`. Turn privacy mode OFF (`/setprivacy`) so it sees group messages.
2. Add the bot to the group; `TELEGRAM_CHAT_ID` is the group's id (a negative number; `/getid`-style bots or the
   `getUpdates` JSON show it). Takeovers and the master shillbot's cadence posts go there.

```bash
cd koth && npm ci
cp .env.example .env            # fill in: KOTH_KEYPAIR, SOLANA_RPC_KEY, BIRDEYE_API_KEY, TELEGRAM_*; openzoo proxy on :8402 (`npx openzoo`)

npm run create-config           # 1. DBC config: creator keeps update authority, quoted in $TOKEN, bonds at 100M
npm run launch-master -- "Master Shill" SHILL https://your.host/koth/metadata/genesis.json
npm run read-metadata           # shows updateAuthority == your wallet, mutable == true
npm run update-metadata -- "KING BONK" KBONK https://your.host/koth/metadata/1.json   # the whole point, by hand

npm run program-keys            # your own program keypair (gitignored) + stamps its id into declare_id!
npm run build-program           # program/target/deploy/koth_play.so  (cargo build-sbf)
npm run deploy-program          # ~0.25 SOL rent for a 32 KB program; put the printed id in KOTH_PLAY_PROGRAM_ID
npm run init-play               # config pda: master mint + Raydium CPMM program

npm run bot                     # Telegram / Discord / X, whichever have credentials, + metadata server on :8787
KOTH_DRY_RUN=1 KOTH_MOCK_JUDGE=1 npm run bot      # rehearsal: in-memory master token, free play, no model
```

`launch-master` needs no arguments: the genesis identity ("Master Shill" / `SHILL`, uri = `koth/genesis/genesis.json`
served raw from GitHub) is the placeholder the first king overwrites. Override with `KOTH_MASTER_NAME` /
`KOTH_MASTER_SYMBOL` / `KOTH_MASTER_URI` or positional args.

### Deploy (fly.io)

```bash
cd koth && fly launch --copy-config --no-deploy
fly secrets set KOTH_KEYPAIR=... SOLANA_RPC_KEY=... BIRDEYE_API_KEY=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
  KOTH_DBC_CONFIG=... KOTH_MASTER_MINT=... KOTH_PLAY_PROGRAM_ID=... KOTH_PUBLIC_URL=https://koth-bot.fly.dev OPENZOO_BASE_URL=...
fly deploy
```

The container runs `start.sh`: the openzoo x402 proxy on `:8402` (its burner wallet at `/data/openzoo-wallet.json`,
created on first boot; the logs print the funding address, and every model call is paid from it in TOKEN / USDC /
LEOS) and then `src/bot.ts`. `/data` also holds the hill ledger, quotes, hosted metadata and card images. Point
`KOTH_PUBLIC_URL` at the app's https url so the on-chain `uri` resolves. Keep it to ONE machine (`--ha=false`): the
bot long-polls Telegram and owns the ledger.

`npm run program-keys` generates `program/keys/koth_play-keypair.json` if it is missing and rewrites `declare_id!` in
`program/src/lib.rs` to match, so build and deploy always agree. Keep that file: it is the program's address.

## Tests

```bash
npm test                        # vitest: cards, metadata builders, openzoo client + judge, hill, play client, entry math, commands
npm run test-program            # cargo: PoolState offsets, instruction decoding, layouts
npm run preflight               # read-only mainnet checks: operator balance, $TOKEN mint, master metadata authority
```

Mainnet only: there is no devnet path. The on-chain proof is the launch itself — `create-config`,
`launch-master`, then `update-metadata` and `read-metadata` show the rewrite. The Raydium CPMM `PoolState`
offsets the program trusts (discriminator `f7ede3f5d7c3de46`, `lp_mint` @136, `token_0_mint` @168,
`token_1_mint` @200, length 637) were verified against live mainnet pools.

## Config

See `.env.example`. Notable:

- `SOLANA_RPC_KEY` (Helius) or a full `SOLANA_RPC_URL`, mainnet only; `BIRDEYE_API_KEY` for holder counts.
- `KOTH_QUOTE_MINT` — the curve's quote mint, `$TOKEN` by default.
- `KOTH_INFERENCE_PAY` — `TOKEN` | `LEOS` | `USDC`: what the inference share of each quote becomes.
- `OPENZOO_BASE_URL`, `KOTH_MODEL` (`openzoo/auto` lets the zoo route), `OPENZOO_WALLET_ADDRESS`.
- `KOTH_PUBLIC_URL` — where `/metadata/*.json` and `/assets/*` are reachable (the on-chain `uri` points there), or `PINATA_JWT`.
- `KOTH_RENDER_PYTHON=1` — draw kings with leCore instead of the SVG card.
