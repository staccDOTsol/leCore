"""Upwork through the OFFICIAL API only. Anonymous scraping of upwork.com is blocked at the
edge (Cloudflare 403) and forbidden by their Terms of Service, so this module speaks the
GraphQL API at https://api.upwork.com/graphql with OAuth2.

Setup (once):
  1. https://www.upwork.com/developer/keys/apply  -> client id + secret. Request the
     "Talent search" / "Freelancer profile" scopes; approval is manual on Upwork's side.
  2. export UPWORK_CLIENT_ID=... UPWORK_CLIENT_SECRET=...
  3. python -m rfp_arbitrage talent upwork-auth      # prints the consent URL, exchanges the code,
                                                     # prints UPWORK_REFRESH_TOKEN for your env
  4. python -m rfp_arbitrage talent upwork-introspect  # lists the root Query fields YOUR key can see
  5. python -m rfp_arbitrage talent upwork-search --skills "python, data analysis" --max-rate 60

Upwork revises the GraphQL schema and gates fields by partner tier, so the search query lives
in SEARCH_QUERY below as data, not behind an abstraction: run upwork-introspect, then adjust the
field names to match what your key is granted. Everything downstream only needs the
normalized Talent record that `to_talent()` builds, and it tolerates missing fields."""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Iterator

from ..config import Settings, settings as _settings
from ..models import Talent
from .scoring import normalize_skills

AUTH_URL = "https://www.upwork.com/ab/account-security/oauth2/authorize"
TOKEN_URL = "https://www.upwork.com/api/v3/oauth2/token"
GRAPHQL_URL = "https://api.upwork.com/graphql"

# Validate against your tenant with `upwork-introspect`; these names follow Upwork's public
# GraphQL docs (talent search + freelancer profile) and may need adjusting per partner tier.
SEARCH_QUERY = """
query TalentSearch($filter: TalentProfileSearchFilter, $pagination: Pagination) {
  talentProfileSearch(filter: $filter, pagination: $pagination) {
    totalCount
    edges { node {
      id ciphertext name title description location { country }
      skills { name }
      hourlyRate { amount currency }
      jobSuccessScore totalHours totalEarnings totalJobs
      topRatedStatus expertVettedStatus risingTalent
      agency { id name size }
      feedback { score count }
      portfolioCount
    } }
  }
}
"""

INTROSPECT_QUERY = """{ __schema { queryType { fields { name description args { name type { name kind ofType { name } } } } } } }"""


