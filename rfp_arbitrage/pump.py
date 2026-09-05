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
from typing import Any, Callable

from .config import Settings, settings as _settings
from .models import Opportunity
from .store import Store

FETCHED_MARK = "rfp:fetched"      # sentinel document row: "attachments were attempted for this key"


class Pump:
    def __init__(self, db: str | Path, threshold: float = 0.6, interval: float = 30.0, batch: int = 25,
                 llm=None, max_docs: int = 6, benchmark: bool = True, out_dir: str | Path = ".",
                 report_limit: int = 40, log: Callable[[str], None] = print, cfg: Settings | None = None,
                 fetch_workers: int = 4, llm_factory: Callable[[], Any] | None = None, gate_workers: int = 4):
        self.db = str(db)
        self.gate_workers = max(1, gate_workers)
        self._gate_claimed: set[str] = set()      # keys an LLM read is in flight for (one process, many threads)
        self.llm_factory = llm_factory      # re-tried every round while the LLM is unavailable (unfunded wallet, proxy down)
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
        self._idle = {"price": 0, **{f"gate{i}": 0 for i in range(max(1, gate_workers))},
                      **{f"fetch{i}": 0 for i in range(max(1, fetch_workers))}}
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
               "key NOT IN (SELECT opportunity_key FROM verdicts WHERE method LIKE 'llm%')"
        rows = st.conn.execute(
            f"SELECT o.* FROM opportunities o LEFT JOIN pricing p ON p.opportunity_key=o.key "
            f"WHERE o.intellectual_score >= ? AND (o.deadline='' OR o.deadline >= date('now')) AND o.key IN "
            f"(SELECT DISTINCT opportunity_key FROM documents) AND {cond} "
            f"ORDER BY COALESCE(p.ask_value, 0) DESC, o.posted DESC LIMIT ?", (self.threshold, self.batch * self.gate_workers)).fetchall()
        return [Opportunity.from_row(dict(r)) for r in rows]

    def pending_price(self, st: Store) -> list[Opportunity]:
        if self.llm is None:
            return st.opportunities(
                "key IN (SELECT opportunity_key FROM verdicts WHERE viable=1) AND key NOT IN (SELECT opportunity_key FROM pricing)",
                (), limit=self.batch)
        # with an LLM: price what has an LLM verdict and no LLM-scoped pricing yet, biggest first
        rows = st.conn.execute(
            "SELECT o.* FROM opportunities o JOIN verdicts v ON v.opportunity_key=o.key AND v.viable=1 AND v.method LIKE 'llm:%' "
            "LEFT JOIN pricing p ON p.opportunity_key=o.key "
            "WHERE p.opportunity_key IS NULL OR json_extract(p.payload, '$.scope_basis') NOT LIKE 'llm%' "
            "ORDER BY COALESCE(p.ask_value, 0) DESC LIMIT ?", (self.batch,)).fetchall()
        return [Opportunity.from_row(dict(r)) for r in rows]

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

    def pending_gate_free(self, st: Store) -> list[Opportunity]:
        """Rows with no verdict at all: a free heuristic verdict now, the paid read later."""
        return st.opportunities(
            "intellectual_score >= ? AND (deadline='' OR deadline >= date('now')) AND key IN "
            "(SELECT DISTINCT opportunity_key FROM documents) AND key NOT IN (SELECT opportunity_key FROM verdicts)",
            (self.threshold,), limit=self.batch * 10)

    def step_gate(self, st: Store) -> int:
        from .clauses import analyze
        n = 0
        if self.llm is not None:
            for o in self.pending_gate_free(st):
                with self._lock:
                    if o.key in self._gate_claimed:
                        continue
                    self._gate_claimed.add(o.key)
                try:
                    st.put_verdict(analyze(o, st.full_text(o.key), None))
                    n += 1
                    with self._lock:
                        self.counts["gated"] += 1
                finally:
                    with self._lock:
                        self._gate_claimed.discard(o.key)
            if n:
                return n
        for o in self.pending_gate(st):
            with self._lock:
                if o.key in self._gate_claimed:
                    continue
                self._gate_claimed.add(o.key)
            try:
                text = st.full_text(o.key)
                ctx = None
                if self.llm is not None:
                    from .clauses import ensure_context
                    try:
                        ctx = ensure_context(st, self.llm, o.key, text)
                    except Exception as e:  # noqa: BLE001
                        self.log(f"[pump:gate] bind failed for {o.key}: {str(e)[:120]}")
                v = analyze(o, text, self.llm, context_id=ctx)
                st.put_verdict(v)
                if self.llm is not None:
                    self.log(f"[pump:gate] {v.method} {v.delegation.value}/{v.ai_use.value} conf={v.confidence:.2f} "
                             f"spent=${self.llm.spent_usd:.2f} {o.title[:60]}")
                n += 1
                with self._lock:
                    self.counts["gated"] += 1
            finally:
                with self._lock:
                    self._gate_claimed.discard(o.key)
        return n

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
            ctx = st.context(o.key, self.llm.name) if self.llm is not None else None
            if bench.get("n", 0) >= 8:
                st.put_pricing(o.key, price(o, st.full_text(o.key), self.llm, bench, self.cfg, context_id=ctx))
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
            st.put_pricing(o.key, price(o, st.full_text(o.key), self.llm, bench, self.cfg, context_id=ctx))
            with self._lock:
                self.counts["priced"] += 1
        return len(opps)

    def _retry_llm(self) -> None:
        if self.llm is not None or self.llm_factory is None:
            return
        cand = self.llm_factory()
        why = cand.available() if cand is not None else "no factory result"
        if why is None:
            self.llm = cand
            self.log(f"[pump] LLM now available: {cand.name} -- heuristic verdicts will be re-gated, biggest asks first")
        else:
            self.log(f"[pump] LLM still unavailable: {why[:160]}")

    def step_report(self, st: Store) -> int:
        self._retry_llm()
        from .match import build_matches
        from .report import match_report, gate_report, live_report
        opps = st.opportunities("key IN (SELECT opportunity_key FROM pricing)")
        verdicts = st.verdicts()
        pricing = {o.key: st.pricing(o.key) for o in opps}
        pricing = {k: v for k, v in pricing.items() if v}
        ms = build_matches(opps, verdicts, pricing, self.cfg)
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
        llm_note = ""
        if self.llm is not None:
            llm_verdicts = st.conn.execute("SELECT COUNT(*) FROM verdicts WHERE method LIKE 'llm:%'").fetchone()[0]
            llm_note = f" llm-verdicts {llm_verdicts} spent ${self.llm.spent_usd:.2f}" + (f"/${self.llm.budget_usd:.0f}" if self.llm.budget_usd else "")
        self.log(f"[pump] round {self.counts['rounds']}: opps {s['opportunities']} intellectual {s['intellectual']} "
                 f"fetched {self.counts['fetched']} docs {s['documents']} gated {s['verdicts']} viable {s['viable']} "
                 f"priced {s['priced']} matches {len(ms)}{llm_note} -> {self.out_dir / 'shortlist.md'}")
        return len(ms)

    # -- run -------------------------------------------------------------------------
    def run(self, watch: bool = False) -> dict:
        jobs = [("price", self.step_price)] + [(f"gate{i}", self.step_gate) for i in range(self.gate_workers)] + \
               [(f"fetch{i}", self.step_fetch) for i in range(self.fetch_workers)]
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
