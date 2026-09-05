"""Flash tool routes -- the sidecar advertises, routes and executes leCore's tools.

Fake weights, a fake upstream (`post` callable), no network, no GDNRuntime. What is
pinned: the catalog arm routes to the callable faculty; the request carries the meta
pair plus routed schemas with REAL parameter names and keeps the caller's tools;
execution refuses what /invoke refuses; the loop runs tool calls on the mind and
stops when the model answers -- or when max_rounds runs out, and says so.
"""
import json

import pytest

from holographic.io_and_interop import holographic_flash_tools as T
from holographic.io_and_interop import holographic_deepseek_v4 as D

DOCS = ["paris is the capital of france", "berlin is in germany"]
CUE = "rank these documents with bm25 for a query"


@pytest.fixture(scope="module")
def mind():
    from holographic.misc.holographic_unified import UnifiedMind
    return UnifiedMind(dim=64, seed=0)


@pytest.fixture(scope="module")
def router(mind):
    return T.ToolRouter(mind=mind, k=6)


@pytest.fixture(scope="module")
def install_dir(tmp_path_factory):
    td = str(tmp_path_factory.mktemp("flash_tools"))
    D.install_deepseek_v4(D.fake_deepseek_v4_weights(), D.fake_deepseek_v4_config(),
                          passages=["the capital of France is Paris"], n_registers=4,
                          seed=0, out_dir=td, hrr_dim=64)
    return td


def _chat(content, **extra):
    body = {"model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": content}]}
    body.update(extra)
    return body


# ---- 1. ROUTE --------------------------------------------------------------------------------
def test_routes_rank_the_callable_faculty_first_and_are_sorted(router):
    routes = router.routes(CUE)
    tools = [r["tool"] for r in routes]
    assert "bm25_rank" in tools
    hit = next(r for r in routes if r["tool"] == "bm25_rank")
    assert hit["kind"] == "faculty" and hit["callable"] is True
    assert routes == sorted(routes, key=lambda r: -r["score"])
    assert len(tools) == len(set(tools))


def test_routes_are_deterministic_and_empty_cue_routes_nothing(router):
    assert router.routes(CUE) == router.routes(CUE)
    assert router.routes("") == [] and router.routes(None) == []


def test_faculty_schema_uses_real_parameter_names(mind):
    schema = T.faculty_schema(mind, "bm25_rank", "lexical ranking")
    fn = schema["function"]
    assert fn["name"] == "bm25_rank"
    assert fn["parameters"]["required"] == ["query", "docs"]
    assert set(fn["parameters"]["properties"]) >= {"query", "docs", "k1", "b", "top"}


# ---- 2. ADVERTISE ----------------------------------------------------------------------------
def test_attach_adds_meta_pair_and_routed_schemas_keeping_caller_tools(router):
    body = _chat(CUE, tools=[{"type": "function",
                              "function": {"name": "weather", "parameters": {}}}])
    attached, info = router.attach(body)
    names = [t["function"]["name"] for t in attached["tools"]]
    assert names[0] == "weather"                          # caller's tool first, untouched
    assert T.TOOL_FIND in names and T.TOOL_INVOKE in names and "bm25_rank" in names
    assert len(names) == len(set(names))
    assert "tool_choice" not in attached                  # the model decides
    assert info["advertised"] and info["cue"] == CUE
    assert set(info["tools_added"]) == set(names) - {"weather"}
    assert body["tools"] == [{"type": "function",
                              "function": {"name": "weather", "parameters": {}}}]  # input untouched


def test_attach_never_duplicates_a_tool_the_caller_already_advertises(router):
    body = _chat(CUE, tools=T.meta_tools())
    attached, info = router.attach(body)
    names = [t["function"]["name"] for t in attached["tools"]]
    assert names.count(T.TOOL_FIND) == 1 and names.count(T.TOOL_INVOKE) == 1
    assert T.TOOL_FIND not in info["tools_added"]


def test_attach_leaves_completions_bodies_alone(router):
    attached, info = router.attach({"model": "x", "prompt": "hello"})
    assert attached == {"model": "x", "prompt": "hello"}
    assert info["advertised"] is False and info["tools_added"] == []


def test_attach_rejects_non_dict(router):
    with pytest.raises(TypeError):
        router.attach(["not", "a", "body"])


# ---- 3. EXECUTE ------------------------------------------------------------------------------
def test_execute_refuses_what_invoke_refuses(router):
    assert router.execute("_private", {})["ok"] is False
    assert router.execute("no_such_faculty_xyz", "{}")["ok"] is False
    bad = router.execute(T.TOOL_INVOKE, {"name": "_hidden", "args": {}})
    assert bad["ok"] is False and "public" in bad["error"]
    assert router.execute("bm25_rank", "{not json")["ok"] is False
    assert router.execute(T.TOOL_FIND, {})["ok"] is False


def test_execute_find_and_invoke_and_direct(router):
    found = router.execute(T.TOOL_FIND, json.dumps({"query": "rank documents with bm25"}))
    assert found["ok"] and "bm25_rank" in [r["tool"] for r in found["result"]["routes"]]
    ran = router.execute(T.TOOL_INVOKE, {"name": "bm25_rank",
                                         "args": {"query": "capital of france", "docs": DOCS}})
    assert ran["ok"] and ran["faculty"] == "bm25_rank" and ran["result"][0][0] == 0
    direct = router.execute("bm25_rank", {"query": "germany", "docs": DOCS})
    assert direct["ok"] and direct["result"][0][0] == 1
    json.dumps(ran)                                         # the result is wire-safe


def test_execute_turns_a_faculty_error_into_data(router):
    out = router.execute("bm25_rank", {"query": "x"})       # docs missing -> TypeError
    assert out["ok"] is False and out["faculty"] == "bm25_rank" and "TypeError" in out["error"]


