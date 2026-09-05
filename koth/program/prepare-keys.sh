#!/bin/sh
# Make the program keypair (once) and stamp its address into declare_id!, so the build and the deploy agree.
# Usage: sh program/prepare-keys.sh   (from koth/)   -> prints the program id to put in KOTH_PLAY_PROGRAM_ID
set -e
cd "$(dirname "$0")"
mkdir -p keys
if [ ! -f keys/koth_play-keypair.json ]; then
  solana-keygen new --no-bip39-passphrase -s -o keys/koth_play-keypair.json >/dev/null
fi
ID=$(solana-keygen pubkey keys/koth_play-keypair.json)
sed -i.bak -E "s/declare_id!\(\"[1-9A-HJ-NP-Za-km-z]+\"\)/declare_id!(\"$ID\")/" src/lib.rs && rm -f src/lib.rs.bak
echo "$ID"
