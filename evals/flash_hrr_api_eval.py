#!/usr/bin/env python3
"""API-only evals for in-weight HRR-on-DeepSeek V4-Flash.

Hits an OpenAI-compatible `/v1/chat/completions` endpoint. No local GPU.
Does not download Flash weights. Temperature 0, 180s timeouts, concurrency ≤2.

    python evals/flash_hrr_api_eval.py --base-url http://HOST:PORT/v1 --scale full

Headline MEMORY SIG DIFF is the lab Gateway auto-sticky measurement and is
never overwritten by a raw-vLLM probe (raw vLLM has no Gateway sticky).

Capability numbers are no-regress / quality, not the pitch. Full official
splits by default; lite slices remain behind --scale lite.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

try:
    from evals.flash_hrr_data import load_lite, load_or_fetch
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from evals.flash_hrr_data import load_lite, load_or_fetch

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
                 temperature=DEFAULT_TEMPERATURE, pause_s=0.05):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key or "EMPTY"
        self.timeout = timeout
        self.temperature = temperature
        self.pause_s = pause_s
        self.latencies = []
        self.errors = []
        self._lock = threading.Lock()

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
                payload = json.loads(raw.decode("utf-8"))
                text = (
                    payload.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content")
                    or ""
                )
                if self.pause_s:
                    time.sleep(self.pause_s)
                rec = {
                    "ok": True,
                    "text": text,
                    "elapsed": elapsed,
                    "usage": payload.get("usage") or {},
                    "raw_id": payload.get("id"),
                    "finish_reason": payload.get("choices", [{}])[0].get("finish_reason"),
                    "max_tokens": max_tokens,
                }
                with self._lock:
                    self.latencies.append(elapsed)
                return rec
        except Exception as exc:
            elapsed = time.time() - t0
            err = {"error": "%s: %s" % (type(exc).__name__, exc), "elapsed": elapsed}
            with self._lock:
                self.latencies.append(elapsed)
                self.errors.append(err)
            if self.pause_s:
                time.sleep(self.pause_s)
            return {"ok": False, "text": "", "elapsed": elapsed, "error": err["error"],
                    "max_tokens": max_tokens}

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


def chat_retry_length(client, messages, max_tokens, retry_tokens=None):
    r = client.chat(messages, max_tokens=max_tokens)
    if (
        r.get("ok")
        and r.get("finish_reason") == "length"
        and retry_tokens
        and retry_tokens > max_tokens
    ):
        r2 = client.chat(messages, max_tokens=retry_tokens)
        r2["retried_from"] = max_tokens
        return r2
    return r


def map_items(items, fn, workers=1, label="", resume_path=None):
    """Run fn(item) over items. workers=1 sequential; 2 max for the live API."""
    n = len(items)
    rows = [None] * n
    workers = max(1, min(int(workers or 1), 2))
    done = 0
    t0 = time.time()
    resume_path = Path(resume_path) if resume_path else None
    cached = {}
    if resume_path and resume_path.exists():
        for line in resume_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if "index" in rec:
                cached[rec["index"]] = rec
        if cached:
            print("  %s resume %s items" % (label or "items", len(cached)), file=sys.stderr)

    def _tick():
        nonlocal done
        done += 1
        if done == n or done % 10 == 0:
            elapsed = time.time() - t0
            print(
                "  %s %s/%s (%.1fs)" % (label or "items", done, n, elapsed),
                file=sys.stderr,
            )

    write_lock = threading.Lock()

    def _store(i, row, fresh):
        rows[i] = row
        if fresh and resume_path is not None:
            resume_path.parent.mkdir(parents=True, exist_ok=True)
            with write_lock:
                with open(resume_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row) + "\n")

    def _one(i, it):
        key = it.get("index", i)
        if key in cached:
            return cached[key], False
        return fn(it), True

    if workers <= 1:
        for i, it in enumerate(items):
            row, fresh = _one(i, it)
            _store(i, row, fresh)
            _tick()
        return rows

    lock = threading.Lock()

    def wrapped(pair):
        i, it = pair
        row, fresh = _one(i, it)
        with lock:
            _store(i, row, fresh)
            _tick()
        return i, row

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(wrapped, (i, it)) for i, it in enumerate(items)]
        for fut in as_completed(futs):
            i, row = fut.result()
            rows[i] = row
    return rows


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


def _word_count(text):
    return len((text or "").split())


def _sentence_count(text):
    """Lite sentence count (regex). Not nltk punkt / official IFEval."""
    t = (text or "").strip()
    if not t:
        return 0
    parts = re.split(r"[.!?]+\s+|\n+", t)
    return len([p for p in parts if p.strip()])


def _paragraphs_double_newline(text):
    parts = re.split(r"\n\s*\n", text or "")
    return [p.strip() for p in parts if p.strip()]


try:
    from langdetect import detect as _langdetect
except Exception:
    _langdetect = None


# ---- IFEval checkers (strict-ish, documented; not the official package) ----
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
        if _langdetect is not None:
            try:
                return _langdetect(text) == lang
            except Exception:
                return False
        # undocumented langs without langdetect: fail closed
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
    if instr_id == "keywords:frequency":
        word = str(_kw(kwargs, "keyword", default="") or "")
        n = int(_kw(kwargs, "frequency", default=0) or 0)
        rel = (_kw(kwargs, "relation", default="at least") or "at least").lower()
        if not word:
            return False
        c = len(re.findall(r"\b" + re.escape(word) + r"\b", text, flags=re.I))
        if rel == "at least":
            return c >= n
        if rel == "less than":
            return c < n
        return c == n
    if instr_id == "keywords:forbidden_words":
        words = _kw(kwargs, "forbidden_words", default=[]) or []
        low = text.lower()
        for w in words:
            if re.search(r"\b" + re.escape(str(w).lower()) + r"\b", low):
                return False
        return True
    if instr_id == "length_constraints:number_sentences":
        n = int(_kw(kwargs, "num_sentences", default=0) or 0)
        rel = (_kw(kwargs, "relation", default="at least") or "at least").lower()
        c = _sentence_count(text)
        if rel == "at least":
            return c >= n
        if rel == "less than":
            return c < n
        return c == n
    if instr_id == "length_constraints:nth_paragraph_first_word":
        n_para = int(_kw(kwargs, "num_paragraphs", default=0) or 0)
        nth = int(_kw(kwargs, "nth_paragraph", default=1) or 1)
        first = str(_kw(kwargs, "first_word", default="") or "").strip()
        paras = _paragraphs_double_newline(text)
        if n_para and len(paras) != n_para:
            return False
        if nth < 1 or nth > len(paras):
            return False
        words = re.findall(r"[A-Za-z0-9']+", paras[nth - 1])
        if not words:
            return False
        return words[0].lower() == first.lower()
    if instr_id == "detectable_content:postscript":
        marker = str(_kw(kwargs, "postscript_marker", default="P.P.S") or "P.P.S")
        return marker.lower() in text.lower()
    if instr_id == "detectable_format:constrained_response":
        t = text.strip()
        allowed = ("My answer is yes.", "My answer is no.", "My answer is maybe.")
        return t in allowed
    if instr_id == "startend:end_checker":
        phrase = str(_kw(kwargs, "end_phrase", default="") or "").strip()
        if not phrase:
            return False
        t = text.strip().strip('"').strip("'")
        return t.endswith(phrase) or t.lower().endswith(phrase.lower())
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


_MCQ_ANSWER = re.compile(
    r"(?:final\s+answer|answer|choice)\s*(?:is|:)\s*\(?([A-J])\)?",
    re.I,
)
_MCQ_BOX_LETTER = re.compile(r"\b([A-J])\b")
_AIME_NUM = re.compile(r"\d{1,3}")


def extract_mcq_letter(text, letters="ABCD"):
    """Prefer Answer: X / \\boxed{X}; last-line single letter as fallback."""
    if not text:
        return ""
    allowed = set(letters.upper())
    boxed = last_boxed(text)
    if boxed:
        m = _MCQ_BOX_LETTER.search(boxed.strip())
        if m and m.group(1).upper() in allowed:
            return m.group(1).upper()
    matches = _MCQ_ANSWER.findall(text)
    for ch in reversed(matches):
        if ch.upper() in allowed:
            return ch.upper()
    tail = "\n".join((text or "").strip().splitlines()[-4:]).strip()
    m = re.search(r"^\s*\(?([A-J])\)?\s*[.\)]?\s*$", tail, re.I | re.M)
    if m and m.group(1).upper() in allowed:
        return m.group(1).upper()
    m = re.search(r"\b([A-J])\b\s*$", tail)
    if m and m.group(1).upper() in allowed:
        return m.group(1).upper()
    return ""


def extract_aime_int(text):
    boxed = last_boxed(text)
    src = boxed if boxed else (text or "")
    nums = _AIME_NUM.findall(src.replace(",", ""))
    if not nums:
        return ""
    n = int(nums[-1]) % 1000
    return str(n)


def aime_match(pred, gold):
    if pred == "" or gold == "":
        return False
    try:
        return int(pred) % 1000 == int(str(gold).strip()) % 1000
    except ValueError:
        return str(pred).strip() == str(gold).strip()


def format_mcq_prompt(question, options, letters, think=True):
    lines = []
    if think:
        lines.append(
            "Solve the multiple-choice question. Reason briefly, then put the "
            "final choice letter in \\boxed{}."
        )
    else:
        lines.append("Answer the multiple-choice question. Put the final letter in \\boxed{}.")
    lines.append("")
    lines.append(question.strip())
    lines.append("")
    for opt in options:
        lines.append("%s. %s" % (opt["letter"], opt["text"]))
    lines.append("")
    lines.append("Choices are %s. End with \\boxed{letter}." % "/".join(letters))
    return "\n".join(lines)


def exec_lcb_item(code, tests, metadata=None, timeout=8, max_tests=40):
    """Run stdin or functional tests. Returns (ok, err, n_run, n_pass)."""
    metadata = metadata or {}
    fn_name = metadata.get("func_name") or metadata.get("fn_name")
    tests = list(tests or [])[:max_tests]
    if not tests:
        return False, "no tests", 0, 0
    n_pass = 0
    last_err = ""
    for i, t in enumerate(tests):
        if not isinstance(t, dict):
            last_err = "bad test %s" % i
            break
        ttype = (t.get("testtype") or t.get("test_type") or "stdin").lower()
        stdin = t.get("input") if "input" in t else t.get("stdin") or ""
        expected = t.get("output") if "output" in t else t.get("stdout") or ""
        if isinstance(stdin, (list, dict)):
            stdin = json.dumps(stdin)
        if isinstance(expected, (list, dict)):
            expected = json.dumps(expected)
        stdin = "" if stdin is None else str(stdin)
        expected = "" if expected is None else str(expected)
        if ttype in ("functional", "function"):
            ok, err = _exec_lcb_functional(code, stdin, expected, fn_name, timeout)
        else:
            ok, err = _exec_lcb_stdin(code, stdin, expected, timeout)
        if not ok:
            last_err = err or ("fail test %s" % i)
            break
        n_pass += 1
    return n_pass == len(tests), last_err, len(tests), n_pass


def _exec_lcb_stdin(code, stdin, expected, timeout):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
        fh.write(code)
        path = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, path],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        got = proc.stdout or ""
        if proc.returncode != 0:
            return False, (proc.stderr or "exit %s" % proc.returncode)[-400:]
        if got.strip() == expected.strip():
            return True, ""
        g_lines = [ln.rstrip() for ln in got.strip().splitlines()]
        e_lines = [ln.rstrip() for ln in expected.strip().splitlines()]
        if g_lines == e_lines:
            return True, ""
        return False, "stdout mismatch"
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _exec_lcb_functional(code, raw_input, expected, fn_name, timeout):
    fn = fn_name or "solution"
    script = (
        code
        + "\n\n"
        + "import json as _json\n"
        + "_inp = %r\n" % (raw_input,)
        + "try:\n"
        + "    _args = _json.loads(_inp)\n"
        + "except Exception:\n"
        + "    _args = _inp\n"
        + "if not isinstance(_args, (list, tuple)):\n"
        + "    _args = [_args]\n"
        + "_out = %s(*_args)\n" % fn
        + "print(_out)\n"
    )
    return _exec_lcb_stdin(script, "", expected, timeout)


# ===========================================================================
# Suites
# ===========================================================================
def load_slice(name):
    path = DATA / name
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_suite_data(key, scale):
    if scale == "lite" and key in ("gsm8k", "math", "humaneval", "ifeval"):
        return load_lite(key)
    return load_or_fetch(key)


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


def _limit_items(sl, n):
    items = list(sl.get("items") or [])
    if n is not None and n >= 0:
        items = items[:n]
    coverage = sl.get("coverage") or "unknown"
    if n is not None and sl.get("n") and n < sl["n"]:
        coverage = "first-n"
    return items, coverage


def _resume_path(name):
    RESULTS.mkdir(parents=True, exist_ok=True)
    slug = name.lower().replace(" ", "_").replace("-", "_")
    return RESULTS / ("resume_%s.jsonl" % slug)


def run_gsm8k(client, n=None, scale="full", workers=1):
    sl = _load_suite_data("gsm8k", scale)
    items, coverage = _limit_items(sl, n)

    def one(it):
        prompt = (
            "Solve the following grade-school math problem. Show brief working. "
            "Put the final numeric answer on its own line after ####.\n\n"
            + it["question"]
        )
        r = client.chat([{"role": "user", "content": prompt}], max_tokens=512)
        pred = extract_gsm8k_pred(r.get("text") or "")
        ok = bool(r.get("ok")) and gsm8k_match(pred, it["gold"])
        return {
            "index": it["index"],
            "gold": it["gold"],
            "pred": pred,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label="GSM8K", resume_path=_resume_path("GSM8K"))
    packed = _pack(sl, rows, "GSM8K")
    packed["coverage"] = coverage
    return packed


def run_math(client, n=None, scale="full", workers=1):
    sl = _load_suite_data("math", scale)
    items, coverage = _limit_items(sl, n)

    def one(it):
        prompt = (
            "Solve the following competition math problem. Put the final answer "
            "in \\boxed{}.\n\n" + it["problem"]
        )
        r = chat_retry_length(
            client, [{"role": "user", "content": prompt}],
            max_tokens=2048, retry_tokens=4096,
        )
        correct, cand = math_match(r.get("text") or "", it["answer"])
        ok = bool(r.get("ok")) and correct
        return {
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
            "max_tokens": r.get("max_tokens"),
            "retried_from": r.get("retried_from"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label="MATH-500", resume_path=_resume_path("MATH-500"))
    packed = _pack(sl, rows, "MATH-500")
    packed["max_tokens"] = "2048, retry 4096 on length"
    packed["coverage"] = coverage
    return packed


def run_humaneval(client, n=None, scale="full", workers=1):
    sl = _load_suite_data("humaneval", scale)
    items, coverage = _limit_items(sl, n)

    def one(it):
        prompt = (
            "Complete the following Python function. Return only code "
            "(the full function), no explanation.\n\n```python\n"
            + it["prompt"]
            + "```\n"
        )
        r = chat_retry_length(
            client, [{"role": "user", "content": prompt}],
            max_tokens=1024, retry_tokens=2048,
        )
        passed, err = (False, "request failed")
        if r.get("ok"):
            passed, err = exec_humaneval_item(
                it["prompt"], r.get("text") or "", it["test"], it["entry_point"]
            )
        return {
            "index": it["index"],
            "task_id": it["task_id"],
            "entry_point": it["entry_point"],
            "correct": bool(passed),
            "exec_error": err or "",
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label="HumanEval", resume_path=_resume_path("HumanEval"))
    packed = _pack(sl, rows, "HumanEval")
    packed["coverage"] = coverage
    return packed


def run_ifeval(client, n=None, scale="full", workers=1):
    sl = _load_suite_data("ifeval", scale)
    items, coverage = _limit_items(sl, n)

    def one(it):
        r = chat_retry_length(
            client, [{"role": "user", "content": it["prompt"]}],
            max_tokens=2048, retry_tokens=4096,
        )
        prompt_ok, flags = ifeval_score_item(it, r.get("text") or "")
        ok = bool(r.get("ok")) and prompt_ok
        return {
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
        }

    rows = map_items(items, one, workers=workers, label="IFEval", resume_path=_resume_path("IFEval"))
    packed = _pack(sl, rows, "IFEval")
    inst_total = sum(len(r["instruction_flags"]) for r in rows)
    inst_ok = sum(sum(1 for f in r["instruction_flags"] if f) for r in rows)
    packed["instruction_level_strict_lite"] = (
        "%s/%s" % (inst_ok, inst_total) if inst_total else "0/0"
    )
    packed["grader"] = (
        "in-repo IFEval checkers in evals/flash_hrr_api_eval.py (strict-ish; "
        "json allows a single markdown fence; Kannada via Unicode block U+0C80–U+0CFF; "
        "other languages via langdetect if installed else fail-closed; "
        "sentence count is regex not nltk; not the official google-research package)"
    )
    packed["coverage"] = coverage
    return packed


def run_gpqa(client, n=None, scale="full", workers=1):
    sl = load_or_fetch("gpqa")
    items, coverage = _limit_items(sl, n)

    def one(it):
        prompt = format_mcq_prompt(it["question"], it["options"], "ABCD")
        r = chat_retry_length(
            client, [{"role": "user", "content": prompt}],
            max_tokens=2048, retry_tokens=4096,
        )
        pred = extract_mcq_letter(r.get("text") or "", "ABCD")
        ok = bool(r.get("ok")) and pred == it["gold"]
        return {
            "index": it["index"],
            "record_id": it.get("record_id"),
            "domain": it.get("domain"),
            "gold": it["gold"],
            "pred": pred,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label="GPQA-Diamond", resume_path=_resume_path("GPQA-Diamond"))
    packed = _pack(sl, rows, "GPQA-Diamond")
    packed["coverage"] = coverage
    packed["grader"] = (
        "A-D letter extract; choices shuffled sha256(Record ID); n_repeats=1; "
        "item text omitted from traces (GPQA anti-contamination)"
    )
    packed["note"] = sl.get("note")
    return packed


def run_mmlupro(client, n=None, scale="full", workers=1):
    sl = load_or_fetch("mmlupro")
    items, coverage = _limit_items(sl, n)
    letters = "ABCDEFGHIJ"

    def one(it):
        used = [opt["letter"] for opt in it["options"]]
        prompt = format_mcq_prompt(it["question"], it["options"], "".join(used))
        r = chat_retry_length(
            client, [{"role": "user", "content": prompt}],
            max_tokens=1024, retry_tokens=2048,
        )
        pred = extract_mcq_letter(r.get("text") or "", letters)
        ok = bool(r.get("ok")) and pred == it["gold"]
        return {
            "index": it["index"],
            "question_id": it.get("question_id"),
            "category": it.get("category"),
            "gold": it["gold"],
            "pred": pred,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label="MMLU-Pro", resume_path=_resume_path("MMLU-Pro"))
    packed = _pack(sl, rows, "MMLU-Pro")
    packed["coverage"] = coverage
    packed["grader"] = "letter extract A-J vs dataset answer; n_repeats=1"
    return packed


def _run_aime(client, key, name, n=None, workers=1):
    sl = load_or_fetch(key)
    items, coverage = _limit_items(sl, n)

    def one(it):
        prompt = (
            "Solve the following AIME problem. The answer is an integer from "
            "000 to 999. Put the integer in \\boxed{}.\n\n" + it["problem"]
        )
        r = chat_retry_length(
            client, [{"role": "user", "content": prompt}],
            max_tokens=4096, retry_tokens=8192,
        )
        pred = extract_aime_int(r.get("text") or "")
        ok = bool(r.get("ok")) and aime_match(pred, it["gold"])
        return {
            "index": it["index"],
            "id": it.get("id"),
            "gold": it["gold"],
            "pred": pred,
            "correct": ok,
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "max_tokens": r.get("max_tokens"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label=name, resume_path=_resume_path(name))
    packed = _pack(sl, rows, name)
    packed["coverage"] = coverage
    packed["note"] = sl.get("note")
    packed["max_tokens"] = "4096, retry 8192 on length"
    return packed


def run_aime24(client, n=None, scale="full", workers=1):
    return _run_aime(client, "aime24", "AIME 2024", n=n, workers=workers)


def run_aime25(client, n=None, scale="full", workers=1):
    return _run_aime(client, "aime25", "AIME 2025", n=n, workers=workers)


def run_lcb(client, n=None, scale="full", workers=1):
    sl = load_or_fetch("lcb")
    items, coverage = _limit_items(sl, n)

    def one(it):
        starter = it.get("starter_code") or ""
        q = it.get("question_content") or ""
        prompt = (
            "Write a Python 3 solution for the following programming problem. "
            "Return only code, no explanation.\n\n"
            "### Question\n%s\n" % q
        )
        if starter.strip():
            prompt += "\n### Starter code\n```python\n%s\n```\n" % starter
        prompt += (
            "\nRead from stdin and write to stdout if the problem is a standard "
            "input program. If starter code defines a function, implement that function."
        )
        r = chat_retry_length(
            client, [{"role": "user", "content": prompt}],
            max_tokens=2048, retry_tokens=4096,
        )
        tests = list(it.get("public_test_cases") or [])
        priv_status = it.get("private_status") or "none"
        if priv_status == "decoded":
            tests = tests + list(it.get("private_test_cases") or [])
        passed, err, n_run, n_pass = (False, "request failed", 0, 0)
        if r.get("ok"):
            code = strip_fences(r.get("text") or "")
            if starter.strip() and not code.strip().startswith(("def ", "class ", "import ", "from ")):
                code = starter + "\n" + code
            passed, err, n_run, n_pass = exec_lcb_item(
                code, tests, it.get("metadata") or {}, timeout=8, max_tests=40
            )
        return {
            "index": it["index"],
            "question_id": it.get("question_id"),
            "difficulty": it.get("difficulty"),
            "contest_date": it.get("contest_date"),
            "private_status": priv_status,
            "n_tests_run": n_run,
            "n_tests_pass": n_pass,
            "correct": bool(passed),
            "exec_error": err or "",
            "elapsed": r.get("elapsed"),
            "error": r.get("error"),
            "finish_reason": r.get("finish_reason"),
            "text_head": (r.get("text") or "")[:240],
        }

    rows = map_items(items, one, workers=workers, label="LiveCodeBench", resume_path=_resume_path("LiveCodeBench"))
    packed = _pack(sl, rows, "LiveCodeBench")
    packed["coverage"] = coverage
    packed["grader"] = sl.get("grader")
    packed["lcb_version"] = sl.get("lcb_version")
    packed["n_private_decoded"] = sl.get("n_private_decoded")
    packed["n_private_skipped"] = sl.get("n_private_skipped")
    packed["files"] = sl.get("files")
    return packed


def _pack(sl, rows, name):
    n = len(rows)
    correct = sum(1 for r in rows if r.get("correct"))
    lats = [r["elapsed"] for r in rows if r.get("elapsed") is not None]
    errs = [r for r in rows if r.get("error")]
    full_n = sl.get("n")
    coverage = sl.get("coverage") or "unknown"
    if full_n and n < full_n:
        coverage = "first-n"
    return {
        "name": name,
        "n": n,
        "split_n": full_n,
        "correct": correct,
        "accuracy": (correct / n) if n else None,
        "score": "%s/%s" % (correct, n),
        "source": sl.get("source"),
        "canonical": sl.get("canonical"),
        "split": sl.get("split"),
        "offset": sl.get("offset", 0),
        "coverage": coverage,
        "latency_p50_s": p50(lats),
        "n_errors": len(errs),
        "errors": [{"index": e.get("index"), "error": e.get("error")} for e in errs[:50]],
        "items": rows,
        "note": sl.get("note"),
    }


# ===========================================================================
# Report
# ===========================================================================
def fmt_pct(acc):
    if acc is None:
        return "NOT RUN"
    return "%.1f%%" % (100.0 * acc)


CAP_ORDER = [
    "MMLU-Pro",
    "GPQA-Diamond",
    "AIME 2024",
    "AIME 2025",
    "LiveCodeBench",
    "GSM8K",
    "MATH-500",
    "HumanEval",
    "IFEval",
]

CAP_DEFAULTS = {
    "MMLU-Pro": ("12032", "TIGER-Lab/MMLU-Pro test (full)"),
    "GPQA-Diamond": ("198", "Idavidrein/gpqa Diamond via OpenAI simple-evals CSV"),
    "AIME 2024": ("30", "HuggingFaceH4/aime_2024 (AIME I 2024, 30 not 60)"),
    "AIME 2025": ("30", "math-ai/aime25 test"),
    "LiveCodeBench": ("—", "livecodebench/code_generation_lite v5_v6"),
    "GSM8K": ("1319", "openai/gsm8k test (full)"),
    "MATH-500": ("500", "HuggingFaceH4/MATH-500 test (full)"),
    "HumanEval": ("164", "openai/openai_humaneval test (full)"),
    "IFEval": ("541", "google/IFEval train (full)"),
}


def _coverage_cell(row):
    cov = row.get("coverage") or ""
    split_n = row.get("split_n")
    n = row.get("n")
    if cov == "full" or (split_n and n == split_n):
        return "full"
    if cov == "full-file":
        return "full-file"
    if cov == "first-n":
        return "first-n (n=%s of %s)" % (n, split_n or "?")
    if cov == "lite-slice":
        return "lite-slice"
    if cov == "subset-files":
        return "subset-files"
    return cov or "—"


def _cap_table_rows(report):
    cap = report.get("capability") or {}
    lines = []
    lines.append(
        "| bench | n | coverage | source | score | accuracy | latency p50 (s) | errors |"
    )
    lines.append("|---|---|---|---|---|---|---|---|")
    for name in CAP_ORDER:
        row = cap.get(name)
        if not row:
            ncell, src = CAP_DEFAULTS[name]
            lines.append(
                "| %s | %s | — | %s | NOT RUN | NOT RUN | NOT RUN | — |"
                % (name, ncell, src)
            )
            continue
        src = (row.get("source") or CAP_DEFAULTS[name][1]).replace("|", "/")
        if len(src) > 90:
            src = src[:87] + "..."
        lines.append(
            "| %s | %s | %s | %s | %s | %s | %s | %s |"
            % (
                name,
                row.get("n"),
                _coverage_cell(row),
                src,
                row.get("score"),
                fmt_pct(row.get("accuracy")),
                ("%.3f" % row["latency_p50_s"]) if row.get("latency_p50_s") is not None else "—",
                row.get("n_errors", 0),
            )
        )
    return lines


def render_markdown(report):
    cap = report.get("capability") or {}
    mem = report.get("memory_raw_vllm")
    probe = report.get("probe") or {}
    lines = []
    lines.append("# Flash HRR benches")
    lines.append("")
    lines.append(
        "In-weight holographic reduced representation (HRR) overlay on "
        "DeepSeek-V4-Flash-0731-serve — not a new pretrained LLM."
    )
    lines.append("")
    lines.append("## Capability evals (raw vLLM, temp 0)")
    lines.append("")
    lines.append(
        "Quality numbers so the card is not empty of ordinary benches. They may be "
        "flat vs published Flash. **Not** the pitch. High-bar sets first "
        "(MMLU-Pro / GPQA-Diamond / AIME / LiveCodeBench); GSM8K / MATH-500 / "
        "HumanEval / IFEval are the floor. Coverage is **full** or **first-n** — "
        "never quote a lite n=20 leftover as the card. SWE-bench / Terminal-Bench / "
        "DeepSWE / OSWorld: harness gap — not attempted, not claimed. "
        "OG commodity OpenRouter was **not run** — empty, not invented."
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
    lines.extend(_cap_table_rows(report))
    lines.append("")
    math_row = cap.get("MATH-500") or {}
    math_items = math_row.get("items") or []
    n_len = sum(1 for it in math_items if it.get("finish_reason") == "length")
    if n_len:
        lines.append(
            "MATH-500: %s/%s items still `finish_reason=length` after 4096 retry "
            "(counted as misses)."
            % (n_len, math_row.get("n"))
        )
        lines.append("")
    if cap.get("IFEval", {}).get("instruction_level_strict_lite"):
        lines.append(
            "IFEval instruction-level strict-lite: **%s**. Grader: %s"
            % (cap["IFEval"]["instruction_level_strict_lite"], cap["IFEval"].get("grader") or "lite")
        )
        lines.append("")
    if cap.get("LiveCodeBench"):
        lcb = cap["LiveCodeBench"]
        lines.append(
            "LiveCodeBench: version `%s`, private decoded %s, private skipped %s. %s"
            % (
                lcb.get("lcb_version"),
                lcb.get("n_private_decoded"),
                lcb.get("n_private_skipped"),
                lcb.get("grader") or "",
            )
        )
        lines.append("")
    if cap.get("GPQA-Diamond", {}).get("grader"):
        lines.append("GPQA-Diamond grader: %s" % cap["GPQA-Diamond"]["grader"])
        lines.append("")
    if cap.get("AIME 2024", {}).get("note"):
        lines.append("AIME 2024: %s" % cap["AIME 2024"]["note"])
        lines.append("")
    lines.append("## MEMORY SIG DIFF")
    lines.append("")
    lines.append(
        "Measured on the **live in-weight overlay** through **Gateway auto-sticky** "
        "(no extra headers for the ON lane). This is the differentiator."
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
        "SWE-bench / Terminal-Bench / DeepSWE / OSWorld: harness gap — not attempted, not claimed."
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
    src_lines = []
    for name in CAP_ORDER:
        row = cap.get(name) or {}
        if row.get("source"):
            src_lines.append(
                "- **%s** (n=%s, coverage=%s): %s"
                % (name, row.get("n"), _coverage_cell(row), row.get("source"))
            )
    if src_lines:
        lines.append("### Exact prompt sources for rows that ran")
        lines.append("")
        lines.extend(src_lines)
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
    lines.append("| concurrency | %s |" % (report.get("concurrency") or 1))
    lines.append("| scale | %s |" % (report.get("scale") or ""))
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


def render_hf_fragment(report):
    cap = report.get("capability") or {}
    mem = report.get("memory_raw_vllm")
    lines = []
    lines.append("# Hugging Face model card fragment — in-weight HRR on DeepSeek V4-Flash")
    lines.append("")
    lines.append(
        "**Base model:** DeepSeek-V4-Flash-0731 (`DeepSeek-V4-Flash-0731-serve`)  "
    )
    lines.append("**License:** MIT (DeepSeek V4)  ")
    lines.append(
        "**This card:** holographic reduced representation (HRR) overlay in the served "
        "weights, plus a Gateway that can auto-stick memory across turns."
    )
    lines.append("")
    lines.append(
        "This is not a new pretrained LLM. It is Flash with an in-weight HRR overlay. "
        "Do **not** read the numbers below as an OpenRouter live listing — OpenRouter "
        "was not run. Do **not** read 64 embed-row passages as Galvatron-in-Flash GDN. "
        "Flash has no GDN."
    )
    lines.append("")
    lines.append("## Evals (raw vLLM, temperature 0)")
    lines.append("")
    lines.append(
        "Host `http://198.145.108.57:30739/v1`, model "
        "`/workspace/models/DeepSeek-V4-Flash-0731-serve`. Sequential or conc≤2. "
        "Coverage column says **full** vs **first-n** — do not read a first-n score "
        "as a full-set published number. SWE-bench / Terminal-Bench / DeepSWE / "
        "OSWorld not attempted (harness gap)."
    )
    lines.append("")
    lines.extend(_cap_table_rows(report))
    lines.append("")
    if cap.get("IFEval", {}).get("instruction_level_strict_lite"):
        lines.append(
            "IFEval is an in-repo checker (not official google-research); "
            "instruction-level strict-lite **%s**."
            % cap["IFEval"]["instruction_level_strict_lite"]
        )
        lines.append("")
    if cap.get("LiveCodeBench"):
        lcb = cap["LiveCodeBench"]
        lines.append(
            "LiveCodeBench is `code_generation_lite` `%s` (n=%s), local Python "
            "exec of public tests plus decoded private tests when the blob is small "
            "enough — not the official `lcb_runner` package. pass@1, one sample."
            % (lcb.get("lcb_version"), lcb.get("n"))
        )
        lines.append("")
    if cap.get("GPQA-Diamond"):
        lines.append(
            "GPQA-Diamond is the 198-item Diamond split (OpenAI simple-evals CSV), "
            "n_repeats=1, A–D shuffled from sha256(Record ID). Item text is not "
            "republished in traces."
        )
        lines.append("")
    if cap.get("AIME 2024", {}).get("note"):
        lines.append(cap["AIME 2024"]["note"])
        lines.append("")
    lines.append("HTTP errors on rows that ran: see the errors column. Traces: "
                 "`evals/results/flash_hrr_full.json` in leCore.")
    lines.append("")
    lines.append("## What HRR is for (plain)")
    lines.append("")
    lines.append("- **Sticky memory.** Facts bound into the overlay can be recalled on a later turn without pasting the transcript back, when the Gateway auto-sticky lane is on.")
    lines.append("- **Bind / unbind.** A role and a filler become one vector (`bind`); `unbind` pulls the filler back. That is how a nonce, a citation, or a slot value is stored and cited.")
    lines.append("- **Damage-tolerant state.** The overlay is holographic: partial or noisy traces still retrieve, instead of a hard key miss.")
    lines.append("")
    lines.append("The pitch is that memory, not a GSM8K bump.")
    lines.append("")
    lines.append("## MEMORY SIG DIFF (differentiator)")
    lines.append("")
    lines.append(
        "Measured on the **live in-weight overlay** through **Gateway auto-sticky** "
        "(no extra headers for the ON lane). Host: lab Gateway `http://127.0.0.1:8765/v1`. "
        "Same overlay both arms: `DeepSeek-V4-Flash-0731-serve`. Public raw vLLM "
        "(no Gateway): `http://198.145.108.57:30739/v1`."
    )
    lines.append("")
    lines.append("| arm | T2 nonce cite | Multi-turn 3-cite | Re-prompts |")
    lines.append("|---|---|---|---|")
    lines.append("| sticky OFF | 0/5 | 0/3 | must re-paste the citations |")
    lines.append("| sticky ON | 5/5 | 3/3 | 1 ask, no paste |")
    lines.append("| OG commodity OpenRouter | NOT RUN | NOT RUN | NOT RUN |")
    lines.append("")
    if mem:
        lines.append(
            "Raw vLLM does not auto-sticky. A nonce remember/recall against `:30739` "
            "with a fresh request (no client history) scored **%s**. That is not a "
            "regression of the Gateway table above."
            % mem.get("score")
        )
    else:
        lines.append(
            "Raw vLLM does not auto-sticky. A nonce remember/recall against `:30739` "
            "with a fresh request is expected to miss; that is not a regression of "
            "the Gateway table above."
        )
    lines.append("")
    lines.append(
        "SWE-bench / Terminal-Bench: harness gap — not attempted, not claimed."
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
    assert extract_mcq_letter("reasoning\n\\boxed{C}") == "C"
    assert extract_mcq_letter("Answer: B") == "B"
    assert extract_aime_int("blah \\boxed{204}") == "204"
    assert aime_match("204", "204")
    item3 = {
        "instruction_id_list": ["keywords:forbidden_words"],
        "kwargs": [{"forbidden_words": ["banana"]}],
        "prompt": "x",
    }
    assert ifeval_score_item(item3, "hello world")[0]
    assert not ifeval_score_item(item3, "a banana split")[0]
    item4 = {
        "instruction_id_list": ["detectable_format:constrained_response"],
        "kwargs": [{}],
        "prompt": "x",
    }
    assert ifeval_score_item(item4, "My answer is yes.")[0]
    ok_lcb, err, n_run, n_pass = exec_lcb_item(
        "print(int(input())+1)\n",
        [{"input": "1\n", "output": "2\n", "testtype": "stdin"}],
        timeout=5,
    )
    assert ok_lcb and n_pass == 1, (ok_lcb, err, n_run, n_pass)
    print("selftest ok")
    return 0


FULL_SUITES = [
    "memory", "mmlupro", "gpqa", "aime24", "aime25", "lcb",
    "gsm8k", "math", "humaneval", "ifeval",
]
LITE_SUITES = ["memory", "gsm8k", "math", "humaneval", "ifeval"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="API-only Flash HRR evals")
    p.add_argument("--base-url", default=os.environ.get("FLASH_EVAL_BASE_URL", LAB_PUBLIC_VLLM))
    p.add_argument("--model", default=os.environ.get("FLASH_EVAL_MODEL", LAB_MODEL_ID))
    p.add_argument("--api-key", default=os.environ.get("OPENAI_API_KEY") or os.environ.get("FLASH_EVAL_API_KEY") or "EMPTY")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    p.add_argument(
        "--suites",
        default="all",
        help="comma list: memory,mmlupro,gpqa,aime24,aime25,lcb,gsm8k,math,humaneval,ifeval,all",
    )
    p.add_argument("--scale", choices=("full", "lite"), default="full")
    p.add_argument("--n", type=int, default=None, help="optional per-suite item cap (first-n)")
    p.add_argument("--concurrency", type=int, default=2, help="1 or 2 (API max)")
    p.add_argument("--out-md", default=str(HERE / "flash-hrr-benches.md"))
    p.add_argument("--out-json", default=str(RESULTS / "flash_hrr_full.json"))
    p.add_argument("--out-hf", default=str(HERE / "HF-README-FRAGMENT.md"))
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--probe-only", action="store_true")
    p.add_argument("--fetch-only", action="store_true")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.selftest:
        return selftest()

    RESULTS.mkdir(parents=True, exist_ok=True)
    if args.scale == "lite" and args.out_json == str(RESULTS / "flash_hrr_full.json"):
        args.out_json = str(RESULTS / "flash_hrr_lite.json")

    suites = [s.strip().lower() for s in args.suites.split(",") if s.strip()]
    if "all" in suites:
        suites = list(LITE_SUITES if args.scale == "lite" else FULL_SUITES)

    workers = max(1, min(int(args.concurrency or 1), 2))
    n_cap = args.n

    if args.fetch_only:
        keys = []
        for s in suites:
            if s == "memory":
                continue
            keys.append({"aime24": "aime24", "aime25": "aime25", "lcb": "lcb",
                         "mmlupro": "mmlupro", "gpqa": "gpqa", "gsm8k": "gsm8k",
                         "math": "math", "humaneval": "humaneval", "ifeval": "ifeval"}[s])
        for k in keys:
            if args.scale == "lite" and k in ("gsm8k", "math", "humaneval", "ifeval"):
                continue
            sl = load_or_fetch(k)
            print("%s n=%s" % (k, sl.get("n")))
        return 0

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
        "concurrency": workers,
        "scale": args.scale,
        "n_cap": n_cap,
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

    def write_outputs(md=None):
        md = md if md is not None else render_markdown(report)
        Path(args.out_md).write_text(md, encoding="utf-8")
        Path(args.out_hf).write_text(render_hf_fragment(report), encoding="utf-8")
        # Drop bulky generations from the committed summary? Keep items (traces).
        Path(args.out_json).write_text(json.dumps(report, indent=2), encoding="utf-8")
        return md

    if not probe.get("ok"):
        report["note"] = (
            "Live API was not reachable from this runner (%s). "
            "Harness landed for GitHub Actions / later runs. "
            "MEMORY SIG DIFF below is the lab Gateway measurement; capability is NOT RUN."
            % probe.get("error")
        )
        report["finished_utc"] = datetime.now(timezone.utc).isoformat()
        md = write_outputs()
        print(md)
        print("wrote", args.out_md, args.out_json, args.out_hf, file=sys.stderr)
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
        report["client_errors"] = list(client.errors)
        return write_outputs()

    if "memory" in suites:
        print("suite memory ...", file=sys.stderr)
        report["memory_raw_vllm"] = run_memory_sig(client)
        checkpoint()

    cap_map = [
        ("mmlupro", "MMLU-Pro", run_mmlupro),
        ("gpqa", "GPQA-Diamond", run_gpqa),
        ("aime24", "AIME 2024", run_aime24),
        ("aime25", "AIME 2025", run_aime25),
        ("lcb", "LiveCodeBench", run_lcb),
        ("gsm8k", "GSM8K", run_gsm8k),
        ("math", "MATH-500", run_math),
        ("humaneval", "HumanEval", run_humaneval),
        ("ifeval", "IFEval", run_ifeval),
    ]
    # Run high-bar smaller sets first so a timeout still leaves AIME/GPQA/LCB.
    run_order = [
        "aime24", "aime25", "gpqa", "humaneval", "lcb",
        "math", "ifeval", "gsm8k", "mmlupro",
    ]
    by_key = {k: (name, fn) for k, name, fn in cap_map}
    ordered = [k for k in run_order if k in suites] + [
        k for k in suites if k in by_key and k not in run_order
    ]
    kw = {"n": n_cap, "scale": args.scale, "workers": workers}
    for key in ordered:
        name, fn = by_key[key]
        print("suite", name, "...", file=sys.stderr)
        try:
            report["capability"][name] = fn(client, **kw)
        except Exception as exc:
            traceback.print_exc()
            report["capability"][name] = {
                "name": name,
                "n": 0,
                "correct": 0,
                "accuracy": None,
                "score": "NOT RUN",
                "source": "suite crashed: %s: %s" % (type(exc).__name__, exc),
                "coverage": "error",
                "n_errors": 1,
                "errors": [{"error": "%s: %s" % (type(exc).__name__, exc)}],
                "items": [],
            }
        checkpoint()

    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    md = checkpoint()
    print(md)
    print("wrote", args.out_md, args.out_json, args.out_hf, file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
