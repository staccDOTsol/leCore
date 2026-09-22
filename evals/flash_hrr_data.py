#!/usr/bin/env python3
"""Fetch / cache official-ish Flash HRR eval splits. API-only; no Flash weights.

Caches JSON under evals/data/cache/ (gitignored). GPQA Diamond is pulled from the
OpenAI simple-evals Azure CSV (n=198), not the gated HF repo. LiveCodeBench streams
HuggingFace jsonl and keeps a compact cache (public tests always; private tests when
the encoded blob is small enough to decode in-process).
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import pickle
import sys
import urllib.error
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
CACHE = DATA / "cache"

HF_ROWS = "https://datasets-server.huggingface.co/rows"
HF_RESOLVE = "https://huggingface.co/datasets/{repo}/resolve/main/{path}"
GPQA_CSV = "https://openaipublic.blob.core.windows.net/simple-evals/gpqa_diamond.csv"
LCB_REPO = "livecodebench/code_generation_lite"
LCB_FILES = {
    "v1": "test.jsonl",
    "v2": "test2.jsonl",
    "v3": "test3.jsonl",
    "v4": "test4.jsonl",
    "v5": "test5.jsonl",
    "v6": "test6.jsonl",
}
LCB_RELEASE = {
    "release_v1": ["v1"],
    "release_v2": ["v1", "v2"],
    "release_v3": ["v1", "v2", "v3"],
    "release_v4": ["v1", "v2", "v3", "v4"],
    "release_v5": ["v1", "v2", "v3", "v4", "v5"],
    "release_v6": ["v1", "v2", "v3", "v4", "v5", "v6"],
    "release_latest": ["v1", "v2", "v3", "v4", "v5", "v6"],
    "v6": ["v6"],
    "v5_v6": ["v5", "v6"],
}

# Encoded private-test blobs bigger than this skip decode and score public-only.
LCB_PRIVATE_MAX_ENCODED = 2_000_000

UA = {"User-Agent": "lecore-flash-hrr-eval/1.0"}


def _urlopen(url, timeout=120, headers=None):
    hdrs = dict(UA)
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    return urllib.request.urlopen(req, timeout=timeout)


def http_get(url, timeout=120):
    last = None
    for attempt in range(5):
        try:
            with _urlopen(url, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:
            last = exc
            if attempt == 4:
                raise
    raise last


def http_json(url, timeout=120):
    return json.loads(http_get(url, timeout=timeout).decode("utf-8"))


def cache_path(name):
    CACHE.mkdir(parents=True, exist_ok=True)
    return CACHE / name


def save_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def fetch_hf_rows(dataset, config, split, map_row, page=100):
    """Paginate HuggingFace datasets-server. Returns list of mapped items."""
    items = []
    offset = 0
    total = None
    while True:
        url = (
            "%s?dataset=%s&config=%s&split=%s&offset=%s&length=%s"
            % (
                HF_ROWS,
                urllib.request.quote(dataset, safe="/"),
                urllib.request.quote(config, safe=""),
                urllib.request.quote(split, safe=""),
                offset,
                page,
            )
        )
        payload = http_json(url, timeout=120)
        if payload.get("error"):
            raise RuntimeError("HF rows %s: %s" % (dataset, payload.get("error")))
        if total is None:
            total = int(payload.get("num_rows_total") or 0)
        rows = payload.get("rows") or []
        if not rows:
            break
        for rec in rows:
            row = rec.get("row") or rec
            items.append(map_row(len(items), row))
        offset += len(rows)
        print("  %s %s/%s" % (dataset, offset, total or "?"), file=sys.stderr)
        if total and offset >= total:
            break
        if len(rows) < page:
            break
    return items


def _gsm8k_gold(answer_full):
    if "####" in answer_full:
        tail = answer_full.split("####")[-1].strip().replace(",", "")
        return tail.split()[0] if tail.split() else ""
    return ""


def fetch_gsm8k():
    items = fetch_hf_rows(
        "openai/gsm8k",
        "main",
        "test",
        lambda i, row: {
            "index": i,
            "question": row["question"],
            "gold": _gsm8k_gold(row.get("answer") or ""),
            "answer_full": row.get("answer") or "",
        },
    )
    return {
        "source": "openai/gsm8k main/test via HuggingFace datasets-server (full test)",
        "canonical": "https://huggingface.co/datasets/openai/gsm8k",
        "split": "test",
        "offset": 0,
        "coverage": "full",
        "n": len(items),
        "items": items,
    }


def fetch_math500():
    items = fetch_hf_rows(
        "HuggingFaceH4/MATH-500",
        "default",
        "test",
        lambda i, row: {
            "index": i,
            "unique_id": row.get("unique_id"),
            "problem": row["problem"],
            "answer": row["answer"],
            "subject": row.get("subject"),
            "level": row.get("level"),
        },
    )
    return {
        "source": "HuggingFaceH4/MATH-500 test via HuggingFace datasets-server (full, n=500)",
        "canonical": "https://huggingface.co/datasets/HuggingFaceH4/MATH-500",
        "split": "test",
        "offset": 0,
        "coverage": "full",
        "n": len(items),
        "items": items,
    }


def fetch_humaneval():
    items = fetch_hf_rows(
        "openai/openai_humaneval",
        "openai_humaneval",
        "test",
        lambda i, row: {
            "index": i,
            "task_id": row["task_id"],
            "prompt": row["prompt"],
            "test": row["test"],
            "entry_point": row["entry_point"],
        },
    )
    return {
        "source": "openai/openai_humaneval test via HuggingFace datasets-server (full, n=164)",
        "canonical": "https://huggingface.co/datasets/openai/openai_humaneval",
        "split": "test",
        "offset": 0,
        "coverage": "full",
        "n": len(items),
        "items": items,
    }


def _ifeval_kwargs(kwargs_list):
    out = []
    for kw in kwargs_list or []:
        if not isinstance(kw, dict):
            out.append({})
            continue
        cleaned = {k: v for k, v in kw.items() if v is not None}
        out.append(cleaned)
    return out


def fetch_ifeval():
    items = fetch_hf_rows(
        "google/IFEval",
        "default",
        "train",
        lambda i, row: {
            "index": i,
            "key": row.get("key"),
            "prompt": row["prompt"],
            "instruction_id_list": list(row.get("instruction_id_list") or []),
            "kwargs": _ifeval_kwargs(row.get("kwargs")),
        },
    )
    return {
        "source": (
            "google/IFEval train via HuggingFace datasets-server (full, n=541; "
            "same order as google-research instruction_following_eval/data/input_data.jsonl)"
        ),
        "canonical": "https://huggingface.co/datasets/google/IFEval",
        "split": "train",
        "offset": 0,
        "coverage": "full",
        "n": len(items),
        "items": items,
    }


def fetch_mmlu_pro():
    letters = "ABCDEFGHIJ"

    def map_row(i, row):
        options = list(row.get("options") or [])
        labeled = []
        for j, opt in enumerate(options):
            if j >= len(letters):
                break
            labeled.append({"letter": letters[j], "text": opt})
        gold = (row.get("answer") or "").strip().upper()
        if not gold and row.get("answer_index") is not None:
            idx = int(row["answer_index"])
            gold = letters[idx] if 0 <= idx < len(letters) else ""
        return {
            "index": i,
            "question_id": row.get("question_id"),
            "question": row["question"],
            "options": labeled,
            "gold": gold,
            "category": row.get("category"),
            "src": row.get("src"),
        }

    items = fetch_hf_rows("TIGER-Lab/MMLU-Pro", "default", "test", map_row)
    return {
        "source": "TIGER-Lab/MMLU-Pro test via HuggingFace datasets-server (full test)",
        "canonical": "https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro",
        "split": "test",
        "offset": 0,
        "coverage": "full",
        "n": len(items),
        "items": items,
    }


def fetch_aime24():
    items = fetch_hf_rows(
        "HuggingFaceH4/aime_2024",
        "default",
        "train",
        lambda i, row: {
            "index": i,
            "id": row.get("id"),
            "problem": row["problem"],
            "gold": str(row.get("answer") or "").strip(),
            "year": row.get("year") or 2024,
            "url": row.get("url"),
        },
    )
    return {
        "source": "HuggingFaceH4/aime_2024 train via HuggingFace datasets-server (n=30; AIME 2024 I)",
        "canonical": "https://huggingface.co/datasets/HuggingFaceH4/aime_2024",
        "split": "train",
        "offset": 0,
        "coverage": "full-file",
        "n": len(items),
        "items": items,
        "note": "This HF file is 30 problems (AIME I 2024), not both AIME I+II (60).",
    }


def fetch_aime25():
    items = fetch_hf_rows(
        "math-ai/aime25",
        "default",
        "test",
        lambda i, row: {
            "index": i,
            "id": row.get("id"),
            "problem": row["problem"],
            "gold": str(row.get("answer") or "").strip(),
            "year": 2025,
        },
    )
    return {
        "source": "math-ai/aime25 test via HuggingFace datasets-server (n=30)",
        "canonical": "https://huggingface.co/datasets/math-ai/aime25",
        "split": "test",
        "offset": 0,
        "coverage": "full-file",
        "n": len(items),
        "items": items,
    }


def _gpqa_shuffle(record_id, correct, wrongs):
    """Deterministic A-D permutation from sha256(record_id). Not OpenAI n_repeats."""
    choices = [correct] + list(wrongs)
    seed = hashlib.sha256(("gpqa-diamond:" + str(record_id)).encode("utf-8")).digest()
    # Fisher-Yates with bytes as RNG
    arr = list(range(4))
    pos = 0
    for i in range(3, 0, -1):
        pos = (pos + 4) % len(seed)
        j = seed[pos] % (i + 1)
        arr[i], arr[j] = arr[j], arr[i]
    labeled = []
    gold_letter = None
    letters = "ABCD"
    for k, idx in enumerate(arr):
        labeled.append({"letter": letters[k], "text": str(choices[idx]).strip()})
        if idx == 0:
            gold_letter = letters[k]
    return labeled, gold_letter


def fetch_gpqa_diamond():
    raw = http_get(GPQA_CSV, timeout=120)
    text = raw.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    items = []
    for i, row in enumerate(reader):
        rid = row.get("Record ID") or ("row-%s" % i)
        correct = row.get("Correct Answer") or ""
        wrongs = [
            row.get("Incorrect Answer 1") or "",
            row.get("Incorrect Answer 2") or "",
            row.get("Incorrect Answer 3") or "",
        ]
        labeled, gold = _gpqa_shuffle(rid, correct, wrongs)
        items.append(
            {
                "index": i,
                "record_id": rid,
                "question": row.get("Question") or "",
                "options": labeled,
                "gold": gold,
                "domain": row.get("High-level domain") or "",
                "subdomain": row.get("Subdomain") or "",
                "canary": row.get("Canary String") or "",
            }
        )
    return {
        "source": (
            "OpenAI simple-evals gpqa_diamond.csv "
            "(https://openaipublic.blob.core.windows.net/simple-evals/gpqa_diamond.csv); "
            "Idavidrein/gpqa Diamond split; n=198. Choices shuffled via sha256(Record ID)."
        ),
        "canonical": "https://huggingface.co/datasets/Idavidrein/gpqa",
        "split": "diamond",
        "offset": 0,
        "coverage": "full",
        "n": len(items),
        "items": items,
        "note": (
            "Gated HF terms ask not to republish item text. Traces store record_id / "
            "letter / correctness, not the question. n_repeats=1 (not simple-evals default 10)."
        ),
    }


def decode_lcb_private(blob):
    if not blob:
        return []
    if isinstance(blob, list):
        return blob
    if not isinstance(blob, str):
        return []
    try:
        parsed = json.loads(blob)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    try:
        raw = base64.b64decode(blob.encode("utf-8"))
        dec = zlib.decompress(raw)
        try:
            obj = pickle.loads(dec)
        except Exception:
            obj = json.loads(dec.decode("utf-8"))
        if isinstance(obj, (bytes, bytearray)):
            obj = obj.decode("utf-8")
        if isinstance(obj, str):
            obj = json.loads(obj)
        if isinstance(obj, list):
            return obj
    except Exception:
        return None  # decode failed
    return []


def _compact_lcb_item(i, obj, version_tag):
    public = obj.get("public_test_cases") or "[]"
    if isinstance(public, str):
        try:
            public = json.loads(public)
        except Exception:
            public = []
    private_blob = obj.get("private_test_cases") or ""
    private = []
    private_status = "none"
    if isinstance(private_blob, list):
        private = private_blob
        private_status = "plain"
    elif isinstance(private_blob, str) and private_blob:
        if len(private_blob) > LCB_PRIVATE_MAX_ENCODED:
            private_status = "skipped_too_large"
        else:
            decoded = decode_lcb_private(private_blob)
            if decoded is None:
                private_status = "decode_failed"
            else:
                private = decoded
                private_status = "decoded"
    metadata = obj.get("metadata") or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata) if metadata else {}
        except Exception:
            metadata = {}
    return {
        "index": i,
        "question_id": obj.get("question_id"),
        "question_title": obj.get("question_title"),
        "question_content": obj.get("question_content"),
        "platform": obj.get("platform"),
        "contest_date": obj.get("contest_date"),
        "starter_code": obj.get("starter_code") or "",
        "difficulty": obj.get("difficulty"),
        "metadata": metadata,
        "public_test_cases": public,
        "private_test_cases": private,
        "private_status": private_status,
        "lcb_file": version_tag,
    }


def fetch_lcb(version="v5_v6"):
    """Stream LiveCodeBench-lite jsonl into a compact cache.

    Default v5_v6 = latest two incremental files (avoids the 1.2GB v1 dump unless asked).
    release_latest pulls every lite file; huge private blobs are public-tests-only.
    """
    tags = LCB_RELEASE.get(version)
    if not tags:
        raise ValueError("unknown LCB version %s (want %s)" % (version, sorted(LCB_RELEASE)))
    items = []
    files_used = []
    for tag in tags:
        filename = LCB_FILES[tag]
        url = HF_RESOLVE.format(repo=LCB_REPO, path=filename)
        print("  LCB stream %s (%s) ..." % (tag, filename), file=sys.stderr)
        req = urllib.request.Request(url, headers=UA)
        n_file = 0
        with urllib.request.urlopen(req, timeout=600) as resp:
            buf = b""
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                buf += chunk
                while True:
                    nl = buf.find(b"\n")
                    if nl < 0:
                        break
                    line = buf[:nl]
                    buf = buf[nl + 1 :]
                    if not line.strip():
                        continue
                    obj = json.loads(line.decode("utf-8"))
                    items.append(_compact_lcb_item(len(items), obj, tag))
                    n_file += 1
                    if n_file % 25 == 0:
                        print("    %s %s items" % (tag, n_file), file=sys.stderr)
            if buf.strip():
                obj = json.loads(buf.decode("utf-8"))
                items.append(_compact_lcb_item(len(items), obj, tag))
                n_file += 1
        files_used.append("%s:%s" % (tag, n_file))
        print("  LCB %s done n=%s" % (tag, n_file), file=sys.stderr)
    n_priv = sum(1 for it in items if it["private_status"] == "decoded")
    n_skip = sum(1 for it in items if it["private_status"] == "skipped_too_large")
    return {
        "source": (
            "livecodebench/code_generation_lite %s files %s (HuggingFace resolve/main). "
            "Private tests decoded when encoded size ≤ %s bytes (%s decoded, %s public-only)."
            % (version, ", ".join(files_used), LCB_PRIVATE_MAX_ENCODED, n_priv, n_skip)
        ),
        "canonical": "https://huggingface.co/datasets/livecodebench/code_generation_lite",
        "split": version,
        "offset": 0,
        "coverage": "full-file" if version in ("release_latest", "release_v6") else "subset-files",
        "n": len(items),
        "items": items,
        "lcb_version": version,
        "files": files_used,
        "n_private_decoded": n_priv,
        "n_private_skipped": n_skip,
        "grader": (
            "local stdin/functional Python exec of public tests plus decoded private tests; "
            "not the official lcb_runner package. pass@1, temp 0, n=1 sample."
        ),
    }


FETCHERS = {
    "gsm8k": ("gsm8k_full.json", fetch_gsm8k),
    "math": ("math500_full.json", fetch_math500),
    "humaneval": ("humaneval_full.json", fetch_humaneval),
    "ifeval": ("ifeval_full.json", fetch_ifeval),
    "mmlupro": ("mmlu_pro_full.json", fetch_mmlu_pro),
    "aime24": ("aime2024.json", fetch_aime24),
    "aime25": ("aime2025.json", fetch_aime25),
    "gpqa": ("gpqa_diamond.json", fetch_gpqa_diamond),
    "lcb": ("lcb_v5_v6.json", lambda: fetch_lcb("v5_v6")),
    "lcb_latest": ("lcb_release_latest.json", lambda: fetch_lcb("release_latest")),
    "lcb_v6": ("lcb_v6.json", lambda: fetch_lcb("v6")),
}


def load_or_fetch(name, force=False):
    if name not in FETCHERS:
        raise KeyError(name)
    fname, fn = FETCHERS[name]
    path = cache_path(fname)
    if path.exists() and not force:
        sl = load_json(path)
        print("cache hit %s n=%s" % (path.name, sl.get("n")), file=sys.stderr)
        return sl
    print("fetch %s ..." % name, file=sys.stderr)
    sl = fn()
    save_json(path, sl)
    print("wrote %s n=%s" % (path, sl.get("n")), file=sys.stderr)
    return sl


def load_lite(name):
    mapping = {
        "gsm8k": "gsm8k_lite20.json",
        "math": "math500_lite20.json",
        "humaneval": "humaneval_lite10.json",
        "ifeval": "ifeval_lite20.json",
    }
    path = DATA / mapping[name]
    sl = load_json(path)
    sl["coverage"] = "lite-slice"
    return sl


def main(argv=None):
    p = argparse.ArgumentParser(description="Fetch Flash HRR eval splits into evals/data/cache")
    p.add_argument("--sets", default="gsm8k,math,humaneval,ifeval,mmlupro,aime24,aime25,gpqa,lcb")
    p.add_argument("--force", action="store_true")
    args = p.parse_args(argv)
    names = [s.strip() for s in args.sets.split(",") if s.strip()]
    if "all" in names:
        names = [k for k in FETCHERS if not k.startswith("lcb_")]
        names.append("lcb")
    for name in names:
        sl = load_or_fetch(name, force=args.force)
        print("%s n=%s coverage=%s" % (name, sl.get("n"), sl.get("coverage")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
