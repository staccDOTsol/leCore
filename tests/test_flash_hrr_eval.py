"""Offline grader checks for evals/flash_hrr_api_eval.py (no API, no GPU)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from evals.flash_hrr_api_eval import (
    extract_gsm8k_pred,
    gsm8k_match,
    ifeval_score_item,
    last_boxed,
    math_match,
    assemble_humaneval,
)


def test_gsm8k_hash_answer():
    assert extract_gsm8k_pred("working\n#### 18") == "18"
    assert gsm8k_match("18", "18")
    assert gsm8k_match("18.0", "18")
    assert not gsm8k_match("19", "18")


def test_math_last_boxed():
    assert last_boxed(r"foo \boxed{\frac{14}{3}} bar") == r"\frac{14}{3}"
    ok, pred = math_match(
        r"answer is \boxed{\left( 3, \frac{\pi}{2} \right)}",
        r"\left( 3, \frac{\pi}{2} \right)",
    )
    assert ok, pred


def test_ifeval_no_comma_and_json_fence():
    item = {
        "instruction_id_list": ["punctuation:no_comma"],
        "kwargs": [{}],
        "prompt": "x",
    }
    assert ifeval_score_item(item, "hello world")[0]
    assert not ifeval_score_item(item, "hello, world")[0]
    item_json = {
        "instruction_id_list": ["detectable_format:json_format"],
        "kwargs": [{}],
        "prompt": "x",
    }
    assert ifeval_score_item(item_json, '```json\n{"a": 1}\n```')[0]


def test_humaneval_assemble_body_only():
    prompt = "def add(a, b):\n    "
    completion = "return a + b\n"
    assert "return a + b" in assemble_humaneval(prompt, completion)
