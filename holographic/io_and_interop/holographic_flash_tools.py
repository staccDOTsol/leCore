"""FLASH TOOL ROUTES -- the sidecar makes use of EVERY leCore tool, not just recall.

FlashHRR (holographic_deepseek_v4) puts holographic memory in front of a model that
leCore cannot run itself: it ranks passages and injects them as a system message
BEFORE tokens. That is one rung. The engine has ~2,300 more faculties, learned APIs
(api_learn), and taught tool reflexes, and the hosted MCP surface already routes
to them deterministically (tool_find, zoo_tools op=find/call). Nothing carried that
routing to the sidecar: a model served through flash_hrr.py saw the passages and
nothing else.

This module closes that. Three moves, all on the OpenAI wire the sidecar already
speaks, so vLLM / the openzoo gateway / any chat-completions server needs no change:

  1. ROUTE.   `routes(cue)` runs the engine's own deterministic tool routing over
              the request cue -- the capability catalog (find_capability) and the
              contextual toolset (tool_find: learned APIs, engine cards, taught
              tools, memory) -- and returns ranked routes with the CALLABLE faculty
              name where one exists. Zero model tokens.
  2. ADVERTISE. `attach(body)` puts those routes on the request as OpenAI `tools`:
              a schema per routed faculty (real parameter names, introspected from
              the live method, exactly as holographic_galvabundle.capability_tools
              does for bundles) plus the two meta tools the MCP surface uses --
              `lecore_find` (search the whole engine) and `lecore_invoke` (run any
              public faculty). Discovery is a search; execution is one generic
              tool; the routed few are shortcuts. The caller's own tools are kept.
  3. EXECUTE. `resolve(response)` runs the tool calls the model made against the
              mind (mind.invoke: public-only, the same dispatch /invoke and the MCP
              server use) and hands back the `tool` messages; `loop()` drives the
              whole round trip until the model answers without calling a tool.

WHAT IS NOT CLAIMED: the model is still the model. Routing chooses which tools it
SEES; whether it calls them is its decision, and the loop is bounded (max_rounds)
so a model that keeps calling cannot spin. Streaming bodies are not looped (a
tool round trip needs the whole response); attach() still works on them.

stdlib + the mind. No vendor SDK.
"""
import inspect
import json

TOOL_FIND = "lecore_find"
TOOL_INVOKE = "lecore_invoke"
DEFAULT_K = 8
DEFAULT_ROUNDS = 4

_META_TOOLS = [
    {"type": "function",
     "function": {
         "name": TOOL_FIND,
         "description": ("BEFORE implementing any algorithm, math routine, data structure, "
                         "or file format yourself: search leCore's ~2,300 verified faculties, "
                         "learned APIs and taught tools for it. Returns ranked routes; call the "
                         "routed faculty directly if it is advertised, else via lecore_invoke."),
         "parameters": {"type": "object",
                        "properties": {"query": {"type": "string",
                                                 "description": "the task in plain words"},
                                       "k": {"type": "integer",
                                             "description": "how many routes (default %d)" % DEFAULT_K}},
                        "required": ["query"]}}},
    {"type": "function",
     "function": {
         "name": TOOL_INVOKE,
         "description": ("Run any PUBLIC leCore faculty by name (find it with lecore_find). "
                         "args is an object of keyword arguments. Deterministic; the result "
                         "is JSON."),
         "parameters": {"type": "object",
                        "properties": {"name": {"type": "string",
                                                "description": "faculty name exactly as routed"},
                                       "args": {"type": "object",
                                                "description": "keyword arguments"}},
                        "required": ["name"]}}},
]


def meta_tools():
    """The two engine-wide tools every attached request carries: search + generic invoke."""
    return [json.loads(json.dumps(t)) for t in _META_TOOLS]


