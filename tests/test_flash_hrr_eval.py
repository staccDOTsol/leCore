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
    extract_mcq_letter,
    extract_aime_int,
    aime_match,
    exec_lcb_item,
    render_markdown,
    render_hf_fragment,
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


def test_mcq_and_aime_extract():
    assert extract_mcq_letter("foo\n\\boxed{C}") == "C"
    assert extract_mcq_letter("Answer: B") == "B"
    assert extract_aime_int("work\n\\boxed{070}") == "70"
    assert aime_match("70", "070")
    assert not aime_match("71", "70")


def test_ifeval_forbidden_and_constrained():
    item = {
        "instruction_id_list": ["keywords:forbidden_words"],
        "kwargs": [{"forbidden_words": ["banana"]}],
        "prompt": "x",
    }
    assert ifeval_score_item(item, "hello world")[0]
    assert not ifeval_score_item(item, "a banana split")[0]
    item2 = {
        "instruction_id_list": ["detectable_format:constrained_response"],
        "kwargs": [{}],
        "prompt": "x",
    }
    assert ifeval_score_item(item2, "My answer is yes.")[0]
    assert not ifeval_score_item(item2, "yes")[0]


def test_lcb_stdin_exec():
    ok, err, n_run, n_pass = exec_lcb_item(
        "print(int(input())+1)\n",
        [{"input": "1\n", "output": "2\n", "testtype": "stdin"}],
        timeout=5,
    )
    assert ok and n_pass == 1, (ok, err, n_run, n_pass)


def test_card_render_has_high_bar_table_not_lite_n20():
    md = render_markdown({"capability": {}, "reachable": True})
    hf = render_hf_fragment({"capability": {}, "reachable": True})
    assert "## Capability evals" in md
    assert "## Evals (Flash+HRR-spill gateway, temperature 0)" in hf
    assert "GPQA-Diamond" in md and "MMLU-Pro" in md and "AIME 2024" in md
    assert "LiveCodeBench" in hf
    assert "MEMORY SIG DIFF" in md and "MEMORY SIG DIFF" in hf
    assert "lite slices" not in md.lower()
    assert "n=20 leftover" not in hf
    # empty capability must say NOT RUN, not fake scores
    assert "NOT RUN" in md
    assert "| OG commodity OpenRouter | — | — | NOT RUN | NOT RUN | NOT RUN |" in md
