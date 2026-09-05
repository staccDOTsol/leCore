"""python -m rfp_arbitrage <verb> [...]  -- see the package docstring for the pipeline."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .config import settings
from .models import Opportunity
from .store import Store


def _store(args) -> Store:
    cfg = settings()
    return Store(args.db or cfg.db_path)


def _llm(args):
    from .llm import LLM
    if getattr(args, "no_llm", False):
        return None
    llm = LLM(provider=getattr(args, "provider", None), model=getattr(args, "model", None))
    why = llm.available()
    if why:
        print(f"[llm] not available: {why} -- falling back to heuristics (results are NOT bid-grade)", file=sys.stderr)
        return None
    print(f"[llm] using {llm.name}", file=sys.stderr)
    return llm


def _classify_all(store: Store, only_new: bool = True) -> int:
    from .taxonomy import classify
    n = 0
    where = "intellectual_score IS NULL" if only_new else "1=1"
    for o in store.opportunities(where):
        c = classify(o.title, o.description, o.naics, o.unspsc, o.psc, o.category_hint)
        store.set_intellectual(o.key, c.score, c.reason)
        n += 1
    return n


# --- verbs ---------------------------------------------------------------------------------
def cmd_sources(args) -> int:
    from .sources import sources
    from .sources.registry import coverage_table
    print("IMPLEMENTED SOURCES")
    for name, cls in sources().items():
        inst = cls()
        why = inst.check()
        print(f"  {name:12s} [{cls.kind:7s}] {cls.covers}" + (f"  -- needs {why}" if why else ""))
    print("\nCOVERAGE MAP (jurisdiction -> which fetcher reaches it)")
    for r in coverage_table():
        cov = ", ".join(r["covered_by"]) or "-- not yet --"
        extra = f" (~{r['tenants']} public bodies)" if r.get("tenants") else ""
        print(f"  {r['jurisdiction']:5s} {r['tier']:9s} {r['code']:14s} {cov:28s} {r['portal'][:80]}{extra}")
    return 0


def cmd_crawl(args) -> int:
    from .sources import sources, DEFAULT_ORDER
    store = _store(args)
    names = args.sources.split(",") if args.sources else DEFAULT_ORDER
    reg = sources()
    total = 0
    scrapy_sites = [n for n in names if n in reg and reg[n].kind == "scrapy"]
    if len(scrapy_sites) > 1:      # one reactor per process: crawl every HTML portal in one batch
        from .sources.mets import run_spiders
        try:
            run_spiders(scrapy_sites, args.keywords or "", args.max_pages, not args.no_details)
        except Exception as e:  # noqa: BLE001
            print(f"[crawl] scrapy batch FAILED {type(e).__name__}: {e}", file=sys.stderr)
    for name in names:
        if name not in reg:
            print(f"[crawl] unknown source {name}; known: {list(reg)}", file=sys.stderr)
            continue
        src = reg[name]()
        why = src.check()
        if why:
            print(f"[crawl] {name}: skipped ({why})", file=sys.stderr)
            continue
        kw: dict[str, Any] = {"days": args.days, "limit": args.limit}
        if args.keywords:
            kw["keywords"] = args.keywords
        if name == "socrata":
            kw["discover"] = args.discover
        if name in ("merx", "bidnet"):
            kw["max_pages"] = args.max_pages
            kw["details"] = not args.no_details
        try:
            batch = list(src.fetch(**kw))
        except Exception as e:  # noqa: BLE001
            print(f"[crawl] {name}: FAILED {type(e).__name__}: {e}", file=sys.stderr)
            continue
        n = store.upsert_opportunities(batch)
        total += n
        print(f"[crawl] {name}: {n} opportunities")
    c = _classify_all(store)
    print(f"[crawl] total {total}; classified {c}; store: {json.dumps(store.stats())}")
    return 0


def cmd_classify(args) -> int:
    store = _store(args)
    n = _classify_all(store, only_new=not args.all)
    print(f"classified {n}; intellectual (>= {args.threshold}): {len(store.intellectual(args.threshold))}")
    if args.show:
        for o in store.intellectual(args.threshold)[: args.show]:
            print(f"  {o.jurisdiction.value}/{o.tier.value:9s} {o.deadline[:10]:10s} {o.title[:80]}  <{o.buyer[:40]}>")
    return 0


def _select(store: Store, args) -> list[Opportunity]:
    where, params = "intellectual_score >= ?", [args.threshold]
    if getattr(args, "keys", None):
        keys = args.keys.split(",")
        where += " AND key IN (%s)" % ",".join("?" * len(keys))
        params += keys
    if getattr(args, "source", None):
        where += " AND source=?"; params.append(args.source)
    if getattr(args, "open_only", True):
        where += " AND (deadline='' OR deadline >= date('now'))"
    return store.opportunities(where, tuple(params), limit=getattr(args, "limit", None))


def cmd_fetch(args) -> int:
    from .attachments import Fetcher
    store = _store(args)
    f = Fetcher(store)
    opps = _select(store, args)
    print(f"[fetch] {len(opps)} intellectual opportunities")
    for i, o in enumerate(opps, 1):
        got = list(f.fetch(o, max_docs=args.max_docs, refresh=args.refresh))
        chars = sum(g["chars"] for g in got)
        errs = sum(1 for g in got if g["kind"] == "error")
        if got:
            print(f"  [{i}/{len(opps)}] {o.key}: {len(got)} docs, {chars:,} chars, {errs} errors")
    return 0


def cmd_gate(args) -> int:
    from .clauses import analyze
    store = _store(args)
    llm = _llm(args)
    opps = _select(store, args)
    done = store.verdicts()
    n = 0
    for o in opps:
        if not args.refresh and o.key in done and (done[o.key].method.startswith("llm") or llm is None):
            continue
        text = store.full_text(o.key)
        v = analyze(o, text, llm)
        store.put_verdict(v)
        n += 1
        flag = "VIABLE " if v.arbitrage_viable else "BLOCKED"
        print(f"  {flag} {v.delegation.value:22s} {v.ai_use.value:20s} conf={v.confidence:.2f} {v.method:22s} {o.title[:60]}")
    st = store.stats()
    print(f"[gate] {n} analyzed; viable {st['viable']}/{st['verdicts']}" + (f"; llm calls {llm.calls}, tokens {llm.usage}" if llm else ""))
    return 0


def cmd_price(args) -> int:
    from .pricing import price
    store = _store(args)
    llm = _llm(args)
    bench_cache: dict[str, dict] = {}
    us = None
    if not args.no_benchmark:
        try:
            from .sources.usaspending import UsaSpending
            us = UsaSpending()
        except Exception as e:  # noqa: BLE001
            print(f"[price] benchmarks off: {e}", file=sys.stderr)
    opps = _select(store, args)
    if args.viable_only:
        viable = store.verdicts(viable_only=True)
        opps = [o for o in opps if o.key in viable]
    n = 0
    for o in opps:
        if not args.refresh and store.pricing(o.key):
            continue
        bench = None
        if us and o.jurisdiction.value == "US" and o.naics:
            k = o.naics[0]
            if k not in bench_cache:
                try:
                    bench_cache[k] = us.benchmark(naics=[k])
                except Exception as e:  # noqa: BLE001
                    bench_cache[k] = {"n": 0, "error": str(e)[:100]}
            bench = bench_cache[k]
        p = price(o, store.full_text(o.key), llm, bench)
        store.put_pricing(o.key, p)
        n += 1
        ask = f"{p['ask_value']:>10,.0f}" if p["ask_value"] else "       n/a"
        print(f"  ask={ask} {p['ask_basis']:28s} hours={p['hours_low']:.0f}-{p['hours_high']:.0f} "
              f"market={p['market_labor_cost']:,.0f} x={p['overpriced_ratio']} {o.title[:50]}")
    print(f"[price] {n} priced")
    return 0


def cmd_talent(args) -> int:
    from .talent.scoring import score_quality, score_price
    store = _store(args)
    if args.talent_cmd == "import":
        from .talent.csv_source import load
        people = list(load(args.path, args.source_name))
        n = store.upsert_talent(people)
        print(f"[talent] imported {n} from {args.path}")
    elif args.talent_cmd == "upwork-auth":
        from .talent.upwork import UpworkClient
        c = UpworkClient()
        print("1. Open this URL, approve, and paste the `code` query parameter from the redirect:\n   " + c.consent_url(args.scopes))
        code = input("code: ").strip()
        tok = c.exchange_code(code)
        print("export UPWORK_REFRESH_TOKEN=" + str(tok.get("refresh_token")))
        print("export UPWORK_ACCESS_TOKEN=" + str(tok.get("access_token")))
    elif args.talent_cmd == "upwork-introspect":
        from .talent.upwork import UpworkClient
        for f in UpworkClient().introspect():
            print(f"  {f['name']}  {(f.get('description') or '')[:80]}")
    elif args.talent_cmd == "upwork-search":
        from .talent.upwork import UpworkClient
        c = UpworkClient()
        skills = [s.strip() for s in (args.skills or "").split(",") if s.strip()]
        people = list(c.search(skills=skills, query=args.query, max_rate=args.max_rate, limit=args.limit))
        n = store.upsert_talent(people)
        print(f"[talent] upwork: {n} profiles")
    elif args.talent_cmd == "score":
        pass
    # (re)score everything
    m = 0
    for t in store.talent():
        q, qn = score_quality(t)
        p, pn = score_price(t)
        store.set_talent_scores(t.key, q, p)
        m += 1
        if args.show:
            print(f"  q={q:.2f} p={p:.2f} {'[team] ' if t.is_team else ''}{t.name[:30]:30s} ${t.hourly_rate or 0:>5.0f}/h  {'; '.join(qn)} | {pn}")
    print(f"[talent] scored {m}; provably good (q>=0.5): {sum(1 for k, (q, p) in store.talent_scores().items() if q >= 0.5)}")
    return 0


def cmd_match(args) -> int:
    from .match import build_matches
    store = _store(args)
    opps = _select(store, args)
    verdicts = store.verdicts()
    pricing = {o.key: store.pricing(o.key) for o in opps}
    pricing = {k: v for k, v in pricing.items() if v}
    talent = store.talent()
    ms = build_matches(opps, verdicts, pricing, talent, top_k=args.top_k, require_viable=not args.include_blocked)
    store.conn.execute("DELETE FROM matches")
    store.conn.commit()
    n = store.put_matches(ms)
    print(f"[match] {n} matches over {len(opps)} opportunities, {len(pricing)} priced, {len(verdicts)} gated, {len(talent)} talent")
    for m in ms[: args.show]:
        o = store.opportunity(m.opportunity_key)
        print(f"  {m.score:.3f} margin={m.margin:.0%} ask=${m.ask_value:,.0f} labor=${m.labor_cost:,.0f} fit={m.fit_score:.2f} q={m.quality_score:.2f} "
              f"{o.title[:50] if o else m.opportunity_key} <- {', '.join(m.talent_keys)}")
    return 0


def cmd_report(args) -> int:
    from .report import match_report, gate_report
    store = _store(args)
    text = gate_report(store) if args.kind == "gate" else match_report(store, args.limit)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


def cmd_pump(args) -> int:
    """fetch + gate + price + match/report as concurrent workers, cumulative, while a crawl lands rows."""
    from .pump import Pump
    cfg = settings()
    llm = _llm(args)
    if args.talent:
        from .talent.csv_source import load
        st = Store(args.db or cfg.db_path)
        st.upsert_talent(list(load(args.talent)))
        from .talent.scoring import score_quality, score_price
        for t in st.talent():
            st.set_talent_scores(t.key, score_quality(t)[0], score_price(t)[0])
        st.close()
    pump = Pump(args.db or cfg.db_path, threshold=args.threshold, interval=args.interval, batch=args.batch, llm=llm,
                max_docs=args.max_docs, benchmark=not args.no_benchmark, out_dir=args.out_dir, report_limit=args.limit, cfg=cfg,
                fetch_workers=args.fetch_workers)
    counts = pump.run(watch=args.watch)
    print(f"[pump] finished: {json.dumps(counts)}")
    return 0


def cmd_stats(args) -> int:
    print(json.dumps(_store(args).stats(), indent=2))
    return 0


def cmd_run(args) -> int:
    """crawl -> classify -> fetch -> gate -> price -> (talent score) -> match -> report"""
    for fn in (cmd_crawl, cmd_fetch, cmd_gate, cmd_price):
        rc = fn(args)
        if rc:
            return rc
    args.talent_cmd = "score"; args.show = False
    cmd_talent(args)
    cmd_match(args)
    args.kind = "matches"
    return cmd_report(args)


# --- parser ---------------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="rfp_arbitrage", description=__doc__)
    p.add_argument("--db", help="SQLite path (default $RFP_DB or ./rfp_arbitrage.sqlite3)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common_select(sp):
        sp.add_argument("--threshold", type=float, default=0.5, help="min intellectual score")
        sp.add_argument("--keys", help="comma-separated opportunity keys")
        sp.add_argument("--source", help="only this source")
        sp.add_argument("--limit", type=int)
        sp.add_argument("--include-closed", dest="open_only", action="store_false")

    def llm_opts(sp):
        sp.add_argument("--no-llm", action="store_true", help="heuristics only")
        sp.add_argument("--provider", choices=["openzoo", "anthropic"], help="default $RFP_LLM_PROVIDER or openzoo")
        sp.add_argument("--model")

    s = sub.add_parser("sources", help="list fetchers and the jurisdiction coverage map"); s.set_defaults(fn=cmd_sources)

    s = sub.add_parser("crawl", help="fetch opportunities into the store"); s.set_defaults(fn=cmd_crawl)
    s.add_argument("--sources", help="comma-separated (default: all implemented)")
    s.add_argument("--days", type=int, default=30); s.add_argument("--limit", type=int)
    s.add_argument("--keywords", help="portal keyword filter (merx/bidnet/sam title search)")
    s.add_argument("--discover", action="store_true", help="socrata: discover datasets beyond the curated list")
    s.add_argument("--max-pages", type=int, default=20, help="merx/bidnet listing pages")
    s.add_argument("--no-details", action="store_true", help="merx/bidnet: listing only, no detail pages")

    s = sub.add_parser("classify", help="(re)score intellectual-work likelihood"); s.set_defaults(fn=cmd_classify)
    s.add_argument("--all", action="store_true"); s.add_argument("--threshold", type=float, default=0.5); s.add_argument("--show", type=int, default=0)

    s = sub.add_parser("fetch", help="download + extract solicitation documents"); s.set_defaults(fn=cmd_fetch)
    common_select(s); s.add_argument("--max-docs", type=int, default=12); s.add_argument("--refresh", action="store_true")

    s = sub.add_parser("gate", help="LLM legal gate: explicit non-denial of delegation / AI"); s.set_defaults(fn=cmd_gate)
    common_select(s); llm_opts(s); s.add_argument("--refresh", action="store_true")

    s = sub.add_parser("price", help="ask value, scope hours, market labor, overpriced ratio"); s.set_defaults(fn=cmd_price)
    common_select(s); llm_opts(s); s.add_argument("--refresh", action="store_true")
    s.add_argument("--viable-only", action="store_true"); s.add_argument("--no-benchmark", action="store_true")

    s = sub.add_parser("talent", help="load / search / score talent"); s.set_defaults(fn=cmd_talent)
    ts = s.add_subparsers(dest="talent_cmd", required=True)
    show = argparse.ArgumentParser(add_help=False); show.add_argument("--show", action="store_true", help="print every scored profile")
    t = ts.add_parser("import", parents=[show]); t.add_argument("path"); t.add_argument("--source-name", default="csv")
    t = ts.add_parser("upwork-auth", parents=[show]); t.add_argument("--scopes", default="")
    ts.add_parser("upwork-introspect", parents=[show])
    t = ts.add_parser("upwork-search", parents=[show]); t.add_argument("--skills"); t.add_argument("--query", default="")
    t.add_argument("--max-rate", type=float); t.add_argument("--limit", type=int, default=100)
    ts.add_parser("score", parents=[show])

    s = sub.add_parser("match", help="rank overpriced asks x underpriced provably-good talent"); s.set_defaults(fn=cmd_match)
    common_select(s); s.add_argument("--top-k", type=int, default=3); s.add_argument("--show", type=int, default=20)
    s.add_argument("--include-blocked", action="store_true", help="also match opportunities that failed the gate (for review)")

    s = sub.add_parser("report", help="markdown dossier"); s.set_defaults(fn=cmd_report)
    s.add_argument("--kind", choices=["matches", "gate"], default="matches"); s.add_argument("--limit", type=int, default=25); s.add_argument("--out")

    s = sub.add_parser("pump", help="fetch+gate+price+match+report concurrently and cumulatively (streaming)"); s.set_defaults(fn=cmd_pump)
    llm_opts(s); s.add_argument("--threshold", type=float, default=0.6); s.add_argument("--interval", type=float, default=30.0)
    s.add_argument("--batch", type=int, default=25); s.add_argument("--max-docs", type=int, default=6)
    s.add_argument("--no-benchmark", action="store_true"); s.add_argument("--out-dir", default="rfp_out")
    s.add_argument("--limit", type=int, default=40, help="opportunities in shortlist.md")
    s.add_argument("--talent", help="CSV/JSON roster to (re)load before pumping")
    s.add_argument("--fetch-workers", type=int, default=4, help="parallel attachment fetchers")
    s.add_argument("--watch", action="store_true", help="never exit; keep pumping as crawls land rows")

    s = sub.add_parser("stats"); s.set_defaults(fn=cmd_stats)

    s = sub.add_parser("run", help="the whole pipeline"); s.set_defaults(fn=cmd_run)
    s.add_argument("--sources"); s.add_argument("--days", type=int, default=30)
    s.add_argument("--keywords"); s.add_argument("--discover", action="store_true"); s.add_argument("--max-pages", type=int, default=20)
    s.add_argument("--no-details", action="store_true"); common_select(s); llm_opts(s)
    s.add_argument("--max-docs", type=int, default=12); s.add_argument("--refresh", action="store_true")
    s.add_argument("--viable-only", action="store_true", default=True); s.add_argument("--no-benchmark", action="store_true")
    s.add_argument("--show", type=int, default=20); s.add_argument("--top-k", type=int, default=3); s.add_argument("--include-blocked", action="store_true")
    s.add_argument("--out"); s.add_argument("--kind", default="matches")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)