class UpworkClient:
    def __init__(self, cfg: Settings | None = None):
        self.cfg = cfg or _settings()
        self.access_token = self.cfg.upwork_access_token
        self.refresh_token = self.cfg.upwork_refresh_token
        self.expires_at = 0.0

    # -- OAuth2 ------------------------------------------------------------------
    def consent_url(self, scopes: str = "") -> str:
        q = {"response_type": "code", "client_id": self.cfg.upwork_client_id, "redirect_uri": self.cfg.upwork_redirect_uri}
        if scopes:
            q["scope"] = scopes
        return AUTH_URL + "?" + urllib.parse.urlencode(q)

    def _token(self, body: dict[str, str]) -> dict[str, Any]:
        data = urllib.parse.urlencode(body).encode()
        req = urllib.request.Request(TOKEN_URL, data=data, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        basic = base64.b64encode(f"{self.cfg.upwork_client_id}:{self.cfg.upwork_client_secret}".encode()).decode()
        req.add_header("Authorization", "Basic " + basic)
        with urllib.request.urlopen(req, timeout=30) as r:
            tok = json.loads(r.read().decode())
        self.access_token = tok.get("access_token")
        self.refresh_token = tok.get("refresh_token") or self.refresh_token
        self.expires_at = time.time() + float(tok.get("expires_in") or 3600) - 60
        return tok

    def exchange_code(self, code: str) -> dict[str, Any]:
        return self._token({"grant_type": "authorization_code", "code": code, "redirect_uri": self.cfg.upwork_redirect_uri})

    def refresh(self) -> dict[str, Any]:
        if not self.refresh_token:
            raise RuntimeError("no UPWORK_REFRESH_TOKEN; run `talent upwork-auth` first")
        return self._token({"grant_type": "refresh_token", "refresh_token": self.refresh_token})

    def _ensure(self) -> None:
        if not self.cfg.upwork_client_id or not self.cfg.upwork_client_secret:
            raise RuntimeError("UPWORK_CLIENT_ID / UPWORK_CLIENT_SECRET not set (https://www.upwork.com/developer/keys/apply)")
        if not self.access_token or time.time() >= self.expires_at:
            self.refresh()

    # -- GraphQL -----------------------------------------------------------------
    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        self._ensure()
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(GRAPHQL_URL, data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.access_token})
        tenant = os.environ.get("UPWORK_ORG_ID")
        if tenant:
            req.add_header("X-Upwork-API-TenantId", tenant)
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode())
        if data.get("errors"):
            raise RuntimeError("Upwork GraphQL errors: " + json.dumps(data["errors"])[:800])
        return data.get("data") or {}

    def introspect(self) -> list[dict[str, Any]]:
        return (self.graphql(INTROSPECT_QUERY).get("__schema") or {}).get("queryType", {}).get("fields", [])

    def search(self, skills: list[str] | None = None, query: str = "", max_rate: float | None = None,
               countries: list[str] | None = None, include_agencies: bool = True, limit: int = 100) -> Iterator[Talent]:
        filt: dict[str, Any] = {}
        if skills:
            filt["skillExpression"] = " OR ".join(skills)
        if query:
            filt["searchExpression"] = query
        if max_rate:
            filt["hourlyRate"] = {"max": max_rate}
        if countries:
            filt["countries"] = countries
        offset, page = 0, min(50, limit)
        while offset < limit:
            data = self.graphql(SEARCH_QUERY, {"filter": filt, "pagination": {"first": page, "after": str(offset)}})
            edges = ((data.get("talentProfileSearch") or {}).get("edges")) or []
            for e in edges:
                t = to_talent(e.get("node") or {})
                if t and (include_agencies or not t.is_team):
                    yield t
            if len(edges) < page:
                break
            offset += page


def to_talent(n: dict[str, Any]) -> Talent | None:
    """Normalize one API node. Every field is optional; missing evidence just lowers the score."""
    if not n or not (n.get("name") or n.get("id")):
        return None
    rate = (n.get("hourlyRate") or {})
    badges = []
    trs = str(n.get("topRatedStatus") or "").lower()
    if "plus" in trs:
        badges.append("top_rated_plus")
    elif "top" in trs or trs in ("true", "1"):
        badges.append("top_rated")
    if n.get("expertVettedStatus") in (True, "true", "EXPERT_VETTED"):
        badges.append("expert_vetted")
    if n.get("risingTalent") in (True, "true"):
        badges.append("rising_talent")
    agency = n.get("agency") or {}
    fb = n.get("feedback") or {}
    sid = str(n.get("ciphertext") or n.get("id"))
    return Talent(
        source="upwork", source_id=sid, name=str(n.get("name") or agency.get("name") or sid),
        url=f"https://www.upwork.com/freelancers/{sid}" if not agency else f"https://www.upwork.com/agencies/{agency.get('id')}",
        is_team=bool(agency), title=str(n.get("title") or ""),
        skills=normalize_skills([s.get("name", "") for s in n.get("skills") or [] if isinstance(s, dict)]),
        hourly_rate=float(rate.get("amount")) if rate.get("amount") not in (None, "") else None,
        currency=str(rate.get("currency") or "USD"), country=str((n.get("location") or {}).get("country") or ""),
        job_success_pct=float(n["jobSuccessScore"]) if n.get("jobSuccessScore") not in (None, "") else None,
        total_hours=float(n["totalHours"]) if n.get("totalHours") not in (None, "") else None,
        total_earnings=float(n["totalEarnings"]) if n.get("totalEarnings") not in (None, "") else None,
        total_jobs=int(n["totalJobs"]) if n.get("totalJobs") not in (None, "") else None,
        badges=badges, portfolio_items=int(n.get("portfolioCount") or 0),
        reviews_count=int(fb.get("count") or 0), rating=float(fb["score"]) if fb.get("score") not in (None, "") else None,
        team_size=int(agency.get("size") or 1) if agency else 1, raw=n,
    )
