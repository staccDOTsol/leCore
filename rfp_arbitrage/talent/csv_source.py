"""Load talent from a CSV or JSON file -- an Upwork/Contra/Toptal export, a curated roster,
or the output of the Upwork API command. Column names are matched loosely:

  name, url, title, skills (comma/semicolon separated), hourly_rate, currency, country,
  job_success (or jss), total_hours (hours), total_earnings (earned), total_jobs (jobs),
  badges (comma separated: top_rated, top_rated_plus, expert_vetted, rising_talent),
  portfolio_items, reviews_count, rating, is_team (true/agency/yes), team_size, source, id"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Iterator

from ..models import Talent, stable_id
from .scoring import normalize_skills

ALIASES = {
    "name": ("name", "full_name", "freelancer", "agency", "agency_name", "display_name"),
    "url": ("url", "profile", "profile_url", "link"),
    "title": ("title", "headline", "tagline", "role"),
    "skills": ("skills", "skill", "tags", "categories", "expertise"),
    "hourly_rate": ("hourly_rate", "rate", "hourly", "price", "rate_usd"),
    "currency": ("currency",),
    "country": ("country", "location"),
    "job_success_pct": ("job_success_pct", "job_success", "jss", "success_rate"),
    "total_hours": ("total_hours", "hours", "hours_billed", "total_hours_billed"),
    "total_earnings": ("total_earnings", "earned", "earnings", "total_earned"),
    "total_jobs": ("total_jobs", "jobs", "jobs_completed", "completed_jobs"),
    "badges": ("badges", "badge", "status", "tier"),
    "portfolio_items": ("portfolio_items", "portfolio"),
    "reviews_count": ("reviews_count", "reviews", "feedback_count"),
    "rating": ("rating", "feedback", "stars", "avg_rating"),
    "is_team": ("is_team", "team", "agency_flag", "type"),
    "team_size": ("team_size", "members", "size"),
    "source": ("source", "platform", "marketplace"),
    "source_id": ("source_id", "id", "uid", "ciphertext"),
}


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    m = re.search(r"-?\d[\d,]*(\.\d+)?", str(v))
    return float(m.group(0).replace(",", "")) if m else None


def _pick(row: dict, key: str):
    low = {re.sub(r"[^a-z0-9]+", "_", k.lower()).strip("_"): v for k, v in row.items()}
    for a in ALIASES[key]:
        if a in low and low[a] not in (None, ""):
            return low[a]
    return None


def row_to_talent(row: dict, default_source: str = "csv") -> Talent | None:
    name = _pick(row, "name")
    if not name:
        return None
    badges = _pick(row, "badges") or ""
    if isinstance(badges, str):
        badges = [b.strip().lower().replace(" ", "_").replace("-", "_") for b in re.split(r"[,;|]", badges) if b.strip()]
    team_raw = str(_pick(row, "is_team") or "").lower()
    is_team = team_raw in ("1", "true", "yes", "y", "agency", "team") or "agency" in team_raw
    src = str(_pick(row, "source") or default_source).lower()
    sid = str(_pick(row, "source_id") or stable_id(src, str(name), str(_pick(row, "url") or "")))
    rate = _num(_pick(row, "hourly_rate"))
    return Talent(
        source=src, source_id=sid, name=str(name), url=str(_pick(row, "url") or ""), is_team=is_team,
        title=str(_pick(row, "title") or ""), skills=normalize_skills(_pick(row, "skills") or []),
        hourly_rate=rate, currency=str(_pick(row, "currency") or "USD").upper(), country=str(_pick(row, "country") or ""),
        job_success_pct=_num(_pick(row, "job_success_pct")), total_hours=_num(_pick(row, "total_hours")),
        total_earnings=_num(_pick(row, "total_earnings")),
        total_jobs=int(_num(_pick(row, "total_jobs")) or 0) or None, badges=badges,
        portfolio_items=int(_num(_pick(row, "portfolio_items")) or 0), reviews_count=int(_num(_pick(row, "reviews_count")) or 0),
        rating=_num(_pick(row, "rating")), team_size=int(_num(_pick(row, "team_size")) or (1 if not is_team else 2)),
        raw={k: v for k, v in row.items() if k not in ("raw",)},
    )


def load(path: str | Path, default_source: str = "csv") -> Iterator[Talent]:
    p = Path(path)
    if p.suffix.lower() in (".json", ".jsonl"):
        text = p.read_text(encoding="utf-8")
        rows = [json.loads(l) for l in text.splitlines() if l.strip()] if p.suffix.lower() == ".jsonl" else json.loads(text)
        if isinstance(rows, dict):
            rows = rows.get("talent") or rows.get("results") or rows.get("data") or []
    else:
        with p.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
    for r in rows:
        t = row_to_talent(r, default_source)
        if t:
            yield t
