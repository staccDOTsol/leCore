"""flash_hrr.py -- Flash-as-HRR: consume a sidecar, inject before generate.

    python assimilation/flash_hrr.py recall OUT_DIR "capital of France"
    python assimilation/flash_hrr.py attach OUT_DIR "what is the capital of France"
    python assimilation/flash_hrr.py serve  OUT_DIR --upstream http://127.0.0.1:8000

Loads install OUT_DIR (lecore.json + lecore_hrr.npz). Recalls from the sidecar,
builds a Gateway-shaped system inject (<=1024 chars), and attaches it to an
OpenAI chat/completions body BEFORE tokens. Lab generate backend is vLLM's
OpenAI server (or any /v1/chat/completions). GDNRuntime is not called.
48 shards are not loaded. In-weight faculties live in the patched embed
shard from install (`lecore.json` in_weight=1); this CLI attaches sidecar
recall onto the request. GDNRuntime is not called.

Inject-before-generate point:
    client  ->  this process (FlashHRR.attach)  ->  vLLM :8000
"""

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)


def _session(out_dir):
    from holographic.io_and_interop.holographic_deepseek_v4 import FlashHRR
    return FlashHRR.open(out_dir)


def _cmd_recall(a):
    sess = _session(a.out_dir)
    hits = sess.recall(a.query, k=int(a.k))
    if a.json:
        print(json.dumps([{"index": i, "score": s, "passage": t}
                          for i, s, t in hits], indent=2))
        return 0
    if not hits:
        print("(no passages)")
        return 0
    for rank, (i, s, t) in enumerate(hits, 1):
        print("%d  %.3f  %s" % (rank, s, t))
    return 0


def _load_body(a):
    if a.body_file:
        with open(a.body_file, encoding="utf-8") as f:
            return json.load(f)
    if a.body:
        return json.loads(a.body)
    if a.messages:
        return {"model": a.model, "messages": json.loads(a.messages),
                "max_tokens": int(a.max_tokens)}
    q = a.query or ""
    if not q:
        raise SystemExit("attach/forward needs QUERY or --messages or --body")
    return {"model": a.model,
            "messages": [{"role": "user", "content": q}],
            "max_tokens": int(a.max_tokens),
            "temperature": 0}


def _cmd_attach(a):
    sess = _session(a.out_dir)
    body = _load_body(a)
    override = None
    if a.body or a.body_file or a.messages:
        override = a.query or None
    attached, info = sess.attach(body, k=int(a.k), query=override)
    print(json.dumps({"body": attached, "info": info}, indent=2))
    return 0


def _cmd_status(a):
    print(json.dumps(_session(a.out_dir).status(), indent=2))
    return 0


def _cmd_registers(a):
    sess = _session(a.out_dir)
    keys = sess.register_keys()
    st = sess.status()
    print(json.dumps({
        "count": st["registers"], "dim": st["hrr_dim"], "seed": st["seed"],
        "in_weight": int(st.get("in_weight") or 0),
        "shape": None if keys is None else list(keys.shape),
    }, indent=2))
    return 0


def _cmd_forward(a):
    sess = _session(a.out_dir)
    body = _load_body(a)
    override = None
    if a.body or a.body_file or a.messages:
        override = a.query or None
    resp, info, attached = sess.forward(
        body, a.upstream, k=int(a.k), query=override)
    print(json.dumps({"response": resp, "info": info, "body": attached},
                     indent=2))
    return 0


