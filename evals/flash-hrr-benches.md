# Flash HRR benches

In-weight holographic reduced representation (HRR) overlay on DeepSeek-V4-Flash-0731-serve — not a new pretrained LLM.

## Capability evals (raw vLLM, temp 0)

Quality numbers so the card is not empty of ordinary benches. They may be flat vs published Flash. **Not** the pitch. High-bar sets first (MMLU-Pro / GPQA-Diamond / AIME / LiveCodeBench); GSM8K / MATH-500 / HumanEval / IFEval are the floor. Coverage is **full** or **first-n** — never quote a lite n=20 leftover as the card. SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed. OG commodity OpenRouter was **not run** — empty, not invented.

| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|---|
| MMLU-Pro | 12032 | — | TIGER-Lab/MMLU-Pro test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| GPQA-Diamond | 198 | — | Idavidrein/gpqa Diamond via OpenAI simple-evals CSV | NOT RUN | NOT RUN | NOT RUN | — |
| AIME 2024 | 30 | full | HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I) | 18/30 | 60.0% | 4.642 | 0 |
| AIME 2025 | 30 | full | math-ai/aime25 test via HuggingFace datasets-server (n=30) | 15/30 | 50.0% | 9.143 | 1 |
| LiveCodeBench | — | — | livecodebench/code_generation_lite v5_v6 | NOT RUN | NOT RUN | NOT RUN | — |
| GSM8K | 1319 | — | openai/gsm8k test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| MATH-500 | 500 | — | HuggingFaceH4/MATH-500 test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| HumanEval | 164 | full | openai/openai_humaneval test via HuggingFace datasets-server (full, n=164) | 150/164 | 91.5% | 0.678 | 0 |
| IFEval | 541 | — | google/IFEval train (full) | NOT RUN | NOT RUN | NOT RUN | — |

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

- **AIME 2024** (n=30, coverage=full): HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I)
- **AIME 2025** (n=30, coverage=full): math-ai/aime25 test via HuggingFace datasets-server (n=30)
- **HumanEval** (n=164, coverage=full): openai/openai_humaneval test via HuggingFace datasets-server (full, n=164)

### Run metadata

| field | value |
|---|---|
| started_utc | 2026-08-13T03:36:55.198043+00:00 |
| finished_utc | 2026-08-13T03:50:23.404369+00:00 |
| base_url | `http://198.145.108.57:30739/v1` |
| model | `/workspace/models/DeepSeek-V4-Flash-0731-serve` |
| temperature | 0.0 |
| timeout_s | 180 |
| concurrency | parallel suites, conc=1 each, ~8 in-flight cap |
| scale | full |
| overall latency p50 (s) | 4.642 |
| client errors | 0 |
| reachable | True |

Suites run as separate processes (resume JSONL). OG OpenRouter NOT RUN. SWE/Terminal-Bench/DeepSWE not attempted.

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