def faculty_schema(mind, name, description=""):
    """One routed faculty as an OpenAI tool schema with its REAL parameter names.

    Introspected from the live method, so the schema cannot advertise a parameter
    the engine does not take; a faculty that cannot be introspected (C-accelerated,
    a builtin) is advertised with no parameters rather than a made-up blob."""
    fn = getattr(mind, name, None)
    props, required = {}, []
    if callable(fn):
        try:
            for pname, prm in inspect.signature(fn).parameters.items():
                if pname == "self" or prm.kind in (prm.VAR_POSITIONAL, prm.VAR_KEYWORD):
                    continue
                props[pname] = {"type": "string"}
                if prm.default is inspect._empty:
                    required.append(pname)
        except (TypeError, ValueError):
            pass
    return {"type": "function",
            "function": {"name": name,
                         "description": " ".join(str(description or "").split())[:300],
                         "parameters": {"type": "object", "properties": props,
                                        "required": required}}}


def _public_callable(mind, name):
    return (isinstance(name, str) and name and not name.startswith("_")
            and callable(getattr(mind, name, None)))


def _tool_calls_of(response):
    """The tool_calls list on choices[0].message, or []. Tolerates a bare message dict."""
    if not isinstance(response, dict):
        return None, []
    msg = response
    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0] if isinstance(choices[0], dict) else {}
        msg = first.get("message") if isinstance(first.get("message"), dict) else {}
    calls = msg.get("tool_calls") if isinstance(msg, dict) else None
    return msg, [c for c in (calls or []) if isinstance(c, dict)]


