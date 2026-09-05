"""THE PRICE SIDE, FROM EVIDENCE: an index of what comparable work actually sold for --
awarded contracts and bid tabulations, existing and incoming -- so every opportunity gets an
ask from the DISTRIBUTION (min / p25 / median / mean / p75 / max, n) of comparable records
instead of needing a stated budget.

Feeds:
  seao_quebec  OCDS award releases (weekly + monthly files): amount, UNSPSC, title, buyer   (CA)
  socrata      curated award / contract tables (Cook County, NY State authorities, ...)    (US)
  usaspending  federal awards by NAICS, cached into the same table on first use            (US)
  canadabuys   contract history / award notices when the open-data file is present         (CA)

Comparability, in order: same UNSPSC 4-digit family or NAICS 4-digit family in the same
country; else keyword overlap on title within the same country; else the country's whole
intellectual-work pool. Amounts are normalised to USD and clipped to [5k, 50M] -- outside
that band a record is a utility bill or a shipbuilding program, not a comparable."""
from __future__ import annotations

import json
import re
import statistics
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Iterator

from .models import Opportunity
from .store import Store
from .taxonomy import classify

AMOUNT_LO, AMOUNT_HI = 5_000.0, 50_000_000.0
FX = {"USD": 1.0, "CAD": 0.73, "EUR": 1.08, "GBP": 1.27}

SCHEMA = """
CREATE TABLE IF NOT EXISTS awards (
    key TEXT PRIMARY KEY, source TEXT, jurisdiction TEXT, tier TEXT, title TEXT, buyer TEXT,
    supplier TEXT, amount REAL, currency TEXT, amount_usd REAL, date TEXT, naics TEXT, unspsc TEXT,
    category TEXT, url TEXT, intellectual REAL, raw TEXT, ingested TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS awards_jur ON awards(jurisdiction);
CREATE INDEX IF NOT EXISTS awards_unspsc ON awards(unspsc);
CREATE INDEX IF NOT EXISTS awards_naics ON awards(naics);
"""


@dataclass
class Award:
    source: str
    source_id: str
    jurisdiction: str          # US | CA
    tier: str
    title: str
    amount: float
    currency: str = "USD"
    buyer: str = ""
    supplier: str = ""
    date: str = ""
    naics: str = ""            # first / primary code
    unspsc: str = ""
    category: str = ""
    url: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.source}:{self.source_id}"

    @property
    def amount_usd(self) -> float:
        return self.amount * FX.get((self.currency or "USD").upper(), 1.0)