def test_resolve_builds_tool_messages_with_matching_ids(router):
    response = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
        {"id": "call_a", "type": "function",
         "function": {"name": "bm25_rank",
                      "arguments": json.dumps({"query": "germany", "docs": DOCS})}},
        {"id": "call_b", "type": "function",
         "function": {"name": "_nope", "arguments": "{}"}}]}}]}
    msg, tool_msgs, records = router.resolve(response)
    assert msg is response["choices"][0]["message"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["call_a", "call_b"]
    assert all(m["role"] == "tool" for m in tool_msgs)
    assert json.loads(tool_msgs[0]["content"])["ok"] is True
    assert records[0]["ok"] is True and records[1]["ok"] is False
    assert router.resolve({"choices": [{"message": {"content": "hi"}}]})[1:] == ([], [])


# ---- the loop --------------------------------------------------------------------------------
def _scripted_upstream(calls_then_answer):
    """A fake /v1/chat/completions: emits each scripted tool call in turn, then answers."""
    seen = []

    def post(path, body):
        seen.append(json.loads(json.dumps(body)))
        n = len(seen) - 1
        if n < len(calls_then_answer):
            name, args = calls_then_answer[n]
            return {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c%d" % n, "type": "function",
                 "function": {"name": name, "arguments": json.dumps(args)}}]}}]}
        return {"choices": [{"message": {"role": "assistant", "content": "Paris."}}]}
    post.seen = seen
    return post


def test_loop_executes_calls_and_returns_when_the_model_answers(router):
    post = _scripted_upstream([(T.TOOL_FIND, {"query": "rank documents with bm25"}),
                               ("bm25_rank", {"query": "capital of france", "docs": DOCS})])
    resp, trace = router.loop(_chat(CUE), post, max_rounds=5)
    assert resp["choices"][0]["message"]["content"] == "Paris."
    assert trace["rounds"] == 3 and trace["exhausted"] is False
    assert [c["name"] for c in trace["calls"]] == [T.TOOL_FIND, "bm25_rank"]
    assert all(c["ok"] for c in trace["calls"])
    # the transcript grows by assistant + tool message per round, ids matching
    second = post.seen[1]["messages"]
    assert second[-2]["tool_calls"][0]["id"] == "c0" and second[-1]["tool_call_id"] == "c0"
    assert post.seen[0]["tools"] and T.TOOL_INVOKE in [t["function"]["name"]
                                                        for t in post.seen[0]["tools"]]


def test_loop_is_bounded_and_says_so(router):
    post = _scripted_upstream([(T.TOOL_FIND, {"query": "bm25"})] * 10)
    resp, trace = router.loop(_chat("bm25"), post, max_rounds=2)
    assert trace["exhausted"] is True and trace["rounds"] == 2 and len(trace["calls"]) == 2
    assert resp["choices"][0]["message"]["tool_calls"]      # the last response is returned as-is


def test_loop_posts_streams_and_prompts_once_without_looping(router):
    post = _scripted_upstream([(T.TOOL_FIND, {"query": "bm25"})])
    _r, trace = router.loop(_chat("bm25", stream=True), post, max_rounds=3)
    assert trace["rounds"] == 1 and trace["calls"] == [] and len(post.seen) == 1
    assert post.seen[0]["tools"]                             # advertised even on a stream
    post2 = _scripted_upstream([])
    _r, trace2 = router.loop({"prompt": "bm25"}, post2, max_rounds=3)
    assert trace2["rounds"] == 1 and "tools" not in post2.seen[0]


# ---- composed with recall --------------------------------------------------------------------
def test_tool_sidecar_injects_recall_then_tools(mind, install_dir):
    side = T.ToolSidecar.open(install_dir, mind=mind, k=6)
    assert side.status()["hrr"]["passages"] == 1
    attached, info = side.attach(_chat("capital of France? rank with bm25"))
    assert attached["messages"][0]["role"] == "system"
    assert "paris" in attached["messages"][0]["content"].lower()
    assert info["hrr"]["attached"] and info["tools"]["advertised"]
    assert attached["messages"][1]["role"] == "user"        # caller's turn preserved after inject


def test_tool_sidecar_forward_carries_hrr_and_trace(mind, install_dir):
    side = T.ToolSidecar.open(install_dir, mind=mind, k=6)
    post = _scripted_upstream([("bm25_rank", {"query": "capital of france", "docs": DOCS})])
    resp, trace = side.forward(_chat("capital of France? rank with bm25"), post=post)
    assert resp["choices"][0]["message"]["content"] == "Paris."
    assert trace["hrr"]["attached"] and trace["rounds"] == 2
    assert [c["name"] for c in trace["calls"]] == ["bm25_rank"]
    assert post.seen[0]["messages"][0]["role"] == "system"
    with pytest.raises(ValueError):
        side.forward(_chat("x"))                             # neither upstream nor post


def test_tool_sidecar_without_install_dir_is_tools_only(mind):
    side = T.ToolSidecar.open(None, mind=mind, k=4)
    assert side.hrr is None and side.status()["hrr"] is None
    attached, info = side.attach(_chat(CUE))
    assert info["hrr"] is None and info["tools"]["advertised"]
    assert attached["messages"][0]["role"] == "user"


def test_unicron_flash_tools_facade_binds_the_mind(mind, install_dir):
    side = mind.unicron_flash_tools(install_dir, k=4)
    assert isinstance(side, T.ToolSidecar) and side.router.mind is mind
    attached, info = side.attach(_chat(CUE))
    assert "bm25_rank" in info["tools"]["tools_added"]
    assert attached["messages"][0]["role"] == "system"