class ToolRouter:
    """Deterministic tool routes for a request, advertised as OpenAI tools and executed on the mind.

    `mind` is the tool provider -- the UnifiedMind whose faculties are routed, advertised
    and run. Built lazily when None, so opening a router costs nothing until a cue arrives."""

    def __init__(self, mind=None, k=DEFAULT_K):
        self._mind = mind
        self.k = int(k)

    @property
    def mind(self):
        if self._mind is None:
            from holographic.misc.holographic_unified import UnifiedMind
            self._mind = UnifiedMind()
        return self._mind

    # ---- 1. ROUTE ---------------------------------------------------------------------------
    def routes(self, cue, k=None):
        """Ranked tool routes for `cue`: [{tool, kind, callable, description, score}, ...].

        Two arms, merged and deduplicated, best first:
          catalog  -- find_capability: engine homes whose `.method` is a live public faculty
                      (kind 'faculty', callable) or import-only homes (kind 'home').
          context  -- tool_find: learned APIs (kind 'api'), engine module cards (kind
                      'module'), taught tool facts (kind 'memory'). An 'engine.<method>'
                      card that names a public faculty is promoted to kind 'faculty'.
        Scores are rank-derived within each arm (1.0 best), so the two arms are comparable."""
        k = int(k or self.k)
        cue = " ".join(str(cue or "").split())
        out, seen = [], set()
        if not cue:
            return out

        def _add(tool, kind, desc, score, is_callable):
            if not tool or tool in seen:
                return
            seen.add(tool)
            out.append({"tool": tool, "kind": kind, "callable": bool(is_callable),
                        "description": " ".join(str(desc or "").split())[:200],
                        "score": round(float(score), 4)})

        try:
            caps = list(self.mind.find_capability(cue, k=k))
        except Exception:
            caps = []
        for rank, cap in enumerate(caps):
            meth = getattr(cap, "method", None)
            score = 1.0 - rank / float(max(k, 1))
            if meth and _public_callable(self.mind, meth):
                _add(meth, "faculty", getattr(cap, "does", ""), score, True)
            else:
                _add(getattr(cap, "name", None), "home", getattr(cap, "does", ""), score, False)
        try:
            rows = list(self.mind.tool_find(cue, k=k))
        except Exception:
            rows = []
        for rank, row in enumerate(rows):
            tool = str(row.get("tool") or "")
            score = 0.9 - rank / float(max(k, 1))       # context arm ranks just under catalog
            if tool.startswith("engine."):
                stem = tool[len("engine."):]
                if stem.endswith(".py"):
                    _add(stem, "module", row.get("description"), score, False)
                elif _public_callable(self.mind, stem):
                    _add(stem, "faculty", row.get("description"), score, True)
                else:
                    _add(stem, "home", row.get("description"), score, False)
            elif tool == "memory":
                _add("memory:%d" % rank, "memory", row.get("description"), score, False)
            else:
                _add(tool, "api", row.get("description"), score, False)
        out.sort(key=lambda r: -r["score"])
        return out[:max(k, 2)]

    # ---- 2. ADVERTISE -----------------------------------------------------------------------
    def openai_tools(self, cue=None, k=None, include_meta=True):
        """Tool schemas for a request: the meta pair plus one per callable routed faculty."""
        tools = meta_tools() if include_meta else []
        names = {t["function"]["name"] for t in tools}
        for r in (self.routes(cue, k=k) if cue else []):
            if r["callable"] and r["tool"] not in names:
                names.add(r["tool"])
                tools.append(faculty_schema(self.mind, r["tool"], r["description"]))
        return tools

    def attach(self, body, cue=None, k=None):
        """Advertise the routed tools on an OpenAI chat body. Returns (attached, info).

        The caller's own `tools` are kept and ours are appended (never a duplicate
        function name); `tool_choice` is left alone -- the model decides. A
        /v1/completions body (prompt, no messages) has no tool channel and is returned
        unchanged with info['advertised'] False."""
        if not isinstance(body, dict):
            raise TypeError("attach() wants an OpenAI request dict, got %r"
                            % type(body).__name__)
        from holographic.io_and_interop.holographic_deepseek_v4 import cue_from_openai_body
        cue = (cue if cue is not None else cue_from_openai_body(body)).strip()
        routes = self.routes(cue, k=k) if cue else []
        info = {"cue": cue, "routes": routes, "advertised": False, "tools_added": []}
        attached = dict(body)
        if body.get("messages") is None:
            return attached, info
        existing = [t for t in (body.get("tools") or []) if isinstance(t, dict)]
        names = {((t.get("function") or {}).get("name")) for t in existing}
        added = []
        for t in meta_tools() + [faculty_schema(self.mind, r["tool"], r["description"])
                                 for r in routes if r["callable"]]:
            nm = t["function"]["name"]
            if nm in names:
                continue
            names.add(nm)
            added.append(t)
        attached["tools"] = existing + added
        info["advertised"] = True
        info["tools_added"] = [t["function"]["name"] for t in added]
        return attached, info

    # ---- 3. EXECUTE -------------------------------------------------------------------------
    def execute(self, name, arguments=None):
        """Run one tool call against the mind. Returns {ok, name, result | error}.

        `lecore_find` -> routes; `lecore_invoke` -> mind.invoke(args.name, args.args);
        any other name -> mind.invoke(name, arguments) if it is a public faculty. The
        private/unknown refusals are the same ones /invoke and the MCP server make."""
        from holographic.io_and_interop.holographic_deepseek_v4 import _jsonable
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments) if arguments.strip() else {}
            except ValueError:
                return {"ok": False, "name": name,
                        "error": "tool arguments are not JSON: %r" % arguments[:120]}
        args = arguments if isinstance(arguments, dict) else {}
        if name == TOOL_FIND:
            q = str(args.get("query") or "")
            if not q:
                return {"ok": False, "name": name, "error": "lecore_find needs a query"}
            return {"ok": True, "name": name,
                    "result": {"query": q, "routes": self.routes(q, k=args.get("k"))}}
        target, targs = name, args
        if name == TOOL_INVOKE:
            target = str(args.get("name") or "")
            targs = args.get("args")
            if targs is None:
                targs = {}
        if not _public_callable(self.mind, target):
            return {"ok": False, "name": name,
                    "error": "not a public leCore faculty: %r -- search with %s"
                             % (target, TOOL_FIND)}
        try:
            result = self.mind.invoke(target, targs)
        except Exception as exc:                      # a tool error is DATA to the model
            return {"ok": False, "name": name, "faculty": target,
                    "error": "%s: %s" % (type(exc).__name__, str(exc)[:300])}
        return {"ok": True, "name": name, "faculty": target, "result": _jsonable(result)}

    def resolve(self, response):
        """Execute every tool call in an OpenAI response. Returns (assistant_msg, tool_msgs, records).

        `tool_msgs` are the `role: tool` messages to append after the assistant message;
        `records` is the audit trail. No tool calls -> (msg, [], [])."""
        msg, calls = _tool_calls_of(response)
        tool_msgs, records = [], []
        for call in calls:
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = str(fn.get("name") or call.get("name") or "")
            out = self.execute(name, fn.get("arguments", call.get("arguments")))
            cid = str(call.get("id") or "call_%d" % len(records))
            tool_msgs.append({"role": "tool", "tool_call_id": cid, "name": name,
                              "content": json.dumps(out, ensure_ascii=False)})
            records.append({"id": cid, "name": name, "ok": bool(out.get("ok")),
                            "faculty": out.get("faculty"), "error": out.get("error")})
        return msg, tool_msgs, records

    def loop(self, body, post, max_rounds=DEFAULT_ROUNDS, cue=None, k=None):
        """Attach, post, execute tool calls, re-post -- until the model answers.

        `post(path, body) -> response dict` is the transport (see http_post for a
        urllib one), so the loop is testable with a fake and reusable behind any
        proxy. Returns (final_response, trace). trace: rounds, calls, routes,
        exhausted (True when max_rounds ran out with calls still pending)."""
        attached, info = self.attach(body, cue=cue, k=k)
        trace = {"routes": info["routes"], "tools_added": info["tools_added"],
                 "rounds": 0, "calls": [], "exhausted": False}
        path = "/v1/chat/completions" if attached.get("messages") is not None \
            else "/v1/completions"
        if path == "/v1/completions" or attached.get("stream"):
            trace["rounds"] = 1
            return post(path, attached), trace          # no tool channel / no loop on streams
        current = attached
        response = None
        for _ in range(max(1, int(max_rounds))):
            trace["rounds"] += 1
            response = post(path, current)
            msg, tool_msgs, records = self.resolve(response)
            if not tool_msgs:
                return response, trace
            trace["calls"].extend(records)
            nxt = dict(current)
            nxt["messages"] = list(current.get("messages") or []) + [msg] + tool_msgs
            current = nxt
        trace["exhausted"] = True
        return response, trace


