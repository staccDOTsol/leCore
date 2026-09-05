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
                "assimilation/install_deepseek_v4.py",
                "assimilation/flash_hrr.py"):
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
    orig = np.array(w["model.embed_tokens.weight"], copy=True)
    w2, cfg2, rep = D.install_deepseek_v4(
        w, cfg, passages=passages, n_registers=8, seed=0,
        out_dir=str(out), hrr_dim=64, model_dir=str(tmp_path))
    # in-weight rewrite of unused/tail embed rows; original dict not mutated
    assert w2 is not w
    assert np.array_equal(w["model.embed_tokens.weight"], orig)
    assert not np.array_equal(w2["model.embed_tokens.weight"], orig)
    assert "registers" in rep["installed"]
    assert "memory_index" in rep["installed"]
    assert "passages" in rep["installed"]
    assert "router" not in rep["installed"]
    assert rep["router"]["ok"] is False
    assert "GDNRuntime" in rep["router"]["reason"]
    assert rep["registers"]["ok"] is True
    assert int(rep["in_weight"]) == 1
    assert int(rep["memory_index"]["in_weight"]) == 1
    assert (out / "lecore.json").is_file()
    card = json.loads((out / "lecore.json").read_text())
    assert card["format"] == D.FORMAT
    assert card["family"] == "deepseek_v4"
    assert int(card["in_weight"]) == 1
    assert "router" in [s["step"] for s in card["skipped"]]
    assert (out / "lecore_hrr.npz").is_file()
    assert (out / "lecore_in_weight.safetensors").is_file()


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
    sess = mind.unicron_flash_hrr(str(tmp_path / "m"))
    attached, info = sess.attach({
        "messages": [{"role": "user", "content": "capital of France?"}]})
    assert info["attached"] and "paris" in attached["messages"][0]["content"].lower()


def test_qwen_config_is_refused_by_deepseek_install():
    w = D.fake_deepseek_v4_weights()
    with pytest.raises(ValueError, match="Qwen stays"):
        D.install_deepseek_v4(w, _qwen_cfg(), passages=["x"], n_registers=4)


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
    idx = D.load_hrr_sidecar(str(out / "lecore_hrr.npz"))
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


def _tiny_sidecar(tmp_path, passages=None, n_registers=8, hrr_dim=64):
    cfg = D.fake_deepseek_v4_config(hidden=32, vocab=48, n_layers=2)
    w = D.fake_deepseek_v4_weights(hidden=32, vocab=48, n_layers=2)
    texts = list(passages or [
        "the capital of France is Paris",
        "water freezes at zero degrees celsius",
        "DeepSeek-V4 Flash is not Gated DeltaNet",
    ])
    model = tmp_path / "flash"
    model.mkdir()
    (model / "config.json").write_text(json.dumps(cfg))
    out = tmp_path / "out"
    D.install_deepseek_v4(w, cfg, passages=texts, n_registers=n_registers, seed=0,
              out_dir=str(out), hrr_dim=hrr_dim, model_dir=str(model))
    return out


def test_flash_hrr_loads_tiny_sidecar_and_recalls(tmp_path):
    out = _tiny_sidecar(tmp_path)
    sess = D.FlashHRR.open(str(out))
    hits = sess.recall("capital of France", k=1)
    assert hits and "paris" in hits[0][2].lower()
    keys = sess.register_keys()
    assert keys is not None and keys.shape[0] == 8
    st = sess.status()
    assert int(st["in_weight"]) == 1
    assert st["inject_max"] == 1024
    assert st["passages"] == 3


def test_gateway_system_inject_is_capped_at_1024():
    huge = D.build_system_inject(
        [(0, 0.9, "alpha " * 400), (1, 0.8, "beta " * 400)],
        max_chars=D.GATEWAY_INJECT_MAX)
    assert huge.startswith(D.GATEWAY_INJECT_HEADER)
    assert len(huge) <= 1024
    assert D.build_system_inject([]) == ""


def test_attach_puts_recalled_memory_into_a_real_generation_request(tmp_path):
    """Flash-as-HRR: the body a vLLM OpenAI server would generate from
    contains sidecar memory. HRR ran before tokens. lecore.json in_weight=1
    because install wrote placeholder/tail embed rows."""
    out = _tiny_sidecar(tmp_path)
    sess = D.open_session(str(out))
    req = {
        "model": "deepseek-ai/DeepSeek-V4-Flash",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is the capital of France?"},
        ],
        "max_tokens": 32,
        "temperature": 0,
        "stream": False,
    }
    attached, info = sess.attach(req)
    assert info["attached"] is True
    assert int(info["in_weight"]) == 1
    assert info["inject_chars"] <= 1024
    assert attached is not req
    assert req["messages"][0]["content"] == "You are a helpful assistant."
    sys_msg = attached["messages"][0]
    assert sys_msg["role"] == "system"
    assert sys_msg["content"].startswith(D.GATEWAY_INJECT_HEADER)
    assert "paris" in sys_msg["content"].lower()
    assert len(sys_msg["content"]) <= 1024
    assert attached["messages"][-1]["content"] == "What is the capital of France?"
    assert attached["messages"][1]["content"] == "You are a helpful assistant."
    assert attached["model"] == req["model"]
    assert attached["max_tokens"] == 32
    assert attached["temperature"] == 0
    # serve hook is the same mutation
    hooked = sess.before_generate(req)
    assert hooked["messages"][0]["content"] == sys_msg["content"]
    # idempotent -- do not stack injects
    again, _ = sess.attach(attached)
    n_hrr = sum(1 for m in again["messages"]
                if D._is_hrr_inject_message(m))
    assert n_hrr == 1


