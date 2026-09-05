"""DEEPSEEK-V4 FLASH -- HRR-attach + consume. Does NOT go through GDNRuntime.

Qwen3-Next / Qwen3.5 is a Gated-DeltaNet hybrid. DeepSeek-V4 Flash is not.
`GDNRuntime` + `assimilation/install.py` assume Qwen tensor names, Qwen
layer_types, and a dense MLP. Pointing that path at Flash either raises
inside a reshape or, worse, tries to mmap ~48 shards into the wrong
forward. This module is the other door.

WHAT THIS SLICE DOES
    detect     config.json model_type == deepseek_v4, or architectures
               containing DeepseekV4ForCausalLM
    refuse     any Qwen GDN load of that config, with a pointer at the CLI
    in-weight  write faculties into unused / placeholder embed rows
                 (Flash-shaped; F8/FP4 decode on the embed shard).
                 lecore.json in_weight=1 when at least one faculty lands.
    sidecar    registers + searchable passages also in lecore_hrr.npz
                 so request-time inject still works without a forward
    consume    load OUT_DIR, recall, Gateway-shaped system inject (<=1024)
               into a real OpenAI chat/completions body BEFORE generate
    load       one-shard peek: F8_E8M0 / F8_E4M3 / I8 packed FP4 (official LUT)
    skip       GDNRuntime, HRNN ladder, GDN prepend, layer-hidden router
               (Flash has no GDN recurrent state -- next bridge named)
    not this   MoE runtime, 48-shard eager install, assimilate compression.
               GDNRuntime is not a Flash forward.

FLASH-AS-HRR:
    in-weight embed rows  ->  vLLM loads patched embed shard
    sidecar inject        ->  FlashHRR.attach() before /v1/chat/completions
    They compose. Sidecar-only is not the Vast SKU.

CLI:
    python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR [--smoke-shard]
    python assimilation/flash_hrr.py attach OUT_DIR "what is the capital of France"
    python -m holographic.io_and_interop.holographic_deepseek_v4 attach OUT_DIR QUERY
    (no args: _selftest, required by the module walker)
"""

from __future__ import annotations

import json
import os
import re

import numpy as np


FORMAT = "leCore/deepseek_v4_hrr/1"
HRR_DIM = 256
# Gateway attach contract: the HRR payload lives in a system message and is
# capped at 1024 characters. External Gateway (:8765 / dogfood :7090) and this
# Flash sidecar emit the same shape so they compose. The cap is the inject
# block, not the caller's existing system prompt.
GATEWAY_INJECT_MAX = 1024
GATEWAY_INJECT_HEADER = "[leCore HRR]"

# Official DeepSeek-V4 Flash FP4 E2M1 codebook, lifted from
# inference/convert.py::FP4_TABLE (deepseek-ai/DeepSeek-V4-Flash).
# Low nibble = even column, high nibble = odd column.
FP4_TABLE = np.array(
    [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0,
     0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0],
    dtype=np.float32,
)
FP4_BLOCK = 32    # one E8M0 scale per 32 input columns (expert / MXFP4)
FP8_BLOCK = 128   # one E8M0 scale per 128x128 tile (non-expert E4M3)


_MODEL_TYPES = frozenset({
    "deepseek_v4",
    "deepseek-v4",
    "deepseek_v4_flash",
    "deepseek-v4-flash",
})
_ARCHITECTURES = frozenset({
    "DeepseekV4ForCausalLM",
    "DeepSeekV4ForCausalLM",
    "DeepseekV4FlashForCausalLM",
    "DeepSeekV4FlashForCausalLM",
})


class QwenGDNRefused(ValueError):
    """DeepSeek-V4 cannot be executed by the Qwen Gated-DeltaNet runtime."""


def is_deepseek_v4(cfg):
    """True iff this Hugging Face config is DeepSeek-V4 (Flash included).

    Matches the two witnesses the checkpoint actually ships:
        model_type == "deepseek_v4"   (hyphens folded)
        architectures contains DeepseekV4ForCausalLM
    Nested `text_config` is checked too -- multimodal cards put the language
    stack there, the same way Qwen3.5 does.
    """
    if not isinstance(cfg, dict):
        return False
    blocks = [cfg]
    nested = cfg.get("text_config")
    if isinstance(nested, dict):
        blocks.append(nested)
    for block in blocks:
        mt = str(block.get("model_type") or "").strip().lower().replace("-", "_")
        if mt in {t.replace("-", "_") for t in _MODEL_TYPES} \
                or mt.startswith("deepseek_v4"):
            return True
        for name in block.get("architectures") or ():
            s = str(name)
            if s in _ARCHITECTURES or "DeepseekV4" in s or "DeepSeekV4" in s:
                return True
    return False


def load_config(model_dir):
    """Read config.json only. Does not open weight shards."""
    path = os.path.join(model_dir, "config.json")
    if not os.path.isfile(path):
        raise FileNotFoundError(
            "no config.json in %r -- DeepSeek-V4 detection needs the Hugging "
            "Face card, not the shards" % model_dir)
    with open(path) as f:
        return json.load(f)


def detect_from_dir(model_dir):
    """Return the config if the directory is DeepSeek-V4, else None.

    Missing config.json is not DeepSeek-V4 -- the Qwen path still has its
    own error for that. We only claim a detection when the card is present
    and names this family.
    """
    path = os.path.join(model_dir, "config.json")
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        cfg = json.load(f)
    return cfg if is_deepseek_v4(cfg) else None


def refuse_message(model_dir=None, cfg=None):
    """The error the Qwen GDN path must raise instead of a reshape traceback."""
    where = repr(model_dir) if model_dir else "this checkpoint"
    mt = None
    arch = None
    if isinstance(cfg, dict):
        mt = cfg.get("model_type") or (cfg.get("text_config") or {}).get(
            "model_type")
        arch = cfg.get("architectures") or (cfg.get("text_config") or {}).get(
            "architectures")
    return (
        "DeepSeek-V4 is not a Qwen3-Next Gated DeltaNet checkpoint. "
        "GDNRuntime will not load %s (model_type=%r, architectures=%r) "
        "and will not mmap Flash shards into a Qwen forward.\n"
        "\n"
        "Use the Flash-shaped HRR install, which does not call GDNRuntime:\n"
        "\n"
        "    python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR\n"
        "    ./assimilation/install_deepseek_v4.sh MODEL_DIR OUT_DIR\n"
        "\n"
        "That writes faculties into unused/placeholder embed rows "
        "(in_weight=1 for memory_index) plus a sidecar for request-time "
        "inject. It does not assimilate and does not claim a Qwen GDN "
        "forward. GDN prepend / HRNN / layer-hidden router stay skipped -- "
        "Flash has no GDN recurrent state."
        % (where, mt, arch)
    )


