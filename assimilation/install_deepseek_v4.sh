#!/bin/sh
# HRR-attach leCore onto DeepSeek-V4 Flash. Does NOT call GDNRuntime.
#   ./install_deepseek_v4.sh MODEL_DIR OUT_DIR
#   ./install_deepseek_v4.sh MODEL_DIR OUT_DIR --doc FILE --registers 16
# Qwen stays on ./install.sh -- this script refuses a non-DeepSeek-V4 card.
export GALVATRON_CWD="$PWD"
cd "$(dirname "$0")/.." || exit 1
if [ $# -lt 2 ]; then
  echo "usage: $0 MODEL_DIR OUT_DIR [--doc FILE] [--registers N] [--passages N]"
  echo "  MODEL_DIR must contain a DeepSeek-V4 config.json"
  echo "  shards are NOT loaded; the base checkpoint is not copied"
  exit 1
fi
SRC="$1"; shift
DST="$1"; shift
if [ ! -f "$SRC/config.json" ] && [ ! -f "$SRC" ]; then
  echo "  [!] no config.json at $SRC"
  exit 1
fi
echo "  DeepSeek-V4 HRR-attach  $SRC  ->  $DST"
PYTHONHASHSEED=0 python3 assimilation/install_deepseek_v4.py "$SRC" "$DST" "$@"
