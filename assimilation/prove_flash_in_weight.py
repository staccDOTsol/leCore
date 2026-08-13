#!/usr/bin/env python3
"""Prove in-weight Flash HRR on a tiny fake (CI) or a real MODEL_DIR (Vast).

    python assimilation/prove_flash_in_weight.py
    python assimilation/prove_flash_in_weight.py MODEL_DIR OUT_DIR

Success prints FLASH_IN_WEIGHT_OK and lecore.json in_weight=1.
Does not call GDNRuntime. Does not load 48 shards.
"""
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    from holographic.io_and_interop.holographic_deepseek_v4 import (
        fake_deepseek_v4_config, fake_deepseek_v4_weights, install)

    if len(argv) >= 2:
        model_dir, out_dir = os.path.abspath(argv[0]), os.path.abspath(argv[1])
        from holographic.io_and_interop.holographic_deepseek_v4 import (
            load_config)
        cfg = load_config(model_dir)
        w = None
    else:
        model_dir = None
        out_dir = tempfile.mkdtemp(prefix="flash_in_weight_")
        cfg = fake_deepseek_v4_config(hidden=32, vocab=48)
        w = fake_deepseek_v4_weights(hidden=32, vocab=48)

    passages = [
        "the capital of France is Paris",
        "water freezes at zero degrees celsius",
        "leCore holographic reduced representations",
    ]
    _w, _c, rep = install(
        w, cfg, passages=passages, n_registers=8, seed=0,
        out_dir=out_dir, hrr_dim=64, model_dir=model_dir)
    card_path = os.path.join(out_dir, "lecore.json")
    card = json.loads(open(card_path, encoding="utf-8").read())
    iw = int(card.get("in_weight") or 0)
    mi = card.get("memory_index") or {}
    print("[prove] out=%s in_weight=%s memory_rows=%s registers_in_weight=%s"
          % (out_dir, iw, mi.get("rows"), (card.get("registers") or {}).get("in_weight")))
    if iw != 1:
        raise SystemExit("lecore.json in_weight=%r -- want 1" % card.get("in_weight"))
    if int(mi.get("in_weight") or 0) != 1:
        raise SystemExit("memory_index.in_weight=%r -- want 1" % mi.get("in_weight"))
    embed = os.path.join(out_dir, "lecore_in_weight.safetensors")
    if not os.path.isfile(embed):
        raise SystemExit("missing %s" % embed)
    print("FLASH_IN_WEIGHT_OK", out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
