"""One spider, two portals. MERX (Canada: federal mirror + provincial + municipal + private)
and BidNet Direct (US: 1,300+ state and local agencies) run the same "mets" platform, so
the listing markup is identical -- `table.simpleSolResultsTable tr` rows with
`a.solicitation-link`, `.rowTitle`, `.buyer-name`, `.location`, `.publicationDate .dateValue`,
`.closingDate .dateValue`, and the numeric id in `.accessibility-hidden`.

Public detail pages differ: MERX exposes description, categories, agreement types and the
document list anonymously; BidNet locks description/issuer behind a free supplier account
(set BIDNET_COOKIE to a logged-in session cookie string to read them).

Politeness: the platform asks nothing in robots.txt for /public/solicitations; we still
use ROBOTSTXT_OBEY, AUTOTHROTTLE, one concurrent request per domain and a 1.5 s delay."""
from __future__ import annotations

import os
import re
from urllib.parse import urlencode

import scrapy

SITES = {
    "merx": {"base": "https://www.merx.com", "jurisdiction": "CA"},
    "bidnet": {"base": "https://www.bidnetdirect.com", "jurisdiction": "US"},
}

FIELD_LABELS = {
    "Reference Number": "reference", "Issuing Organization": "buyer", "Solicitation Type": "notice_type",
    "Solicitation Number": "solicitation_number", "Location": "location", "Description": "description",
    "Publication": "posted", "Publication Date": "posted", "Closing Date": "deadline",
    "Agreement Types": "agreements", "Purchase Type": "purchase_type", "Category": "category",
    "Categories": "category", "Source": "source_portal", "Estimated Value": "estimated_value",
}


class MetsSpider(scrapy.Spider):
    name = "mets"
    custom_settings = {
        "ROBOTSTXT_OBEY": True, "DOWNLOAD_DELAY": 1.5, "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "AUTOTHROTTLE_ENABLED": True, "AUTOTHROTTLE_TARGET_CONCURRENCY": 1.0,
        "USER_AGENT": os.environ.get("RFP_USER_AGENT", "rfp-arbitrage/0.1 (+public procurement indexer)"),
        "HTTPCACHE_ENABLED": True, "HTTPCACHE_EXPIRATION_SECS": 6 * 3600,
        "HTTPCACHE_DIR": os.path.join(os.environ.get("RFP_CACHE", ".rfp_cache"), "scrapy"),
        "LOG_LEVEL": os.environ.get("RFP_SCRAPY_LOG", "WARNING"), "RETRY_TIMES": 3,
    }

    def __init__(self, site: str = "merx", keywords: str = "", max_pages: int = 20, details: str = "1", **kw):
        super().__init__(**kw)
        if site not in SITES:
            raise ValueError(f"site must be one of {list(SITES)}")
        self.site = site
        self.base = SITES[site]["base"]
        self.jurisdiction = SITES[site]["jurisdiction"]
        self.keywords = keywords
        self.max_pages = int(max_pages)
        self.details = str(details) not in ("0", "false", "no")
        cookie = os.environ.get("BIDNET_COOKIE" if site == "bidnet" else "MERX_COOKIE", "")
        self.cookie_header = {"Cookie": cookie} if cookie else {}

    async def start(self):          # Scrapy >= 2.13 entry point
        for r in self.start_requests():
            yield r

    def start_requests(self):        # Scrapy < 2.13
        q = {"pageNumber": 1}
        if self.keywords:
            q["keywords"] = self.keywords
        yield scrapy.Request(f"{self.base}/public/solicitations/open?{urlencode(q)}", callback=self.parse_list,
                             headers=self.cookie_header, cb_kwargs={"page": 1})

    def parse_list(self, response, page: int):
        rows = response.css("table.simpleSolResultsTable tr")
        n = 0
        for tr in rows:
            a = tr.css("a.solicitation-link")
            if not a:
                continue
            n += 1
            href = a.attrib.get("href", "")
            sid = (tr.css(".accessibility-hidden::text").get() or "").strip() or re.sub(r"\D", "", href.split("?")[0].rsplit("/", 1)[-1])
            item = {
                "site": self.site, "jurisdiction": self.jurisdiction, "source_id": sid,
                "url": response.urljoin(href.split("?")[0]),
                "title": " ".join(t.strip() for t in tr.css(".rowTitle::text").getall()).strip(),
                "buyer": (tr.css(".buyer-name::text").get() or "").strip(),
                "location": " ".join(t.strip() for t in tr.css(".location::text").getall()).strip(),
                "posted": (tr.css(".publicationDate .dateValue::text").get() or "").strip(),
                "deadline": (tr.css(".closingDate .dateValue::text").get() or "").strip(),
                "icon_hint": (tr.css(".simpleSolResultsItemIcon svg::attr(data-mets-tooltip)").get() or ""),
            }
            if self.details and href:
                yield scrapy.Request(item["url"] + "?origin=0", callback=self.parse_detail, headers=self.cookie_header,
                                     cb_kwargs={"item": item}, dont_filter=False)
            else:
                yield item
        if n and page < self.max_pages:
            q = {"pageNumber": page + 1}
            if self.keywords:
                q["keywords"] = self.keywords
            yield scrapy.Request(f"{self.base}/public/solicitations/open?{urlencode(q)}", callback=self.parse_list,
                                 headers=self.cookie_header, cb_kwargs={"page": page + 1})

    def parse_detail(self, response, item: dict):
        for lab in response.css(".mets-field-label"):
            key = " ".join(lab.css("::text").getall()).strip().rstrip(":")
            role = FIELD_LABELS.get(key)
            if not role:
                continue
            val = lab.xpath("following-sibling::*[1]")
            text = " ".join(t.strip() for t in val.css("::text").getall() if t.strip())
            if "Registered members only" in text:
                continue
            item.setdefault(role, text[:20000])
        desc = response.css("#descriptionText")
        if desc:
            item["description"] = " ".join(t.strip() for t in desc.css("::text").getall() if t.strip())[:60000]
        item["categories"] = [t.strip() for t in response.css("#categoriesAbstractTab ::text, .categories-list ::text").getall()
                              if re.match(r"^[A-Z0-9]{2,}", t.strip())][:20]
        item["attachments"] = sorted({response.urljoin(h) for h in response.css("a::attr(href)").getall()
                                      if re.search(r"/documents?/|download|attachment|\.pdf|\.docx?$", h, re.I)})[:50]
        yield item
