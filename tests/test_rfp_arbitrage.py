"""rfp_arbitrage -- the RFP indexer / legal gate / talent matcher. Network-free: sources are
exercised through their converters on fixture rows, the LLM through a fake JSON back end."""
import json
import time
import os
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rfp_arbitrage.models import Opportunity, Jurisdiction, Tier, DelegationStatus, AIStatus, ClauseVerdict  # noqa: E402
from rfp_arbitrage.store import Store  # noqa: E402
from rfp_arbitrage.taxonomy import classify  # noqa: E402
from rfp_arbitrage import clauses  # noqa: E402
from rfp_arbitrage.llm import LLM, _extract_json  # noqa: E402
from rfp_arbitrage.talent.csv_source import load as load_talent, row_to_talent  # noqa: E402
from rfp_arbitrage.talent.scoring import score_quality, score_price, skill_families  # noqa: E402
from rfp_arbitrage.pricing import price, stated_budget, heuristic_scope  # noqa: E402
from rfp_arbitrage.match import build_matches, fit  # noqa: E402
from rfp_arbitrage.report import match_report, gate_report  # noqa: E402
from rfp_arbitrage.sources.base import norm_date, parse_money, strip_html  # noqa: E402
from rfp_arbitrage.sources.registry import coverage_table, US_STATES, CA_PROVINCES  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "rfp_talent_sample.csv"


def _opp(key="t:1", title="Website redesign and content strategy consulting", desc="", **kw):
    d = dict(source="t", source_id=key.split(":")[1], title=title, url="https://example.org/" + key,
             jurisdiction=Jurisdiction.US, tier=Tier.MUNICIPAL, buyer="City of Example", region="CA",
             posted="2026-09-01", deadline="2099-01-01", description=desc, currency="USD")
    d.update(kw)
    return Opportunity(**d)


# --- taxonomy ----------------------------------------------------------------------------
def test_taxonomy_intellectual_vs_physical():
    assert classify("Grant writing services").score >= 0.5
    assert classify("Custom software development", naics=["541511"]).score >= 0.8
    assert classify("Asphalt paving program 2026").score < 0.2
    assert classify("Supply and delivery of pickup trucks").score < 0.2
    # codes are authoritative on the physical side
    assert classify("Study of something", naics=["237310"]).score < 0.4
    # French-only notice with a service UNSPSC still passes on the code
    assert classify("Services-conseils en gestion", unspsc=["80101500"]).score >= 0.5


# --- store -------------------------------------------------------------------------------
def test_store_roundtrip(tmp_path):
    st = Store(tmp_path / "x.sqlite3")
    o = _opp(naics=["541511"], attachments=["https://example.org/a.pdf"], raw={"k": 1})
    assert st.upsert_opportunities([o]) == 1
    assert st.upsert_opportunities([o]) == 1          # idempotent upsert
    back = st.opportunity(o.key)
    assert back.naics == ["541511"] and back.attachments == ["https://example.org/a.pdf"] and back.raw == {"k": 1}
    st.set_intellectual(o.key, 0.9, "test")
    assert [x.key for x in st.intellectual()] == [o.key]
    st.put_document(o.key, "https://example.org/a.pdf", "pdf", "Subcontracting is permitted.")
    assert "Subcontracting is permitted" in st.full_text(o.key)
    v = ClauseVerdict(o.key, DelegationStatus.SILENT, AIStatus.SILENT, confidence=0.7, method="llm:x")
    st.put_verdict(v)
    assert st.verdict(o.key).arbitrage_viable and st.verdicts(viable_only=True)
    st.put_pricing(o.key, {"ask_value": 100000, "ask_basis": "stated:notice", "hours_low": 100, "hours_high": 200, "skill_mix": {"software": 1}})
    assert st.pricing(o.key)["ask_value"] == 100000
    assert st.stats()["viable"] == 1


