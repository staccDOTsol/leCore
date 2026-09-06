"""python -m rfp_arbitrage <verb> [...]  -- see the package docstring for the pipeline."""
from __future__ import annotations

import argparse
import re
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
    from .awards import AwardIndex
    idx = AwardIndex(store)
    n = 0
    for o in opps:
        if not args.refresh and store.pricing(o.key):
            continue
        bench = idx.benchmark(o)
        if bench.get("n", 0) < 8:
            bench = None
        if bench is None and us and o.jurisdiction.value == "US" and o.naics:
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


def cmd_match(args) -> int:
    from .match import build_matches
    store = _store(args)
    opps = _select(store, args)
    verdicts = store.verdicts()
    pricing = {o.key: store.pricing(o.key) for o in opps}
    pricing = {k: v for k, v in pricing.items() if v}
    ms = build_matches(opps, verdicts, pricing, require_viable=not args.include_blocked)
    store.conn.execute("DELETE FROM matches")
    store.conn.commit()
    n = store.put_matches(ms)
    print(f"[match] {n} matches over {len(opps)} opportunities, {len(pricing)} priced, {len(verdicts)} gated; delivery = openzoo at ${__import__('rfp_arbitrage.match', fromlist=['zoo_rate']).zoo_rate():.0f}/h")
    for m in ms[: args.show]:
        o = store.opportunity(m.opportunity_key)
        print(f"  {m.score:.3f} margin={m.margin:.0%} ask=${m.ask_value:,.0f} delivery=${m.labor_cost:,.0f} gate={m.quality_score:.2f} "
              f"{o.title[:60] if o else m.opportunity_key}")
    return 0


def cmd_report(args) -> int:
    from .report import match_report, gate_report
    store = _store(args)
    from .report import live_report
    text = gate_report(store) if args.kind == "gate" else live_report(store, args.limit) if args.kind == "live" else match_report(store, args.limit)
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
    from .llm import LLM
    cfg = settings()
    llm = _llm(args)
    factory = None
    if llm is None and not getattr(args, "no_llm", False):
        factory = lambda: LLM(provider=getattr(args, "provider", None), model=getattr(args, "model", None))  # noqa: E731
    pump = Pump(args.db or cfg.db_path, threshold=args.threshold, interval=args.interval, batch=args.batch, llm=llm,
                max_docs=args.max_docs, benchmark=not args.no_benchmark, out_dir=args.out_dir, report_limit=args.limit, cfg=cfg,
                fetch_workers=args.fetch_workers, llm_factory=factory, gate_workers=args.gate_workers)
    counts = pump.run(watch=args.watch)
    print(f"[pump] finished: {json.dumps(counts)}")
    return 0


def cmd_ingest(args) -> int:
    """re-crawl on a schedule; pair with `pump --watch` in another shell."""
    from .ingest import loop
    loop(fast_every=args.fast_every * 3600, slow_every=args.slow_every * 3600, sam_every=args.sam_every * 3600,
         sam_days=args.sam_days, max_pages=args.max_pages, discover=not args.no_discover, watch=args.watch)
    return 0


