# DeepSeek-V4 Flash -- in-weight HRR + sidecar consume

Detect Flash, refuse the Qwen GDN installer, **write faculties into
unused / placeholder embed rows** (`lecore.json` `in_weight=1`), keep a
sidecar for request-time inject, then consume: recall + Gateway-shaped
system inject (<=1024) BEFORE tokens. Lab generate backend is vLLM.

This is **not** assimilate compression, not a MoE runtime, and not a
claim that `GDNRuntime` runs Flash. One-shard F8/FP4 peek is included;
48-shard eager load is not.

## Why in-weight (Vast H200)

Sidecar inject alone is not the SKU. The H200 job exists to land HRR
**inside Flash weights**. The Flash-legal bank is tokenizer
`place_holder` ids plus unused tail vocab rows of `embed.weight`
(F8/BF16 decode, write, encode). GDN recurrent-state orthogonalisation
is physically absent -- that skip is named, not faked.

## Install

```bash
python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR --smoke-shard
python assimilation/prove_flash_in_weight.py MODEL_DIR OUT_DIR
# expect: FLASH_IN_WEIGHT_OK  and  lecore.json in_weight=1
```

`MODEL_DIR` needs Hugging Face `config.json` (`model_type` `deepseek_v4`
or `architectures` containing `DeepseekV4ForCausalLM`). **One** embed
shard is loaded. `--smoke-shard` peeks ONE file (F8_E8M0 / F8_E4M3 /
packed FP4 LUT).

`OUT_DIR` receives `lecore.json`, `lecore_hrr.npz`, `lecore_in_weight.safetensors`
(and a patched embed shard when the source shard is present), `BASE.txt`.

| faculty | result | where |
|---|---|---|
| **memory_index** | real. Written into placeholder/tail embed rows. `in_weight=1`. | embed + sidecar |
| **registers** | real keys. Written into remaining embed rows when they exist; else sidecar. GDN-state orthogonalisation SKIPPED. | embed and/or sidecar |
| **router** | **skipped** (needs a Flash forward; a stubbed gate is a fake success). Next bridge: Flash-native early-layer hidden states. | -- |
| **HRNN / prepend** | **skipped**. Flash has no GDN recurrent state / Qwen `layer_types`. | -- |

## Serve in-weight (no 156G copy)

```bash
python assimilation/flash_in_weight_serve_dir.py MODEL_DIR OUT_DIR SERVE_DIR
python -m vllm.entrypoints.openai.api_server --model SERVE_DIR --port 8000
python assimilation/flash_hrr.py serve OUT_DIR --upstream http://127.0.0.1:8000 --port 8765
python assimilation/flash_hrr_vllm_inject.py OUT_DIR --cue "What is the capital of France?"
```

`flash_in_weight_serve_dir.py` **symlinks** MODEL_DIR and overlays the
patched embed shard. It does not copy 48 shards.

## Sidecar inject (composes with in-weight)

```
client  -->  FlashHRR.attach(openai_body)  -->  vLLM :8000 /v1/chat/completions
```

```bash
python assimilation/flash_hrr.py recall OUT_DIR "capital of France"
python assimilation/flash_hrr.py attach OUT_DIR "what is the capital of France"
```

## One-shard dequant smoke

```bash
python assimilation/smoke_flash_dequant_oneshard.py \
    MODEL_DIR/model-00002-of-00048.safetensors
# expect DEQUANT_SMOKE_OK
```

## Qwen path (unchanged)

```bash
./assimilation/install.sh MODEL_DIR OUT_DIR
```

A DeepSeek card is refused before shards open, with a pointer at
`install_deepseek_v4.py`.

## Out of scope / honest SKIP

- 48-shard / 156G eager load
- MoE forward / GDNRuntime-as-Flash
- assimilate / Unicron compression as the SKU
- GDN prepend, HRNN ladder, layer-hidden router (next bridge named in `lecore.json` skipped[])
