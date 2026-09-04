"""Pin docs/OPENZOO_OPERATIONS.md (the operator manual) to holographic_mcp._TOOLS.

WHY THIS EXISTS (a measured drift, kept loud). The manual said "26 hosted tools" / "tool pin = 26" in three
places, and docs/INDEX.md repeated "all 26 hosted tools", while holographic_mcp._TOOLS held 40 -- fourteen
tools (corpus_delta, study, study_ask, wisdom_record, wisdom_ask, series_analyze, dataset_decompose,
fact_check, scene_create, scene_adjust, scene_export, image_tool, math_eval, chart_make) landed in the
server and never in the manual. Worse, the manual's own preamble claimed the table was "generated from
`holographic_mcp.py` itself" and that `tools/regen_docs.py --check` would fail CI on drift. Neither was
true: no generator ever owned this file (tools/regen_docs.GENERATORS lists it nowhere, and nothing under
tools/ mentions it), so the number was typed by hand and rotted silently. A doc that claims a guard it does
not have is worse than one that claims nothing -- a reader trusts the claim and stops checking.

This module IS that guard. It pins three things:
  1. every count claim in the manual and in docs/INDEX.md -- "N hosted tools", "tool pin = N", "tool pin N",
     and the "`zoo_*` ladder (N tools)" row of the integration table -- equals the count in source;
  2. the tool table lists exactly _TOOLS' names, in _TOOLS' order (the row number column makes the count
     visible on the page itself, so the last row IS the pin a reader can eyeball);
  3. each row's description cell is what render_table() makes from that tool's REAL description string.

It is also the writer: `python3 tests/test_openzoo_operations_doc.py --write` rewrites the table between the
BEGIN/END markers and the count claims from source, and nothing else. It is deliberately NOT registered in
tools/regen_docs.GENERATORS: that list owns files REGENERATED IN FULL (its docstring records why, and keeps
servicedoc.py out for the same reason), and this manual is hand-written prose around one generated table.
A partial rewriter in a list that promises full regeneration would be a second lie in place of the first.
The pytest is the drift gate; the CI shard that runs tests/ runs it.

DETERMINISM: render_table() is a pure function of _TOOLS (a list literal, so iteration order is source
order); no dates, no paths, no dict-order dependence -- the same contract tools/regen_docs.py pins for the
full generators, so --write twice is a no-op.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DOC = ROOT / "docs" / "OPENZOO_OPERATIONS.md"
INDEX = ROOT / "docs" / "INDEX.md"

# The markers fence the ONLY generated span of the manual. Prose outside them is hand-written and
# never touched by --write.
BEGIN = "<!-- BEGIN GENERATED TOOL TABLE: python3 tests/test_openzoo_operations_doc.py --write -->"
END = "<!-- END GENERATED TOOL TABLE -->"

# Description cells: the tool's real description, whitespace-normalised, cut at a word boundary. 96 was
# chosen so the widest cell still fits a 120-column terminal with the name column beside it; the longest
# description in source is 650+ characters and belongs in `lecore_describe`, not in a table row.
WIDTH = 96

# Every phrasing the docs use for the count. Each alternative has ONE capture group, so findall() yields
# tuples we can collapse with `next(filter(None, ...))`. Add a phrasing here before adding it to a doc.
COUNT_CLAIM = re.compile(r"(\d+) hosted tools|tool pin = (\d+)|tool pin (\d+)")
ZOO_CLAIM = re.compile(r"`zoo_\*` ladder \((\d+) tools")


def _tools():
    """The live list -- imported, not AST-parsed, so what CI pins is exactly what tools/list serves."""
    from holographic_mcp import _TOOLS
    return _TOOLS


def summary(description, width=WIDTH):
    """First `width` characters of a description, cut at a word boundary, with pipes escaped for the table."""
    text = " ".join(description.split())
    if len(text) > width:
        cut = text.rfind(" ", 0, width)
        text = text[: cut if cut > 0 else width].rstrip(",;:") + " ..."
    return text.replace("|", "\\|")


def render_table(tools):
    """The generated span, markers included -- one function so the test and --write cannot disagree."""
    lines = [BEGIN, "", "| # | Tool | Description |", "|---|---|---|"]
    for i, tool in enumerate(tools, 1):
        lines.append("| %d | `%s` | %s |" % (i, tool["name"], summary(tool["description"])))
    lines += ["", END]
    return "\n".join(lines)


def _span(text):
    """(start, end) of the generated span in `text`, markers included; asserts both markers exist once."""
    b, e = text.find(BEGIN), text.find(END)
    assert b >= 0 and e > b, "docs/OPENZOO_OPERATIONS.md has lost its BEGIN/END tool-table markers"
    assert text.count(BEGIN) == 1 and text.count(END) == 1, "duplicate tool-table markers"
    return b, e + len(END)


def _claims(text):
    return [int(next(g for g in m if g)) for m in COUNT_CLAIM.findall(text)]


def write(tools=None):
    """Rewrite the generated span and every count claim from source. Returns the list of files changed."""
    tools = tools if tools is not None else _tools()
    n, nzoo = len(tools), sum(1 for t in tools if t["name"].startswith("zoo_"))
    changed = []
    for path in (DOC, INDEX):
        old = path.read_text(encoding="utf-8")
        new = old
        if path == DOC:
            b, e = _span(new)
            new = new[:b] + render_table(tools) + new[e:]
            new = ZOO_CLAIM.sub("`zoo_*` ladder (%d tools" % nzoo, new)
        new = re.sub(r"\d+ hosted tools", "%d hosted tools" % n, new)
        new = re.sub(r"tool pin = \d+", "tool pin = %d" % n, new)
        new = re.sub(r"tool pin \d+", "tool pin %d" % n, new)
        if new != old:
            path.write_text(new, encoding="utf-8")
            changed.append(str(path.relative_to(ROOT)))
    return changed


def test_every_count_claim_matches_source():
    """THE PIN. "26 hosted tools" sat in the manual while the server served 40. Every stated count, in both
    docs that state one, must equal len(_TOOLS) -- and there must BE claims, or the regex rotted."""
    n = len(_tools())
    for path in (DOC, INDEX):
        claims = _claims(path.read_text(encoding="utf-8"))
        assert claims, "%s states no tool count -- COUNT_CLAIM no longer matches its phrasing" % path.name
        wrong = sorted(set(c for c in claims if c != n))
        assert not wrong, ("%s says %s hosted tools; holographic_mcp._TOOLS has %d. Run "
                           "`python3 tests/test_openzoo_operations_doc.py --write`." % (path.name, wrong, n))


def test_zoo_ladder_count_matches_source():
    """The integration-status row counts the zoo_* rungs; it was written as 15 while source had 16."""
    tools = _tools()
    nzoo = sum(1 for t in tools if t["name"].startswith("zoo_"))
    claims = [int(c) for c in ZOO_CLAIM.findall(DOC.read_text(encoding="utf-8"))]
    assert claims, "the manual no longer states the zoo_* ladder size -- ZOO_CLAIM rotted"
    assert all(c == nzoo for c in claims), "manual says zoo_* ladder has %s tools; source has %d" % (claims, nzoo)


def test_tool_table_matches_source():
    """The table between the markers is byte-for-byte what render_table() makes from _TOOLS: same names,
    same order, same description cells. Names checked first so a drift names the tool, not a byte offset."""
    tools = _tools()
    text = DOC.read_text(encoding="utf-8")
    b, e = _span(text)
    span = text[b:e]
    rows = re.findall(r"^\| \d+ \| `([A-Za-z0-9_]+)` \|", span, flags=re.M)
    assert rows == [t["name"] for t in tools], (
        "tool table drifted from holographic_mcp._TOOLS -- missing: %s, extra: %s. Run "
        "`python3 tests/test_openzoo_operations_doc.py --write`."
        % (sorted(set(t["name"] for t in tools) - set(rows)), sorted(set(rows) - set(t["name"] for t in tools))))
    assert span == render_table(tools), \
        "a description cell drifted from source; run `python3 tests/test_openzoo_operations_doc.py --write`"


def test_write_is_idempotent(tmp_path, monkeypatch):
    """--write on an up-to-date tree changes nothing (the regen_docs determinism contract, applied here)."""
    doc, idx = tmp_path / "OPENZOO_OPERATIONS.md", tmp_path / "INDEX.md"
    doc.write_text(DOC.read_text(encoding="utf-8"), encoding="utf-8")
    idx.write_text(INDEX.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setattr(sys.modules[__name__], "DOC", doc)
    monkeypatch.setattr(sys.modules[__name__], "INDEX", idx)
    monkeypatch.setattr(sys.modules[__name__], "ROOT", tmp_path)
    assert write() == [], "the committed manual is not what --write produces; commit the regenerated copy"


def test_summary_escapes_pipes_and_cuts_on_words():
    """Two descriptions in source contain '|' (chart_make, zoo_model3d); an unescaped pipe splits a cell."""
    assert summary("a | b") == "a \\| b"
    long = " ".join(["word"] * 40)
    cell = summary(long)
    assert cell.endswith(" ...") and len(cell) <= WIDTH + 4 and "  " not in cell
    assert summary("short") == "short"


if __name__ == "__main__":
    if "--write" in sys.argv:
        changed = write()
        print("rewrote: %s" % (", ".join(changed) or "nothing (already current)"))
    else:
        print(render_table(_tools()))
