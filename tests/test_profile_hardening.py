import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from backend.models.profile import UserProfile
from backend.routers import profile as profile_router


class ProfileHardeningTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.original_data_dir = profile_router.DATA_DIR
        self.original_parse_resume = profile_router.ResumeParser.parse_resume
        profile_router.DATA_DIR = self.data_dir
        # Uploads refuse to start without a configured AI provider; these tests
        # exercise parsing and file handling, so make the provider available.
        self.provider_patch = patch(
            "backend.routers.profile.inspect_provider_configuration",
            return_value={
                "provider": "gemini",
                "model": "test-model",
                "configured": True,
                "error": None,
            },
        )
        self.provider_patch.start()

    def tearDown(self):
        self.provider_patch.stop()
        profile_router.DATA_DIR = self.original_data_dir
        profile_router.ResumeParser.parse_resume = staticmethod(self.original_parse_resume)
        self.temp_dir.cleanup()

    def test_merge_profiles_merges_address_and_replaces_projects(self):
        existing = UserProfile.model_validate(
            {
                "personal": {"first_name": "Manual", "address": {"city": "Old City"}},
                "projects": [{"name": "Old project"}],
            }
        )
        parsed = UserProfile.model_validate(
            {
                "personal": {
                    "first_name": "Parsed",
                    "last_name": "Applicant",
                    "address": {"city": "Parsed City", "state": "CA", "country": "US"},
                },
                "projects": [{"name": "Latest project"}],
            }
        )

        merged = profile_router._merge_profiles(existing, parsed)

        self.assertEqual(merged.personal.first_name, "Manual")
        self.assertEqual(merged.personal.last_name, "Applicant")
        self.assertEqual(merged.personal.address.city, "Old City")
        self.assertEqual(merged.personal.address.state, "CA")
        self.assertEqual(merged.personal.address.country, "US")
        self.assertEqual([project.name for project in merged.projects], ["Latest project"])

    async def test_resume_upload_rejects_empty_and_non_pdf_before_writing(self):
        empty = UploadFile(filename="resume.pdf", file=BytesIO(b""))
        with self.assertRaises(HTTPException) as empty_error:
            await profile_router.upload_resume(empty)
        self.assertEqual(empty_error.exception.status_code, 400)

        invalid = UploadFile(filename="resume.pdf", file=BytesIO(b"not a PDF"))
        with self.assertRaises(HTTPException) as invalid_error:
            await profile_router.upload_resume(invalid)
        self.assertEqual(invalid_error.exception.status_code, 400)
        self.assertFalse((self.data_dir / "resume.pdf").exists())

    async def test_failed_parse_preserves_existing_resume_and_removes_temp_file(self):
        profile_router._ensure_data_dir()
        resume_path = self.data_dir / "resume.pdf"
        resume_path.write_bytes(b"%PDF-old")
        os.chmod(resume_path, 0o600)
        profile_router.ResumeParser.parse_resume = staticmethod(
            lambda _: (_ for _ in ()).throw(ValueError("parse failed"))
        )
        uploaded = UploadFile(filename="resume.pdf", file=BytesIO(b"%PDF-new"))

        with self.assertRaises(HTTPException) as error:
            await profile_router.upload_resume(uploaded)

        # A parser-reported ValueError is a rejected upload, not a server fault.
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(resume_path.read_bytes(), b"%PDF-old")
        self.assertEqual(list(self.data_dir.glob("resume-*.pdf")), [])

    async def test_successful_resume_upload_promotes_private_file_after_parse(self):
        parsed_profile = UserProfile.model_validate({"personal": {"first_name": "Ada"}})
        profile_router.ResumeParser.parse_resume = staticmethod(lambda _: parsed_profile)
        uploaded = UploadFile(filename="resume.pdf", file=BytesIO(b"%PDF-new"))

        response = await profile_router.upload_resume(uploaded)
        resume_path = self.data_dir / "resume.pdf"

        self.assertEqual(response["status"], "success")
        self.assertEqual(resume_path.read_bytes(), b"%PDF-new")
        self.assertEqual(resume_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.data_dir.stat().st_mode & 0o777, 0o700)