def http_post(upstream, timeout=60, headers=None):
    """A `post(path, body)` over urllib for ToolRouter.loop / ToolSidecar.forward."""
    import urllib.error
    import urllib.request
    base = str(upstream).rstrip("/")
    hdrs = {"Content-Type": "application/json"}
    hdrs.update(headers or {})

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode("utf-8"),
                                     headers=hdrs, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            err = exc.read().decode("utf-8", "replace")
            raise RuntimeError("upstream %s%s -> HTTP %s: %s"
                               % (base, path, exc.code, err[:400])) from exc
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {"raw": raw.decode("utf-8", "replace")}
    return post


class ToolSidecar:
    """Memory AND tools in front of a model leCore does not run: FlashHRR recall injected
    first (when an install OUT_DIR is given), then the routed tools advertised, then the
    model's tool calls executed on the mind until it answers."""

    def __init__(self, router, hrr=None, k_recall=3):
        self.router = router
        self.hrr = hrr
        self.k_recall = int(k_recall)

    @classmethod
    def open(cls, out_dir=None, mind=None, k=DEFAULT_K, k_recall=3):
        hrr = None
        if out_dir:
            from holographic.io_and_interop.holographic_deepseek_v4 import FlashHRR
            hrr = FlashHRR.open(out_dir)
        return cls(ToolRouter(mind=mind, k=k), hrr=hrr, k_recall=k_recall)

    def status(self):
        return {"hrr": self.hrr.status() if self.hrr is not None else None,
                "tools": {"k": self.router.k, "meta": [TOOL_FIND, TOOL_INVOKE]},
                "runtime": "recall inject + routed tools + tool-call execution; "
                           "GDNRuntime not called"}

    def attach(self, body, cue=None, k=None):
        """FlashHRR.attach then ToolRouter.attach. Returns (attached, {hrr, tools})."""
        info = {"hrr": None, "tools": None}
        current = body
        if self.hrr is not None:
            current, info["hrr"] = self.hrr.attach(body, k=self.k_recall, query=cue)
        attached, info["tools"] = self.router.attach(current, cue=cue, k=k)
        return attached, info

    def before_generate(self, body, cue=None, k=None):
        """Serve-layer hook: the body the upstream should see."""
        return self.attach(body, cue=cue, k=k)[0]

    def forward(self, body, upstream=None, post=None, max_rounds=DEFAULT_ROUNDS,
                cue=None, k=None, timeout=60):
        """Full round trip: recall + tools attached, tool calls executed, model answered.
        Returns (response, trace); trace carries the hrr info alongside the tool loop."""
        if post is None:
            if not upstream:
                raise ValueError("forward() needs an upstream URL or a post callable")
            post = http_post(upstream, timeout=timeout)
        current, hrr_info = body, None
        if self.hrr is not None:
            current, hrr_info = self.hrr.attach(body, k=self.k_recall, query=cue)
        response, trace = self.router.loop(current, post, max_rounds=max_rounds, cue=cue, k=k)
        trace["hrr"] = hrr_info
        return response, trace


