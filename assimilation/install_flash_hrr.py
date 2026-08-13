#!/usr/bin/env python3
"""Flash HRR bridge CLI -- install embed-space faculties without GDNRuntime.

    python assimilation/install_flash_hrr.py MODEL_DIR OUT_DIR [--passages N]
"""
import argparse
import os
import re
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--passages", type=int, default=32)
    ap.add_argument("--doc", default=None)
    a = ap.parse_args()

    from holographic.io_and_interop.holographic_flash_hrr import (
        install_flash_hrr, is_flash_model, plan_flash_hrr)
    from holographic.io_and_interop.holographic_bpe import BPE

    if not is_flash_model(a.model_dir):
        raise SystemExit("not a Flash / deepseek_v4 model: %s" % a.model_dir)
    print("[plan]", plan_flash_hrr(a.model_dir)["available_now"])

    bpe = BPE.from_dir(a.model_dir)
    tok = lambda t: list(bpe.encode(t))[:512]

    if a.doc:
        text = open(a.doc, encoding="utf-8", errors="ignore").read()
    else:
        import glob
        parts = []
        for f in sorted(glob.glob(os.path.join(_REPO, "docs", "*.md")))[:20]:
            try:
                parts.append(open(f, encoding="utf-8", errors="ignore").read())
            except OSError:
                pass
        text = "\n\n".join(parts) or ("leCore holographic memory registers router " * 200)

    rng = np.random.default_rng(0)
    stems = ["what is ", "how does ", "why does ", "where is ", "which ",
             "how many ", "what happens when ", "explain "]
    words = re.findall(r"\b[a-z]{5,12}\b", text[:400000]) or ["memory", "state"]
    pos = [rng.choice(stems) + " ".join(rng.choice(words, 2)) + " " for _ in range(80)]
    step = max(len(text) // 200, 40)
    neg = [text[i:i + 120] for i in range(2000, min(len(text) - 200, 2000 + 80 * step), step)]
    passages = [text[i:i + 240] for i in range(4000, min(len(text) - 300, 4000 + a.passages * step), step)]
    passages = passages[: a.passages]

    def show(s):
        print("      %-14s %-5s %s" % (s["step"], "ok" if s["ok"] else "SKIP", s["detail"]))

    print("[install-flash-hrr] %s -> %s" % (a.model_dir, a.out_dir))
    _w, _c, rep = install_flash_hrr(
        a.model_dir, a.out_dir,
        passages=passages,
        router_positive=pos,
        router_negative=neg,
        tokenize=tok,
        n_passages=a.passages,
        progress=show,
    )
    print("[done] installed=%s out=%s" % (rep.get("installed"), a.out_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
