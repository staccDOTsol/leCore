"""Continuous ingest: re-crawl the sources on a schedule while `pump --watch` consumes what
lands. Each tick runs the API/CSV sources in-process and the Scrapy portals in a child
process (one reactor per process). `python -m rfp_arbitrage ingest --watch`."""
from __future__ import annotations

import subprocess
import sys
import time
from typing import Callable

FAST = ["canadabuys", "seao_quebec", "socrata"]      # cheap, open data, no quota
SLOW = ["merx", "bidnet"]                            # HTML portals, throttled spider
QUOTA = ["sam_gov"]                                  # 10 requests/day on a public key


def _run(sources: list[str], extra: list[str], log: Callable[[str], None]) -> None:
    cmd = [sys.executable, "-m", "rfp_arbitrage", "crawl", "--sources", ",".join(sources), *extra]
    log(f"[ingest] {' '.join(cmd[3:])}")
    r = subprocess.run(cmd, capture_output=True, text=True)
    tail = (r.stdout.strip().splitlines() or [""])[-1]
    log(f"[ingest] {','.join(sources)} rc={r.returncode} {tail[:300]}")
    if r.returncode and r.stderr:
        log("[ingest] " + r.stderr.strip().splitlines()[-1][:300])


def loop(fast_every: float = 2 * 3600, slow_every: float = 4 * 3600, sam_every: float = 24 * 3600,
         sam_days: int = 7, max_pages: int = 40, discover: bool = True, watch: bool = True,
         log: Callable[[str], None] = print) -> None:
    last = {"fast": 0.0, "slow": 0.0, "sam": 0.0}
    while True:
        now = time.time()
        if now - last["fast"] >= fast_every:
            _run(FAST, ["--days", "30"] + (["--discover"] if discover else []), log); last["fast"] = time.time()
        if now - last["slow"] >= slow_every:
            _run(SLOW, ["--max-pages", str(max_pages)], log); last["slow"] = time.time()
        if now - last["sam"] >= sam_every:
            _run(QUOTA, ["--days", str(sam_days)], log); last["sam"] = time.time()
        if not watch:
            return
        time.sleep(60)
