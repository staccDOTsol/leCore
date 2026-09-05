"""Source registry. Every fetcher yields normalized Opportunity records."""
from __future__ import annotations

from typing import Type

from .base import Source


def _lazy() -> dict[str, Type[Source]]:
    from .sam_gov import SamGov
    from .canadabuys import CanadaBuys
    from .seao import SeaoQuebec
    from .socrata import Socrata
    from .mets import Merx, BidNet
    return {c.name: c for c in (SamGov, CanadaBuys, SeaoQuebec, Socrata, Merx, BidNet)}


def sources() -> dict[str, Type[Source]]:
    return _lazy()


DEFAULT_ORDER = ["sam_gov", "canadabuys", "seao_quebec", "socrata", "merx", "bidnet"]
