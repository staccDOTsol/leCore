"""install_deepseek_v4.py -- HRR-attach leCore onto DeepSeek-V4 Flash.

    python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR
    python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR --doc FILE --registers 16

THIS DOES NOT CALL GDNRuntime. The Qwen Galvatron path
(`assimilation/install.py`) assumes Qwen3-Next Gated DeltaNet tensors.
DeepSeek-V4 Flash is a different architecture (MoE, Flash quant, no GDN
recurrent state). Pointing the Qwen installer at it is refused; this is
the other door.

WHAT LANDS, in a SIDECAR next to the untouched base:
    registers       seed-derived orthonormal keys (real attach)
    memory_index    searchable HRR passages (real attach)
    router          skipped with a reason -- needs a Flash forward

WHAT DOES NOT LAND (follow-ups, not silent successes):
    in-weight Galvatron (prepend / GDN gate / head-row index)
    MoE runtime, 48-shard eager load, assimilate compression

Optional one-shard dtype smoke (does not load the whole checkpoint):

    python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR --smoke-shard

The base checkpoint is not copied and not rewritten. OUT_DIR gets
lecore.json, lecore_hrr.npz, a copy of config.json, and BASE.txt
pointing at MODEL_DIR.
"""

import argparse
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


_BUILTIN_PASSAGES = (
    "leCore represents memory as holographic reduced representations",
    "registers are reserved orthonormal key directions that survive interference",
    "a memory index stores searchable passages as bundled hypervectors",
    "DeepSeek-V4 Flash is not a Qwen3-Next Gated DeltaNet checkpoint",
    "the capital of France is Paris and water freezes at zero celsius",
    "bind glue two vectors, bundle overlays many, cleanup snaps to nearest",
)


def _passages_from_doc(path, n):
    text = open(path, encoding="utf-8", errors="ignore").read()
    chunks = []
    step = max(80, len(text) // max(int(n), 1))
    for i in range(0, len(text), step):
        piece = " ".join(text[i:i + 240].split())
        if len(piece) >= 40:
            chunks.append(piece)
        if len(chunks) >= int(n):
            break
    return chunks


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="HRR-attach leCore onto DeepSeek-V4 Flash (no GDNRuntime)")
    ap.add_argument("model_dir", help="Hugging Face DeepSeek-V4 directory "
                                      "(needs config.json; shards are not loaded)")
    ap.add_argument("out_dir", help="where to write lecore.json + sidecar")
    ap.add_argument("--doc", help="optional text file split into passages")
    ap.add_argument("--registers", type=int, default=16,
                    help="permanent memory slots in the sidecar (default 16)")
    ap.add_argument("--passages", type=int, default=0,
                    help="how many passages to index (0 = all provided)")
    ap.add_argument("--hrr-dim", type=int, default=256)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke-shard", nargs="?", const="auto", default=None,
                    help="peek ONE safetensors shard (F8_E8M0 / F8_E4M3 / packed "
                         "FP4). Does not load 48 shards. Omit path to use the "
                         "smallest .safetensors in MODEL_DIR")
    a = ap.parse_args(argv)

    from holographic.io_and_interop.holographic_deepseek_v4 import (
        detect_from_dir, first_shard, install, is_deepseek_v4, load_config,
        search_index, load_sidecar, smoke_one_shard)

    model_dir = os.path.abspath(a.model_dir)
    out_dir = os.path.abspath(a.out_dir)
    cfg = load_config(model_dir)
    if not is_deepseek_v4(cfg):
        raise SystemExit(
            "refusing: %s is not DeepSeek-V4 (model_type=%r, "
            "architectures=%r). Qwen stays on assimilation/install.py."
            % (model_dir, cfg.get("model_type"), cfg.get("architectures"))
        )
    # detect_from_dir is the same check the Qwen installer uses to refuse
    assert detect_from_dir(model_dir) is not None

    if a.doc:
        n = int(a.passages) or 24
        passages = _passages_from_doc(a.doc, n)
        print("[corpus] %s -> %d passages" % (a.doc, len(passages)))
    else:
        passages = list(_BUILTIN_PASSAGES)
        if int(a.passages):
            passages = passages[:int(a.passages)]
        print("[corpus] built-in %d passages (pass --doc FILE for your own)"
              % len(passages))

    print("[install] DeepSeek-V4 HRR-attach  %s -> %s" % (model_dir, out_dir))
    print("          GDNRuntime is not called; 48 shards are not eager-loaded")
    if a.smoke_shard is not None:
        shard = (first_shard(model_dir) if a.smoke_shard == "auto"
                 else os.path.abspath(a.smoke_shard))
        if not shard or not os.path.isfile(shard):
            raise SystemExit("no .safetensors shard to smoke in %s" % model_dir)
        print("[smoke] one shard %s (%.1f MB)"
              % (shard, os.path.getsize(shard) / 1e6))
        srep = smoke_one_shard(shard)
        print("        tensors %d  dtypes %s"
              % (srep["n_tensors"], srep["dtypes"]))
        if srep.get("dequant"):
            d = srep["dequant"]
            print("        dequant %s %s -> %s finite=%s absmax=%.4g"
                  % (d["kind"], d["weight"], d["out_shape"], d["finite"],
                     d["absmax"]))
        elif srep.get("note"):
            print("        %s" % srep["note"])
    _w, _c, rep = install(None, cfg, passages=passages,
                          n_registers=int(a.registers), seed=int(a.seed),
                          out_dir=out_dir, hrr_dim=int(a.hrr_dim),
                          model_dir=model_dir)
    for s in rep["steps"]:
        print("      %-14s %-5s %s" % (s["step"],
                                       "ok" if s["ok"] else "SKIP",
                                       s["detail"][:120]))
    print("[wrote] %s" % out_dir)
    print("        installed: %s" % (", ".join(rep["installed"]) or "(none)"))
    skipped = [x["step"] for x in rep["skipped"]]
    if skipped:
        print("        skipped:    %s" % ", ".join(skipped))
    print("        sidecar:    %s" % rep.get("sidecar"))

    if "memory_index" in rep["installed"] and rep.get("sidecar"):
        idx = load_sidecar(rep["sidecar"])
        cue = "capital of France"
        hits = search_index(idx, cue, k=1)
        if hits:
            print("[search] cue %r -> %r (cosine %.3f)"
                  % (cue, hits[0][2][:72], hits[0][1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
