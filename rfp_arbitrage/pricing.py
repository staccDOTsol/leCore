"""Is the ask overpriced? Three numbers per opportunity:

  ask_value   what the buyer will pay -- stated budget / estimated value if the notice has one,
              else the USAspending median award for the same NAICS (US federal), else a dollar
              figure parsed from the text, else unknown.
  hours       an LLM scope estimate (deliverables -> skill mix -> hours range) with a keyword
              fallback that is crude on purpose (it says so in `basis`).
  labor_cost  hours x the matched talent's rate (done in match.py); here we carry the reference
              cost at market rates so 'overpriced' has a meaning before any talent is matched:
              ask / (market labor + overhead)."""
from __future__ import annotations

import re
from typing import Any

from .config import Settings, settings as _settings
from .llm import LLM, LLMError
from .models import Opportunity
from .sources.base import parse_money
from .talent.scoring import REFERENCE_RATES

SCOPE_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["deliverables", "skill_mix", "hours_low", "hours_high", "seniority", "duration_weeks", "stated_budget", "assumptions"],
    "properties": {
        "deliverables": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
        "skill_mix": {"type": "object", "additionalProperties": {"type": "number"},
                      "description": "fraction of hours per skill family; keys from: " + ", ".join(REFERENCE_RATES)},
        "hours_low": {"type": "number"}, "hours_high": {"type": "number"},
        "seniority": {"type": "string", "enum": ["junior", "mid", "senior", "mixed"]},
        "duration_weeks": {"type": ["number", "null"]},
        "stated_budget": {"type": ["number", "null"], "description": "budget / estimated value / NTE amount stated in the text, in the notice currency, else null"},
        "assumptions": {"type": "array", "items": {"type": "string"}, "maxItems": 8},
    },
}

SCOPE_SYSTEM = """You estimate delivery effort for public-sector intellectual-work contracts (software, data,
consulting, studies, writing, design, training, research). Read the solicitation and return: the concrete
deliverables; the skill mix as fractions summing to 1 over the allowed skill families; a realistic hours range
for a competent small team (not a Big-4 staffing pyramid); seniority; duration; any budget, estimated value,
ceiling, NTE, or price range STATED in the text (null if none -- never guess); and assumptions. Scope only
the intellectual work: if the notice bundles hardware, construction or physical services, exclude them and say
so in assumptions."""

# A money figure near a budget label. The currency marker or a k/m unit is REQUIRED: bare
# numbers after "estimated" are page counts, years and item quantities far more often than dollars.
_BUDGET_RE = re.compile(
    r"(?:budget|estimated (?:value|cost|contract value|amount|total)|not[- ]to[- ]exceed|\bNTE\b|maximum (?:value|amount|budget)|"
    r"contract (?:value|ceiling|amount)|funding (?:available|of)|valued at|ceiling)[^$\d]{0,60}?"
    r"(?:(?:CAD|USD|CA\$|US\$|\$)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)?|(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)\b)",
    re.I)


def stated_budget(text: str, floor: float = 5_000) -> float | None:
    best = None
    for m in _BUDGET_RE.finditer(text or ""):
        num, unit = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        v = parse_money(num + " " + (unit or ""))
        if v and floor <= v <= 500_000_000 and (best is None or v > best):
            best = v
    return best


def heuristic_scope(opp: Opportunity, text: str) -> dict[str, Any]:
    """Keyword-only fallback: family from the taxonomy vocabulary, hours from notice size."""
    from .talent.scoring import skill_families
    fams = skill_families([opp.title, opp.category_hint], (text or "")[:4000]) or {"consulting": 1}
    total = sum(fams.values())
    mix = {k: round(v / total, 2) for k, v in list(fams.items())[:4]}
    n = len(text or "")
    lo, hi = (80, 300) if n < 5000 else (200, 800) if n < 30000 else (400, 2000)
    return {"deliverables": [], "skill_mix": mix, "hours_low": lo, "hours_high": hi, "seniority": "mixed",
            "duration_weeks": None, "stated_budget": stated_budget(text), "assumptions": ["heuristic scope: hours from document size, mix from keywords"],
            "basis": "heuristic"}


