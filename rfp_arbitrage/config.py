"""Environment-driven configuration. Nothing here is required to import the package;
each stage checks the keys it needs and fails with a one-line explanation."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


@dataclass
class Settings:
    db_path: Path = field(default_factory=lambda: Path(_env("RFP_DB", "rfp_arbitrage.sqlite3")))
    cache_dir: Path = field(default_factory=lambda: Path(_env("RFP_CACHE", ".rfp_cache")))
    user_agent: str = field(default_factory=lambda: _env(
        "RFP_USER_AGENT",
        "rfp-arbitrage/0.1 (+public procurement indexer; contact via repository)"))
    request_delay: float = field(default_factory=lambda: float(_env("RFP_DELAY", "1.0")))
    # US federal
    sam_api_key: str | None = field(default_factory=lambda: _env("SAM_API_KEY"))
    # LLM
    anthropic_model: str = field(default_factory=lambda: _env("RFP_LLM_MODEL", "claude-opus-5"))
    llm_effort: str = field(default_factory=lambda: _env("RFP_LLM_EFFORT", "medium"))
    llm_fallbacks: bool = field(default_factory=lambda: _env("RFP_LLM_FALLBACKS", "1") != "0")
    # Upwork official API (OAuth2). https://www.upwork.com/developer/keys/apply
    upwork_client_id: str | None = field(default_factory=lambda: _env("UPWORK_CLIENT_ID"))
    upwork_client_secret: str | None = field(default_factory=lambda: _env("UPWORK_CLIENT_SECRET"))
    upwork_refresh_token: str | None = field(default_factory=lambda: _env("UPWORK_REFRESH_TOKEN"))
    upwork_access_token: str | None = field(default_factory=lambda: _env("UPWORK_ACCESS_TOKEN"))
    upwork_redirect_uri: str = field(default_factory=lambda: _env("UPWORK_REDIRECT_URI", "http://localhost:8765/callback"))
    # Economics
    overhead_rate: float = field(default_factory=lambda: float(_env("RFP_OVERHEAD", "0.25")))
    min_margin: float = field(default_factory=lambda: float(_env("RFP_MIN_MARGIN", "0.35")))

    def ensure_dirs(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)


def settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s
