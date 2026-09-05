"""US (and some Canadian) state/county/city open-data portals on Socrata. Dozens of
governments publish their live solicitations as a dataset (LA "RAMP Open Bid Opportunities",
Delaware "Open Bids", Montgomery County MD "Solicitations", Winnipeg "Bid Opportunities"...).

Two modes:
  * curated  -- KNOWN datasets with a hand-checked column mapping (reliable)
  * discover -- Socrata Discovery API search, then a heuristic column-role mapper; only
                datasets where a title AND a deadline/close column resolve are ingested.

Rows: GET https://{domain}/resource/{id}.json?$limit=N   (SODA 2.x, no key needed for
public data; an app token raises the rate limit: SOCRATA_APP_TOKEN)."""
from __future__ import annotations

import os
import re
from typing import Any, Iterator

from .base import Source, norm_date, parse_money, strip_html, take
from ..models import Opportunity, Jurisdiction, Tier

DISCOVERY = "https://api.us.socrata.com/api/catalog/v1"


def _today() -> str:
    from datetime import date
    return date.today().isoformat()

# domain, dataset id, label, jurisdiction, tier, region, column roles
CURATED: list[dict[str, Any]] = [
    {"domain": "data.lacity.org", "id": "hf3r-utnq", "label": "City of Los Angeles RAMP open bids",
     "jurisdiction": "US", "tier": "municipal", "region": "Los Angeles, CA", "buyer": "City of Los Angeles",
     "cols": {"id": "rampid", "title": "title", "description": "category", "deadline": "closedate",
              "posted": "bidpost", "url": "url", "buyer": "department", "type": "type"}},
    {"domain": "data.delaware.gov", "id": "2hnj-zwix", "label": "State of Delaware open bids",
     "jurisdiction": "US", "tier": "state", "region": "DE", "buyer": "State of Delaware",
     "cols": {"id": "contractnumber", "title": "contracttitle", "deadline": "deadlinedate", "posted": "opendate",
              "url": "bidurl", "unspsc": "unspsc", "buyer": "agencycode"}},
    {"domain": "data.montgomerycountymd.gov", "id": "eeq6-nnwe", "label": "Montgomery County MD solicitations",
     "jurisdiction": "US", "tier": "municipal", "region": "Montgomery County, MD", "buyer": "Montgomery County, MD",
     "cols": {"id": "number", "title": "description", "deadline": "closingdate", "posted": "issuancedate",
              "buyer": "department", "type": "type", "status": "status"}},
    {"domain": "data.winnipeg.ca", "id": "rijt-92n4", "label": "City of Winnipeg bid opportunities",
     "jurisdiction": "CA", "tier": "municipal", "region": "Winnipeg, MB", "buyer": "City of Winnipeg",
     "cols": {"id": "bid_opportunity_number", "title": "title", "description": "scope", "deadline": "submission_deadline",
              "posted": "date_update", "url": "documents_url", "status": "status", "type": "transaction_type"}},
]

ROLE_PATTERNS = {
    "title": r"^(title|bid_?title|contract_?title|solicitation_?title|project_?name|name|description|procurement_?description|project_?description)$",
    "description": r"(scope|summary|details|long_?description|abstract|category|commodity)",
    "deadline": r"(clos|deadline|due|end_?date|submission|bid_?open|opening)",
    "posted": r"(post|issu|publish|advertis|release|open_?date|start|date_?update)",
    "url": r"(url|link|href|document)",
    "id": r"(^id$|number|_no$|_id$|identifier|reference|solicitation$|contract$)",
    "buyer": r"(department|agency|division|buyer|organization|entity)",
    "type": r"(type|method)",
    "status": r"(status|stage)",
    "value": r"(estimat|amount|budget|value)",
    "unspsc": r"(unspsc|nigp|naics|commodity_?code)",
}


def map_columns(fields: list[str]) -> dict[str, str]:
    roles: dict[str, str] = {}
    for role, pat in ROLE_PATTERNS.items():
        for f in fields:
            if f.startswith(":"):
                continue
            if re.search(pat, f, re.I) and f not in roles.values():
                roles[role] = f
                break
    return roles


