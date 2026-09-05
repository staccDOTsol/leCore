"""THE LEGAL GATE. Service arbitrage -- winning the contract and having a subcontractor or an
AI team deliver it -- is only lawful where the solicitation and its incorporated terms do not
forbid it. So the gate looks for the EXPLICIT NON-DENIAL of delegation:

    viable  <=>  delegation is not explicitly prohibited  AND  AI use is not explicitly prohibited

"Silent" counts as non-denial (that is the user's rule and, for subcontracting, the usual
default in North American public procurement: assignment of the CONTRACT is restricted,
subcontracting of WORK is allowed, often subject to disclosure or consent). Consent
requirements, self-performance minimums, key-personnel locks, data-residency rules and
clearance requirements do not flip the verdict but are surfaced as conditions.

Method:
  1. prescreen()   -- regex pulls every passage that talks about subcontracting, assignment,
                      personnel, AI/automation, data residency, clearances. Keeps the LLM
                      call small and puts the model's eyes on the right paragraphs.
  2. LLM verdict   -- structured JSON with VERBATIM quotes for every non-silent finding.
                      The model is told not to infer prohibition from vague language.
  3. cross-check   -- the regex heuristic runs too; a disagreement on an explicit prohibition
                      lowers confidence and is written into other_blockers so a human looks.
When no LLM is reachable the heuristic verdict is stored with method="heuristic" and
confidence capped at 0.5 -- enough to triage, never enough to bid on.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .llm import LLM, LLMError
from .models import AIStatus, ClauseVerdict, DelegationStatus, Opportunity

# --- regex prescreen ---------------------------------------------------------------------
TOPICS: dict[str, str] = {
    "subcontract": r"sub-?contract|sub-?consultant|sub-?vendor|subcontractor|third[- ]part(y|ies)|assign(ment|ed)?\b|delegat|"
                   r"own (forces|employees|personnel|staff)|self-?perform|prime contractor|team(ing)? (agreement|partner)|joint venture|consortium",
    "personnel": r"key personnel|named (staff|personnel|individuals)|proposed (staff|team|personnel)|substitut(e|ion) of personnel|"
                 r"replacement of (key )?personnel|resumes?|curricula? vitae|staffing plan|project team",
    "ai": r"artificial intelligence|\bA\.?I\.?\b|generative|large language model|\bLLM|machine[- ]learning|ChatGPT|Claude|Copilot|"
          r"automated (tool|content|generation)|machine[- ]generated|AI[- ]generated|AI[- ]assisted|bot\b|algorithmic",
    "residency": r"data (residency|sovereignty|location)|stored (in|within) (canada|the united states|the u\.?s)|"
                 r"remain (in|within) (canada|the united states)|offshor|outside (of )?(canada|the united states|the country)|"
                 r"cloud (services?|hosting).{0,60}(canada|united states)|export control|ITAR|controlled goods",
    "clearance": r"security clearance|reliability status|secret clearance|top secret|public trust|citizen(ship)?|"
                 r"permanent resident|background (check|screening)|fingerprint|criminal record check|CJIS|HIPAA|FedRAMP|CMMC|PIPEDA|SOC ?2",
    "location": r"on-?site|in-?person|physical(ly)? present|local (office|presence|vendor)|within \d+ (miles|km|kilomet)|"
                r"located in (the )?(city|county|province|state)",
}
_TOPIC_RE = {k: re.compile(v, re.I) for k, v in TOPICS.items()}


@dataclass
class Excerpt:
    topic: str
    text: str
    pos: int


def split_passages(text: str) -> list[tuple[int, str]]:
    text = re.sub(r"\r", "", text)
    out: list[tuple[int, str]] = []
    pos = 0
    for block in re.split(r"\n\s*\n|(?<=\.)\s+(?=[A-Z(\d])", text):
        b = block.strip()
        if b:
            out.append((pos, b))
        pos += len(block) + 1
    return out


def prescreen(text: str, window: int = 700, max_chars: int = 36_000) -> list[Excerpt]:
    """Passages that mention any gate topic, with a little context, deduplicated, bounded."""
    passages = split_passages(text)
    hits: list[Excerpt] = []
    seen: set[int] = set()
    for i, (pos, p) in enumerate(passages):
        for topic, rx in _TOPIC_RE.items():
            if rx.search(p):
                if i in seen:
                    break
                seen.add(i)
                ctx = " ".join(q for _, q in passages[max(0, i - 1): i + 2])
                hits.append(Excerpt(topic, ctx[:window * 2] if len(ctx) > window * 2 else ctx, pos))
                break
    hits.sort(key=lambda e: e.pos)
    total, kept = 0, []
    for e in hits:
        if total + len(e.text) > max_chars:
            break
        kept.append(e)
        total += len(e.text)
    return kept


# --- heuristic verdict -------------------------------------------------------------------
# A gap that must not contain consent language: "prohibited ... unless approved" is consent, not a ban.
_NOCONSENT = r"(?:(?!consent|approv|authori[sz]|permission|unless|except|disclos|prior written).){0,120}"
SUB_PROHIBIT = [
    # "will not subcontract MORE THAN 70 percent" (FAR 52.215-23 pass-through limits) is a cap, not a ban
    r"(shall|must|may|will|can) ?not (sub-?contract|delegate)\b(?! (more than|in excess of|greater than|any more than|over)\b)(?!.{0,80}(without|unless|except))",
    r"(shall|must|may|will|can) ?not assign (the |any |all |its )?(work|services|performance|duties|obligations)\b(?!.{0,80}(without|unless|except))",
    r"\bno (sub-?contracting|subcontractors?|assignment)\b(?!.{0,60}(without|unless|except))",
    r"sub-?contracting (is|will be|shall be|are) (not (permitted|allowed|acceptable)|prohibited|forbidden)",
    r"(prohibit(s|ed)?|forbid(s|den)?) (the )?(use of )?sub-?contract" + _NOCONSENT.replace("{0,120}", "{0,0}"),
    r"sub-?contract(ing|ors?)?" + _NOCONSENT + r"(is |are |will be |shall be )(strictly )?(prohibited|not permitted|not allowed|forbidden)",
    r"must (perform|complete|deliver) (all|100 ?%|the entirety of) (of )?the (work|services)",
    r"(with|using) (its|their|the (contractor|proponent|bidder|offeror)'?s?) own (forces|employees|personnel|staff)(?! (or|and) )",
    r"in-?house (only|exclusively)|(no|without) (use of )?third[- ]part(y|ies)\b(?!.{0,60}(without|unless|except|consent|approval))",
]
SUB_CONSENT = [
    r"(sub-?contract|assign|delegate).{0,120}(without|unless|subject to|only with).{0,40}(prior )?(written )?(consent|approval|authori[sz]ation|permission)",
    r"(consent|approval).{0,60}(before|prior to).{0,60}sub-?contract",
    r"(identify|list|disclose|name|declare).{0,60}(all )?(proposed )?sub-?contractors?",
]
SUB_PERMIT = [
    r"sub-?contract(ing|ors?)? (is|are|will be|shall be|may be) (permitted|allowed|acceptable|encouraged)",
    r"(may|can) (use|engage|retain|employ) (sub-?contractors?|sub-?consultants?|third[- ]part(y|ies)|partners)",
    r"(bidders?|proponents?|offerors?|contractors?|vendors?) (may|can) (sub-?contract|team|partner|form (a )?(joint venture|consortium))",
    r"teaming (agreements?|arrangements?) (are|is) (permitted|allowed|encouraged)|joint ventures? (are|is) (permitted|allowed|eligible)",
]
SELF_PERFORM = [
    r"not sub-?contract (more than|in excess of|greater than|over)\s*(\d{1,3})\s?(%|percent)",
    r"(self-?perform|perform(ed)?|complete[ds]?).{0,60}(at least|a minimum of|not less than|no less than|minimum)\s*(\d{1,3})\s?(%|percent)",
    r"(\d{1,3})\s?(%|percent).{0,80}(own (forces|employees|personnel|staff)|self-?perform|prime contractor)",
    r"(at least|a minimum of|not less than|no less than)\s*(\d{1,3})\s?(%|percent).{0,100}(own (forces|employees|personnel)|self-?perform|by the (prime|contractor))",
]
KEY_PERSONNEL_LOCK = [
    r"key personnel.{0,160}(shall not|may not|cannot|must not|will not) be (replaced|substituted|changed|reassigned|removed)",
    r"(replacement|substitution) of (any )?key personnel.{0,100}(prior )?(written )?(consent|approval)",
    r"(named|proposed|identified) (staff|personnel|individuals|team members?).{0,120}(shall|must) (perform|be assigned to|remain on|be available for)",
]
AI_PROHIBIT = [
    r"(use of )?(generative )?(artificial intelligence|\bAI\b|large language models?|LLMs?|ChatGPT|machine[- ]generated|AI[- ]generated|automated (tools?|content generation))" + _NOCONSENT + r"(is |are |will be |shall be )?(strictly )?(prohibited|not permitted|not allowed|forbidden|banned|will not be accepted|will be rejected|will be disqualified|grounds for disqualification)",
    r"(shall|must|may|will|can) ?not (use|employ|utili[sz]e|rely on|incorporate|submit).{0,60}(generative )?(artificial intelligence|\bAI\b|large language models?|LLMs?|ChatGPT|machine[- ]learning)(?!.{0,80}(without|unless|except|consent|approv))",
    r"(proposals?|submissions?|responses?|deliverables?|work product|content).{0,60}(generated|produced|written|prepared|created|drafted) (in whole or in part )?(by|using|with|through).{0,20}(generative )?(artificial intelligence|\bAI\b|large language models?|LLMs?).{0,120}(prohibited|not (be )?(permitted|allowed|accepted)|rejected|disqualif|ineligible|non-?responsive)",
    r"(no|without) (use of )?(generative )?(artificial intelligence|\bAI\b|LLMs?|large language models?)\b(?!.{0,60}(without|unless|except|consent|approval|disclos))",
    r"(must|shall) be (performed|produced|prepared|written|created) (solely |entirely |exclusively )?by (human|natural person|the (contractor|proponent)'?s? (staff|employees|personnel))",
]
AI_RESTRICT = [
    r"(disclose|declare|identify|notify|inform).{0,80}(use of )?(generative )?(artificial intelligence|\bAI\b|LLMs?|large language models?)",
    r"(artificial intelligence|\bAI\b|LLMs?|large language models?|generative).{0,120}(confidential|sensitive|personal|proprietary|protected) (data|information)",
    r"(artificial intelligence|\bAI\b|generative).{0,120}(subject to|with|requires?|only with|upon).{0,40}(prior )?(written )?(approval|consent|authori[sz]ation)",
    r"(responsible|accountable|liable) for.{0,80}(output|content|deliverables?).{0,60}(generated|produced).{0,40}(artificial intelligence|\bAI\b)",
    r"(human (review|oversight|in the loop)|reviewed by a (qualified )?(human|professional)).{0,120}(artificial intelligence|\bAI\b|automated)",
]
AI_PERMIT = [
    r"(may|can|encouraged to|welcome to|permitted to) (use|leverage|employ|utili[sz]e|incorporate).{0,40}(generative )?(artificial intelligence|\bAI\b|LLMs?|large language models?|machine learning|automation)",
    r"(use of )?(artificial intelligence|\bAI\b|LLMs?|generative|machine learning|automation)( tools?| solutions?| technolog(y|ies))?.{0,60}(is |are )?(permitted|allowed|acceptable|encouraged|welcome)",
]
RESIDENCY = [
    r"(data|information|records).{0,80}(shall|must|will|to) (remain|reside|be stored|be hosted|be processed|be kept|stay|be located) (solely |only |exclusively )?(in|within) (canada|the united states|the u\.?s\.?a?\b|the province|the state|[A-Z][a-z]+ (province|state))",
    r"(no|not|never|shall not|must not).{0,40}(stored|hosted|processed|transferred|transmitted|accessed).{0,60}(outside|beyond) (of )?(canada|the united states|the u\.?s\.?a?\b|the country|north america)",
    r"(offshore|off-?shoring|outside (of )?(canada|the united states)).{0,100}(prohibited|not permitted|not allowed|shall not)",
    r"\b(ITAR|export control(led)?|controlled goods|CMMC|FedRAMP|IRAP|Protected B|CJIS)\b",
]
CLEARANCE = [
    r"(security clearance|reliability status|secret clearance|top secret|public trust|enhanced reliability|CJIS|federal security).{0,120}(required|must|shall|mandatory|hold|possess|obtain)",
    r"(must|shall) (be|hold|possess|obtain|have).{0,40}(security clearance|reliability status|secret clearance|public trust)",
    r"(must|shall|only) (be )?(a )?(u\.?s\.?|united states|canadian) citizens?|citizenship (is )?(required|mandatory)|(permanent resident|resident of canada) (status )?(is )?(required|mandatory)",
]


def _find(patterns: list[str], text: str, flags=re.I | re.S) -> list[str]:
    out: list[str] = []
    for p in patterns:
        for m in re.finditer(p, text, flags):
            a, b = max(0, m.start() - 160), min(len(text), m.end() + 160)
            snippet = re.sub(r"\s+", " ", text[a:b]).strip()
            if snippet not in out:
                out.append(snippet)
            if len(out) >= 6:
                return out
    return out


def heuristic_verdict(key: str, text: str) -> ClauseVerdict:
    t = text or ""
    sub_pro, sub_con, sub_ok = _find(SUB_PROHIBIT, t), _find(SUB_CONSENT, t), _find(SUB_PERMIT, t)
    self_perf = None
    for p in SELF_PERFORM:
        m = re.search(p, t, re.I | re.S)
        if m:
            nums = [g for g in m.groups() if g and g.isdigit()]
            if nums:
                self_perf = float(nums[0])
                if p.startswith("not sub-?contract"):
                    self_perf = 100.0 - self_perf
                break
    kp = _find(KEY_PERSONNEL_LOCK, t)
    ai_pro, ai_res, ai_ok = _find(AI_PROHIBIT, t), _find(AI_RESTRICT, t), _find(AI_PERMIT, t)
    res, clr = _find(RESIDENCY, t), _find(CLEARANCE, t)

    if self_perf is not None and self_perf >= 100:
        d = DelegationStatus.EXPLICITLY_PROHIBITED
    elif self_perf is not None or kp:
        d = DelegationStatus.RESTRICTED
    elif sub_pro and not sub_ok:
        d = DelegationStatus.EXPLICITLY_PROHIBITED
    elif sub_con:
        d = DelegationStatus.PERMITTED_WITH_CONSENT
    elif sub_ok:
        d = DelegationStatus.EXPLICITLY_PERMITTED
    else:
        d = DelegationStatus.SILENT
    if ai_pro and not ai_ok:
        a = AIStatus.EXPLICITLY_PROHIBITED
    elif ai_res:
        a = AIStatus.RESTRICTED
    elif ai_ok:
        a = AIStatus.EXPLICITLY_PERMITTED
    else:
        a = AIStatus.SILENT
    conf = 0.5 if (sub_pro or sub_ok or sub_con or ai_pro or ai_ok or ai_res) else 0.3
    if not t.strip():
        conf = 0.0
    return ClauseVerdict(
        opportunity_key=key, delegation=d, ai_use=a,
        delegation_evidence=(sub_pro or sub_ok or sub_con)[:4], ai_evidence=(ai_pro or ai_ok or ai_res)[:4],
        self_perform_min_pct=self_perf, key_personnel_lock=bool(kp), consent_required=bool(sub_con),
        data_residency_constraints=res[:3], clearance_or_citizenship_required=bool(clr),
        other_blockers=([] if t.strip() else ["no solicitation text available -- verdict is a placeholder"]),
        confidence=conf, rationale="regex heuristic; not a legal reading", method="heuristic", text_chars=len(t),
    )


# --- LLM verdict -------------------------------------------------------------------------
VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["delegation", "delegation_evidence", "ai_use", "ai_evidence", "self_perform_min_pct",
                 "key_personnel_lock", "consent_required", "data_residency_constraints",
                 "clearance_or_citizenship_required", "other_blockers", "confidence", "rationale"],
    "properties": {
        "delegation": {"type": "string", "enum": [s.value for s in DelegationStatus]},
        "delegation_evidence": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
        "ai_use": {"type": "string", "enum": [s.value for s in AIStatus]},
        "ai_evidence": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
        "self_perform_min_pct": {"type": ["number", "null"]},
        "key_personnel_lock": {"type": "boolean"},
        "consent_required": {"type": "boolean"},
        "data_residency_constraints": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
        "clearance_or_citizenship_required": {"type": "boolean"},
        "other_blockers": {"type": "array", "items": {"type": "string"}, "maxItems": 8},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "rationale": {"type": "string"},
    },
}

SYSTEM_PROMPT = """You are procurement counsel's analyst. You read public-sector solicitations (RFPs, RFQs,
RFIs, tender notices, terms and conditions, sample contracts) from the United States and Canada, in English or
French, and answer ONE question with evidence: does this solicitation EXPLICITLY DENY the winning bidder the
ability to have the work performed by (a) subcontractors / partners / a delegated team, or (b) AI systems?

