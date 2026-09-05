"""The intersection. For every opportunity that is (1) intellectual, (2) past the legal gate,
(3) priced, find the talent -- individuals and teams -- that fits the skill mix, is provably
good, and is cheap relative to market; compute the margin at THEIR rates; rank.

score = gate_conf * (0.35*margin_norm + 0.25*fit + 0.25*quality + 0.15*price)  with hard cuts:
  margin >= min_margin (default 35 %), quality >= 0.5, fit >= 0.25."""
from __future__ import annotations

import re
from typing import Iterable

from .config import Settings, settings as _settings
from .models import ClauseVerdict, Match, Opportunity, Talent
from .talent.scoring import skill_families, score_quality, score_price

STOP = set("the and for of to in a an with on by or as at from is are be this that services service work project "
           "provide provision city county state department government contract contractor proposal proposals request "
           "rfp rfq bid bids tender supply including required requirements shall must will may".split())


def _terms(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z0-9+#.]{2,}", (s or "").lower()) if w not in STOP}


def fit(opp: Opportunity, skill_mix: dict[str, float], t: Talent) -> float:
    fams = skill_families(t.skills, t.title)
    tot = sum(fams.values()) or 1
    fam_cover = sum(frac for fam, frac in skill_mix.items() if fam in fams)
    depth = sum((fams.get(fam, 0) / tot) * frac for fam, frac in skill_mix.items())
    ot = _terms(opp.title + " " + opp.category_hint + " " + opp.description[:2000])
    tt = _terms(" ".join(t.skills) + " " + t.title)
    kw = len(ot & tt) / max(6, min(len(ot), 40)) if ot and tt else 0.0
    return round(min(1.0, 0.55 * fam_cover + 0.25 * min(1.0, depth * 2) + 0.20 * min(1.0, kw)), 3)


def labor_cost(hours: float, skill_mix: dict[str, float], team: list[Talent]) -> float:
    """Each skill family is staffed by the cheapest matching team member; unmatched families
    fall back to the team's mean rate. Team rates in USD."""
    from .pricing import to_usd
    rates = {}
    for t in team:
        r = to_usd(t.hourly_rate, t.currency)
        if r:
            for fam in skill_families(t.skills, t.title):
                rates[fam] = min(rates.get(fam, 1e9), r)
    mean = sum(to_usd(t.hourly_rate, t.currency) or 0 for t in team) / max(1, len([t for t in team if t.hourly_rate]))
    return sum(hours * frac * rates.get(fam, mean or 0) for fam, frac in skill_mix.items())


def build_matches(opps: Iterable[Opportunity], verdicts: dict[str, ClauseVerdict], pricing: dict[str, dict],
                  talent: list[Talent], cfg: Settings | None = None, top_k: int = 3,
                  require_viable: bool = True) -> list[Match]:
    cfg = cfg or _settings()
    scored = []
    for t in talent:
        q, _ = score_quality(t)
        p, _ = score_price(t)
        if q >= 0.5 and t.hourly_rate:
            scored.append((t, q, p))
    out: list[Match] = []
    for o in opps:
        v = verdicts.get(o.key)
        pr = pricing.get(o.key)
        if not pr or not pr.get("ask_value"):
            continue
        if require_viable and (v is None or not v.arbitrage_viable):
            continue
        gate_conf = (v.confidence if v else 0.0) * (1.0 if v and v.method.startswith("llm") else 0.5)
        mix = pr["skill_mix"]
        hours = pr["hours_mid"]
        cands = []
        for t, q, p in scored:
            f = fit(o, mix, t)
            if f < 0.25:
                continue
            cands.append((f, q, p, t))
        cands.sort(key=lambda c: -(0.5 * c[0] + 0.3 * c[1] + 0.2 * c[2]))
        # individual best-fits, then a composed team when the mix spans families
        options: list[list[tuple[float, float, float, Talent]]] = [[c] for c in cands[:top_k]]
        if len(mix) > 1 and len(cands) > 1:
            team, covered = [], set()
            for c in cands:
                fams = set(skill_families(c[3].skills, c[3].title))
                new = {fam for fam in mix if fam in fams} - covered
                if new:
                    team.append(c); covered |= new
                if covered >= set(mix) or len(team) >= 4:
                    break
            if len(team) > 1:
                options.append(team)
        for opt in options:
            members = [c[3] for c in opt]
            cost = labor_cost(hours, mix, members)
            if cost <= 0:
                continue
            ask = float(pr["ask_value"])
            margin = (ask - cost * (1 + cfg.overhead_rate)) / ask
            f = sum(c[0] for c in opt) / len(opt)
            q = min(c[1] for c in opt)
            p = sum(c[2] for c in opt) / len(opt)
            notes = [f"ask {pr['ask_basis']}", f"hours {pr['hours_low']:.0f}-{pr['hours_high']:.0f}", f"scope {pr.get('scope_basis')}"]
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
            if margin < cfg.min_margin:
                continue
            margin_norm = min(1.0, (margin - cfg.min_margin) / (0.9 - cfg.min_margin))
            score = round(max(0.05, gate_conf) * (0.35 * margin_norm + 0.25 * f + 0.25 * q + 0.15 * p), 4)
            out.append(Match(opportunity_key=o.key, talent_keys=[m.key for m in members], ask_value=ask, ask_basis=pr["ask_basis"],
                             labor_cost=round(cost, 2), hours_estimate=hours, margin=round(margin, 3), fit_score=round(f, 3),
                             quality_score=round(q, 3), price_score=round(p, 3), gate_ok=bool(v and v.arbitrage_viable),
                             score=score, notes=notes))
    out.sort(key=lambda m: -m.score)
    return out
