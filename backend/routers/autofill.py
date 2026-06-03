"""Autofill endpoints — form analysis, fill generation, corrections, and job analysis."""

import json
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Body

from backend.models.profile import UserProfile
from backend.models.form_schema import FormSchema, FillResponse, FitScore
from backend.models.application import Correction, AnswerBankEntry
from backend.services.field_mapper import FieldMapper
from backend.services.job_analyzer import JobAnalyzer
from backend.services.answer_generator import AnswerGenerator
from backend.services.database import get_database

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["autofill"])

DATA_DIR = Path(__file__).parent.parent / "data"

# Module-level caches for profile and knowledge to avoid redundant disk reads
_profile_cache = None
_knowledge_cache = None
_profile_mtime = 0
_knowledge_mtime = 0


def _load_profile() -> Optional[UserProfile]:
    """Load the current profile from disk, using cache if file hasn't changed."""
    global _profile_cache, _profile_mtime
    profile_path = DATA_DIR / "profile.json"
    if profile_path.exists():
        current_mtime = profile_path.stat().st_mtime
        if _profile_cache is not None and current_mtime == _profile_mtime:
            return _profile_cache
        with open(profile_path, "r") as f:
            _profile_cache = UserProfile.model_validate(json.load(f))
        _profile_mtime = current_mtime
        return _profile_cache
    return None


def _load_knowledge() -> str:
    """Load the knowledge file content, using cache if file hasn't changed."""
    global _knowledge_cache, _knowledge_mtime
    knowledge_path = DATA_DIR / "knowledge.md"
    if knowledge_path.exists():
        current_mtime = knowledge_path.stat().st_mtime
        if _knowledge_cache is not None and current_mtime == _knowledge_mtime:
            return _knowledge_cache
        with open(knowledge_path, "r") as f:
            _knowledge_cache = f.read()
        _knowledge_mtime = current_mtime
        return _knowledge_cache
    return ""


def _load_corrections() -> list[Correction]:
    """Load recent corrections from the database."""
    db = get_database()
    rows = db.get_recent_corrections(50)
    return [Correction.model_validate(row) for row in rows]


@router.post("/autofill", response_model=FillResponse)
def autofill(form_schema: FormSchema):
    """Generate fill instructions for a form schema.

    Takes the extracted form fields + job description, loads the user's profile,
    knowledge file, and past corrections, then uses Gemini to generate
    intelligent fill instructions with confidence levels.
    """
    profile = _load_profile()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Upload a resume first at /api/profile/upload-resume",
        )

    knowledge = _load_knowledge()
    corrections = _load_corrections()

    # Generate fill instructions
    mapper = FieldMapper()
    response = mapper.map_fields(
        form_schema=form_schema,
        profile=profile,
        knowledge=knowledge,
        corrections=corrections,
    )

    # Save any generated text answers to the answer bank
    _save_generated_answers(form_schema, response)

    logger.info(
        f"Autofill complete: {len(response.instructions)} instructions "
        f"for {form_schema.url}"
    )
    return response


@router.post("/analyze-job", response_model=FitScore)
def analyze_job(body: dict = Body(...)):
    """Analyze a job description and return a fit score.

    Compares the job description against the user's profile to determine
    match quality, missing skills, and a recommendation.
    """
    job_description = body.get("job_description", "")
    if not job_description:
        raise HTTPException(
            status_code=400,
            detail="job_description is required",
        )

    profile = _load_profile()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Upload a resume first.",
        )

    knowledge = _load_knowledge()

    analyzer = JobAnalyzer()
    fit_score = analyzer.analyze_job(
        job_description=job_description,
        profile=profile,
        knowledge=knowledge,
    )

    return fit_score


@router.post("/corrections")
def log_correction(correction: Correction):
    """Log a user correction for learning.

    When the user edits a field value in the review overlay, the correction
    is stored so future autofills can learn from it.
    """
    db = get_database()
    total = db.add_correction(correction.model_dump())

    logger.info(
        f"Correction logged: '{correction.field_label}' "
        f"'{correction.agent_value}' -> '{correction.user_value}'"
    )

    return {"status": "success", "total_corrections": total}


@router.get("/answer-bank")
def get_answer_bank():
    """Get all past generated answers."""
    db = get_database()
    return db.get_answers()


@router.post("/cover-letter")
def generate_cover_letter(body: dict = Body(...)):
    """Generate a tailored cover letter."""
    job_description = body.get("job_description", "")
    company = body.get("company", "")
    role = body.get("role", "")
    
    profile = _load_profile()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Upload a resume first.",
        )
    
    knowledge = _load_knowledge()
    
    from backend.services.cover_letter import CoverLetterGenerator
    letter = CoverLetterGenerator.generate(
        job_description, company, role, profile, knowledge
    )
    return {"cover_letter": letter}


@router.post("/tailor-resume")
def tailor_resume(body: dict = Body(...)):
    """Generate JD-tailored resume suggestions."""
    job_description = body.get("job_description", "")
    if not job_description:
        raise HTTPException(
            status_code=400,
            detail="job_description is required",
        )
    
    profile = _load_profile()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Upload a resume first.",
        )
    
    knowledge = _load_knowledge()
    
    from backend.services.resume_tailor import ResumeTailor
    result = ResumeTailor.tailor(job_description, profile, knowledge)
    return result



def _save_generated_answers(
    form_schema: FormSchema, response: FillResponse
) -> None:
    """Save any generated text answers to the answer bank for variation tracking."""
    db = get_database()

    # Detect company and role from the form schema
    company = _extract_company(form_schema.url, form_schema.page_title or "")
    role = form_schema.page_title or "Unknown Role"

    for instruction in response.instructions:
        # Only save low-confidence text answers (generated content)
        if (
            instruction.action == "fill"
            and instruction.confidence == "low"
            and instruction.value
            and len(instruction.value) > 50  # Only substantial answers
        ):
            # Find the matching field to get the question
            field = next(
                (f for f in form_schema.fields if f.id == instruction.field_id),
                None,
            )
            if field:
                question = field.label or field.placeholder or field.name or ""
                question_type = AnswerGenerator.classify_question(question)

                entry = AnswerBankEntry(
                    company=company,
                    role=role,
                    question_type=question_type,
                    question=question,
                    answer=instruction.value,
                )
                db.add_answer(entry.model_dump())


def _extract_company(url: str, title: str) -> str:
    """Try to extract company name from URL or page title."""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    domain = parsed.hostname or ""

    # Common ATS platforms — company is usually in subdomain
    for ats in ["myworkdayjobs.com", "greenhouse.io", "lever.co", "ashbyhq.com"]:
        if ats in domain:
            parts = domain.split(".")
            if len(parts) > 2:
                return parts[0].replace("-", " ").title()

    # Try from title
    if " - " in title:
        return title.split(" - ")[-1].strip()
    if " at " in title:
        return title.split(" at ")[-1].strip()
    if " | " in title:
        return title.split(" | ")[-1].strip()

    # Fallback to domain
    return domain.split(".")[0].title() if domain else "Unknown"
