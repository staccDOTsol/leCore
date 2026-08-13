# Hugging Face model card fragment — in-weight HRR on DeepSeek V4-Flash

**Base model:** DeepSeek-V4-Flash-0731 (`DeepSeek-V4-Flash-0731-serve`)  
**License:** MIT (DeepSeek V4)  
**This card:** holographic reduced representation (HRR) overlay in the served weights, plus a Gateway that can auto-stick memory across turns.

This is not a new pretrained LLM. It is Flash with an in-weight HRR overlay. Do **not** read the numbers below as an OpenRouter live listing — OpenRouter was not run. Do **not** read 64 embed-row passages as Galvatron-in-Flash GDN. Flash has no GDN.

## Evals (Flash+HRR-spill gateway, temperature 0)

Host `http://198.145.108.57:30739/v1`, model `deepseek-v4-flash`, Bearer `sk-lecore-…`. This is the **HRR spill gateway**, not vanilla 32k vLLM. Coverage column says **full** vs **first-n**. SWE-bench / Terminal-Bench / DeepSWE / OSWorld not attempted (harness gap).

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

This HF file is 30 problems (AIME I 2024), not both AIME I+II (60).

HTTP errors on rows that ran: see the errors column. Traces: `evals/results/suite_*_spill.json` in leCore.

## What HRR is for (plain)

- **Sticky memory.** Facts bound into the overlay can be recalled on a later turn without pasting the transcript back, when the Gateway auto-sticky lane is on.
- **Bind / unbind.** A role and a filler become one vector (`bind`); `unbind` pulls the filler back. That is how a nonce, a citation, or a slot value is stored and cited.
- **Damage-tolerant state.** The overlay is holographic: partial or noisy traces still retrieve, instead of a hard key miss.

The pitch is that memory, not a GSM8K bump.

## MEMORY SIG DIFF (differentiator)

Measured on the **live in-weight overlay** through **Gateway auto-sticky** (no extra headers for the ON lane). Host: lab Gateway `http://127.0.0.1:8765/v1`. Same overlay both arms: `DeepSeek-V4-Flash-0731-serve`. Public API is the Flash+HRR-spill gateway `http://198.145.108.57:30739/v1` model `deepseek-v4-flash`.

| arm | T2 nonce cite | Multi-turn 3-cite | Re-prompts |
|---|---|---|---|
| sticky OFF | 0/5 | 0/3 | must re-paste the citations |
| sticky ON | 5/5 | 3/3 | 1 ask, no paste |
| OG commodity OpenRouter | NOT RUN | NOT RUN | NOT RUN |

Raw vLLM does not auto-sticky. A nonce remember/recall against `:30739` with a fresh request is expected to miss; that is not a regression of the Gateway table above.

SWE-bench / Terminal-Bench: harness gap — not attempted, not claimed.
