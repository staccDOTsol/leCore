"""One command: the paying proxy, the crawler, the conveyor, and a gist that tracks them.

    python -m rfp_arbitrage daemon

Everything the pipeline needs runs under this process and is restarted when it dies. If
GITHUB_TOKEN is set the board is published to a gist and the SAME gist is rewritten every
round, so a single link stays current.

Two details here were expensive to learn and are load-bearing:

* The openzoo proxy takes 60-90 seconds to bind and prints nothing at all for the first 45.
  Every earlier supervisor decided it was dead and killed it mid-startup, forever. So: four
  consecutive failed health checks before acting, and four minutes of silence afterwards.
* Never ask `pgrep -f openzoo` whether it is running -- the pattern matches the pgrep
  command line itself and answers yes whether or not the service exists. Here we own the
  children as Popen handles and ask them directly.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .store import Store

GIST_API = "https://api.github.com/gists"


def _log(msg: str) -> None:
    print(f"[daemon {datetime.now(timezone.utc):%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------- the published board


def _slug(s: str, n: int = 48) -> str:
    return (re.sub(r"[^a-z0-9]+", "-", (s or "bid").lower()).strip("-") or "bid")[:n]


def board_markdown(store: Store, limit: int = 60) -> str:
    """The bid board as markdown. The HTML board is for a browser; a gist wants this."""
    from .bidder import Bidder
    from .report import ready_board
    b = Bidder.load()
    rows = ready_board(store, limit)
    st = store.stats()
    ready = [r for r in rows if r["sendable"]]
    blocked = [r for r in rows if not r["sendable"]]
    value = sum(r["price"] for r in ready)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    awards = store.conn.execute("SELECT COUNT(*) FROM awards").fetchone()[0]

    out = [f"# {len(ready)} bid{'' if len(ready) == 1 else 's'} ready to send", "",
           f"*{now} — rewritten every pump round. Drafted for {b.legal_name}"
           f" ({b.short_name}), a {b.entity_type} of {b.state_of_incorporation}.*", "",
           "| | |", "|---|---|",
           f"| clean drafts, nothing left to correct | **{len(ready)}** |",
           f"| bid value sitting ready | **${value:,.0f}** |",
           f"| drafted but blocked on a registration or a flagged claim | {len(blocked)} |",
           f"| eligible matches queued behind these | {st.get('matches', 0):,} of {st.get('opportunities', 0):,} indexed |",
           ""]

    def table(rs: list[dict[str, Any]]) -> list[str]:
        t = ["| bid | buyer | closes | price | delivery | margin |", "|---|---|---|---|---|---|"]
        for r in rs:
            m = f"{r['margin']:.0%}" if r.get("margin") is not None else "—"
            d = f"${r['delivery']:,.0f}" if r.get("delivery") else "—"
            t.append(f"| [{r['title'][:78]}]({r['url']}) | {(r['buyer'] or '')[:44]} | {r['deadline'] or '—'} "
                     f"| ${r['price']:,.0f} | {d} | {m} |")
        return t + [""]

    if ready:
        out += ["## Ready to send", ""] + table(ready)
        for r in ready:
            if r["deliverables"]:
                out += [f"**{r['title'][:90]}** — {r['where']}", ""]
                out += [f"- {d}" for d in r["deliverables"]] + [""]
    if blocked:
        out += ["## Drafted, blocked", "",
                "Each of these is written; the lines below are what a human must fix before it goes out.", ""]
        out += table(blocked)
        for r in blocked:
            out += [f"**{r['title'][:90]}**", ""] + [f"- {x}" for x in r["blockers"]] + [""]
    if not rows:
        out += ["_Nothing drafted yet. The conveyor drafts as it finds; give it a few rounds._", ""]

    out += ["## The pipeline behind it", "",
            "It is a conveyor, not a set of queues: one opportunity is carried the whole way —",
            "documents, legal gate, eligibility, price, match, draft — before the next is picked up,",
            "so a bid exists minutes after the solicitation is seen rather than after every stage",
            "has run over every row.", "",
            "```",
            "crawl ─▶ classify ─▶ documents ─▶ LEGAL GATE ─▶ eligibility ─▶ price ─▶ match ─▶ DRAFT",
            "                                      │                                          │",
            "                     explicit non-denial of delegation                 re-read, and rewritten",
            "                     and of AI use, quoted verbatim                    if it claims anything",
            "                                                                       the entity cannot support",
            "```", "",
            "| stage | rows |", "|---|---|",
            f"| indexed solicitations | {st.get('opportunities', 0):,} |",
            f"| intellectual work | {st.get('intellectual', 0):,} |",
            f"| clause verdicts | {st.get('verdicts', 0):,} ({st.get('viable', 0):,} viable) |",
            f"| priced | {st.get('priced', 0):,} |",
            f"| eligible matches | {st.get('matches', 0):,} |",
            f"| comparable awards priced against | {awards:,} |",
            f"| drafted bids | {st.get('proposals', 0):,} |", "",
            "No bid has been submitted. A draft marked ready still needs a human to send it.", ""]
    return "\n".join(out)


def gist_files(store: Store, proposals: int = 8) -> dict[str, dict[str, str]]:
    """What the gist holds: the board, then the drafts themselves so the link is the work."""
    from .report import ready_board
    files: dict[str, dict[str, str]] = {"README.md": {"content": board_markdown(store)}}
    for i, r in enumerate(ready_board(store, 60)):
        if i >= proposals:
            break
        row = store.conn.execute("SELECT markdown FROM proposals WHERE opportunity_key=?", (r["key"],)).fetchone()
        md = (row["markdown"] if row else "") or ""
        if not md.strip():
            continue
        tag = "ready" if r["sendable"] else "blocked"
        # a gist file over a megabyte is rejected outright; no bid is anywhere near this long
        files[f"{i + 1:02d}-{tag}-{_slug(r['title'])}.md"] = {"content": md[:120_000]}
    return files


# ---------------------------------------------------------------- the gist itself


class Gist:
    """One gist, rewritten in place. The id is remembered in the cache dir so a restart does
    not scatter a new link every time."""

    def __init__(self, token: str | None, gist_id: str | None, cache: Path, public: bool = False):
        self.token = token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
        self.path = Path(cache) / "gist.json"
        self.public = public
        self.id = gist_id or self._remembered()
        self.url = ""
        self._last = ""
        self._published: set[str] = set()      # so a draft that drops out is removed, not left stale

    def _remembered(self) -> str:
        try:
            return json.loads(self.path.read_text()).get("id", "")
        except Exception:
            return ""

    def _remember(self, gid: str, url: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"id": gid, "url": url}, indent=2))

    def _call(self, method: str, url: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method=method, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
            "User-Agent": "rfp-arbitrage-daemon"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())

    def publish(self, files: dict[str, dict[str, str]], description: str) -> str | None:
        """Create once, then PATCH the same id forever. Returns the url when something changed."""
        if not self.token:
            return None
        digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        if digest == self._last:
            return None                       # nothing new; do not spend a write
        # IN PLACE means in place: a file we published last round and no longer have is deleted
        # (null), not left behind as a bid that has since been superseded.
        payload = dict(files)
        for gone in self._published - set(files):
            payload[gone] = None              # type: ignore[assignment]
        body = {"description": description, "files": payload}
        try:
            if self.id:
                r = self._call("PATCH", f"{GIST_API}/{self.id}", body)
            else:
                r = self._call("POST", GIST_API, body | {"public": self.public})
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:200]
            if e.code == 404 and self.id:     # remembered a gist that is gone; start a new one
                _log(f"gist {self.id} is gone, creating a fresh one")
                self.id = ""
                return self.publish(files, description)
            _log(f"gist {method_hint(e)}: {e.code} {detail}")
            return None
        except Exception as e:                # network flap: try again next round
            _log(f"gist unreachable: {str(e)[:120]}")
            return None
        self._last = digest
        self._published = set(files)
        self.id, self.url = r["id"], r["html_url"]
        self._remember(self.id, self.url)
        return self.url


def method_hint(e: urllib.error.HTTPError) -> str:
    return {401: "token rejected", 403: "token lacks the `gist` scope", 422: "rejected the payload"}.get(
        e.code, "refused")


# ---------------------------------------------------------------- supervision


class Child:
    """A pipeline stage we own. Restarted when it exits, with a floor on the restart rate so a
    stage that dies instantly does not spin."""

    def __init__(self, name: str, argv: list[str], log: Path, env: dict[str, str]):
        self.name, self.argv, self.log, self.env = name, argv, log, env
        self.proc: subprocess.Popen | None = None
        self.started = 0.0
        self.restarts = 0

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        self.log.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.log, "ab")
        fh.write(f"\n=== {datetime.now(timezone.utc).isoformat()} start ===\n".encode())
        self.proc = subprocess.Popen(self.argv, stdout=fh, stderr=subprocess.STDOUT, env=self.env)
        self.started = time.time()
        _log(f"{self.name} up (pid {self.proc.pid}) -> {self.log}")

    def ensure(self) -> None:
        if self.alive():
            return
        if self.proc is not None:
            code = self.proc.poll()
            if time.time() - self.started < 15:
                time.sleep(15)                # do not spin on an instant crash
            self.restarts += 1
            _log(f"{self.name} exited ({code}); restart #{self.restarts} — see {self.log}")
        self.start()

    def stop(self) -> None:
        if self.alive():
            self.proc.terminate()


def _proxy_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/models", timeout=10) as r:
            return r.status < 500
    except urllib.error.HTTPError:
        return True                            # answering at all is enough; it is bound
    except Exception:
        return False


def run(args) -> int:
    cfg_cache = Path(os.environ.get("RFP_CACHE") or ".rfp_cache")
    logs = cfg_cache / "logs"
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    llm_url = env.get("LECORE_LLM_URL") or "http://localhost:8402/v1"
    env["LECORE_LLM_URL"] = llm_url
    env.setdefault("LECORE_LLM_KEY", "sk-openzoo")
    env.setdefault("RFP_LLM_PROVIDER", "openzoo")
    if args.budget:
        env["RFP_LLM_BUDGET_USD"] = str(args.budget)
    if args.models:
        env["RFP_LLM_MODELS"] = args.models
        env["RFP_LLM_MODEL"] = args.models.split(",")[0].strip()

    py = [sys.executable, "-m", "rfp_arbitrage"]
    db = ["--db", args.db] if args.db else []
    children = [
        Child("pump", py + db + ["pump", "--watch", "--verbose",
                                 "--threshold", str(args.threshold), "--interval", str(args.interval),
                                 "--conveyor-workers", str(args.conveyor_workers),
                                 "--gate-workers", str(args.gate_workers),
                                 "--out-dir", args.out_dir], logs / "pump.log", env),
        Child("ingest", py + db + ["ingest", "--watch", "--fast-every", str(args.fast_every),
                                   "--slow-every", str(args.slow_every), "--sam-every", str(args.sam_every)],
              logs / "ingest.log", env),
    ]

    gist = Gist(args.gist_token, args.gist, cfg_cache, public=args.gist_public)
    if not gist.token:
        _log("no GITHUB_TOKEN in the environment — running without the gist. "
             "Create one with only the `gist` scope at https://github.com/settings/tokens?type=beta")
    elif gist.id:
        _log(f"publishing into the existing gist {gist.id}")

    stop = {"now": False}

    def bye(signum, frame):
        stop["now"] = True
    signal.signal(signal.SIGINT, bye)
    signal.signal(signal.SIGTERM, bye)

    proxy: subprocess.Popen | None = None
    misses, quiet_until, last_gist = 0, 0.0, 0.0
    _log(f"starting. db={args.db or os.environ.get('RFP_DB') or 'rfp_arbitrage.sqlite3'} out={args.out_dir}")
    try:
        while not stop["now"]:
            # 1. the paying proxy
            if not args.no_proxy and time.time() >= quiet_until:
                if _proxy_up(llm_url):
                    misses = 0
                else:
                    misses += 1
                    _log(f"proxy at {llm_url} not answering ({misses}/4)")
                    if misses >= 4:
                        _log("restarting the openzoo proxy, then leaving it alone for four minutes "
                             "— it binds slowly and prints nothing at first; that is normal")
                        if proxy and proxy.poll() is None:
                            proxy.kill()
                        logs.mkdir(parents=True, exist_ok=True)
                        fh = open(logs / "openzoo.log", "ab")
                        penv = env.copy()
                        penv.setdefault("OPENZOO_NO_TUNNEL", "1")
                        proxy = subprocess.Popen(["npx", "-y", "openzoo"], stdout=fh,
                                                 stderr=subprocess.STDOUT, env=penv)
                        misses, quiet_until = 0, time.time() + 240

            # 2. the pipeline
            for c in children:
                c.ensure()

            # 3. the link
            if gist.token and time.time() - last_gist >= args.gist_every:
                last_gist = time.time()
                url = None
                try:
                    from .config import settings
                    st = Store(args.db or settings().db_path)
                    try:
                        files = gist_files(st, args.gist_proposals)
                    finally:
                        st.close()
                    ready = sum(1 for n in files if "-ready-" in n)
                    url = gist.publish(files, f"Live bid board — {ready} ready to send — "
                                              f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}")
                except Exception as e:
                    _log(f"board build failed: {type(e).__name__}: {str(e)[:160]}")
                else:
                    if url:
                        _log(f"gist updated: {url}")

            for _ in range(int(max(1, args.tick))):
                if stop["now"]:
                    break
                time.sleep(1)
    finally:
        _log("shutting down")
        for c in children:
            c.stop()
        if proxy and proxy.poll() is None and not args.keep_proxy:
            proxy.terminate()
    return 0
