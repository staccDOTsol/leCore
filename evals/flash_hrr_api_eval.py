#!/usr/bin/env python3
"""API-only lite evals for in-weight HRR-on-DeepSeek V4-Flash.

Hits an OpenAI-compatible `/v1/chat/completions` endpoint. No local GPU.
Does not download Flash weights. Sequential, temperature 0, 180s timeouts.

    python evals/flash_hrr_api_eval.py --base-url http://HOST:PORT/v1

Headline MEMORY SIG DIFF is the lab Gateway auto-sticky measurement and is
never overwritten by a raw-vLLM probe (raw vLLM has no Gateway sticky).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RESULTS = HERE / "results"

# ---------------------------------------------------------------------------
# Lab headline (Gateway auto-sticky). Do not overwrite from raw vLLM.
# ---------------------------------------------------------------------------
LAB_HOST = "lab box Gateway http://127.0.0.1:8765/v1"
LAB_PUBLIC_VLLM = "http://198.145.108.57:30739/v1"
LAB_OVERLAY = "DeepSeek-V4-Flash-0731-serve"
LAB_MODEL_ID = "/workspace/models/DeepSeek-V4-Flash-0731-serve"
LAB_SIG = {
    "t2_nonce_cite": {"off": "0/5", "on": "5/5"},
    "multi_turn_3cite": {"off": "0/3", "on": "3/3"},
    "reprompts": {
        "off": "must re-paste the citations",
        "on": "1 ask, no paste",
    },
}

DEFAULT_TIMEOUT = 180
DEFAULT_TEMPERATURE = 0.0


# ===========================================================================
# HTTP client
# ===========================================================================
class ChatClient:
    def __init__(self, base_url, model, api_key="EMPTY", timeout=DEFAULT_TIMEOUT,
                 temperature=DEFAULT_TEMPERATURE, pause_s=0.15):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key or "EMPTY"
        self.timeout = timeout
        self.temperature = temperature
        self.pause_s = pause_s
        self.latencies = []
        self.errors = []

    def chat(self, messages, max_tokens=512, extra=None):
        url = self.base_url + "/chat/completions"
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": max_tokens,
        }
        if extra:
            body.update(extra)
        data = json.dumps(body).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + self.api_key,
        }
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                elapsed = time.time() - t0
                self.latencies.append(elapsed)
                payload = json.loads(raw.decode("utf-8"))
                text = (
                    payload.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                )
                if self.pause_s:
                    time.sleep(self.pause_s)
                return {
                    "ok": True,
                    "text": text,
                    "elapsed": elapsed,
                    "usage": payload.get("usage") or {},
                    "raw_id": payload.get("id"),
                    "finish_reason": payload.get("choices", [{}])[0].get("finish_reason"),
                }
        except Exception as exc:
            elapsed = time.time() - t0
            self.latencies.append(elapsed)
            err = {"error": "%s: %s" % (type(exc).__name__, exc), "elapsed": elapsed}
            self.errors.append(err)
            if self.pause_s:
                time.sleep(self.pause_s)
            return {"ok": False, "text": "", "elapsed": elapsed, "error": err["error"]}

    def probe(self):
        url = self.base_url + "/models"
        headers = {"Authorization": "Bearer " + self.api_key}
        req = urllib.request.Request(url, headers=headers, method="GET")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=min(30, self.timeout)) as resp:
                raw = resp.read()
                payload = json.loads(raw.decode("utf-8"))
                ids = [m.get("id") for m in payload.get("data") or []]
                return {"ok": True, "models": ids, "elapsed": time.time() - t0, "body": payload}
        except Exception as exc:
            return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc),
                    "elapsed": time.time() - t0}


def p50(xs):
    if not xs:
        return None
    return float(statistics.median(xs))


# ===========================================================================
# Graders
# ===========================================================================
_NUM = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def extract_gsm8k_gold(answer_full):
    if "####" in answer_full:
        return answer_full.split("####")[-1].strip().replace(",", "").split()[0]
    nums = _NUM.findall(answer_full.replace(",", ""))
    return nums[-1] if nums else ""


def extract_gsm8k_pred(text):
    if not text:
        return ""
    if "####" in text:
        tail = text.split("####")[-1].strip()
        nums = _NUM.findall(tail.replace(",", ""))
        if nums:
            return nums[0].replace(",", "")
    nums = _NUM.findall(text.replace(",", ""))
    return nums[-1].replace(",", "") if nums else ""


def gsm8k_match(pred, gold):
    if pred == "" or gold == "":
        return False
    try:
        return abs(float(pred) - float(gold)) < 1e-6
    except ValueError:
        return pred.strip() == gold.strip()


def last_boxed(text):
    if not text:
        return ""
    idx = text.rfind("\\boxed")
    if idx < 0:
        return ""
    brace = text.find("{", idx)
    if brace < 0:
        # \boxed 42
        rest = text[idx + len("\\boxed"):].strip()
        m = re.match(r"([^\s$]+)", rest)
        return m.group(1) if m else ""
    depth = 0
    for j in range(brace, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[brace + 1:j]
    return text[brace + 1:]


def norm_math(s):
    if s is None:
        return ""
    s = str(s).strip()
    s = s.replace("\n", " ")
    s = s.replace("\\left", "").replace("\\right", "")
    s = s.replace("\\,", "").replace("\\!", "").replace("\\;", "").replace("\\:", "")
    s = s.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
    s = s.replace("\\mathrm", "").replace("\\mathbf", "")
    s = re.sub(r"\\text\{([^{}]*)\}", r"\1", s)
    s = s.replace("$", "")
    s = s.replace(" ", "")
    s = s.replace("{,}", "")
    s = s.replace("^\\circ", "").replace("^{\\circ}", "")
    s = s.replace("\\cdot", "*")
    return s


def math_match(pred_text, gold):
    boxed = last_boxed(pred_text)
    cand = boxed if boxed else pred_text.strip().split("\n")[-1]
    np_, ng = norm_math(cand), norm_math(gold)
    if np_ and np_ == ng:
        return True, cand
    # loose: strip more latex
    def loose(x):
        x = re.sub(r"[{}]", "", x)
        x = x.replace("\\frac", "")
        x = x.replace("\\pi", "pi")
        x = x.replace("\\sqrt", "sqrt")
        return x
    if np_ and loose(np_) == loose(ng):
        return True, cand
    return False, cand


def strip_fences(text):
    if not text:
        return ""
    m = re.search(r"```(?:python|py|json)?\s*\n(.*?)```", text, re.S | re.I)
    if m:
        return m.group(1).strip("\n")
    return text.strip()


def assemble_humaneval(prompt, completion):
    body = strip_fences(completion)
    # drop a leading language tag leftover
    if body.startswith("python\n"):
        body = body[len("python\n"):]
    stripped = body.lstrip()
    if stripped.startswith("from ") or stripped.startswith("import ") or stripped.startswith("def "):
        return body
    return prompt + body


def exec_humaneval_item(prompt, completion, test, entry_point, timeout=12):
    code = assemble_humaneval(prompt, completion)
    script = code + "\n\n" + test + "\n\ncheck(%s)\n" % entry_point
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
        fh.write(script)
        path = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, path],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        ok = proc.returncode == 0
        err = ""
        if not ok:
            err = (proc.stderr or proc.stdout or "nonzero exit %s" % proc.returncode)[-800:]
        return ok, err
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# ---- IFEval lite checkers (strict-ish, documented; not the official package) ----
def _kw(kwargs, *keys, default=None):
    if not kwargs:
        return default
    for k in keys:
        if k in kwargs and kwargs[k] is not None:
            return kwargs[k]
    return default


def ifeval_check(instr_id, kwargs, response, prompt=""):
    text = response or ""
    if instr_id == "punctuation:no_comma":
        return "," not in text
    if instr_id == "detectable_format:number_highlighted_sections":
        n = int(_kw(kwargs, "num_highlights", default=0) or 0)
        singles = list(re.finditer(r"\*[^\n*]*\*", text))
        doubles = list(re.finditer(r"\*\*[^\n*]*\*\*", text))
        return (len(singles) + len(doubles)) >= n
    if instr_id == "length_constraints:number_words":
        n = int(_kw(kwargs, "num_words", default=0) or 0)
        rel = (_kw(kwargs, "relation", default="at least") or "at least").lower()
        wc = len(text.split())
        if rel == "at least":
            return wc >= n
        if rel == "less than":
            return wc < n
        return wc == n
    if instr_id == "detectable_content:number_placeholders":
        n = int(_kw(kwargs, "num_placeholders", default=0) or 0)
        return len(re.findall(r"\[[^\]]+\]", text)) >= n
    if instr_id == "combination:repeat_prompt":
        rpt = _kw(kwargs, "prompt_to_repeat", default="") or ""
        return text.strip().startswith(rpt.strip())
    if instr_id == "detectable_format:title":
        return bool(re.search(r"<<[^<>]+>>", text))
    if instr_id == "change_case:english_lowercase":
        return text == text.lower() and any(c.isalpha() for c in text)
    if instr_id == "change_case:english_capital":
        return text == text.upper() and any(c.isalpha() for c in text)
    if instr_id == "detectable_format:number_bullet_lists":
        n = int(_kw(kwargs, "num_bullets", default=0) or 0)
        stars = re.findall(r"^\s*\*[^\n*].*$", text, flags=re.M)
        dashes = re.findall(r"^\s*- .*$", text, flags=re.M)
        return len(stars) + len(dashes) == n
    if instr_id == "detectable_format:multiple_sections":
        splitter = _kw(kwargs, "section_spliter", "section_splitter", default="Section") or "Section"
        n = int(_kw(kwargs, "num_sections", default=0) or 0)
        pat = r"\s?" + re.escape(splitter) + r"\s?\d+\s?"
        parts = re.split(pat, text)
        return (len(parts) - 1) >= n
    if instr_id == "change_case:capital_word_frequency":
        n = int(_kw(kwargs, "capital_frequency", default=0) or 0)
        rel = (_kw(kwargs, "capital_relation", default="at least") or "at least").lower()
        words = re.findall(r"\b[A-Z]{2,}\b", text)
        c = len(words)
        if rel == "at least":
            return c >= n
        if rel == "less than":
            return c < n
        return c == n
    if instr_id == "startend:quotation":
        t = text.strip()
        return len(t) >= 2 and t[0] == '"' and t[-1] == '"'
    if instr_id == "keywords:existence":
        kws = _kw(kwargs, "keywords", default=[]) or []
        low = text.lower()
        return all(str(k).lower() in low for k in kws)
    if instr_id == "detectable_format:json_format":
        blob = strip_fences(text).strip()
        try:
            json.loads(blob)
            return True
        except Exception:
            return False
    if instr_id == "length_constraints:number_paragraphs":
        n = int(_kw(kwargs, "num_paragraphs", default=0) or 0)
        paragraphs = re.split(r"\s*\*\*\*\s*", text)
        count = len(paragraphs)
        for index, paragraph in enumerate(paragraphs):
            if not paragraph.strip():
                if index == 0 or index == len(paragraphs) - 1:
                    count -= 1
                else:
                    return False
        return count == n
    if instr_id == "combination:two_responses":
        if text.count("******") != 1:
            return False
        a, b = text.split("******", 1)
        return bool(a.strip()) and bool(b.strip())
    if instr_id == "language:response_language":
        lang = (_kw(kwargs, "language", default="") or "").lower()
        letters = [c for c in text if c.isalpha()]
        if not letters:
            return False
        if lang == "kn":
            kn = sum(1 for c in letters if "\u0c80" <= c <= "\u0cff")
            return kn / len(letters) >= 0.6
        # undocumented langs in this lite slice: fail closed
        return False
    if instr_id == "keywords:letter_frequency":
        letter = str(_kw(kwargs, "letter", default="") or "")
        n = int(_kw(kwargs, "let_frequency", default=0) or 0)
        rel = (_kw(kwargs, "let_relation", default="at least") or "at least").lower()
        hay = text.lower()
        needle = letter.lower()
        c = hay.count(needle)
        if rel == "at least":
            return c >= n
        if rel == "less than":
            return c < n
        return c == n
    return False


def ifeval_score_item(item, response):
    ids = item["instruction_id_list"]
    kwargs_list = item.get("kwargs") or [{}] * len(ids)
    flags = []
    for i, iid in enumerate(ids):
        kw = kwargs_list[i] if i < len(kwargs_list) else {}
        flags.append(bool(ifeval_check(iid, kw, response, item.get("prompt") or "")))
    prompt_ok = all(flags) if flags else False
    return prompt_ok, flags


# ===========================================================================
# Suites
# ===========================================================================
def load_slice(name):
    path = DATA / name
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def run_memory_sig(client, n=5):
    """Raw-vLLM nonce remember/recall. Fresh request on recall (no client history).

    This is NOT Gateway auto-sticky. Failures here must not overwrite lab SIG DIFF.
    """
    trials = []
    for i in range(n):
        nonce = "HRR-SIG-%s-%s" % (uuid.uuid4().hex[:12], i)
        remember = (
            "This is a memory probe. Remember this exact nonce for later recall: "
            "%s. Confirm by repeating the nonce once." % nonce
        )
        r1 = client.chat([{"role": "user", "content": remember}], max_tokens=64)
        recall = (
            "Without any extra context, what is the exact nonce I asked you to "
            "remember in this thread? Reply with only the nonce."
        )
        r2 = client.chat([{"role": "user", "content": recall}], max_tokens=64)
        cited = nonce in (r2.get("text") or "")
        trials.append({
            "i": i,
            "nonce": nonce,
            "remember_ok": r1.get("ok"),
            "remember_text": (r1.get("text") or "")[:200],
            "recall_ok": r2.get("ok"),
            "recall_text": (r2.get("text") or "")[:200],
            "cited": cited,
            "remember_s": r1.get("elapsed"),
            "recall_s": r2.get("elapsed"),
            "remember_error": r1.get("error"),
            "recall_error": r2.get("error"),
        })
    hits = sum(1 for t in trials if t["cited"])
    return {
        "n": n,
        "hits": hits,
        "score": "%s/%s" % (hits, n),
        "trials": trials,
        "note": (
            "raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. "
            "This probe used a fresh request (no client-side history, no extra headers)."
        ),
    }


def run_gsm8k(client, n=20):
    sl = load_slice("gsm8k_lite20.json")
    items = sl["items"][:n]
    rows = []
    for it in items:
        prompt = (
            "Solve the following grade-school math problem. Show brief working. "
            "Put the final numeric answer on its own line after ####.\n\n"
            + it["question"]
        )
        r = client.chat([{"role": "user", "content": prompt}], max_tokens=512)
        pred = extract_gsm8k_pred(r.get("text") or "")
        ok = bool(r.get("ok")) and gsm8k_match(pred, it["gold"])
        rows.append({
            "index": it["index"],
            "gold": it["gold"],
            "pred": pred,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        })
    return _pack(sl, rows, "GSM8K")


def run_math(client, n=20):
    sl = load_slice("math500_lite20.json")
    items = sl["items"][:n]
    rows = []
    for it in items:
        prompt = (
            "Solve the following competition math problem. Put the final answer "
            "in \\boxed{}.\n\n" + it["problem"]
        )
        r = client.chat([{"role": "user", "content": prompt}], max_tokens=1024)
        correct, cand = math_match(r.get("text") or "", it["answer"])
        ok = bool(r.get("ok")) and correct
        rows.append({
            "index": it["index"],
            "unique_id": it.get("unique_id"),
            "subject": it.get("subject"),
            "level": it.get("level"),
            "gold": it["answer"],
            "pred": cand,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        })
    return _pack(sl, rows, "MATH-500")


def run_humaneval(client, n=10):
    sl = load_slice("humaneval_lite10.json")
    items = sl["items"][:n]
    rows = []
    for it in items:
        prompt = (
            "Complete the following Python function. Return only code "
            "(the full function), no explanation.\n\n```python\n"
            + it["prompt"]
            + "```\n"
        )
        r = client.chat([{"role": "user", "content": prompt}], max_tokens=768)
        passed, err = (False, "request failed")
        if r.get("ok"):
            passed, err = exec_humaneval_item(
                it["prompt"], r.get("text") or "", it["test"], it["entry_point"]
            )
        rows.append({
            "index": it["index"],
            "task_id": it["task_id"],
            "entry_point": it["entry_point"],
            "correct": bool(passed),
            "exec_error": err or "",
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        })
    return _pack(sl, rows, "HumanEval")


def run_ifeval(client, n=20):
    sl = load_slice("ifeval_lite20.json")
    items = sl["items"][:n]
    rows = []
    for it in items:
        r = client.chat([{"role": "user", "content": it["prompt"]}], max_tokens=2048)
        prompt_ok, flags = ifeval_score_item(it, r.get("text") or "")
        ok = bool(r.get("ok")) and prompt_ok
        rows.append({
            "index": it["index"],
            "key": it.get("key"),
            "instruction_id_list": it["instruction_id_list"],
            "instruction_flags": flags,
            "prompt_level_strict_lite": ok,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        })
    packed = _pack(sl, rows, "IFEval")
    inst_total = sum(len(r["instruction_flags"]) for r in rows)
    inst_ok = sum(sum(1 for f in r["instruction_flags"] if f) for r in rows)
    packed["instruction_level_strict_lite"] = (
        "%s/%s" % (inst_ok, inst_total) if inst_total else "0/0"
    )
    packed["grader"] = (
        "lite IFEval checkers in evals/flash_hrr_api_eval.py (strict-ish; "
        "json allows a single markdown fence; Kannada via Unicode block U+0C80–U+0CFF; "
        "not the official google-research package)"
    )
    return packed


def _pack(sl, rows, name):
    n = len(rows)
    correct = sum(1 for r in rows if r.get("correct"))
    lats = [r["elapsed"] for r in rows if r.get("elapsed") is not None]
    errs = [r for r in rows if r.get("error")]
    return {
        "name": name,
        "n": n,
        "correct": correct,
        "accuracy": (correct / n) if n else None,
        "score": "%s/%s" % (correct, n),
        "source": sl.get("source"),
        "canonical": sl.get("canonical"),
        "split": sl.get("split"),
        "offset": sl.get("offset"),
        "latency_p50_s": p50(lats),
        "n_errors": len(errs),
        "errors": [{"index": e.get("index"), "error": e.get("error")} for e in errs],
        "items": rows,
    }


# ===========================================================================
# Report
# ===========================================================================
def fmt_pct(acc):
    if acc is None:
        return "NOT RUN"
    return "%.1f%%" % (100.0 * acc)


def render_markdown(report):
    cap = report.get("capability") or {}
    mem = report.get("memory_raw_vllm")
    probe = report.get("probe") or {}
    lines = []
    lines.append("# Flash HRR benches")
    lines.append("")
    lines.append("## MEMORY SIG DIFF")
    lines.append("")
    lines.append(
        "Measured on the **live in-weight overlay** through **Gateway auto-sticky** "
        "(no extra headers for the ON lane)."
    )
    lines.append("")
    lines.append("| arm | host | overlay | T2 nonce cite | Multi-turn 3-cite | Re-prompts |")
    lines.append("|---|---|---|---|---|---|")
    lines.append(
        "| sticky OFF | %s | `%s` | %s | %s | %s |"
        % (LAB_HOST, LAB_OVERLAY, LAB_SIG["t2_nonce_cite"]["off"],
           LAB_SIG["multi_turn_3cite"]["off"], LAB_SIG["reprompts"]["off"])
    )
    lines.append(
        "| sticky ON | %s | `%s` | %s | %s | %s |"
        % (LAB_HOST, LAB_OVERLAY, LAB_SIG["t2_nonce_cite"]["on"],
           LAB_SIG["multi_turn_3cite"]["on"], LAB_SIG["reprompts"]["on"])
    )
    lines.append(
        "| OG commodity OpenRouter | — | — | NOT RUN | NOT RUN | NOT RUN |"
    )
    lines.append("")
    lines.append(
        "Same overlay both Gateway arms: `%s` (served model id `%s`). "
        "Public raw vLLM (no Gateway): `%s`. "
        "OG commodity OpenRouter column was **not run** — empty, not invented."
        % (LAB_OVERLAY, LAB_MODEL_ID, LAB_PUBLIC_VLLM)
    )
    lines.append("")
    lines.append(
        "SWE-bench / Terminal-Bench: harness gap — not attempted, not claimed."
    )
    lines.append("")
    lines.append("## Raw vLLM memory probe (this run)")
    lines.append("")
    if not mem:
        lines.append(
            "NOT RUN. Raw vLLM has no Gateway auto-sticky; SIG DIFF is Gateway+overlay. "
            "Lab 0/5 vs 5/5 numbers above are the measured headline."
        )
    else:
        lines.append(
            "Host: `%s`. Model: `%s`. n=%s nonce remember/recall, **fresh request** "
            "(no client history, no Gateway). Score: **%s**."
            % (report.get("base_url"), report.get("model"), mem.get("n"), mem.get("score"))
        )
        lines.append("")
        lines.append(mem.get("note") or "")
        lines.append("")
        if mem.get("hits", 1) == 0:
            lines.append(
                "Recall failed, as expected on raw vLLM. **Do not treat this as a "
                "regression of the Gateway SIG DIFF (0/5 vs 5/5).**"
            )
        lines.append("")
        lines.append("| trial | nonce | cited on recall | recall head |")
        lines.append("|---|---|---|---|")
        for t in mem.get("trials") or []:
            head = (t.get("recall_text") or "").replace("|", "/").replace("\n", " ")[:80]
            lines.append(
                "| %s | `%s` | %s | %s |"
                % (t.get("i"), t.get("nonce"), "yes" if t.get("cited") else "no", head)
            )
    lines.append("")
    lines.append("## Appendix — capability lite (no-regress, not the pitch)")
    lines.append("")
    lines.append(
        "GSM8K / MATH-500 / HumanEval / IFEval are quality numbers so a Hugging Face "
        "README is not empty. They may be flat vs published Flash. GPQA skipped "
        "(too long for this lite pass). SWE-bench / Terminal-Bench not attempted."
    )
    lines.append("")
    reachable = report.get("reachable")
    if reachable is False:
        lines.append(
            "Live API was **not reachable** from this runner. Capability rows are NOT RUN."
        )
        if probe.get("error"):
            lines.append("")
            lines.append("Probe error: `%s`" % probe.get("error"))
        lines.append("")
    lines.append(
        "| bench | n | source | score | accuracy | latency p50 (s) | errors |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    order = ["GSM8K", "MATH-500", "HumanEval", "IFEval", "GPQA"]
    seen = set()
    for name in order:
        row = cap.get(name)
        seen.add(name)
        if not row:
            src = {
                "GSM8K": "openai/gsm8k test offset=0",
                "MATH-500": "HuggingFaceH4/MATH-500 test offset=0",
                "HumanEval": "openai/openai_humaneval test offset=0",
                "IFEval": "google/IFEval train offset=0",
                "GPQA": "skipped (too long)",
            }[name]
            ncell = "20" if name in ("GSM8K", "MATH-500", "IFEval") else (
                "10" if name == "HumanEval" else "—"
            )
            if name == "GPQA":
                lines.append(
                    "| %s | — | %s | skipped | — | — | — |" % (name, src)
                )
            else:
                lines.append(
                    "| %s | %s | %s | NOT RUN | NOT RUN | NOT RUN | — |"
                    % (name, ncell, src)
                )
            continue
        lines.append(
            "| %s | %s | %s | %s | %s | %s | %s |"
            % (
                name,
                row.get("n"),
                row.get("source") or "",
                row.get("score"),
                fmt_pct(row.get("accuracy")),
                ("%.3f" % row["latency_p50_s"]) if row.get("latency_p50_s") is not None else "—",
                row.get("n_errors", 0),
            )
        )
    lines.append("")
    if cap.get("IFEval", {}).get("instruction_level_strict_lite"):
        lines.append(
            "IFEval instruction-level strict-lite: **%s**. Grader: %s"
            % (cap["IFEval"]["instruction_level_strict_lite"], cap["IFEval"].get("grader") or "lite")
        )
        lines.append("")
    lines.append("### Run metadata")
    lines.append("")
    lines.append("| field | value |")
    lines.append("|---|---|")
    lines.append("| started_utc | %s |" % (report.get("started_utc") or ""))
    lines.append("| finished_utc | %s |" % (report.get("finished_utc") or ""))
    lines.append("| base_url | `%s` |" % (report.get("base_url") or ""))
    lines.append("| model | `%s` |" % (report.get("model") or ""))
    lines.append("| temperature | %s |" % report.get("temperature"))
    lines.append("| timeout_s | %s |" % report.get("timeout_s"))
    lines.append("| sequential | yes |")
    lines.append("| overall latency p50 (s) | %s |" % (
        ("%.3f" % report["latency_p50_s"]) if report.get("latency_p50_s") is not None else "—"
    ))
    lines.append("| client errors | %s |" % len(report.get("client_errors") or []))
    lines.append("| reachable | %s |" % report.get("reachable"))
    if report.get("note"):
        lines.append("")
        lines.append(report["note"])
    lines.append("")
    lines.append(
        "Do not claim OpenRouter live. Do not claim Galvatron-in-Flash GDN "
        "(Flash has no GDN; 64 embed-row passages is not GDN)."
    )
    lines.append("")
    return "\n".join(lines)


def selftest():
    assert extract_gsm8k_pred("blah\n#### 18") == "18"
    assert gsm8k_match("18", "18")
    assert gsm8k_match("18.0", "18")
    boxed = last_boxed("foo \\boxed{\\frac{14}{3}} bar")
    assert boxed == "\\frac{14}{3}", boxed
    ok, _ = math_match("answer is \\boxed{\\left( 3, \\frac{\\pi}{2} \\right)}",
                       r"\left( 3, \frac{\pi}{2} \right)")
    assert ok
    item = {
        "instruction_id_list": ["punctuation:no_comma"],
        "kwargs": [{}],
        "prompt": "x",
    }
    prompt_ok, flags = ifeval_score_item(item, "hello world")
    assert prompt_ok and flags == [True]
    prompt_ok, flags = ifeval_score_item(item, "hello, world")
    assert (not prompt_ok) and flags == [False]
    item2 = {
        "instruction_id_list": ["detectable_format:json_format"],
        "kwargs": [{}],
        "prompt": "x",
    }
    assert ifeval_score_item(item2, '```json\n{"a": 1}\n```')[0]
    print("selftest ok")
    return 0


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="API-only Flash HRR lite evals")
    p.add_argument("--base-url", default=os.environ.get("FLASH_EVAL_BASE_URL", LAB_PUBLIC_VLLM))
    p.add_argument("--model", default=os.environ.get("FLASH_EVAL_MODEL", LAB_MODEL_ID))
    p.add_argument("--api-key", default=os.environ.get("OPENAI_API_KEY") or os.environ.get("FLASH_EVAL_API_KEY") or "EMPTY")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    p.add_argument(
        "--suites",
        default="memory,gsm8k,math,humaneval,ifeval",
        help="comma list: memory,gsm8k,math,humaneval,ifeval,all",
    )
    p.add_argument("--out-md", default=str(HERE / "flash-hrr-benches.md"))
    p.add_argument("--out-json", default=str(RESULTS / "flash_hrr_lite.json"))
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--probe-only", action="store_true")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.selftest:
        return selftest()

    RESULTS.mkdir(parents=True, exist_ok=True)
    suites = [s.strip().lower() for s in args.suites.split(",") if s.strip()]
    if "all" in suites:
        suites = ["memory", "gsm8k", "math", "humaneval", "ifeval"]

    started = datetime.now(timezone.utc).isoformat()
    client = ChatClient(
        args.base_url, args.model, api_key=args.api_key,
        timeout=args.timeout, temperature=args.temperature,
    )
    probe = client.probe()
    report = {
        "started_utc": started,
        "base_url": args.base_url,
        "model": args.model,
        "temperature": args.temperature,
        "timeout_s": args.timeout,
        "suites": suites,
        "probe": {k: v for k, v in probe.items() if k != "body"},
        "reachable": bool(probe.get("ok")),
        "lab_sig_diff": {
            "host": LAB_HOST,
            "overlay": LAB_OVERLAY,
            "model_id": LAB_MODEL_ID,
            "public_vllm": LAB_PUBLIC_VLLM,
            "arms": LAB_SIG,
            "openrouter": "NOT RUN",
            "note": "Gateway auto-sticky on the lab box. Same overlay both arms.",
        },
        "capability": {},
        "memory_raw_vllm": None,
        "client_errors": [],
        "note": "",
    }

    if not probe.get("ok"):
        report["note"] = (
            "Live API was not reachable from this runner (%s). "
            "Harness landed for GitHub Actions / later runs. "
            "MEMORY SIG DIFF below is the lab Gateway measurement; capability is NOT RUN."
            % probe.get("error")
        )
        report["finished_utc"] = datetime.now(timezone.utc).isoformat()
        md = render_markdown(report)
        Path(args.out_md).write_text(md, encoding="utf-8")
        Path(args.out_json).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(md)
        print("wrote", args.out_md, args.out_json, file=sys.stderr)
        return 2

    if args.model not in (probe.get("models") or []) and (probe.get("models") or []):
        print(
            "warning: model %s not in /v1/models %s — sending it anyway"
            % (args.model, probe.get("models")),
            file=sys.stderr,
        )

    if args.probe_only:
        report["finished_utc"] = datetime.now(timezone.utc).isoformat()
        print(json.dumps(report, indent=2))
        return 0

    def checkpoint():
        report["latency_p50_s"] = p50(client.latencies)
        report["client_errors"] = client.errors
        md = render_markdown(report)
        Path(args.out_md).write_text(md, encoding="utf-8")
        Path(args.out_json).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return md

    if "memory" in suites:
        print("suite memory ...", file=sys.stderr)
        report["memory_raw_vllm"] = run_memory_sig(client)
        checkpoint()

    cap_map = {
        "gsm8k": ("GSM8K", run_gsm8k),
        "math": ("MATH-500", run_math),
        "humaneval": ("HumanEval", run_humaneval),
        "ifeval": ("IFEval", run_ifeval),
    }
    for key, (name, fn) in cap_map.items():
        if key not in suites:
            continue
        print("suite", name, "...", file=sys.stderr)
        report["capability"][name] = fn(client)
        checkpoint()

    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    md = checkpoint()
    print(md)
    print("wrote", args.out_md, args.out_json, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