class AwardIndex:
    def __init__(self, store: Store):
        self.store = store
        self.conn = store.conn
        self.conn.executescript(SCHEMA)

    def upsert(self, awards: Iterable[Award]) -> int:
        n = 0
        with self.store.tx() as c:
            for a in awards:
                if not (AMOUNT_LO <= a.amount_usd <= AMOUNT_HI) or not a.title:
                    continue
                cl = classify(a.title, "", [a.naics] if a.naics else None, [a.unspsc] if a.unspsc else None, "", a.category)
                c.execute("""INSERT OR REPLACE INTO awards (key, source, jurisdiction, tier, title, buyer, supplier, amount, currency,
                             amount_usd, date, naics, unspsc, category, url, intellectual, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          (a.key, a.source, a.jurisdiction, a.tier, a.title[:500], a.buyer[:200], a.supplier[:200], a.amount, a.currency,
                           a.amount_usd, a.date, a.naics, a.unspsc, a.category[:200], a.url, cl.score, json.dumps(a.raw, default=str)[:4000]))
                n += 1
        return n

    def count(self) -> dict[str, int]:
        return {r[0]: r[1] for r in self.conn.execute("SELECT source, COUNT(*) FROM awards GROUP BY source")}

    # -- benchmark ------------------------------------------------------------------
    def comparable(self, opp: Opportunity, min_n: int = 8) -> tuple[list[float], str]:
        jur = opp.jurisdiction.value
        rows: list[float] = []
        how = ""
        codes = [(c[:4], "unspsc") for c in opp.unspsc if len(c) >= 4] + [(c[:4], "naics") for c in opp.naics if len(c) >= 4]
        for prefix, col in codes:
            rows = [r[0] for r in self.conn.execute(
                f"SELECT amount_usd FROM awards WHERE jurisdiction=? AND {col} LIKE ? AND intellectual >= 0.4", (jur, prefix + "%"))]
            if len(rows) >= min_n:
                how = f"{col}:{prefix}*"
                break
            rows = []
        if not rows:
            terms = [t for t in re.findall(r"[a-zà-ÿ]{4,}", (opp.title or "").lower()) if t not in _STOP][:8]
            if terms:
                like = " OR ".join("title LIKE ?" for _ in terms)
                hits = self.conn.execute(
                    f"SELECT title, amount_usd FROM awards WHERE jurisdiction=? AND intellectual >= 0.4 AND ({like})",
                    (jur, *[f"%{t}%" for t in terms])).fetchall()
                scored = []
                for title, amt in hits:
                    tl = (title or "").lower()
                    k = sum(1 for t in terms if t in tl)
                    if k >= max(1, min(2, len(terms) // 2)):
                        scored.append((k, amt))
                scored.sort(key=lambda x: -x[0])
                rows = [a for _, a in scored[:200]]
                if len(rows) >= min_n:
                    how = f"keywords:{'+'.join(terms[:4])}"
                else:
                    rows = []
        if not rows:
            rows = [r[0] for r in self.conn.execute(
                "SELECT amount_usd FROM awards WHERE jurisdiction=? AND intellectual >= 0.6", (jur,))]
            how = "country-pool" if len(rows) >= min_n else ""
            if not how:
                rows = []
        return rows, how

    def benchmark(self, opp: Opportunity, min_n: int = 8) -> dict[str, Any]:
        rows, how = self.comparable(opp, min_n)
        if not rows:
            return {"n": 0}
        rows = sorted(rows)
        q = statistics.quantiles(rows, n=4) if len(rows) >= 4 else [rows[0], statistics.median(rows), rows[-1]]
        return {"n": len(rows), "how": how, "min": rows[0], "p25": q[0], "median": q[1], "mean": statistics.fmean(rows),
                "p75": q[2], "max": rows[-1], "source": "awards-index"}


_STOP = set("services service pour avec dans les des sur une request proposal proposals bids contract contrat fourniture "
            "provision supply city county state ville services professionnels demande offres appel city of the and for".split())


# --- feeds ------------------------------------------------------------------------------
def seao_awards(http, months: int = 12, weeks: int = 6) -> Iterator[Award]:
    """OCDS releases carrying `awards[].value` from Données Québec (monthly files for history,
    weekly for the incoming edge)."""
    from .sources.seao import SeaoQuebec
    src = SeaoQuebec(http=http)
    res = src.resources()
    picked = [r for r in res if (r.get("name") or "").startswith("mensuel")][:months] + \
             [r for r in res if (r.get("name") or "").startswith("hebdo")][:weeks]
    seen: set[str] = set()
    for r in picked:
        try:
            pkg = http.get_json(r["url"], max_age=30 * 86400)
        except Exception as e:  # noqa: BLE001
            print(f"[awards] seao {r.get('name')}: {e}")
            continue
        for rel in pkg.get("releases") or []:
            t = rel.get("tender") or {}
            parties = {p.get("id"): p for p in rel.get("parties") or []}
            bp = parties.get((rel.get("buyer") or {}).get("id")) or {}
            municipal = str(((bp.get("details") or {}).get("municipal") or "0")) == "1"
            items = t.get("items") or []
            unspsc = next((str((i.get("classification") or {}).get("id")) for i in items
                           if (i.get("classification") or {}).get("scheme") == "UNSPSC"), "")
            for a in rel.get("awards") or []:
                v = a.get("value") or {}
                amt = v.get("amount")
                if not amt or not t.get("title"):
                    continue
                aid = f"{rel.get('ocid')}:{a.get('id')}"
                if aid in seen:
                    continue
                seen.add(aid)
                yield Award(source="seao_quebec", source_id=aid, jurisdiction="CA", tier="municipal" if municipal else "state",
                            title=t["title"], amount=float(amt), currency=str(v.get("currency") or "CAD"),
                            buyer=(rel.get("buyer") or {}).get("name") or "", supplier=", ".join(s.get("name", "") for s in a.get("suppliers") or []),
                            date=(a.get("date") or rel.get("date") or "")[:10], unspsc=unspsc,
                            category=f"{t.get('mainProcurementCategory', '')} {t.get('procurementMethodDetails', '')}".strip(),
                            url=(t.get("documents") or [{}])[0].get("url", ""), raw={"tender_id": t.get("id"), "method": t.get("procurementMethod")})


# domain, dataset, jurisdiction, tier, buyer, column roles (title, amount, date, buyer, category, code, id, url)
SOCRATA_AWARDS: list[dict[str, Any]] = [
    {"domain": "datacatalog.cookcountyil.gov", "id": "qh8j-6k63", "label": "Cook County awarded contracts", "jurisdiction": "US", "tier": "municipal",
     "buyer": "Cook County, IL", "cols": {"title": "description", "amount": "amount", "date": "start_date", "buyer": "lead_department",
                                         "category": "commodity_type", "id": "contract_number"}},
    {"domain": "data.ny.gov", "id": "ehig-g5x3", "label": "NY State authorities procurement report", "jurisdiction": "US", "tier": "state",
     "buyer": "NY State authorities", "cols": {"title": "procurement_description", "amount": "contract_amount", "date": "award_date",
                                              "buyer": "authority_name", "category": "type_of_procurement", "id": "contract_number"}},
    {"domain": "data.ny.gov", "id": "twsw-2mqa", "label": "MTA procurements", "jurisdiction": "US", "tier": "municipal",
     "buyer": "MTA", "cols": {"title": "procurement_description", "amount": "contract_amount", "date": "award_date",
                             "category": "type_of_procurement", "id": "contract_number"}},
    {"domain": "data.montgomerycountymd.gov", "id": "vmu2-pnrc", "label": "Montgomery County MD contracts", "jurisdiction": "US", "tier": "municipal",
     "buyer": "Montgomery County, MD", "cols": {"title": "description", "amount": "amount", "date": "execution", "buyer": "division",
                                               "category": "contracttype", "id": "contractnumber"}},
    {"domain": "data.lacity.org", "id": "hf3r-utnq", "label": "LA RAMP (awarded stage)", "jurisdiction": "US", "tier": "municipal",
     "buyer": "City of Los Angeles", "cols": {"title": "title", "amount": "awardamount", "date": "closedate", "buyer": "department",
                                              "category": "category", "id": "rampid"}},
]


def socrata_awards(http, limit: int = 20000) -> Iterator[Award]:
    from .sources.base import norm_date, parse_money
    for ds in SOCRATA_AWARDS:
        url = f"https://{ds['domain']}/resource/{ds['id']}.json"
        try:
            rows = http.get_json(url, {"$limit": limit, "$order": ":id DESC"}, max_age=7 * 86400)
        except Exception as e:  # noqa: BLE001
            print(f"[awards] {ds['label']}: {e}")
            continue
        c = ds["cols"]
        for i, r in enumerate(rows):
            g = lambda k: r.get(c.get(k, ""), "") if c.get(k) else ""  # noqa: E731
            amt = parse_money(g("amount"))
            title = str(g("title") or "").strip()
            if not amt or not title:
                continue
            yield Award(source=f"socrata:{ds['domain']}/{ds['id']}", source_id=str(g("id") or i), jurisdiction=ds["jurisdiction"],
                        tier=ds["tier"], title=title, amount=amt, currency="USD", buyer=str(g("buyer") or ds["buyer"]),
                        date=norm_date(g("date"))[:10], category=str(g("category") or "") if not isinstance(g("category"), dict) else str(g("category").get("description", "")),
                        url=f"https://{ds['domain']}/d/{ds['id']}")


def usaspending_awards(http, naics: list[str], years: int = 3) -> Iterator[Award]:
    from .sources.usaspending import UsaSpending
    us = UsaSpending(http)
    for code in naics:
        try:
            rows = us.awards(naics=[code], years=years, limit=300)
        except Exception as e:  # noqa: BLE001
            print(f"[awards] usaspending {code}: {e}")
            continue
        for r in rows:
            amt = float(r.get("Award Amount") or 0)
            if amt <= 0:
                continue
            yield Award(source="usaspending", source_id=str(r.get("generated_internal_id") or r.get("Award ID")), jurisdiction="US",
                        tier="federal", title=str(r.get("Description") or ""), amount=amt, buyer=str(r.get("Awarding Agency") or ""),
                        supplier=str(r.get("Recipient Name") or ""), date=str(r.get("Start Date") or "")[:10],
                        naics=str(r.get("NAICS Code") or code), url=f"https://www.usaspending.gov/award/{r.get('generated_internal_id', '')}")


def canadabuys_awards(http) -> Iterator[Award]:
    """CanadaBuys publishes award notices in the tender CSVs with status Awarded; the contract
    history file is added here when its URL is known (CANADABUYS_AWARDS_URL)."""
    import csv, io, os
    from .sources.base import norm_date, parse_money
    url = os.environ.get("CANADABUYS_AWARDS_URL")
    if not url:
        return
    raw = http.get(url, max_age=7 * 86400).decode("utf-8-sig", "replace")
    for r in csv.DictReader(io.StringIO(raw)):
        g = lambda k: (r.get(k) or "").strip()  # noqa: E731
        amt = parse_money(g("contractValue-valeurContrat") or g("contract_value") or g("amount"))
        title = g("description-eng") or g("title-titre-eng") or g("description")
        if not amt or not title:
            continue
        yield Award(source="canadabuys", source_id=g("referenceNumber-numeroReference") or g("contractNumber-numeroContrat") or title[:60],
                    jurisdiction="CA", tier="federal", title=title, amount=amt, currency="CAD",
                    buyer=g("contractingEntityName-nomEntitContractante-eng") or g("buyer"), supplier=g("vendorName-nomFournisseur") or g("supplier"),
                    date=norm_date(g("contractDate-dateContrat") or g("date"))[:10], unspsc=g("unspsc")[:8], category=g("gsinDescription-nibsDescription-eng"))


def build(store: Store, http=None, seao_months: int = 12, naics: list[str] | None = None, log=print) -> dict[str, int]:
    from .sources.base import Http
    http = http or Http()
    idx = AwardIndex(store)
    for name, gen in (("seao_quebec", lambda: seao_awards(http, months=seao_months)),
                      ("socrata", lambda: socrata_awards(http)),
                      ("canadabuys", lambda: canadabuys_awards(http))):
        try:
            n = idx.upsert(gen())
            log(f"[awards] {name}: {n} records")
        except Exception as e:  # noqa: BLE001
            log(f"[awards] {name}: FAILED {type(e).__name__}: {e}")
    if naics:
        n = idx.upsert(usaspending_awards(http, naics))
        log(f"[awards] usaspending ({len(naics)} NAICS): {n} records")
    return idx.count()


def naics_in_use(store: Store) -> list[str]:
    seen: dict[str, int] = {}
    for o in store.opportunities("intellectual_score >= 0.6 AND jurisdiction='US' AND (deadline='' OR deadline >= date('now'))"):
        for c in o.naics[:1]:
            seen[c] = seen.get(c, 0) + 1
    return [c for c, _ in sorted(seen.items(), key=lambda kv: -kv[1])]
