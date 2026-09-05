"""Tests for the MCP door bridge on the standalone service: GET /doors + POST /door run holographic_mcp's curated
tools IN-PROCESS over the service's own mind, so an HTTP client (the openzoo gateway) reaches every door without
spawning a stdio MCP host.

WHY THESE PINS: the gateway audit found only /tools + /invoke consumed -- 35 of the 40 doors were unreachable over
HTTP. The bridge is only worth having if (1) the listing IS the adapter's tool list, (2) a door round-trips with the
same content/_meta an MCP host would see, (3) the adapter wraps THIS service's mind (no second 4.6 s mind), (4) the
token gate covers it exactly like /invoke, (5) tenant_id -- the gateway's word -- is stripped and partitions, and
(6) an unknown door is a 404 that never builds the adapter. A real HTTPServer on port 0, like
test_holographic_service, because the token gate and the JSON framing only exist on the socket path."""
import json
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer

import pytest

from holographic_service import Service, make_handler


def _run_server(svc):
    httpd = HTTPServer(("127.0.0.1", 0), make_handler(svc))
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


def _call(port, method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _door(port, tok, name, arguments=None, **extra):
    body = {"name": name, "arguments": arguments if arguments is not None else {}}
    body.update(extra)
    return _call(port, "POST", "/door", body, token=tok)


def _text(body):
    """The first text block of a flattened door reply, parsed -- what an MCP host's model reads."""
    return json.loads(body["content"][0]["text"])


@pytest.fixture
def server(tmp_path):
    """A token-gated service whose door partition lives under tmp_path, so no test writes ./lecore_memory."""
    svc = Service(token="secret", memory_root=str(tmp_path / "mem"))
    httpd, port = _run_server(svc)
    try:
        yield svc, port, "secret"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_doors_listing_gate_and_unknown_door(server):
    svc, port, tok = server
    # the token gate covers the doors exactly as it covers /invoke: no token, wrong token -> 401
    assert _call(port, "GET", "/doors")[0] == 401
    assert _door(port, None, "lecore_map")[0] == 401
    assert _door(port, "wrong", "lecore_map")[0] == 401
    # the listing IS holographic_mcp's curated tool list -- same names, in the adapter's order
    from holographic_mcp import _TOOLS
    status, body = _call(port, "GET", "/doors", token=tok)
    assert status == 200 and body["ok"]
    assert [d["name"] for d in body["doors"]] == [t["name"] for t in _TOOLS]
    assert body["count"] == len(_TOOLS) == 40
    assert all(d["description"] and isinstance(d["inputSchema"], dict) for d in body["doors"])
    # an unknown door is a 404 {error} -- and it never built the adapter (nor the mind)
    status, body = _door(port, tok, "no_such_door")
    assert status == 404 and body["ok"] is False and "no_such_door" in body["error"]
    assert svc._doors == {} and svc._mind is None
    # malformed bodies are 400s, not 500s
    assert _call(port, "POST", "/door", {"arguments": {}}, token=tok)[0] == 400
    assert _door(port, tok, "lecore_map", [])[0] == 400
    assert _door(port, tok, "")[0] == 400
    # the index advertises both routes
    idx = _call(port, "GET", "/", token=tok)[1]["endpoints"]
    assert "GET /doors" in idx and "POST /door" in idx


def test_door_round_trip_map_corpus_receipt_and_tenant(server):
    svc, port, tok = server
    # lecore_map: the flattened MCP result -- content blocks, isError, and the adapter's own _meta
    status, body = _door(port, tok, "lecore_map")
    assert status == 200 and body["ok"] is True and body["name"] == "lecore_map" and body["isError"] is False
    assert body["content"][0]["type"] == "text"
    mp = _text(body)
    assert mp["total_capabilities"] > 1000 and "families" in mp
    cost, receipt = body["_meta"]["lecore.cost"], body["_meta"]["lecore.receipt"]
    assert cost["elapsed_ms"] >= 0 and cost["payload_bytes"] > 0
    assert set(receipt) == {"input_sha256", "output_sha256", "deterministic"} and receipt["deterministic"] is True
    # THE SAME MIND: the adapter wraps this service, it does not hide a second one behind it
    adapter = svc.door_adapter()
    assert adapter.service is svc and adapter.service.mind is svc.mind
    assert svc.door_adapter() is adapter                                   # built once, reused

    # corpus_bind + corpus_ask(gate='dispatch'): the payment-gate verdict shape the gateway acts on
    chunks = ["alpha chunk about wallets", "beta chunk about rails", "gamma chunk about fur"]
    status, bound = _door(port, tok, "corpus_bind", {"texts": chunks})
    assert status == 200 and bound["ok"]
    handle = _text(bound)["handle"]
    status, hit = _door(port, tok, "corpus_ask", {"handle": handle, "query": "rails", "gate": "dispatch"})
    assert status == 200 and hit["ok"]
    verdict = _text(hit)
    assert verdict["answerable"] is True and verdict["stage"] and isinstance(verdict["margin"], float)
    assert verdict["via"] == "dispatch" and verdict["chunks"][0]["chunk"] == chunks[1]
    status, miss = _door(port, tok, "corpus_ask",
                         {"handle": handle, "query": "quantum entanglement bandwidth", "gate": "dispatch"})
    v2 = _text(miss)
    assert v2["answerable"] is False and v2["stage"] == "abstain" and "margin" in v2
    # the gateless path stays the classic BM25 row list (never-flip), through the door too
    classic = _text(_door(port, tok, "corpus_ask", {"handle": handle, "query": "rails"})[1])
    assert isinstance(classic, list) and "beta" in classic[0]["chunk"]

    # receipt_verify on a receipt from a PREVIOUS door call: determinism is the proof system
    status, ver = _door(port, tok, "receipt_verify", {"name": "lecore_map", "arguments": {}, "receipt": receipt})
    assert status == 200 and _text(ver)["match"] is True
    forged = dict(receipt, output_sha256="0" * 64)
    assert _text(_door(port, tok, "receipt_verify",
                       {"name": "lecore_map", "arguments": {}, "receipt": forged})[1])["match"] is False

    # tenant_id INSIDE arguments (the gateway's convention, like /internal/v1/memory/*) is stripped -- before
    # this it reached corpus_bind as an unexpected keyword -- and selects a separate partition
    status, tb = _door(port, tok, "corpus_bind", {"texts": ["tenant only text"], "tenant_id": "zoo_abc"})
    assert status == 200 and tb["ok"] and tb["isError"] is False, tb
    t_handle = _text(tb)["handle"]
    tenant_adapter = svc.door_adapter("zoo_abc")
    assert tenant_adapter is not adapter and tenant_adapter.service is svc      # own partition, same mind
    assert t_handle in tenant_adapter._corpora and t_handle not in adapter._corpora
    assert tenant_adapter._memory_root != adapter._memory_root
    assert tenant_adapter._memory_root.startswith(str(svc._memory_root))
    # ...and the default partition cannot see the tenant's handle (isolation is observable, not assumed)
    unseen = _text(_door(port, tok, "corpus_ask", {"handle": t_handle, "query": "tenant"})[1])
    assert "unknown handle" in unseen["error"]
    # top-level tenant_id is the same thing
    status, tb2 = _door(port, tok, "corpus_ask", {"handle": t_handle, "query": "tenant"}, tenant_id="zoo_abc")
    assert status == 200 and _text(tb2)[0]["chunk"] == "tenant only text"

    # the isError path carries cost too: a metered lane must never see a priced call without a price
    status, err = _door(port, tok, "void_explore", {})                 # KeyError 'handle' inside the adapter
    assert status == 200 and err["ok"] is False and err["isError"] is True
    assert "handle" in _text(err).get("hint", "") or "handle" in _text(err)["error"]
    assert err["_meta"]["lecore.cost"]["payload_bytes"] > 0 and err["_meta"]["lecore.cost"]["elapsed_ms"] >= 0
    assert "lecore.receipt" not in err["_meta"]                          # an error is not a computed claim


def test_invoke_is_untouched_and_door_dispatch_level(tmp_path):
    """Belt and braces at the dispatch seam (no socket): /invoke keeps its exact shape, and the door handler's
    status mapping (404 unknown, 400 malformed) holds without the HTTP layer."""
    svc = Service(memory_root=str(tmp_path / "mem"))
    status, body = svc.dispatch("POST", "/invoke", {"name": "affected_tests", "args": {"changed_paths": ["README.md"]}})
    assert status == 200 and body == {"ok": True, "name": "affected_tests", "result": []}
    assert svc.dispatch("POST", "/invoke", {"name": "_private", "args": {}}) == (200, {"ok": False, "error": "invalid or private tool name: '_private'"})
    assert svc.dispatch("POST", "/door", {"name": "nope", "arguments": {}})[0] == 404
    assert svc.dispatch("POST", "/door", {})[0] == 400
    status, body = svc.dispatch("POST", "/door", {"name": "lecore_find", "arguments": {"query": "bind two vectors"}})
    assert status == 200 and body["ok"] and body["isError"] is False
    assert "bind" in body["content"][0]["text"].lower()
    assert body["_meta"]["lecore.cost"]["payload_bytes"] == len(body["content"][0]["text"])
