"""PROPOSE: draft the bid from the bound solicitation, through openzoo, for the opportunities
that survived gate + price + match. The draft is the first artifact of the delivery loop --
the same context that produced the verdict and the scope produces the proposal, the buyer
Q&A, and later the deliverables and their revisions. Output: a Markdown proposal plus a
structured record (compliance matrix, assumptions, questions for the buyer, price).

The proposal speaks in ASSETS AND RESOURCES, never in production method: a buyer is purchasing
an outcome against acceptance criteria, and how the firm marshals capacity to meet them is not
something these solicitations ask to be disclosed. Where a solicitation DOES require disclosure
of methods or tooling, that requirement is answered truthfully in the compliance matrix -- the
clause gate has already recorded whether the solicitation demands it."""
from __future__ import annotations

import json
from typing import Any

from .bidder import Bidder
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
                 "description": "the resources assigned: roles and accountable leads, described as assets/capacity the firm brings; never the production method"},
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
intellectual work: software, data, studies, writing, design, analysis. Read the bound solicitation.

HOW TO DESCRIBE THE DELIVERY TEAM. Speak in terms of ASSETS AND RESOURCES the firm brings to bear --
"our delivery resources", "the assets assigned to this engagement", "capacity", "the review team",
named accountable leads. Do NOT describe the production method, do NOT name AI, automation, models
or tooling, and do NOT claim headcount you cannot name. Never assert a registration, certification,
clearance, bond or past-performance reference the bidder block does not state: carry the bracketed
placeholder through instead, so a human fills it or the bid is not sent.

