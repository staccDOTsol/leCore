"""Shared plumbing for API/CSV/JSON sources: a polite HTTP session, on-disk cache, date
normalisation. Scrapy spiders (spiders/) handle the HTML portals; everything that speaks
JSON or CSV goes through here because a session + a cache is all it needs."""
from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from ..config import Settings, settings as _settings
from ..models import Opportunity


class Http:
    """requests.Session with a user agent, a delay between calls, retries, and a byte cache
    keyed on URL+body so re-running a crawl during development does not re-hit a portal."""

    def __init__(self, cfg: Settings | None = None, cache: bool = True):
        import requests  # lazy: the core package stays stdlib-only

        self.cfg = cfg or _settings()
        self.s = requests.Session()
        self.s.headers["User-Agent"] = self.cfg.user_agent
        self.s.headers["Accept"] = "application/json, text/csv, text/html;q=0.9, */*;q=0.8"
        self.cache = cache
        self._last = 0.0

    def _cache_path(self, url: str, body: str | None) -> Path:
        h = hashlib.sha1((url + (body or "")).encode()).hexdigest()
        return self.cfg.cache_dir / "http" / h[:2] / h

    def _throttle(self) -> None:
        dt = time.time() - self._last
        if dt < self.cfg.request_delay:
            time.sleep(self.cfg.request_delay - dt)
        self._last = time.time()

    def get(self, url: str, params: dict | None = None, max_age: float = 6 * 3600, **kw) -> bytes:
        import requests
        full = url if not params else requests.Request("GET", url, params=params).prepare().url
        p = self._cache_path(full, None)
        if self.cache and p.exists() and time.time() - p.stat().st_mtime < max_age:
            return p.read_bytes()
        for attempt in range(4):
            self._throttle()
            try:
                r = self.s.get(full, timeout=kw.pop("timeout", 60), **kw)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise IOError(f"HTTP {r.status_code}")
                r.raise_for_status()
                break
            except (IOError, requests.RequestException) as e:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        if self.cache:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(r.content)
        return r.content

    def post_json(self, url: str, body: dict, max_age: float = 6 * 3600) -> Any:
        import requests
        b = json.dumps(body, sort_keys=True)
        p = self._cache_path(url, b)
        if self.cache and p.exists() and time.time() - p.stat().st_mtime < max_age:
            return json.loads(p.read_bytes())
        for attempt in range(4):
            self._throttle()
            try:
                r = self.s.post(url, data=b, headers={"Content-Type": "application/json"}, timeout=90)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise IOError(f"HTTP {r.status_code}")
                r.raise_for_status()
                break
            except (IOError, requests.RequestException):
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        if self.cache:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(r.content)
        return r.json()

    def get_json(self, url: str, params: dict | None = None, **kw) -> Any:
        return json.loads(self.get(url, params, **kw).decode("utf-8", "replace"))


_DATE_PATTERNS = [
    ("%Y-%m-%dT%H:%M:%S%z", None), ("%Y-%m-%dT%H:%M:%S.%f%z", None), ("%Y-%m-%dT%H:%M:%S", None),
    ("%Y-%m-%dT%H:%M:%S.%f", None), ("%Y-%m-%d %H:%M:%S", None), ("%Y-%m-%d", None), ("%Y/%m/%d", None),
    ("%m/%d/%Y %I:%M %p", None), ("%m/%d/%Y", None), ("%Y/%m/%d %I:%M:%S %p", None),
    ("%d/%m/%Y", None), ("%B %d, %Y", None), ("%b %d, %Y", None),
]


def norm_date(s: Any) -> str:
    """Best-effort -> ISO 8601 (date or datetime) string; '' when unparseable."""
    if not s:
        return ""
    if isinstance(s, (int, float)):
        try:
            return datetime.fromtimestamp(s / (1000 if s > 1e11 else 1), tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return ""
    s = str(s).strip()
    s = re.sub(r"\s+(EDT|EST|CDT|CST|MDT|MST|PDT|PST|ADT|AST|NDT|NST|UTC|GMT)\b.*$", "", s)
    s = s.replace("Z", "+0000")
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$", s):
        s = s[:-3] + s[-2:]
    for fmt, _ in _DATE_PATTERNS:
        try:
            d = datetime.strptime(s, fmt)
            return d.isoformat() if ("%H" in fmt or "%I" in fmt) else d.date().isoformat()
        except ValueError:
            continue
    m = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return ""


def parse_money(s: Any) -> float | None:
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)):
        return float(s)
    m = re.search(r"\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)?", str(s), re.I)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    unit = (m.group(2) or "").lower()
    if unit in ("k", "thousand"):
        v *= 1e3
    elif unit in ("m", "million"):
        v *= 1e6
    return v


def strip_html(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    import html
    s = html.unescape(s)
    return re.sub(r"[ \t\xa0]+", " ", re.sub(r"\n\s*\n+", "\n", s)).strip()


class Source:
    """A fetcher yields Opportunity records. `name` is the registry key, `covers` is prose
    for the coverage table, `needs` lists env vars that must be set."""
    name = "base"
    covers = ""
    needs: tuple[str, ...] = ()
    kind = "api"     # api | csv | ocds | socrata | scrapy | manual

    def __init__(self, cfg: Settings | None = None, http: Http | None = None):
        self.cfg = cfg or _settings()
        self._http = http

    @property
    def http(self) -> Http:
        if self._http is None:
            self._http = Http(self.cfg)
        return self._http

    def fetch(self, days: int = 30, limit: int | None = None, **kw) -> Iterator[Opportunity]:
        raise NotImplementedError

    def check(self) -> str | None:
        missing = [n for n in self.needs if not getattr(self.cfg, n, None)]
        return f"missing {', '.join(missing)}" if missing else None


def take(it: Iterable[Opportunity], limit: int | None) -> Iterator[Opportunity]:
    n = 0
    for o in it:
        if limit is not None and n >= limit:
            return
        n += 1
        yield o
