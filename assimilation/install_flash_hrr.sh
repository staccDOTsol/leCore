#!/bin/sh
# Flash HRR attach entrypoint.
# In-weight Galvatron is blocked until DeepSeek-V4 runtime bridge lands.
# Sidecar plan/store: assimilation/work/flash0731/hrr_attach/
set -e
cd "$(dirname "$0")/.."
python3 assimilation/smoke_flash_dequant.py
python3 - <<'PY'
import json
from pathlib import Path
p=Path("assimilation/work/flash0731/hrr_attach/hrr_attach_plan.json")
print(p.read_text() if p.exists() else "no plan yet — run bootstrap")
PY
echo "Next: DeepSeek-V4 install bridge PR on staccDOTsol/leCore (cloud agent) or adapter runtime."
