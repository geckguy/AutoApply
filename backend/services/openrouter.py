"""OpenRouter API client — OpenAI-compatible interface for models like NVIDIA Nemotron.

Uses httpx to call https://openrouter.ai/api/v1/chat/completions with the
standard chat-completions format (system + user messages).
"""

import os
import time
import logging
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

from backend.services.llm_client import (
    LLMClient,
    LLMResponseError,
    ProviderBusy,
    RateLimiter,
    configured_max_calls_per_minute,
)

logger = logging.getLogger(__name__)

# Load env from backend directory
_backend_dir = Path(__file__).parent.parent
load_dotenv(_backend_dir / ".env")

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# One attempt must finish inside the caller's own timeout budget.
REQUEST_TIMEOUT_SECONDS = 30.0

# Retry only on rate limiting and transient server errors.
_RETRYABLE_STATUSES = frozenset({429})

# Global rate limiter: 5 calls per 60 seconds unless overridden.
_rate_limiter = RateLimiter(
    max_calls=configured_max_calls_per_minute(5), period=60.0
)


def _error_detail(response) -> str:
    """Best-effort extraction of the gateway's own error message."""
    if response is None:
        return ""
    try:
        body = response.json()
    except Exception:
        try:
            return (response.text or "").strip()[:300]
        except Exception:
            return ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("type") or "").strip()[:300]
        if error:
            return str(error)[:300]
        if body.get("message"):
            return str(body["message"])[:300]
    return ""


class OpenRouterClient(LLMClient):
    """Chat-completions client for an OpenAI-compatible gateway.

    OpenRouter is the built-in configuration; subclasses change `label`, `api_url`,
    the environment variables and the rate limiter to target another gateway
    (`OpenCodeGoClient` does exactly that) without duplicating the retry,
    timeout and error-translation logic below.
    """

    label = "OpenRouter"
    provider_key = "openrouter"
    api_url = OPENROUTER_API_URL
    api_key_env = "OPENROUTER_API_KEY"
    model_env = "OPENROUTER_MODEL"
    base_url_env: Optional[str] = None
    privacy_mode_supported = True
    rate_limiter = _rate_limiter
    request_headers = {
        "HTTP-Referer": "https://github.com/geckguy/AutoApply",
        "X-Title": "AutoApply",
    }

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.api_key = api_key or os.getenv(self.api_key_env)
        if not self.api_key:
            raise ValueError(
                f"{self.api_key_env} not found. Set it in backend/.env or pass it directly."
            )
        self._model = model or os.getenv(self.model_env)
        if not self._model:
            raise ValueError(f"{self.model_env} must be set explicitly in backend/.env.")
        self._endpoint = (
            base_url
            or (os.getenv(self.base_url_env) if self.base_url_env else None)
            or self.api_url
        ).strip()
        self._privacy_mode = (
            os.getenv("OPENROUTER_PRIVACY_MODE", "strict").strip().lower()
            if self.privacy_mode_supported
            else "allow"
        )
        self._http = httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS)
        logger.info(f"{self.label} client initialized with model: {self._model}")

    # -- LLMClient interface --------------------------------------------------

    @property
    def provider_name(self) -> str:
        return self.provider_key

    @property
    def model_name(self) -> str:
        return self._model

    def close(self) -> None:
        self._http.close()

    def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """Generate text via the gateway's chat completions endpoint."""
        messages = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.request_headers,
        }

        payload = {
            "model": self._model,
            "messages": messages,
        }
        if self._privacy_mode == "strict":
            payload["provider"] = {"data_collection": "deny", "zdr": True}

        last_error = None
        for attempt in range(max_retries):
            try:
                self.rate_limiter.wait_if_needed()

                response = self._http.post(
                    self._endpoint,
                    headers=headers,
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()

                # Some gateways report failures inside a 200 OK body.
                if "error" in data:
                    error_msg = data["error"].get("message", str(data["error"]))
                    raise RuntimeError(f"{self.label} API error: {error_msg}")

                choices = data.get("choices", [])
                if not choices:
                    raise ValueError(f"{self.label} returned no choices in response")

                content = choices[0].get("message", {}).get("content", "")
                if not content:
                    raise ValueError(f"{self.label} returned empty content")

                return content

            except ProviderBusy:
                # Waiting longer would exceed the caller's budget; answer immediately.
                raise
            except Exception as e:
                last_error = e
                error_str = str(e)

                response = getattr(e, "response", None)
                status_code = getattr(response, "status_code", None)
                if (
                    isinstance(status_code, int)
                    and 400 <= status_code < 500
                    and status_code not in _RETRYABLE_STATUSES
                ):
                    raise LLMResponseError(
                        f"{self.label} rejected the request (HTTP {status_code}). "
                        f"{_error_detail(response) or 'Check the API key, model, and prompt size.'}"
                    ) from e

                if attempt == max_retries - 1:
                    break

                # Exponential backoff: 3s, 6s, 12s, 24s, 48s
                wait_time = (2 ** attempt) * 3.0

                # Check for rate-limit retry-after hints
                if response is not None:
                    retry_after = response.headers.get("retry-after")
                    if retry_after:
                        try:
                            wait_time = float(retry_after) + 1.0
                        except ValueError:
                            pass

                logger.warning(
                    f"{self.label} attempt {attempt + 1}/{max_retries} failed. "
                    f"Retrying in {wait_time:.1f}s... Error: {error_str[:150]}"
                )
                time.sleep(wait_time)

        raise LLMResponseError(
            f"{self.label} request failed after {max_retries} attempts. Last error: {last_error}"
        )
