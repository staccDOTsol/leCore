"""The intersection, with openzoo as the labor. For every opportunity that is (1) intellectual,
(2) past the legal gate, (3) priced: the delivery plan is an openzoo AI team -- the scope's
hours at the zoo's cost per delivered hour-equivalent (RFP_ZOO_USD_PER_HOUR, a knob, default
$4: roughly 40-80k output tokens of frontier work per human-hour of deliverable, iterations
included) plus the human review share RFP_REVIEW_SHARE (default 10 % of hours at the review
rate). Margin = (ask - delivery x (1 + overhead)) / ask.

    score = gate_conf x (0.6 x margin_norm + 0.4 x size_norm)     size_norm = log-scaled ask
with hard cuts: margin >= RFP_MIN_MARGIN (default 35 %), ask known."""
from __future__ import annotations

import math
import os
from typing import Iterable

from .config import Settings, settings as _settings
from .models import ClauseVerdict, Match, Opportunity


def zoo_rate() -> float:
    return float(os.environ.get("RFP_ZOO_USD_PER_HOUR", "4.0"))


def review_share() -> float:
    return float(os.environ.get("RFP_REVIEW_SHARE", "0.10"))


def review_rate() -> float:
    return float(os.environ.get("RFP_REVIEW_USD_PER_HOUR", "120.0"))


def delivery_cost(hours: float) -> tuple[float, dict]:
    zoo = hours * zoo_rate()
    review = hours * review_share() * review_rate()
    return zoo + review, {"zoo_hours": hours, "zoo_usd_per_hour": zoo_rate(), "zoo_usd": round(zoo, 2),
                          "review_hours": round(hours * review_share(), 1), "review_usd": round(review, 2)}


def build_matches(opps: Iterable[Opportunity], verdicts: dict[str, ClauseVerdict], pricing: dict[str, dict],
                  cfg: Settings | None = None, require_viable: bool = True) -> list[Match]:
    cfg = cfg or _settings()
    out: list[Match] = []
    for o in opps:
        v = verdicts.get(o.key)
        pr = pricing.get(o.key)
        if not pr or not pr.get("ask_value"):
            continue
        if require_viable and (v is None or not v.arbitrage_viable):
            continue
        gate_conf = (v.confidence if v else 0.0) * (1.0 if v and v.method.startswith("llm:") else 0.5)
        hours = float(pr["hours_mid"])
        cost, plan = delivery_cost(hours)
        ask = float(pr["ask_value"])
        margin = (ask - cost * (1 + cfg.overhead_rate)) / ask
        notes = [f"ask {pr['ask_basis']}", f"hours {pr['hours_low']:.0f}-{pr['hours_high']:.0f}", f"scope {pr.get('scope_basis')}",
                 f"zoo ${plan['zoo_usd']:,.0f} + review ${plan['review_usd']:,.0f}"]
        if v:
            notes.append(f"gate {v.delegation.value}/{v.ai_use.value} conf {v.confidence:.2f} ({v.method})")
            if v.consent_required:
                notes.append("subcontractor consent required")
            if v.self_perform_min_pct:
                notes.append(f"self-perform >= {v.self_perform_min_pct:.0f}%")
            if v.key_personnel_lock:
                notes.append("key personnel lock")
            if v.clearance_or_citizenship_required:
                notes.append("clearance/citizenship required")
            notes += [f"blocker: {b}" for b in v.other_blockers[:3]]
        if pr["ask_basis"].endswith("(regex)"):
            notes.append("ask is a regex-found figure -- verify before trusting the margin")
        if margin < cfg.min_margin:
            continue
        margin_norm = min(1.0, (margin - cfg.min_margin) / (0.95 - cfg.min_margin))
        size_norm = min(1.0, max(0.0, (math.log10(max(ask, 1_000)) - 4) / 3))     # $10k -> 0, $10M -> 1
        score = round(max(0.05, gate_conf) * (0.6 * margin_norm + 0.4 * size_norm), 4)
        if pr["ask_basis"].endswith("(regex)"):
            score = round(score * 0.5, 4)
        out.append(Match(opportunity_key=o.key, talent_keys=["openzoo"], ask_value=ask, ask_basis=pr["ask_basis"],
                         labor_cost=round(cost, 2), hours_estimate=hours, margin=round(margin, 3), fit_score=1.0,
                         quality_score=round(gate_conf, 3), price_score=round(1 - min(1.0, cost / ask), 3),
                         gate_ok=bool(v and v.arbitrage_viable), score=score, notes=notes))
    out.sort(key=lambda m: -m.score)
    return out
