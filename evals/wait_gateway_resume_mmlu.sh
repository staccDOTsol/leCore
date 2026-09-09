#!/usr/bin/env bash
# Wait until the public Flash+HRR-spill gateway answers GET /v1/models with 200,
# then resume MMLU-Pro. Do not hit raw vLLM.
set -u
BASE_URL="${FLASH_EVAL_BASE_URL:-http://198.145.108.57:30739/v1}"
KEY="${FLASH_EVAL_API_KEY:-sk-lecore-dogfood}"
LOG=/workspace/evals/results/run_mmlupro_spill.log
cd /workspace
echo "waiting for ${BASE_URL}/models ..." | tee -a "$LOG"
delay=10
while true; do
  code=$(python3 - <<'PY'
import urllib.request, sys
url = "http://198.145.108.57:30739/v1/models"
req = urllib.request.Request(url, headers={"Authorization": "Bearer sk-lecore-dogfood"}, method="GET")
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        print(resp.status)
except Exception as e:
    print(0)
    print(type(e).__name__, e, file=sys.stderr)
PY
)
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) GET /v1/models -> ${code}" | tee -a "$LOG"
  if [ "$code" = "200" ]; then
    break
  fi
  sleep "$delay"
  delay=$(( delay < 60 ? delay + 5 : 60 ))
done
echo "gateway 200; resuming MMLU-Pro" | tee -a "$LOG"
export PYTHONPATH=/workspace FLASH_EVAL_RESUME_SUFFIX=spill
python3 evals/flash_hrr_api_eval.py \
  --base-url "$BASE_URL" \
  --model deepseek-v4-flash \
  --api-key "$KEY" \
  --scale full \
  --concurrency 2 \
  --timeout 180 \
  --temperature 0 \
  --resume-suffix spill \
  --suites mmlupro \
  --out-md evals/results/tmp_mmlupro_spill.md \
  --out-hf evals/results/tmp_mmlupro_spill.hf.md \
  --out-json evals/results/suite_mmlupro_spill.json \
  2>&1 | tee -a "$LOG"
echo "EXIT:${PIPESTATUS[0]}" >> "$LOG"
