"""OpenCode Go client — OpenAI-compatible gateway at https://opencode.ai/zen/go.

OpenCode Go is a subscription gateway that serves coding models (DeepSeek, Kimi,
GLM, Qwen, …) behind a single `sk-…` key. It speaks the standard
chat-completions protocol, so it reuses `OpenRouterClient`'s transport, retry and
error translation and only changes the endpoint, the credentials, the rate
limiter and the headers.

The gateway asks every client to identify itself and to send a stable session id
per conversation (see https://opencode.ai/docs/go/#where-can-i-use-it), which is
also what lets it route requests and reuse the prompt cache.
"""

import os
import uuid

from backend.services.llm_client import RateLimiter, configured_max_calls_per_minute
from backend.services.openrouter import OpenRouterClient

OPENCODE_GO_API_URL = "https://opencode.ai/zen/go/v1/chat/completions"

# Identify the client rather than the HTTP library, as the gateway requests.
USER_AGENT = "AutoApply/1.0.1 (+https://github.com/geckguy/AutoApply)"

# The subscription is metered by spend, not by requests per minute, so the local
# limiter only has to stop runaway loops; the autopilot needs ~1 call per form step.
_rate_limiter = RateLimiter(max_calls=configured_max_calls_per_minute(30), period=60.0)


class OpenCodeGoClient(OpenRouterClient):
    """OpenCode Go API client (`AI_PROVIDER=opencode`)."""

    label = "OpenCode Go"
    provider_key = "opencode"
    api_url = OPENCODE_GO_API_URL
    api_key_env = "OPENCODE_API_KEY"
    model_env = "OPENCODE_MODEL"
    base_url_env = "OPENCODE_BASE_URL"
    # The gateway exposes no data-collection controls; there is nothing to negotiate.
    privacy_mode_supported = False
    rate_limiter = _rate_limiter

    def __init__(self, api_key=None, model=None, base_url=None):
        super().__init__(api_key=api_key, model=model, base_url=base_url)
        # One stable session for this process: every call in a run shares it, so the
        # gateway can keep routing and prompt caching consistent. Overridable for
        # deployments that want a session per application instead.
        self.session_id = os.getenv("OPENCODE_SESSION_ID", "").strip() or uuid.uuid4().hex

    @property
    def request_headers(self) -> dict[str, str]:
        return {
            "User-Agent": USER_AGENT,
            "x-opencode-session": self.session_id,
        }