def test_attach_completions_prompt_gets_the_same_inject(tmp_path):
    out = _tiny_sidecar(tmp_path)
    sess = D.FlashHRR.open(str(out))
    req = {"model": "deepseek-v4-flash",
           "prompt": "What is the capital of France?",
           "max_tokens": 16}
    attached, info = sess.attach(req)
    assert info["attached"]
    assert attached["prompt"].startswith(D.GATEWAY_INJECT_HEADER)
    assert "paris" in attached["prompt"].lower()
    assert "What is the capital of France?" in attached["prompt"]


def test_forward_posts_attached_body_to_openai_upstream(tmp_path):
    """A fake vLLM records the body it received -- memory must already be in it."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    out = _tiny_sidecar(tmp_path)
    sess = D.FlashHRR.open(str(out))
    captured = {}

    class FakeVLLM(BaseHTTPRequestHandler):
        def log_message(self, *_a, **_k):
            return

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            captured["path"] = self.path
            captured["body"] = json.loads(self.rfile.read(n).decode("utf-8"))
            payload = json.dumps({
                "id": "fake", "object": "chat.completion",
                "choices": [{"index": 0, "message": {
                    "role": "assistant", "content": "Paris."},
                             "finish_reason": "stop"}],
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    httpd = HTTPServer(("127.0.0.1", 0), FakeVLLM)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        resp, info, attached = sess.forward(
            {"model": "deepseek-v4-flash",
             "messages": [{"role": "user",
                           "content": "What is the capital of France?"}],
             "max_tokens": 8},
            "http://127.0.0.1:%d" % port)
    finally:
        httpd.shutdown()
    assert captured["path"] == "/v1/chat/completions"
    got = captured["body"]
    assert got["messages"][0]["role"] == "system"
    assert "paris" in got["messages"][0]["content"].lower()
    assert len(got["messages"][0]["content"]) <= 1024
    assert got == attached
    assert info["attached"]
    assert resp["choices"][0]["message"]["content"] == "Paris."


def test_cli_recall_and_attach_on_tiny_sidecar(tmp_path, capsys):
    out = _tiny_sidecar(tmp_path)
    assert D._cli(["recall", str(out), "capital of France", "-k", "1"]) == 0
    printed = capsys.readouterr().out.lower()
    assert "paris" in printed
    assert D._cli(["attach", str(out), "what is the capital of France?"]) == 0
    blob = capsys.readouterr().out
    payload = json.loads(blob)
    assert payload["info"]["attached"]
    assert "paris" in payload["body"]["messages"][0]["content"].lower()
    assert len(payload["body"]["messages"][0]["content"]) <= 1024


def test_flash_hrr_cli_script_attach(tmp_path):
    out = _tiny_sidecar(tmp_path)
    import importlib.util
    cli = os.path.join(os.path.dirname(__file__), "..",
                       "assimilation/flash_hrr.py")
    spec = importlib.util.spec_from_file_location("flash_hrr", cli)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # main prints JSON; capture via returning 0 and reading sidecar attach
    rc = mod.main(["attach", str(out), "capital of France", "-k", "1"])
    assert rc == 0


def test_in_weight_is_one_and_embed_rows_change(tmp_path):
    cfg = D.fake_deepseek_v4_config(hidden=32, vocab=48)
    w = D.fake_deepseek_v4_weights(hidden=32, vocab=48)
    orig = np.array(w["model.embed_tokens.weight"], copy=True)
    out = tmp_path / "iw"
    w2, _c, rep = D.install_deepseek_v4(
        w, cfg,
        passages=["the capital of France is Paris", "water freezes at zero"],
        n_registers=4, seed=0, out_dir=str(out), hrr_dim=64)
    assert int(rep["in_weight"]) == 1
    assert int(rep["memory_index"]["in_weight"]) == 1
    assert int(rep["registers"]["in_weight"]) == 1
    assert len(rep["memory_index"]["rows"]) >= 2
    assert not np.array_equal(w2["model.embed_tokens.weight"], orig)
    card = json.loads((out / "lecore.json").read_text())
    assert int(card["in_weight"]) == 1
    assert (out / "lecore_in_weight.safetensors").is_file()
    skipped = {s["step"]: s["reason"] for s in card["skipped"]}
    assert "router" in skipped
    assert "hrnn_ladder" in skipped
    assert "prepend" in skipped
    assert "GDNRuntime" in skipped["router"] or "Flash" in skipped["router"]


def test_f8_e8m0fnu_alias_round_trips():
    from holographic.io_and_interop.holographic_unicron import (
        save_safetensors, load_safetensors, _decode_st_payload)
    import tempfile
    raw = bytes([127, 128])
    arr = _decode_st_payload("F8_E8M0FNU", raw, (2,))
    assert float(arr[0]) == 1.0 and float(arr[1]) == 2.0
    td = tempfile.mkdtemp()
    p = os.path.join(td, "fnu.safetensors")
    save_safetensors(p, {"s": np.array([1.0, 2.0], np.float32)},
                     dtypes={"s": "F8_E8M0FNU"})
    back, dts = load_safetensors(p, return_dtypes=True)
    assert dts["s"] == "F8_E8M0FNU"
    assert float(back["s"][0]) == 1.0



