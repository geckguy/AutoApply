"""Abstract LLM client interface and provider factory.

Supports multiple AI backends (Gemini, OpenRouter) behind a unified interface.
Consumer services import `get_llm_client()` and never worry about the provider.
"""

import json
import re
import os
import time
import logging
import threading
import collections
from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Union

from dotenv import load_dotenv

if TYPE_CHECKING:
    from backend.models.profile import UserProfile

logger = logging.getLogger(__name__)

# Load env from backend directory
_backend_dir = Path(__file__).parent.parent
load_dotenv(_backend_dir / ".env")

DEFAULT_PROVIDER = "gemini"
SUPPORTED_PROVIDERS = frozenset({"gemini", "openrouter", "opencode"})

# Prompt budget shared by every service that interpolates the knowledge file.
MAX_KNOWLEDGE_CHARS = 4000

# A provider call is never allowed to block a request handler longer than this;
# callers abort at 30s (extension) and would otherwise wait on a dead response.
MAX_PROVIDER_WAIT_SECONDS = 20.0


class ProviderNotConfigured(ValueError):
    """The AI provider is selected but required configuration is missing."""


class ProviderBusy(RuntimeError):
    """The AI provider cannot serve the request right now (rate limited)."""


class LLMResponseError(RuntimeError):
    """The provider returned a payload the caller cannot use."""


