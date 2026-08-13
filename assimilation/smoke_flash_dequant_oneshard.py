#!/usr/bin/env python3
"""One-shard F8/FP4 smoke (side-work; does not touch prove OUT)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from holographic.io_and_interop.holographic_unicron import load_safetensors
from holographic.io_and_interop.flash_dequant import dequant_pair
import numpy as np

shard = "/workspace/models/DeepSeek-V4-Flash-0731/model-00002-of-00048.safetensors"
w, dts = load_safetensors(shard, return_dtypes=True)
a = dequant_pair(w, "layers.0.attn.wkv.weight")
e = dequant_pair(w, "layers.0.ffn.experts.0.w1.weight")
assert e.shape == (2048, 4096)
assert np.isfinite(a).all() and np.isfinite(e).all()
print("DEQUANT_SMOKE_OK", a.shape, e.shape, sorted(set(dts.values())))
