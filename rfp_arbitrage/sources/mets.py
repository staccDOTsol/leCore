"""MERX + BidNet Direct via the mets spider (see spiders/mets_spider.py)."""
from __future__ import annotations

import re
from typing import Iterator

from .base import Source, norm_date, parse_money, take
from .canadabuys import tier_for
from ..models import Opportunity, Jurisdiction, Tier

US_STATE_RE = re.compile(r"\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|"
                         r"Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|"
                         r"Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|"
                         r"New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|"
                         r"South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|"
                         r"Wisconsin|Wyoming|District of Columbia)\b")


def run_spider(site: str, keywords: str = "", max_pages: int = 20, details: bool = True) -> list[dict]:
    """Run the spider in-process and return its items. Twisted's reactor runs once per
    process, so one CLI invocation crawls one or more sites in a single CrawlerProcess."""
    from scrapy.crawler import CrawlerProcess
    from ..spiders.mets_spider import MetsSpider

    items: list[dict] = []

    class Collect:
        def process_item(self, item, spider=None):
            items.append(dict(item))
            return item

    process = CrawlerProcess(settings={"ITEM_PIPELINES": {Collect: 100}, **MetsSpider.custom_settings})
    process.crawl(MetsSpider, site=site, keywords=keywords, max_pages=max_pages, details="1" if details else "0")
    process.start()
    return items


def convert(it: dict) -> Opportunity:
    site = it["site"]
    jur = Jurisdiction(it["jurisdiction"])
    buyer = it.get("buyer") or ""
    hint = (it.get("icon_hint") or "").lower()
    if jur == Jurisdiction.US:
        tier = Tier.FEDERAL if "federal" in hint else (Tier.STATE if "statewide" in it.get("url", "") or "state" in hint else Tier.MUNICIPAL)
    else:
        tier = tier_for(buyer) if buyer else (Tier.FEDERAL if "canadian public" in hint and not buyer else Tier.OTHER)
        if tier == Tier.OTHER and "private" in hint:
            tier = Tier.OTHER
    loc = it.get("location") or ""
    region = loc
    if jur == Jurisdiction.US:
        m = US_STATE_RE.search(loc) or US_STATE_RE.search(it.get("url", "").replace("-", " "))
        region = m.group(1) if m else loc
    return Opportunity(
        source=site, source_id=str(it["source_id"]), title=it.get("title") or "", url=it["url"],
        jurisdiction=jur, tier=tier, buyer=buyer, region=region,
        posted=norm_date(it.get("posted")), deadline=norm_date(it.get("deadline")),
        notice_type=it.get("notice_type") or "", description=it.get("description") or "",
        unspsc=[c for c in it.get("categories") or [] if re.match(r"^\d{4,8}$", c)],
        category_hint=" ".join(it.get("categories") or []),
        estimated_value=parse_money(it.get("estimated_value")), currency="CAD" if jur == Jurisdiction.CA else "USD",
        attachments=it.get("attachments") or [],
        raw={k: v for k, v in it.items() if k in ("reference", "solicitation_number", "agreements", "purchase_type",
                                                  "icon_hint", "source_portal")},
    )


class Merx(Source):
    name = "merx"
    covers = "Canada: MERX -- federal mirror, provinces (MB, NS, NB, PEI, NL...), hundreds of municipalities, private"
    kind = "scrapy"

    def fetch(self, days: int = 30, limit: int | None = None, keywords: str = "", max_pages: int = 20,
              details: bool = True, **kw) -> Iterator[Opportunity]:
        return take((convert(i) for i in run_spider("merx", keywords, max_pages, details)), limit)


class BidNet(Source):
    name = "bidnet"
    covers = "US: BidNet Direct -- 1,300+ state, county, city, school and special-district agencies"
    kind = "scrapy"

    def fetch(self, days: int = 30, limit: int | None = None, keywords: str = "", max_pages: int = 20,
              details: bool = True, **kw) -> Iterator[Opportunity]:
        return take((convert(i) for i in run_spider("bidnet", keywords, max_pages, details)), limit)
