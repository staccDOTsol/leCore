#!/bin/sh
# One container, two processes: the openzoo x402-paying proxy (all inference goes through it) and the bot.
# The proxy's burner wallet lives on the /data volume so it survives deploys; fund it at the address it prints.
set -e
export OPENZOO_WALLET="${OPENZOO_WALLET:-/data/openzoo-wallet.json}"
export OPENZOO_PORT="${OPENZOO_PORT:-8402}"
export OPENZOO_BASE_URL="${OPENZOO_BASE_URL:-http://127.0.0.1:${OPENZOO_PORT}/v1}"
mkdir -p /data
( openzoo proxy 2>&1 | sed 's/^/[openzoo] /' ) &
sleep 3
exec tsx src/bot.ts