# --- clause gate: heuristic ----------------------------------------------------------------
PROHIBIT_SUB = "The Contractor shall not subcontract any portion of the Work. All Services must be performed by the Contractor's own employees."
CONSENT_SUB = "The Contractor may subcontract portions of the Work only with the prior written consent of the City, which shall not be unreasonably withheld."
PERMIT_SUB = "Proponents may subcontract or form a joint venture; teaming agreements are permitted and should be described in the proposal."
PROHIBIT_AI = ("Proposals or deliverables generated in whole or in part using generative artificial intelligence tools such as ChatGPT "
               "will be rejected and the Proponent will be disqualified.")
RESTRICT_AI = "Proponents must disclose any use of artificial intelligence in preparing the proposal. AI tools shall not be used with confidential data."
SELF_PERFORM = "The prime contractor shall self-perform at least 60% of the contract value with its own forces."
RESIDENCY = "All data shall remain in Canada at all times. Storage or processing of City data outside of Canada is prohibited."
CLEARANCE = "All personnel must hold a valid Reliability Status security clearance prior to contract start."
SILENT = "The Consultant will deliver a housing needs assessment report, a public engagement summary, and a final presentation to Council."


@pytest.mark.parametrize("text,deleg,ai,viable", [
    (PROHIBIT_SUB, DelegationStatus.EXPLICITLY_PROHIBITED, AIStatus.SILENT, False),
    (CONSENT_SUB, DelegationStatus.PERMITTED_WITH_CONSENT, AIStatus.SILENT, True),
    (PERMIT_SUB, DelegationStatus.EXPLICITLY_PERMITTED, AIStatus.SILENT, True),
    (PROHIBIT_AI + " " + PERMIT_SUB, DelegationStatus.EXPLICITLY_PERMITTED, AIStatus.EXPLICITLY_PROHIBITED, False),
    (RESTRICT_AI, DelegationStatus.SILENT, AIStatus.RESTRICTED, True),
    (SELF_PERFORM, DelegationStatus.RESTRICTED, AIStatus.SILENT, True),
    (SILENT, DelegationStatus.SILENT, AIStatus.SILENT, True),
])
def test_heuristic_verdicts(text, deleg, ai, viable):
    v = clauses.heuristic_verdict("t:1", text)
    assert v.delegation == deleg and v.ai_use == ai and v.arbitrage_viable is viable and v.method == "heuristic"


def test_heuristic_conditions():
    v = clauses.heuristic_verdict("t:1", SELF_PERFORM + " " + RESIDENCY + " " + CLEARANCE)
    assert v.self_perform_min_pct == 60 and v.clearance_or_citizenship_required and v.data_residency_constraints
    assert v.arbitrage_viable   # conditions are not denials


def test_heuristic_does_not_confuse_contract_assignment_with_work():
    v = clauses.heuristic_verdict("t:1", "The Contractor shall not assign this Agreement without consent. " + PERMIT_SUB)
    assert v.delegation != DelegationStatus.EXPLICITLY_PROHIBITED


def test_prescreen_pulls_topic_passages_only():
    filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 400
    text = filler + "\n\n" + PROHIBIT_AI + "\n\n" + filler + "\n\n" + CLEARANCE + "\n\n" + filler
    ex = clauses.prescreen(text)
    topics = {e.topic for e in ex}
    assert "ai" in topics and "clearance" in topics
    assert sum(len(e.text) for e in ex) < len(text) / 4


