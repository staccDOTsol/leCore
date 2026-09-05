#!/usr/bin/env sh
# Stand up the three pieces that make transmuted sites and leCore doors live.
# Run from the leCore repo root on a machine with flyctl logged in. Idempotent.
#
#   1. lecore-service   — leCore's HTTP service (/tools /invoke /door /doors): the
#                         gateway's real "lecore-front"
#   2. x402-tokens      — point the gateway at it (branch lecore-doors must be deployed)
#   3. openzoo-sites    — the hosted explorer for every transmuted site on mainnet
set -eu
TOKEN="${LECORE_TOKEN:-sk-lecore-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

echo "== 1. lecore-service"
flyctl apps create lecore-service --org personal 2>/dev/null || true
flyctl volumes list -a lecore-service | grep -q lecore_data || flyctl volumes create lecore_data --size 3 --region iad -a lecore-service --yes
flyctl secrets set LECORE_TOKEN="$TOKEN" -a lecore-service --stage >/dev/null
flyctl deploy --config fly.lecore-service.toml --dockerfile deploy/lecore-service/Dockerfile --remote-only -a lecore-service
curl -sS -H "authorization: Bearer $TOKEN" https://lecore-service.fly.dev/doors | head -c 200; echo

echo "== 2. x402-tokens → lecore-service"
flyctl secrets set LECORE_FRONT_URL=https://lecore-service.fly.dev LECORE_FRONT_KEY="$TOKEN" -a x402-tokens
# (redeploy the gateway from branch lecore-doors if it is not already live)
curl -sS https://x402-tokens.fly.dev/v1/lecore/doors | head -c 200; echo

echo "== 3. openzoo-sites (the hub)"
( cd openzoo-transmute && flyctl apps create openzoo-sites --org personal 2>/dev/null || true; flyctl deploy --remote-only -a openzoo-sites )
curl -sS https://openzoo-sites.fly.dev/.hub/health; echo
echo "hub: https://openzoo-sites.fly.dev/.hub  — a site lives at /s/<programId> once you run: npx openzoo deploy . --cluster mainnet --yes"
