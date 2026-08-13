#!/bin/sh
# Flash-as-HRR consume: recall / attach / serve in front of vLLM.
#   ./flash_hrr.sh recall OUT_DIR "capital of France"
#   ./flash_hrr.sh attach OUT_DIR "what is the capital of France"
#   ./flash_hrr.sh serve  OUT_DIR --upstream http://127.0.0.1:8000 --port 8765
export GALVATRON_CWD="$PWD"
cd "$(dirname "$0")/.." || exit 1
if [ $# -lt 1 ]; then
  echo "usage: $0 recall|attach|serve|status|registers|forward OUT_DIR ..."
  echo "  HRR runs before tokens; generate is the --upstream OpenAI server"
  exit 1
fi
PYTHONHASHSEED=0 python3 assimilation/flash_hrr.py "$@"
