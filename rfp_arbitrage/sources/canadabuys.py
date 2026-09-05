"""Canada: CanadaBuys open data -- every federal tender notice, plus the provinces,
municipalities, school boards, crown corporations and universities that publish through
CanadaBuys (a growing set; the buyer name tells you which). Two CSVs, refreshed daily:

  newTenderNotice   -- notices published yesterday
  openTenderNotice  -- every notice still open (~1k rows, 7 MB)

No key, no rate limit. Columns are bilingual-suffixed; we read the -eng ones."""
from __future__ import annotations

import csv
import io
from typing import Iterator

from .base import Source, norm_date, take
from ..models import Opportunity, Jurisdiction, Tier

OPEN = "https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv"
NEW = "https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv"

FEDERAL_HINTS = ("canada", "department of", "agency", "shared services", "national", "royal canadian",
                 "correctional service", "defence", "public works", "pspc", "government of canada",
                 "canadian", "parks canada", "statistics", "elections", "library and archives", "senate",
                 "house of commons", "office of the", "commission", "board of canada", "council of canada")
PROVINCE_HINTS = ("province of", "government of ontario", "government of alberta", "gouvernement du",
                  "ministry of", "ministère", "manitoba", "saskatchewan", "nova scotia", "new brunswick",
                  "newfoundland", "prince edward island", "yukon", "nunavut", "northwest territories",
                  "british columbia", "alberta", "ontario", "quebec", "québec")
MUNICIPAL_HINTS = ("city of", "town of", "ville de", "municipality", "municipalité", "county", "region of",
                   "regional municipality", "district of", "township", "school board", "school division",
                   "conseil scolaire", "university", "université", "college", "hospital", "health",
                   "transit", "library", "housing", "police", "utilities", "hydro")


PROVINCIAL_MARKERS = ("ministry of", "ministère", "province of", "government of ontario", "government of alberta",
                      "government of british columbia", "government of manitoba", "government of saskatchewan",
                      "government of nova scotia", "government of new brunswick", "government of newfoundland",
                      "government of prince edward island", "government of yukon", "government of nunavut",
                      "government of the northwest territories", "gouvernement du québec", "gouvernement du quebec")


def tier_for(buyer: str) -> Tier:
    b = (buyer or "").lower()
    if any(h in b for h in PROVINCIAL_MARKERS) and "canada" not in b:
        return Tier.STATE
    if any(h in b for h in MUNICIPAL_HINTS):
        return Tier.MUNICIPAL
    if any(h in b for h in PROVINCE_HINTS) and not any(h in b for h in ("canada", "of canada")):
        return Tier.STATE
    if any(h in b for h in FEDERAL_HINTS):
        return Tier.FEDERAL
    return Tier.OTHER


class CanadaBuys(Source):
    name = "canadabuys"
    covers = "Canada federal (all) + provinces/municipalities/MASH sector publishing via CanadaBuys"
    kind = "csv"

    def fetch(self, days: int = 30, limit: int | None = None, only_new: bool = False, **kw) -> Iterator[Opportunity]:
        def gen() -> Iterator[Opportunity]:
            url = NEW if only_new else OPEN
            raw = self.http.get(url, max_age=3600).decode("utf-8-sig", "replace")
            for r in csv.DictReader(io.StringIO(raw)):
                o = self._convert(r)
                if o:
                    yield o
        return take(gen(), limit)

    def _convert(self, r: dict) -> Opportunity | None:
        g = lambda k: (r.get(k) or "").strip()  # noqa: E731
        ref = g("referenceNumber-numeroReference")
        title = g("title-titre-eng") or g("title-titre-fra")
        if not ref or not title:
            return None
        cat = g("procurementCategory-categorieApprovisionnement")   # *SRV, *GD, *CNST, *SRVTGD
        buyer = g("contractingEntityName-nomEntitContractante-eng")
        unspsc = [c.strip() for c in g("unspsc").replace("\n", ",").split(",") if c.strip()]
        atts = [a.strip() for a in g("attachment-piecesJointes-eng").replace("\n", ",").split(",") if a.strip().startswith("http")]
        return Opportunity(
            source=self.name, source_id=ref, title=title,
            url=g("noticeURL-URLavis-eng") or f"https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/{ref.lower()}",
            jurisdiction=Jurisdiction.CA, tier=tier_for(buyer), buyer=buyer,
            region=g("regionsOfDelivery-regionsLivraison-eng") or g("contractingEntityAddressProvince-entiteContractanteAdresseProvince-eng"),
            posted=norm_date(g("publicationDate-datePublication")),
            deadline=norm_date(g("tenderClosingDate-appelOffresDateCloture")),
            notice_type=g("noticeType-avisType-eng") or g("procurementMethod-methodeApprovisionnement-eng"),
            description=g("tenderDescription-descriptionAppelOffres-eng") or g("tenderDescription-descriptionAppelOffres-fra"),
            unspsc=unspsc, category_hint=f"{cat} {g('unspscDescription-eng')} {g('gsinDescription-nibsDescription-eng')}".strip(),
            currency="CAD", attachments=atts,
            contact=f"{g('contactInfoName-informationsContactNom')} <{g('contactInfoEmail-informationsContactCourriel')}>".strip(" <>"),
            raw={"solicitationNumber": g("solicitationNumber-numeroSollicitation"), "category": cat,
                 "gsin": g("gsin-nibs"), "tradeAgreements": g("tradeAgreements-accordsCommerciaux-eng"),
                 "selectionCriteria": g("selectionCriteria-criteresSelection-eng"), "status": g("tenderStatus-appelOffresStatut-eng")},
        )