def refuse_qwen_gdn(model_dir=None, cfg=None):
    """Raise QwenGDNRefused with the CLI pointer. Call this BEFORE loading shards."""
    raise QwenGDNRefused(refuse_message(model_dir, cfg))


def _tokens(text):
    found = re.findall(r"[a-z0-9]+", str(text).lower())
    return found or ["_empty"]


def _encode(vocab, text):
    from holographic.agents_and_reasoning.holographic_ai import bundle
    return bundle([vocab.get(t) for t in _tokens(text)])


def attach_registers(dim, n_slots, seed=0):
    """REAL attach: orthonormal keys regenerable from (dim, n_slots, seed).

    Same object Qwen install stores -- a QR of a seeded random matrix.
    in_weight enforcement (projecting the model's own keys off these
    directions) is skipped because Flash has no GDN state to orthogonalise.
    """
    from holographic.caching_and_storage.holographic_keyreserve import reserve
    n = int(n_slots)
    d = int(dim)
    if n <= 0:
        return None, {"ok": False,
                      "reason": "n_registers=%d -- nothing to reserve" % n}
    if n > d:
        return None, {"ok": False,
                      "reason": "n_registers=%d exceeds HRR dim %d" % (n, d)}
    keys = reserve(d, n, seed=int(seed))
    gram = keys @ keys.T
    off = float(np.max(np.abs(gram - np.eye(n))))
    return keys, {
        "ok": True,
        "count": n,
        "dim": d,
        "seed": int(seed),
        "regenerable_from_seed": True,
        "orthonormal_offdiag": off,
        "where": "sidecar",
        "in_weight": False,
        "in_weight_skip": (
            "Flash is not Gated DeltaNet; there is no recurrent state in "
            "these weights to orthogonalise against. The reservation is "
            "real and regenerates from the seed. In-weight enforcement "
            "waits on a DeepSeek-V4 runtime."
        ),
    }


def attach_memory_index(passages, dim, seed=0):
    """REAL attach: HRR-bundled passage vectors, searchable by cosine.

    Not the Qwen in-weight index (addresses from GDN hidden states written
    into unused vocab rows). That needs GDNRuntime.forward and mutates the
    checkpoint. This index lives in the sidecar and answers cues without
    a Flash forward.
    """
    from holographic.agents_and_reasoning.holographic_ai import Vocabulary

    texts = [str(p).strip() for p in passages if str(p).strip()]
    if not texts:
        return None, None, {
            "ok": False,
            "reason": "no passages given -- nothing to index",
        }
    vocab = Vocabulary(int(dim), seed=int(seed), derived=True)
    vectors = np.stack([_encode(vocab, t) for t in texts])
    return vectors, texts, {
        "ok": True,
        "passages": len(texts),
        "dim": int(dim),
        "seed": int(seed),
        "searchable": True,
        "where": "sidecar",
        "in_weight": False,
        "in_weight_skip": (
            "Sidecar index is HRR-dim. In-weight landing is a separate step: "
            "install_deepseek_v4() writes these passages into Flash placeholder / unused "
            "embed rows after F8/BF16 decode. GDN hidden-state addresses are "
            "not used -- Flash is not Gated DeltaNet."
        ),
    }


_EMBED_KEYS = (
    "embed.weight", "model.embed.weight",
    "model.embed_tokens.weight", "embed_tokens.weight",
)


def _find_embed_key(weights):
    if not weights:
        return None
    for k in _EMBED_KEYS:
        if k in weights:
            return k
    for k in weights:
        ks = str(k)
        if ks.endswith("embed_tokens.weight") or ks.endswith("embed.weight"):
            return k
    return None


def _lift_to_hidden(vec, hidden, seed=0):
    """Seeded isometry: HRR-dim vector -> Flash hidden. Not a GDN projection."""
    v = np.asarray(vec, np.float64).reshape(-1)
    h = int(hidden)
    if v.size == h:
        n = np.linalg.norm(v) or 1.0
        return v / n
    rng = np.random.default_rng(int(seed) + 17)
    out = np.zeros(h, np.float64)
    ncopy = min(v.size, h)
    out[:ncopy] = v[:ncopy]
    if v.size < h:
        extra = rng.standard_normal(h - v.size)
        extra -= extra.mean()
        en = np.linalg.norm(extra) or 1.0
        out[v.size:] = extra / en * (np.linalg.norm(v[:ncopy]) / np.sqrt(h) + 1e-12)
    n = np.linalg.norm(out) or 1.0
    return out / n


def _passage_embed_address(E, text, tokenize=None):
    ids = []
    if tokenize is not None:
        try:
            ids = [int(i) for i in list(tokenize(text))[:64]]
        except Exception:
            ids = []
    if not ids:
        v = int(E.shape[0])
        ids = [b % max(v - 1, 1) for b in str(text).encode("utf-8")[:32]] or [1]
    ids = [min(max(int(i), 0), int(E.shape[0]) - 1) for i in ids]
    addr = np.asarray(E[ids], np.float64).mean(0)
    n = np.linalg.norm(addr)
    if n < 1e-8:
        return None
    return addr / n


def placeholder_or_tail_rows(model_dir, vocab, n_needed):
    """Flash place_holder ids if the tokenizer ships them, else tail vocab rows.

    Writing into a defined special token would corrupt EOS / vision markers.
    Placeholder rows and the unused tail are the Flash-legal in-weight bank.
    """
    rows = []
    if model_dir:
        try:
            from holographic.io_and_interop.holographic_flash_hrr import (
                placeholder_rows)
            rows = list(placeholder_rows(model_dir, limit=max(int(n_needed), 8)))
        except Exception:
            rows = []
    seen = set(rows)
    if len(rows) < int(n_needed):
        start = max(0, int(vocab) - int(n_needed))
        for i in range(start, int(vocab)):
            if i not in seen:
                rows.append(i)
                seen.add(i)
            if len(rows) >= int(n_needed):
                break
    return rows[: int(n_needed)]


def load_embed_for_install(weights, model_dir):
    """One embed tensor, decoded (F8/BF16 -> float32). Never 48 shards."""
    key = _find_embed_key(weights)
    if key is not None:
        return key, np.asarray(weights[key]).copy(), None
    if not model_dir:
        return None, None, None
    try:
        from holographic.io_and_interop.holographic_flash_hrr import (
            load_embed_only, _embed_shard_path)
        key, w = load_embed_only(model_dir)
        _k, src = _embed_shard_path(model_dir)
        return key, np.asarray(w[key]).copy(), src
    except Exception:
        return None, None, None


