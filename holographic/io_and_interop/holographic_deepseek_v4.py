"""DEEPSEEK-V4 FLASH -- HRR-attach bridge that does NOT go through GDNRuntime.

Qwen3-Next / Qwen3.5 is a Gated-DeltaNet hybrid. DeepSeek-V4 Flash is not.
`GDNRuntime` + `assimilation/install.py` assume Qwen tensor names, Qwen
layer_types, and a dense MLP. Pointing that path at Flash either raises
inside a reshape or, worse, tries to mmap ~48 shards into the wrong
forward. This module is the other door.

WHAT THIS SLICE DOES
    detect     config.json model_type == deepseek_v4, or architectures
               containing DeepseekV4ForCausalLM
    refuse     any Qwen GDN load of that config, with a pointer at the CLI
    attach     HRR faculties into a SIDECAR + lecore.json
                 registers        seed-derived orthonormal keys (real)
                 memory_index     searchable HRR passage index (real)
                 router           skipped -- needs a Flash forward, not GDN
    load       one-shard peek: F8_E8M0 / F8_E4M3 / I8 packed FP4 (official LUT)
    not this   MoE runtime, 48-shard eager install, assimilate compression,
               in-weight Galvatron (follow-up)

IN-WEIGHT vs SIDECAR, stated so nobody reads a skip as a success:
    Qwen registers live in the GDN recurrent state and regenerate from a
    seed -- the weights are not rewritten for that step. Flash has no GDN
    state, so the same reservation lands in the sidecar. That is a real
    attach of the keys, and an honest skip of in-weight enforcement
    (orthogonalise on the model's own keys) until a Flash runtime exists.
    The passage index is the same shape of answer: searchable in the
    sidecar via HRR bundle+nearest, not written into unused vocab rows
    (that write needs GDN hidden states and would mutate the 156G file).

CLI:  python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR [--smoke-shard]
"""

from __future__ import annotations

import json
import os
import re

import numpy as np


FORMAT = "leCore/deepseek_v4_hrr/1"
HRR_DIM = 256

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
        "Use the HRR-attach path, which does not call GDNRuntime:\n"
        "\n"
        "    python assimilation/install_deepseek_v4.py MODEL_DIR OUT_DIR\n"
        "    ./assimilation/install_deepseek_v4.sh MODEL_DIR OUT_DIR\n"
        "\n"
        "That writes lecore.json plus a sidecar with registers and searchable "
        "passages. It does not assimilate, does not rewrite the base weights, "
        "and does not pretend a GDN router fitted. In-weight Galvatron "
        "(prepend / GDN gate / head-row index) is a follow-up -- Flash has "
        "no GDN recurrent state on this path."
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
            "In-weight head-row index needs GDN hidden-state addresses and "
            "unused tokenizer rows. This path does not call GDNRuntime and "
            "does not rewrite Flash weights. Search the sidecar instead."
        ),
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


def install(weights, cfg, passages=(), n_registers=16, seed=0, out_dir=None,
            hrr_dim=HRR_DIM, model_dir=None):
    """Attach HRR faculties to a DeepSeek-V4 config. Never calls GDNRuntime.

    `weights` may be a tiny dict (tests) or None (CLI -- we do not load 156G).
    Returns (weights, cfg, report). Weights are returned UNCHANGED -- this
    path does not rewrite the base.
    """
    if not is_deepseek_v4(cfg):
        raise ValueError(
            "install() on holographic_deepseek_v4 requires a DeepSeek-V4 "
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
        for key, arr in weights.items():
            if str(key).endswith("embed_tokens.weight"):
                hidden = int(np.asarray(arr).shape[-1])
                break
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
        "in_weight": False,
        "runtime": "none -- GDNRuntime is Qwen-only and is not called",
        "assimilate": False,
    }

    keys, rrep = attach_registers(dim, n_registers, seed=seed)
    rep["registers"] = rrep
    if rrep.get("ok"):
        rrep["model_hidden"] = model_hidden
        _note(rep, "registers", True,
              "%d reserved slots in sidecar dim %d (seed %d); in-weight "
              "GDN enforcement skipped" % (rrep["count"], dim, seed))
    else:
        _note(rep, "registers", False, rrep.get("reason", "skipped"))

    vectors, texts, irep = attach_memory_index(passages, dim, seed=seed)
    rep["memory_index"] = irep
    if irep.get("ok"):
        _note(rep, "memory_index", True,
              "%d searchable passages in sidecar HRR dim %d"
              % (irep["passages"], dim))
        _note(rep, "passages", True,
              "%d passages indexed (sidecar; not written into vocab rows)"
              % irep["passages"])
        rep["passages"] = {"count": irep["passages"], "where": "sidecar",
                           "ok": True}
    else:
        _note(rep, "memory_index", False, irep.get("reason", "skipped"))
        _note(rep, "passages", False, irep.get("reason", "skipped"))

    rtr = attach_router()
    rep["router"] = rtr
    _note(rep, "router", False, rtr["reason"])

    sidecar = None
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        sidecar = os.path.join(out_dir, "lecore_hrr.npz")
        save_sidecar(sidecar, keys=keys, vectors=vectors, passages=texts,
                     seed=seed, dim=dim, meta={
                         "format": FORMAT,
                         "family": "deepseek_v4",
                         "base": rep.get("base"),
                     })
        rep["sidecar"] = os.path.abspath(sidecar)
        serial = _jsonable(rep)
        with open(os.path.join(out_dir, "lecore.json"), "w") as f:
            json.dump(serial, f, indent=2)
        # pointer only -- do not copy 156G weights
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

    return weights, cfg, rep


def save_sidecar(path, keys=None, vectors=None, passages=None, seed=0, dim=HRR_DIM,
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


def load_sidecar(path):
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


def first_shard(model_dir):
    """Smallest *.safetensors in the directory -- one-shard smoke, not 48-way."""
    names = sorted(f for f in os.listdir(model_dir)
                   if f.endswith(".safetensors") and not f.endswith(".index.json"))
    if not names:
        return None
    paths = [os.path.join(model_dir, f) for f in names]
    return min(paths, key=lambda p: os.path.getsize(p))


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
    td = tempfile.mkdtemp()
    _w, _c, rep = install(w, cfg, passages=passages, n_registers=8, seed=1,
                          out_dir=td, hrr_dim=64)
    assert _w is w
    assert "registers" in rep["installed"]
    assert "memory_index" in rep["installed"]
    assert "router" not in rep["installed"]
    assert os.path.isfile(os.path.join(td, "lecore.json"))
    idx = load_sidecar(os.path.join(td, "lecore_hrr.npz"))
    assert search_index(idx, "capital of France", k=1)

    packed = np.full((2, 16), 0x21, dtype=np.int8)   # nibbles 1,2 -> 0.5, 1.0
    scale = np.ones((2, 1), np.float32)              # E8M0 2^0
    got = dequant_fp4(packed, scale)
    assert got.shape == (2, 32)
    assert np.allclose(got[0, :4], [0.5, 1.0, 0.5, 1.0])
    shard = os.path.join(td, "toy.safetensors")
    write_flash_toy_shard(shard)
    smoke = smoke_one_shard(shard)
    assert smoke["dequant"]["finite"]
    print("deepseek_v4 selftest OK -- detect, refuse GDN, sidecar registers "
          "+ searchable passages, router skipped, one-shard FP4 dequant")


if __name__ == "__main__":
    _selftest()

