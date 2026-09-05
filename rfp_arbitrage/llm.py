"""One small client, two back ends, one job: return a JSON object that matches a schema.

  provider "openzoo"   (default) -- the local openzoo proxy or any OpenAI-compatible
                        /v1/chat/completions. Same env vars as the rest of leCore:
                        LECORE_LLM_URL (default http://localhost:8402/v1), LECORE_LLM_MODEL,
                        LECORE_LLM_KEY (OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY also read).
  provider "anthropic" -- the official SDK against the Claude API (ANTHROPIC_API_KEY), with
                        structured outputs (output_config.format) and adaptive thinking.

Select with RFP_LLM_PROVIDER. Deterministic by default (temperature 0) because verdicts
get stored and compared across runs."""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any


class LLMError(RuntimeError):
    pass


# USD per million tokens (input, output) -- first-party list prices; gateways may mark up
PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0), "claude-fable-5": (10.0, 50.0), "claude-opus-5": (5.0, 25.0), "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0), "claude-opus-4-6": (5.0, 25.0), "claude-sonnet-5": (2.0, 10.0), "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def price_of(model: str) -> tuple[float, float]:
    m = model.split("/")[-1]
    for k, v in PRICES.items():
        if m.startswith(k):
            return v
    return (5.0, 25.0)   # assume frontier when unknown: the cap errs on the safe side


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    a, b = text.find("{"), text.rfind("}")
    if a != -1 and b > a:
        return json.loads(text[a:b + 1])
    raise LLMError(f"no JSON object in model output: {text[:200]!r}")


