# Flash HRR benches

## MEMORY SIG DIFF

Measured on the **live in-weight overlay** through **Gateway auto-sticky** (no extra headers for the ON lane).

| arm | host | overlay | T2 nonce cite | Multi-turn 3-cite | Re-prompts |
|---|---|---|---|---|---|
| sticky OFF | lab box Gateway http://127.0.0.1:8765/v1 | `DeepSeek-V4-Flash-0731-serve` | 0/5 | 0/3 | must re-paste the citations |
| sticky ON | lab box Gateway http://127.0.0.1:8765/v1 | `DeepSeek-V4-Flash-0731-serve` | 5/5 | 3/3 | 1 ask, no paste |
| OG commodity OpenRouter | — | — | NOT RUN | NOT RUN | NOT RUN |

Same overlay both Gateway arms: `DeepSeek-V4-Flash-0731-serve` (served model id `/workspace/models/DeepSeek-V4-Flash-0731-serve`). Public raw vLLM (no Gateway): `http://198.145.108.57:30739/v1`. OG commodity OpenRouter column was **not run** — empty, not invented.

SWE-bench / Terminal-Bench: harness gap — not attempted, not claimed.

## Raw vLLM memory probe (this run)

Host: `http://198.145.108.57:30739/v1`. Model: `/workspace/models/DeepSeek-V4-Flash-0731-serve`. n=5 nonce remember/recall, **fresh request** (no client history, no Gateway). Score: **0/5**.

raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. This probe used a fresh request (no client-side history, no extra headers).

Recall failed, as expected on raw vLLM. **Do not treat this as a regression of the Gateway SIG DIFF (0/5 vs 5/5).**

| trial | nonce | cited on recall | recall head |
|---|---|---|---|
| 0 | `HRR-SIG-61ae93b85888-0` | no | 0 |
| 1 | `HRR-SIG-5ba4df1dd387-1` | no | I don’t have any record of a nonce you asked me to remember in this thread. |
| 2 | `HRR-SIG-ce20ad610e0c-2` | no | 0 |
| 3 | `HRR-SIG-d7e4651232e5-3` | no | 0 |
| 4 | `HRR-SIG-784794d059b3-4` | no | I don’t have any record of a nonce you asked me to remember in this thread. |

## Appendix — capability lite (no-regress, not the pitch)

GSM8K / MATH-500 / HumanEval / IFEval are quality numbers so a Hugging Face README is not empty. They may be flat vs published Flash. These are **first-n lite slices**, not full-set published scores. GPQA skipped (too long for this lite pass). SWE-bench / Terminal-Bench not attempted.

| bench | n | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|
| GSM8K | 20 | openai/gsm8k main/test via HuggingFace datasets-server offset=0 length=20 | 20/20 | 100.0% | 0.342 | 0 |
| MATH-500 | 20 | HuggingFaceH4/MATH-500 test via HuggingFace datasets-server offset=0 length=20 | 16/20 | 80.0% | 0.905 | 0 |
| HumanEval | 10 | openai/openai_humaneval test via HuggingFace datasets-server offset=0 length=10 | 10/10 | 100.0% | 0.343 | 0 |
| IFEval | 20 | google/IFEval train via HuggingFace datasets-server offset=0 length=20 (same order as google-research instruction_following_eval/data/input_data.jsonl head) | 19/20 | 95.0% | 2.394 | 0 |
| GPQA | — | skipped (too long) | skipped | — | — | — |

MATH-500: 3/20 items ended with `finish_reason=length` (counted as misses). Remaining misses are wrong answers, not HTTP errors.

IFEval instruction-level strict-lite: **29/30**. Grader: lite IFEval checkers in evals/flash_hrr_api_eval.py (strict-ish; json allows a single markdown fence; Kannada via Unicode block U+0C80–U+0CFF; not the official google-research package)

Exact prompt sources for rows that ran:

- **GSM8K** (n=20): openai/gsm8k main/test via HuggingFace datasets-server offset=0 length=20
- **MATH-500** (n=20): HuggingFaceH4/MATH-500 test via HuggingFace datasets-server offset=0 length=20
- **HumanEval** (n=10): openai/openai_humaneval test via HuggingFace datasets-server offset=0 length=10
- **IFEval** (n=20): google/IFEval train via HuggingFace datasets-server offset=0 length=20 (same order as google-research instruction_following_eval/data/input_data.jsonl head)

### Run metadata

| field | value |
|---|---|
| started_utc | 2026-08-13T03:10:42.223577+00:00 |
| finished_utc | 2026-08-13T03:12:22.090395+00:00 |
| base_url | `http://198.145.108.57:30739/v1` |
| model | `/workspace/models/DeepSeek-V4-Flash-0731-serve` |
| temperature | 0.0 |
| timeout_s | 180 |
| sequential | yes |
| overall latency p50 (s) | 0.409 |
| client errors | 0 |
| reachable | True |

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
