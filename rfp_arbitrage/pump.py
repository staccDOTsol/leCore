"""STREAMING MODE. Instead of crawl -> fetch -> gate -> price -> match -> report as batch
stages, run them as concurrent workers over the shared store, each picking up whatever the
previous one has produced, cumulatively, while a crawl is still landing rows:

    fetch workers  : intellectual + open + never fetched      -> documents  (N threads, claim-based)
    gate worker    : fetched + no verdict (or heuristic-only while an LLM is up) -> verdict
    price worker   : gated + no pricing                        -> pricing (+ USAspending benchmark)
    match/report   : every `interval` seconds rebuild matches from everything gated+priced,
                     rewrite shortlist.md and gate.md, print a one-line scoreboard

SQLite is put in WAL mode so readers never block the writers; every worker owns its own
connection. `--watch` keeps the pump alive indefinitely (run the crawl in another shell as
often as you like); without it the pump exits once every queue has been empty for two
consecutive rounds."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Callable

from .config import Settings, settings as _settings
from .models import Opportunity
from .store import Store

FETCHED_MARK = "rfp:fetched"      # sentinel document row: "attachments were attempted for this key"


class Pump:
    def __init__(self, db: str | Path, threshold: float = 0.6, interval: float = 30.0, batch: int = 25,
                 llm=None, max_docs: int = 6, benchmark: bool = True, out_dir: str | Path = ".",
                 report_limit: int = 40, log: Callable[[str], None] = print, cfg: Settings | None = None,
                 fetch_workers: int = 4):
        self.db = str(db)
        self.fetch_workers = max(1, fetch_workers)
        self.threshold = threshold
        self.interval = interval
        self.batch = batch
        self.llm = llm
        self.max_docs = max_docs
        self.benchmark = benchmark
        self.out_dir = Path(out_dir)
        self.report_limit = report_limit
        self.log = log
        self.cfg = cfg or _settings()
        self.stop = threading.Event()
        self.counts = {"fetched": 0, "gated": 0, "priced": 0, "matched": 0, "rounds": 0}
        self._idle = {"gate": 0, "price": 0, **{f"fetch{i}": 0 for i in range(max(1, fetch_workers))}}
        self._lock = threading.Lock()

    # -- queues ----------------------------------------------------------------------
    def _open(self) -> Store:
        st = Store(self.db)
        return st

    def pending_fetch(self, st: Store) -> list[Opportunity]:
        return st.opportunities(
            "intellectual_score >= ? AND (deadline='' OR deadline >= date('now')) AND key NOT IN "
            "(SELECT DISTINCT opportunity_key FROM documents WHERE NOT (kind='mark' AND error='in progress' AND fetched < datetime('now', '-30 minutes')))",
            (self.threshold,), limit=self.batch * self.fetch_workers)

    def pending_gate(self, st: Store) -> list[Opportunity]:
        # a heuristic verdict is re-done once an LLM is available
        cond = "key NOT IN (SELECT opportunity_key FROM verdicts)" if self.llm is None else \
               "key NOT IN (SELECT opportunity_key FROM verdicts WHERE method LIKE 'llm:%')"
        return st.opportunities(
            f"intellectual_score >= ? AND (deadline='' OR deadline >= date('now')) AND key IN "
            f"(SELECT DISTINCT opportunity_key FROM documents) AND {cond}", (self.threshold,), limit=self.batch)

    def pending_price(self, st: Store) -> list[Opportunity]:
        return st.opportunities(
            "key IN (SELECT opportunity_key FROM verdicts WHERE viable=1) AND key NOT IN (SELECT opportunity_key FROM pricing)",
            (), limit=self.batch)

    # -- workers ---------------------------------------------------------------------
    def _loop(self, name: str, step: Callable[[Store], int]) -> None:
        st = self._open()
        try:
            while not self.stop.is_set():
                try:
                    n = step(st)
                except Exception as e:  # noqa: BLE001
                    self.log(f"[pump:{name}] error {type(e).__name__}: {e}")
                    n = 0
                with self._lock:
                    self._idle[name] = 0 if n else self._idle[name] + 1
                if n == 0:
                    self.stop.wait(min(self.interval, 10.0))
        finally:
            st.close()

    def _claim(self, st: Store, key: str) -> bool:
        """Insert the sentinel first; the worker whose insert lands owns the key."""
        with st.tx() as c:
            cur = c.execute("INSERT OR IGNORE INTO documents (opportunity_key, url, kind, chars, text, error) VALUES (?,?,?,?,?,?)",
                            (key, FETCHED_MARK, "mark", 0, "", "in progress"))
            if cur.rowcount == 1:
                return True
            # a sentinel left 'in progress' by a killed run: take it over once
            cur = c.execute("UPDATE documents SET error='claimed', fetched=CURRENT_TIMESTAMP WHERE opportunity_key=? AND url=? "
                            "AND error='in progress' AND fetched < datetime('now', '-30 minutes')", (key, FETCHED_MARK))
            return cur.rowcount == 1

    def step_fetch(self, st: Store) -> int:
        from .attachments import Fetcher
        f = Fetcher(st, self.cfg)
        n = 0
        for o in self.pending_fetch(st):
            if not self._claim(st, o.key):
                continue
            n += 1
            got = list(f.fetch(o, max_docs=self.max_docs))
            st.put_document(o.key, FETCHED_MARK, "mark", "", "" if got else "no attachments")
            with self._lock:
                self.counts["fetched"] += 1
        return n

    def step_gate(self, st: Store) -> int:
        from .clauses import analyze
        opps = self.pending_gate(st)
        for o in opps:
            v = analyze(o, st.full_text(o.key), self.llm)
            st.put_verdict(v)
            with self._lock:
                self.counts["gated"] += 1
        return len(opps)

    def step_price(self, st: Store) -> int:
        from .pricing import price
        from .awards import AwardIndex
        opps = self.pending_price(st)
        us = None
        if self.benchmark:
            from .sources.usaspending import UsaSpending
            us = UsaSpending()
        idx = AwardIndex(st)
        cache: dict[str, dict] = {}
        for o in opps:
            bench = idx.benchmark(o)
            if bench.get("n", 0) >= 8:
                st.put_pricing(o.key, price(o, st.full_text(o.key), self.llm, bench, self.cfg))
                with self._lock:
                    self.counts["priced"] += 1
                continue
            bench = None
            if us and o.jurisdiction.value == "US" and o.naics:
                k = o.naics[0]
                if k not in cache:
                    try:
                        cache[k] = us.benchmark(naics=[k])
                    except Exception as e:  # noqa: BLE001
                        cache[k] = {"n": 0, "error": str(e)[:100]}
                bench = cache[k]
            st.put_pricing(o.key, price(o, st.full_text(o.key), self.llm, bench, self.cfg))
            with self._lock:
                self.counts["priced"] += 1
        return len(opps)

    def step_report(self, st: Store) -> int:
        from .match import build_matches
        from .report import match_report, gate_report, live_report
        opps = st.opportunities("key IN (SELECT opportunity_key FROM pricing)")
        verdicts = st.verdicts()
        pricing = {o.key: st.pricing(o.key) for o in opps}
        pricing = {k: v for k, v in pricing.items() if v}
        talent = st.talent()
        ms = build_matches(opps, verdicts, pricing, talent, self.cfg)
        with st.tx() as c:
            c.execute("DELETE FROM matches")
        st.put_matches(ms)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        (self.out_dir / "shortlist.md").write_text(match_report(st, self.report_limit), encoding="utf-8")
        (self.out_dir / "gate.md").write_text(gate_report(st, 5000), encoding="utf-8")
        (self.out_dir / "live.md").write_text(live_report(st, 5000), encoding="utf-8")
        with self._lock:
            self.counts["matched"] = len(ms)
            self.counts["rounds"] += 1
        s = st.stats()
        self.log(f"[pump] round {self.counts['rounds']}: opps {s['opportunities']} intellectual {s['intellectual']} "
                 f"fetched {self.counts['fetched']} docs {s['documents']} gated {s['verdicts']} viable {s['viable']} "
                 f"priced {s['priced']} talent {s['talent']} matches {len(ms)} -> {self.out_dir / 'shortlist.md'}")
        return len(ms)

    # -- run -------------------------------------------------------------------------
    def run(self, watch: bool = False) -> dict:
        jobs = [("gate", self.step_gate), ("price", self.step_price)] + [(f"fetch{i}", self.step_fetch) for i in range(self.fetch_workers)]
        threads = [threading.Thread(target=self._loop, args=(n, f), name=n, daemon=True) for n, f in jobs]
        for t in threads:
            t.start()
        st = self._open()
        try:
            while not self.stop.is_set():
                try:
                    self.step_report(st)
                except Exception as e:  # noqa: BLE001
                    self.log(f"[pump:report] error {type(e).__name__}: {e}")
                if not watch:
                    with self._lock:
                        all_idle = all(v >= 2 for v in self._idle.values()) and self.counts["rounds"] >= 3
                    if all_idle:
                        self.log("[pump] every queue empty for two rounds; done (use --watch to keep pumping)")
                        break
                self.stop.wait(self.interval)
        except KeyboardInterrupt:
            self.log("[pump] interrupted")
        finally:
            self.stop.set()
            for t in threads:
                t.join(timeout=30)
            try:
                self.step_report(st)      # final cumulative rewrite
            finally:
                st.close()
        return dict(self.counts)
