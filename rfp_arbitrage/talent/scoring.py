"""'Provably good' and 'underpriced' as numbers, from evidence anyone can verify on the
profile page: job success, hours billed, dollars earned, badges, reviews, portfolio.

Quality (0..1): weighted evidence with hard floors -- no JSS or JSS < 85 caps at 0.3; under
100 hours AND under $5k earned caps at 0.35, because a perfect score on two jobs proves
nothing. Teams (agencies) are scored on the same signals plus a size bonus (bench depth).

Price (0..1): how far the asking rate sits below the reference market rate for the talent's
primary skill family. 0 at/above reference, 1 at <= 30 % of reference. Reference rates are
North American mid-level consulting rates in USD/hour -- edit REFERENCE_RATES for your
market; they are inputs, not facts."""
from __future__ import annotations

import re

from ..models import Talent

REFERENCE_RATES: dict[str, float] = {
    "software": 120.0, "data": 130.0, "ai_ml": 150.0, "cloud_devops": 130.0, "cybersecurity": 150.0,
    "design": 85.0, "writing": 70.0, "marketing": 90.0, "translation": 60.0, "video": 80.0,
    "consulting": 150.0, "finance": 120.0, "legal": 200.0, "engineering": 130.0, "research": 90.0,
    "training": 80.0, "project_management": 100.0, "gis": 100.0, "admin": 40.0, "general": 80.0,
}

SKILL_FAMILIES: dict[str, str] = {
    "software": r"software|developer|programm|python|java\b|javascript|typescript|react|node|\.net|c#|c\+\+|golang|\brust\b|php|ruby|rails|django|flask|api|backend|frontend|full[- ]?stack|mobile|ios|android|flutter|web dev|wordpress|drupal|salesforce|sharepoint|erp|crm|integration|qa\b|testing|devops",
    "data": r"\bdata\b|sql|analytics|tableau|power ?bi|etl|warehouse|snowflake|spark|pandas|statistic|excel|dashboard|visuali",
    "ai_ml": r"machine learning|\bml\b|\bai\b|deep learning|nlp|llm|langchain|openai|computer vision|tensorflow|pytorch|prompt|chatbot|rag\b",
    "cloud_devops": r"aws|azure|gcp|google cloud|kubernetes|docker|terraform|devops|sre|linux|cloud",
    "cybersecurity": r"security|penetration|pentest|soc ?2|iso ?27001|nist|cissp|vulnerab|compliance audit|grc\b",
    "design": r"design|ux|ui\b|figma|graphic|illustrat|branding|logo|adobe|photoshop|indesign|typograph|print design",
    "writing": r"writ|copy|editor|editing|proofread|content|technical writ|grant|proposal|journalis|blog|documentation",
    "marketing": r"marketing|seo|sem\b|ppc|social media|campaign|brand strateg|public relations|\bpr\b|advertis|communications",
    "translation": r"translat|interpret|localiz|subtitl|transcri|french|spanish|bilingual",
    "video": r"video|animation|motion graphics|premiere|after effects|3d|audio|podcast|photograph",
    "consulting": r"consult|strateg|management|business analys|process improvement|change management|organi[sz]ational|policy|governance|advisory",
    "finance": r"account|bookkeep|cpa|financial|audit|tax|actuar|budget|forecast|quickbooks|cfo",
    "legal": r"legal|lawyer|attorney|paralegal|contract review|regulatory|compliance",
    "engineering": r"engineer(?!ing manager)|cad|autocad|revit|civil|mechanical|electrical|structural|architect(?!ure of)",
    "research": r"research|survey|market research|literature review|academic|phd|economist|evaluation|evaluator",
    "training": r"training|instructional|curriculum|e-?learning|course|facilitat|coach|lms|articulate",
    "project_management": r"project manag|pmp|scrum|agile|program manag|pmo|coordinator",
    "gis": r"\bgis\b|arcgis|qgis|mapping|geospatial|remote sensing|cartograph",
    "admin": r"virtual assistant|data entry|admin|customer service|scheduling|transcription",
}
_FAMILY_RE = {k: re.compile(v, re.I) for k, v in SKILL_FAMILIES.items()}


