# DeepSeek-V4 Flash -- HRR-attach bridge

Smallest slice: detect Flash, refuse the Qwen GDN installer, attach
registers and searchable passages in a **sidecar**. The Qwen path
(`assimilation/install.py`, `GDNRuntime`) is unchanged.

This is **not** assimilate compression, not a MoE runtime, and not
in-weight Galvatron. One-shard F8/FP4 peek is included; 48-shard eager
load is not.

## CLI

From the repo root. `MODEL_DIR` needs a Hugging Face `config.json`
(`model_type` `deepseek_v4`, or `architectures` containing
`DeepseekV4ForCausalLM`). Weight shards are **not** all loaded.

```bash
python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR
python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR --smoke-shard
python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR --doc FILE --registers 16 --passages 24
./assimilation/install_deepseek_v4.sh MODEL_DIR OUT_DIR --smoke-shard
```

Windows:

```bat
assimilation\install_deepseek_v4.bat MODEL_DIR OUT_DIR
```

Flags:

| flag | default | meaning |
|---|---|---|
| `--doc FILE` | built-in 6 passages | split a text file into searchable passages |
| `--registers N` | 16 | orthonormal key slots in the sidecar |
| `--passages N` | all provided | cap on indexed passages |
| `--hrr-dim N` | 256 | sidecar HRR dimension |
| `--seed N` | 0 | regenerates registers and the passage codebook |
| `--smoke-shard [PATH]` | off | peek ONE shard: F8_E8M0 / F8_E4M3 / packed FP4 LUT. `auto` = smallest file |

`OUT_DIR` receives:

- `lecore.json` -- what installed, what skipped, and why
- `lecore_hrr.npz` -- register basis + passage vectors
- `config.json` -- copy of the card (not the 156G weights)
- `BASE.txt` -- absolute path of `MODEL_DIR`

The base checkpoint is left byte-identical. Do not point
`assimilation/install.py` at Flash; it will refuse and print this CLI.

## What attaches

| faculty | result | where |
|---|---|---|
| **registers** | real. Seed-derived orthonormal keys, same object Qwen stores. Regenerable from `(dim, n, seed)`. | sidecar |
| **memory_index / passages** | real. HRR bundle of passage tokens, cosine search. | sidecar |
| **router** | **skipped**. A router is a ridge discriminant on early hidden states. That needs a working forward. `GDNRuntime` is Qwen3-Next only and is not called here. | -- |

In-weight enforcement (orthogonalise the model's own GDN keys; write
addresses into unused vocab rows; fit a gate on prepended layer 0) is
skipped with a reason in `lecore.json`. Flash has no Gated DeltaNet
recurrent state on this path. A skip is not recorded as `ok`.

## Search the sidecar

```python
from holographic.io_and_interop.holographic_deepseek_v4 import (
    load_sidecar, search_index)

idx = load_sidecar("OUT_DIR/lecore_hrr.npz")
print(search_index(idx, "capital of France", k=3))
```

## Qwen path (unchanged)

```bash
./assimilation/install.sh MODEL_DIR OUT_DIR          # Qwen3-Next / Qwen3.5 GDN
python assimilation/install.py MODEL_DIR OUT_DIR     # same
```

If that installer sees `model_type=deepseek_v4`, it exits with a pointer
at `install_deepseek_v4.py` instead of loading shards into `GDNRuntime`.
`load_runtime()` does the same refuse **before** opening weight files.

## Out of scope (this PR)

- 48-shard / 156G eager load
- MoE forward
- assimilate / Unicron compression
- in-weight prepend, HRNN ladder, GDN router, head-row index