class LLM:
    def __init__(self, provider: str | None = None, model: str | None = None, url: str | None = None,
                 api_key: str | None = None, timeout: float = 300.0, effort: str | None = None,
                 fallbacks: bool | None = None):
        self.provider = (provider or os.environ.get("RFP_LLM_PROVIDER") or "openzoo").lower()
        self.timeout = timeout
        self.effort = effort or os.environ.get("RFP_LLM_EFFORT", "medium")
        self.fallbacks = (os.environ.get("RFP_LLM_FALLBACKS", "1") != "0") if fallbacks is None else fallbacks
        if self.provider == "anthropic":
            self.model = model or os.environ.get("RFP_LLM_MODEL") or "claude-opus-5"
            self.url = None
            self.api_key = api_key
        else:
            self.url = (url or os.environ.get("LECORE_LLM_URL") or os.environ.get("OPENAI_BASE_URL")
                        or "http://localhost:8402/v1").rstrip("/") + "/chat/completions"
            self.model = (model or os.environ.get("RFP_LLM_MODEL") or os.environ.get("LECORE_LLM_MODEL")
                          or os.environ.get("OPENAI_MODEL") or "claude-opus-5")
            self.api_key = api_key or os.environ.get("LECORE_LLM_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        # extra headers for gateways that authenticate by session/namespace rather than a bearer
        # (openzoo.fun: x-openzoo-session minted by /v1/auth/session for a funded tenant)
        try:
            self.extra_headers: dict[str, str] = json.loads(os.environ.get("LECORE_LLM_HEADERS") or "{}")
        except json.JSONDecodeError:
            self.extra_headers = {}
        if os.environ.get("OPENZOO_SESSION"):
            self.extra_headers.setdefault("x-openzoo-session", os.environ["OPENZOO_SESSION"])
        self.calls = 0
        self.usage: dict[str, int] = {"input": 0, "output": 0}
        self.budget_usd: float | None = float(os.environ["RFP_LLM_BUDGET_USD"]) if os.environ.get("RFP_LLM_BUDGET_USD") else None

    @property
    def spent_usd(self) -> float:
        i, o = price_of(self.model)
        return self.usage["input"] / 1e6 * i + self.usage["output"] / 1e6 * o

    def over_budget(self) -> bool:
        return self.budget_usd is not None and self.spent_usd >= self.budget_usd

    @property
    def name(self) -> str:
        return f"{self.provider}:{self.model}"

    # -- public --------------------------------------------------------------------
    def json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int = 4000) -> dict[str, Any]:
        if self.over_budget():
            raise LLMError(f"LLM budget exhausted: ${self.spent_usd:.2f} of ${self.budget_usd:.2f} (RFP_LLM_BUDGET_USD)")
        self.calls += 1
        if self.provider == "anthropic":
            return self._anthropic_json(system, user, schema, max_tokens)
        return self._openai_json(system, user, schema, max_tokens)

    def available(self) -> str | None:
        """None when the back end answers, else a one-line reason."""
        try:
            if self.provider == "anthropic":
                import anthropic  # noqa: F401
                if not (self.api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
                    return "ANTHROPIC_API_KEY not set (or use `ant auth login`)"
                return None
            req = urllib.request.Request(self.url.rsplit("/chat/completions", 1)[0] + "/models")
            if self.api_key:
                req.add_header("Authorization", "Bearer " + self.api_key)
            for k, v in self.extra_headers.items():
                req.add_header(k, v)
            with urllib.request.urlopen(req, timeout=8):
                pass
            # /models is public on paid gateways; prove the chat door actually opens for us
            probe = {"model": self.model, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 1}
            try:
                self._post(probe)
            except LLMError as e:
                if "402" in str(e):
                    return f"{self.url} answers 402: this gateway wants payment (x402) or a funded session (OPENZOO_SESSION / LECORE_LLM_HEADERS)"
                if "401" in str(e) or "403" in str(e):
                    return f"{self.url} rejects our credentials ({str(e)[:80]})"
                raise
            return None
        except Exception as e:  # noqa: BLE001
            return f"{self.provider} at {self.url or 'api.anthropic.com'} unreachable: {type(e).__name__}: {e}"

    # -- openzoo / OpenAI-compatible -----------------------------------------------
    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(self.url, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        if self.api_key:
            req.add_header("Authorization", "Bearer " + self.api_key)
        for k, v in self.extra_headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:400]
            except Exception:  # noqa: BLE001
                pass
            raise LLMError(f"{self.url} -> HTTP {e.code} {detail}") from None
        except Exception as e:  # noqa: BLE001
            raise LLMError(f"could not reach {self.url}: {type(e).__name__}: {e}") from None

    def _openai_json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int) -> dict[str, Any]:
        sys_msg = system + "\n\nRespond with ONE JSON object and nothing else. It must validate against this JSON Schema:\n" + json.dumps(schema)
        body: dict[str, Any] = {"model": self.model, "temperature": 0,
                                "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}],
                                "max_tokens": max_tokens,
                                "response_format": {"type": "json_object"}}
        try:
            data = self._post(body)
        except LLMError as e:
            if "400" not in str(e):
                raise
            body.pop("response_format", None)      # proxy/model without JSON mode
            data = self._post(body)
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise LLMError(f"unexpected response shape: {list(data) if isinstance(data, dict) else type(data)}") from None
        u = data.get("usage") or {}
        self.usage["input"] += int(u.get("prompt_tokens") or 0)
        self.usage["output"] += int(u.get("completion_tokens") or 0)
        if isinstance(text, list):   # some proxies return content blocks
            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
        return _extract_json(text)

    # -- Anthropic SDK ---------------------------------------------------------------
    def _anthropic_json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int) -> dict[str, Any]:
        import anthropic

        client = anthropic.Anthropic(api_key=self.api_key) if self.api_key else anthropic.Anthropic()
        kwargs: dict[str, Any] = dict(
            model=self.model, max_tokens=max(max_tokens, 4000), system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
        )
        try:
            if self.fallbacks:
                # server-side refusal fallback ("default" routes by refusal category)
                resp = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
            else:
                resp = client.messages.create(**kwargs)
        except anthropic.BadRequestError as e:
            if self.fallbacks and "fallback" in str(e).lower():
                resp = client.messages.create(**kwargs)
            else:
                raise LLMError(f"anthropic bad request: {e.message}") from None
        except anthropic.AuthenticationError:
            raise LLMError("anthropic: invalid or missing API key") from None
        except anthropic.RateLimitError as e:
            raise LLMError(f"anthropic: rate limited ({e.response.headers.get('retry-after', '?')}s)") from None
        except anthropic.APIStatusError as e:
            raise LLMError(f"anthropic: HTTP {e.status_code} {e.message}") from None
        except anthropic.APIConnectionError as e:
            raise LLMError(f"anthropic: connection error {e}") from None
        if resp.stop_reason == "refusal":
            cat = getattr(getattr(resp, "stop_details", None), "category", None)
            raise LLMError(f"anthropic: model declined (category={cat})")
        self.usage["input"] += int(getattr(resp.usage, "input_tokens", 0) or 0)
        self.usage["output"] += int(getattr(resp.usage, "output_tokens", 0) or 0)
        text = next((b.text for b in resp.content if b.type == "text"), "")
        return _extract_json(text)


def make_llm(**kw) -> LLM:
    return LLM(**kw)
