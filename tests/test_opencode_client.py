"""Behavioural tests for the OpenCode Go provider (offline, stubbed transport)."""

import json
import os
import unittest
from unittest.mock import patch

from backend.services import llm_client
from backend.services.llm_client import LLMResponseError, ProviderNotConfigured
from backend.services.opencode import (
    OPENCODE_GO_API_URL,
    USER_AGENT,
    OpenCodeGoClient,
)
from backend.services.openrouter import OpenRouterClient

_ENV_KEYS = (
    "AI_PROVIDER",
    "OPENCODE_API_KEY",
    "OPENCODE_MODEL",
    "OPENCODE_BASE_URL",
    "OPENCODE_SESSION_ID",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
)


class _StubResponse:
    def __init__(self, status_code=200, payload=None, headers=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = text or json.dumps(payload or {})

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx

            request = httpx.Request("POST", OPENCODE_GO_API_URL)
            # Mirror httpx: the raised error carries the real response, so the
            # client can read the gateway's own error message from the body.
            response = httpx.Response(
                self.status_code,
                json=self._payload,
                headers=self.headers,
                request=request,
            )
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=request, response=response
            )


class _EnvIsolated(unittest.TestCase):
    def setUp(self):
        self._saved = {key: os.environ.get(key) for key in _ENV_KEYS}
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        llm_client.close_llm_client()

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        llm_client.close_llm_client()


class ProviderConfigurationTests(_EnvIsolated):
    def test_opencode_reports_the_missing_model_by_name(self):
        os.environ["AI_PROVIDER"] = "opencode"
        os.environ["OPENCODE_API_KEY"] = "sk-live-key"

        configuration = llm_client.inspect_provider_configuration()

        self.assertFalse(configuration["configured"])
        self.assertEqual(configuration["provider"], "opencode")
        self.assertIn("OPENCODE_MODEL", str(configuration["error"]))

    def test_get_llm_client_builds_the_opencode_client(self):
        os.environ["AI_PROVIDER"] = "opencode"
        os.environ["OPENCODE_API_KEY"] = "sk-live-key"
        os.environ["OPENCODE_MODEL"] = "deepseek-v4.1-flash"

        client = llm_client.get_llm_client()

        self.assertIsInstance(client, OpenCodeGoClient)
        self.assertEqual(client.provider_name, "opencode")
        self.assertEqual(client.model_name, "deepseek-v4.1-flash")

    def test_unconfigured_provider_raises_the_configuration_error(self):
        os.environ["AI_PROVIDER"] = "opencode"
        os.environ["OPENCODE_API_KEY"] = "your_opencode_api_key_here"

        with self.assertRaises(ProviderNotConfigured):
            llm_client.get_llm_client()


class RequestShapeTests(_EnvIsolated):
    def _client(self):
        return OpenCodeGoClient(api_key="sk-live-key", model="deepseek-v4.1-flash")

    def test_gateway_contract_is_honoured(self):
        """URL, bearer auth, client user-agent, session header and payload model."""
        captured = {}

        def fake_post(url, headers=None, json=None, **kwargs):
            captured["url"] = url
            captured["headers"] = headers
            captured["payload"] = json
            return _StubResponse(payload={"choices": [{"message": {"content": "ok"}}]})

        with patch("httpx.Client.post", side_effect=fake_post):
            result = self._client().generate("Question?", system_instruction="System")

        self.assertEqual(result, "ok")
        self.assertEqual(captured["url"], OPENCODE_GO_API_URL)
        self.assertEqual(captured["headers"]["Authorization"], "Bearer sk-live-key")
        self.assertEqual(captured["headers"]["User-Agent"], USER_AGENT)
        self.assertTrue(captured["headers"].get("x-opencode-session"))
        self.assertEqual(captured["payload"]["model"], "deepseek-v4.1-flash")
        self.assertEqual(
            [message["role"] for message in captured["payload"]["messages"]],
            ["system", "user"],
        )
        # The OpenRouter privacy provider block must not reach this gateway.
        self.assertNotIn("provider", captured["payload"])

    def test_session_id_is_stable_across_calls(self):
        sessions = []

        def fake_post(url, headers=None, json=None, **kwargs):
            sessions.append(headers.get("x-opencode-session"))
            return _StubResponse(payload={"choices": [{"message": {"content": "ok"}}]})

        client = self._client()
        with patch("httpx.Client.post", side_effect=fake_post):
            client.generate("one")
            client.generate("two")

        self.assertEqual(len(sessions), 2)
        self.assertEqual(sessions[0], sessions[1])

    def test_explicit_session_id_wins(self):
        os.environ["OPENCODE_SESSION_ID"] = "session-from-config"

        self.assertEqual(self._client().session_id, "session-from-config")

    def test_rejection_surfaces_the_gateway_message(self):
        def fake_post(url, headers=None, json=None, **kwargs):
            return _StubResponse(
                status_code=400,
                payload={"error": {"type": "MissingSessionID", "message": "Request is missing x-opencode-session"}},
            )

        with patch("httpx.Client.post", side_effect=fake_post):
            with self.assertRaises(LLMResponseError) as raised:
                self._client().generate("Question?")

        message = str(raised.exception)
        self.assertIn("OpenCode Go", message)
        self.assertIn("missing x-opencode-session", message)


class OpenRouterStillWorksTests(_EnvIsolated):
    def test_openrouter_keeps_its_endpoint_and_privacy_payload(self):
        os.environ["OPENROUTER_API_KEY"] = "sk-or-test"
        os.environ["OPENROUTER_MODEL"] = "example/model"
        captured = {}

        def fake_post(url, headers=None, json=None, **kwargs):
            captured["url"] = url
            captured["payload"] = json
            return _StubResponse(payload={"choices": [{"message": {"content": "ok"}}]})

        with patch("httpx.Client.post", side_effect=fake_post):
            OpenRouterClient().generate("Question?")

        self.assertEqual(captured["url"], "https://openrouter.ai/api/v1/chat/completions")
        self.assertEqual(captured["payload"]["provider"], {"data_collection": "deny", "zdr": True})


if __name__ == "__main__":
    unittest.main()
