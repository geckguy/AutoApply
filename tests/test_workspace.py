import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.database import Database


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.database = Database(self.data_dir / "workspace.db")
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.db_patch = patch("backend.routers.workspace.get_database", return_value=self.database)
        self.data_patch = patch("backend.routers.workspace.DATA_DIR", self.data_dir)
        self.version_dir_patch = patch("backend.routers.workspace.RESUME_VERSION_DIR", self.data_dir / "resume_versions")
        self.db_patch.start()
        self.data_patch.start()
        self.version_dir_patch.start()

    def tearDown(self):
        self.version_dir_patch.stop()
        self.data_patch.stop()
        self.db_patch.stop()
        self.database.close()
        self.temp.cleanup()

    def _opportunity(self):
        response = self.client.post(
            "/api/workspace/opportunities/upsert",
            json={
                "company": "Example", "role": "Engineer",
                "url": "https://jobs.example.test/123?source=board",
                "platform": "greenhouse", "job_description_snippet": "Build reliable systems.",
            },
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()["opportunity"]

    def test_extension_packet_teach_and_confirmed_receipt_flow(self):
        opportunity = self._opportunity()
        app_id = opportunity["id"]
        packet_response = self.client.post(
            "/api/workspace/application-packets",
            json={
                "opportunity_id": app_id, "stage": "review",
                "page_url": "https://jobs.example.test/123/apply",
                "instructions": [{"field_id": "email", "action": "fill"}],
                "field_failures": [{"field_id": "city", "reason": "missing"}],
            },
        )
        self.assertEqual(200, packet_response.status_code, packet_response.text)
        packet_id = packet_response.json()["packet_id"]

        teach = self.client.post(
            "/api/workspace/teaches",
            json={
                "opportunity_id": app_id, "packet_id": packet_id,
                "url": "https://jobs.example.test/123/apply",
                "field": {"id": "city", "label": "Current city", "type": "text"},
                "proposed_value": "", "corrected_value": "London",
            },
        )
        self.assertEqual(200, teach.status_code, teach.text)
        self.assertEqual("London", self.database.get_learned_mappings()[0]["value"])

        rejected = self.client.post(
            "/api/workspace/submissions/confirm",
            json={"opportunity_id": app_id, "packet_id": packet_id, "user_confirmed": False},
        )
        self.assertEqual(422, rejected.status_code)
        confirmed = self.client.post(
            "/api/workspace/submissions/confirm",
            json={
                "opportunity_id": app_id, "packet_id": packet_id,
                "submitted_at": "2026-07-23T12:00:00Z", "user_confirmed": True,
                "receipt": {"url": "https://jobs.example.test/thanks", "confirmation_text": "Application received"},
            },
        )
        self.assertEqual(200, confirmed.status_code, confirmed.text)
        self.assertEqual("applied", self.database.get_application_by_id(app_id)["status"])

    def test_dashboard_overview_packet_relationships_and_followups(self):
        app_id = self._opportunity()["id"]
        contact = self.client.post(
            f"/api/workspace/applications/{app_id}/relationships",
            json={"name": "Grace Hopper", "type": "contact"},
        )
        self.assertEqual(200, contact.status_code, contact.text)
        follow_up = self.client.post(
            f"/api/workspace/applications/{app_id}/follow-ups",
            json={"due_at": "2026-07-30T10:00:00Z", "note": "Send a concise follow-up"},
        )
        self.assertEqual(200, follow_up.status_code, follow_up.text)

        packet = self.client.get(f"/api/workspace/applications/{app_id}/packet")
        self.assertEqual(200, packet.status_code, packet.text)
        self.assertEqual("Grace Hopper", packet.json()["contacts"][0]["name"])
        self.assertEqual("Send a concise follow-up", packet.json()["follow_ups"][0]["notes"])

        overview = self.client.get("/api/workspace/overview")
        self.assertEqual(200, overview.status_code, overview.text)
        self.assertTrue(overview.json()["queue"])
        self.assertTrue(overview.json()["reminders"])
        self.assertGreaterEqual(len(overview.json()["policies"]), 4)

    def test_duplicate_resolution_is_explicit_and_non_destructive(self):
        original = self._opportunity()

        matches = self.client.get(
            "/api/workspace/duplicates",
            params={
                "url": "https://jobs.example.test/123?utm_source=email",
                "company": "Example",
                "role": "Engineer",
            },
        )
        self.assertEqual(200, matches.status_code, matches.text)
        self.assertEqual("exact_url", matches.json()["matches"][0]["match_type"])

        reused = self.client.post(
            "/api/workspace/opportunities/upsert",
            json={
                "company": "Example",
                "role": "Engineer",
                "url": "https://jobs.example.test/123?utm_source=email",
                "duplicate_resolution": "reuse",
                "existing_id": original["id"],
            },
        )
        self.assertEqual(200, reused.status_code, reused.text)
        self.assertEqual(original["id"], reused.json()["opportunity"]["id"])
        self.assertTrue(reused.json()["reused"])

        created = self.client.post(
            "/api/workspace/opportunities/upsert",
            json={
                "company": "Example",
                "role": "Engineer",
                "url": "https://jobs.example.test/123?utm_source=email",
                "duplicate_resolution": "create_new",
            },
        )
        self.assertEqual(200, created.status_code, created.text)
        self.assertNotEqual(original["id"], created.json()["opportunity"]["id"])
        self.assertEqual(2, len(self.database.list_opportunities()))

    def test_applied_roles_enter_queue_only_when_an_action_is_due(self):
        app_id = self._opportunity()["id"]
        updated = self.client.patch(
            f"/api/workspace/opportunities/{app_id}",
            json={"status": "applied"},
        )
        self.assertEqual(200, updated.status_code, updated.text)

        overview = self.client.get("/api/workspace/overview").json()
        self.assertFalse(any(item.get("opportunity_id") == app_id for item in overview["actions"]))

        follow_up = self.client.post(
            f"/api/workspace/applications/{app_id}/follow-ups",
            json={"due_at": "2026-07-30T10:00:00Z", "note": "Check in"},
        )
        self.assertEqual(200, follow_up.status_code, follow_up.text)
        follow_up_id = follow_up.json()["follow_up"]["id"]

        overview = self.client.get("/api/workspace/overview").json()
        self.assertTrue(
            any(
                item.get("opportunity_id") == app_id and item.get("type") == "follow_up"
                for item in overview["actions"]
            )
        )

        completed = self.client.patch(
            f"/api/workspace/follow-ups/{follow_up_id}",
            json={"completed": True},
        )
        self.assertEqual(200, completed.status_code, completed.text)
        overview = self.client.get("/api/workspace/overview").json()
        self.assertFalse(
            any(
                item.get("opportunity_id") == app_id and item.get("type") == "follow_up"
                for item in overview["actions"]
            )
        )

    def test_policy_toggle_entries_are_validated(self):
        for payload in ({"policies": [{}]}, {"policies": [None]}):
            with self.subTest(payload=payload):
                response = self.client.put("/api/workspace/policies", json=payload)
                self.assertEqual(422, response.status_code, response.text)

    def test_opportunity_metadata_must_be_an_object(self):
        response = self.client.post(
            "/api/workspace/opportunities/upsert",
            json={"company": "Example", "role": "Engineer", "metadata": "not-a-dict"},
        )

        self.assertEqual(422, response.status_code, response.text)

    def test_unknown_application_id_is_rejected_before_writing(self):
        requests = [
            ("follow-ups", {"due_at": "2026-07-30T10:00:00Z"}),
            ("interviews", {"scheduled_at": "2026-07-30T10:00:00Z"}),
            ("relationships", {"name": "Grace Hopper"}),
        ]
        for path, payload in requests:
            with self.subTest(path=path):
                response = self.client.post(f"/api/workspace/applications/missing-id/{path}", json=payload)
                self.assertEqual(404, response.status_code, response.text)

        related = self.database.related_records("missing-id")
        self.assertEqual([], related["contacts"])
        self.assertEqual([], related["follow_ups"])
        self.assertEqual([], related["interviews"])

    def test_oversized_application_packet_is_rejected(self):
        app_id = self._opportunity()["id"]
        payload = {"opportunity_id": app_id}

        accepted = self.client.post(
            "/api/workspace/application-packets", json={**payload, "cover_letter": "x" * 50_000}
        )
        self.assertEqual(200, accepted.status_code, accepted.text)

        rejected = self.client.post(
            "/api/workspace/application-packets", json={**payload, "cover_letter": "x" * 50_001}
        )
        self.assertEqual(422, rejected.status_code, rejected.text)

    def test_resume_alias_and_private_download(self):
        resume = self.data_dir / "generated.pdf"
        resume.write_bytes(b"%PDF-1.4\nfixture")
        version = self.database.upsert_resume_version(
            {
                "id": "resume-1", "filename": "generated.pdf", "label": "Backend",
                "sha256": "a" * 64, "storage_path": str(resume),
                "artifacts": {"pdf_path": str(resume)}, "profile_snapshot": {}, "make_active": True,
            }
        )
        listing = self.client.get("/api/workspace/resume-versions")
        self.assertEqual("Backend", listing.json()["versions"][0]["name"])
        self.assertTrue(listing.json()["versions"][0]["active"])
        download = self.client.get(f"/api/workspace/resume-versions/{version['id']}/download")
        self.assertEqual(200, download.status_code, download.text)
        self.assertTrue(download.content.startswith(b"%PDF"))

    @patch("backend.routers.workspace.ResumeTailor.tailor")
    def test_tailor_endpoint_creates_pdf_and_docx_version(self, tailor):
        (self.data_dir / "profile.json").write_text(
            '{"personal":{"first_name":"Ada","last_name":"Lovelace"},'
            '"work_experience":[{"company":"Engines","title":"Engineer","description":"Built systems"}],'
            '"skills":["Python","SQL"]}'
        )
        tailor.return_value = {
            "summary": "Engineer building reliable data systems.",
            "highlighted_skills": ["SQL"],
            "experience_bullets": [{"company": "Engines", "title": "Engineer", "bullets": ["Built reliable systems"]}],
            "suggestions": [],
        }
        response = self.client.post(
            "/api/workspace/resume-versions/tailor",
            json={"job_description": "Build reliable data systems with Python and SQL.", "label": "Data systems"},
        )
        self.assertEqual(200, response.status_code, response.text)
        version = response.json()["version"]
        self.assertTrue(Path(version["artifacts"]["pdf_path"]).is_file())
        self.assertTrue(Path(version["artifacts"]["docx_path"]).is_file())


if __name__ == "__main__":
    unittest.main()
