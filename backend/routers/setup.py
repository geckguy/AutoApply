"""Setup endpoints — connect one AI service without editing any file.

The dashboard wizard is the only caller: it picks a service, the user pastes one
key, and this router writes it into `backend/.env` with every other line and
comment kept. The key is then proven with one real request through the same
client the rest of the app uses; a rejected key is rolled back so a bad paste
can never break a configuration that already worked.
"""

import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.services.llm_client import (
    SUPPORTED_PROVIDERS,
    ProviderBusy,
    ProviderNotConfigured,
    close_llm_client,
    get_llm_client,
    inspect_provider_configuration,
    provider_display_name,
    provider_settings,
    stored_key_state,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/setup", tags=["setup"])

BACKEND_DIR = Path(__file__).parent.parent
ENV_PATH = BACKEND_DIR / ".env"
ENV_EXAMPLE_PATH = BACKEND_DIR / ".env.example"
DATA_DIR = BACKEND_DIR / "data"
ENV_FILE_MODE = 0o600

# The smallest real request that proves a key works through the same client the
# rest of the app uses.
_PROBE_PROMPT = "Reply with the single word: ready"

_SETTINGS_ERROR = "AutoApply couldn't save your settings. Start AutoApply again and try."
_KEY_REJECTED = "That key didn't work with {name}. Copy it again and paste it here."
_MODEL_REJECTED = "AutoApply couldn't use that model with {name}. Check the name and try again."

_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
_SAFE_ENV_VALUE = re.compile(r"^[A-Za-z0-9._:/+\-]+$")

# Failures that say nothing about the pasted settings: the write is kept and the
# user is told it could not be checked yet.
_TRANSIENT_PROBE_ERROR = re.compile(
    r"rate.?limit|quota|exhaust|deadline|timeout|timed out|temporar|unavailable"
    r"|overload|network|connection|reset by peer|getaddrinfo|\b(429|5\d\d)\b",
    re.IGNORECASE,
)
# A named model the service does not offer, as opposed to a rejected key.
_MODEL_PROBE_ERROR = re.compile(
    r"model.{0,20}(not found|does not exist|unsupported|invalid|unknown)"
    r"|(not found|does not exist|no such|unknown).{0,20}model",
    re.IGNORECASE,
)

# Everything the wizard shows about a service. `key_label`, `key_url` and `note`
# are user-visible, so they name no env var, port or status code.
_PROVIDER_CHOICES = {
    "gemini": {
        "key_label": "Gemini key",
        "key_url": "https://aistudio.google.com/apikey",
        "models": ["gemini-2.5-flash"],
        "note": "Free tier available.",
    },
    "openrouter": {
        "key_label": "OpenRouter key",
        "key_url": "https://openrouter.ai/keys",
        "models": ["nvidia/nemotron-3-super-120b-a12b"],
        "note": "Pay per use. Paid models keep your details private.",
    },
    "opencode": {
        "key_label": "OpenCode Go key",
        "key_url": "https://opencode.ai/auth",
        "models": ["deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3", "kimi-k2.7-code"],
        "note": "One subscription covers many models.",
    },
}


class ProviderSetupRequest(BaseModel):
    """One AI service choice from the dashboard wizard."""

    provider: str = Field(default="", max_length=40)
    api_key: str = Field(default="", max_length=4096)
    model: str | None = Field(default=None, max_length=200)


def _choices() -> list[dict[str, Any]]:
    """Describe every selectable AI service, including its current model."""
    described = []
    for provider, metadata in _PROVIDER_CHOICES.items():
        model_env = provider_settings(provider).get("model_env")
        models = list(metadata["models"])
        current = os.getenv(model_env, "").strip() if model_env else ""
        if current and current not in models:
            models.append(current)
        described.append(
            {
                "id": provider,
                "label": provider_display_name(provider),
                "key_label": metadata["key_label"],
                "key_url": metadata["key_url"],
                "needs_model": bool(model_env),
                "models": models,
                "note": metadata["note"],
            }
        )
    return described


def _read_env_text() -> str | None:
    """Return the current settings file text, or None when there is no file."""
    if not ENV_PATH.exists():
        return None
    return ENV_PATH.read_text(encoding="utf-8")


def _example_env_text() -> str:
    """Return the shipped template text used to create a missing settings file."""
    if not ENV_EXAMPLE_PATH.exists():
        return ""
    return ENV_EXAMPLE_PATH.read_text(encoding="utf-8")


def _dotenv_line(key: str, value: str) -> str:
    """Render one assignment, quoting a value the settings file would misparse."""
    if _SAFE_ENV_VALUE.fullmatch(value):
        return f"{key}={value}"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{key}="{escaped}"'


def _upsert_env_values(text: str, updates: dict[str, str]) -> str:
    """Set the given keys in place, keeping every other line and comment.

    Every assignment of a key is replaced, so a duplicated key cannot override
    the new value the next time the settings file is read.
    """
    replaced: set[str] = set()
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = _ASSIGNMENT.match(line)
        key = match.group(1) if match else None
        if key in updates:
            replaced.add(key)
            lines[index] = _dotenv_line(key, updates[key])
    missing = [key for key in updates if key not in replaced]
    if missing:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# Set by AutoApply setup.")
        lines.extend(_dotenv_line(key, updates[key]) for key in missing)
    return "\n".join(lines) + "\n"


def _write_env_text(text: str) -> None:
    """Replace the settings file atomically, readable by this user only."""
    descriptor, temp_name = tempfile.mkstemp(dir=ENV_PATH.parent, prefix=".env-")
    temp_path = Path(temp_name)
    try:
        os.fchmod(descriptor, ENV_FILE_MODE)
        with os.fdopen(descriptor, "w", encoding="utf-8") as temp_file:
            temp_file.write(text)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, ENV_PATH)
        # mkstemp is already private, but an existing file may not have been.
        os.chmod(ENV_PATH, ENV_FILE_MODE)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _apply_environment(updates: dict[str, str]) -> dict[str, str | None]:
    """Mirror written values into this process; return what they replaced.

    `get_llm_client()` reads `os.environ`, so the new settings must land there
    before the probe or the next request builds a client from stale values.
    """
    previous = {key: os.environ.get(key) for key in updates}
    os.environ.update(updates)
    return previous


