"""SQLite store. One file, five tables, no ORM. Every stage reads and writes here so the
pipeline can be resumed at any verb."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .models import Opportunity, Talent, ClauseVerdict, Match, DelegationStatus, AIStatus

SCHEMA = """
CREATE TABLE IF NOT EXISTS opportunities (
    key TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, url TEXT,
    jurisdiction TEXT, tier TEXT, buyer TEXT, region TEXT, posted TEXT, deadline TEXT,
    notice_type TEXT, description TEXT, naics TEXT, unspsc TEXT, psc TEXT, category_hint TEXT,
    set_aside TEXT, estimated_value REAL, currency TEXT, attachments TEXT, contact TEXT, raw TEXT,
    intellectual_score REAL, intellectual_reason TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS opp_source ON opportunities(source);
CREATE INDEX IF NOT EXISTS opp_deadline ON opportunities(deadline);
CREATE TABLE IF NOT EXISTS documents (
    opportunity_key TEXT, url TEXT, kind TEXT, chars INTEGER, text TEXT, error TEXT,
    fetched TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (opportunity_key, url)
);
CREATE TABLE IF NOT EXISTS verdicts (
    opportunity_key TEXT PRIMARY KEY, delegation TEXT, ai_use TEXT, viable INTEGER,
    payload TEXT, method TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pricing (
    opportunity_key TEXT PRIMARY KEY, ask_value REAL, ask_basis TEXT, hours_low REAL, hours_high REAL,
    skill_mix TEXT, benchmark TEXT, payload TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS talent (
    key TEXT PRIMARY KEY, source TEXT, source_id TEXT, name TEXT, url TEXT, is_team INTEGER, title TEXT,
    skills TEXT, hourly_rate REAL, currency TEXT, country TEXT, job_success_pct REAL, total_hours REAL,
    total_earnings REAL, total_jobs INTEGER, badges TEXT, portfolio_items INTEGER, reviews_count INTEGER,
    rating REAL, team_size INTEGER, raw TEXT, quality_score REAL, price_score REAL,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS matches (
    opportunity_key TEXT, talent_keys TEXT, payload TEXT, score REAL,
    created TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (opportunity_key, talent_keys)
);
"""


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    # -- opportunities -------------------------------------------------------------
    def upsert_opportunities(self, opps: Iterable[Opportunity]) -> int:
        n = 0
        with self.tx() as c:
            for o in opps:
                c.execute(
                    """INSERT INTO opportunities (key, source, source_id, title, url, jurisdiction, tier,
                       buyer, region, posted, deadline, notice_type, description, naics, unspsc, psc,
                       category_hint, set_aside, estimated_value, currency, attachments, contact, raw)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(key) DO UPDATE SET title=excluded.title, url=excluded.url,
                       buyer=excluded.buyer, region=excluded.region, posted=excluded.posted,
                       deadline=excluded.deadline, notice_type=excluded.notice_type,
                       description=CASE WHEN length(excluded.description) > length(opportunities.description)
                                        THEN excluded.description ELSE opportunities.description END,
                       naics=excluded.naics, unspsc=excluded.unspsc, psc=excluded.psc,
                       category_hint=excluded.category_hint, set_aside=excluded.set_aside,
                       estimated_value=COALESCE(excluded.estimated_value, opportunities.estimated_value),
                       currency=excluded.currency, attachments=excluded.attachments, contact=excluded.contact,
                       raw=excluded.raw, last_seen=CURRENT_TIMESTAMP""",
                    (o.key, o.source, o.source_id, o.title, o.url, o.jurisdiction.value, o.tier.value,
                     o.buyer, o.region, o.posted, o.deadline, o.notice_type, o.description,
                     json.dumps(o.naics), json.dumps(o.unspsc), o.psc, o.category_hint, o.set_aside,
                     o.estimated_value, o.currency, json.dumps(o.attachments), o.contact,
                     json.dumps(o.raw, default=str)))
                n += 1
        return n

    def opportunities(self, where: str = "1=1", params: tuple = (), limit: int | None = None) -> list[Opportunity]:
        q = f"SELECT * FROM opportunities WHERE {where} ORDER BY posted DESC"
        if limit:
            q += f" LIMIT {int(limit)}"
        return [Opportunity.from_row(dict(r)) for r in self.conn.execute(q, params)]

    def opportunity(self, key: str) -> Opportunity | None:
        r = self.conn.execute("SELECT * FROM opportunities WHERE key=?", (key,)).fetchone()
        return Opportunity.from_row(dict(r)) if r else None

    def set_intellectual(self, key: str, score: float, reason: str) -> None:
        with self.tx() as c:
            c.execute("UPDATE opportunities SET intellectual_score=?, intellectual_reason=? WHERE key=?",
                      (score, reason, key))

    def intellectual(self, min_score: float = 0.5) -> list[Opportunity]:
        return self.opportunities("intellectual_score >= ?", (min_score,))

    def intellectual_scores(self) -> dict[str, float]:
        return {r["key"]: r["intellectual_score"] or 0.0
                for r in self.conn.execute("SELECT key, intellectual_score FROM opportunities")}

    # -- documents -----------------------------------------------------------------
    def put_document(self, key: str, url: str, kind: str, text: str, error: str = "") -> None:
        with self.tx() as c:
            c.execute("INSERT OR REPLACE INTO documents (opportunity_key, url, kind, chars, text, error) "
                      "VALUES (?,?,?,?,?,?)", (key, url, kind, len(text), text, error))

    def documents(self, key: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM documents WHERE opportunity_key=? ORDER BY chars DESC", (key,))]

    def has_document(self, key: str, url: str) -> bool:
        return self.conn.execute("SELECT 1 FROM documents WHERE opportunity_key=? AND url=?",
                                 (key, url)).fetchone() is not None

    def full_text(self, key: str) -> str:
        o = self.opportunity(key)
        parts = [o.title, o.description] if o else []
        parts += [d["text"] for d in self.documents(key) if d["text"]]
        return "\n\n".join(p for p in parts if p)

    # -- verdicts ------------------------------------------------------------------
    def put_verdict(self, v: ClauseVerdict) -> None:
        with self.tx() as c:
            c.execute("INSERT OR REPLACE INTO verdicts (opportunity_key, delegation, ai_use, viable, payload, method) "
                      "VALUES (?,?,?,?,?,?)",
                      (v.opportunity_key, v.delegation.value, v.ai_use.value, int(v.arbitrage_viable),
                       json.dumps(v.to_dict()), v.method))

    def verdict(self, key: str) -> ClauseVerdict | None:
        r = self.conn.execute("SELECT payload FROM verdicts WHERE opportunity_key=?", (key,)).fetchone()
        if not r:
            return None
        d = json.loads(r["payload"])
        d.pop("arbitrage_viable", None)
        d["delegation"] = DelegationStatus(d["delegation"])
        d["ai_use"] = AIStatus(d["ai_use"])
        return ClauseVerdict(**d)

    def verdicts(self, viable_only: bool = False) -> dict[str, ClauseVerdict]:
        q = "SELECT opportunity_key FROM verdicts" + (" WHERE viable=1" if viable_only else "")
        out = {}
        for r in self.conn.execute(q):
            v = self.verdict(r["opportunity_key"])
            if v:
                out[v.opportunity_key] = v
        return out

    # -- pricing -------------------------------------------------------------------
    def put_pricing(self, key: str, payload: dict[str, Any]) -> None:
        with self.tx() as c:
            c.execute("INSERT OR REPLACE INTO pricing (opportunity_key, ask_value, ask_basis, hours_low, hours_high, "
                      "skill_mix, benchmark, payload) VALUES (?,?,?,?,?,?,?,?)",
                      (key, payload.get("ask_value"), payload.get("ask_basis"), payload.get("hours_low"),
                       payload.get("hours_high"), json.dumps(payload.get("skill_mix", {})),
                       json.dumps(payload.get("benchmark", {})), json.dumps(payload, default=str)))

    def pricing(self, key: str) -> dict[str, Any] | None:
        r = self.conn.execute("SELECT payload FROM pricing WHERE opportunity_key=?", (key,)).fetchone()
        return json.loads(r["payload"]) if r else None

    # -- talent --------------------------------------------------------------------
    def upsert_talent(self, people: Iterable[Talent]) -> int:
        n = 0
        with self.tx() as c:
            for t in people:
                row = t.to_row()
                row["key"] = t.key
                cols = ", ".join(row.keys())
                qs = ", ".join("?" for _ in row)
                updates = ", ".join(f"{k}=excluded.{k}" for k in row if k != "key")
                c.execute(f"INSERT INTO talent ({cols}) VALUES ({qs}) ON CONFLICT(key) DO UPDATE SET {updates}, "
                          f"last_seen=CURRENT_TIMESTAMP", tuple(row.values()))
                n += 1
        return n

    def set_talent_scores(self, key: str, quality: float, price: float) -> None:
        with self.tx() as c:
            c.execute("UPDATE talent SET quality_score=?, price_score=? WHERE key=?", (quality, price, key))

    def talent(self, where: str = "1=1", params: tuple = ()) -> list[Talent]:
        return [Talent.from_row(dict(r)) for r in self.conn.execute(f"SELECT * FROM talent WHERE {where}", params)]

    def talent_scores(self) -> dict[str, tuple[float, float]]:
        return {r["key"]: (r["quality_score"] or 0.0, r["price_score"] or 0.0)
                for r in self.conn.execute("SELECT key, quality_score, price_score FROM talent")}

    # -- matches -------------------------------------------------------------------
    def put_matches(self, matches: Iterable[Match]) -> int:
        n = 0
        with self.tx() as c:
            for m in matches:
                c.execute("INSERT OR REPLACE INTO matches (opportunity_key, talent_keys, payload, score) VALUES (?,?,?,?)",
                          (m.opportunity_key, json.dumps(m.talent_keys), json.dumps(m.to_dict()), m.score))
                n += 1
        return n

    def matches(self, limit: int = 50) -> list[Match]:
        rows = self.conn.execute("SELECT payload FROM matches ORDER BY score DESC LIMIT ?", (limit,))
        return [Match(**json.loads(r["payload"])) for r in rows]

    # -- stats ---------------------------------------------------------------------
    def stats(self) -> dict[str, Any]:
        c = self.conn
        one = lambda q, p=(): c.execute(q, p).fetchone()[0]  # noqa: E731
        by_source = {r[0]: r[1] for r in c.execute("SELECT source, COUNT(*) FROM opportunities GROUP BY source")}
        by_tier = {r[0]: r[1] for r in c.execute("SELECT jurisdiction || '/' || tier, COUNT(*) FROM opportunities GROUP BY 1")}
        return {
            "opportunities": one("SELECT COUNT(*) FROM opportunities"),
            "by_source": by_source,
            "by_jurisdiction_tier": by_tier,
            "intellectual": one("SELECT COUNT(*) FROM opportunities WHERE intellectual_score >= 0.5"),
            "documents": one("SELECT COUNT(*) FROM documents"),
            "verdicts": one("SELECT COUNT(*) FROM verdicts"),
            "viable": one("SELECT COUNT(*) FROM verdicts WHERE viable=1"),
            "priced": one("SELECT COUNT(*) FROM pricing"),
            "talent": one("SELECT COUNT(*) FROM talent"),
            "matches": one("SELECT COUNT(*) FROM matches"),
        }