class Socrata(Source):
    name = "socrata"
    covers = "US/CA state, county and city open-data procurement datasets (Socrata)"
    kind = "socrata"

    def _headers(self) -> dict[str, str]:
        tok = os.environ.get("SOCRATA_APP_TOKEN")
        return {"X-App-Token": tok} if tok else {}

    def datasets(self, discover: bool = False, query: str = "open bids OR solicitations OR RFP OR procurement opportunities",
                 max_datasets: int = 60) -> list[dict[str, Any]]:
        out = list(CURATED)
        if not discover:
            return out
        known = {(d["domain"], d["id"]) for d in out}
        data = self.http.get_json(DISCOVERY, {"q": query, "only": "datasets", "limit": max_datasets}, max_age=86400)
        for r in data.get("results") or []:
            res = r.get("resource") or {}
            dom = (r.get("metadata") or {}).get("domain") or ""
            if (dom, res.get("id")) in known:
                continue
            name = (res.get("name") or "").lower()
            if not re.search(r"bid|solicit|rfp|procure|tender|opportunit", name):
                continue
            if re.search(r"tabulat|award|histor|archive|closed|contract(s)?$|violation|forecast|plan", name):
                continue
            cols = map_columns(res.get("columns_field_name") or [])
            if "title" not in cols or "deadline" not in cols:
                continue
            out.append({"domain": dom, "id": res["id"], "label": f"{dom}: {res.get('name')}",
                        "jurisdiction": "CA" if dom.endswith(".ca") else "US",
                        "tier": "state" if re.search(r"^data\.(\w\w)\.gov$|state", dom) else "municipal",
                        "region": dom, "buyer": (res.get("attribution") or dom), "cols": cols, "discovered": True})
        return out

    def fetch(self, days: int = 30, limit: int | None = None, discover: bool = False, **kw) -> Iterator[Opportunity]:
        def gen() -> Iterator[Opportunity]:
            for ds in self.datasets(discover=discover):
                url = f"https://{ds['domain']}/resource/{ds['id']}.json"
                try:
                    rows = self.http.get_json(url, {"$limit": 5000}, max_age=6 * 3600, headers=self._headers())
                except Exception as e:  # one bad portal must not kill the crawl
                    print(f"[socrata] {ds['label']}: {e}")
                    continue
                for r in rows:
                    o = self._convert(ds, r)
                    if o:
                        yield o
        return take(gen(), limit)

    def _convert(self, ds: dict[str, Any], r: dict[str, Any]) -> Opportunity | None:
        c = ds["cols"]
        g = lambda role: r.get(c.get(role, ""), "") if c.get(role) else ""  # noqa: E731
        title = str(g("title") or "").strip()
        if not title:
            return None
        status = str(g("status") or "").lower()
        if status and re.search(r"award|clos|cancel|archiv|terminated|expired", status):
            return None
        deadline = norm_date(g("deadline"))
        # a solicitation without a future deadline is closed, or the dataset is an award/history
        # table that discovery mistook for a bid board -- either way it is not an opportunity
        if not deadline or deadline[:10] < _today():
            return None
        sid = str(g("id") or "") or re.sub(r"\W+", "-", title.lower())[:60]
        url = g("url")
        if isinstance(url, dict):
            url = url.get("url", "")
        return Opportunity(
            source=self.name, source_id=f"{ds['domain']}/{ds['id']}/{sid}", title=title,
            url=str(url or f"https://{ds['domain']}/d/{ds['id']}"),
            jurisdiction=Jurisdiction(ds["jurisdiction"]), tier=Tier(ds["tier"]),
            buyer=str(g("buyer") or ds.get("buyer") or ""), region=ds.get("region", ""),
            posted=norm_date(g("posted")), deadline=deadline,
            notice_type=str(g("type") or ""), description=strip_html(str(g("description") or "")),
            unspsc=[str(g("unspsc"))] if g("unspsc") else [], estimated_value=parse_money(g("value")),
            currency="CAD" if ds["jurisdiction"] == "CA" else "USD",
            raw={"dataset": ds["label"], "row": {k: v for k, v in r.items() if not k.startswith(":")}},
        )
