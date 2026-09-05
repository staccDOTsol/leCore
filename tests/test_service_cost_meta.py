"""The HTTP doors an x402 proxy meters (GET /tools, POST /invoke) carry the SAME `_meta` the MCP adapter stamps
on every tools/call -- {"lecore.cost": {elapsed_ms, payload_bytes}, "lecore.receipt": {input_sha256,
output_sha256, deterministic}} -- and NOTHING ELSE about the payload changes.

WHY EACH PIN EXISTS: the gateway (x402-tokens src/lecore.ts lecoreCall) bills these two numbers and echoes the
receipt; a proxy that meters a number the door does not send bills fiction. The byte-identity pins protect the
in-process callers: the MCP adapter receipts dispatch("POST", "/invoke")'s RESULT, so a wall-clock elapsed_ms
leaking into that text would make its own output_sha256 unreproducible -- the stamp must live on the wire only.
Same in-process pattern as tests/test_holographic_service.py (HTTPServer + make_handler on a free port)."""
import hashlib
import json
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer

from holographic_service import Service, make_handler, cost_meta, _json_default

INVOKE = {"name": "version", "args": {}}      # cheap (measured 0.07 s) + deterministic; affected_tests was 16 s/call


def _run_server(svc):
    httpd = HTTPServer(("127.0.0.1", 0), make_handler(svc))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, httpd.server_address[1]


def _call(port, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _canon(tool, arguments):
    return json.dumps({"tool": tool, "arguments": arguments}, sort_keys=True, separators=(",", ":"), default=str)


def _assert_meta_shape(meta):
    assert set(meta) == {"lecore.cost", "lecore.receipt"}
    cost, rcpt = meta["lecore.cost"], meta["lecore.receipt"]
    assert set(cost) == {"elapsed_ms", "payload_bytes"}
    assert cost["elapsed_ms"] >= 0 and cost["payload_bytes"] > 0
    assert set(rcpt) == {"input_sha256", "output_sha256", "deterministic"}      # the MCP selftest's exact pin
    assert rcpt["deterministic"] is True and len(rcpt["output_sha256"]) == 64 and len(rcpt["input_sha256"]) == 64


def test_invoke_and_tools_carry_meta_and_nothing_else_changes():
    svc = Service()
    httpd, port = _run_server(svc)
    try:
        for method, path, body in (("POST", "/invoke", INVOKE), ("GET", "/tools", None)):
            status, raw = _call(port, method, path, body)
            assert status == 200
            wire = json.loads(raw)
            _assert_meta_shape(wire["_meta"])
            meta = wire.pop("_meta")
            # BYTE-IDENTICAL minus the one key: what the in-process dispatch returns is what the wire says.
            in_proc = svc.dispatch(method, path, body if body is not None else {})[1]
            assert "_meta" not in in_proc                   # the stamp is wire-only (MCP receipts depend on it)
            text = json.dumps(in_proc, default=_json_default)
            assert json.dumps(wire, default=_json_default) == text
            # payload_bytes is the response the caller received, BEFORE _meta -- and ensure_ascii JSON means
            # chars == UTF-8 bytes, so a proxy billing bytes bills exactly what crossed the wire.
            assert meta["lecore.cost"]["payload_bytes"] == len(text) == len(text.encode())
            # the receipt is recomputable by anyone holding the request and the response
            assert meta["lecore.receipt"]["output_sha256"] == hashlib.sha256(text.encode()).hexdigest()
            assert meta["lecore.receipt"]["input_sha256"] == \
                hashlib.sha256(_canon(path, body if body is not None else {}).encode()).hexdigest()
    finally:
        httpd.shutdown(); httpd.server_close()


def test_receipt_reproduces_across_calls_and_distinguishes_inputs():
    """'Don't trust, re-run': the same request twice yields the same output_sha256 (elapsed_ms may differ and
    lives outside the receipt); a different request yields a different input_sha256."""
    svc = Service()
    httpd, port = _run_server(svc)
    try:
        a = json.loads(_call(port, "POST", "/invoke", INVOKE)[1])["_meta"]
        b = json.loads(_call(port, "POST", "/invoke", INVOKE)[1])["_meta"]
        assert a["lecore.receipt"] == b["lecore.receipt"]
        other = {"name": "no_such_faculty_xyz", "args": {}}          # an in-band error is still a stamped 200
        c = json.loads(_call(port, "POST", "/invoke", other)[1])["_meta"]
        assert c["lecore.receipt"]["input_sha256"] != a["lecore.receipt"]["input_sha256"]
    finally:
        httpd.shutdown(); httpd.server_close()


def test_in_band_errors_are_metered_but_unmetered_routes_and_404s_are_not():
    svc = Service()
    httpd, port = _run_server(svc)
    try:
        # an in-band {ok: False, error} at 200 is still a computed answer (MCP stamps these too)
        status, raw = _call(port, "POST", "/invoke", {"name": "no_such_faculty_xyz", "args": {}})
        body = json.loads(raw)
        assert status == 200 and body["ok"] is False and "_meta" in body
        # infrastructure routes stay exactly as they were
        status, raw = _call(port, "GET", "/health")
        assert status == 200 and "_meta" not in json.loads(raw)
        # a route miss is the analog of the MCP's "unknown tool" JSON-RPC error: no result, no receipt
        status, raw = _call(port, "POST", "/tools", {"query": "bind", "top": 3})
        assert status == 404 and "_meta" not in json.loads(raw)
    finally:
        httpd.shutdown(); httpd.server_close()


def test_mcp_adapter_shares_the_helper():
    """One shape on both wires: the MCP adapter must stamp through the very same function, not a copy."""
    import holographic_mcp
    assert holographic_mcp.cost_meta is cost_meta
    import time
    m = cost_meta("lecore_describe", {"name": "bind"}, '{"x": 1}', time.perf_counter())
    _assert_meta_shape(m)
    assert m["lecore.receipt"]["input_sha256"] == hashlib.sha256(_canon("lecore_describe", {"name": "bind"}).encode()).hexdigest()
