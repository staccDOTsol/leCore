"""Markdown / JSON dossiers for the ranked matches and a one-screen pipeline summary."""
from __future__ import annotations

import json
from typing import Any

from .store import Store


def _money(v: float | None) -> str:
    return "n/a" if v is None else f"${v:,.0f}"


def match_report(store: Store, limit: int = 25) -> str:
    lines = ["# RFP service-arbitrage shortlist", "",
             "Each entry: the ask (stated or benchmarked), the legal gate verdict with quotes, the openzoo delivery cost and the margin. "
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
        lines.append(f"- **Delivery (openzoo)**: {m.hours_estimate:,.0f} h of deliverable -> {_money(m.labor_cost)} "
                     f"(AI team + human review), margin {m.margin:.0%}")
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


def _eligibility(o_setaside: str, verdict_payload, bidder) -> str:
    import json as _j
    clearance = False
    if verdict_payload:
        try:
            clearance = bool(_j.loads(verdict_payload).get("clearance_or_citizenship_required"))
        except Exception:  # noqa: BLE001
            pass
    ok, why = bidder.eligible_for(o_setaside or "", clearance)
    return "" if ok else why


def live_report(store: Store, limit: int = 500) -> str:
    """Every OPEN, intellectual, gate-viable opportunity: deadline, buyer, link, the comparable
    price distribution, the margin at the best matched team when there is one."""
    import json as _json
    rows = store.conn.execute(
        """SELECT o.key, o.title, o.buyer, o.jurisdiction, o.tier, o.region, o.deadline, o.url, o.notice_type, o.intellectual_score, o.set_aside,
                  v.payload AS verdict, p.payload AS pricing,
                  (SELECT payload FROM matches m WHERE m.opportunity_key=o.key ORDER BY score DESC LIMIT 1) AS best
           FROM opportunities o JOIN verdicts v ON v.opportunity_key=o.key AND v.viable=1
           LEFT JOIN pricing p ON p.opportunity_key=o.key
           WHERE o.intellectual_score >= 0.6 AND (o.deadline='' OR o.deadline >= date('now'))
           ORDER BY (p.ask_value IS NULL), COALESCE(p.ask_value, 0) DESC, o.deadline LIMIT ?""", (limit,)).fetchall()
    from .bidder import Bidder
    bidder = Bidder.load()
    lines = ["# Live biddable opportunities", "",
             f"{len(rows)} open, intellectual-work, gate-viable solicitations. Price = distribution of comparable bids/awards "
             "(min / p25 / median / mean / p75 / max, n) or the stated value. Margin = delivered by openzoo at RFP_ZOO_USD_PER_HOUR plus review.", "",
             "| deadline | ask (USD) | basis | min | median | mean | max | n | margin | gate | eligible | title | buyer | where | link |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        pr = _json.loads(r["pricing"]) if r["pricing"] else {}
        b = pr.get("benchmark") or {}
        v = _json.loads(r["verdict"]) if r["verdict"] else {}
        best = _json.loads(r["best"]) if r["best"] else None
        fmt = lambda x: _money(x) if isinstance(x, (int, float)) else ""  # noqa: E731
        gate = f"{v.get('delegation', '')[:12]}/{v.get('ai_use', '')[:10]} {v.get('confidence', 0):.1f}"
        elig = _eligibility(r["set_aside"] if "set_aside" in r.keys() else "", r["verdict"], bidder)
        lines.append(f"| {(r['deadline'] or '')[:10]} | {fmt(pr.get('ask_value'))} | {(pr.get('ask_basis') or '')[:30]} | {fmt(b.get('min'))} | "
                     f"{fmt(b.get('median'))} | {fmt(b.get('mean'))} | {fmt(b.get('max'))} | {b.get('n', '')} | "
                     f"{(str(round(best['margin'] * 100)) + '%') if best else ''} | {gate} | {('NO: ' + elig[:44]) if elig else 'yes'} | {r['title'][:80].replace('|', '/')} | "
                     f"{(r['buyer'] or '')[:40].replace('|', '/')} | {r['jurisdiction']}/{r['tier']} {(r['region'] or '')[:18]} | {r['url']} |")
    return "\n".join(lines)


def ready_board(store: Store, limit: int = 40) -> list[dict[str, Any]]:
    """Drafted bids, newest first: what each is worth, whether it is clean enough to send, and
    what is still in the way. This is the queue a human works from."""
    import json as _j
    from .bidder import Bidder
    bidder = Bidder.load()
    rows = store.conn.execute(
        """SELECT r.opportunity_key, r.markdown, r.payload, r.created, o.title, o.buyer, o.url, o.deadline,
                  o.jurisdiction, o.tier, o.region, o.contact, o.set_aside, p.ask_value, p.payload AS pricing,
                  (SELECT payload FROM matches m WHERE m.opportunity_key=r.opportunity_key ORDER BY score DESC LIMIT 1) AS best
           FROM proposals r JOIN opportunities o ON o.key=r.opportunity_key
           LEFT JOIN pricing p ON p.opportunity_key=r.opportunity_key
           ORDER BY r.created DESC LIMIT ?""", (limit,)).fetchall()
    out = []
    for r in rows:
        data = _j.loads(r["payload"]) if r["payload"] else {}
        best = _j.loads(r["best"]) if r["best"] else {}
        ready, why = bidder.ready_for(r["jurisdiction"], r["tier"])
        # RE-CHECK THE TEXT, never trust a stored flag: drafts written before the checker
        # existed carry no claims list and would otherwise read as clean.
        from .propose import unsupported_claims
        claims = unsupported_claims(r["markdown"] or "", bidder)
        blockers = ([] if ready else [why]) + ([f"{len(claims)} unsupported claim(s) to correct"] if claims else [])
        out.append({
            "key": r["opportunity_key"], "title": r["title"], "buyer": r["buyer"], "url": r["url"],
            "deadline": (r["deadline"] or "")[:10], "where": f"{r['jurisdiction']}/{r['tier']} {r['region'] or ''}".strip(),
            "price": float(data.get("price_usd") or r["ask_value"] or 0),
            "ask": float(r["ask_value"] or 0), "margin": best.get("margin"),
            "delivery": best.get("labor_cost"), "hours": best.get("hours_estimate"),
            "contact": r["contact"] or "", "route": "email" if (r["contact"] or "").count("@") else "portal",
            "sendable": ready and not claims, "blockers": blockers, "claims": claims[:4],
            "deliverables": (data.get("deliverables") or [])[:4], "created": r["created"],
        })
    return out


def summary(store: Store) -> dict[str, Any]:
    return store.stats()
