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

Pending live API run from this cloud agent. Raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. Lab 0/5 vs 5/5 numbers above are the measured headline.

## Appendix — capability lite (no-regress, not the pitch)

GSM8K / MATH-500 / HumanEval / IFEval are quality numbers so a Hugging Face README is not empty. They may be flat vs published Flash. GPQA skipped (too long for this lite pass). SWE-bench / Terminal-Bench not attempted.

| bench | n | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|
| GSM8K | 20 | openai/gsm8k test offset=0 | NOT RUN | NOT RUN | NOT RUN | — |
| MATH-500 | 20 | HuggingFaceH4/MATH-500 test offset=0 | NOT RUN | NOT RUN | NOT RUN | — |
| HumanEval | 10 | openai/openai_humaneval test offset=0 | NOT RUN | NOT RUN | NOT RUN | — |
| IFEval | 20 | google/IFEval train offset=0 | NOT RUN | NOT RUN | NOT RUN | — |
| GPQA | — | skipped (too long) | skipped | — | — | — |

Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN (Flash has no GDN; 64 embed-row passages is not GDN).
