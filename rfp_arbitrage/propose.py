"""PROPOSE: draft the bid from the bound solicitation, through openzoo, for the opportunities
that survived gate + price + match. The draft is the first artifact of the delivery loop --
the same context that produced the verdict and the scope produces the proposal, the buyer
Q&A, and later the deliverables and their revisions. Output: a Markdown proposal plus a
structured record (compliance matrix, assumptions, questions for the buyer, price)."""
from __future__ import annotations

from typing import Any

from .llm import LLM, LLMError
from .models import Opportunity

PROPOSAL_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False,
    "required": ["title", "executive_summary", "understanding", "approach", "deliverables", "schedule", "team",
                 "compliance_matrix", "assumptions", "questions_for_buyer", "price_usd", "price_rationale"],
    "properties": {
        "title": {"type": "string"},
        "executive_summary": {"type": "string"},
        "understanding": {"type": "string", "description": "the buyer's problem in their own terms, citing the solicitation"},
        "approach": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
        "deliverables": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["name", "acceptance"],
                                                    "properties": {"name": {"type": "string"}, "acceptance": {"type": "string"}}}, "maxItems": 15},
        "schedule": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
        "team": {"type": "array", "items": {"type": "string"}, "maxItems": 8,
                 "description": "roles on the delivery team (AI teams with named human accountable leads / reviewers)"},
        "compliance_matrix": {"type": "array", "maxItems": 30, "items": {"type": "object", "additionalProperties": False,
                              "required": ["requirement", "where", "response"],
                              "properties": {"requirement": {"type": "string"}, "where": {"type": "string"}, "response": {"type": "string"}}}},
        "assumptions": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
        "questions_for_buyer": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
        "price_usd": {"type": "number"},
        "price_rationale": {"type": "string"},
    },
}

SYSTEM = """You write winning, compliant responses to public-sector solicitations for a firm that delivers
intellectual work (software, data, studies, writing, design, analysis) through AI teams with human accountable
leads and reviewers. Read the bound solicitation. Mirror its structure and its evaluation criteria. Build the
compliance matrix from the solicitation's own mandatory requirements, citing where each one lives. Be concrete:
deliverables with acceptance criteria, a schedule that respects stated dates, assumptions that protect margin,
questions that a serious bidder would ask before pricing. Never invent past performance, certifications, or
registrations; leave those as bracketed placeholders like [PAST PERFORMANCE 1]. Price at the figure given."""


def draft(opp: Opportunity, text: str, pricing: dict[str, Any], match: dict[str, Any] | None, llm: LLM,
          context_id: str | None) -> tuple[str, dict[str, Any]]:
    ask = pricing.get("ask_value") or 0
    target = round(ask * 0.92, -2) if ask else 0          # bid just under the comparable median by default
    user = (f"SOLICITATION: {opp.title}\nBUYER: {opp.buyer}\nJURISDICTION: {opp.jurisdiction.value}/{opp.tier.value} {opp.region}\n"
            f"CLOSES: {opp.deadline}\nNOTICE TYPE: {opp.notice_type}\nURL: {opp.url}\n\n"
            f"SCOPE ESTIMATE: {pricing.get('hours_low', 0):.0f}-{pricing.get('hours_high', 0):.0f} hours; skill mix {pricing.get('skill_mix')}; "
            f"deliverables already identified: {pricing.get('deliverables', [])[:8]}\n"
            f"COMPARABLE AWARDS: {pricing.get('benchmark', {})}\nBID PRICE TO USE (USD): {target:,.0f}\n\n"
            f"OPENING OF THE SOLICITATION:\n{text[:3000]}")
    data = llm.json(SYSTEM, user, PROPOSAL_SCHEMA, max_tokens=6000, context_id=context_id, top_k=32)
    md = [f"# {data.get('title') or opp.title}", "", f"*Response to {opp.buyer} · {opp.title} · closes {opp.deadline[:10]}*", "",
          "## Executive summary", data.get("executive_summary", ""), "", "## Our understanding", data.get("understanding", ""), "",
          "## Approach"] + [f"- {a}" for a in data.get("approach", [])] + ["", "## Deliverables and acceptance"]
    md += [f"- **{d.get('name')}** -- {d.get('acceptance')}" for d in data.get("deliverables", [])]
    md += ["", "## Schedule"] + [f"- {s}" for s in data.get("schedule", [])] + ["", "## Team"] + [f"- {t}" for t in data.get("team", [])]
    md += ["", "## Compliance matrix", "| requirement | where | response |", "|---|---|---|"]
    md += [f"| {c.get('requirement', '')} | {c.get('where', '')} | {c.get('response', '')} |".replace("\n", " ") for c in data.get("compliance_matrix", [])]
    md += ["", "## Assumptions"] + [f"- {a}" for a in data.get("assumptions", [])]
    md += ["", "## Questions for the buyer"] + [f"- {q}" for q in data.get("questions_for_buyer", [])]
    md += ["", "## Price", f"**${float(data.get('price_usd') or target):,.0f}** -- {data.get('price_rationale', '')}"]
    return "\n".join(md), data
