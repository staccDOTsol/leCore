#!/usr/bin/env python3
"""flash_hrr_consume.py -- thinnest Flash-native use of lecore_hrr.npz

Loads install_deepseek_v4 sidecar and makes Flash *use* HRR by searching
passages + surfacing registers into a grounded prompt. No GDNRuntime, no
48-shard load, no vLLM.

Prove:
  python assimilation/flash_hrr_consume.py \
    /workspace/leCore/assimilation/work/flash0731/hrr_attach_out \
    --cue "capital of France"
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def _build_prompt(cue, hits, registers_n):
    lines = [
        "System: You are DeepSeek-V4-Flash with an attached leCore HRR memory sidecar.",
        "Use retrieved passages when relevant. Registers: %d durable slots." % registers_n,
        "",
        "Retrieved HRR passages:",
    ]
    if not hits:
        lines.append("  (none)")
    else:
        for rank, item in enumerate(hits, 1):
            i, score, text = item
            lines.append(
                "  [%d] cos=%.3f  %s"
                % (rank, score, text.replace("\n", " ")[:240])
            )
    lines.extend(["", "User: %s" % cue, "Assistant:"])
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Flash-native consumer of lecore_hrr.npz")
    ap.add_argument("sidecar_dir", help="OUT_DIR from install_deepseek_v4.py")
    ap.add_argument("--cue", default="capital of France")
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--out-prompt", default="")
    a = ap.parse_args(argv)

    from holographic.io_and_interop.holographic_deepseek_v4 import (
        load_sidecar,
        search_index,
    )

    side = os.path.abspath(a.sidecar_dir)
    npz = os.path.join(side, "lecore_hrr.npz")
    meta = os.path.join(side, "lecore.json")
    if not os.path.isfile(npz):
        raise SystemExit("missing sidecar %s — run install_deepseek_v4.py first" % npz)
    idx = load_sidecar(npz)
    lj = json.load(open(meta)) if os.path.isfile(meta) else {}
    regs = int((lj.get("registers") or {}).get("count") or 0)
    hits = search_index(idx, a.cue, k=int(a.k))
    prompt = _build_prompt(a.cue, hits, regs)

    print("[hrr] sidecar %s" % side)
    print(
        "[hrr] installed %s | skipped %s | in_weight=%s"
        % (
            lj.get("installed"),
            [s.get("step") for s in lj.get("skipped") or []],
            lj.get("in_weight"),
        )
    )
    print("[hrr] cue %r -> %d hit(s)" % (a.cue, len(hits)))
    for i, score, text in hits:
        print("      #%d cos=%.3f  %s" % (i, score, text[:100].replace("\n", " ")))
    print("[hrr] registers=%d dim=%s" % (regs, lj.get("hrr_dim")))
    print("--- grounded prompt ---")
    print(prompt)
    print("--- end ---")
    if a.out_prompt:
        open(a.out_prompt, "w", encoding="utf-8").write(prompt)
        print("[wrote] %s" % a.out_prompt)
    if not hits:
        raise SystemExit("SEARCH_FAIL: no usable hits")
    print("CONSUME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
