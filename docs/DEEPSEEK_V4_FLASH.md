# DeepSeek-V4 Flash -- HRR-attach + Flash-as-HRR consume

Detect Flash, refuse the Qwen GDN installer, attach registers and
searchable passages in a sidecar, then **consume** that sidecar on the
generation request: recall + Gateway-shaped system inject (<=1024)
BEFORE tokens. Lab generate backend is vLLM's OpenAI server.

This is **not** assimilate compression, not a MoE runtime, and not
in-weight Galvatron. One-shard F8/FP4 peek is included; 48-shard eager
load is not. `GDNRuntime` is not a Flash forward.

## Two layers (compose; they are not the same process)

| layer | what | where |
|---|---|---|
| **External HRR / Gateway** | process-level holographic memory in front of any model. Dogfood HTTP `:7090`, gateway `:8765`. | outside the checkpoint |
| **Flash sidecar (this)** | model-local `lecore.json` + `lecore_hrr.npz`. Registers + searchable passages. | install `OUT_DIR` |
| **In-weight Galvatron** | keys / index / router inside Flash tensors | inside 156G -- follow-up, not claimed |

Both Gateway and this sidecar emit the same inject: a **system** message
starting `[leCore HRR]`, payload **<= 1024 characters**. A serve layer
can run either or both, then send the attached body to generate.

## Install (write the sidecar)

```bash
python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR
python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR --smoke-shard
./assimilation/install_deepseek_v4.sh MODEL_DIR OUT_DIR --smoke-shard
```

`MODEL_DIR` needs Hugging Face `config.json` (`model_type` `deepseek_v4`
or `architectures` containing `DeepseekV4ForCausalLM`). Weight shards
are **not** all loaded. `--smoke-shard` peeks ONE file (F8_E8M0 /
F8_E4M3 / packed FP4 LUT).

`OUT_DIR` receives `lecore.json`, `lecore_hrr.npz`, a copy of
`config.json`, `BASE.txt`. The base checkpoint stays byte-identical.

| faculty | result | where |
|---|---|---|
| **registers** | real. Seed-derived orthonormal keys. | sidecar |
| **memory_index / passages** | real. HRR bundle, cosine search. | sidecar |
| **router** | **skipped** (needs a Flash forward; a stubbed gate is a fake success). | -- |

## Flash-as-HRR: inject before generate

This is the integration point. HRR runs on the **request**. Generate
(vLLM / anything speaking `/v1/chat/completions`) never sees a bare
prompt -- the attached body already contains recalled passages.

```
client  -->  FlashHRR.attach(openai_body)  -->  vLLM :8000 /v1/chat/completions
                 ^
                 system inject <=1024, header [leCore HRR]
```

```bash
python assimilation/flash_hrr.py recall OUT_DIR "capital of France"
python assimilation/flash_hrr.py attach OUT_DIR "what is the capital of France"
python -m holographic.io_and_interop.holographic_deepseek_v4 attach OUT_DIR QUERY
```

`attach` prints the OpenAI body to POST. `serve` is the lab proxy:

```bash
# terminal 1 -- vanilla vLLM (Flash weights; no GDNRuntime)
python -m vllm.entrypoints.openai.api_server --model MODEL_DIR --port 8000

# terminal 2 -- HRR before tokens
python assimilation/flash_hrr.py serve OUT_DIR --upstream http://127.0.0.1:8000 --port 8765

# client talks to :8765; FlashHRR.attach runs; vLLM generates
```

Python (same hook a Gateway can call):

```python
from holographic.io_and_interop.holographic_deepseek_v4 import FlashHRR

sess = FlashHRR.open("OUT_DIR")
body = sess.before_generate({
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "messages": [{"role": "user", "content": "What is the capital of France?"}],
    "max_tokens": 32,
})
# POST body to vLLM /v1/chat/completions -- memory is already in messages[0]
```

`in_weight` is False. Registers are in the sidecar, not orthogonalised
against a GDN state that Flash does not have on this path.

## Qwen path (unchanged)

```bash
./assimilation/install.sh MODEL_DIR OUT_DIR
```

A DeepSeek card is refused before shards open, with a pointer at
`install_deepseek_v4.py`.

## Out of scope

- 48-shard / 156G eager load
- MoE forward / GDNRuntime-as-Flash
- assimilate / Unicron compression as the SKU
- in-weight prepend, HRNN ladder, GDN router, head-row index