def _cmd_serve(a):
    """HRR-before-tokens proxy in front of vLLM (or any OpenAI upstream)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import urllib.error
    import urllib.request

    from holographic.io_and_interop.holographic_deepseek_v4 import FlashHRR

    sess = FlashHRR.open(a.out_dir)
    upstream = a.upstream.rstrip("/")
    k = int(a.k)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            sys.stderr.write("[flash-hrr] " + (fmt % args) + "\n")

        def _send(self, code, payload, content_type="application/json"):
            raw = payload if isinstance(payload, bytes) else (
                json.dumps(payload).encode("utf-8"))
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/health", "/v1/hrr"):
                self._send(200, {"ok": True, "hrr": sess.status(),
                                 "upstream": upstream})
                return
            self._proxy(self.path, b"", self.headers)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            path = self.path.split("?", 1)[0]
            if path.rstrip("/").endswith("/chat/completions") \
                    or path.rstrip("/").endswith("/completions"):
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    self._send(400, {"error": "request body is not JSON"})
                    return
                attached, info = sess.attach(body, k=k)
                raw = json.dumps(attached).encode("utf-8")
                self.log_message("HRR attached=%s chars=%d hits=%d %s",
                                 info["attached"], info["inject_chars"],
                                 len(info["hits"]), path)
            self._proxy(self.path, raw, self.headers)

        def _proxy(self, path, raw, headers):
            url = upstream + path
            hdrs = {}
            for key in ("Authorization", "Content-Type", "Accept"):
                val = headers.get(key)
                if val:
                    hdrs[key] = val
            if raw and "Content-Type" not in hdrs:
                hdrs["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=(raw or None),
                                         headers=hdrs, method=self.command)
            try:
                with urllib.request.urlopen(req, timeout=int(a.timeout)) as resp:
                    out = resp.read()
                    self.send_response(resp.status)
                    for hk, hv in resp.headers.items():
                        if hk.lower() in ("transfer-encoding", "connection",
                                          "content-encoding"):
                            continue
                        self.send_header(hk, hv)
                    if "Content-Length" not in {k.title() for k in resp.headers}:
                        self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
            except urllib.error.HTTPError as exc:
                err = exc.read()
                self.send_response(exc.code)
                self.send_header("Content-Type",
                                 exc.headers.get("Content-Type",
                                                 "application/json"))
                self.send_header("Content-Length", str(len(err)))
                self.end_headers()
                self.wfile.write(err)
            except Exception as exc:
                self._send(502, {"error": "upstream %s: %s: %s"
                                 % (url, type(exc).__name__, exc)})

    httpd = ThreadingHTTPServer((a.host, int(a.port)), Handler)
    print("[flash-hrr] sidecar %s" % os.path.abspath(a.out_dir), flush=True)
    print("[flash-hrr] inject-before-generate on :%d -> %s"
          % (int(a.port), upstream), flush=True)
    print("[flash-hrr] GDNRuntime is not called; 48 shards are not loaded",
          flush=True)
    httpd.serve_forever()


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Flash-as-HRR: sidecar recall + Gateway inject before "
                    "generate (no GDNRuntime)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def _out(p):
        p.add_argument("out_dir", help="install OUT_DIR with lecore_hrr.npz")

    p = sub.add_parser("recall", help="ranked passages")
    _out(p)
    p.add_argument("query")
    p.add_argument("-k", type=int, default=3)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("attach",
                       help="print the OpenAI body vLLM should see")
    _out(p)
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--messages", default="")
    p.add_argument("--body", default="")
    p.add_argument("--body-file", default="")
    p.add_argument("--model", default="deepseek-v4-flash")
    p.add_argument("--max-tokens", type=int, default=32)
    p.add_argument("-k", type=int, default=3)

    p = sub.add_parser("forward",
                       help="attach then POST to --upstream (one shot)")
    _out(p)
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--upstream", required=True)
    p.add_argument("--messages", default="")
    p.add_argument("--body", default="")
    p.add_argument("--body-file", default="")
    p.add_argument("--model", default="deepseek-v4-flash")
    p.add_argument("--max-tokens", type=int, default=32)
    p.add_argument("-k", type=int, default=3)

    p = sub.add_parser("status")
    _out(p)
    p = sub.add_parser("registers")
    _out(p)

    p = sub.add_parser("serve",
                       help="proxy: HRR attach then vLLM OpenAI server")
    _out(p)
    p.add_argument("--upstream", default="http://127.0.0.1:8000",
                   help="vLLM OpenAI base (default http://127.0.0.1:8000)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("-k", type=int, default=3)
    p.add_argument("--timeout", type=int, default=120)

    a = ap.parse_args(argv)
    if a.cmd == "recall":
        return _cmd_recall(a)
    if a.cmd == "attach":
        return _cmd_attach(a)
    if a.cmd == "forward":
        return _cmd_forward(a)
    if a.cmd == "status":
        return _cmd_status(a)
    if a.cmd == "registers":
        return _cmd_registers(a)
    if a.cmd == "serve":
        return _cmd_serve(a)
    raise SystemExit("unknown command")


if __name__ == "__main__":
    sys.exit(main())
