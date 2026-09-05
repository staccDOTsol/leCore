"""rfp_arbitrage -- index public-sector RFPs (US + Canada, federal / state-provincial /
municipal), gate each one on the LEGAL question that decides whether service arbitrage
is possible (does the solicitation explicitly deny delegation to subcontractors or to AI
teams?), and intersect the survivors with provably-good, under-priced talent.

Pipeline (each stage is a CLI verb, see `python -m rfp_arbitrage --help`):

    crawl     -> sources/*      fetch opportunities into the SQLite store
    fetch     -> attachments    pull solicitation documents, extract text
    gate      -> clauses        LLM verdict: subcontracting / AI-use explicit non-denial
    price     -> pricing        benchmark stated budget vs. historical awards + labor cost
    talent    -> talent/*       load / search professionals + agencies, score "provably good"
    match     -> match          rank the intersection: overpriced ask x underpriced good labor
    report    -> report         markdown / JSON dossier for the top matches

Everything is stdlib + requests; scrapy, bs4/lxml, pdfminer, python-docx and the
anthropic SDK are imported lazily by the stages that need them.
"""
from .models import Opportunity, Talent, ClauseVerdict, Match, Jurisdiction, Tier  # noqa: F401

__version__ = "0.1.0"
