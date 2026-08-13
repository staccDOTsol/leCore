# Flash HRR API evals

Lite, **API-only** benches for the in-weight HRR overlay on DeepSeek V4-Flash.
No local GPU. Does not download Flash weights. Sequential `chat/completions`.

## Headline vs appendix

**MEMORY SIG DIFF** is the pitch. It was measured on the lab box through
Gateway auto-sticky (`http://127.0.0.1:8765/v1`), same overlay both arms
(`DeepSeek-V4-Flash-0731-serve`). Those numbers live in
[`flash-hrr-benches.md`](flash-hrr-benches.md) and are **not** overwritten by a
raw-vLLM probe.

GSM8K / MATH-500 / HumanEval / IFEval are **appendix no-regress** (may be flat
vs published Flash). GPQA is skipped when too long. SWE-bench / Terminal-Bench
are a harness gap — not attempted, not claimed.

OG commodity OpenRouter was **not run**. Empty cell, not a fake delta.

## Run

```bash
python evals/flash_hrr_api_eval.py \
  --base-url http://198.145.108.57:30739/v1 \
  --model /workspace/models/DeepSeek-V4-Flash-0731-serve
```

Optional: `--api-key EMPTY` (default), `--timeout 180`, `--temperature 0`,
`--suites memory,gsm8k,math,humaneval,ifeval`.

Writes:

- `evals/flash-hrr-benches.md`
- `evals/results/flash_hrr_lite.json`

Pinned lite slices (exact prompts) are under `evals/data/`. Sources:

| slice | n | source |
|---|---|---|
| GSM8K | 20 | `openai/gsm8k` test, offset 0 |
| MATH-500 | 20 | `HuggingFaceH4/MATH-500` test, offset 0 |
| HumanEval | 10 | `openai/openai_humaneval` test, offset 0 |
| IFEval | 20 | `google/IFEval` train, offset 0 |

IFEval scoring is a **lite** checker in this folder (strict-ish). It is not the
official google-research package. Kannada is Unicode-block, not `langdetect`.

GitHub Actions: [`.github/workflows/eval-flash-api.yml`](../.github/workflows/eval-flash-api.yml)
(`workflow_dispatch`, takes `base_url`).