def open_tool_sidecar(out_dir=None, mind=None, k=DEFAULT_K):
    """Open the tool sidecar: recall from OUT_DIR when given, tools from `mind` (or a fresh one)."""
    return ToolSidecar.open(out_dir, mind=mind, k=k)


def _selftest():
    import os
    import tempfile
    from holographic.misc.holographic_unified import UnifiedMind
    from holographic.io_and_interop.holographic_deepseek_v4 import (
        fake_deepseek_v4_config, fake_deepseek_v4_weights, install_deepseek_v4)

    m = UnifiedMind(dim=64, seed=0)
    router = ToolRouter(mind=m, k=6)
    # 1) ROUTE: the catalog arm finds the callable faculty for a lexical-ranking task
    routes = router.routes("rank these documents with bm25 for a query")
    names = [r["tool"] for r in routes]
    assert "bm25_rank" in names, names
    assert all(set(r) >= {"tool", "kind", "callable", "description", "score"} for r in routes)
    assert routes == sorted(routes, key=lambda r: -r["score"])
    # 2) ADVERTISE: meta pair + routed schema with the REAL parameter names, caller tools kept
    body = {"model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "rank these documents with bm25 for a query"}],
            "tools": [{"type": "function", "function": {"name": "weather", "parameters": {}}}]}
    attached, info = router.attach(body)
    fnames = [t["function"]["name"] for t in attached["tools"]]
    assert fnames[0] == "weather" and TOOL_FIND in fnames and TOOL_INVOKE in fnames
    assert "bm25_rank" in fnames and len(fnames) == len(set(fnames))
    schema = next(t for t in attached["tools"] if t["function"]["name"] == "bm25_rank")
    assert schema["function"]["parameters"]["required"] == ["query", "docs"]
    assert "tool_choice" not in attached and "tools" not in body or body["tools"] is not attached["tools"]
    plain, pinfo = router.attach({"model": "x", "prompt": "hello"})
    assert "tools" not in plain and pinfo["advertised"] is False
    # 3) EXECUTE: refusals match /invoke; lecore_find routes; lecore_invoke runs a faculty
    assert router.execute("_private", {})["ok"] is False
    assert router.execute("no_such_faculty_xyz", "{}")["ok"] is False
    assert router.execute("bm25_rank", "not json")["ok"] is False
    found = router.execute(TOOL_FIND, {"query": "rank documents with bm25", "k": 4})
    assert found["ok"] and "bm25_rank" in [r["tool"] for r in found["result"]["routes"]]
    docs = ["paris is the capital of france", "berlin is in germany"]
    ran = router.execute(TOOL_INVOKE, json.dumps({"name": "bm25_rank",
                                                  "args": {"query": "capital of france",
                                                           "docs": docs}}))
    assert ran["ok"] and ran["faculty"] == "bm25_rank" and ran["result"][0][0] == 0, ran
    direct = router.execute("bm25_rank", {"query": "germany", "docs": docs})
    assert direct["ok"] and direct["result"][0][0] == 1
    # 4) LOOP: a fake model calls lecore_find, then the routed faculty, then answers
    seen = []

    def fake_post(path, req):
        seen.append(json.loads(json.dumps(req)))
        n = len(seen)
        if n == 1:
            call = {"id": "c1", "type": "function",
                    "function": {"name": TOOL_FIND,
                                 "arguments": json.dumps({"query": "rank documents with bm25"})}}
        elif n == 2:
            assert req["messages"][-1]["role"] == "tool" and req["messages"][-1]["tool_call_id"] == "c1"
            call = {"id": "c2", "type": "function",
                    "function": {"name": "bm25_rank",
                                 "arguments": json.dumps({"query": "capital of france",
                                                          "docs": docs})}}
        else:
            return {"choices": [{"message": {"role": "assistant", "content": "Paris."}}]}
        return {"choices": [{"message": {"role": "assistant", "content": None,
                                         "tool_calls": [call]}}]}

    td = tempfile.mkdtemp()
    install_deepseek_v4(fake_deepseek_v4_weights(), fake_deepseek_v4_config(),
                        passages=["the capital of France is Paris"], n_registers=4,
                        seed=0, out_dir=td, hrr_dim=64)
    side = ToolSidecar.open(td, mind=m, k=6)
    assert os.path.isfile(os.path.join(td, "lecore.json")) and side.status()["hrr"]["passages"] == 1
    resp, trace = side.forward({"model": "deepseek-v4-flash",
                                "messages": [{"role": "user",
                                              "content": "rank documents with bm25: capital of france"}]},
                               post=fake_post)
    assert resp["choices"][0]["message"]["content"] == "Paris."
    assert trace["rounds"] == 3 and [c["name"] for c in trace["calls"]] == [TOOL_FIND, "bm25_rank"]
    assert all(c["ok"] for c in trace["calls"]) and trace["exhausted"] is False
    assert trace["hrr"]["attached"] and seen[0]["messages"][0]["role"] == "system"
    assert "paris" in seen[0]["messages"][0]["content"].lower()
    assert TOOL_INVOKE in [t["function"]["name"] for t in seen[0]["tools"]]
    # bounded: a model that never stops calling is cut off and the trace says so
    always = lambda path, req: {"choices": [{"message": {  # noqa: E731
        "role": "assistant", "tool_calls": [{"id": "x", "function": {
            "name": TOOL_FIND, "arguments": json.dumps({"query": "bm25"})}}]}}]}
    _r, t2 = router.loop({"messages": [{"role": "user", "content": "bm25"}]}, always, max_rounds=2)
    assert t2["exhausted"] is True and t2["rounds"] == 2 and len(t2["calls"]) == 2
    # streams and prompt bodies are posted once, never looped
    _r, t3 = router.loop({"messages": [{"role": "user", "content": "bm25"}], "stream": True},
                         always, max_rounds=3)
    assert t3["rounds"] == 1 and t3["calls"] == []
    print("holographic_flash_tools selftest OK -- routes rank the callable faculty, the request "
          "advertises %d tools (meta pair + routed), tool calls execute on the mind, the loop "
          "answered in %d rounds with HRR recall injected first" % (len(fnames), trace["rounds"]))


if __name__ == "__main__":
    _selftest()
