"""Markdown / JSON dossiers for the ranked matches and a one-screen pipeline summary."""
from __future__ import annotations

import json
from typing import Any

from .store import Store


def _money(v: float | None) -> str:
    return "n/a" if v is None else f"${v:,.0f}"


def match_report(store: Store, limit: int = 25) -> str:
    lines = ["# RFP service-arbitrage shortlist", "",
             "Each entry: the ask (stated or benchmarked), the legal gate verdict with quotes, the labor plan and the margin. "
             "Nothing here is a bid decision -- the gate verdict is an LLM reading with evidence for a human to confirm.", ""]
    # one section per opportunity, best option first, alternatives listed under it
    groups: dict[str, list] = {}
    for m in store.matches(limit * 4):
        groups.setdefault(m.opportunity_key, []).append(m)
    for i, (key, ms) in enumerate(list(groups.items())[:limit], 1):
        m = ms[0]
        o = store.opportunity(key)
        v = store.verdict(key)
        pr = store.pricing(key) or {}
        if not o:
            continue
        lines += [f"## {i}. {o.title}", "",
                  f"- **Buyer**: {o.buyer or '?'} ({o.jurisdiction.value} / {o.tier.value} / {o.region})",
                  f"- **Deadline**: {o.deadline or '?'}  |  **Posted**: {o.posted or '?'}  |  **Type**: {o.notice_type or '?'}",
                  f"- **Link**: {o.url}",
                  f"- **Ask**: {_money(m.ask_value)} ({m.ask_basis})  |  **Hours**: {pr.get('hours_low', 0):.0f}-{pr.get('hours_high', 0):.0f}  |  "
                  f"**Market labor**: {_money(pr.get('market_labor_cost'))}  |  **Overpriced x**: {pr.get('overpriced_ratio')}",
                  f"- **Labor at matched rates**: {_money(m.labor_cost)}  |  **Margin**: {m.margin:.0%}  |  **Score**: {m.score:.3f}",
                  f"- **Skill mix**: {json.dumps(pr.get('skill_mix', {}))}"]
        if v:
            lines += [f"- **Gate** ({v.method}, confidence {v.confidence:.2f}): delegation = `{v.delegation.value}`, AI use = `{v.ai_use.value}` "
                      f"-> **{'VIABLE' if v.arbitrage_viable else 'BLOCKED'}**"]
            for q in v.delegation_evidence[:3]:
                lines.append(f"  - delegation evidence: > {q}")
            for q in v.ai_evidence[:3]:
                lines.append(f"  - AI evidence: > {q}")
            conds = []
            if v.consent_required: conds.append("consent required")
            if v.self_perform_min_pct: conds.append(f"self-perform >= {v.self_perform_min_pct:.0f}%")
            if v.key_personnel_lock: conds.append("key personnel lock")
            if v.clearance_or_citizenship_required: conds.append("clearance / citizenship")
            conds += v.data_residency_constraints[:2]
            if conds:
                lines.append(f"  - conditions: {'; '.join(conds)}")
            for b in v.other_blockers[:4]:
                lines.append(f"  - blocker/note: {b}")
            if v.rationale:
                lines.append(f"  - rationale: {v.rationale}")
        for j, opt in enumerate(ms[:4]):
            label = "Team" if j == 0 else f"Alternative {j}"
            lines.append(f"- **{label}** (labor {_money(opt.labor_cost)}, margin {opt.margin:.0%}, fit {opt.fit_score:.2f}):")
            for k in opt.talent_keys:
                ts = store.talent("key=?", (k,))
                if ts:
                    t = ts[0]
                    lines.append(f"  - {'[team] ' if t.is_team else ''}{t.name} -- {t.title} -- ${t.hourly_rate or 0:.0f}/h {t.currency} -- "
                                 f"JSS {t.job_success_pct or 0:.0f}% -- {t.total_hours or 0:,.0f} h -- {', '.join(t.badges) or 'no badges'} -- {t.url}")
        if pr.get("deliverables"):
            lines.append("- **Deliverables**: " + "; ".join(pr["deliverables"][:6]))
        lines.append("- **Notes**: " + "; ".join(m.notes))
        lines.append("")
    return "\n".join(lines)


def gate_report(store: Store, limit: int = 200) -> str:
    """Every gated opportunity, viable first, for review before any bid."""
    lines = ["| viable | delegation | AI | conf | method | title | buyer | deadline | url |", "|---|---|---|---|---|---|---|---|---|"]
    vs = sorted(store.verdicts().values(), key=lambda v: (not v.arbitrage_viable, -v.confidence))
    for v in vs[:limit]:
        o = store.opportunity(v.opportunity_key)
        if not o:
            continue
        lines.append(f"| {'yes' if v.arbitrage_viable else 'NO'} | {v.delegation.value} | {v.ai_use.value} | {v.confidence:.2f} | {v.method} | "
                     f"{o.title[:70].replace('|', '/')} | {o.buyer[:40].replace('|', '/')} | {o.deadline[:10]} | {o.url} |")
    return "\n".join(lines)


def summary(store: Store) -> dict[str, Any]:
    return store.stats()
