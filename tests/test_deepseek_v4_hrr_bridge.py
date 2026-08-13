"""DeepSeek-V4 Flash HRR-attach bridge -- detection, refuse-GDN, sidecar faculties.

Tiny fake weight dicts only. No 156G, no shard load, no GDNRuntime on the
Flash path. The Qwen installer is asserted to still exist and to refuse
a DeepSeek card without importing this test's fake weights into GDN.
"""
import ast
import json
import os

import numpy as np
import pytest

from holographic.io_and_interop import holographic_deepseek_v4 as D


def _qwen_cfg():
    return {"model_type": "qwen3_next",
            "architectures": ["Qwen3NextForCausalLM"],
            "hidden_size": 128,
            "num_hidden_layers": 4}


def test_detects_model_type_deepseek_v4():
    assert D.is_deepseek_v4({"model_type": "deepseek_v4"})
    assert D.is_deepseek_v4({"model_type": "deepseek-v4"})
    assert D.is_deepseek_v4({"model_type": "deepseek_v4_flash"})


def test_detects_architectures_deepseek_v4_for_causal_lm():
    assert D.is_deepseek_v4({
        "architectures": ["DeepseekV4ForCausalLM"],
        "hidden_size": 8,
    })
    assert D.is_deepseek_v4({
        "text_config": {"architectures": ["DeepSeekV4ForCausalLM"]},
    })


def test_qwen_config_is_not_deepseek_v4():
    assert not D.is_deepseek_v4(_qwen_cfg())
    assert not D.is_deepseek_v4({"model_type": "llama"})
    assert not D.is_deepseek_v4({})
    assert not D.is_deepseek_v4(None)


def test_detect_from_dir_reads_config_json_only(tmp_path):
    cfg = D.fake_deepseek_v4_config()
    (tmp_path / "config.json").write_text(json.dumps(cfg))
    got = D.detect_from_dir(str(tmp_path))
    assert got is not None
    assert D.is_deepseek_v4(got)
    qwen = tmp_path / "qwen"
    qwen.mkdir()
    (qwen / "config.json").write_text(json.dumps(_qwen_cfg()))
    assert D.detect_from_dir(str(qwen)) is None


