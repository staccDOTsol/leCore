# Hugging Face model card fragment — in-weight HRR on DeepSeek V4-Flash

**Base model:** DeepSeek-V4-Flash-0731 (`DeepSeek-V4-Flash-0731-serve`)  
**License:** MIT (DeepSeek V4)  
**This card:** holographic reduced representation (HRR) overlay in the served weights, plus a Gateway that can auto-stick memory across turns.

This is not a new pretrained LLM. It is Flash with an in-weight HRR overlay. Do **not** read the numbers below as an OpenRouter live listing — OpenRouter was not run. Do **not** read 64 embed-row passages as Galvatron-in-Flash GDN. Flash has no GDN.

## Evals (raw vLLM, temperature 0)

Host `http://198.145.108.57:30739/v1`, model `/workspace/models/DeepSeek-V4-Flash-0731-serve`. Sequential or conc≤2. Coverage column says **full** vs **first-n** — do not read a first-n score as a full-set published number. SWE-bench / Terminal-Bench / DeepSWE / OSWorld not attempted (harness gap).

| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |
|---|---|---|---|---|---|---|---|
| MMLU-Pro | 3447 | first-n (n=3447 of 12032) | TIGER-Lab/MMLU-Pro test via HuggingFace datasets-server (full test) | 2743/3447 | 79.6% | 0.581 | 0 |
| GPQA-Diamond | 198 | full | OpenAI simple-evals gpqa_diamond.csv (https://openaipublic.blob.core.windows.net/simple... | 144/198 | 72.7% | 1.978 | 0 |
| AIME 2024 | 30 | full | HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I) | 18/30 | 60.0% | 4.642 | 0 |
| AIME 2025 | 30 | full | math-ai/aime25 test via HuggingFace datasets-server (n=30) | 15/30 | 50.0% | 9.143 | 1 |
| LiveCodeBench | 342 | full | livecodebench/code_generation_lite v5_v6 files v5:167, v6:175 (HuggingFace resolve/main... | 97/342 | 28.4% | 1.173 | 0 |
| GSM8K | 1319 | full | openai/gsm8k main/test via HuggingFace datasets-server (full test) | 1280/1319 | 97.0% | 0.573 | 0 |
| MATH-500 | 500 | full | HuggingFaceH4/MATH-500 test via HuggingFace datasets-server (full, n=500) | 448/500 | 89.6% | 1.326 | 0 |
| HumanEval | 164 | full | openai/openai_humaneval test via HuggingFace datasets-server (full, n=164) | 150/164 | 91.5% | 0.678 | 0 |
| IFEval | 541 | full | google/IFEval train via HuggingFace datasets-server (full, n=541; same order as google-... | 467/541 | 86.3% | 3.481 | 0 |

IFEval is an in-repo checker (not official google-research); instruction-level strict-lite **757/834**.

LiveCodeBench is `code_generation_lite` `v5_v6` (n=342), local Python exec of public tests plus decoded private tests when the blob is small enough — not the official `lcb_runner` package. pass@1, one sample.

GPQA-Diamond is the 198-item Diamond split (OpenAI simple-evals CSV), n_repeats=1, A–D shuffled from sha256(Record ID). Item text is not republished in traces.

This HF file is 30 problems (AIME I 2024), not both AIME I+II (60).

HTTP errors on rows that ran: see the errors column. Traces: `evals/results/flash_hrr_full.json` in leCore.

## What HRR is for (plain)

- **Sticky memory.** Facts bound into the overlay can be recalled on a later turn without pasting the transcript back, when the Gateway auto-sticky lane is on.
- **Bind / unbind.** A role and a filler become one vector (`bind`); `unbind` pulls the filler back. That is how a nonce, a citation, or a slot value is stored and cited.
- **Damage-tolerant state.** The overlay is holographic: partial or noisy traces still retrieve, instead of a hard key miss.

The pitch is that memory, not a GSM8K bump.

## MEMORY SIG DIFF (differentiator)

Measured on the **live in-weight overlay** through **Gateway auto-sticky** (no extra headers for the ON lane). Host: lab Gateway `http://127.0.0.1:8765/v1`. Same overlay both arms: `DeepSeek-V4-Flash-0731-serve`. Public raw vLLM (no Gateway): `http://198.145.108.57:30739/v1`.

| arm | T2 nonce cite | Multi-turn 3-cite | Re-prompts |
|---|---|---|---|
| sticky OFF | 0/5 | 0/3 | must re-paste the citations |
| sticky ON | 5/5 | 3/3 | 1 ask, no paste |
| OG commodity OpenRouter | NOT RUN | NOT RUN | NOT RUN |

Raw vLLM does not auto-sticky. A nonce remember/recall against `:30739` with a fresh request (no client history) scored **0/5**. That is not a regression of the Gateway table above.

SWE-bench / Terminal-Bench: harness gap — not attempted, not claimed.
