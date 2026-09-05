#!/usr/bin/env python3
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from holographic.io_and_interop.holographic_unicron import load_safetensors
from holographic.io_and_interop.holographic_deepseek_v4 import dequant_pair
import numpy as np

shard = os.environ.get(
    "FLASH_SHARD",
    "/workspace/models/DeepSeek-V4-Flash-0731/model-00002-of-00048.safetensors",
)
print("[smoke] load", shard, flush=True)
w = load_safetensors(shard)
expert = "layers.0.ffn.experts.0.w1.weight"
attn = "layers.0.attn.wq_b.weight"
for name in (expert, attn):
    if name not in w:
        # find first matching
        cands = [k for k in w if k.endswith(name.split('.',1)[-1]) or name.split('.')[-2] in k]
        print("missing", name, "cands", cands[:8])
        continue
    y = dequant_pair(w, name)
    print(name, "->", y.shape, y.dtype, "mean", float(y.mean()), "std", float(y.std()), flush=True)
print("SMOKE_OK", flush=True)
