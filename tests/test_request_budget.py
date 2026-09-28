"""Regression tests for AI request budget, answer drafts, and startup work."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.models.form_schema import FitScore
from backend.routers import autofill
from backend.services.database import Database
from backend.services.llm_client import ProviderBusy


class _DatabaseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "autoapply.db"
        self.database = Database(self.db_path)

    def tearDown(self) -> None:
        self.database.close()
        self.temp.cleanup()

    def _draft(self, answer: str, company: str = "Example") -> dict:
        return {
            "id": f"draft-{answer}", "question": "Why do you want to work here?",
            "answer": answer, "company": company, "role": "Engineer",
            "question_type": "motivation", "tags": ["motivation"],
            "source": "generated", "approved": False,
        }


class GeneratedAnswerTests(_DatabaseCase):
    def test_rescan_replaces_the_pending_draft(self) -> None:
        self.database.save_generated_answer(self._draft("first draft"))
        self.database.save_generated_answer(self._draft("second draft"))

        answers = self.database.list_answer_vault()
        self.assertEqual(1, len(answers))
        self.assertEqual("second draft", answers[0]["answer"])

    def test_each_company_keeps_its_own_draft(self) -> None:
        self.database.save_generated_answer(self._draft("for example", "Example"))
        self.database.save_generated_answer(self._draft("for other", "Other"))

        self.assertEqual(2, len(self.database.list_answer_vault()))

    def test_approved_answer_is_never_overwritten(self) -> None:
        saved = self.database.save_generated_answer(self._draft("approved text"))
        self.database.patch_answer_vault(saved["id"], {"approved": True})

        self.database.save_generated_answer(self._draft("new draft"))

        answers = self.database.list_answer_vault()
        self.assertEqual(1, len(answers))
        self.assertEqual("approved text", answers[0]["answer"])
        self.assertEqual(1, answers[0]["approved"])


class StartupMigrationTests(_DatabaseCase):
    def test_later_answer_bank_rows_are_not_imported_as_approved(self) -> None:
        self.database.add_answer({
            "company": "Example", "role": "Engineer", "question_type": "motivation",
            "question": "Why us?", "answer": "An AI draft nobody approved.",
        })
        self.database.close()

        self.database = Database(self.db_path)

        approved = [item for item in self.database.list_answer_vault() if item["approved"]]
        self.assertEqual([], approved)


class DuplicateLookupTests(_DatabaseCase):
    def test_rows_without_company_or_role_do_not_crash_or_match(self) -> None:
        self.database.add_application({"id": "legacy", "company": None, "role": None, "url": ""})

        self.assertIsNone(self.database.check_duplicate_company_role("Example", "Engineer"))


class FitScoreCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        autofill._fit_cache.clear()
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.profile_patch = patch.object(autofill, "_load_profile", return_value=Mock())
        self.knowledge_patch = patch.object(autofill, "_load_knowledge", return_value="")
        self.profile_patch.start()
        self.knowledge_patch.start()

    def tearDown(self) -> None:
        self.knowledge_patch.stop()
        self.profile_patch.stop()
        autofill._fit_cache.clear()

    def _analyze(self):
        response = self.client.post(
            "/api/analyze-job", json={"job_description": "Build reliable systems. " * 10}
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def test_same_posting_is_scored_once(self) -> None:
        score = FitScore(score=72, verdict="Good match", recommendation="apply")
        with patch.object(autofill.JobAnalyzer, "analyze_job", return_value=score) as analyze:
            first = self._analyze()
            second = self._analyze()

        self.assertEqual(1, analyze.call_count)
        self.assertEqual(first, second)

    def test_failed_analysis_is_retried(self) -> None:
        failed = FitScore(score=0, verdict="Analysis failed", recommendation="unknown")
        with patch.object(autofill.JobAnalyzer, "analyze_job", return_value=failed) as analyze:
            self._analyze()
            self._analyze()

        self.assertEqual(2, analyze.call_count)


class _RateLimited(Exception):
    code = 429


class GeminiBudgetTests(unittest.TestCase):
    def _client(self, genai: MagicMock):
        from backend.services.gemini import GeminiClient

        with patch("backend.services.gemini.genai", genai):
            return GeminiClient(api_key="test-key")

    @patch("backend.services.gemini._rate_limiter.wait_if_needed")
    @patch("backend.services.gemini.time.sleep")
    def test_long_retry_hint_answers_busy_instead_of_sleeping(self, sleep, _wait) -> None:
        genai = MagicMock()
        client = self._client(genai)
        client.model.generate_content.side_effect = _RateLimited("Quota hit. Please retry in 40s.")

        with self.assertRaises(ProviderBusy):
            client.generate("hello")

        sleep.assert_not_called()
        self.assertEqual(1, client.model.generate_content.call_count)

    @patch("backend.services.gemini._rate_limiter.wait_if_needed")
    def test_json_requests_use_json_output_and_a_timeout(self, _wait) -> None:
        genai = MagicMock()
        client = self._client(genai)
        client.model.generate_content.return_value = Mock(candidates=[object()], text="[]")

        self.assertEqual([], client.generate_json("hello"))

        kwargs = client.model.generate_content.call_args.kwargs
        self.assertEqual({"response_mime_type": "application/json"}, kwargs["generation_config"])
        self.assertIn("timeout", kwargs["request_options"])


if __name__ == "__main__":
    unittest.main()
