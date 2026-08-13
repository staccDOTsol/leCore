# Flash HRR benches

In-weight holographic reduced representation (HRR) overlay on DeepSeek-V4-Flash-0731-serve — not a new pretrained LLM.

## Capability evals (Flash+HRR-spill gateway, temp 0)

Measured through the **public Flash+HRR-spill gateway** (`deepseek-v4-flash` on `:30739`, Bearer auth). These are **not** vanilla 32k raw-vLLM scores. Prior 32k-raw rows live in `evals/results/suite_*.json` without the `_spill` suffix and must not be mixed. Quality numbers so the card is not empty of ordinary benches. They may be flat vs published Flash. **Not** the pitch except Spill-needle (the spill prove). Coverage is **full** or **first-n**. SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed. OG commodity OpenRouter was **not run** — empty, not invented.

| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|---|
| Spill-needle | 2 | full | synthetic HRR spill needle (NEEDLE_KV_SPILL_9f3c) at ~60%% depth in a repeating warehou... | 0/2 | 0.0% | 1.068 | 0 |
| MMLU-Pro | 12032 | — | TIGER-Lab/MMLU-Pro test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| GPQA-Diamond | 198 | — | Idavidrein/gpqa Diamond via OpenAI simple-evals CSV | NOT RUN | NOT RUN | NOT RUN | — |
| AIME 2024 | 30 | full | HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I) | 22/30 | 73.3% | 9.823 | 0 |
| AIME 2025 | 30 | — | math-ai/aime25 test | NOT RUN | NOT RUN | NOT RUN | — |
| LiveCodeBench | — | — | livecodebench/code_generation_lite v5_v6 | NOT RUN | NOT RUN | NOT RUN | — |
| GSM8K | 1319 | — | openai/gsm8k test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| MATH-500 | 500 | — | HuggingFaceH4/MATH-500 test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| HumanEval | 164 | — | openai/openai_humaneval test (full) | NOT RUN | NOT RUN | NOT RUN | — |
| IFEval | 541 | — | google/IFEval train (full) | NOT RUN | NOT RUN | NOT RUN | — |

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
- **AIME 2024** (n=30, coverage=full): HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I)

### Run metadata

| field | value |
|---|---|
| started_utc |  |
| finished_utc | 2026-08-13T05:43:25.253978+00:00 |
| base_url | `http://198.145.108.57:30739/v1` |
| model | `deepseek-v4-flash` |
| temperature | 0.0 |
| timeout_s | 180 |
| concurrency | parallel suites, conc=1 each, ~8 in-flight cap |
| scale | full |
| overall latency p50 (s) | 9.823 |
| client errors | 0 |
| reachable | True |

Suites run as separate processes against the Flash+HRR-spill gateway (deepseek-v4-flash, Bearer auth). Not vanilla 32k raw vLLM. OG OpenRouter NOT RUN. SWE/Terminal-Bench/DeepSWE not attempted.

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
