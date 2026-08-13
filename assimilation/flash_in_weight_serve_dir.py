#!/usr/bin/env python3
"""Build a vLLM serve directory with in-weight Flash embed overlay.

    python assimilation/flash_in_weight_serve_dir.py MODEL_DIR OUT_DIR SERVE_DIR

Symlinks MODEL_DIR (no 156G copy), then copies the patched embed shard from
OUT_DIR on top. GDNRuntime is not used.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3:
        raise SystemExit(
            "usage: python assimilation/flash_in_weight_serve_dir.py "
            "MODEL_DIR OUT_DIR SERVE_DIR")
    from holographic.io_and_interop.holographic_deepseek_v4 import (
        make_in_weight_serve_dir)
    rep = make_in_weight_serve_dir(argv[0], argv[1], argv[2])
    print("FLASH_SERVE_DIR", rep)
    if not rep.get("in_weight"):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
