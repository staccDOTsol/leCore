#!/usr/bin/env python3
"""One-shard F8/FP4 smoke. Does not load 48 shards. Does not assimilate.

    python assimilation/smoke_flash_dequant_oneshard.py [SHARD]
    FLASH_SHARD=/path/to/model-00002-of-00048.safetensors \\
        python assimilation/smoke_flash_dequant_oneshard.py
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from holographic.io_and_interop.holographic_unicron import load_safetensors
from holographic.io_and_interop.holographic_deepseek_v4 import dequant_pair
import numpy as np


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    shard = argv[0] if argv else os.environ.get("FLASH_SHARD")
    if not shard:
        default = "/workspace/models/DeepSeek-V4-Flash-0731/model-00002-of-00048.safetensors"
        shard = default if os.path.isfile(default) else None
    if not shard or not os.path.isfile(shard):
        raise SystemExit("no shard: pass a .safetensors path or set FLASH_SHARD")
    print("[smoke] load", shard, flush=True)
    w, dts = load_safetensors(shard, return_dtypes=True)
    found = []
    for name in list(w):
        if not name.endswith(".weight"):
            continue
        scale = name[:-7] + ".scale"
        if scale not in w:
            continue
        try:
            y = dequant_pair(w, name)
        except Exception as exc:
            print("skip", name, type(exc).__name__, exc)
            continue
        assert np.isfinite(y).all(), name
        print(name, "->", y.shape, "finite", True, flush=True)
        found.append(name)
        if len(found) >= 2:
            break
    if not found:
        raise SystemExit("no dequantable weight+scale pair in %s" % shard)
    print("DEQUANT_SMOKE_OK", found, "dtypes", sorted(set(dts.values())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
