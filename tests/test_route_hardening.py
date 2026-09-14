"""Route behaviour when the AI provider is unavailable and request limits."""

import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.services.llm_client as llm_client
from backend.main import app
from backend.models.profile import PersonalInfo, UserProfile
from backend.services.database import Database


class ProviderUnavailableRouteTests(unittest.TestCase):
    """A missing provider must degrade to 503 or a local answer, never a 500."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.database = Database(self.data_dir / "autoapply.db")
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.profile = UserProfile(
            personal=PersonalInfo(first_name="Ada", last_name="Lovelace", email="ada@example.test")
        )
        # get_llm_client() caches a process-wide singleton; a client built by an
        # earlier test would hide the unconfigured provider entirely.
        llm_client.close_llm_client()
        self.env_patch = patch.dict(
            os.environ,
            {"AI_PROVIDER": "gemini", "GEMINI_API_KEY": "your_gemini_api_key_here"},
            clear=False,
        )
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()
        llm_client.close_llm_client()
        self.database.close()
        self.temp.cleanup()

    def _autofill_patches(self):
        return (
            patch("backend.routers.autofill.get_database", return_value=self.database),
            patch("backend.services.database.get_database", return_value=self.database),
            patch("backend.routers.autofill._load_profile", return_value=self.profile),
            patch("backend.routers.autofill._load_knowledge", return_value=""),
            patch("backend.routers.autofill._load_corrections", return_value=[]),
        )

    def assert_provider_error_is_plain(self, text: str) -> None:
        """The sentence a user reads names no env var, file or status code."""
        self.assertIn("Google Gemini", text)
        for leaked in ("GEMINI_API_KEY", "backend/.env", "HTTP", "AI provider"):
            self.assertNotIn(leaked, text)

    def test_autofill_keeps_local_instructions_and_reports_ai_error(self) -> None:
        schema = {
            "url": "https://jobs.example.test/apply",
            "fields": [
                {"id": "email", "type": "email", "label": "Email"},
                {"id": "why", "type": "textarea", "label": "Why do you want to work here?"},
            ],
        }
        with ExitStack() as stack:
            for context in self._autofill_patches():
                stack.enter_context(context)
            response = self.client.post("/api/autofill", json=schema)

        self.assertEqual(200, response.status_code, response.text)
        body = response.json()
        self.assert_provider_error_is_plain(body["ai_error"] or "")
        instructions = {item["field_id"]: item for item in body["instructions"]}
        self.assertEqual("ada@example.test", instructions["email"]["value"])
        self.assertFalse(instructions["email"]["review_required"])
        # The open question could not be answered, so it is a reviewable skip
        # rather than an invented value or a server fault.
        self.assertEqual("skip", instructions["why"]["action"])
        self.assertIsNone(instructions["why"]["value"])
        self.assertEqual(1, body["ready_count"])

    def test_cover_letter_reports_the_missing_provider(self) -> None:
        with patch("backend.routers.autofill._load_profile", return_value=self.profile), patch(
            "backend.routers.autofill._load_knowledge", return_value=""
        ):
            response = self.client.post(
                "/api/cover-letter",
                json={"job_description": "Build reliable systems.", "company": "Example", "role": "Engineer"},
            )

        self.assertEqual(503, response.status_code, response.text)
        self.assert_provider_error_is_plain(response.json()["detail"])

    def test_tailor_resume_reports_the_missing_provider(self) -> None:
        with patch("backend.routers.autofill._load_profile", return_value=self.profile), patch(
            "backend.routers.autofill._load_knowledge", return_value=""
        ):
            response = self.client.post(
                "/api/tailor-resume", json={"job_description": "Build reliable systems."}
            )

        self.assertEqual(503, response.status_code, response.text)
        self.assert_provider_error_is_plain(response.json()["detail"])

    def test_workspace_resume_tailor_reports_the_missing_provider(self) -> None:
        (self.data_dir / "profile.json").write_text(self.profile.model_dump_json())
        with patch("backend.routers.workspace.DATA_DIR", self.data_dir), patch(
            "backend.routers.workspace.get_database", return_value=self.database
        ):
            response = self.client.post(
                "/api/workspace/resume-versions/tailor",
                json={"job_description": "Build reliable data systems with Python.", "label": "Data"},
            )

        self.assertEqual(503, response.status_code, response.text)
        self.assert_provider_error_is_plain(response.json()["detail"])

    def test_resume_upload_needs_a_provider_but_validates_the_file_first(self) -> None:
        with patch("backend.routers.profile.DATA_DIR", self.data_dir):
            valid = self.client.post(
                "/api/profile/upload-resume",
                files={"file": ("resume.pdf", b"%PDF-1.4 fixture", "application/pdf")},
            )
            not_pdf = self.client.post(
                "/api/profile/upload-resume",
                files={"file": ("resume.pdf", b"not a pdf", "application/pdf")},
            )
            wrong_type = self.client.post(
                "/api/profile/upload-resume",
                files={"file": ("resume.txt", b"%PDF-1.4 fixture", "text/plain")},
            )

        self.assertEqual(503, valid.status_code, valid.text)
        self.assert_provider_error_is_plain(valid.json()["detail"])
        self.assertNotIn("PDF", valid.json()["detail"])
        # Input validation keeps precedence over the provider check.
        self.assertEqual(400, not_pdf.status_code, not_pdf.text)
        self.assertEqual(400, wrong_type.status_code, wrong_type.text)
        self.assertFalse((self.data_dir / "resume.pdf").exists())
        self.assertEqual([], list(self.data_dir.glob("resume-*")))

    def test_knowledge_payload_over_the_cap_is_rejected(self) -> None:
        with patch("backend.routers.profile.DATA_DIR", self.data_dir):
            accepted = self.client.post("/api/profile/upload-knowledge", json={"content": "x" * 200_000})
            rejected = self.client.post("/api/profile/upload-knowledge", json={"content": "x" * 200_001})

        self.assertEqual(200, accepted.status_code, accepted.text)
        self.assertEqual(422, rejected.status_code, rejected.text)
        self.assertEqual(200_000, len((self.data_dir / "knowledge.md").read_text()))


class AnswerBankLimitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temp.name) / "answer_bank.db")
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.db_patch = patch(
            "backend.routers.autofill.get_database", return_value=self.database
        )
        self.db_patch.start()

    def tearDown(self) -> None:
        self.db_patch.stop()
        self.database.close()
        self.temp.cleanup()

    def test_answer_bank_returns_at_most_limit_newest_rows(self) -> None:
        for index in range(5):
            self.database.add_answer(
                {
                    "company": "Example",
                    "role": "Engineer",
                    "question_type": "motivation",
                    "question": f"Question {index}",
                    "answer": f"Answer {index}",
                }
            )

        response = self.client.get("/api/answer-bank", params={"limit": 2})

        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual(["Question 4", "Question 3"], [row["question"] for row in response.json()])
        self.assertEqual(
            ["Question 4", "Question 3", "Question 2"],
            [row["question"] for row in self.database.get_answers(3)],
        )


if __name__ == "__main__":
    unittest.main()