def install_in_weight_embed(weights, passages, keys=None, sidecar_vectors=None,
                            model_dir=None, seed=0, tokenize=None):
    """Write memory_index (and registers if rows remain) into embed rows.

    Flash-shaped: unused / placeholder vocab rows of embed.weight.
    GDNRuntime is not called. Returns (new_weights_or_None, report).
    """
    key, E, src_shard = load_embed_for_install(weights, model_dir)
    if key is None or E is None or E.ndim != 2:
        return weights, {
            "ok": False,
            "in_weight": 0,
            "reason": (
                "no embed.weight / embed_tokens.weight to write into -- "
                "pass a weights dict or a MODEL_DIR with one embed shard"
            ),
        }
    vocab, hidden = int(E.shape[0]), int(E.shape[1])
    texts = [str(p).strip() for p in (passages or ()) if str(p).strip()]
    n_keys = 0 if keys is None else int(np.asarray(keys).shape[0])
    n_needed = len(texts) + n_keys
    if n_needed <= 0:
        return weights, {
            "ok": False, "in_weight": 0,
            "reason": "no passages or registers to write into embed rows",
        }
    rows = placeholder_or_tail_rows(model_dir, vocab, n_needed)
    if len(rows) < 1:
        return weights, {
            "ok": False, "in_weight": 0,
            "reason": "no placeholder or tail vocab rows available",
        }
    peak = float(np.median(np.abs(np.asarray(E, np.float64)).max(axis=1)))
    if not np.isfinite(peak) or peak < 1e-8:
        peak = 1.0
    E2 = np.asarray(E, np.float64).copy()
    mem_rows = []
    n_pass = min(len(texts), len(rows))
    vecs = None if sidecar_vectors is None else np.asarray(sidecar_vectors)
    for i in range(n_pass):
        addr = _passage_embed_address(E, texts[i], tokenize=tokenize)
        if addr is None and vecs is not None and i < len(vecs):
            addr = _lift_to_hidden(vecs[i], hidden, seed=int(seed) + i)
        if addr is None:
            addr = _lift_to_hidden(
                np.random.default_rng(int(seed) + 200 + i).standard_normal(hidden),
                hidden, seed=int(seed) + 200 + i)
        E2[int(rows[i])] = np.asarray(addr, np.float64) * peak
        mem_rows.append(int(rows[i]))
    reg_rows = []
    if n_keys and len(rows) > n_pass:
        K = np.asarray(keys, np.float64)
        for j in range(min(n_keys, len(rows) - n_pass)):
            addr = _lift_to_hidden(K[j], hidden, seed=int(seed) + 300 + j)
            E2[int(rows[n_pass + j])] = addr * peak
            reg_rows.append(int(rows[n_pass + j]))
    new_w = dict(weights) if weights else {key: E2.astype(np.float32)}
    orig_dt = None if weights is None else getattr(weights.get(key), "dtype", None)
    new_w[key] = E2.astype(orig_dt or np.float32, copy=False)
    return new_w, {
        "ok": True,
        "in_weight": 1,
        "embed_key": key,
        "hidden": hidden,
        "vocab": vocab,
        "peak": peak,
        "src_shard": src_shard,
        "memory_index": {
            "ok": True,
            "in_weight": 1,
            "where": "embed.placeholder_or_tail_rows",
            "rows": mem_rows,
            "n": len(mem_rows),
            "passages": n_pass,
        },
        "registers": {
            "ok": bool(reg_rows),
            "in_weight": 1 if reg_rows else 0,
            "where": "embed.placeholder_or_tail_rows" if reg_rows else None,
            "rows": reg_rows,
            "n": len(reg_rows),
            "in_weight_skip": None if reg_rows else (
                "GDN-state orthogonalisation is impossible on Flash (no "
                "recurrent state). Next bridge: more placeholder rows, or a "
                "Flash-native key bank in unused embed rows."
            ),
        },
    }


def attach_router():
    """HONEST SKIP. A router is a ridge discriminant on early hidden states.

    Fitting it requires a working forward. GDNRuntime is Qwen3-Next only.
    Returning ok=True here would be a fake success.
    """
    return {
        "ok": False,
        "reason": (
            "Router needs early-layer hidden states from a working forward. "
            "GDNRuntime is the Qwen3-Next Gated DeltaNet path and is not "
            "called here. DeepSeek-V4 Flash has no GDN forward on this "
            "bridge. Follow-up: a Flash-native router, not a stubbed gate."
        ),
    }


def search_index(index, cue, k=3):
    """Rank stored passages against a cue in the sidecar HRR space."""
    from holographic.agents_and_reasoning.holographic_ai import Vocabulary

    vectors = np.asarray(index["vectors"], float)
    texts = list(index["passages"])
    if not texts:
        return []
    vocab = Vocabulary(int(vectors.shape[1]),
                       seed=int(index.get("seed", 0)), derived=True)
    q = _encode(vocab, cue)
    qn = np.linalg.norm(q) or 1.0
    vn = np.linalg.norm(vectors, axis=1)
    vn = np.where(vn == 0.0, 1.0, vn)
    scores = (vectors @ q) / (vn * qn)
    order = np.argsort(scores)[::-1][:min(int(k), len(texts))]
    return [(int(i), float(scores[i]), texts[int(i)]) for i in order]


def _note(rep, name, ok, detail):
    step = {"step": name, "ok": bool(ok), "detail": detail}
    rep["steps"].append(step)
    if ok:
        rep["installed"].append(name)
    else:
        rep["skipped"].append({"step": name, "reason": detail})
    return step