def test_flash_module_and_cli_never_import_gdnruntime():
    """The unlock: this path must not pull in the Qwen forward."""
    root = os.path.join(os.path.dirname(__file__), "..")
    for rel in ("holographic/io_and_interop/holographic_deepseek_v4.py",
                "assimilation/install_deepseek_v4.py"):
        src = open(os.path.join(root, rel), encoding="utf-8").read()
        tree = ast.parse(src)
        imported = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.extend(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.append(node.module or "")
                imported.extend(a.name for a in node.names)
        joined = " ".join(imported)
        assert "GDNRuntime" not in joined, rel
        assert "holographic_gdnruntime" not in joined, rel
        assert "holographic_install_lecore" not in joined, rel


def test_install_on_tiny_fake_weights_writes_lecore_json(tmp_path):
    cfg = D.fake_deepseek_v4_config(hidden=32, vocab=48, n_layers=2)
    w = D.fake_deepseek_v4_weights(hidden=32, vocab=48, n_layers=2)
    assert "linear_attn" not in " ".join(w)
    passages = [
        "the capital of France is Paris",
        "water freezes at zero degrees celsius",
        "registers are reserved orthonormal key directions",
    ]
    out = tmp_path / "galvatron_dsv4"
    w2, cfg2, rep = D.install(
        w, cfg, passages=passages, n_registers=8, seed=0,
        out_dir=str(out), hrr_dim=64, model_dir=str(tmp_path))
    # base weights are not rewritten
    assert w2 is w
    assert np.array_equal(
        w["model.embed_tokens.weight"],
        D.fake_deepseek_v4_weights(hidden=32, vocab=48)["model.embed_tokens.weight"])
    assert "registers" in rep["installed"]
    assert "memory_index" in rep["installed"]
    assert "passages" in rep["installed"]
    assert "router" not in rep["installed"]
    assert rep["router"]["ok"] is False
    assert "GDNRuntime" in rep["router"]["reason"]
    assert rep["registers"]["ok"] is True
    assert rep["registers"]["in_weight"] is False
    assert rep["memory_index"]["ok"] is True
    assert rep["memory_index"]["in_weight"] is False
    assert (out / "lecore.json").is_file()
    card = json.loads((out / "lecore.json").read_text())
    assert card["format"] == D.FORMAT
    assert card["family"] == "deepseek_v4"
    assert "router" in [s["step"] for s in card["skipped"]]
    assert (out / "lecore_hrr.npz").is_file()


def test_registers_regenerate_from_seed_and_are_orthonormal():
    keys, rep = D.attach_registers(64, 8, seed=3)
    assert rep["ok"]
    again, _ = D.attach_registers(64, 8, seed=3)
    assert np.allclose(keys, again)
    gram = keys @ keys.T
    assert np.allclose(gram, np.eye(8), atol=1e-6)


def test_sidecar_passages_are_searchable():
    passages = [
        "the capital of France is Paris",
        "water freezes at zero degrees celsius",
        "DeepSeek-V4 Flash is not Gated DeltaNet",
    ]
    vectors, texts, irep = D.attach_memory_index(passages, dim=64, seed=0)
    assert irep["ok"] and irep["searchable"]
    hits = D.search_index(
        {"vectors": vectors, "passages": texts, "seed": 0},
        "capital of France", k=1)
    assert hits, hits
    assert "paris" in hits[0][2].lower()
    assert hits[0][1] > 0.3


def test_qwen_config_from_json_still_loads():
    """The refuse must not fire on Qwen -- that path stays the GDN runtime."""
    from holographic.io_and_interop.holographic_gdnruntime import config_from_json
    cfg = config_from_json({
        "model_type": "qwen3_next",
        "architectures": ["Qwen3NextForCausalLM"],
        "hidden_size": 128,
        "num_hidden_layers": 4,
        "num_attention_heads": 4,
        "head_dim": 32,
        "num_experts": 0,
    })
    assert cfg["hidden"] == 128
    assert cfg["n_layers"] == 4


def test_unified_mind_faculty_does_not_take_a_gdn_runtime(tmp_path):
    from holographic.misc.holographic_unified import UnifiedMind
    mind = UnifiedMind(dim=64, seed=0)
    assert callable(mind.unicron_install_deepseek_v4)
    cfg = D.fake_deepseek_v4_config()
    w = D.fake_deepseek_v4_weights()
    _w, _c, rep = mind.unicron_install_deepseek_v4(
        w, cfg, passages=["the capital of France is Paris"],
        n_registers=4, seed=0, out_dir=str(tmp_path / "m"), hrr_dim=64)
    assert "registers" in rep["installed"]
    assert "router" not in rep["installed"]


def test_qwen_config_is_refused_by_deepseek_install():
    w = D.fake_deepseek_v4_weights()
    with pytest.raises(ValueError, match="Qwen stays"):
        D.install(w, _qwen_cfg(), passages=["x"], n_registers=4)


def test_config_from_json_refuses_deepseek_before_qwen_parse(tmp_path):
    from holographic.io_and_interop.holographic_gdnruntime import config_from_json
    p = tmp_path / "config.json"
    p.write_text(json.dumps(D.fake_deepseek_v4_config()))
    with pytest.raises(D.QwenGDNRefused, match="install_deepseek_v4"):
        config_from_json(str(p))


def test_load_runtime_refuses_deepseek_before_opening_shards(tmp_path, monkeypatch):
    from holographic.io_and_interop import holographic_gdnruntime as G
    (tmp_path / "config.json").write_text(json.dumps(D.fake_deepseek_v4_config()))
    (tmp_path / "model.safetensors").write_bytes(b"not-a-real-shard")

    def _boom(*_a, **_k):
        raise AssertionError("must not load Flash shards into GDNRuntime")

    monkeypatch.setattr(G, "load_weight_files", _boom)
    with pytest.raises(D.QwenGDNRefused, match="install_deepseek_v4"):
        G.load_runtime(str(tmp_path))


def test_cli_writes_sidecar_and_does_not_touch_qwen_install(tmp_path):
    model = tmp_path / "flash"
    model.mkdir()
    (model / "config.json").write_text(json.dumps(D.fake_deepseek_v4_config()))
    out = tmp_path / "out"
    import importlib.util
    cli = os.path.join(os.path.dirname(__file__), "..",
                       "assimilation/install_deepseek_v4.py")
    spec = importlib.util.spec_from_file_location("install_deepseek_v4", cli)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.main([str(model), str(out), "--registers", "4",
                     "--hrr-dim", "64"]) == 0
    card = json.loads((out / "lecore.json").read_text())
    assert card["installed"]
    assert "registers" in card["installed"]
    idx = D.load_sidecar(str(out / "lecore_hrr.npz"))
    hits = D.search_index(idx, "capital of France", k=1)
    assert hits and "paris" in hits[0][2].lower()
    sh = open(os.path.join(os.path.dirname(__file__), "..",
                           "assimilation/install.sh"), encoding="utf-8").read()
    assert "assimilation/install.py" in sh
    assert "install_deepseek_v4" not in sh


def test_qwen_install_script_refuses_deepseek_dir(tmp_path):
    """assimilation/install.py must not call load_runtime on a Flash card."""
    model = tmp_path / "flash"
    model.mkdir()
    (model / "config.json").write_text(json.dumps(D.fake_deepseek_v4_config()))
    cfg = D.detect_from_dir(str(model))
    assert cfg is not None
    with pytest.raises(D.QwenGDNRefused, match="install_deepseek_v4"):
        D.refuse_qwen_gdn(str(model), cfg)
    src = open(os.path.join(os.path.dirname(__file__), "..",
                            "assimilation/install.py"), encoding="utf-8").read()
    assert "detect_from_dir" in src
    assert "refuse_message" in src
    assert "load_runtime(a.model_dir)" in src


def test_official_fp4_lut_and_one_shard_smoke(tmp_path):
    packed = np.full((2, 16), 0x21, dtype=np.int8)
    scale = np.ones((2, 1), np.float32)
    got = D.dequant_fp4(packed, scale)
    assert got.shape == (2, 32)
    assert np.allclose(got[0, :2], [0.5, 1.0])
    shard = tmp_path / "toy.safetensors"
    D.write_flash_toy_shard(str(shard))
    from holographic.io_and_interop.holographic_unicron import load_safetensors_one
    e4 = load_safetensors_one(str(shard), "attn.q_proj.weight")
    assert e4.shape == (4, 4) and np.allclose(e4, 1.0)
    e8 = load_safetensors_one(str(shard), "attn.q_proj.scale")
    assert float(e8.reshape(-1)[0]) == 1.0
    smoke = D.smoke_one_shard(str(shard))
    assert smoke["dequant"]["finite"]
    assert "F8_E4M3" in smoke["dtypes"] and "I8" in smoke["dtypes"]