def cmd_propose(args) -> int:
    """draft proposals for the top matches, from the bound solicitation, through openzoo."""
    from .propose import draft
    from .clauses import ensure_context
    from pathlib import Path
    store = _store(args)
    llm = _llm(args)
    if llm is None:
        print("[propose] a model is required (openzoo at LECORE_LLM_URL)", file=sys.stderr)
        return 2
    from .bidder import Bidder
    bidder = Bidder.load()
    out = Path(args.out_dir); out.mkdir(parents=True, exist_ok=True)
    n = 0
    for m in store.matches(args.limit * 6):
        if n >= args.limit:
            break
        if not args.refresh and store.proposal(m.opportunity_key):
            continue
        o = store.opportunity(m.opportunity_key); pr = store.pricing(m.opportunity_key) or {}
        v = store.verdict(m.opportunity_key)
        ok, why = bidder.eligible_for(o.set_aside, bool(v and v.clearance_or_citizenship_required))
        if not ok:
            continue
        ready, gate_why = bidder.ready_for(o.jurisdiction.value, o.tier.value)
        if not ready and not args.include_blocked:
            print(f"  skipped {o.key}: {gate_why}", file=sys.stderr)
            continue
        text = store.full_text(o.key)
        try:
            ctx = ensure_context(store, llm, o.key, text)
            md, data = draft(o, text, pr, m.to_dict(), llm, ctx)
        except Exception as e:  # noqa: BLE001
            print(f"[propose] {o.key}: {type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
            continue
        store.put_proposal(o.key, md, data, f"llm:{llm.name}")
        fn = out / (re.sub(r"[^A-Za-z0-9]+", "-", o.key)[:80] + ".md")
        fn.write_text(md, encoding="utf-8")
        n += 1
        print(f"  drafted ${float(data.get('price_usd') or 0):,.0f} -> {fn}  ({o.title[:60]})  spent ${llm.spent_usd:.2f}")
    print(f"[propose] {n} proposals")
    return 0


def cmd_awards(args) -> int:
    """build / refresh the comparable-awards index (the price side)."""
    from .awards import build, naics_in_use
    store = _store(args)
    naics = None if args.no_usaspending else naics_in_use(store)[: args.naics_limit]
    counts = build(store, seao_months=args.seao_months, naics=naics)
    print(f"[awards] index: {json.dumps(counts)}")
    return 0


def cmd_stats(args) -> int:
    print(json.dumps(_store(args).stats(), indent=2))
    return 0


def cmd_run(args) -> int:
    """crawl -> classify -> fetch -> gate -> price -> match -> report"""
    for fn in (cmd_crawl, cmd_fetch, cmd_gate, cmd_price):
        rc = fn(args)
        if rc:
            return rc
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

    s = sub.add_parser("match", help="rank gate-viable asks by margin when delivered through openzoo"); s.set_defaults(fn=cmd_match)
    common_select(s); s.add_argument("--show", type=int, default=20)
    s.add_argument("--include-blocked", action="store_true", help="also match opportunities that failed the gate (for review)")

    s = sub.add_parser("report", help="markdown dossier"); s.set_defaults(fn=cmd_report)
    s.add_argument("--kind", choices=["matches", "gate", "live"], default="matches"); s.add_argument("--limit", type=int, default=25); s.add_argument("--out")

    s = sub.add_parser("pump", help="fetch+gate+price+match+report concurrently and cumulatively (streaming)"); s.set_defaults(fn=cmd_pump)
    llm_opts(s); s.add_argument("--threshold", type=float, default=0.6); s.add_argument("--interval", type=float, default=30.0)
    s.add_argument("--batch", type=int, default=25); s.add_argument("--max-docs", type=int, default=6)
    s.add_argument("--no-benchmark", action="store_true"); s.add_argument("--out-dir", default="rfp_out")
    s.add_argument("--limit", type=int, default=40, help="opportunities in shortlist.md")
    s.add_argument("--fetch-workers", type=int, default=4, help="parallel attachment fetchers")
    s.add_argument("--gate-workers", type=int, default=4, help="parallel LLM gate readers (each paid call has a settlement round trip)")
    s.add_argument("--watch", action="store_true", help="never exit; keep pumping as crawls land rows")

    s = sub.add_parser("ingest", help="re-crawl all sources on a schedule (pair with pump --watch)"); s.set_defaults(fn=cmd_ingest)
    s.add_argument("--fast-every", type=float, default=2.0, help="hours between CanadaBuys/SEAO/Socrata crawls")
    s.add_argument("--slow-every", type=float, default=4.0, help="hours between MERX/BidNet crawls")
    s.add_argument("--sam-every", type=float, default=24.0, help="hours between SAM.gov crawls (public key: 10 req/day)")
    s.add_argument("--sam-days", type=int, default=7); s.add_argument("--max-pages", type=int, default=40)
    s.add_argument("--no-discover", action="store_true"); s.add_argument("--watch", action="store_true", help="loop forever")

    s = sub.add_parser("propose", help="draft bids for the top matches from the bound solicitation (openzoo)"); s.set_defaults(fn=cmd_propose)
    llm_opts(s); s.add_argument("--limit", type=int, default=5); s.add_argument("--out-dir", default="rfp_out/proposals"); s.add_argument("--refresh", action="store_true")
    s.add_argument("--include-blocked", action="store_true", help="also draft where a registration (e.g. SAM.gov UEI) is still missing")

    s = sub.add_parser("awards", help="build the comparable bids/awards index used to price asks"); s.set_defaults(fn=cmd_awards)
    s.add_argument("--seao-months", type=int, default=3); s.add_argument("--naics-limit", type=int, default=40)
    s.add_argument("--no-usaspending", action="store_true")

    s = sub.add_parser("stats"); s.set_defaults(fn=cmd_stats)

    s = sub.add_parser("run", help="the whole pipeline"); s.set_defaults(fn=cmd_run)
    s.add_argument("--sources"); s.add_argument("--days", type=int, default=30)
    s.add_argument("--keywords"); s.add_argument("--discover", action="store_true"); s.add_argument("--max-pages", type=int, default=20)
    s.add_argument("--no-details", action="store_true"); common_select(s); llm_opts(s)
    s.add_argument("--max-docs", type=int, default=12); s.add_argument("--refresh", action="store_true")
    s.add_argument("--viable-only", action="store_true", default=True); s.add_argument("--no-benchmark", action="store_true")
    s.add_argument("--show", type=int, default=20); s.add_argument("--include-blocked", action="store_true")
    s.add_argument("--out"); s.add_argument("--kind", default="matches")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)