def install_deepseek_v4(weights, cfg, passages=(), n_registers=16, seed=0, out_dir=None,
            hrr_dim=HRR_DIM, model_dir=None, tokenize=None):
    """Attach HRR faculties to DeepSeek-V4 Flash. Never calls GDNRuntime.

    Sidecar (lecore_hrr.npz) still lands for request-time inject.
    In-weight: unused/placeholder embed rows are rewritten (in_weight=1)
    when an embed tensor is available -- fake dict in tests, or ONE embed
    shard from MODEL_DIR (F8/BF16 decode). 48 shards are not eager-loaded.
    """
    if not is_deepseek_v4(cfg):
        raise ValueError(
            "install_deepseek_v4() on holographic_deepseek_v4 requires a DeepSeek-V4 "
            "config (model_type=deepseek_v4 or architectures containing "
            "DeepseekV4ForCausalLM); got model_type=%r architectures=%r. "
            "Qwen stays on assimilation/install.py / GDNRuntime."
            % (cfg.get("model_type") if isinstance(cfg, dict) else None,
               cfg.get("architectures") if isinstance(cfg, dict) else None)
        )

    dim = int(hrr_dim)
    hidden = None
    if isinstance(cfg, dict):
        block = cfg.get("text_config") if isinstance(cfg.get("text_config"),
                                                     dict) else cfg
        hidden = block.get("hidden_size") or block.get("hidden")
    if weights:
        ek = _find_embed_key(weights)
        if ek is not None:
            hidden = int(np.asarray(weights[ek]).shape[-1])
    model_hidden = int(hidden) if hidden else None

    rep = {
        "format": FORMAT,
        "family": "deepseek_v4",
        "variant": "flash",
        "model_type": cfg.get("model_type"),
        "architectures": list(cfg.get("architectures") or ()),
        "model_hidden": model_hidden,
        "hrr_dim": dim,
        "base": os.path.abspath(model_dir) if model_dir else None,
        "steps": [],
        "installed": [],
        "skipped": [],
        "in_weight": 0,
        "runtime": "flash-embed-rows -- GDNRuntime is Qwen-only and is not called",
        "assimilate": False,
    }

    keys, rrep = attach_registers(dim, n_registers, seed=seed)
    rep["registers"] = rrep
    if rrep.get("ok"):
        rrep["model_hidden"] = model_hidden
        _note(rep, "registers", True,
              "%d reserved slots in sidecar dim %d (seed %d)"
              % (rrep["count"], dim, seed))
    else:
        _note(rep, "registers", False, rrep.get("reason", "skipped"))

    vectors, texts, irep = attach_memory_index(passages, dim, seed=seed)
    rep["memory_index"] = irep
    if irep.get("ok"):
        _note(rep, "memory_index", True,
              "%d searchable passages in sidecar HRR dim %d"
              % (irep["passages"], dim))
        _note(rep, "passages", True,
              "%d passages indexed (sidecar + in-weight rows when embed exists)"
              % irep["passages"])
        rep["passages"] = {"count": irep["passages"], "where": "sidecar",
                           "ok": True}
    else:
        _note(rep, "memory_index", False, irep.get("reason", "skipped"))
        _note(rep, "passages", False, irep.get("reason", "skipped"))

    w_out, iw = install_in_weight_embed(
        weights, texts or passages, keys=keys, sidecar_vectors=vectors,
        model_dir=model_dir, seed=seed, tokenize=tokenize)
    rep["in_weight_report"] = {
        k: iw[k] for k in iw if k not in ("memory_index", "registers")
    }
    if iw.get("ok") and iw.get("in_weight"):
        rep["in_weight"] = 1
        if iw.get("memory_index", {}).get("in_weight"):
            irep.update(iw["memory_index"])
            irep["ok"] = True
            irep["in_weight"] = 1
            rep["memory_index"] = irep
            if "passages" in rep:
                rep["passages"]["where"] = "embed.placeholder_or_tail_rows"
                rep["passages"]["in_weight"] = 1
            _note(rep, "in_weight_memory_index", True,
                  "%d passages written into embed rows %s"
                  % (iw["memory_index"]["n"], iw["memory_index"]["rows"][:4]))
        if iw.get("registers", {}).get("in_weight"):
            rrep["in_weight"] = 1
            rrep["where"] = iw["registers"]["where"]
            rrep["rows"] = iw["registers"]["rows"]
            rrep.pop("in_weight_skip", None)
            _note(rep, "in_weight_registers", True,
                  "%d register keys written into embed rows %s"
                  % (iw["registers"]["n"], iw["registers"]["rows"][:4]))
        else:
            _note(rep, "in_weight_registers", False,
                  (iw.get("registers") or {}).get("in_weight_skip")
                  or "registers stayed sidecar-only")
    else:
        _note(rep, "in_weight_memory_index", False,
              iw.get("reason") or "in-weight embed write skipped")

    rtr = attach_router()
    rep["router"] = rtr
    _note(rep, "router", False, rtr["reason"])
    _note(rep, "hrnn_ladder", False,
          "needs GDN decay channels; Flash has no recurrent state. "
          "Next bridge: Flash-native state tensor, not GDNRuntime.")
    _note(rep, "prepend", False,
          "GDN blank-layer prepend assumes Qwen layer_types. "
          "Next bridge: Flash MLA / MoE blank expert, not claimed here.")

    if model_dir and os.path.isdir(model_dir):
        try:
            shard = first_shard(model_dir)
            if shard:
                srep = smoke_one_shard(shard)
                rep["dequant_smoke"] = {
                    "n_tensors": srep.get("n_tensors"),
                    "dtypes": srep.get("dtypes"),
                    "dequant": srep.get("dequant"),
                    "path": os.path.basename(shard),
                }
                _note(rep, "dequant_smoke", True,
                      "one shard %s dtypes %s" % (
                          os.path.basename(shard), srep.get("dtypes")))
        except Exception as exc:
            _note(rep, "dequant_smoke", False, "%s: %s" % (type(exc).__name__, exc))

    sidecar = None
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        sidecar = os.path.join(out_dir, "lecore_hrr.npz")
        save_hrr_sidecar(sidecar, keys=keys, vectors=vectors, passages=texts,
                     seed=seed, dim=dim, meta={
                         "format": FORMAT,
                         "family": "deepseek_v4",
                         "base": rep.get("base"),
                         "in_weight": int(rep.get("in_weight") or 0),
                     })
        rep["sidecar"] = os.path.abspath(sidecar)
        ek = iw.get("embed_key")
        if iw.get("ok") and ek and w_out is not None and ek in w_out:
            from holographic.io_and_interop.holographic_unicron import (
                save_safetensors)
            embed_path = os.path.join(out_dir, "lecore_in_weight.safetensors")
            save_safetensors(embed_path, {ek: np.asarray(w_out[ek])})
            rep["in_weight_embed"] = os.path.abspath(embed_path)
            src_shard = iw.get("src_shard")
            if src_shard and os.path.isfile(src_shard):
                from holographic.io_and_interop.holographic_flash_hrr import (
                    _write_patched_shard)
                dest = os.path.join(out_dir, os.path.basename(src_shard))
                _write_patched_shard(src_shard, ek, w_out[ek], dest)
                rep["patched_embed_shard"] = os.path.abspath(dest)
        serial = _jsonable(rep)
        with open(os.path.join(out_dir, "lecore.json"), "w") as f:
            json.dump(serial, f, indent=2)
        with open(os.path.join(out_dir, "BASE.txt"), "w") as f:
            f.write("%s\n" % (rep.get("base") or ""))
        if model_dir:
            src_cfg = os.path.join(model_dir, "config.json")
            dst_cfg = os.path.join(out_dir, "config.json")
            if os.path.isfile(src_cfg) and os.path.abspath(src_cfg) != os.path.abspath(dst_cfg):
                with open(src_cfg) as f:
                    card = json.load(f)
                with open(dst_cfg, "w") as f:
                    json.dump(card, f, indent=2)
        with open(os.path.join(out_dir, "IN_WEIGHT.txt"), "w") as f:
            f.write(
                "in_weight=%s\n"
                "memory_index rows=%s\n"
                "registers rows=%s\n"
                "GDNRuntime is not a Flash forward.\n"
                "Serve: python assimilation/flash_in_weight_serve_dir.py "
                "MODEL_DIR OUT_DIR SERVE_DIR\n"
                "then vLLM --model SERVE_DIR\n"
                % (rep.get("in_weight"),
                   (rep.get("memory_index") or {}).get("rows"),
                   (rep.get("registers") or {}).get("rows"))
            )

    return w_out, cfg, rep