Definitions you must apply:
- delegation = explicitly_prohibited: the text says subcontracting, assignment OF THE WORK, or delegation is not
  permitted, or that the contractor must perform all work with its own employees. A restriction on assigning THE
  CONTRACT (the legal agreement) is NOT a prohibition on subcontracting the work.
- delegation = restricted: allowed but with a self-performance minimum, a key-personnel lock (named staff cannot be
  substituted without approval), or a cap on the share subcontracted.
- delegation = permitted_with_consent: allowed subject to disclosure, prior written consent or buyer approval of
  the subcontractor.
- delegation = explicitly_permitted: the text says subcontracting/teaming/joint ventures are allowed or encouraged.
- delegation = silent: nothing in the provided text addresses it.
- ai_use = explicitly_prohibited: the text bans using AI / generative AI / LLMs / automated tools to produce the
  proposal or the deliverables, or says AI-produced work will be rejected, or requires deliverables to be created
  solely by humans.
- ai_use = restricted: AI use is allowed only with disclosure, approval, human review, or not with confidential data.
- ai_use = explicitly_permitted: the text allows or encourages AI/automation.
- ai_use = silent: not addressed.

Rules:
1. Quote VERBATIM evidence (short excerpts, <= 300 characters each) for every status other than "silent". No
   quote, no finding -- if you cannot quote it, the status is "silent".
