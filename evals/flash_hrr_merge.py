#!/usr/bin/env python3
"""Merge per-suite Flash HRR JSON traces into the card markdown + combined JSON.

Does not call the live API. Does not invent scores. Missing suites stay NOT RUN.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
sys.path.insert(0, str(HERE.parent))
from evals.flash_hrr_api_eval import (  # noqa: E402
    LAB_MODEL_ID,
    LAB_PUBLIC_VLLM,
    render_hf_fragment,
    render_markdown,
)

SUITE_FILES = [
    ("suite_aime24.json", "AIME 2024"),
    ("suite_aime25.json", "AIME 2025"),
    ("suite_gpqa.json", "GPQA-Diamond"),
    ("suite_humaneval.json", "HumanEval"),
    ("suite_lcb.json", "LiveCodeBench"),
    ("suite_math.json", "MATH-500"),
    ("suite_ifeval.json", "IFEval"),
    ("suite_gsm8k.json", "GSM8K"),
    ("suite_mmlupro.json", "MMLU-Pro"),
]


def load(path):
    p = Path(path)
    if not p.exists():
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    snap = load(RESULTS / "suite_snapshot_pre_parallel.json") or load(RESULTS / "flash_hrr_full.json") or {}
    aime24 = load(RESULTS / "suite_aime24.json") or {}
    report = {
        "started_utc": snap.get("started_utc") or "",
        "finished_utc": datetime.now(timezone.utc).isoformat(),
        "base_url": snap.get("base_url") or LAB_PUBLIC_VLLM,
        "model": snap.get("model") or LAB_MODEL_ID,
        "temperature": snap.get("temperature", 0.0),
        "timeout_s": snap.get("timeout_s", 180),
        "concurrency": "parallel suites, conc=1 each, ~8 in-flight cap",
        "scale": "full",
        "reachable": True,
        "lab_sig_diff": snap.get("lab_sig_diff") or aime24.get("lab_sig_diff"),
        "capability": {},
        "memory_raw_vllm": snap.get("memory_raw_vllm") or aime24.get("memory_raw_vllm"),
        "client_errors": [],
        "note": (
            "Suites run as separate processes (resume JSONL). "
            "OG OpenRouter NOT RUN. SWE/Terminal-Bench/DeepSWE not attempted."
        ),
        "probe": snap.get("probe") or {"ok": True},
        "suites_merged": [],
    }
    for fname, name in SUITE_FILES:
        blob = load(RESULTS / fname)
        if not blob:
            continue
        cap = (blob.get("capability") or {}).get(name)
        if not cap:
            # maybe the file is the packed row itself
            if blob.get("name") == name:
                cap = blob
        if cap and cap.get("score") not in (None, "NOT RUN"):
            report["capability"][name] = cap
            report["suites_merged"].append(name)
            if blob.get("memory_raw_vllm") and not report["memory_raw_vllm"]:
                report["memory_raw_vllm"] = blob["memory_raw_vllm"]
    lats = []
    for row in report["capability"].values():
        if row.get("latency_p50_s") is not None:
            lats.append(row["latency_p50_s"])
    report["latency_p50_s"] = sorted(lats)[len(lats) // 2] if lats else None

    md = render_markdown(report)
    hf = render_hf_fragment(report)
    (HERE / "flash-hrr-benches.md").write_text(md, encoding="utf-8")
    (HERE / "HF-README-FRAGMENT.md").write_text(hf, encoding="utf-8")
    # Combined traces: keep items for finished suites (MMLU-Pro stays in its suite file if huge).
    combined = dict(report)
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "flash_hrr_full.json").write_text(json.dumps(combined, indent=2), encoding="utf-8")
    print(
        "merged",
        ", ".join("%s %s" % (k, v.get("score")) for k, v in report["capability"].items()) or "(none)",
        file=sys.stderr,
    )
    print("wrote", HERE / "flash-hrr-benches.md", HERE / "HF-README-FRAGMENT.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