# --- clause gate: LLM path through a fake OpenAI-compatible server ---------------------------
class _FakeLLM:
    """Stands in for the openzoo proxy: returns canned JSON, records requests."""

    def __init__(self, payload):
        self.payload = payload
        self.requests = []
        srv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(b'{"data": []}')

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                srv.requests.append(json.loads(self.rfile.read(n)))
                body = json.dumps({"choices": [{"message": {"content": "```json\n" + json.dumps(srv.payload) + "\n```"}}],
                                   "usage": {"prompt_tokens": 10, "completion_tokens": 5}}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(body)

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/v1" % self.httpd.server_address[1]

    def close(self):
        self.httpd.shutdown()


def test_llm_verdict_with_evidence_discipline_and_crosscheck():
    payload = {"delegation": "explicitly_prohibited", "delegation_evidence": [],   # no quote -> demoted
               "ai_use": "silent", "ai_evidence": [], "self_perform_min_pct": None, "key_personnel_lock": False,
               "consent_required": False, "data_residency_constraints": [], "clearance_or_citizenship_required": False,
               "other_blockers": [], "confidence": 0.9, "rationale": "r"}
    fake = _FakeLLM(payload)
    try:
        llm = LLM(provider="openzoo", url=fake.url, model="fake", api_key="k")
        assert llm.available() is None
        v = clauses.analyze(_opp(), PERMIT_SUB, llm)
        assert v.method == "llm:openzoo:fake"
        assert v.delegation == DelegationStatus.SILENT               # demoted: claimed prohibition without a quote
        assert any("without a quote" in b for b in v.other_blockers)
        assert v.arbitrage_viable
        # the request carried the schema + the solicitation text
        req = fake.requests[-1]
        assert req["temperature"] == 0 and "JSON Schema" in req["messages"][0]["content"]
        assert PERMIT_SUB[:40] in req["messages"][1]["content"]
        assert llm.usage["input"] == 10 and llm.calls == 1
    finally:
        fake.close()


def test_llm_prohibition_blocks_and_heuristic_agreement_keeps_confidence():
    payload = {"delegation": "explicitly_prohibited", "delegation_evidence": ["The Contractor shall not subcontract any portion of the Work."],
               "ai_use": "silent", "ai_evidence": [], "self_perform_min_pct": None, "key_personnel_lock": False,
               "consent_required": False, "data_residency_constraints": [], "clearance_or_citizenship_required": False,
               "other_blockers": [], "confidence": 0.9, "rationale": "r"}
    fake = _FakeLLM(payload)
    try:
        v = clauses.analyze(_opp(), PROHIBIT_SUB, LLM(provider="openzoo", url=fake.url, model="m", api_key="k"))
        assert not v.arbitrage_viable and v.confidence == 0.9 and not v.other_blockers
    finally:
        fake.close()


def test_llm_unreachable_falls_back_to_heuristic():
    llm = LLM(provider="openzoo", url="http://127.0.0.1:9/v1", model="m", api_key="k", timeout=2)
    assert llm.available() is not None
    v = clauses.analyze(_opp(), PROHIBIT_AI, llm)
    assert v.method == "heuristic" and v.ai_use == AIStatus.EXPLICITLY_PROHIBITED and any("LLM unavailable" in b for b in v.other_blockers)


def test_extract_json_variants():
    assert _extract_json('{"a": 1}') == {"a": 1}
    assert _extract_json('Sure:\n```json\n{"a": [1,2]}\n```') == {"a": [1, 2]}
    assert _extract_json('prefix {"a": {"b": 2}} suffix') == {"a": {"b": 2}}


# --- talent ------------------------------------------------------------------------------
def test_talent_csv_and_scoring():
    people = list(load_talent(FIX, "upwork"))
    assert len(people) == 10
    by = {t.name: t for t in people}
    assert by["Nordic Cloud Collective"].is_team and by["Nordic Cloud Collective"].team_size == 7
    assert by["Sophie Tremblay"].currency == "CAD" and "top_rated" in by["Sophie Tremblay"].badges
    q_ana, _ = score_quality(by["Ana Petrova"]); q_new, notes = score_quality(by["Newbie Dev"])
    assert q_ana >= 0.7 and q_new <= 0.35 and any("floor" in n for n in notes)
    p_ana, _ = score_price(by["Ana Petrova"]); p_pricey, _ = score_price(by["Pricey Corp"])
    assert p_ana > 0.5 and p_pricey == 0.0
    assert "software" in skill_families(by["Ana Petrova"].skills, by["Ana Petrova"].title)


def test_talent_row_aliases():
    t = row_to_talent({"Freelancer": "X", "Rate": "$120/hr", "JSS": "96%", "Hours Billed": "1,200", "Type": "Agency", "Skills": "GIS; ArcGIS"})
    assert t.hourly_rate == 120 and t.job_success_pct == 96 and t.total_hours == 1200 and t.is_team and t.skills == ["gis", "arcgis"]


# --- pricing + matching --------------------------------------------------------------------
def test_stated_budget_and_heuristic_scope():
    assert stated_budget("The estimated value of this contract is $1,250,000 over three years.") == 1_250_000
    assert stated_budget("Budget: CAD $250k. Not to exceed $300,000.") == 300_000
    assert stated_budget("no money here") is None
    sc = heuristic_scope(_opp(title="Data analytics dashboard development"), "x" * 100)
    assert sc["hours_low"] > 0 and "data" in sc["skill_mix"] or "software" in sc["skill_mix"]


def test_price_and_match_end_to_end(tmp_path):
    st = Store(tmp_path / "m.sqlite3")
    o1 = _opp("t:1", "Custom software development and data dashboard", "Build a Django web application and a Power BI dashboard. Estimated value $240,000.", naics=["541511"])
    o2 = _opp("t:2", "Grant writing services", "Write federal grant applications. Budget $40,000.")
    o3 = _opp("t:3", "Asphalt paving", "Pave roads. Budget $2,000,000.")
    st.upsert_opportunities([o1, o2, o3])
    for o in (o1, o2, o3):
        c = classify(o.title, o.description)
        st.set_intellectual(o.key, c.score, c.reason)
    st.put_verdict(ClauseVerdict(o1.key, DelegationStatus.SILENT, AIStatus.SILENT, confidence=0.8, method="llm:x"))
    st.put_verdict(ClauseVerdict(o2.key, DelegationStatus.EXPLICITLY_PROHIBITED, AIStatus.SILENT, confidence=0.9, method="llm:x",
                                 delegation_evidence=["shall not subcontract"]))
    st.upsert_talent(list(load_talent(FIX, "upwork")))
    pricing = {}
    for o in (o1, o2):
        p = price(o, o.description, None)
        assert p["ask_value"] and p["ask_basis"].startswith("stated:text")
        st.put_pricing(o.key, p); pricing[o.key] = p
    ms = build_matches(st.intellectual(), st.verdicts(), pricing, st.talent())
    assert ms and all(m.opportunity_key == o1.key for m in ms)          # o2 blocked by the gate, o3 not intellectual
    best = ms[0]
    assert best.margin >= 0.35 and best.gate_ok and best.labor_cost < best.ask_value
    assert "Pricey Corp" not in " ".join(best.talent_keys) and "newbie" not in " ".join(best.talent_keys)
    st.put_matches(ms)
    rep = match_report(st)
    assert "VIABLE" in rep and "Ana Petrova" in rep or "Marcus" in rep
    assert "| yes |" in gate_report(st) and "| NO |" in gate_report(st)
    # include_blocked lets a reviewer see what the gate removed
    assert any(m.opportunity_key == o2.key for m in build_matches(st.intellectual(), st.verdicts(), pricing, st.talent(), require_viable=False))


def test_fit_prefers_matching_families():
    people = {t.name: t for t in load_talent(FIX, "upwork")}
    o = _opp(title="Machine learning model for permit processing", description="NLP classification of permit applications")
    mix = {"ai_ml": 0.7, "software": 0.3}
    assert fit(o, mix, people["Chen Wei"]) > fit(o, mix, people["Diego Alvarez"])


# --- source converters (no network) ------------------------------------------------------------
def test_date_and_money_helpers():
    assert norm_date("09/04/2026 08:34 PM EDT") == "2026-09-04T20:34:00"
    assert norm_date("2026/09/25") == "2026-09-25"
    assert norm_date("2026-09-25T12:00:00-05:00").startswith("2026-09-25T12:00:00")
    assert norm_date("") == "" and norm_date("garbage") == ""
    assert parse_money("$1,250,000.50") == 1250000.5 and parse_money("2.5 million") == 2_500_000
    assert strip_html("<p>Hello&nbsp;<b>world</b></p><script>x</script>") == "Hello world"


def test_sam_converter():
    from rfp_arbitrage.sources.sam_gov import SamGov
    s = SamGov.__new__(SamGov); s.cfg = type("C", (), {"sam_api_key": "k"})()
    row = {"noticeId": "abc", "title": "Pedestrian testing", "uiLink": "https://sam.gov/opp/abc/view", "postedDate": "2026-09-05",
           "responseDeadLine": "2026-09-20T15:00:00-04:00", "type": "Presolicitation", "naicsCodes": ["541380"], "classificationCode": "H223",
           "fullParentPathName": "DOT.NHTSA", "placeOfPerformance": {"state": {"code": "DC"}}, "pointOfContact": [{"fullName": "V", "email": "v@dot.gov"}],
           "resourceLinks": ["https://sam.gov/api/prod/opps/v3/opportunities/resources/files/x/download"], "description": "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc"}
    o = s._convert(row)
    assert o.tier == Tier.FEDERAL and o.naics == ["541380"] and o.psc == "H223" and o.region == "DC" and o.deadline.startswith("2026-09-20")
    assert s.attachment_url(o.attachments[0]).endswith("?api_key=k")


def test_canadabuys_converter_and_tier():
    from rfp_arbitrage.sources.canadabuys import CanadaBuys, tier_for
    c = CanadaBuys.__new__(CanadaBuys)
    row = {"title-titre-eng": "Consulting services", "referenceNumber-numeroReference": "MX-1", "procurementCategory-categorieApprovisionnement": "*SRV",
           "contractingEntityName-nomEntitContractante-eng": "City of Ottawa", "unspsc": "80101500,80101600", "tenderClosingDate-appelOffresDateCloture": "2026-10-01T14:00:00",
           "noticeURL-URLavis-eng": "https://canadabuys.canada.ca/x", "attachment-piecesJointes-eng": "https://a.example/1.pdf\nhttps://a.example/2.pdf"}
    o = c._convert(row)
    assert o.tier == Tier.MUNICIPAL and o.unspsc == ["80101500", "80101600"] and len(o.attachments) == 2 and o.currency == "CAD"
    assert tier_for("Department of National Defence (DND)") == Tier.FEDERAL and tier_for("Ministry of Health Ontario") == Tier.STATE


def test_seao_converter():
    from rfp_arbitrage.sources.seao import SeaoQuebec
    s = SeaoQuebec.__new__(SeaoQuebec)
    rel = {"ocid": "ocds-x-1", "date": "2026-03-27T16:09:43-04:00", "tag": ["tender"], "buyer": {"name": "Ville de Laval", "id": "OP-1"},
           "parties": [{"id": "OP-1", "name": "Ville de Laval", "roles": ["buyer"], "details": {"municipal": "1"}, "address": {"locality": "Laval"}}],
           "tender": {"id": "T1", "title": "Services professionnels", "items": [{"classification": {"scheme": "UNSPSC", "id": "80101500"}}],
                      "tenderPeriod": {"endDate": "2026-04-30T14:00:00-04:00"}, "documents": [{"url": "https://seao.gouv.qc.ca/x"}], "mainProcurementCategory": "services"}}
    o = s._convert(rel)
    assert o.tier == Tier.MUNICIPAL and o.unspsc == ["80101500"] and o.region == "Laval, QC" and o.deadline.startswith("2026-04-30")


def test_socrata_column_mapper_and_converter():
    from rfp_arbitrage.sources.socrata import map_columns, Socrata, CURATED
    cols = map_columns(["contracttitle", "opendate", "unspsc", "agencycode", "deadlinedate", "contractnumber", "bidurl"])
    assert cols["title"] == "contracttitle" and cols["deadline"] == "deadlinedate" and cols["url"] == "bidurl"
    s = Socrata.__new__(Socrata)
    ds = CURATED[1]
    o = s._convert(ds, {"contracttitle": "IT consulting", "deadlinedate": "2026-10-01T00:00:00.000", "contractnumber": "GSS-1", "bidurl": {"url": "https://x"}})
    assert o.tier == Tier.STATE and o.url == "https://x" and o.source_id.endswith("/GSS-1")
    ds_status = dict(ds, cols=dict(ds["cols"], status="status"))
    assert s._convert(ds_status, {"contracttitle": "old", "status": "Awarded", "deadlinedate": "2020-01-01"}) is None


def test_mets_converter():
    from rfp_arbitrage.sources.mets import convert
    it = {"site": "merx", "jurisdiction": "CA", "source_id": "1", "url": "https://www.merx.com/x", "title": "Consulting", "buyer": "The City of Winnipeg",
          "location": "Winnipeg, MB, CAN", "posted": "2026/09/04", "deadline": "2026/09/25", "icon_hint": "Canadian Public Tenders", "categories": ["80101500", "Consulting"]}
    o = convert(it)
    assert o.tier == Tier.MUNICIPAL and o.deadline == "2026-09-25" and o.unspsc == ["80101500"] and o.currency == "CAD"
    it2 = {"site": "bidnet", "jurisdiction": "US", "source_id": "2", "url": "https://www.bidnetdirect.com/hawaii/solicitations/open-bids/statewide/X/2", "title": "T",
           "location": "Hawaii", "posted": "09/04/2026", "deadline": "09/10/2026", "icon_hint": "Federal Bids"}
    o2 = convert(it2)
    assert o2.tier == Tier.FEDERAL and o2.region == "Hawaii" and o2.posted == "2026-09-04"


def test_registry_is_complete():
    assert len(US_STATES) == 51 and len(CA_PROVINCES) == 13
    rows = coverage_table()
    assert all(r["covered_by"] for r in rows if r["tier"] in ("federal", "state")), "every state/province must map to a fetcher"


def test_cli_smoke(tmp_path):
    from rfp_arbitrage.cli import main
    db = str(tmp_path / "cli.sqlite3")
    assert main(["--db", db, "talent", "import", str(FIX)]) == 0
    assert main(["--db", db, "stats"]) == 0
    assert main(["--db", db, "sources"]) == 0
    st = Store(db)
    assert st.stats()["talent"] == 10 and all(q >= 0 for q, p in st.talent_scores().values())


def test_pump_streams_cumulatively(tmp_path, monkeypatch):
    """Rows landing while the pump runs get fetched, gated, priced and reported without restarts."""
    from rfp_arbitrage.pump import Pump, FETCHED_MARK
    import rfp_arbitrage.attachments as att

    db = tmp_path / "p.sqlite3"
    st = Store(db)
    st.upsert_talent(list(load_talent(FIX, "upwork")))
    o1 = _opp("t:1", "Custom software development and data dashboard", "Build a Django app. Estimated value $240,000. " + PERMIT_SUB, naics=["541511"])
    st.upsert_opportunities([o1]); c = classify(o1.title, o1.description); st.set_intellectual(o1.key, c.score, c.reason)
    # no network: attachments stage records the sentinel only
    monkeypatch.setattr(att.Fetcher, "urls_for", lambda self, opp: [])
    logs = []
    pump = Pump(db, threshold=0.5, interval=0.2, benchmark=False, out_dir=tmp_path / "out", log=logs.append)
    # land a second row mid-run from another connection
    def lander():
        time.sleep(0.15)
        st2 = Store(db)
        o2 = _opp("t:2", "Grant writing services", "Write grant applications. Budget $40,000. " + PROHIBIT_SUB)
        st2.upsert_opportunities([o2]); c2 = classify(o2.title, o2.description); st2.set_intellectual(o2.key, c2.score, c2.reason); st2.close()
    threading.Thread(target=lander, daemon=True).start()
    counts = pump.run(watch=False)
    st3 = Store(db)
    assert st3.has_document("t:1", FETCHED_MARK) and st3.has_document("t:2", FETCHED_MARK)
    vs = st3.verdicts()
    assert vs["t:1"].arbitrage_viable and not vs["t:2"].arbitrage_viable
    assert st3.pricing("t:1") and st3.pricing("t:2") is None          # blocked rows are not priced
    assert counts["matched"] >= 1 and (tmp_path / "out" / "shortlist.md").exists() and (tmp_path / "out" / "gate.md").exists()
    assert "t:2" not in " ".join(m.opportunity_key for m in st3.matches())
    assert st3.stats()["documents"] == 0                              # sentinels are not documents