2. Do NOT infer a prohibition from generic language ("the Contractor is responsible for all work", "no assignment
   of this Agreement", confidentiality clauses, professional-standards clauses). Those are not denials.
3. Record self-performance minimums (as a percent of contract value or hours), key-personnel locks, consent
   requirements, data-residency / export-control constraints, and security clearance or citizenship requirements
   -- they are conditions, not denials.
4. other_blockers: anything else that would stop a remote delegated team from lawfully delivering (mandatory
   on-site presence, licensed-professional stamp required, local-vendor-only eligibility, set-aside the bidder
   cannot meet, mandatory site visit, physical goods bundled with the intellectual work).
5. confidence reflects how much of the solicitation you actually saw: excerpts of a long document warrant <= 0.8;
   a notice without its attachments warrants <= 0.6.
6. rationale: two or three sentences a lawyer could check in a minute."""


def _user_prompt(opp: Opportunity, text: str, excerpts: list[Excerpt], full: bool) -> str:
    head = (f"SOLICITATION\ntitle: {opp.title}\nbuyer: {opp.buyer}\njurisdiction: {opp.jurisdiction.value} / {opp.tier.value} / {opp.region}\n"
            f"notice type: {opp.notice_type}\nsource url: {opp.url}\n")
    if full:
        return head + f"\nFULL TEXT ({len(text)} chars):\n" + text
    body = "\n\n".join(f"[{e.topic} @ char {e.pos}]\n{e.text}" for e in excerpts)
    return (head + f"\nThe document is {len(text)} characters. Below are every passage that mentions subcontracting, "
            f"assignment, personnel, AI/automation, data residency, clearances or location, with one passage of context "
            f"each. If none of them addresses a topic, that topic is 'silent'.\n\nEXCERPTS:\n" + body)


SMALL_BODY = 9_000     # chars: under openzoo's spill threshold with room for the system prompt + schema


def ensure_context(store, llm: LLM, key: str, text: str) -> str | None:
    """Bind the solicitation once per backend and remember its context id."""
    if llm is None or not llm.can_bind or not text.strip():
        return None
    ctx = store.context(key, llm.name)
    if ctx:
        return ctx
    ctx = llm.bind(text)
    store.put_context(key, ctx, len(text), llm.name)
    return ctx


def analyze(opp: Opportunity, text: str, llm: LLM | None, full_threshold: int = SMALL_BODY,
            context_id: str | None = None) -> ClauseVerdict:
    key = opp.key
    heur = heuristic_verdict(key, text)
    if llm is None or not text.strip():
        return heur
    full = len(text) <= full_threshold
    excerpts = [] if full else prescreen(text, max_chars=SMALL_BODY if context_id else 36_000)
    if not full and not excerpts and not context_id:
        # long document, nothing matched any topic: it is silent, and the model would only see noise
        heur.rationale = "no passage in the document mentions delegation, personnel, AI, residency or clearances"
        heur.confidence = 0.6
        heur.method = f"prescreen+{llm.name}"
        return heur
    user = _user_prompt(opp, text, excerpts, full)
    if context_id and not full:
        user += ("\n\nThe COMPLETE solicitation is bound as your context: recall every passage about subcontracting, "
                 "assignment, teaming, key personnel, artificial intelligence / automated tools, data residency, "
                 "security clearance, citizenship and on-site requirements before answering.")
    try:
        data = llm.json(SYSTEM_PROMPT, user, VERDICT_SCHEMA, max_tokens=3000, context_id=context_id, top_k=24)
    except LLMError as e:
        heur.other_blockers.append(f"LLM unavailable ({e}); heuristic verdict only")
        return heur
    try:
        v = ClauseVerdict(
            opportunity_key=key,
            delegation=DelegationStatus(data["delegation"]), ai_use=AIStatus(data["ai_use"]),
            delegation_evidence=[str(x) for x in data.get("delegation_evidence") or []][:6],
            ai_evidence=[str(x) for x in data.get("ai_evidence") or []][:6],
            self_perform_min_pct=(float(data["self_perform_min_pct"]) if data.get("self_perform_min_pct") is not None else None),
            key_personnel_lock=bool(data.get("key_personnel_lock")), consent_required=bool(data.get("consent_required")),
            data_residency_constraints=[str(x) for x in data.get("data_residency_constraints") or []][:6],
            clearance_or_citizenship_required=bool(data.get("clearance_or_citizenship_required")),
            other_blockers=[str(x) for x in data.get("other_blockers") or []][:8],
            confidence=max(0.0, min(1.0, float(data.get("confidence") or 0))),
            rationale=str(data.get("rationale") or ""), method=f"llm:{llm.name}", text_chars=len(text),
        )
    except (KeyError, ValueError, TypeError) as e:
        heur.other_blockers.append(f"LLM returned malformed verdict ({e}); heuristic verdict only")
        return heur
    # evidence discipline: a non-silent status without a quote is demoted to silent
    if v.delegation != DelegationStatus.SILENT and not v.delegation_evidence:
        v.other_blockers.append(f"model claimed delegation={v.delegation.value} without a quote; demoted to silent")
        v.delegation = DelegationStatus.SILENT
    if v.ai_use != AIStatus.SILENT and not v.ai_evidence:
        v.other_blockers.append(f"model claimed ai_use={v.ai_use.value} without a quote; demoted to silent")
        v.ai_use = AIStatus.SILENT
    # cross-check with the heuristic on the one thing that matters: explicit prohibition
    for field, h, m in (("delegation", heur.delegation, v.delegation), ("ai_use", heur.ai_use, v.ai_use)):
        hp = h.value == "explicitly_prohibited"
        mp = m.value == "explicitly_prohibited"
        if hp != mp:
            v.confidence = min(v.confidence, 0.55)
            ev = (heur.delegation_evidence if field == "delegation" else heur.ai_evidence)[:2]
            v.other_blockers.append(f"heuristic disagrees on {field} (regex={h.value}, model={m.value}); check: {ev}")
    if not full:
        v.confidence = min(v.confidence, 0.8)
    return v