def save_hrr_sidecar(path, keys=None, vectors=None, passages=None, seed=0, dim=HRR_DIM,
                 meta=None):
    """Write the HRR sidecar. Small on purpose -- the base checkpoint stays put."""
    man = dict(meta or {})
    man.update({"format": FORMAT, "seed": int(seed), "dim": int(dim),
                "passages": list(passages or ())})
    payload = {
        "manifest": np.frombuffer(json.dumps(man).encode("utf-8"),
                                  dtype=np.uint8),
    }
    if keys is not None:
        payload["registers"] = np.asarray(keys, np.float32)
    if vectors is not None:
        payload["passage_vectors"] = np.asarray(vectors, np.float32)
    np.savez_compressed(path, **payload)
    return {"path": path, "bytes": os.path.getsize(path)}


def load_hrr_sidecar(path):
    z = np.load(path, allow_pickle=False)
    man = json.loads(bytes(z["manifest"]).decode("utf-8"))
    if man.get("format") != FORMAT:
        raise ValueError("not a DeepSeek-V4 HRR sidecar: %r" % man.get("format"))
    out = dict(man)
    if "registers" in z.files:
        out["registers"] = z["registers"]
    if "passage_vectors" in z.files:
        out["vectors"] = z["passage_vectors"]
        out["passages"] = list(man.get("passages") or ())
    return out


