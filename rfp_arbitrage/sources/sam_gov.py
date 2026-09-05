"""US federal: SAM.gov Contract Opportunities API v2 (needs a free api.data.gov key).

Endpoint: GET https://api.sam.gov/opportunities/v2/search
Docs:     https://open.gsa.gov/api/get-opportunities-public-api/
Notes:    postedFrom/postedTo are MM/dd/yyyy and the window must be <= 1 year; `ptype`
          selects notice types (o=solicitation, p=presolicitation, k=combined synopsis/
          solicitation, r=sources sought, s=special notice); the description field is a
          URL to a second endpoint (noticedesc) that returns the HTML body; resourceLinks
          are attachment download URLs (they 303 to S3 and need the api_key too).
Rate:     non-federal keys get 10 requests/day on the description endpoint at the lowest
          tier -- so descriptions are fetched lazily for the intellectual subset only."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterator

from .base import Source, norm_date, strip_html, take
from ..models import Opportunity, Jurisdiction, Tier

SEARCH = "https://api.sam.gov/opportunities/v2/search"
INTELLECTUAL_PTYPES = "o,k,p,r"     # solicitations, combined, presolicitation, sources sought


class SamGov(Source):
    name = "sam_gov"
    covers = "US federal -- every agency's contract opportunities (SAM.gov)"
    needs = ("sam_api_key",)
    kind = "api"

    def fetch(self, days: int = 30, limit: int | None = None, naics: list[str] | None = None,
              keywords: str | None = None, ptype: str = INTELLECTUAL_PTYPES, **kw) -> Iterator[Opportunity]:
        def gen() -> Iterator[Opportunity]:
            to = date.today()
            frm = to - timedelta(days=min(days, 364))
            offset = 0
            page = 1000
            while True:
                params = {"api_key": self.cfg.sam_api_key, "postedFrom": frm.strftime("%m/%d/%Y"),
                          "postedTo": to.strftime("%m/%d/%Y"), "limit": page, "offset": offset,
                          "ptype": ptype, "active": "true"}
                if naics:
                    params["ncode"] = ",".join(naics)
                if keywords:
                    params["title"] = keywords
                data = self.http.get_json(SEARCH, params, max_age=3600)
                rows = data.get("opportunitiesData") or []
                for r in rows:
                    yield self._convert(r)
                offset += len(rows)
                if not rows or offset >= int(data.get("totalRecords") or 0):
                    return
        return take(gen(), limit)

    def _convert(self, r: dict) -> Opportunity:
        pop = r.get("placeOfPerformance") or {}
        state = ((pop.get("state") or {}).get("code") or (r.get("officeAddress") or {}).get("state") or "")
        contact = ", ".join(f"{c.get('fullName', '')} <{c.get('email', '')}>" for c in (r.get("pointOfContact") or []) if c.get("email"))
        atts = list(r.get("resourceLinks") or [])
        desc_url = r.get("description") or ""
        return Opportunity(
            source=self.name, source_id=r["noticeId"], title=r.get("title") or "",
            url=r.get("uiLink") or f"https://sam.gov/opp/{r['noticeId']}/view",
            jurisdiction=Jurisdiction.US, tier=Tier.FEDERAL,
            buyer=(r.get("fullParentPathName") or "").replace(".", " > "), region=state,
            posted=norm_date(r.get("postedDate")), deadline=norm_date(r.get("responseDeadLine")),
            notice_type=r.get("type") or r.get("baseType") or "",
            description="",     # filled by describe() -- see rate note in the module docstring
            naics=[c for c in (r.get("naicsCodes") or [r.get("naicsCode")]) if c],
            psc=r.get("classificationCode") or "", set_aside=r.get("typeOfSetAsideDescription") or "",
            attachments=atts, contact=contact,
            raw={"solicitationNumber": r.get("solicitationNumber"), "description_url": desc_url,
                 "organizationType": r.get("organizationType"), "archiveDate": r.get("archiveDate")},
        )

    def describe(self, opp: Opportunity) -> str:
        """Fetch the notice body (HTML) via the noticedesc endpoint. Lazy on purpose."""
        url = (opp.raw or {}).get("description_url")
        if not url:
            return ""
        data = self.http.get_json(url, {"api_key": self.cfg.sam_api_key}, max_age=7 * 86400)
        return strip_html(data.get("description") or "")

    def attachment_url(self, url: str) -> str:
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}api_key={self.cfg.sam_api_key}"
