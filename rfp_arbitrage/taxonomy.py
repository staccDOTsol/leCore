"""Is this solicitation for INTELLECTUAL work -- something a remote professional or an AI
team can deliver -- rather than goods, construction, or physical services?

Three signals, combined into a 0..1 score with a reason string:
  1. classification codes (NAICS for US, UNSPSC for Canada / Socrata, PSC for US federal)
  2. keyword evidence in title + description + source category
  3. hard negatives (construction, paving, HVAC, fleet, food, janitorial...)

The LLM is NOT used here: codes and vocabulary are decisive enough, and this filter runs
over tens of thousands of notices. The LLM is reserved for the legal gate (clauses.py) and
for scope estimation (pricing.py), where reading matters.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# NAICS prefixes: the whole of 54 (professional, scientific, technical) plus publishing,
# data, education, design, media, admin/back-office services. Longer prefix wins.
NAICS_INTELLECTUAL: dict[str, float] = {
    "5411": 1.0,  # legal
    "5412": 1.0,  # accounting, bookkeeping, payroll
    "5413": 0.85, # architecture / engineering (drawings + analysis; site work is not)
    "5414": 1.0,  # specialized design (graphic, industrial, interior)
    "5415": 1.0,  # computer systems design, software, custom programming
    "5416": 1.0,  # management / scientific / technical consulting
    "5417": 0.9,  # R&D
    "5418": 1.0,  # advertising, PR, media buying, marketing
    "5419": 0.9,  # translation, photography, market research, other professional
    "5112": 1.0,  # software publishers
    "5182": 0.9,  # data processing, hosting
    "5191": 0.8,  # web search portals, libraries, other information services
    "5121": 0.8,  # motion picture / video production
    "5122": 0.7,  # sound recording
    "5111": 0.8,  # newspaper/periodical/book publishers (content)
    "6114": 0.9,  # business, computer, management training
    "6116": 0.7,  # other schools and instruction
    "5613": 0.4,  # employment services (staffing -- delegable by construction)
    "5614": 0.7,  # business support (call centers, document prep, collection)
    "5619": 0.3,
    "5231": 0.5, "5239": 0.6,  # financial advisory
    "5241": 0.3, "5242": 0.5,  # insurance-related
    "7111": 0.5, "7115": 0.7,  # performing arts / independent artists, writers
    "9211": 0.3,               # public admin catch-all
}
NAICS_PHYSICAL_PREFIXES = ("23", "31", "32", "33", "42", "44", "45", "48", "49", "11", "21", "22",
                           "5617", "5622", "7211", "7222", "7223", "8111", "8112", "8113", "8123")

# UNSPSC segments (first 2 digits). 80 = management/business/professional/admin services,
# 81 = engineering/research/technology, 43 = IT hardware+software (software 4323xx), 82 = editorial/
# design/graphic/fine art, 84 = financial/insurance, 86 = education/training, 55 = published products.
UNSPSC_INTELLECTUAL: dict[str, float] = {
    "80": 0.95, "81": 0.9, "82": 0.95, "86": 0.85, "84": 0.6, "4323": 0.9, "43": 0.4, "55": 0.5,
    "93": 0.3,   # political / civic affairs services
    "83": 0.2, "85": 0.3, "76": 0.0, "72": 0.0, "70": 0.0, "78": 0.0, "77": 0.2, "90": 0.0, "91": 0.0, "92": 0.1,
}
# US federal PSC: letters for services. R = professional/admin/management, D = IT and telecom,
# B = special studies and analyses, A = R&D, U = education/training, T = photo/map/print/publication.
PSC_INTELLECTUAL: dict[str, float] = {"R": 1.0, "D": 1.0, "B": 1.0, "A": 0.8, "U": 0.9, "T": 0.8,
                                     "L": 0.3, "H": 0.3, "Q": 0.2, "C": 0.6, "Y": 0.0, "Z": 0.0, "S": 0.05,
                                     "J": 0.05, "W": 0.0, "V": 0.0, "N": 0.05, "M": 0.05, "K": 0.1, "F": 0.2}

POSITIVE = [
    (r"\bsoftware\b|\bapplication development|\bweb (site|application|portal|design)|\bmobile app", 0.5),
    (r"\bdata (analytics|analysis|science|warehouse|migration|visuali[sz]ation)|\bdashboard", 0.5),
    (r"\bconsult(ing|ant|ancy)\b|\badvisory\b|\bstrategic plan|\bstrategy\b", 0.4),
    (r"\bstudy\b|\bfeasibility|\bassessment\b|\bevaluation\b|\breview\b|\bresearch\b|\banalysis\b", 0.35),
    (r"\bgrant writing|\bproposal writing|\bwriting\b|\beditorial|\bcopywrit|\btechnical writ|\bcontent", 0.45),
    (r"\btranslation|\binterpret(ing|ation)|\btranscription|\bcaptioning|\bsubtitl", 0.5),
    (r"\bgraphic design|\bbranding\b|\blogo\b|\bvideo production|\banimation|\billustrat", 0.5),
    (r"\bmarketing|\bcommunications? (plan|strategy|campaign)|\bpublic relations|\bsocial media|\bcampaign", 0.45),
    (r"\btraining (program|development|course|curriculum)|\bcurriculum|\be-?learning|\binstructional design", 0.45),
    (r"\bgis\b|\bmapping\b|\bremote sensing|\bmodel(l)?ing\b|\bsimulation", 0.35),
    (r"\barchitectur(e|al) (design|services)|\bengineering (design|study|services|analysis)|\bdesign services", 0.35),
    (r"\bit (services|support|consult)|\bcloud|\bcybersecurity|\bsecurity assessment|\bpenetration test|\bsaas\b|\berp\b|\bcrm\b", 0.5),
    (r"\bactuar|\baudit(ing)?\b|\baccounting|\bbookkeeping|\bfinancial (analysis|advis|model)|\btax\b", 0.45),
    (r"\blegal (services|counsel|research)|\bcounsel\b|\bpolicy (development|analysis|research)|\bregulatory", 0.45),
    (r"\bsurvey (design|research)|\bmarket research|\bcommunity engagement|\bpublic (consultation|engagement)|\bfacilitat", 0.4),
    (r"\bmachine learning|\bartificial intelligence|\b(ai|ml|nlp|llm)\b|\bautomation|\bchatbot|\bdigital transformation", 0.5),
    (r"\bprogram (management|evaluation)|\bproject management|\bpmo\b|\bchange management|\bbusiness process", 0.4),
    (r"\bmaster plan|\bcomprehensive plan|\bland use plan|\bplanning (study|services)|\bhousing (study|strategy|needs)", 0.4),
    (r"\bdocument(ation)? (management|conversion|digitization)|\brecords management|\bdigitiz|\bscanning services", 0.35),
    (r"\brfp\b|\brequest for proposals?\b|\bexpression of interest|\brfq\b|\bstatement of qualifications|\bsources sought", 0.1),
]
WEAK = 0.2   # patterns below this weight get no title bonus (an "RFP" prefix says nothing about the work)
NEGATIVE = [
    (r"\bconstruction\b|\bpaving\b|\bresurfac|\basphalt|\bconcrete\b|\broof(ing)?\b|\bhvac\b|\bplumbing|\belectrical (work|contractor)|\bdemolition|\brenovation|\bremediation|\bexcavat|\bsidewalk|\bculvert|\bbridge (rehab|replacement|repair)", 0.9),
    (r"\bjanitorial|\bcustodial|\blandscap|\bsnow removal|\bgrounds (maintenance|keeping)|\btree (removal|trimming)|\bmowing|\bpest control|\bwaste (collection|hauling)|\brecycling collection", 0.9),
    (r"\bvehicle|\btruck|\bbus(es)?\b|\bfleet\b|\btractor|\bloader|\bexcavator|\bambulance|\bfire (truck|apparatus)|\bpickup", 0.8),
    (r"\bsupply (and|&) (delivery|install)|\bpurchase of|\bfurnish and deliver|\bfurnish(ing)? (and|&) deliver|\bprocurement of (equipment|goods|supplies)|\bsupplies\b|\bequipment (purchase|rental)", 0.6),
    (r"\bfood\b|\bcatering|\bmeal|\buniform|\bclothing|\bfootwear|\bfurniture|\bchemical|\bfuel\b|\bgasoline|\bdiesel|\bpropane|\bnatural gas\b|\belectricity supply|\bsalt\b|\bgravel|\baggregate|\bpipe\b|\bvalves?\b|\bpump(s)?\b", 0.7),
    (r"\bmedical (supplies|equipment)|\bpharmac|\blaboratory (supplies|equipment)|\bppe\b|\bgloves|\bmasks\b", 0.6),
    (r"\bsecurity guard|\bguard services|\bpatrol\b|\barmed\b|\bparking (lot|structure)|\btowing|\bmoving services|\bcourier|\bfreight|\bshipping", 0.7),
    (r"\bprinting\b(?! and design)|\bsignage|\bsigns\b|\bbanners\b|\bpromotional items", 0.4),
    (r"\bhardware\b(?! and software)|\bservers?\b|\blaptops?\b|\bdesktops?\b|\bprinters?\b|\btablets?\b|\bnetwork equipment|\bswitches\b|\brouters?\b|\bcabling|\bfiber (optic|installation)|\bradios?\b", 0.5),
    (r"\bsecurity system|\bcamera(s)? (install|system)|\bcctv|\baccess control (system|install)|\balarm|\bfire (alarm|suppression|sprinkler)", 0.5),
    (r"\bmaintenance (and repair|services)|\brepair(s)? (and|&) maintenance|\binspection services|\belevator|\bgenerator", 0.5),
    (r"\binstall(ation|ing|ed)?\b(?! of software)|\bpiping|\bwiring|\bretrofit|\bcommissioning", 0.7),
    (r"\bsubscription|\blicen[cs]e (renewal|purchase|fees?)|\brenewal of|\bcredits\b|\bseats?\b|\bcopies of|\bmaintenance agreement|\bsupport agreement|"
     r"\bhardware and software (maintenance|support)|\bsoftware (maintenance|support|licen[cs]e|renewal|upgrade)\b|\bwarranty\b|\bextended support|\bvendor support|"
     r"\bsole source\b.{0,40}\b(subscription|licen[cs]e|maintenance|renewal|database)|\bbrand name\b|\bpart numbers?\b|\bmodel numbers?\b|\bquantity\b", 0.7),
    (r"\bwallpaper|\bcarpet|\bflooring|\bpaint\b|\bwindows?\b|\bdoors?\b|\bfencing|\blighting fixtures", 0.8),
    (r"\b(workstation|computer|gpu|laptop|tablet|monitor|scanner|drone|sensor|instrument|analyzer|detector|simulator)s?\b(?!.{0,25}(services|design|programming|consult|science|development|integration|implementation|study|analysis))", 0.5),
    (r"\b(purchase|procure|acquisition|acquire|supply|furnish|deliver(y)?) of (a |an |the |new |replacement )?(\w+ ){0,3}(system|equipment|unit|device|software|hardware|licen[cs]e|subscription|tool|kit|vehicle|machine)s?\b", 0.7),
    (r"\bwater (treatment|main|meter)|\bwastewater|\bsewer|\bstormwater|\bdredg|\bwell drilling|\bhydrant", 0.6),
    (r"\bsheriff|\bcorrection(al|s)? (food|medical)|\binmate|\buniform", 0.4),
]


@dataclass
class Classification:
    score: float
    reason: str


def _prefix_lookup(code: str, table: dict[str, float]) -> float | None:
    code = (code or "").strip()
    for n in range(len(code), 1, -1):
        p = code[:n]
        if p in table:
            return table[p]
    return None


def classify(title: str, description: str = "", naics: list[str] | None = None,
             unspsc: list[str] | None = None, psc: str = "", category_hint: str = "") -> Classification:
    reasons: list[str] = []
    code_scores: list[float] = []
    for c in naics or []:
        s = _prefix_lookup(c, NAICS_INTELLECTUAL)
        if s is not None:
            code_scores.append(s); reasons.append(f"naics {c}->{s}")
        elif c[:2] in NAICS_PHYSICAL_PREFIXES or c[:4] in NAICS_PHYSICAL_PREFIXES:
            code_scores.append(0.0); reasons.append(f"naics {c}->physical")
    for c in unspsc or []:
        s = _prefix_lookup(c, UNSPSC_INTELLECTUAL)
        if s is not None:
            code_scores.append(s); reasons.append(f"unspsc {c}->{s}")
    if psc:
        s = PSC_INTELLECTUAL.get(psc[:1].upper())
        if s is not None and not psc[:1].isdigit():
            code_scores.append(s); reasons.append(f"psc {psc}->{s}")
        elif psc[:1].isdigit():
            code_scores.append(0.0); reasons.append(f"psc {psc}->product")

    text = f"{title}\n{category_hint}\n{description or ''}"[:6000].lower()
    title_l = (title or "").lower()
    pos = 0.0
    for pat, w in POSITIVE:
        if re.search(pat, title_l):
            pos = max(pos, w + (0.3 if w >= WEAK else 0.0)); reasons.append(f"+title:{pat.split('|')[0]}")
        elif re.search(pat, text):
            pos = max(pos, w * 0.8); reasons.append(f"+text:{pat.split('|')[0]}")   # text-only evidence never clears 0.5 alone
    neg = 0.0
    neg_title = 0.0
    for pat, w in NEGATIVE:
        if re.search(pat, title_l):
            neg = max(neg, w + 0.2); neg_title = max(neg_title, w); reasons.append(f"-title:{pat.split('|')[0]}")
        elif re.search(pat, text[:1500]):
            neg = max(neg, w * 0.6); reasons.append(f"-text:{pat.split('|')[0]}")

    kw = max(0.0, min(1.0, 0.15 + pos - neg))
    positive_codes = [c for c in code_scores if c > 0]
    physical_code = any(c == 0.0 for c in code_scores)
    if positive_codes:
        score = 0.65 * max(positive_codes) + 0.35 * kw
        if physical_code and pos == 0:          # a services PSC on a NAICS-physical buy, and nothing in the words
            score = min(score, 0.45)
    elif physical_code:
        score = min(kw, 0.35)
    else:
        score = kw
    if neg_title >= 0.7:                         # "installation", "subscription", "paving" in the TITLE wins over any code
        score = min(score, 0.4)
    return Classification(round(score, 3), "; ".join(reasons[:8]))


def is_intellectual(*args, threshold: float = 0.5, **kw) -> bool:
    return classify(*args, **kw).score >= threshold
