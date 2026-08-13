#!/usr/bin/env python3
"""flash_hrr_vllm_inject.py -- real Flash-as-HRR via live vLLM + sidecar

1) search lecore_hrr.npz
2) inject retrieved passages into the user message
3) call Flash on localhost:8000 (OpenAI chat/completions)

No assimilate. No 48-shard load. Prove:
  python assimilation/flash_hrr_vllm_inject.py \
    /workspace/leCore/assimilation/work/flash0731/hrr_attach_out \
    --cue "What is the capital of France?"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def _post_chat(base, messages, max_tokens=256, model_id="/workspace/models/DeepSeek-V4-Flash-0731"):
    url = base.rstrip("/") + "/v1/chat/completions"
    body = json.dumps({
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("sidecar_dir")
    ap.add_argument("--cue", default="What is the capital of France?")
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--max-tokens", type=int, default=256)
    ap.add_argument("--dry-run", action="store_true",
                    help="build injected messages only; do not call vLLM")
    a = ap.parse_args(argv)

    from holographic.io_and_interop.holographic_deepseek_v4 import (
        load_sidecar, search_index,
    )

    side = os.path.abspath(a.sidecar_dir)
    npz = os.path.join(side, "lecore_hrr.npz")
    lj = json.load(open(os.path.join(side, "lecore.json")))
    idx = load_sidecar(npz)
    hits = search_index(idx, a.cue, k=int(a.k))
    mem_lines = []
    for rank, item in enumerate(hits, 1):
        _i, score, text = item
        mem_lines.append("[%d] (cos=%.3f) %s" % (rank, score, text.replace("\n", " ")[:300]))
    system = (
        "You are DeepSeek-V4-Flash with a leCore HRR memory sidecar attached. "
        "Registers=%s, passages=%s, in_weight=%s. Prefer retrieved memory when relevant."
        % (
            (lj.get("registers") or {}).get("count"),
            (lj.get("memory_index") or {}).get("passages"),
            lj.get("in_weight"),
        )
    )
    user = (
        "HRR retrieved memory:\n"
        + ("\n".join(mem_lines) if mem_lines else "(none)")
        + "\n\nQuestion: "
        + a.cue
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    print("[hrr->flash] sidecar", side)
    print("[hrr->flash] hits", len(hits), "base", a.base_url)
    for line in mem_lines:
        print(" ", line[:160])
    if a.dry_run:
        print(json.dumps(messages, indent=2)[:2000])
        print("DRY_RUN_OK")
        return 0
    # health
    try:
        with urllib.request.urlopen(a.base_url.rstrip("/") + "/v1/models", timeout=10) as r:
            models = json.loads(r.read().decode())
        print("[vllm] models", [m.get("id") for m in models.get("data", [])][:5])
    except Exception as e:
        raise SystemExit("vLLM not reachable at %s: %s" % (a.base_url, e))
    out = _post_chat(a.base_url, messages, max_tokens=int(a.max_tokens), model_id="/workspace/models/DeepSeek-V4-Flash-0731")
    text = out["choices"][0]["message"]["content"]
    print("--- flash reply ---")
    print(text)
    print("--- end ---")
    print("FLASH_HRR_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