def configured_max_calls_per_minute(default: int) -> int:
    """Read LLM_MAX_CALLS_PER_MINUTE, falling back to the provider default."""
    raw = os.getenv("LLM_MAX_CALLS_PER_MINUTE", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return default


class RateLimiter:
    """Pace provider calls; raise ProviderBusy instead of blocking past the budget."""

    def __init__(
        self,
        max_calls: int = 2,
        period: float = 60.0,
        max_wait: float = MAX_PROVIDER_WAIT_SECONDS,
    ):
        self.max_calls = max_calls
        self.period = period
        self.max_wait = max_wait
        self.calls: collections.deque = collections.deque()
        self.lock = threading.Lock()

    def wait_if_needed(self) -> None:
        while True:
            with self.lock:
                now = time.time()
                while self.calls and now - self.calls[0] > self.period:
                    self.calls.popleft()
                if len(self.calls) >= self.max_calls:
                    sleep_time = self.period - (now - self.calls[0]) + 0.1
                else:
                    self.calls.append(now)
                    return
            if sleep_time > self.max_wait:
                raise ProviderBusy(
                    f"AutoApply is busy right now. Try again in {sleep_time:.0f} seconds."
                )
            logger.info(f"Rate limit: waiting {sleep_time:.1f}s...")
            time.sleep(sleep_time)


_PROVIDER_SETTINGS = {
    "gemini": {
        "api_key_env": "GEMINI_API_KEY",
        "default_model": "gemini-2.5-flash",
        "model_env": None,
    },
    "openrouter": {
        "api_key_env": "OPENROUTER_API_KEY",
        "default_model": None,
        "model_env": "OPENROUTER_MODEL",
    },
    "opencode": {
        "api_key_env": "OPENCODE_API_KEY",
        "default_model": None,
        "model_env": "OPENCODE_MODEL",
    },
}


# Names and sentences that can reach the UI. A user-visible sentence never names
# an env var, a port, or an HTTP status code; the technical wording travels in
# the separate `error_detail` key, which only logs consume.
_PROVIDER_DISPLAY_NAMES = {
    "gemini": "Google Gemini",
    "openrouter": "OpenRouter",
    "opencode": "OpenCode Go",
}


def provider_display_name(provider: str) -> str:
    """Return the name of an AI service as the user sees it."""
    return _PROVIDER_DISPLAY_NAMES.get(provider, "the AI service")


def _is_placeholder(value: str) -> bool:
    """Return whether an API-key value is an example/template placeholder."""
    normalized = value.strip().lower()
    return (
        not normalized
        or normalized.startswith("your_")
        or normalized.startswith("<your_")
        or normalized in {"changeme", "replace_me", "replace-with-your-key"}
    )


def provider_settings(provider: str) -> dict[str, str | None]:
    """Return the env-var names and default model for a provider."""
    return dict(_PROVIDER_SETTINGS.get(provider, {}))


def stored_key_state(provider: str) -> tuple[bool, str | None]:
    """Return (usable key stored, masked hint) for a provider.

    The hint is the key's last four characters behind six dots; the stored key
    itself is never returned by any endpoint.
    """
    settings = _PROVIDER_SETTINGS.get(provider)
    value = os.getenv(settings["api_key_env"], "").strip() if settings else ""
    if _is_placeholder(value):
        return False, None
    return True, f"••••••{value[-4:]}"


def inspect_provider_configuration() -> dict[str, str | bool | None]:
    """Inspect LLM setup without creating a client or making a network request.

    This is safe to call from a health endpoint. It intentionally returns only
    public configuration state: API keys are never included in the response.

    `error` is the sentence the user reads; `error_detail` is the technical
    wording for logs only. Both are None when the provider is configured.
    """
    provider = os.getenv("AI_PROVIDER", DEFAULT_PROVIDER).strip().lower() or DEFAULT_PROVIDER
    if provider not in SUPPORTED_PROVIDERS:
        supported = ", ".join(sorted(SUPPORTED_PROVIDERS))
        return {
            "provider": provider,
            "model": None,
            "configured": False,
            "error": "AutoApply doesn't recognize this AI service. Choose one from the list.",
            "error_detail": f"Unsupported AI_PROVIDER '{provider}'. Use one of: {supported}.",
        }

    settings = _PROVIDER_SETTINGS[provider]
    api_key_env = settings["api_key_env"]
    api_key = os.getenv(api_key_env, "")
    model_env = settings["model_env"]
    model = (
        os.getenv(model_env, "").strip()
        if model_env
        else settings["default_model"]
    ) or settings["default_model"]
    display_name = provider_display_name(provider)

    if _is_placeholder(api_key):
        return {
            "provider": provider,
            "model": model,
            "configured": False,
            "error": f"Add your {display_name} key to finish setup.",
            "error_detail": f"Set a valid {api_key_env} in backend/.env for {provider}.",
        }

    if not model:
        return {
            "provider": provider,
            "model": None,
            "configured": False,
            "error": "Choose which AI model to use in AutoApply.",
            "error_detail": f"Set {model_env} explicitly in backend/.env.",
        }

    if provider == "openrouter":
        privacy_mode = os.getenv("OPENROUTER_PRIVACY_MODE", "strict").strip().lower()
        if privacy_mode not in {"strict", "allow"}:
            return {
                "provider": provider,
                "model": model,
                "configured": False,
                "error": "The saved AI service settings are incomplete. Finish setup again.",
                "error_detail": "OPENROUTER_PRIVACY_MODE must be 'strict' or 'allow'.",
            }
        if privacy_mode == "strict" and str(model).endswith(":free"):
            return {
                "provider": provider,
                "model": model,
                "configured": False,
                "error": (
                    "This free AI model may keep copies of your details. "
                    "Choose a paid model instead."
                ),
                "error_detail": (
                    "OpenRouter free endpoints may retain personal data. Choose a "
                    "privacy-compatible paid model, or explicitly set "
                    "OPENROUTER_PRIVACY_MODE=allow after reviewing provider terms."
                ),
            }

    return {
        "provider": provider,
        "model": model,
        "configured": True,
        "error": None,
        "error_detail": None,
    }


# Never serialize these to a provider: the local mapper refuses to fill
# demographics, so the values must not leave the machine either.
_PROMPT_EXCLUDED_PROFILE_FIELDS = {
    "personal": {"date_of_birth", "nationality"},
    "legal": True,
}


def profile_prompt_json(profile: "UserProfile") -> str:
    """Serialize a profile for an LLM prompt without its sensitive subset.

    `personal.date_of_birth`, `personal.nationality` and every `legal` value are
    dropped; callers interpolate the returned JSON verbatim.
    """
    return profile.model_dump_json(
        indent=2,
        exclude_none=True,
        exclude=_PROMPT_EXCLUDED_PROFILE_FIELDS,
    )


def provider_status_line() -> str:
    """One-line AI provider readiness summary for startup logging."""
    configuration = inspect_provider_configuration()
    if configuration["configured"]:
        return f"AI provider ready: {configuration['provider']} ({configuration['model']})"
    return (
        f"AI provider unavailable: {configuration['error_detail']} "
        "AI-assisted features will fail until this is fixed."
    )


class LLMClient(ABC):
    """Abstract base class for LLM provider clients.

    Every provider must implement `generate()`. The `generate_json()` method
    is provided for free via the shared `_extract_json()` helper.
    """

    @abstractmethod
    def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """Generate text from a prompt with retry logic."""
        ...

    def generate_json(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> Union[dict, list]:
        """Generate a response and parse it as JSON."""
        raw = self.generate(prompt, system_instruction, max_retries)
        return self._extract_json(raw)

    @staticmethod
    def _extract_json(text: str) -> Union[dict, list]:
        """Extract JSON from a response that may be wrapped in markdown code blocks."""
        text_stripped = text.strip()
        try:
            return json.loads(text_stripped)
        except json.JSONDecodeError:
            pass

        json_block_match = re.search(
            r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL
        )
        if json_block_match:
            try:
                return json.loads(json_block_match.group(1).strip())
            except json.JSONDecodeError:
                pass

        for start_char, end_char in [("{", "}"), ("[", "]")]:
            start_idx = text.find(start_char)
            if start_idx != -1:
                end_idx = text.rfind(end_char)
                if end_idx > start_idx:
                    try:
                        return json.loads(text[start_idx : end_idx + 1])
                    except json.JSONDecodeError:
                        pass

        raise ValueError(
            f"Could not extract valid JSON from LLM response. Raw text:\n{text[:500]}"
        )

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Human-readable provider name for health checks / logging."""
        ...

    @property
    @abstractmethod
    def model_name(self) -> str:
        """The model identifier string."""
        ...

    def close(self) -> None:
        """Release provider resources. Most SDK clients do not require this."""


# ---------------------------------------------------------------------------
# Singleton factory
# ---------------------------------------------------------------------------

_client: Optional[LLMClient] = None
_client_lock = threading.Lock()


def get_llm_client() -> LLMClient:
    """Get or create the singleton LLM client based on AI_PROVIDER env var.

    Supported values for AI_PROVIDER:
        - "gemini"     (default) — uses Google Gemini via google-generativeai SDK
        - "openrouter" — uses OpenRouter API (OpenAI-compatible)
        - "opencode"   — uses the OpenCode Go gateway (OpenAI-compatible)
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:  # double-check
                configuration = inspect_provider_configuration()
                if not configuration["configured"]:
                    raise ProviderNotConfigured(str(configuration["error"]))

                provider = str(configuration["provider"])
                if provider == "openrouter":
                    from backend.services.openrouter import OpenRouterClient
                    _client = OpenRouterClient()
                elif provider == "opencode":
                    from backend.services.opencode import OpenCodeGoClient
                    _client = OpenCodeGoClient()
                elif provider == "gemini":
                    from backend.services.gemini import GeminiClient
                    _client = GeminiClient()
                else:  # Defensive guard: inspect_provider_configuration validates this.
                    raise ProviderNotConfigured(
                        "AutoApply doesn't recognize this AI service. Choose one from the list."
                    )
                logger.info(
                    f"LLM client initialized: provider={_client.provider_name}, "
                    f"model={_client.model_name}"
                )
    return _client


def close_llm_client() -> None:
    """Close and clear the provider singleton if it was initialized."""
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
            _client = None
