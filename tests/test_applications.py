"""Application lifecycle and export regression tests."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.main import app
from backend.models.application import Application, ApplicationStatusUpdate
from backend.routers.applications import _csv_safe
from backend.services.database import Database


class ApplicationModelTests(unittest.TestCase):
    def test_prepared_application_has_truthful_status(self) -> None:
        application = Application(
            company="Example",
            role="Engineer",
            url="https://example.test/jobs/1",
            status="ready_to_review",
        )

        self.assertEqual("ready_to_review", application.status)

    def test_unknown_status_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            ApplicationStatusUpdate(status="maybe")


class CsvSafetyTests(unittest.TestCase):
    def test_formula_prefixes_are_neutralized(self) -> None:
        for value in ("=cmd()", "+1+1", "-2+3", "@SUM(A1:A2)", "  =1+1"):
            with self.subTest(value=value):
                self.assertTrue(_csv_safe(value).startswith("'"))

    def test_normal_values_are_unchanged(self) -> None:
        self.assertEqual("Example, Inc.", _csv_safe("Example, Inc."))
        self.assertEqual(92, _csv_safe(92))


class ApplicationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temp.name) / "applications.db")
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.db_patch = patch(
            "backend.routers.applications.get_database", return_value=self.database
        )
        self.db_patch.start()

    def tearDown(self) -> None:
        self.db_patch.stop()
        self.database.close()
        self.temp.cleanup()

    def test_repeat_application_id_is_reported_as_a_conflict(self) -> None:
        application = {
            "id": "duplicate-1",
            "company": "Example",
            "role": "Engineer",
            "url": "https://example.test/jobs/1",
        }

        first = self.client.post("/api/applications/", json=application)
        second = self.client.post("/api/applications/", json=application)

        self.assertEqual(200, first.status_code, first.text)
        self.assertEqual(409, second.status_code, second.text)
        self.assertEqual(1, self.database.count_applications())


if __name__ == "__main__":
    unittest.main()
