"""The live board: one self-contained HTML page rewritten every pump round, holding the
drafted bids and the pipeline behind them. The pump writes it; a human publishes it."""
from __future__ import annotations

import html
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .store import Store
from .report import ready_board


def _money(v) -> str:
    return "—" if not v else f"${float(v):,.0f}"


def render(store: Store, limit: int = 60) -> str:
    from .bidder import Bidder
    b = Bidder.load()
    rows = ready_board(store, limit)
    st = store.stats()
    sendable = [r for r in rows if r["sendable"]]
    blocked = [r for r in rows if not r["sendable"]]
    val = sum(r["price"] for r in sendable)
    e = html.escape
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    def card(r: dict[str, Any]) -> str:
        cls = "ok" if r["sendable"] else "blk"
        blockers = "".join(f"<li>{e(x[:200])}</li>" for x in (r["blockers"] + r["claims"])[:5])
        deliv = "".join(f"<li>{e(str(d)[:120])}</li>" for d in r["deliverables"])
        return f"""<article class="bid {cls}">
  <div class="bh"><span class="tag {cls}">{'READY TO SEND' if r['sendable'] else 'BLOCKED'}</span>
    <span class="rt">{e(r['route'])}</span><span class="dl">closes {e(r['deadline'])}</span></div>
  <h3><a href="{e(r['url'])}" target="_blank" rel="noopener">{e(r['title'][:130])}</a></h3>
  <div class="meta">{e(r['buyer'][:80])} · {e(r['where'])}</div>
  <div class="nums"><b>{_money(r['price'])}</b><span>bid price</span>
    <b>{_money(r['delivery'])}</b><span>delivery</span>
    <b>{(str(round(r['margin']*100)) + '%') if r.get('margin') is not None else '—'}</b><span>margin</span>
    <b>{(f"{r['hours']:,.0f} h" if r.get('hours') else '—')}</b><span>scope</span></div>
  {f'<ul class="dv">{deliv}</ul>' if deliv else ''}
  {f'<ul class="bl">{blockers}</ul>' if blockers else ''}
</article>"""

    return f"""<title>STACCCS bid board</title>
<style>
:root{{--paper:#F4F5F0;--card:#fff;--ink:#191C18;--ink2:#4C524A;--mute:#7B8179;--line:#D3D7CD;
--ok:#1F7A47;--ok-s:#DEF0E4;--blk:#A8281F;--blk-s:#F7DEDB;--acc:#0B5FA5;--acc-s:#DEEAF6;
--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;--body:"Public Sans",system-ui,-apple-system,Segoe UI,sans-serif;
--disp:"Newsreader",Georgia,serif}}
@media(prefers-color-scheme:dark){{:root:not([data-theme=light]){{--paper:#151814;--card:#1E221D;--ink:#EDEFE7;--ink2:#B7BCB1;
--mute:#878D83;--line:#333930;--ok:#63C68C;--ok-s:#18301F;--blk:#EE8A80;--blk-s:#3A1D1A;--acc:#6EB0EF;--acc-s:#152A3E}}}}
:root[data-theme=dark]{{--paper:#151814;--card:#1E221D;--ink:#EDEFE7;--ink2:#B7BCB1;--mute:#878D83;--line:#333930;
--ok:#63C68C;--ok-s:#18301F;--blk:#EE8A80;--blk-s:#3A1D1A;--acc:#6EB0EF;--acc-s:#152A3E}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font-family:var(--body);line-height:1.5}}
.page{{max-width:1080px;margin:0 auto;padding:34px 22px 70px}}
h1{{font-family:var(--disp);font-weight:500;font-size:clamp(30px,5vw,48px);line-height:1.05;margin:8px 0 10px}}
h2{{font-family:var(--disp);font-weight:500;font-size:25px;margin:34px 0 12px}}
.eyebrow{{font-family:var(--mono);font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--mute)}}
.lede{{color:var(--ink2);max-width:64ch;font-size:16px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:22px 0 6px}}
.tile{{border-top:2px solid var(--ink);padding-top:10px}}.tile.ok{{border-color:var(--ok)}}.tile.acc{{border-color:var(--acc)}}
.tile .n{{font-family:var(--mono);font-size:31px;font-weight:500;font-variant-numeric:tabular-nums;line-height:1}}
.tile.ok .n{{color:var(--ok)}}.tile.acc .n{{color:var(--acc)}}
.tile .l{{font-size:12.5px;color:var(--ink2);margin-top:5px}}
.bid{{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);border-radius:7px;padding:15px 17px;margin:0 0 13px}}
.bid.blk{{border-left-color:var(--blk)}}
.bh{{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:7px}}
.tag{{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;padding:2px 8px;border-radius:999px;background:var(--ok-s);color:var(--ok)}}
.tag.blk{{background:var(--blk-s);color:var(--blk)}}
.rt{{font-family:var(--mono);font-size:11px;color:var(--acc);background:var(--acc-s);padding:2px 7px;border-radius:999px}}
.dl{{font-family:var(--mono);font-size:11px;color:var(--mute);margin-left:auto}}
.bid h3{{font-size:15.5px;margin:0 0 3px;font-weight:600;line-height:1.3}}
.bid h3 a{{color:var(--ink);text-decoration:none}}.bid h3 a:hover{{text-decoration:underline}}
.meta{{font-size:12.5px;color:var(--mute);margin-bottom:9px}}
.nums{{display:grid;grid-template-columns:repeat(4,auto);gap:2px 20px;justify-content:start;font-size:12px;color:var(--mute);margin-bottom:8px}}
.nums b{{font-family:var(--mono);font-size:16px;color:var(--ink);font-variant-numeric:tabular-nums;grid-row:1}}
.nums span{{grid-row:2}}
ul{{margin:6px 0 0;padding-left:17px}}li{{font-size:12.5px;color:var(--ink2);margin-bottom:3px}}
ul.bl li{{color:var(--blk)}}
.foot{{border-top:1px solid var(--line);margin-top:30px;padding-top:14px;font-size:12.5px;color:var(--mute)}}
.mono{{font-family:var(--mono)}}
</style>
<div class="page">
<div class="eyebrow">live bid board · {now} · rewritten every pump round</div>
<h1>{len(sendable)} bids ready to send</h1>
<p class="lede">Drafted for <span class="mono">{e(b.legal_name)}</span> ({e(b.short_name)}), a {e(b.entity_type)} of {e(b.state_of_incorporation)}.
Every draft is re-read before it appears here: any claim of a registration, certification, experience or past performance the
entity cannot support blocks it and names the line to fix.</p>

<div class="tiles">
  <div class="tile ok"><div class="n">{len(sendable)}</div><div class="l">clean drafts, nothing left to correct</div></div>
  <div class="tile ok"><div class="n">{_money(val)}</div><div class="l">bid value sitting ready</div></div>
  <div class="tile"><div class="n">{len(blocked)}</div><div class="l">drafted but blocked on a registration or a flagged claim</div></div>
  <div class="tile acc"><div class="n">{st['matches']:,}</div><div class="l">eligible matches queued behind these, of {st['opportunities']:,} indexed</div></div>
</div>

<h2>Ready to send</h2>
{''.join(card(r) for r in sendable) or '<p class="lede">None clean yet.</p>'}

<h2>Blocked</h2>
{''.join(card(r) for r in blocked) or '<p class="lede">Nothing blocked.</p>'}

<div class="foot">Gate verdicts: {st['viable']:,} viable of {st['verdicts']:,}. Prices from {store.conn.execute("SELECT COUNT(*) FROM awards").fetchone()[0]:,} comparable awards.
No bid has been submitted. A ready draft still needs a human to send it.</div>
</div>"""


def write(store: Store, path: str | Path = "rfp_out/board.html", limit: int = 60) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(render(store, limit), encoding="utf-8")
    return p
