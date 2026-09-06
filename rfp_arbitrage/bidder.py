"""WHO IS BIDDING. One place for the entity that signs every proposal, so no draft has to
invent it and no draft can assert a registration we do not hold.

The real values live OUTSIDE the repository: `.rfp_bidder.json` (gitignored) or
`RFP_BIDDER_*` environment variables. A tax id, a phone number and a home address are not
repository content -- the code ships empty defaults, and anything still empty is written into
the proposal as a bracketed placeholder a human must fill before the bid is sent."""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, fields
from pathlib import Path

PROFILE_PATHS = (os.environ.get("RFP_BIDDER_FILE", ""), ".rfp_bidder.json", "~/.rfp_bidder.json")


@dataclass
class Bidder:
    legal_name: str = ""
    short_name: str = ""
    entity_type: str = ""
    state_of_incorporation: str = ""
    file_number: str = ""          # state registration / charter number
    ein: str = ""                  # US federal tax id
    incorporated: str = ""
    contact_name: str = ""
    contact_email: str = ""
    contact_phone: str = ""
    address: str = ""
    country: str = ""
    uei: str = ""                  # SAM.gov Unique Entity ID: required to be AWARDED US federal work
    set_asides: str = ""           # comma list we can actually claim: small_business,8a,sdvosb,wosb,hubzone,indigenous
    cage: str = ""
    website: str = ""

    @classmethod
    def load(cls) -> "Bidder":
        b = cls()
        for p in PROFILE_PATHS:
            if not p:
                continue
            f = Path(p).expanduser()
            if f.is_file():
                data = json.loads(f.read_text(encoding="utf-8"))
                for k, v in data.items():
                    if k in {x.name for x in fields(cls)} and v:
                        setattr(b, k, str(v))
                break
        for f_ in fields(cls):                    # env always wins
            v = os.environ.get("RFP_BIDDER_" + f_.name.upper())
            if v:
                setattr(b, f_.name, v)
        return b

    def missing(self) -> list[str]:
        """Fields a responsive bid usually needs, that we do not have."""
        need = ("legal_name", "contact_name", "contact_email", "contact_phone", "address", "uei")
        return [n for n in need if not getattr(self, n)]

    def ready_for(self, jurisdiction: str, tier: str) -> tuple[bool, str]:
        """Can this bid actually be submitted, or is it a draft pending a registration?"""
        if not self.legal_name or not self.contact_email:
            return False, "no legal name or contact email on file"
        if jurisdiction == "US" and tier == "federal" and not self.uei:
            return False, "US federal award requires a SAM.gov UEI; not registered yet"
        return True, ""

    # Set-aside categories the bidder can claim. Small-business status is SELF-CERTIFIED in
    # SAM.gov; the socio-economic ones (8(a), SDVOSB, WOSB, HUBZone, Indigenous programs) are
    # certified by a third party and cannot be claimed without it.
    def set_asides_held(self) -> set[str]:
        raw = os.environ.get("RFP_BIDDER_SET_ASIDES", self.set_asides)
        return {x.strip().lower() for x in raw.split(",") if x.strip()}

    def eligible_for(self, set_aside: str, clearance_required: bool = False) -> tuple[bool, str]:
        """Can this bidder legally compete, before anything about price or fit."""
        s = (set_aside or "").strip().lower()
        if clearance_required and self.country and self.country.upper() != "US":
            return False, "requires a clearance or US citizenship; bidder is not US-based"
        if not s or "no set aside" in s or "n/a" in s:
            return True, ""
        held = self.set_asides_held()
        if "total small business" in s or s.startswith("small business"):
            return ("small_business" in held,
                    "" if "small_business" in held else "small business set-aside; self-certify in SAM.gov to claim it")
        for tag, key in (("8(a)", "8a"), ("sdvosb", "sdvosb"), ("service-disabled", "sdvosb"),
                         ("wosb", "wosb"), ("women-owned", "wosb"), ("hubzone", "hubzone"),
                         ("indian", "indigenous"), ("indigenous", "indigenous"), ("aboriginal", "indigenous"),
                         ("veteran", "vosb")):
            if tag in s:
                return (key in held, "" if key in held else f"{set_aside.strip()[:60]}: third-party certification we do not hold")
        return True, ""

    def block(self, redact_ein: bool = True) -> str:
        ph = lambda v, name: v or f"[{name}]"  # noqa: E731
        ein = ("on file" if redact_ein else self.ein) if self.ein else "[EIN]"
        lines = [f"{ph(self.legal_name, 'LEGAL NAME')}" + (f" ({self.short_name})" if self.short_name else ""),
                 f"{ph(self.entity_type, 'ENTITY TYPE')}"
                 + (f", {self.state_of_incorporation}" if self.state_of_incorporation else "")
                 + (f", file no. {self.file_number}" if self.file_number else "")
                 + (f", incorporated {self.incorporated}" if self.incorporated else ""),
                 f"EIN: {ein}   UEI: {ph(self.uei, 'UEI PENDING SAM.GOV REGISTRATION')}"
                 + (f"   CAGE: {self.cage}" if self.cage else ""),
                 f"Contact: {ph(self.contact_name, 'CONTACT')} <{ph(self.contact_email, 'EMAIL')}>  {ph(self.contact_phone, 'PHONE')}",
                 f"Address: {ph(self.address, 'ADDRESS')}"]
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return asdict(self)
