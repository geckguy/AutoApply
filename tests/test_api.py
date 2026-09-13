"""API security and health regression tests."""

import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from backend.main import app


class ApiSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")

    def test_untrusted_web_origin_is_not_allowed_by_cors(self) -> None:
        response = self.client.options(
            "/api/profile/",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )

        # CORSMiddleware may reject the preflight before the origin middleware.
        self.assertIn(response.status_code, (400, 403))
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_simple_cross_origin_request_is_rejected_server_side(self) -> None:
        response = self.client.get(
            "/api/profile/", headers={"Origin": "https://evil.example"}
        )

        self.assertEqual(403, response.status_code)

    def test_extension_origin_is_allowed_by_cors(self) -> None:
        response = self.client.options(
            "/api/profile/",
            headers={
                "Origin": "chrome-extension://geiaehlmjhdjaglkijniajpkcicebahm",
                "Access-Control-Request-Method": "GET",
            },
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            "chrome-extension://geiaehlmjhdjaglkijniajpkcicebahm",
            response.headers["access-control-allow-origin"],
        )

    def test_public_host_header_is_rejected(self) -> None:
        response = self.client.post(
            "/api/analyze-job",
            json={"job_description": ""},
            headers={"Host": "evil.test"},
        )

        self.assertEqual(403, response.status_code, response.text)

    def test_loopback_host_header_is_accepted_on_any_port(self) -> None:
        response = self.client.post(
            "/api/analyze-job",
            json={"job_description": ""},
            headers={"Host": "127.0.0.1:9123"},
        )

        # The Host check passed; the empty body is what fails next.
        self.assertEqual(422, response.status_code, response.text)

    def test_dashboard_on_a_non_default_port_is_accepted(self) -> None:
        # Browsers send Origin on same-origin non-GET requests; a dashboard
        # served from a non-default port must not have its own writes rejected.
        client = TestClient(app, base_url="http://127.0.0.1:8123")

        response = client.post(
            "/api/analyze-job",
            json={"job_description": ""},
            headers={"Origin": "http://127.0.0.1:8123"},
        )

        self.assertEqual(422, response.status_code, response.text)

    def test_loopback_origin_on_a_different_port_is_rejected(self) -> None:
        response = self.client.post(
            "/api/analyze-job",
            json={"job_description": ""},
            headers={"Origin": "http://127.0.0.1:8123"},
        )

        self.assertEqual(403, response.status_code, response.text)

    def test_pinned_extension_origins_are_accepted(self) -> None:
        for origin in (
            "chrome-extension://geiaehlmjhdjaglkijniajpkcicebahm",
            "moz-extension://autoapply@local",
        ):
            with self.subTest(origin=origin):
                response = self.client.post(
                    "/api/analyze-job",
                    json={"job_description": ""},
                    headers={"Origin": origin},
                )
                self.assertEqual(422, response.status_code, response.text)

    def test_unpinned_extension_origin_is_rejected(self) -> None:
        response = self.client.post(
            "/api/analyze-job",
            json={"job_description": ""},
            headers={"Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        )

        self.assertEqual(403, response.status_code, response.text)

    def test_job_analysis_body_is_validated_before_work_starts(self) -> None:
        response = self.client.post("/api/analyze-job", json={"job_description": ""})

        self.assertEqual(422, response.status_code)

    @patch("backend.services.llm_client.inspect_provider_configuration")
    @patch("backend.services.database.get_database")
    def test_health_uses_sqlite_count_without_constructing_llm(
        self, get_database: Mock, inspect_provider_configuration: Mock
    ) -> None:
        get_database.return_value.count_applications.return_value = 14
        inspect_provider_configuration.return_value = {
            "provider": "openrouter",
            "model": "test-model",
            "configured": True,
            "error": None,
        }

        response = self.client.get("/api/health")

        self.assertEqual(200, response.status_code)
        self.assertEqual(14, response.json()["total_applications"])
        self.assertTrue(response.json()["ai_ready"])


if __name__ == "__main__":
    unittest.main()