def estimate_scope(opp: Opportunity, text: str, llm: LLM | None) -> dict[str, Any]:
    if llm is None or not text.strip():
        return heuristic_scope(opp, text)
    body = text if len(text) <= 60_000 else text[:45_000] + "\n...\n" + text[-15_000:]
    user = (f"title: {opp.title}\nbuyer: {opp.buyer}\ncurrency: {opp.currency}\nnotice type: {opp.notice_type}\n"
            f"codes: naics={opp.naics} unspsc={opp.unspsc} psc={opp.psc}\n\nTEXT:\n{body}")
    try:
        d = llm.json(SCOPE_SYSTEM, user, SCOPE_SCHEMA, max_tokens=2500)
    except LLMError as e:
        h = heuristic_scope(opp, text)
        h["assumptions"].append(f"LLM unavailable: {e}")
        return h
    mix = {k: float(v) for k, v in (d.get("skill_mix") or {}).items() if k in REFERENCE_RATES and float(v) > 0}
    s = sum(mix.values()) or 1.0
    mix = {k: round(v / s, 3) for k, v in mix.items()} or {"consulting": 1.0}
    lo, hi = float(d.get("hours_low") or 0), float(d.get("hours_high") or 0)
    if hi <= 0 or lo <= 0 or hi < lo:
        lo, hi = heuristic_scope(opp, text)["hours_low"], heuristic_scope(opp, text)["hours_high"]
    sb = d.get("stated_budget")
    return {"deliverables": [str(x) for x in d.get("deliverables") or []][:12], "skill_mix": mix,
            "hours_low": lo, "hours_high": hi, "seniority": str(d.get("seniority") or "mixed"),
            "duration_weeks": d.get("duration_weeks"), "stated_budget": float(sb) if sb else stated_budget(text),
            "assumptions": [str(x) for x in d.get("assumptions") or []][:8], "basis": f"llm:{llm.name}"}


def market_rate(skill_mix: dict[str, float], reference: dict[str, float] | None = None) -> float:
    ref = reference or REFERENCE_RATES
    return sum(ref.get(k, ref["general"]) * f for k, f in skill_mix.items()) or ref["general"]


def to_usd(v: float | None, currency: str) -> float | None:
    if v is None:
        return None
    return v * {"CAD": 0.73, "EUR": 1.08, "GBP": 1.27}.get((currency or "USD").upper(), 1.0)


def price(opp: Opportunity, text: str, llm: LLM | None, benchmark: dict[str, Any] | None = None,
          cfg: Settings | None = None) -> dict[str, Any]:
    cfg = cfg or _settings()
    scope = estimate_scope(opp, text, llm)
    ask, basis = None, "unknown"
    if opp.estimated_value:
        ask, basis = to_usd(opp.estimated_value, opp.currency), "stated:notice"
    hours_mid = (scope["hours_low"] + scope["hours_high"]) / 2
    rate = market_rate(scope["skill_mix"])
    market_cost = hours_mid * rate
    have_bench = bool(benchmark and benchmark.get("n", 0) >= 5)
    if ask is None and scope.get("stated_budget"):
        sb = to_usd(scope["stated_budget"], opp.currency)
        # a regex-found figure an order of magnitude under the labor estimate is a stray number,
        # not a budget -- an LLM-read one is trusted as stated
        if scope.get("basis", "").startswith("llm") or sb >= 0.1 * market_cost or not have_bench:
            ask, basis = sb, "stated:text" if scope.get("basis", "").startswith("llm") else "stated:text(regex)"
    if ask is None and have_bench:
        ask, basis = float(benchmark["median"]), f"benchmark:usaspending n={benchmark['n']}"
    overpriced_ratio = (ask / (market_cost * (1 + cfg.overhead_rate))) if ask and market_cost else None
    return {
        "ask_value": ask, "ask_basis": basis, "hours_low": scope["hours_low"], "hours_high": scope["hours_high"],
        "hours_mid": hours_mid, "skill_mix": scope["skill_mix"], "market_rate": round(rate, 2),
        "market_labor_cost": round(market_cost, 2), "overpriced_ratio": round(overpriced_ratio, 2) if overpriced_ratio else None,
        "deliverables": scope.get("deliverables", []), "seniority": scope.get("seniority"), "duration_weeks": scope.get("duration_weeks"),
        "assumptions": scope.get("assumptions", []), "scope_basis": scope.get("basis"), "benchmark": benchmark or {},
    }
