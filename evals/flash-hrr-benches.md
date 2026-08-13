# Flash HRR benches

In-weight holographic reduced representation (HRR) overlay on DeepSeek-V4-Flash-0731-serve — not a new pretrained LLM.

## Capability evals (raw vLLM, temp 0)

Quality numbers so the card is not empty of ordinary benches. They may be flat vs published Flash. **Not** the pitch. High-bar sets first (MMLU-Pro / GPQA-Diamond / AIME / LiveCodeBench); GSM8K / MATH-500 / HumanEval / IFEval are the floor. Coverage is **full** or **first-n** — never quote a lite n=20 leftover as the card. SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed. OG commodity OpenRouter was **not run** — empty, not invented.

| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|---|
| MMLU-Pro | 12032 | — | TIGER-Lab/MMLU-Pro test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| GPQA-Diamond | 198 | full | OpenAI simple-evals gpqa_diamond.csv (https://openaipublic.blob.core.windows.net/simple... | 144/198 | 72.7% | 1.978 | 0 |
| AIME 2024 | 30 | full | HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I) | 18/30 | 60.0% | 4.642 | 0 |
| AIME 2025 | 30 | full | math-ai/aime25 test via HuggingFace datasets-server (n=30) | 15/30 | 50.0% | 9.143 | 1 |
| LiveCodeBench | 342 | full | livecodebench/code_generation_lite v5_v6 files v5:167, v6:175 (HuggingFace resolve/main... | 97/342 | 28.4% | 1.173 | 0 |
| GSM8K | 1319 | full | openai/gsm8k main/test via HuggingFace datasets-server (full test) | 1280/1319 | 97.0% | 0.573 | 0 |
| MATH-500 | 500 | full | HuggingFaceH4/MATH-500 test via HuggingFace datasets-server (full, n=500) | 448/500 | 89.6% | 1.326 | 0 |
| HumanEval | 164 | full | openai/openai_humaneval test via HuggingFace datasets-server (full, n=164) | 150/164 | 91.5% | 0.678 | 0 |
| IFEval | 541 | full | google/IFEval train via HuggingFace datasets-server (full, n=541; same order as google-... | 467/541 | 86.3% | 3.481 | 0 |

MATH-500: 2/500 items still `finish_reason=length` after 4096 retry (counted as misses).

IFEval instruction-level strict-lite: **757/834**. Grader: in-repo IFEval checkers in evals/flash_hrr_api_eval.py (strict-ish; json allows a single markdown fence; Kannada via Unicode block U+0C80–U+0CFF; other languages via langdetect if installed else fail-closed; sentence count is regex not nltk; not the official google-research package)

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

Same overlay both Gateway arms: `DeepSeek-V4-Flash-0731-serve` (served model id `/workspace/models/DeepSeek-V4-Flash-0731-serve`). Public raw vLLM (no Gateway): `http://198.145.108.57:30739/v1`. OG commodity OpenRouter column was **not run** — empty, not invented.

SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed.

## Raw vLLM memory probe (this run)

Host: `http://198.145.108.57:30739/v1`. Model: `/workspace/models/DeepSeek-V4-Flash-0731-serve`. n=5 nonce remember/recall, **fresh request** (no client history, no Gateway). Score: **0/5**.

raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. This probe used a fresh request (no client-side history, no extra headers).

Recall failed, as expected on raw vLLM. **Do not treat this as a regression of the Gateway SIG DIFF (0/5 vs 5/5).**

| trial | nonce | cited on recall | recall head |
|---|---|---|---|
| 0 | `HRR-SIG-062d78ac3a87-0` | no | 7f3a9c2b8e4d1a6f |
| 1 | `HRR-SIG-91cf843904c6-1` | no | I don’t have any record of a nonce you asked me to remember in this thread. |
| 2 | `HRR-SIG-4956a72444b4-2` | no | 0 |
| 3 | `HRR-SIG-7162d1084600-3` | no | I don’t have any record of a nonce you asked me to remember in this thread. |
| 4 | `HRR-SIG-9af7b89c344f-4` | no | 0 |

### Exact prompt sources for rows that ran

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
| started_utc | 2026-08-13T03:36:55.198043+00:00 |
| finished_utc | 2026-08-13T04:30:32.227758+00:00 |
| base_url | `http://198.145.108.57:30739/v1` |
| model | `/workspace/models/DeepSeek-V4-Flash-0731-serve` |
| temperature | 0.0 |
| timeout_s | 180 |
| concurrency | parallel suites, conc=1 each, ~8 in-flight cap |
| scale | full |
| overall latency p50 (s) | 1.978 |
| client errors | 0 |
| reachable | True |

Suites run as separate processes (resume JSONL). OG OpenRouter NOT RUN. SWE/Terminal-Bench/DeepSWE not attempted.

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
