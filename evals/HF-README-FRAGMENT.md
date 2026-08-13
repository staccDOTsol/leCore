# Hugging Face model card fragment — in-weight HRR on DeepSeek V4-Flash

**Base model:** DeepSeek-V4-Flash-0731 (`DeepSeek-V4-Flash-0731-serve`)
**License:** MIT (DeepSeek V4)
**This card:** holographic reduced representation (HRR) overlay in the served weights, plus a Gateway that can auto-stick memory across turns.

This is not a new pretrained LLM. It is Flash with an in-weight HRR overlay. Do **not** read the numbers below as an OpenRouter live listing — OpenRouter was not run. Do **not** read 64 embed-row passages as Galvatron-in-Flash GDN. Flash has no GDN.

## What HRR is for (plain)

- **Sticky memory.** Facts bound into the overlay can be recalled on a later turn without pasting the transcript back, when the Gateway auto-sticky lane is on.
- **Bind / unbind.** A role and a filler become one vector (`bind`); `unbind` pulls the filler back. That is how a nonce, a citation, or a slot value is stored and cited.
- **Damage-tolerant state.** The overlay is holographic: partial or noisy traces still retrieve, instead of a hard key miss.

The pitch is that memory, not a GSM8K bump.

## MEMORY SIG DIFF (headline)

Measured on the **live in-weight overlay** through **Gateway auto-sticky** (no extra headers for the ON lane). Host: lab Gateway `http://127.0.0.1:8765/v1`. Same overlay both arms: `DeepSeek-V4-Flash-0731-serve`. Public raw vLLM (no Gateway): `http://198.145.108.57:30739/v1`.

| arm | T2 nonce cite | Multi-turn 3-cite | Re-prompts |
|---|---|---|---|
| sticky OFF | 0/5 | 0/3 | must re-paste the citations |
| sticky ON | 5/5 | 3/3 | 1 ask, no paste |
| OG commodity OpenRouter | NOT RUN | NOT RUN | NOT RUN |

Raw vLLM does not auto-sticky. A nonce remember/recall against `:30739` with a fresh request (no client history) scored **0/5** from Cursor cloud (2026-08-13). That is not a regression of the Gateway table above.

SWE-bench / Terminal-Bench: harness gap — not attempted, not claimed.

## Appendix — capability lite (no-regress)

Quality slices so this README is not empty of ordinary numbers. They may be flat vs published Flash. They are **not** the headline. First-n lite, temperature 0, sequential, host `http://198.145.108.57:30739/v1`, model `/workspace/models/DeepSeek-V4-Flash-0731-serve`, run 2026-08-13.

| bench | n | source | score | accuracy | latency p50 (s) |
|---|---|---|---|---|---|
| GSM8K | 20 | openai/gsm8k test offset=0 | 20/20 | 100.0% | 0.342 |
| MATH-500 | 20 | HuggingFaceH4/MATH-500 test offset=0 | 16/20 | 80.0% | 0.905 |
| HumanEval | 10 | openai/openai_humaneval test offset=0 | 10/10 | 100.0% | 0.343 |
| IFEval | 20 | google/IFEval train offset=0 | 19/20 prompt-level strict-lite | 95.0% | 2.394 |
| GPQA | — | skipped (too long) | skipped | — | — |

MATH-500: 3/20 hit `finish_reason=length` at max_tokens=1024 (counted miss); 1/20 wrong answer. IFEval is a lite checker in-repo (not the official google-research package); instruction-level strict-lite 29/30. HTTP errors: 0. SWE-bench / Terminal-Bench not attempted.

Exact n, prompts, and item traces: `evals/flash-hrr-benches.md` and `evals/results/flash_hrr_lite.json` in leCore.
