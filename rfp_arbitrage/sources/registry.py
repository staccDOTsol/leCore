"""The coverage map: every US state + DC, every Canadian province + territory, the US and
Canadian federal systems, and the multi-tenant municipal platforms -- each with its portal
and WHICH fetcher covers it today. `python -m rfp_arbitrage sources` prints this so the
gaps are visible instead of implied.

covered_by values: a source name from SOURCES, or a platform tag:
  "sam_gov" / "canadabuys" / "seao_quebec" / "merx" / "bidnet" / "socrata"  -> implemented
  "bonfire" / "bidsandtenders" / "planetbids" / "demandstar" / "opengov" / "periscope" /
  "ionwave" / "jaggaer" / "ariba" / "peoplesoft" / "custom" -> platform identified, spider
  not yet written (contributions: one spider per platform covers every tenant)."""
from __future__ import annotations

US_STATES: dict[str, dict] = {
    "AL": {"portal": "https://www.alabamabuys.gov", "platform": "jaggaer", "covered_by": ["bidnet"]},
    "AK": {"portal": "https://aws.state.ak.us/OnlinePublicNotices/", "platform": "custom", "covered_by": ["bidnet"]},
    "AZ": {"portal": "https://app.az.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "AR": {"portal": "https://www.transform.ar.gov/procurement/bids/", "platform": "custom", "covered_by": ["bidnet"]},
    "CA": {"portal": "https://caleprocure.ca.gov", "platform": "peoplesoft", "covered_by": ["bidnet", "socrata"]},
    "CO": {"portal": "https://www.bidscolorado.com", "platform": "jaggaer", "covered_by": ["bidnet"]},
    "CT": {"portal": "https://portal.ct.gov/das/ctsource", "platform": "custom", "covered_by": ["bidnet"]},
    "DE": {"portal": "https://mymarketplace.delaware.gov", "platform": "custom", "covered_by": ["socrata", "bidnet"]},
    "DC": {"portal": "https://contracts.dc.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "FL": {"portal": "https://vendor.myfloridamarketplace.com", "platform": "custom", "covered_by": ["bidnet", "demandstar"]},
    "GA": {"portal": "https://ssl.doas.state.ga.us/gpr/", "platform": "custom", "covered_by": ["bidnet"]},
    "HI": {"portal": "https://hands.ehawaii.gov/hands/opportunities", "platform": "custom", "covered_by": ["bidnet"]},
    "ID": {"portal": "https://purchasing.idaho.gov", "platform": "jaggaer", "covered_by": ["bidnet"]},
    "IL": {"portal": "https://www.bidbuy.illinois.gov", "platform": "periscope", "covered_by": ["bidnet"]},
    "IN": {"portal": "https://www.in.gov/idoa/procurement/", "platform": "custom", "covered_by": ["bidnet"]},
    "IA": {"portal": "https://bidopportunities.iowa.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "KS": {"portal": "https://admin.ks.gov/offices/procurement-and-contracts", "platform": "custom", "covered_by": ["bidnet"]},
    "KY": {"portal": "https://emars.ky.gov/online/vss/", "platform": "custom", "covered_by": ["bidnet"]},
    "LA": {"portal": "https://wwwcfprd.doa.louisiana.gov/osp/lapac/", "platform": "custom", "covered_by": ["bidnet"]},
    "ME": {"portal": "https://www.maine.gov/dafs/bbm/procurementservices/vendors/rfps", "platform": "custom", "covered_by": ["bidnet"]},
    "MD": {"portal": "https://emma.maryland.gov", "platform": "ivalua", "covered_by": ["bidnet", "socrata"]},
    "MA": {"portal": "https://www.commbuys.com", "platform": "periscope", "covered_by": ["bidnet"]},
    "MI": {"portal": "https://sigma.michigan.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "MN": {"portal": "https://mn.gov/mmb/", "platform": "custom", "covered_by": ["bidnet"]},
    "MS": {"portal": "https://www.ms.gov/dfa/contract_bid_search", "platform": "custom", "covered_by": ["bidnet"]},
    "MO": {"portal": "https://missouribuys.mo.gov", "platform": "jaggaer", "covered_by": ["bidnet"]},
    "MT": {"portal": "https://emacs.mt.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "NE": {"portal": "https://das.nebraska.gov/materiel/purchasing.html", "platform": "custom", "covered_by": ["bidnet"]},
    "NV": {"portal": "https://nevadaepro.com", "platform": "periscope", "covered_by": ["bidnet"]},
    "NH": {"portal": "https://apps.das.nh.gov/bidscontracts/bids.aspx", "platform": "custom", "covered_by": ["bidnet"]},
    "NJ": {"portal": "https://www.njstart.gov", "platform": "periscope", "covered_by": ["bidnet"]},
    "NM": {"portal": "https://www.generalservices.state.nm.us/state-purchasing/", "platform": "custom", "covered_by": ["bidnet"]},
    "NY": {"portal": "https://www.nyscr.ny.gov", "platform": "custom", "covered_by": ["bidnet", "socrata"]},
    "NC": {"portal": "https://www.ips.state.nc.us", "platform": "custom", "covered_by": ["bidnet"]},
    "ND": {"portal": "https://apps.nd.gov/csd/spo/services/bidder/", "platform": "custom", "covered_by": ["bidnet"]},
    "OH": {"portal": "https://procure.ohio.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "OK": {"portal": "https://oklahoma.gov/omes/services/purchasing.html", "platform": "custom", "covered_by": ["bidnet"]},
    "OR": {"portal": "https://oregonbuys.gov", "platform": "periscope", "covered_by": ["bidnet"]},
    "PA": {"portal": "https://www.emarketplace.state.pa.us", "platform": "custom", "covered_by": ["bidnet"]},
    "RI": {"portal": "https://www.ridop.ri.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "SC": {"portal": "https://procurement.sc.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "SD": {"portal": "https://www.sdbidsandcontracts.sd.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "TN": {"portal": "https://www.tn.gov/generalservices/procurement.html", "platform": "custom", "covered_by": ["bidnet"]},
    "TX": {"portal": "https://www.txsmartbuy.gov/esbd", "platform": "custom", "covered_by": ["bidnet"]},
    "UT": {"portal": "https://purchasing.utah.gov", "platform": "jaggaer", "covered_by": ["bidnet"]},
    "VT": {"portal": "https://bgs.vermont.gov/purchasing-contracting/bids", "platform": "custom", "covered_by": ["bidnet"]},
    "VA": {"portal": "https://eva.virginia.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "WA": {"portal": "https://webs.des.wa.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "WV": {"portal": "https://www.state.wv.us/admin/purchase/bids/", "platform": "custom", "covered_by": ["bidnet"]},
    "WI": {"portal": "https://vendornet.wi.gov", "platform": "custom", "covered_by": ["bidnet"]},
    "WY": {"portal": "https://ai.wyo.gov/divisions/general-services/procurement", "platform": "custom", "covered_by": ["bidnet"]},
}

CA_PROVINCES: dict[str, dict] = {
    "AB": {"portal": "https://purchasingconnection.ca", "platform": "custom", "covered_by": ["canadabuys", "merx"]},
    "BC": {"portal": "https://www.bcbid.gov.bc.ca", "platform": "ivalua", "covered_by": ["canadabuys", "merx"]},
    "MB": {"portal": "https://www.merx.com/manitoba", "platform": "merx", "covered_by": ["merx", "socrata"]},
    "NB": {"portal": "https://nbon-rpanb.gnb.ca", "platform": "custom", "covered_by": ["canadabuys", "merx"]},
    "NL": {"portal": "https://www.merx.com/nl", "platform": "merx", "covered_by": ["merx"]},
    "NS": {"portal": "https://procurement.novascotia.ca", "platform": "custom", "covered_by": ["merx", "canadabuys"]},
    "NT": {"portal": "https://www.fin.gov.nt.ca/en/services/procurement-services", "platform": "custom", "covered_by": ["canadabuys"]},
    "NU": {"portal": "https://www.gov.nu.ca/tenders", "platform": "custom", "covered_by": ["canadabuys"]},
    "ON": {"portal": "https://ontariotenders.app.jaggaer.com", "platform": "jaggaer", "covered_by": ["canadabuys", "merx"]},
    "PE": {"portal": "https://www.merx.com/pei", "platform": "merx", "covered_by": ["merx"]},
    "QC": {"portal": "https://seao.gouv.qc.ca", "platform": "seao", "covered_by": ["seao_quebec"]},
    "SK": {"portal": "https://sasktenders.ca", "platform": "custom", "covered_by": ["canadabuys", "merx"]},
    "YT": {"portal": "https://yukon.ca/en/doing-business/bids-and-tenders", "platform": "custom", "covered_by": ["canadabuys"]},
}

FEDERAL = {
    "US": {"portal": "https://sam.gov", "covered_by": ["sam_gov", "bidnet"], "benchmarks": "usaspending"},
    "CA": {"portal": "https://canadabuys.canada.ca", "covered_by": ["canadabuys", "merx"]},
}

# Multi-tenant municipal platforms. One spider per platform = every tenant. `tenants` is an
# order-of-magnitude count of public bodies on that platform in the US+CA.
MUNICIPAL_PLATFORMS = {
    "bidnet": {"tenants": 1300, "status": "implemented", "notes": "US local; free login unlocks descriptions (BIDNET_COOKIE)"},
    "merx": {"tenants": 500, "status": "implemented", "notes": "CA local + provincial; public descriptions"},
    "socrata": {"tenants": 30, "status": "implemented", "notes": "open-data portals with a live solicitations dataset"},
    "bonfire": {"tenants": 900, "status": "todo", "notes": "https://<org>.bonfirehub.com/portal/?tab=openOpportunities; JSON at /api/portal/opportunities (this sandbox's proxy 502s the domain)"},
    "bidsandtenders": {"tenants": 250, "status": "todo", "notes": "Ontario/NS/AB munis: https://<org>.bidsandtenders.ca/Module/Tenders/en -- JS-rendered, needs Playwright"},
    "planetbids": {"tenants": 600, "status": "todo", "notes": "CA/WA/AZ/TX munis: https://pbsystem.planetbids.com/portal/<id>/bo/bo-search JSON API"},
    "demandstar": {"tenants": 1000, "status": "todo", "notes": "SE US munis: api.demandstar.com (auth); Florida-heavy"},
    "opengov": {"tenants": 1200, "status": "todo", "notes": "https://procurement.opengov.com/portal/<org> -- JSON via /api"},
    "periscope": {"tenants": 400, "status": "todo", "notes": "BidSync / Periscope S2G; also IL, MA, NV, NJ, OR state portals"},
    "ionwave": {"tenants": 300, "status": "todo", "notes": "TX/MO munis: https://<org>.ionwave.net/SourcingEvents.aspx"},
    "jaggaer": {"tenants": 60, "status": "todo", "notes": "AL, CO, ID, MO, UT, ON state/provincial portals; public search pages"},
}


def coverage_table() -> list[dict]:
    rows = []
    for k, v in FEDERAL.items():
        rows.append({"jurisdiction": k, "tier": "federal", "code": k, "portal": v["portal"], "covered_by": v["covered_by"]})
    for k, v in US_STATES.items():
        rows.append({"jurisdiction": "US", "tier": "state", "code": k, "portal": v["portal"], "platform": v["platform"], "covered_by": v["covered_by"]})
    for k, v in CA_PROVINCES.items():
        rows.append({"jurisdiction": "CA", "tier": "state", "code": k, "portal": v["portal"], "platform": v["platform"], "covered_by": v["covered_by"]})
    for k, v in MUNICIPAL_PLATFORMS.items():
        rows.append({"jurisdiction": "US/CA", "tier": "municipal", "code": k, "portal": v["notes"], "platform": k,
                     "covered_by": [k] if v["status"] == "implemented" else [], "tenants": v["tenants"]})
    return rows
