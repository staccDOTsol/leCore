"""USAspending.gov -- the price side of the ledger for US work. No key. Used by pricing.py
to answer "what do agencies actually pay for this NAICS / this description", which is how
we call an ask overpriced with evidence rather than vibes.

POST https://api.usaspending.gov/api/v2/search/spending_by_award/
Docs: https://api.usaspending.gov/docs/endpoints"""
from __future__ import annotations

import statistics
from datetime import date, timedelta
from typing import Any

from .base import Http

AWARD_SEARCH = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
CONTRACT_TYPES = ["A", "B", "C", "D"]      # BPA call, purchase order, delivery order, definitive contract


class UsaSpending:
    def __init__(self, http: Http | None = None):
        self._http = http

    @property
    def http(self) -> Http:
        if self._http is None:
            self._http = Http()
        return self._http

    def awards(self, naics: list[str] | None = None, keywords: list[str] | None = None,
               agency: str | None = None, years: int = 3, limit: int = 100, sort: str = "Start Date") -> list[dict[str, Any]]:
        """Most RECENT awards by default. Sorting by amount would make the sample the largest
        contracts in the country, and a 'median' of those is not a benchmark for anything."""
        end = date.today()
        start = end - timedelta(days=365 * years)
        filters: dict[str, Any] = {
            "time_period": [{"start_date": start.isoformat(), "end_date": end.isoformat()}],
            "award_type_codes": CONTRACT_TYPES,
        }
        if naics:
            filters["naics_codes"] = naics
        if keywords:
            filters["keywords"] = keywords
        if agency:
            filters["agencies"] = [{"type": "awarding", "tier": "toptier", "name": agency}]
        body = {"filters": filters, "limit": min(limit, 100), "page": 1, "sort": sort, "order": "desc",
                "fields": ["Award ID", "Recipient Name", "Award Amount", "Description", "Awarding Agency",
                           "Start Date", "End Date", "NAICS Code", "PSC Code"]}
        out: list[dict[str, Any]] = []
        while len(out) < limit:
            data = self.http.post_json(AWARD_SEARCH, body, max_age=7 * 86400)
            rows = data.get("results") or []
            out.extend(rows)
            if not rows or not (data.get("page_metadata") or {}).get("hasNext"):
                break
            body["page"] += 1
        return out[:limit]

    def benchmark(self, naics: list[str] | None = None, keywords: list[str] | None = None,
                  years: int = 3, lo: float = 10_000, hi: float = 10_000_000) -> dict[str, Any]:
        """Distribution of RECENT award amounts for comparable work, within a band a small prime
        could plausibly win (lo..hi): n, p25, median, p75, min, max, examples."""
        rows = self.awards(naics=naics, keywords=keywords, years=years, limit=200)
        amts = sorted(float(r.get("Award Amount") or 0) for r in rows if lo <= float(r.get("Award Amount") or 0) <= hi)
        if not amts:
            return {"n": 0}
        q = statistics.quantiles(amts, n=4) if len(amts) >= 4 else [amts[0], statistics.median(amts), amts[-1]]
        return {"n": len(amts), "p25": q[0], "median": q[1], "p75": q[2], "max": amts[-1], "min": amts[0],
                "naics": naics, "keywords": keywords, "years": years, "band": [lo, hi], "n_raw": len(rows),
                "examples": [{"id": r.get("Award ID"), "amount": r.get("Award Amount"), "recipient": r.get("Recipient Name"),
                              "desc": (r.get("Description") or "")[:120]} for r in rows[:5]]}
