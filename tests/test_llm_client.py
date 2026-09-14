"""Provider configuration and shared response parsing tests."""

import os
import unittest
from unittest.mock import patch

from backend.services.llm_client import LLMClient, inspect_provider_configuration
from backend.services.openrouter import OpenRouterClient


class ProviderConfigurationTests(unittest.TestCase):
    def test_default_placeholder_key_is_not_ready(self) -> None:
        with patch.dict(
            os.environ,
            {"AI_PROVIDER": "gemini", "GEMINI_API_KEY": "your_gemini_api_key_here"},
            clear=True,
        ):
            status = inspect_provider_configuration()

        self.assertFalse(status["configured"])
        self.assertEqual("gemini", status["provider"])
        self.assertNotIn("your_gemini_api_key_here", str(status))

    def test_unknown_provider_is_rejected(self) -> None:
        with patch.dict(os.environ, {"AI_PROVIDER": "mystery"}, clear=True):
            status = inspect_provider_configuration()

        self.assertFalse(status["configured"])
        # The diagnostic keeps the env-var name for logs; the user-facing
        # sentence must not carry it.
        self.assertIn("Unsupported AI_PROVIDER", status["error_detail"])
        self.assertNotIn("AI_PROVIDER", status["error"])

    def test_selected_provider_reports_public_readiness_only(self) -> None:
        secret = "test-secret-value"
        with patch.dict(
            os.environ,
            {
                "AI_PROVIDER": "openrouter",
                "OPENROUTER_API_KEY": secret,
                "OPENROUTER_MODEL": "example/model",
                "OPENROUTER_PRIVACY_MODE": "strict",
            },
            clear=True,
        ):
            status = inspect_provider_configuration()

        self.assertTrue(status["configured"])
        self.assertEqual("example/model", status["model"])
        self.assertNotIn(secret, str(status))

    def test_free_openrouter_model_requires_explicit_privacy_opt_in(self) -> None:
        with patch.dict(
            os.environ,
            {
                "AI_PROVIDER": "openrouter",
                "OPENROUTER_API_KEY": "test-key",
                "OPENROUTER_MODEL": "example/model:free",
            },
            clear=True,
        ):
            status = inspect_provider_configuration()

        self.assertFalse(status["configured"])
        # The retention warning stays technical in the log line; the sentence a
        # user reads never names the opt-in variable.
        self.assertIn("personal data", status["error_detail"])
        self.assertNotIn("OPENROUTER_PRIVACY_MODE", status["error"])


class JsonExtractionTests(unittest.TestCase):
    def test_extracts_fenced_json(self) -> None:
        self.assertEqual(
            {"ok": True},
            LLMClient._extract_json('Result:\n```json\n{"ok": true}\n```'),
        )

    def test_invalid_response_is_rejected_without_echoing_everything(self) -> None:
        with self.assertRaisesRegex(ValueError, "Could not extract valid JSON"):
            LLMClient._extract_json("not json")


class OpenRouterPrivacyTests(unittest.TestCase):
    @patch("backend.services.openrouter._rate_limiter.wait_if_needed")
    def test_strict_mode_requests_private_routing(self, _wait) -> None:
        with patch.dict(
            os.environ, {"OPENROUTER_PRIVACY_MODE": "strict"}, clear=False
        ):
            client = OpenRouterClient(api_key="test-key", model="example/model")
        response = unittest.mock.Mock()
        response.json.return_value = {
            "choices": [{"message": {"content": "ok"}}]
        }
        client._http = unittest.mock.Mock()
        client._http.post.return_value = response

        try:
            self.assertEqual("ok", client.generate("hello", max_retries=1))
            payload = client._http.post.call_args.kwargs["json"]
            self.assertEqual(
                {"data_collection": "deny", "zdr": True}, payload["provider"]
            )
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
