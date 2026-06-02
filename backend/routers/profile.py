"""Profile management endpoints — resume upload, knowledge file, profile CRUD."""

import json
import logging
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, UploadFile, HTTPException, Body

from backend.models.profile import UserProfile
from backend.services.resume_parser import ResumeParser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/profile", tags=["profile"])

DATA_DIR = Path(__file__).parent.parent / "data"


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
    with open(profile_path, "w") as f:
        json.dump(profile.model_dump(exclude_none=True), f, indent=2)
    logger.info("Profile saved to disk")


@router.post("/upload-resume")
async def upload_resume(file: UploadFile = File(...)):
    """Upload a PDF resume, parse it, and save the extracted profile.

    The resume is saved to data/resume.pdf and parsed using pdfplumber + Gemini
    to extract structured profile data.
    """
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    # Save the uploaded file
    resume_path = DATA_DIR / "resume.pdf"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 10MB)")

    with open(resume_path, "wb") as f:
        f.write(content)

    logger.info(f"Resume saved: {resume_path} ({len(content)} bytes)")

    # Parse the resume
    try:
        parser = ResumeParser()
        profile = parser.parse_resume(str(resume_path))

        # Merge with existing profile if one exists (preserve manual edits)
        existing = _load_profile()
        if existing:
            profile = _merge_profiles(existing, profile)

        _save_profile(profile)

        return {
            "status": "success",
            "message": "Resume parsed and profile updated",
            "profile": profile.model_dump(exclude_none=True),
        }

    except Exception as e:
        logger.error(f"Resume parsing failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to parse resume: {str(e)}",
        )


@router.post("/upload-knowledge")
async def upload_knowledge(body: dict = Body(...)):
    """Upload or update the knowledge.md file.

    This is a freeform markdown file with additional information about the user
    that supplements the resume (salary expectations, preferences, common Q&A, etc.)
    """
    content = body.get("content", "")
    knowledge_path = DATA_DIR / "knowledge.md"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with open(knowledge_path, "w") as f:
        f.write(content)

    logger.info(f"Knowledge file saved ({len(content)} chars)")

    return {
        "status": "success",
        "message": "Knowledge file updated",
        "size": len(content),
    }


@router.get("/")
async def get_profile():
    """Get the current user profile."""
    profile = _load_profile()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Upload a resume first.",
        )
    return profile.model_dump(exclude_none=True)


@router.put("/")
async def update_profile(updates: dict = Body(...)):
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
async def get_knowledge():
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

    # For personal info, prefer existing non-null values
    for key, value in new_dict.get("personal", {}).items():
        if value is not None:
            existing_val = existing_dict.get("personal", {}).get(key)
            if existing_val is None:
                existing_dict.setdefault("personal", {})[key] = value

    # For list fields (work_experience, education, skills), use the new parsed version
    # since it's from the latest resume
    for list_field in ["work_experience", "education", "skills", "certifications", "languages_spoken"]:
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
