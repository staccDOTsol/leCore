"""DeepSeek-V4-Flash HRR install bridge -- faculties without Qwen GDN.

Full assimilation/install.py calls load_runtime -> GDNRuntime, which assumes
Qwen3.5 Gated-DeltaNet tensor names and eagerly loads every shard. Flash is
deepseek_v4 MoE + sparse attention (FP4 experts, FP8 attn), tied embed.weight,
and has NO recurrent state for registers / HRNN.

Smallest viable path (adapter, not a new NumPy Flash forward):
  * detect Flash from config.json / tensor names
  * load ONLY embed.weight (shard 00001) -- never the 48-shard wall
  * install searchable passages into tokenizer placeholder rows
  * fit an embed-space router (mean-pooled token embeds) into lecore.json
  * skip registers / HRNN / prepend with an explicit reason
  * write a sidecar out_dir with patched embed shard + lecore.json

This does NOT claim bit-identical hidden-state faculties; it installs the HRR
side-channels that do not require a Flash forward pass.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np


FLASH_MODEL_TYPES = {"deepseek_v4", "deepseekv4"}


def is_flash_model(model_dir: str) -> bool:
    cfg_path = os.path.join(model_dir, "config.json")
    if not os.path.isfile(cfg_path):
        return False
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return False
    mt = str(cfg.get("model_type") or "").lower()
    arches = [str(a).lower() for a in (cfg.get("architectures") or [])]
    if mt in FLASH_MODEL_TYPES:
        return True
    if any("deepseekv4" in a or "deepseek_v4" in a for a in arches):
        return True
    return False


def load_flash_cfg(model_dir: str) -> dict:
    with open(os.path.join(model_dir, "config.json"), encoding="utf-8") as f:
        cj = json.load(f)
    return {
        "hidden": int(cj.get("hidden_size") or cj.get("dim") or 0),
        "n_layers": int(cj.get("num_hidden_layers") or 0),
        "vocab": None,
        "max_position_embeddings": int(cj.get("max_position_embeddings") or 0),
        "n_routed_experts": int(cj.get("n_routed_experts") or 0),
        "expert_dtype": cj.get("expert_dtype"),
        "model_type": cj.get("model_type"),
        "family": "attention",
        "variant": "deepseek_v4",
        "has_recurrent_state": False,
        "raw": cj,
    }


def placeholder_rows(model_dir: str, limit: int = 256) -> List[int]:
    """Flash ships ~1217 place_holder ids; use the plain numbered ones."""
    path = os.path.join(model_dir, "tokenizer.json")
    with open(path, encoding="utf-8") as f:
        tj = json.load(f)
    rows = []
    for a in tj.get("added_tokens") or []:
        content = a.get("content") or ""
        low = content.lower()
        if "place" in low and "holder" in low:
            if "mm_span" in content or "fim" in low:
                continue
            if "place_holder_no_" in content or "place▁holder▁no▁" in content:
                rows.append(int(a["id"]))
    rows = sorted(set(rows))
    return rows[: int(limit)]


def _embed_shard_path(model_dir: str) -> Tuple[str, str]:
    idx = os.path.join(model_dir, "model.safetensors.index.json")
    with open(idx, encoding="utf-8") as f:
        wm = json.load(f)["weight_map"]
    for key in ("embed.weight", "model.embed.weight", "model.embed_tokens.weight",
                "embed_tokens.weight"):
        if key in wm:
            return key, os.path.join(model_dir, wm[key])
    raise KeyError("no embed.* weight in Flash weight_map")


def load_embed_only(model_dir: str) -> Tuple[str, Dict[str, np.ndarray]]:
    from holographic.io_and_interop.holographic_unicron import load_safetensors
    key, path = _embed_shard_path(model_dir)
    w = load_safetensors(path)
    if key not in w:
        raise KeyError("%s missing from %s" % (key, path))
    return key, {key: w[key]}


class FlashEmbedRuntime:
    """Minimal runtime: forward returns token embedding sequence (T, H)."""

    def __init__(self, weights: dict, cfg: dict, embed_key: str):
        self.weights = weights
        self.cfg = dict(cfg)
        self.embed_key = embed_key
        self.E = np.asarray(weights[embed_key], np.float32)

    def forward(self, token_ids, hooks=None):
        ids = [int(i) for i in token_ids]
        if not ids:
            raise ValueError("empty token_ids")
        h = self.E[ids]
        if hooks:
            for _L, fn in hooks.items():
                fn(h)
        return h


def _mean_pool(h: np.ndarray) -> np.ndarray:
    x = np.asarray(h, np.float64)
    v = x.mean(0)
    n = np.linalg.norm(v) + 1e-30
    return v / n


def build_embed_index(runtime: FlashEmbedRuntime, passages, tokenize, decay=0.99):
    from holographic.agents_and_reasoning.holographic_memsearch import bundle_address
    addrs = []
    for p in passages:
        ids = list(tokenize(p))
        h = runtime.forward(ids)
        addrs.append(bundle_address(h, decay))
    A = np.stack(addrs)
    mu = A.mean(0)
    Ac = A - mu
    return {
        "addresses": Ac / (np.linalg.norm(Ac, axis=1, keepdims=True) + 1e-30),
        "mean": mu,
        "passages": list(passages),
        "decay": float(decay),
        "layer": "embed",
        "space": "embed",
    }


def fit_embed_router(runtime: FlashEmbedRuntime, positive, negative, tokenize,
                     ridge=1e-1, holdout=0.33):
    def st(text):
        return _mean_pool(runtime.forward(list(tokenize(text))))

    A = np.stack([st(t) for t in positive])
    B = np.stack([st(t) for t in negative])
    na = max(1, int(len(A) * (1.0 - holdout)))
    nb = max(1, int(len(B) * (1.0 - holdout)))
    X = np.vstack([A[:na], B[:nb]])
    y = np.r_[np.ones(na), -np.ones(nb)]
    mu = X.mean(0)
    Xc = X - mu
    lam = float(ridge) * float(np.trace(Xc.T @ Xc)) / max(Xc.shape[1], 1)
    d = np.linalg.solve(Xc.T @ Xc + lam * np.eye(Xc.shape[1]), Xc.T @ y)

    def score(M):
        return (np.asarray(M, np.float64) - mu) @ d

    held_pos = A[na:] if na < len(A) else A[-1:]
    held_neg = B[nb:] if nb < len(B) else B[-1:]
    held = np.r_[np.sign(score(held_pos)), np.sign(score(held_neg))]
    truth = np.r_[np.ones(len(held_pos)), -np.ones(len(held_neg))]
    acc = float((held == truth).mean()) if len(truth) else 0.0
    return {
        "direction": d.astype(np.float64),
        "mean": mu.astype(np.float64),
        "heldout_acc": acc,
        "space": "embed",
        "n_pos": len(positive),
        "n_neg": len(negative),
    }


def install_index_into_embed(weights: dict, embed_key: str, index: dict, rows: List[int]):
    out = dict(weights)
    A = np.asarray(weights[embed_key], np.float64).copy()
    peak = float(np.median(np.abs(A).max(axis=1)))
    used = []
    for row, addr in zip(rows, index["addresses"]):
        A[int(row)] = np.asarray(addr, np.float64) * peak
        used.append(int(row))
    out[embed_key] = A.astype(np.asarray(weights[embed_key]).dtype, copy=False)
    return out, {"rows": used, "head": embed_key, "peak": peak}


def _write_patched_shard(src_shard: str, embed_key: str, new_embed: np.ndarray, dest: str):
    from holographic.io_and_interop.holographic_unicron import load_safetensors, save_safetensors
    with open(src_shard, "rb") as f:
        (hdr_len,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(hdr_len).decode("utf-8"))
    tensors = load_safetensors(src_shard)
    tensors[embed_key] = np.asarray(new_embed)
    dtypes = {k: header[k]["dtype"] for k in tensors if k in header}
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)
    save_safetensors(dest, tensors, dtypes=dtypes)


def install_flash_hrr(
    model_dir: str,
    out_dir: str,
    passages=(),
    router_positive=(),
    router_negative=(),
    tokenize: Optional[Callable] = None,
    n_passages: int = 32,
    progress=None,
):
    """Install HRR side-channels into a Flash checkpoint copy (embed shard only)."""
    def note(step, ok, detail):
        if progress:
            progress({"step": step, "ok": ok, "detail": detail})
        else:
            print("      %-14s %-5s %s" % (step, "ok" if ok else "SKIP", detail))

    if not is_flash_model(model_dir):
        raise ValueError("not a DeepSeek-V4 / Flash model: %s" % model_dir)

    cfg = load_flash_cfg(model_dir)
    embed_key, w = load_embed_only(model_dir)
    cfg["vocab"] = int(np.asarray(w[embed_key]).shape[0])
    cfg["hidden"] = int(np.asarray(w[embed_key]).shape[1]) or cfg["hidden"]
    note("architecture", True,
         "deepseek_v4 attention/MoE -- no recurrent state; GDN install skipped")

    if tokenize is None:
        from holographic.io_and_interop.holographic_bpe import BPE
        bpe = BPE.from_dir(model_dir)
        tokenize = lambda t: list(bpe.encode(t))[:512]

    rt = FlashEmbedRuntime(w, cfg, embed_key)
    rep = {
        "architecture": {
            "family": "attention",
            "variant": "deepseek_v4",
            "has_recurrent_state": False,
        },
        "installed": ["architecture"],
        "steps": [],
        "in_weight": 0,
    }

    note("registers", False, "Flash has no recurrent state to reserve directions in")
    note("hrnn_ladder", False, "needs GDN decay channels; not present on deepseek_v4")
    note("prepend", False, "GDN blank-layer prepend assumes Qwen layer_types")

    rows = placeholder_rows(model_dir, limit=max(8, int(n_passages)))
    passages = list(passages)[: len(rows)]
    if passages and rows:
        idx = build_embed_index(rt, passages, tokenize)
        w2, irep = install_index_into_embed(w, embed_key, idx, rows[: len(passages)])
        w = w2
        rep["memory_index"] = {
            "rows": irep["rows"],
            "n": len(irep["rows"]),
            "space": "embed",
            "passages": passages,
        }
        rep["installed"].append("memory_index")
        note("memory_index", True,
             "%d passages in placeholder rows %s.."
             % (len(irep["rows"]), irep["rows"][:3]))
        rep["in_weight"] = 1
        rep["memory_index"]["in_weight"] = 1
    else:
        note("memory_index", False,
             "need passages and placeholder rows (have %d rows, %d passages)"
             % (len(rows), len(passages)))

    if router_positive and router_negative:
        r = fit_embed_router(rt, list(router_positive), list(router_negative), tokenize)
        rep["router"] = {
            "heldout_acc": r["heldout_acc"],
            "space": "embed",
            "dim": int(r["direction"].shape[0]),
        }
        rep["router_vectors"] = {
            "direction": r["direction"].tolist(),
            "mean": r["mean"].tolist(),
        }
        rep["installed"].append("router")
        note("router", True,
             "embed-space held-out acc %.0f%%" % (100 * r["heldout_acc"]))
    else:
        note("router", False, "no positive/negative examples provided")

    os.makedirs(out_dir, exist_ok=True)
    key, src_shard = _embed_shard_path(model_dir)
    shard_name = os.path.basename(src_shard)
    dest_shard = os.path.join(out_dir, shard_name)
    _write_patched_shard(src_shard, key, w[key], dest_shard)
    note("export", True, "patched %s" % shard_name)

    for fn in os.listdir(model_dir):
        src = os.path.join(model_dir, fn)
        if not os.path.isfile(src):
            continue
        if fn.endswith(".safetensors"):
            continue
        try:
            shutil.copy(src, os.path.join(out_dir, fn))
        except OSError:
            pass

    summary = {k: v for k, v in rep.items() if k != "router_vectors"}
    with open(os.path.join(out_dir, "lecore.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
    if "router_vectors" in rep:
        np.savez(
            os.path.join(out_dir, "lecore_router_embed.npz"),
            direction=np.asarray(rep["router_vectors"]["direction"], np.float64),
            mean=np.asarray(rep["router_vectors"]["mean"], np.float64),
        )
    with open(os.path.join(out_dir, "FLASH_HRR_README.txt"), "w", encoding="utf-8") as f:
        f.write(
            "Flash HRR bridge artifact.\n"
            "- Patched embed shard only; other shards remain in the source model dir.\n"
            "- memory_index is IN-WEIGHT (placeholder embed rows, in_weight=1).\n"
            "- router is embed-space (not layer-hidden); see lecore_router_embed.npz.\n"
            "- HRNN/prepend skipped (no GDN recurrent state).\n"
            "- Full GDN install.py path is BLOCKED for deepseek_v4.\n"
        )
    rep["out_dir"] = out_dir
    rep["embed_shard"] = dest_shard
    return w, cfg, rep


def plan_flash_hrr(model_dir: str) -> dict:
    cfg = load_flash_cfg(model_dir) if is_flash_model(model_dir) else {}
    rows = placeholder_rows(model_dir, limit=8) if cfg else []
    return {
        "is_flash": bool(cfg),
        "cfg": {k: v for k, v in cfg.items() if k != "raw"} if cfg else {},
        "placeholder_sample": rows,
        "full_gdn_install": False,
        "blocked": [
            "load_runtime/GDNRuntime (Qwen tensor layout)",
            "registers / HRNN ladder (no recurrent state)",
            "prepend blank GDN layers",
            "layer-hidden router / memsearch (needs Flash forward)",
        ],
        "available_now": [
            "F8_E8M0/F8_E4M3 decode in load_safetensors",
            "flash_dequant FP4/FP8 helpers + smoke_flash_dequant.py",
            "install_flash_hrr: embed-space memory_index + router into placeholders",
        ],
    }