def _restore_environment(previous: dict[str, str | None]) -> None:
    """Put back the process values captured by `_apply_environment`."""
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _revert(snapshot: str | None, previous: dict[str, str | None]) -> None:
    """Put back the settings that worked before this request."""
    try:
        if snapshot is None:
            ENV_PATH.unlink(missing_ok=True)
        else:
            _write_env_text(snapshot)
    except OSError as error:
        logger.error("Setup could not restore backend/.env: %s", error)
        raise HTTPException(status_code=500, detail=_SETTINGS_ERROR) from error
    finally:
        # The running process must fall back to the previous configuration even
        # if the file could not be rewritten.
        _restore_environment(previous)
        close_llm_client()


def _probe_failure_message(provider: str, error: Exception) -> str:
    """Plain copy for a rejected key or model; never the service's own text."""
    name = provider_display_name(provider)
    if _MODEL_PROBE_ERROR.search(f"{type(error).__name__}: {error}"):
        return _MODEL_REJECTED.format(name=name)
    return _KEY_REJECTED.format(name=name)


def _saved_response(provider: str, message: str) -> dict[str, Any]:
    """Build the success body: a masked hint at most, never the key."""
    _, key_hint = stored_key_state(provider)
    return {
        "status": "success",
        "ready": True,
        "provider": provider,
        "model": inspect_provider_configuration()["model"],
        "key_hint": key_hint,
        "message": message,
    }


@router.get("/status")
def setup_status() -> dict[str, Any]:
    """Report what is set up and what is not, without ever returning a key."""
    configuration = inspect_provider_configuration()
    provider = str(configuration["provider"])
    has_key, key_hint = stored_key_state(provider)
    return {
        "ready": bool(configuration["configured"]),
        "provider": provider,
        "model": configuration["model"],
        "has_key": has_key,
        "key_hint": key_hint,
        "message": "AI service is connected." if configuration["configured"] else configuration["error"],
        "resume_ready": (DATA_DIR / "resume.pdf").exists(),
        "profile_ready": (DATA_DIR / "profile.json").exists(),
        "choices": _choices(),
    }


@router.put("/provider")
def configure_provider(request: ProviderSetupRequest) -> dict[str, Any]:
    """Store a pasted key, prove it works, and roll back if it does not."""
    provider = request.provider.strip().lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail="AutoApply doesn't recognize this AI service. Choose one from the list.",
        )

    name = provider_display_name(provider)
    api_key = request.api_key.strip()
    if not api_key or any(character in api_key for character in "\r\n\x00"):
        raise HTTPException(status_code=400, detail=f"Add your {name} key to finish setup.")

    settings = provider_settings(provider)
    model_env = settings["model_env"]
    model = (request.model or "").strip() or (os.getenv(model_env, "").strip() if model_env else "")
    if model_env and not model:
        raise HTTPException(status_code=400, detail="Choose which AI model to use in AutoApply.")

    updates = {"AI_PROVIDER": provider, str(settings["api_key_env"]): api_key}
    if model_env:
        updates[model_env] = model

    try:
        snapshot = _read_env_text()
        existing = snapshot if snapshot is not None else _example_env_text()
        _write_env_text(_upsert_env_values(existing, updates))
    except OSError as error:
        logger.warning("Setup could not write backend/.env: %s", error)
        raise HTTPException(status_code=500, detail=_SETTINGS_ERROR) from error

    previous = _apply_environment(updates)

    # The cached singleton still holds the previous configuration; drop it so
    # the probe below and every later request build a client from the new values.
    close_llm_client()

    configuration = inspect_provider_configuration()
    if not configuration["configured"]:
        _revert(snapshot, previous)
        raise HTTPException(status_code=400, detail=str(configuration["error"]))

    try:
        get_llm_client().generate(_PROBE_PROMPT, max_retries=1)
    except ProviderNotConfigured as error:
        _revert(snapshot, previous)
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ProviderBusy:
        logger.info("Provider probe was rate limited; keeping the new settings.")
        return _saved_response(
            provider, "Saved. AutoApply is busy right now; try again in a moment."
        )
    except Exception as error:
        if _TRANSIENT_PROBE_ERROR.search(f"{type(error).__name__}: {error}"):
            logger.warning("Provider probe was inconclusive: %s", error)
            return _saved_response(
                provider,
                "Saved. AutoApply couldn't check it yet. Try again in a moment.",
            )
        logger.warning("Provider probe rejected the new settings: %s", error)
        _revert(snapshot, previous)
        raise HTTPException(
            status_code=400, detail=_probe_failure_message(provider, error)
        ) from error

    logger.info("AI service configured: provider=%s model=%s", provider, model or "(default)")
    return _saved_response(provider, "AI service is connected.")
