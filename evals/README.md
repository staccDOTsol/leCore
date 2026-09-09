# Flash HRR API evals

**API-only** benches for the in-weight HRR overlay on DeepSeek V4-Flash.
No local GPU. Does not download Flash weights. `chat/completions`, temperature 0,
concurrency ≤2.

## Headline vs quality table

**MEMORY SIG DIFF** is the differentiator (lab Gateway auto-sticky,
`http://127.0.0.1:8765/v1`, same overlay both arms). A raw-vLLM probe must not
overwrite those numbers.

The **capability table** is quality / no-regress (may be flat vs published Flash).
High-bar first: MMLU-Pro, GPQA-Diamond, AIME 2024/2025, LiveCodeBench.
Floor: GSM8K, MATH-500, HumanEval, IFEval. Coverage is `full` or `first-n` —
do not quote the old n=20 lite slices as the card.

SWE-bench / Terminal-Bench / DeepSWE / OSWorld are a harness gap — not attempted,
not claimed. OG commodity OpenRouter was **not run**. Empty cell, not a fake delta.

## Run

```bash
# graders only
python evals/flash_hrr_api_eval.py --selftest

# fetch official splits into evals/data/cache/ (gitignored)
python evals/flash_hrr_data.py --sets gsm8k,math,humaneval,ifeval,mmlupro,aime24,aime25,gpqa,lcb

# full card (live Flash API)
python evals/flash_hrr_api_eval.py \
  --base-url http://198.145.108.57:30739/v1 \
  --model /workspace/models/DeepSeek-V4-Flash-0731-serve \
  --scale full --concurrency 2
```

`--scale lite` still runs the pinned 20/20/10/20 slices under `evals/data/`.
`--n N` caps each suite at first-n (documented as first-n, not full).

Writes:

- `evals/flash-hrr-benches.md`
- `evals/HF-README-FRAGMENT.md`
- `evals/results/flash_hrr_full.json` (item traces)

| suite | intended split | n |
|---|---|---|
| MMLU-Pro | TIGER-Lab/MMLU-Pro test | 12032 full (or first-n ≥200 if too slow) |
| GPQA-Diamond | OpenAI simple-evals `gpqa_diamond.csv` | 198 |
| AIME 2024 | HuggingFaceH4/aime_2024 | 30 (AIME I, not I+II) |
| AIME 2025 | math-ai/aime25 test | 30 |
| LiveCodeBench | code_generation_lite `v5_v6` | latest two incremental files |
| GSM8K | openai/gsm8k test | 1319 |
| MATH-500 | HuggingFaceH4/MATH-500 test | 500 |
| HumanEval | openai/openai_humaneval test | 164 |
| IFEval | google/IFEval train | 541 |

IFEval scoring is an **in-repo** checker (strict-ish). It is not the official
google-research package. LiveCodeBench is local stdin/functional exec, not
`lcb_runner`. MATH retries `max_tokens=4096` on `finish_reason=length`.

GitHub Actions: [`.github/workflows/eval-flash-api.yml`](../.github/workflows/eval-flash-api.yml)
(`workflow_dispatch`, `scale` lite|full).
