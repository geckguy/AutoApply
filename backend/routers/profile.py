"""Profile management endpoints — resume upload, knowledge file, profile CRUD."""

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, UploadFile, HTTPException, Body
from starlette.concurrency import run_in_threadpool

from backend.models.profile import UserProfile
from backend.models.requests import KnowledgeUpdate
from backend.services.llm_client import (
    LLMResponseError,
    ProviderBusy,
    ProviderNotConfigured,
    inspect_provider_configuration,
)
from backend.services.resume_parser import ResumeParser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/profile", tags=["profile"])

DATA_DIR = Path(__file__).parent.parent / "data"
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def _ensure_data_dir() -> None:
    """Create the local data directory with owner-only permissions."""
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
    # mkdir does not change permissions on an existing directory.
    os.chmod(DATA_DIR, PRIVATE_DIR_MODE)


def _atomic_write_text(path: Path, content: str) -> None:
    """Durably replace a private text file without leaving partial contents."""
    _ensure_data_dir()
    fd, temp_name = tempfile.mkstemp(dir=DATA_DIR, prefix=f".{path.name}-")
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, PRIVATE_FILE_MODE)
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, path)
        os.chmod(path, PRIVATE_FILE_MODE)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _load_profile() -> Optional[UserProfile]:
    """Load the current profile from disk."""
    profile_path = DATA_DIR / "profile.json"
    if profile_path.exists():
        with open(profile_path, "r") as f:
            data = json.load(f)
        return UserProfile.model_validate(data)
    return None


def _save_profile(profile: UserProfile) -> None:
    """Save a profile to disk."""
    profile_path = DATA_DIR / "profile.json"
    content = json.dumps(profile.model_dump(exclude_none=True), indent=2)
    _atomic_write_text(profile_path, content)
    logger.info("Profile saved to disk")


@router.post("/upload-resume")
async def upload_resume(file: UploadFile = File(...)):
    """Upload a PDF resume, parse it, and save the extracted profile.

    The resume is saved to data/resume.pdf and parsed using pdfplumber + the
    configured AI provider.
    to extract structured profile data.
    """
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    resume_path = DATA_DIR / "resume.pdf"
    _ensure_data_dir()

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded PDF is empty")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 10MB)")
    if not content.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF")

    # Parsing needs the AI provider. Check before the upload is processed so a
    # misconfiguration reports itself instead of looking like a broken PDF.
    provider = inspect_provider_configuration()
    if not provider["configured"]:
        raise HTTPException(
            status_code=503,
            detail=f"Resume parsing needs an AI provider. {provider['error']}",
        )

    temp_fd, temp_name = tempfile.mkstemp(
        dir=DATA_DIR,
        prefix="resume-",
        suffix=".pdf",
    )
    temp_path = Path(temp_name)
    try:
        # Parse a private temporary file first so a failed upload cannot replace
        # the user's existing resume.
        with os.fdopen(temp_fd, "wb") as temp_file:
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.chmod(temp_path, PRIVATE_FILE_MODE)

        parser = ResumeParser()
        profile = await run_in_threadpool(parser.parse_resume, str(temp_path))

        # Merge with existing profile if one exists (preserve manual edits)
        existing = _load_profile()
        if existing:
            profile = _merge_profiles(existing, profile)

        await run_in_threadpool(_save_profile, profile)
        os.replace(temp_path, resume_path)
        os.chmod(resume_path, PRIVATE_FILE_MODE)
        logger.info("Resume parsed and promoted (%d bytes)", len(content))

        return {
            "status": "success",
            "message": "Resume parsed and profile updated",
            "profile": profile.model_dump(exclude_none=True),
        }

    except (ProviderNotConfigured, ProviderBusy, LLMResponseError):
        # Provider problems have their own HTTP mapping; do not blame the PDF.
        raise
    except ValueError as error:
        logger.warning("Resume rejected: %s", error)
        raise HTTPException(status_code=400, detail=str(error))
    except Exception:
        logger.exception("Resume parsing failed")
        raise HTTPException(
            status_code=500,
            detail="Failed to parse resume",
        )
    finally:
        # os.replace removes the temporary path on success; on failure this
        # guarantees no unparsed resume is retained.
        if temp_path.exists():
            temp_path.unlink()


@router.post("/upload-knowledge")
def upload_knowledge(body: KnowledgeUpdate):
    """Upload or update the knowledge.md file.

    This is a freeform markdown file with additional information about the user
    that supplements the resume (salary expectations, preferences, common Q&A, etc.)
    """
    content = body.content
    knowledge_path = DATA_DIR / "knowledge.md"
    _atomic_write_text(knowledge_path, content)

    logger.info(f"Knowledge file saved ({len(content)} chars)")

    return {
        "status": "success",
        "message": "Knowledge file updated",
        "size": len(content),
    }


@router.get("/")
def get_profile():
    """Get the current user profile."""
    profile = _load_profile()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Upload a resume first.",
        )
    return profile.model_dump(exclude_none=True)


@router.put("/")
def update_profile(updates: dict = Body(...)):
    """Update specific fields in the profile.

    Accepts a partial profile JSON and merges it with the existing profile.
    """
    existing = _load_profile()
    if not existing:
        # Create a new profile from the updates
        existing = UserProfile()

    # Deep merge the updates into the existing profile
    existing_dict = existing.model_dump()
    _deep_merge(existing_dict, updates)

    try:
        updated = UserProfile.model_validate(existing_dict)
        _save_profile(updated)
        return {
            "status": "success",
            "message": "Profile updated",
            "profile": updated.model_dump(exclude_none=True),
        }
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid profile data: {str(e)}",
        )


@router.get("/knowledge")
def get_knowledge():
    """Get the current knowledge file content."""
    knowledge_path = DATA_DIR / "knowledge.md"
    if not knowledge_path.exists():
        return {"content": ""}
    with open(knowledge_path, "r") as f:
        return {"content": f.read()}


def _merge_profiles(existing: UserProfile, new: UserProfile) -> UserProfile:
    """Merge a newly parsed profile with existing data.

    Prefers existing values for fields that were manually set,
    but adds new information from the parsed resume.
    """
    existing_dict = existing.model_dump()
    new_dict = new.model_dump()

    # For personal info, prefer existing non-empty values. Address is nested,
    # so merge its individual fields rather than treating its default dict as
    # a manually supplied value.
    for key, value in new_dict.get("personal", {}).items():
        if key == "address" and isinstance(value, dict):
            existing_address = existing_dict.setdefault("personal", {}).setdefault("address", {})
            for address_key, address_value in value.items():
                if address_value is not None and not existing_address.get(address_key):
                    existing_address[address_key] = address_value
        elif value is not None:
            existing_val = existing_dict.get("personal", {}).get(key)
            if not existing_val:
                existing_dict.setdefault("personal", {})[key] = value

    # For list fields (work_experience, education, skills), use the new parsed version
    # since it's from the latest resume
    for list_field in [
        "work_experience",
        "education",
        "skills",
        "certifications",
        "projects",
        "languages_spoken",
    ]:
        if new_dict.get(list_field):
            existing_dict[list_field] = new_dict[list_field]

    # For legal, preferences, common_answers — keep existing (these are manual)
    return UserProfile.model_validate(existing_dict)


def _deep_merge(base: dict, updates: dict) -> None:
    """Recursively merge updates into base dict (in-place)."""
    for key, value in updates.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