NO INVENTED CREDENTIALS, EVER. This is a false-certification risk, not a style note. Do not give a
role a certification (PMP, PE, CPA, CISSP, security clearance), a number of years of experience, a
named prior employer, or a past project unless the bidder block states it. Describe each role by the
WORK IT OWNS on this engagement -- "owns the monthly schedule and cost reporting", "independent
reviewer of every deliverable before submission" -- and nothing else. Where the solicitation demands
credentials, resumes, past performance or registrations, put the requirement in the compliance matrix
with a bracketed placeholder as the response, so a human supplies it or the bid is withdrawn. The buyer is purchasing an outcome against
acceptance criteria; how the firm marshals its resources to meet them is not a disclosure the
solicitation asks for. If the solicitation itself requires disclosure of methods or tooling, answer
that requirement truthfully and completely in the compliance matrix. Mirror its structure and its evaluation criteria. Build the
compliance matrix from the solicitation's own mandatory requirements, citing where each one lives. Be concrete:
deliverables with acceptance criteria, a schedule that respects stated dates, assumptions that protect margin,
questions that a serious bidder would ask before pricing. Never invent past performance, certifications, or
registrations; leave those as bracketed placeholders like [PAST PERFORMANCE 1]. Price at the figure given."""


# Claims a draft must not make on its own. Each is a phrase that asserts something only the
# bidder profile can establish; the check runs on the finished text, because a prompt is a request
# and this is a rule.
_FORBIDDEN = [
    (r"\b(registered|active)\b[^.]{0,60}\bSAM\.gov\b", "claims SAM.gov registration"),
    (r"\bvalid\s+(UEI|CAGE)\b|\bUEI\s*(?:code|number)?\s*[:#]?\s*[A-Z0-9]{12}\b", "claims a UEI/CAGE we do not have"),
    # PMP as a CREDENTIAL, not "project management plan (PMP)" the document
    (r"\b(PMP|PE|CPA|CISSP|PMI-ACP|CISA|LEED)[-\s]?(certified|credentialed)\b|\((?:PMP|PE|CPA|CISSP|CISA|LEED),", "asserts a professional certification"),
    (r"\b\d{1,2}\+?\s*years?\b[^.]{0,40}\bexperience\b", "asserts years of experience"),
    (r"\b(we|our firm|the firm)\b[^.]{0,50}\b(previously|have|has)\s+(delivered|completed|performed|supported)\b", "asserts past performance"),
    (r"\b(security clearance|facility clearance|bonded|insured for)\b", "asserts a clearance or bond"),
    (r"\bISO\s?\d{4,5}\b|\bCMMI\b|\bSOC\s?2\b", "asserts a certification standard"),
]


def unsupported_claims(text: str, bidder: Bidder) -> list[str]:
    """Every forbidden assertion the draft makes that the bidder profile does not support."""
    import re as _re
    held = " ".join(filter(None, [bidder.uei, bidder.cage])).upper()
    out = []
    for pat, why in _FORBIDDEN:
        for m in _re.finditer(pat, text, _re.I):
            frag = text[max(0, m.start() - 60):m.end() + 60].replace("\n", " ")
            if held and any(h and h in frag.upper() for h in held.split()):
                continue
            out.append(f"{why}: ...{frag.strip()}...")
            break
    return out


def _render(opp: Opportunity, data: dict[str, Any], bidder: Bidder) -> str:
    md = [f"# {data.get('title') or opp.title}", "",
          f"*Response to {opp.buyer} · {opp.title} · closes {opp.deadline[:10]}*", "",
          "```", bidder.block(), "```", "",
          "## Executive summary", data.get("executive_summary", ""), "",
          "## Our understanding", data.get("understanding", ""), "",
          "## Approach"] + [f"- {a}" for a in data.get("approach", [])] + ["", "## Deliverables and acceptance"]
    md += [f"- **{d.get('name')}** -- {d.get('acceptance')}" for d in data.get("deliverables", [])]
    md += ["", "## Schedule"] + [f"- {x}" for x in data.get("schedule", [])] + ["", "## Team"] + [f"- {t}" for t in data.get("team", [])]
    md += ["", "## Compliance matrix", "| requirement | where | response |", "|---|---|---|"]
    md += [f"| {c.get('requirement', '')} | {c.get('where', '')} | {c.get('response', '')} |".replace("\n", " ")
           for c in data.get("compliance_matrix", [])]
    md += ["", "## Assumptions"] + [f"- {a}" for a in data.get("assumptions", [])]
    md += ["", "## Questions for the buyer"] + [f"- {q}" for q in data.get("questions_for_buyer", [])]
    md += ["", "## Price", f"**${float(data.get('price_usd') or 0):,.0f}** -- {data.get('price_rationale', '')}"]
    return "\n".join(md)


def draft(opp: Opportunity, text: str, pricing: dict[str, Any], match: dict[str, Any] | None, llm: LLM,
          context_id: str | None) -> tuple[str, dict[str, Any]]:
    ask = pricing.get("ask_value") or 0
    target = round(ask * 0.92, -2) if ask else 0          # bid just under the comparable median by default
    bidder = Bidder.load()
    user = (f"BIDDER (use this identity verbatim):\n{bidder.block(redact_ein=False)}\n\n"
            f"SOLICITATION: {opp.title}\nBUYER: {opp.buyer}\nJURISDICTION: {opp.jurisdiction.value}/{opp.tier.value} {opp.region}\n"
            f"CLOSES: {opp.deadline}\nNOTICE TYPE: {opp.notice_type}\nURL: {opp.url}\n\n"
            f"SCOPE ESTIMATE: {pricing.get('hours_low', 0):.0f}-{pricing.get('hours_high', 0):.0f} hours; skill mix {pricing.get('skill_mix')}; "
            f"deliverables already identified: {pricing.get('deliverables', [])[:8]}\n"
            f"COMPARABLE AWARDS: {pricing.get('benchmark', {})}\nBID PRICE TO USE (USD): {target:,.0f}\n\n"
            f"OPENING OF THE SOLICITATION:\n{text[:3000]}")
    data = llm.json(SYSTEM, user, PROPOSAL_SCHEMA, max_tokens=6000, context_id=context_id, top_k=32)
    text = _render(opp, data, bidder)
    text = "\n".join(md)
    problems = unsupported_claims(text, bidder)
    # REWRITE, DO NOT JUST COMPLAIN. A flagged draft is a draft the model can fix: hand it back
    # the exact violations and the identity it must respect, and take the corrected version.
    for attempt in range(2):
        if not problems:
            break
        repair = (f"Your draft response makes claims this bidder cannot support. Rewrite it so every one is gone.\n\n"
                  f"THE BIDDER, in full — nothing beyond this may be asserted:\n{bidder.block(redact_ein=False)}\n\n"
                  f"VIOLATIONS TO REMOVE ({len(problems)}):\n"
                  + "\n".join(f"- {p}" for p in problems)
                  + "\n\nRules for the rewrite: state no registration, certification, clearance, bond, years of "
                    "experience, prior employer or past project that the bidder block above does not contain. Where the "
                    "solicitation requires one, answer with a bracketed placeholder such as [UEI PENDING SAM.GOV "
                    "REGISTRATION] or [PAST PERFORMANCE 1] so a human supplies it. Describe each role by the work it "
                    "owns on this engagement, never by credentials. Keep everything else — scope, deliverables, "
                    "schedule, compliance matrix, price — as strong as it was.\n\n"
                    "YOUR DRAFT:\n" + json.dumps(data)[:60000])
        try:
            data = llm.json(SYSTEM, repair, PROPOSAL_SCHEMA, max_tokens=16000, context_id=context_id, top_k=24)
        except LLMError as e:
            data.setdefault("repair_errors", []).append(str(e)[:200])
            break
        text = _render(opp, data, bidder)
        problems = unsupported_claims(text, bidder)
    if problems:
        banner = ["> **NOT SUBMITTABLE AS WRITTEN.** The draft still asserts things this bidder cannot support,",
                  "> after a rewrite. A human must correct each line below before this is sent.", ">"]
        banner += [f"> - {p[:300]}" for p in problems]
        text = "\n".join(banner) + "\n\n" + text
        data["unsupported_claims"] = problems
    data["bidder"] = bidder.to_dict() | {"ein": "redacted"}
    return text, data
