# Flash HRR benches

In-weight holographic reduced representation (HRR) overlay on DeepSeek-V4-Flash-0731-serve — not a new pretrained LLM.

## Capability evals (Flash+HRR-spill gateway, temp 0)

Measured through the **public Flash+HRR-spill gateway** (`deepseek-v4-flash` on `:30739`, Bearer auth). These are **not** vanilla 32k raw-vLLM scores. Prior 32k-raw rows live in `evals/results/suite_*.json` without the `_spill` suffix and must not be mixed. Quality numbers so the card is not empty of ordinary benches. They may be flat vs published Flash. **Not** the pitch except Spill-needle (the spill prove). Coverage is **full** or **first-n**. SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed. OG commodity OpenRouter was **not run** — empty, not invented.

| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|---|
| Spill-needle | 2 | full | synthetic HRR spill needle (NEEDLE_KV_SPILL_9f3c) at ~60%% depth in a repeating warehou... | 0/2 | 0.0% | 1.068 | 0 |
| MMLU-Pro | 2645 | first-n (n=2645 of 12032) | TIGER-Lab/MMLU-Pro test via HuggingFace datasets-server (full test) | 1544/2645 | 58.4% | 0.935 | 675 |
| GPQA-Diamond | 198 | full | OpenAI simple-evals gpqa_diamond.csv (https://openaipublic.blob.core.windows.net/simple... | 138/198 | 69.7% | 5.295 | 0 |
| AIME 2024 | 30 | full | HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I) | 22/30 | 73.3% | 9.823 | 0 |
| AIME 2025 | 30 | full | math-ai/aime25 test via HuggingFace datasets-server (n=30) | 16/30 | 53.3% | 8.626 | 0 |
| LiveCodeBench | 342 | full | livecodebench/code_generation_lite v5_v6 files v5:167, v6:175 (HuggingFace resolve/main... | 105/342 | 30.7% | 6.363 | 11 |
| GSM8K | 1319 | full | openai/gsm8k main/test via HuggingFace datasets-server (full test) | 1274/1319 | 96.6% | 1.879 | 2 |
| MATH-500 | 500 | full | HuggingFaceH4/MATH-500 test via HuggingFace datasets-server (full, n=500) | 449/500 | 89.8% | 6.883 | 2 |
| HumanEval | 164 | full | openai/openai_humaneval test via HuggingFace datasets-server (full, n=164) | 147/164 | 89.6% | 2.242 | 0 |
| IFEval | 541 | full | google/IFEval train via HuggingFace datasets-server (full, n=541; same order as google-... | 473/541 | 87.4% | 7.578 | 2 |

IFEval instruction-level strict-lite: **766/834**. Grader: in-repo IFEval checkers in evals/flash_hrr_api_eval.py (strict-ish; json allows a single markdown fence; Kannada via Unicode block U+0C80–U+0CFF; other languages via langdetect if installed else fail-closed; sentence count is regex not nltk; not the official google-research package)

LiveCodeBench: version `v5_v6`, private decoded 284, private skipped 58. local stdin/functional Python exec of public tests plus decoded private tests; not the official lcb_runner package. pass@1, temp 0, n=1 sample.

GPQA-Diamond grader: A-D letter extract; choices shuffled sha256(Record ID); n_repeats=1; item text omitted from traces (GPQA anti-contamination)

AIME 2024: This HF file is 30 problems (AIME I 2024), not both AIME I+II (60).

## MEMORY SIG DIFF

Measured on the **live in-weight overlay** through **Gateway auto-sticky** (no extra headers for the ON lane). This is the differentiator.

| arm | host | overlay | T2 nonce cite | Multi-turn 3-cite | Re-prompts |
|---|---|---|---|---|---|
| sticky OFF | lab box Gateway http://127.0.0.1:8765/v1 | `DeepSeek-V4-Flash-0731-serve` | 0/5 | 0/3 | must re-paste the citations |
| sticky ON | lab box Gateway http://127.0.0.1:8765/v1 | `DeepSeek-V4-Flash-0731-serve` | 5/5 | 3/3 | 1 ask, no paste |
| OG commodity OpenRouter | — | — | NOT RUN | NOT RUN | NOT RUN |

Same overlay both Gateway arms: `DeepSeek-V4-Flash-0731-serve` (served model id `/workspace/models/DeepSeek-V4-Flash-0731-serve`). Public Flash+HRR-spill gateway: `http://198.145.108.57:30739/v1` model `deepseek-v4-flash`. OG commodity OpenRouter column was **not run** — empty, not invented.

SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed.

## Raw vLLM memory probe (this run)

NOT RUN. Raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. Lab 0/5 vs 5/5 numbers above are the measured headline.

### Exact prompt sources for rows that ran

- **Spill-needle** (n=2, coverage=full): synthetic HRR spill needle (NEEDLE_KV_SPILL_9f3c) at ~60%% depth in a repeating warehouse haystack. Targets 250k and 500k tokens (char/4 heuristic). This is the spill prove, not a capability quiz.
- **MMLU-Pro** (n=2645, coverage=first-n (n=2645 of 12032)): TIGER-Lab/MMLU-Pro test via HuggingFace datasets-server (full test)
- **GPQA-Diamond** (n=198, coverage=full): OpenAI simple-evals gpqa_diamond.csv (https://openaipublic.blob.core.windows.net/simple-evals/gpqa_diamond.csv); Idavidrein/gpqa Diamond split; n=198. Choices shuffled via sha256(Record ID).
- **AIME 2024** (n=30, coverage=full): HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I)
- **AIME 2025** (n=30, coverage=full): math-ai/aime25 test via HuggingFace datasets-server (n=30)
- **LiveCodeBench** (n=342, coverage=full): livecodebench/code_generation_lite v5_v6 files v5:167, v6:175 (HuggingFace resolve/main). Private tests decoded when encoded size ≤ 2000000 bytes (284 decoded, 58 public-only).
- **GSM8K** (n=1319, coverage=full): openai/gsm8k main/test via HuggingFace datasets-server (full test)
- **MATH-500** (n=500, coverage=full): HuggingFaceH4/MATH-500 test via HuggingFace datasets-server (full, n=500)
- **HumanEval** (n=164, coverage=full): openai/openai_humaneval test via HuggingFace datasets-server (full, n=164)
- **IFEval** (n=541, coverage=full): google/IFEval train via HuggingFace datasets-server (full, n=541; same order as google-research instruction_following_eval/data/input_data.jsonl)

### Run metadata

| field | value |
|---|---|
| started_utc |  |
| finished_utc | 2026-08-13T07:22:36.707216+00:00 |
| base_url | `http://198.145.108.57:30739/v1` |
| model | `deepseek-v4-flash` |
| temperature | 0.0 |
| timeout_s | 180 |
| concurrency | parallel suites, conc=1 each, ~8 in-flight cap |
| scale | full |
| overall latency p50 (s) | 6.363 |
| client errors | 0 |
| reachable | True |

Suites run as separate processes against the Flash+HRR-spill gateway (deepseek-v4-flash, Bearer auth). Not vanilla 32k raw vLLM. OG OpenRouter NOT RUN. SWE/Terminal-Bench/DeepSWE not attempted.

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
