"""Gemini API client wrapper with retry logic and rate limiting.

Implements the LLMClient interface for Google Gemini models.
"""

import re
import time
import logging
from pathlib import Path
from typing import Optional

import google.generativeai as genai
from dotenv import load_dotenv
import os

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

# Retry only on transient conditions; a 4xx rejection will not heal with a retry.
_RETRYABLE_STATUSES = frozenset({408, 409, 429})

# Global rate limiter instance: 2 calls per 60 seconds unless overridden.
_rate_limiter = RateLimiter(
    max_calls=configured_max_calls_per_minute(2), period=60.0
)


def _http_status(error: Exception) -> Optional[int]:
    """Best-effort HTTP status from a google-api-core exception."""
    code = getattr(error, "code", None)
    return code if isinstance(code, int) else None


class GeminiClient(LLMClient):
    """Google Gemini API client with retry logic, implementing the LLMClient interface."""

    def __init__(self, api_key: Optional[str] = None, model_name: str = "gemini-2.5-flash"):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "GEMINI_API_KEY not found. Set it in backend/.env or pass it directly."
            )
        genai.configure(api_key=self.api_key)
        self._model_name = model_name
        self.model = genai.GenerativeModel(model_name)
        logger.info(f"Gemini client initialized with model: {model_name}")

    # -- LLMClient interface --------------------------------------------------

    @property
    def provider_name(self) -> str:
        return "gemini"

    @property
    def model_name(self) -> str:
        return self._model_name

    def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """Generate text from a prompt with retry logic."""
        model = self.model
        if system_instruction:
            model = genai.GenerativeModel(
                self._model_name,
                system_instruction=system_instruction,
            )

        last_error = None
        for attempt in range(max_retries):
            try:
                # Enforce global rate limit before the actual call
                _rate_limiter.wait_if_needed()
                
                response = model.generate_content(prompt)
                if not response.candidates:
                    raise ValueError("Gemini returned no candidates (possibly blocked by safety filters)")
                return response.text
            except ProviderBusy:
                # Waiting longer would exceed the caller's budget; answer immediately.
                raise
            except Exception as e:
                last_error = e
                error_str = str(e)

                if re.search(
                    r"API_KEY_INVALID|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED",
                    error_str,
                    re.IGNORECASE,
                ):
                    raise LLMResponseError("Gemini rejected the configured API key.") from e

                status = _http_status(e)
                if (
                    status is not None
                    and 400 <= status < 500
                    and status not in _RETRYABLE_STATUSES
                ):
                    raise LLMResponseError(
                        f"Gemini rejected the request (HTTP {status}). {error_str[:200]}"
                    ) from e

                if attempt == max_retries - 1:
                    break
                
                # Default backoff: 5s, 10s, 20s, 40s, 80s
                wait_time = (2 ** attempt) * 5.0
                
                # Check if API specifically tells us how long to wait
                match = re.search(r"Please retry in (\d+(?:\.\d+)?)s", error_str)
                if match:
                    wait_time = float(match.group(1)) + 2.0  # Add a 2s buffer
                
                logger.warning(
                    f"Gemini API attempt {attempt + 1}/{max_retries} failed. "
                    f"Retrying in {wait_time:.1f}s... Error snippet: {error_str[:100]}"
                )
                time.sleep(wait_time)

        raise LLMResponseError(
            f"Gemini API failed after {max_retries} attempts. Last error: {last_error}"
        )