def _text_of(content):
    """Flatten OpenAI message content (string or multipart) to plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(str(p.get("text") or p.get("content") or ""))
            else:
                parts.append(str(p))
        return " ".join(x for x in parts if x)
    return str(content)


def cue_from_openai_body(body):
    """Last user utterance (chat) or the prompt (completions) -- the recall cue."""
    if not isinstance(body, dict):
        return ""
    msgs = body.get("messages")
    if isinstance(msgs, list) and msgs:
        for msg in reversed(msgs):
            if not isinstance(msg, dict):
                continue
            if str(msg.get("role") or "").lower() == "user":
                return _text_of(msg.get("content")).strip()
        return _text_of(msgs[-1].get("content") if isinstance(msgs[-1], dict)
                        else "").strip()
    prompt = body.get("prompt")
    if isinstance(prompt, str):
        return prompt.strip()
    return ""


def build_system_inject(hits, max_chars=GATEWAY_INJECT_MAX):
    """Gateway-shaped system inject: header + ranked passages, hard-capped.

    Compatible with external Gateway attach: the payload is a system message
    whose body is at most `max_chars` (default 1024). Empty hits -> empty
    string (do not inject a hollow header).
    """
    cap = int(max_chars)
    if cap <= 0 or not hits:
        return ""
    header = GATEWAY_INJECT_HEADER
    if len(header) > cap:
        return header[:cap]
    lines = [header]
    used = len(header)
    for i, item in enumerate(hits, 1):
        text = item[2] if len(item) > 2 else item[-1]
        line = "%d. %s" % (i, " ".join(str(text).split()))
        extra = 1 + len(line)
        if used + extra <= cap:
            lines.append(line)
            used += extra
            continue
        room = cap - used - 1
        if room >= 4:
            cut = line[:room]
            if len(line) > room:
                cut = cut.rstrip()
                if not cut.endswith("..."):
                    cut = (cut[:-3] + "...") if len(cut) >= 3 else cut
            lines.append(cut)
        break
    out = "\n".join(lines)
    return out[:cap]


def _is_hrr_inject_message(msg):
    if not isinstance(msg, dict):
        return False
    if str(msg.get("role") or "").lower() != "system":
        return False
    return _text_of(msg.get("content")).lstrip().startswith(GATEWAY_INJECT_HEADER)


def attach_messages(messages, inject):
    """Insert the HRR inject as a dedicated leading system message.

    Idempotent: a previous [leCore HRR] system message is replaced. Existing
    caller system prompts are preserved after the inject. The inject itself
    is already capped at GATEWAY_INJECT_MAX.
    """
    msgs = [dict(m) for m in (messages or []) if isinstance(m, dict)]
    if not inject:
        return [m for m in msgs if not _is_hrr_inject_message(m)]
    rest = [m for m in msgs if not _is_hrr_inject_message(m)]
    return [{"role": "system", "content": inject}] + rest


class FlashHRR:
    """Flash-native consume of an install OUT_DIR. No GDNRuntime. No 48 shards.

    This is flash-as-hrr at two layers: (1) in-weight embed rows written at
    install (lecore.json in_weight=1), (2) sidecar recall attached into the
    generation request BEFORE tokens. Downstream generate (vLLM) can load the
    patched embed shard. GDNRuntime is not a Flash forward.
    """

    def __init__(self, index, card=None, out_dir=None):
        self.index = index
        self.card = dict(card or {})
        self.out_dir = os.path.abspath(out_dir) if out_dir else None

    @classmethod
    def open(cls, out_dir):
        """Load lecore.json + lecore_hrr.npz. Accepts OUT_DIR or the npz path."""
        path = os.path.abspath(out_dir)
        if path.endswith(".npz"):
            npz, root = path, os.path.dirname(path)
        else:
            npz, root = os.path.join(path, "lecore_hrr.npz"), path
        if not os.path.isfile(npz):
            raise FileNotFoundError(
                "no lecore_hrr.npz in %r -- run "
                "python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR "
                "first" % root)
        index = load_hrr_sidecar(npz)
        card = {}
        card_path = os.path.join(root, "lecore.json")
        if os.path.isfile(card_path):
            with open(card_path) as f:
                card = json.load(f)
        return cls(index, card=card, out_dir=root)

    def recall(self, query, k=3):
        """Ranked passages: [(index, cosine, text), ...]."""
        return search_index(self.index, query, k=k)

    def register_keys(self):
        """Sidecar orthonormal keys (n, dim) float array, or None."""
        keys = self.index.get("registers")
        return None if keys is None else np.asarray(keys)

    def status(self):
        keys = self.register_keys()
        passages = list(self.index.get("passages") or ())
        return {
            "format": self.index.get("format") or self.card.get("format"),
            "family": self.card.get("family") or "deepseek_v4",
            "out_dir": self.out_dir,
            "hrr_dim": int(self.index.get("dim") or self.card.get("hrr_dim")
                           or 0),
            "seed": int(self.index.get("seed") or 0),
            "passages": len(passages),
            "registers": 0 if keys is None else int(keys.shape[0]),
            "in_weight": int(self.card.get("in_weight") or 0),
            "runtime": "flash-embed-rows + sidecar inject; GDNRuntime not called",
            "inject_max": GATEWAY_INJECT_MAX,
            "gateway_header": GATEWAY_INJECT_HEADER,
        }

    def system_inject(self, query, k=3, max_chars=GATEWAY_INJECT_MAX):
        """Gateway-compatible system inject for `query`."""
        hits = self.recall(query, k=k)
        return build_system_inject(hits, max_chars=max_chars), hits

    def attach(self, body, k=3, query=None, max_chars=GATEWAY_INJECT_MAX):
        """Attach sidecar memory into an OpenAI-style generation request.

        THIS is the inject-before-generate point. Copy `body`, inject HRR,
        leave model/temperature/max_tokens/stream alone. Does not call a
        Flash forward. Returns (attached_body, info).
        """
        if not isinstance(body, dict):
            raise TypeError("attach() wants an OpenAI request dict, got %r"
                            % type(body).__name__)
        cue = (query if query is not None else cue_from_openai_body(body)).strip()
        inject, hits = ("", [])
        if cue:
            inject, hits = self.system_inject(cue, k=k, max_chars=max_chars)
        attached = dict(body)
        info = {
            "attached": bool(inject),
            "query": cue,
            "k": int(k),
            "hits": [{"index": int(i), "score": float(s), "passage": t}
                     for i, s, t in hits],
            "inject": inject,
            "inject_chars": len(inject),
            "inject_max": int(max_chars),
            "in_weight": int(self.card.get("in_weight") or 0),
            "inject_where": "system" if body.get("messages") is not None else "prompt",
            "where": "system" if body.get("messages") is not None else "prompt",
        }
        if not inject:
            return attached, info
        if "messages" in body or body.get("messages") is not None:
            attached["messages"] = attach_messages(body.get("messages") or [],
                                                   inject)
        else:
            prompt = body.get("prompt")
            if isinstance(prompt, str):
                attached["prompt"] = inject + "\n\n" + prompt
            elif prompt is None:
                attached["messages"] = attach_messages([], inject)
            # token-id prompts: cannot prefix text; leave unchanged
        return attached, info

    def before_generate(self, body, k=3, query=None):
        """Serve-layer hook: return the body vLLM should see. HRR already ran."""
        attached, _info = self.attach(body, k=k, query=query)
        return attached

    def forward(self, body, upstream, k=3, query=None, timeout=60):
        """Attach, then POST to an OpenAI-compatible generate backend.

        `upstream` is the vLLM (or Gateway) base, e.g. http://127.0.0.1:8000.
        Chat bodies go to /v1/chat/completions; prompt bodies to /v1/completions.
        Returns (response_json, info, attached_body).
        """
        import urllib.error
        import urllib.request

        attached, info = self.attach(body, k=k, query=query)
        if "messages" in attached:
            path = "/v1/chat/completions"
        else:
            path = "/v1/completions"
        url = str(upstream).rstrip("/") + path
        req = urllib.request.Request(
            url,
            data=json.dumps(attached).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            err = exc.read().decode("utf-8", "replace")
            raise RuntimeError("upstream %s -> HTTP %s: %s"
                               % (url, exc.code, err[:400])) from exc
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except ValueError:
            parsed = {"raw": raw.decode("utf-8", "replace")}
        return parsed, info, attached


def open_session(out_dir):
    """Load a Flash HRR sidecar session from an install OUT_DIR."""
    return FlashHRR.open(out_dir)


def _jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        return float(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if obj is None or isinstance(obj, str):
        return obj
    return str(obj)


def fake_deepseek_v4_weights(hidden=32, vocab=48, n_layers=2):
    """Tiny in-memory Flash-shaped dict for tests. Not 156G, not Qwen GDN."""
    h, v = int(hidden), int(vocab)
    z = lambda *sh: np.zeros(sh, np.float32)
    w = {"model.embed_tokens.weight": z(v, h),
         "lm_head.weight": z(v, h)}
    for i in range(int(n_layers)):
        p = "model.layers.%d." % i
        w[p + "self_attn.q_proj.weight"] = z(h, h)
        w[p + "self_attn.k_proj.weight"] = z(h, h)
        w[p + "self_attn.v_proj.weight"] = z(h, h)
        w[p + "self_attn.o_proj.weight"] = z(h, h)
        w[p + "mlp.gate_proj.weight"] = z(2 * h, h)
        w[p + "mlp.up_proj.weight"] = z(2 * h, h)
        w[p + "mlp.down_proj.weight"] = z(h, 2 * h)
        w[p + "input_layernorm.weight"] = z(h)
        w[p + "post_attention_layernorm.weight"] = z(h)
    return w


def fake_deepseek_v4_config(hidden=32, vocab=48, n_layers=2, n_experts=16):
    return {
        "model_type": "deepseek_v4",
        "architectures": ["DeepseekV4ForCausalLM"],
        "hidden_size": int(hidden),
        "num_hidden_layers": int(n_layers),
        "vocab_size": int(vocab),
        "num_attention_heads": 4,
        "num_experts": int(n_experts),
        "torch_dtype": "bfloat16",
    }


def unpack_fp4(packed):
    """I8 packed E2M1: two FP4 values per byte via the official LUT."""
    raw = np.asarray(packed).view(np.uint8)
    low = raw & 0x0F
    high = (raw >> 4) & 0x0F
    return np.stack([FP4_TABLE[low], FP4_TABLE[high]], axis=-1).reshape(
        raw.shape[:-1] + (raw.shape[-1] * 2,))


def dequant_fp4(packed, scale, block=FP4_BLOCK):
    """Expert weights: packed I8 + per-row E8M0 scale (block=32)."""
    w = unpack_fp4(packed)
    s = np.asarray(scale, np.float32)
    if s.ndim == 1:
        s = s.reshape(w.shape[0], -1)
    s = np.repeat(s, int(block), axis=-1)[:, :w.shape[-1]]
    return (w * s).astype(np.float32)


def dequant_fp8_block(weight, scale, block=FP8_BLOCK):
    """Non-expert weights: F8_E4M3 + 128x128 E8M0 block scale."""
    w = np.asarray(weight, np.float32)
    s = np.asarray(scale, np.float32)
    out_dim, in_dim = w.shape
    b = int(block)
    pad_o = (b - out_dim % b) % b
    pad_i = (b - in_dim % b) % b
    if pad_o or pad_i:
        w = np.pad(w, ((0, pad_o), (0, pad_i)))
    n_o = w.shape[0] // b
    n_i = w.shape[1] // b
    tiles = w.reshape(n_o, b, n_i, b)
    s = s.reshape(n_o, n_i)
    tiles = tiles * s[:, None, :, None]
    return tiles.reshape(w.shape[0], w.shape[1])[:out_dim, :in_dim].astype(
        np.float32)


def dequant_pair(weights, name):
    """Dequantise one `<name>.weight` against its sibling `<name>.scale`.
    I8-packed FP4 (experts, block 32) or F8_E4M3 (attention, 128x128 tiles)
    are told apart by the stored dtype -- what the one-shard smoke scripts
    walk a shard with."""
    if not str(name).endswith(".weight"):
        raise KeyError("expected a '.weight' tensor name, got %r" % (name,))
    w = weights[name]
    scale = weights[name[:-7] + ".scale"]
    if np.asarray(w).dtype == np.int8:
        return dequant_fp4(np.asarray(w), scale)
    return dequant_fp8_block(np.asarray(w, np.float32), scale)


def first_shard(model_dir):
    """Smallest *.safetensors in the directory -- one-shard smoke, not 48-way."""
    names = sorted(f for f in os.listdir(model_dir)
                   if f.endswith(".safetensors") and not f.endswith(".index.json"))
    if not names:
        return None
    paths = [os.path.join(model_dir, f) for f in names]
    return min(paths, key=lambda p: os.path.getsize(p))


def make_in_weight_serve_dir(model_dir, out_dir, serve_dir):
    """Symlink MODEL_DIR into SERVE_DIR, overlay the patched embed shard.

    Does not copy 156G. vLLM --model SERVE_DIR then sees in-weight rows.
    """
    import shutil
    model_dir = os.path.abspath(model_dir)
    out_dir = os.path.abspath(out_dir)
    serve_dir = os.path.abspath(serve_dir)
    os.makedirs(serve_dir, exist_ok=True)
    patched = None
    card_path = os.path.join(out_dir, "lecore.json")
    if os.path.isfile(card_path):
        with open(card_path) as f:
            card = json.load(f)
        patched = card.get("patched_embed_shard")
    if not patched or not os.path.isfile(patched):
        for name in os.listdir(out_dir):
            if name.endswith(".safetensors") and name.startswith("model-"):
                patched = os.path.join(out_dir, name)
                break
    for name in os.listdir(model_dir):
        src = os.path.join(model_dir, name)
        dst = os.path.join(serve_dir, name)
        if os.path.lexists(dst):
            continue
        try:
            os.symlink(src, dst)
        except OSError:
            if os.path.isfile(src) and os.path.getsize(src) < 50_000_000:
                shutil.copy2(src, dst)
    if patched and os.path.isfile(patched):
        dest = os.path.join(serve_dir, os.path.basename(patched))
        if os.path.lexists(dest):
            os.remove(dest)
        shutil.copy2(patched, dest)
        return {"serve_dir": serve_dir, "patched_embed": dest, "in_weight": 1}
    return {"serve_dir": serve_dir, "patched_embed": None, "in_weight": 0}


def smoke_one_shard(path):
    """Header census + dequant of the smallest Flash-quant tensor. No 48-shard load.

    Returns a report. Does not call GDNRuntime. Does not rewrite the file.
    """
    from holographic.io_and_interop.holographic_unicron import (
        safetensors_header, load_safetensors_one)

    header, _off = safetensors_header(path)
    census = {}
    tensors = []
    for name, meta in header.items():
        if name == "__metadata__" or not isinstance(meta, dict):
            continue
        dt = str(meta.get("dtype") or "?")
        census[dt] = census.get(dt, 0) + 1
        tensors.append((name, dt, tuple(meta.get("shape") or ())))
    rep = {"path": os.path.abspath(path), "n_tensors": len(tensors),
           "dtypes": census, "dequant": None}
    by_name = {n: (dt, sh) for n, dt, sh in tensors}

    def _nbytes(shape, dt):
        n = 1
        for d in shape:
            n *= int(d)
        return n

    # Prefer a tiny I8 packed-FP4 weight with a sibling .scale
    candidates = []
    for name, dt, sh in tensors:
        if not name.endswith(".weight"):
            continue
        scale = name[:-len(".weight")] + ".scale"
        if scale not in by_name:
            continue
        sdt, ssh = by_name[scale]
        candidates.append((_nbytes(sh, dt), name, dt, sh, scale, sdt, ssh))
    candidates.sort()
    if not candidates:
        rep["note"] = "no .weight+.scale pair in this shard -- header census only"
        return rep
    _nb, name, dt, sh, scale, sdt, ssh = candidates[0]
    w = load_safetensors_one(path, name)
    s = load_safetensors_one(path, scale)
    if dt == "I8":
        out = dequant_fp4(w, s)
        kind = "fp4_i8_e8m0"
    elif dt in ("F8_E4M3", "F32") and sdt in ("F8_E8M0", "F32"):
        out = dequant_fp8_block(w, s) if w.ndim == 2 else (w * s)
        kind = "fp8_e4m3_e8m0"
    else:
        rep["note"] = "pair %s (%s) + %s (%s) has no dequant rule" % (
            name, dt, scale, sdt)
        return rep
    finite = bool(np.all(np.isfinite(out)))
    rep["dequant"] = {
        "weight": name, "scale": scale, "kind": kind,
        "packed_shape": list(sh), "out_shape": list(out.shape),
        "finite": finite,
        "absmax": float(np.nanmax(np.abs(out))) if out.size else 0.0,
    }
    if not finite:
        raise ValueError("dequant of %s produced non-finite values" % name)
    return rep


def write_flash_toy_shard(path):
    """Tiny Flash-shaped safetensors: I8 packed FP4 + F8_E8M0 scale + F8_E4M3."""
    import struct as _st
    packed = np.full((2, 16), 0x21, dtype=np.uint8)   # 0.5, 1.0 repeating
    scale = np.full((2, 1), 127, dtype=np.uint8)      # 2**(127-127) = 1.0
    e4 = np.full((4, 4), 0x38, dtype=np.uint8)        # E4M3 1.0
    items = {
        "experts.0.weight": ("I8", packed.shape, packed.tobytes()),
        "experts.0.scale": ("F8_E8M0", scale.shape, scale.tobytes()),
        "attn.q_proj.weight": ("F8_E4M3", e4.shape, e4.tobytes()),
        "attn.q_proj.scale": ("F8_E8M0", (1, 1), np.array([127], np.uint8).tobytes()),
    }
    header, blobs, off = {}, [], 0
    for name in sorted(items):
        dt, shape, raw = items[name]
        header[name] = {"dtype": dt, "shape": list(shape),
                        "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)
    hj = json.dumps(header, sort_keys=True).encode("utf-8")
    with open(path, "wb") as f:
        f.write(_st.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)
    return path


def _selftest():
    import tempfile

    assert is_deepseek_v4(fake_deepseek_v4_config())
    assert is_deepseek_v4({"architectures": ["DeepseekV4ForCausalLM"]})
    assert not is_deepseek_v4({"model_type": "qwen3_next",
                               "architectures": ["Qwen3NextForCausalLM"]})
    try:
        refuse_qwen_gdn(cfg=fake_deepseek_v4_config())
        raise AssertionError("refuse_qwen_gdn must raise")
    except QwenGDNRefused as exc:
        assert "install_deepseek_v4" in str(exc)

    keys, rrep = attach_registers(64, 8, seed=1)
    assert rrep["ok"] and rrep["in_weight"] is False
    assert np.allclose(keys @ keys.T, np.eye(8), atol=1e-6)
    passages = ["the capital of France is Paris",
                "water freezes at zero celsius"]
    vectors, texts, irep = attach_memory_index(passages, dim=64, seed=1)
    assert irep["ok"] and irep["searchable"]
    hits = search_index({"vectors": vectors, "passages": texts, "seed": 1},
                        "capital of France", k=1)
    assert "paris" in hits[0][2].lower()
    assert attach_router()["ok"] is False

    cfg = fake_deepseek_v4_config()
    w = fake_deepseek_v4_weights()
    orig = np.array(w["model.embed_tokens.weight"], copy=True)
    td = tempfile.mkdtemp()
    _w, _c, rep = install_deepseek_v4(w, cfg, passages=passages, n_registers=8, seed=1,
                          out_dir=td, hrr_dim=64)
    assert _w is not w
    assert not np.array_equal(_w["model.embed_tokens.weight"], orig)
    assert int(rep["in_weight"]) == 1
    assert int(rep["memory_index"]["in_weight"]) == 1
    assert "registers" in rep["installed"]
    assert "memory_index" in rep["installed"]
    assert "router" not in rep["installed"]
    assert os.path.isfile(os.path.join(td, "lecore.json"))
    card = json.loads(open(os.path.join(td, "lecore.json")).read())
    assert int(card["in_weight"]) == 1
    assert os.path.isfile(os.path.join(td, "lecore_in_weight.safetensors"))
    idx = load_hrr_sidecar(os.path.join(td, "lecore_hrr.npz"))
    assert search_index(idx, "capital of France", k=1)

    sess = FlashHRR.open(td)
    hits = sess.recall("capital of France", k=1)
    assert hits and "paris" in hits[0][2].lower()
    keys = sess.register_keys()
    assert keys is not None and keys.shape[0] == 8
    assert int(sess.status()["in_weight"]) == 1
    body = {"model": "deepseek-v4-flash",
            "messages": [{"role": "user",
                          "content": "what is the capital of France?"}],
            "max_tokens": 32, "temperature": 0}
    attached, info = sess.attach(body)
    assert info["attached"] and int(info["in_weight"]) == 1
    assert attached["messages"][0]["role"] == "system"
    assert attached["messages"][0]["content"].startswith(GATEWAY_INJECT_HEADER)
    assert "paris" in attached["messages"][0]["content"].lower()
    assert len(attached["messages"][0]["content"]) <= GATEWAY_INJECT_MAX
    assert attached["messages"][-1]["content"] == body["messages"][0]["content"]
    assert attached["model"] == "deepseek-v4-flash"
    assert attached["max_tokens"] == 32
    again, _ = sess.attach(attached)
    n_sys = sum(1 for m in again["messages"] if m["role"] == "system"
                and str(m.get("content", "")).startswith(GATEWAY_INJECT_HEADER))
    assert n_sys == 1
    huge = build_system_inject(
        [(0, 1.0, "x" * 4000), (1, 0.9, "y" * 4000)], max_chars=1024)
    assert len(huge) <= 1024 and huge.startswith(GATEWAY_INJECT_HEADER)

    packed = np.full((2, 16), 0x21, dtype=np.int8)   # nibbles 1,2 -> 0.5, 1.0
    scale = np.ones((2, 1), np.float32)              # E8M0 2^0
    got = dequant_fp4(packed, scale)
    assert got.shape == (2, 32)
    assert np.allclose(got[0, :4], [0.5, 1.0, 0.5, 1.0])
    shard = os.path.join(td, "toy.safetensors")
    write_flash_toy_shard(shard)
    smoke = smoke_one_shard(shard)
    assert smoke["dequant"]["finite"]
    print("deepseek_v4 selftest OK -- detect, refuse GDN, in_weight=1 embed "
          "rows, sidecar registers + searchable passages, router/HRNN/prepend "
          "skipped, one-shard FP4 dequant, FlashHRR attach injects recall")


def _cli(argv=None):
    """No args -> _selftest (module walker). Else recall / attach / registers."""
    import argparse
    import sys as _sys

    argv = list(_sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("selftest",):
        _selftest()
        return 0
    ap = argparse.ArgumentParser(
        prog="holographic_deepseek_v4",
        description="Flash-as-HRR: consume a sidecar, inject before generate")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_rec = sub.add_parser("recall", help="ranked passages from OUT_DIR")
    p_rec.add_argument("out_dir")
    p_rec.add_argument("query")
    p_rec.add_argument("-k", type=int, default=3)
    p_rec.add_argument("--json", action="store_true")
    p_att = sub.add_parser("attach", help="inject HRR into an OpenAI body")
    p_att.add_argument("out_dir")
    p_att.add_argument("query", nargs="?", default="")
    p_att.add_argument("--messages", default="",
                       help="JSON list of OpenAI messages (default: one user)")
    p_att.add_argument("--body", default="",
                       help="JSON OpenAI request (chat or completions)")
    p_att.add_argument("-k", type=int, default=3)
    p_reg = sub.add_parser("registers", help="sidecar register key summary")
    p_reg.add_argument("out_dir")
    p_st = sub.add_parser("status", help="sidecar card")
    p_st.add_argument("out_dir")
    a = ap.parse_args(argv)
    sess = FlashHRR.open(a.out_dir)
    if a.cmd == "status":
        print(json.dumps(sess.status(), indent=2))
        return 0
    if a.cmd == "registers":
        keys = sess.register_keys()
        st = sess.status()
        print(json.dumps({
            "count": st["registers"], "dim": st["hrr_dim"], "seed": st["seed"],
            "in_weight": int(st.get("in_weight") or 0),
            "shape": None if keys is None else list(keys.shape),
        }, indent=2))
        return 0
    if a.cmd == "recall":
        hits = sess.recall(a.query, k=int(a.k))
        if a.json:
            print(json.dumps([{"index": i, "score": s, "passage": t}
                              for i, s, t in hits], indent=2))
        else:
            for rank, (i, s, t) in enumerate(hits, 1):
                print("%d  %.3f  %s" % (rank, s, t))
        return 0
    body = None
    if a.body:
        body = json.loads(a.body)
    elif a.messages:
        body = {"model": "deepseek-v4-flash",
                "messages": json.loads(a.messages),
                "max_tokens": 32}
    else:
        q = a.query or ""
        if not q:
            raise SystemExit("attach needs QUERY or --messages or --body")
        body = {"model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": q}],
                "max_tokens": 32}
    attached, info = sess.attach(body, k=int(a.k),
                                 query=(a.query or None))
    print(json.dumps({"body": attached, "info": info}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())

