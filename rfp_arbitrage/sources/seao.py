"""Québec: SEAO (Système électronique d'appel d'offres) open data in OCDS format, published
weekly + monthly on Données Québec. Covers the province, its ministries, and every Québec
municipality, school service centre, health network and crown corporation that must
publish there (that is all of them above threshold). French text -- the classifier's
keyword lists are English, so UNSPSC codes and `mainProcurementCategory` carry the load;
the clause gate is language-agnostic because the LLM reads French."""
from __future__ import annotations

from typing import Iterator

from .base import Source, norm_date, take
from ..models import Opportunity, Jurisdiction, Tier

CKAN = "https://www.donneesquebec.ca/recherche/api/3/action/package_show"
PACKAGE = "systeme-electronique-dappel-doffres-seao"
PACKAGE_ID = "d23b2e02-085d-43e5-9e6e-e1d558ebfdd5"


class SeaoQuebec(Source):
    name = "seao_quebec"
    covers = "Québec provincial + all Québec municipal/para-public bodies (SEAO OCDS open data)"
    kind = "ocds"

    def resources(self) -> list[dict]:
        data = self.http.get_json(CKAN, {"id": PACKAGE_ID}, max_age=6 * 3600)
        res = (data.get("result") or {}).get("resources") or []
        return sorted([r for r in res if (r.get("format") or "").upper() == "JSON" and r.get("url")],
                      key=lambda r: r.get("name") or "", reverse=True)

    def fetch(self, days: int = 30, limit: int | None = None, **kw) -> Iterator[Opportunity]:
        def gen() -> Iterator[Opportunity]:
            weeks = max(1, days // 7 + 1)
            seen: set[str] = set()
            picked = [r for r in self.resources() if (r.get("name") or "").startswith("hebdo")][:weeks]
            for r in picked:
                pkg = self.http.get_json(r["url"], max_age=7 * 86400)
                for rel in pkg.get("releases") or []:
                    tags = rel.get("tag") or []
                    if not any(t in ("tender", "tenderUpdate", "tenderAmendment") for t in tags):
                        continue
                    o = self._convert(rel)
                    if o and o.key not in seen:
                        seen.add(o.key)
                        yield o
        return take(gen(), limit)

    def _convert(self, rel: dict) -> Opportunity | None:
        t = rel.get("tender") or {}
        if not t.get("title"):
            return None
        buyer = (rel.get("buyer") or {}).get("name") or (t.get("procuringEntity") or {}).get("name") or ""
        parties = {p.get("id"): p for p in rel.get("parties") or []}
        bp = parties.get((rel.get("buyer") or {}).get("id")) or {}
        municipal = str(((bp.get("details") or {}).get("municipal") or "0")) == "1"
        addr = bp.get("address") or {}
        items = t.get("items") or []
        unspsc = [str((i.get("classification") or {}).get("id")) for i in items
                  if (i.get("classification") or {}).get("scheme") == "UNSPSC" and (i.get("classification") or {}).get("id")]
        docs = [d.get("url") for d in t.get("documents") or [] if d.get("url")]
        value = (t.get("value") or {}).get("amount")
        period = t.get("tenderPeriod") or {}
        return Opportunity(
            source=self.name, source_id=rel.get("ocid") or t.get("id"), title=t["title"],
            url=docs[0] if docs else f"https://seao.gouv.qc.ca/avis-resultat-recherche?q={t.get('id', '')}",
            jurisdiction=Jurisdiction.CA, tier=Tier.MUNICIPAL if municipal else Tier.STATE,
            buyer=buyer, region=f"{addr.get('locality', '')}, QC".strip(", "),
            posted=norm_date(rel.get("date")), deadline=norm_date(period.get("endDate")),
            notice_type=t.get("procurementMethodDetails") or t.get("procurementMethod") or "",
            description=t.get("description") or " / ".join(i.get("description") or "" for i in items),
            unspsc=unspsc, category_hint=f"{t.get('mainProcurementCategory', '')} {' '.join(t.get('additionalProcurementCategories') or [])}",
            estimated_value=float(value) if value else None, currency="CAD", attachments=docs[1:],
            raw={"tender_id": t.get("id"), "status": t.get("status"), "tags": rel.get("tag")},
        )