def normalize_skills(skills: list[str] | str) -> list[str]:
    if isinstance(skills, str):
        skills = re.split(r"[,;|/\n]+", skills)
    out = []
    for s in skills:
        s = re.sub(r"\s+", " ", s.strip().lower())
        if s and s not in out:
            out.append(s)
    return out


def skill_families(skills: list[str], title: str = "") -> dict[str, int]:
    blob = " ".join(skills) + " " + title
    hits = {}
    for fam, rx in _FAMILY_RE.items():
        n = len(rx.findall(blob))
        if n:
            hits[fam] = n
    return dict(sorted(hits.items(), key=lambda kv: -kv[1]))


def primary_family(t: Talent) -> str:
    fams = skill_families(t.skills, t.title)
    return next(iter(fams), "general")


def score_quality(t: Talent) -> tuple[float, list[str]]:
    notes: list[str] = []
    jss = t.job_success_pct
    hours = t.total_hours or 0.0
    earned = t.total_earnings or 0.0
    jobs = t.total_jobs or 0
    badges = {b.lower().replace(" ", "_") for b in t.badges}
    s = 0.0
    if jss is not None:
        if jss >= 98: s += 0.30
        elif jss >= 95: s += 0.25
        elif jss >= 90: s += 0.18
        elif jss >= 85: s += 0.08
        notes.append(f"JSS {jss:.0f}%")
    # volume: log-ish steps; hours OR dollars, whichever proves more
    vol = 0.0
    if hours >= 5000 or earned >= 500_000: vol = 0.30
    elif hours >= 2000 or earned >= 200_000: vol = 0.25
    elif hours >= 1000 or earned >= 100_000: vol = 0.20
    elif hours >= 500 or earned >= 30_000: vol = 0.14
    elif hours >= 100 or earned >= 5_000: vol = 0.07
    s += vol
    if hours or earned:
        notes.append(f"{hours:,.0f} h / ${earned:,.0f} earned / {jobs} jobs")
    if "expert_vetted" in badges: s += 0.20; notes.append("Expert-Vetted")
    elif "top_rated_plus" in badges: s += 0.16; notes.append("Top Rated Plus")
    elif "top_rated" in badges: s += 0.12; notes.append("Top Rated")
    elif "rising_talent" in badges: s += 0.04; notes.append("Rising Talent")
    if t.rating is not None and t.reviews_count:
        s += min(0.10, (t.rating / 5.0) * min(1.0, t.reviews_count / 30) * 0.10)
        notes.append(f"{t.rating:.1f}/5 over {t.reviews_count} reviews")
    if t.portfolio_items:
        s += min(0.06, 0.01 * t.portfolio_items)
    if t.is_team:
        s += min(0.08, 0.01 * max(0, t.team_size - 1))
        notes.append(f"team of {t.team_size}")
    # floors: unproven is unproven
    if jss is None or jss < 85:
        s = min(s, 0.30); notes.append("floor: JSS missing or < 85")
    if hours < 100 and earned < 5_000 and not t.is_team:
        s = min(s, 0.35); notes.append("floor: < 100 h and < $5k")
    return round(min(1.0, s), 3), notes


def score_price(t: Talent, reference: dict[str, float] | None = None) -> tuple[float, str]:
    ref_table = reference or REFERENCE_RATES
    fam = primary_family(t)
    ref = ref_table.get(fam, ref_table["general"])
    if not t.hourly_rate or t.hourly_rate <= 0:
        return 0.0, f"no rate ({fam})"
    rate = t.hourly_rate if t.currency.upper() == "USD" else t.hourly_rate * {"CAD": 0.73, "EUR": 1.08, "GBP": 1.27}.get(t.currency.upper(), 1.0)
    ratio = rate / ref
    if ratio >= 1.0:
        return 0.0, f"${rate:.0f}/h at/above {fam} reference ${ref:.0f}"
    score = min(1.0, (1.0 - ratio) / 0.7)   # 30 % of reference -> 1.0
    return round(score, 3), f"${rate:.0f}/h is {ratio:.0%} of {fam} reference ${ref:.0f}"
