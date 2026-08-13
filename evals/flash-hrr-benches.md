# Flash HRR benches

In-weight holographic reduced representation (HRR) overlay on DeepSeek-V4-Flash-0731-serve — not a new pretrained LLM.

## Capability evals (raw vLLM, temp 0)

Quality numbers so the card is not empty of ordinary benches. They may be flat vs published Flash. **Not** the pitch. High-bar sets first (MMLU-Pro / GPQA-Diamond / AIME / LiveCodeBench); GSM8K / MATH-500 / HumanEval / IFEval are the floor. Coverage is **full** or **first-n** — never quote a lite n=20 leftover as the card. SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed. OG commodity OpenRouter was **not run** — empty, not invented.

| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|---|
| MMLU-Pro | 12032 | — | TIGER-Lab/MMLU-Pro test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| GPQA-Diamond | 198 | — | Idavidrein/gpqa Diamond via OpenAI simple-evals CSV | NOT RUN | NOT RUN | NOT RUN | — |
| AIME 2024 | 30 | — | HuggingFaceH4/aime_2024 (AIME I 2024, 30 not 60) | NOT RUN | NOT RUN | NOT RUN | — |
| AIME 2025 | 30 | — | math-ai/aime25 test | NOT RUN | NOT RUN | NOT RUN | — |
| LiveCodeBench | — | — | livecodebench/code_generation_lite v5_v6 | NOT RUN | NOT RUN | NOT RUN | — |
| GSM8K | 1319 | — | openai/gsm8k test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| MATH-500 | 500 | — | HuggingFaceH4/MATH-500 test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| HumanEval | 164 | — | openai/openai_humaneval test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| IFEval | 541 | — | google/IFEval train (full) | NOT RUN | NOT RUN | NOT RUN | — |

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

NOT RUN. Raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. Lab 0/5 vs 5/5 numbers above are the measured headline.

### Run metadata

| field | value |
|---|---|
| started_utc | 2026-08-13T03:30:43.882559+00:00 |
| finished_utc |  |
| base_url | `http://198.145.108.57:30739/v1` |
| model | `/workspace/models/DeepSeek-V4-Flash-0731-serve` |
| temperature | 0.0 |
| timeout_s | 180 |
| concurrency | 2 |
| scale | full |
| overall latency p50 (s) | — |
| client errors | 0 |
| reachable | True |

Harness upgraded for full/high-bar splits. Live numbers pending this run.

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
