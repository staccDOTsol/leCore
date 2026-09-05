"""Normalized records shared by every source, the store, the gate and the matcher."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


class Tier(str, Enum):
    FEDERAL = "federal"
    STATE = "state"            # US state / Canadian province or territory
    MUNICIPAL = "municipal"    # city, county, region, school board, transit agency, crown corp
    OTHER = "other"


class Jurisdiction(str, Enum):
    US = "US"
    CA = "CA"


class DelegationStatus(str, Enum):
    """What the solicitation says about the bidder handing work to others."""
    EXPLICITLY_PERMITTED = "explicitly_permitted"
    PERMITTED_WITH_CONSENT = "permitted_with_consent"   # allowed if the buyer approves the sub
    SILENT = "silent"                                   # not addressed at all -> non-denial
    RESTRICTED = "restricted"                           # e.g. self-perform >= X %, key personnel lock
    EXPLICITLY_PROHIBITED = "explicitly_prohibited"


class AIStatus(str, Enum):
    EXPLICITLY_PERMITTED = "explicitly_permitted"
    SILENT = "silent"
    RESTRICTED = "restricted"           # e.g. disclosure required, no confidential data into AI tools
    EXPLICITLY_PROHIBITED = "explicitly_prohibited"


@dataclass
class Opportunity:
    source: str                     # registry key, e.g. "sam_gov", "merx"
    source_id: str                  # id within that source
    title: str
    url: str
    jurisdiction: Jurisdiction
    tier: Tier
    buyer: str = ""
    region: str = ""                # state / province / city text
    posted: str = ""                # ISO date
    deadline: str = ""              # ISO datetime
    notice_type: str = ""           # RFP / RFQ / RFI / presolicitation / ...
    description: str = ""
    naics: list[str] = field(default_factory=list)
    unspsc: list[str] = field(default_factory=list)
    psc: str = ""                   # US product/service code
    category_hint: str = ""         # source's own category text
    set_aside: str = ""
    estimated_value: float | None = None
    currency: str = "USD"
    attachments: list[str] = field(default_factory=list)   # URLs
    contact: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.source}:{self.source_id}"

    def to_json(self) -> str:
        d = asdict(self)
        d["jurisdiction"] = self.jurisdiction.value
        d["tier"] = self.tier.value
        return json.dumps(d, ensure_ascii=False, default=str)

    @staticmethod
    def from_row(d: dict[str, Any]) -> "Opportunity":
        d = dict(d)
        d["jurisdiction"] = Jurisdiction(d["jurisdiction"])
        d["tier"] = Tier(d["tier"])
        for k in ("naics", "unspsc", "attachments"):
            if isinstance(d.get(k), str):
                d[k] = json.loads(d[k]) if d[k] else []
        if isinstance(d.get("raw"), str):
            d["raw"] = json.loads(d["raw"]) if d["raw"] else {}
        return Opportunity(**{k: v for k, v in d.items() if k in Opportunity.__dataclass_fields__})


@dataclass
class ClauseVerdict:
    """The legal gate. `arbitrage_viable` is True only when NEITHER delegation NOR AI use is
    explicitly prohibited -- the "explicit non-denial" the user asked for. Everything else is
    evidence so a human can check the model's reading before bidding."""
    opportunity_key: str
    delegation: DelegationStatus
    ai_use: AIStatus
    delegation_evidence: list[str] = field(default_factory=list)
    ai_evidence: list[str] = field(default_factory=list)
    self_perform_min_pct: float | None = None
    key_personnel_lock: bool = False
    consent_required: bool = False
    data_residency_constraints: list[str] = field(default_factory=list)
    clearance_or_citizenship_required: bool = False
    other_blockers: list[str] = field(default_factory=list)
    confidence: float = 0.0
    rationale: str = ""
    method: str = "heuristic"        # "llm:<model>" or "heuristic"
    text_chars: int = 0              # how much text the verdict was based on

    @property
    def arbitrage_viable(self) -> bool:
        return (self.delegation != DelegationStatus.EXPLICITLY_PROHIBITED
                and self.ai_use != AIStatus.EXPLICITLY_PROHIBITED)

    @property
    def explicit_non_denial(self) -> bool:
        """Alias with the user's wording."""
        return self.arbitrage_viable

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["delegation"] = self.delegation.value
        d["ai_use"] = self.ai_use.value
        d["arbitrage_viable"] = self.arbitrage_viable
        return d


@dataclass
class Match:
    opportunity_key: str
    talent_keys: list[str]           # delivery plan: ["openzoo"]
    ask_value: float                 # what the buyer will pay (stated or benchmarked), USD
    ask_basis: str                   # "stated" | "benchmark:<naics>" | "estimate"
    labor_cost: float                # estimated cost of delivering through openzoo (+ review), USD
    hours_estimate: float
    margin: float                    # (ask - labor - overhead) / ask
    fit_score: float                 # 0-1 skill overlap
    quality_score: float             # 0-1 "provably good"
    price_score: float               # 0-1 how far below market the labor is
    gate_ok: bool
    score: float
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def stable_id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]
