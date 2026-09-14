"""Unified preparation, submission-receipt, and follow-up workspace API."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.models.profile import UserProfile
from backend.models.workspace import (
    AnswerVaultUpsert,
    ApplicationPacketUpsert,
    ContactUpsert,
    FieldPolicyUpsert,
    FollowUpUpsert,
    InterviewUpsert,
    OpportunityPatch,
    OpportunityUpsert,
    PolicyToggleList,
    TeachUpsert,
)
from backend.services.database import Database, get_database
from backend.services.resume_documents import ResumeDocumentGenerator, apply_tailoring
from backend.services.resume_tailor import ResumeTailor


router = APIRouter(prefix="/api/workspace", tags=["workspace"])
DATA_DIR = Path(__file__).parent.parent / "data"
RESUME_VERSION_DIR = DATA_DIR / "resume_versions"


class TailorResumeRequest(BaseModel):
    job_description: str = Field(min_length=20, max_length=100_000)
    label: str = Field(default="Tailored resume", min_length=1, max_length=200)
    opportunity_id: str | None = Field(default=None, max_length=100)


def _profile() -> UserProfile:
    path = DATA_DIR / "profile.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Upload a resume before creating versions.")
    try:
        return UserProfile.model_validate(json.loads(path.read_text()))
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail="The saved profile could not be loaded.") from error


def _knowledge() -> str:
    path = DATA_DIR / "knowledge.md"
    return path.read_text() if path.exists() else ""


def _with_resume_aliases(item: dict) -> dict:
    result = dict(item)
    result["name"] = result.get("label") or result.get("filename")
    result["active"] = bool(result.get("is_default"))
    return result


def _ensure_master_resume(db: Database) -> None:
    if db.list_resume_versions():
        return
    source = DATA_DIR / "resume.pdf"
    if not source.exists():
        return
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    profile_path = DATA_DIR / "profile.json"
    snapshot = json.loads(profile_path.read_text()) if profile_path.exists() else {}
    db.upsert_resume_version(
        {
            "id": f"master-{digest[:16]}", "filename": "resume.pdf", "label": "Master resume",
            "sha256": digest, "storage_path": str(source), "profile_snapshot": snapshot,
            "artifacts": {"pdf_path": str(source)}, "make_active": True,
        }
    )


def _ensure_default_policies(db: Database) -> None:
    if db.list_policies():
        return
    # Labels and descriptions are shown in the dashboard's fill-rules list, so
    # they stay in plain language; the keys and actions underneath do not change.
    defaults = [
        ("email", "Contact information", "always", "Fills in from the details you saved."),
        ("authorized_to_work", "Work authorization", "ask_every_time", "Asks you first every time."),
        ("sponsorship_required", "Visa sponsorship", "ask_every_time", "Asks you first every time."),
        ("gender", "Questions about you", "ask_every_time", "Never guessed. Asks you first."),
        ("salary_expectation", "Salary expectations", "ask_every_time", "Asks you first every time."),
    ]
    for key, label, action, description in defaults:
        db.upsert_policy(
            {"id": key, "field_key": key, "label": label, "description": description,
             "action": action, "value": None, "confidence": "high", "scope": {}, "enabled": True}
        )


@router.get("/overview")
def overview():
    db = get_database()
    _ensure_master_resume(db)
    _ensure_default_policies(db)
    return db.workspace_overview()


@router.get("/opportunities")
def list_opportunities(
    limit: int = Query(default=100, ge=1, le=500),
    status: str | None = Query(default=None, max_length=500),
    search: str | None = Query(default=None, max_length=500),
    sort: str = Query(default="updated_desc", pattern="^(updated_desc|created_desc|fit_desc|target_asc)$"),
):
    return {"opportunities": get_database().list_opportunities(limit, status=status, search=search, sort=sort)}


@router.get("/duplicates")
def duplicate_opportunities(
    url: str = Query(default="", max_length=4096),
    company: str = Query(default="", max_length=500),
    role: str = Query(default="", max_length=500),
):
    matches = get_database().find_duplicate_opportunities(url=url, company=company, role=role)
    return {"is_duplicate": bool(matches), "matches": matches}


@router.post("/opportunities/upsert")
def upsert_opportunity(body: OpportunityUpsert):
    payload = body.model_dump(exclude_unset=True)
    company = str(payload.get("company") or "Unknown").strip()[:500]
    role = str(payload.get("role") or payload.get("page_title") or "Unknown").strip()[:500]
    url = str(payload.get("url") or "").strip()[:4096]
    db = get_database()
    resolution = str(payload.get("duplicate_resolution") or "").casefold()
    existing_id = str(payload.get("existing_id") or "").strip()
    if resolution == "reuse":
        existing = db.get_opportunity(existing_id)
        if not existing:
            raise HTTPException(status_code=404, detail="The selected tracked application no longer exists")
        changes = {
            key: value for key, value in {
                "company": company, "role": role, "url": url, "platform": payload.get("platform"),
                "page_title": payload.get("page_title"), "job_description": payload.get("job_description"),
                "job_description_snippet": payload.get("job_description_snippet"), "source": payload.get("source"),
            }.items() if value not in (None, "")
        }
        opportunity = db.patch_opportunity(existing_id, changes) or existing
        return {"opportunity": opportunity, "opportunity_id": opportunity["id"], "reused": True}

    existing = None
    if resolution != "create_new":
        existing = next(
            (item for item in db.list_opportunities(500) if url and db._normalize_url(item.get("url") or "") == db._normalize_url(url)),
            None,
        )
    payload = {
        **payload,
        "id": str((existing or {}).get("id") or payload.get("id") or uuid4()),
        "company": company or "Unknown", "role": role or "Unknown", "url": url,
        "status": payload.get("status") or (existing or {}).get("status") or "draft",
    }
    payload.pop("duplicate_resolution", None)
    payload.pop("existing_id", None)
    opportunity = db.upsert_opportunity(payload)
    return {"opportunity": opportunity, "opportunity_id": opportunity["id"], "reused": bool(existing)}


@router.get("/opportunities/{opportunity_id}")
def get_opportunity(opportunity_id: str):
    item = get_database().get_opportunity(opportunity_id)
    if not item:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return item


@router.patch("/opportunities/{opportunity_id}")
def patch_opportunity(opportunity_id: str, body: OpportunityPatch):
    item = get_database().patch_opportunity(opportunity_id, body.model_dump(exclude_unset=True))
    if not item:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return item


@router.get("/policy")
def page_policy(url: str = "", platform: str = ""):
    db = get_database()
    _ensure_default_policies(db)
    policies = db.get_field_policies()
    review = [policy for policy in policies if policy.get("action") in {"ask", "ask_every_time", "skip", "never"}]
    return {
        "policy": {
            "allow_autopilot": True,
            "message": f"{len(review)} field categories require review" if review else "Verified fields can be filled automatically",
            "url": url, "platform": platform, "fields": policies,
        }
    }


@router.get("/policies")
def list_policies():
    db = get_database()
    _ensure_default_policies(db)
    return {"policies": db.list_policies()}


@router.post("/policies")
def save_policy(body: FieldPolicyUpsert):
    return get_database().upsert_policy(body.model_dump())


@router.put("/policies")
def update_policy_toggles(payload: PolicyToggleList):
    return {"policies": get_database().set_policies_enabled(
        [item.model_dump(exclude_none=True) for item in payload.policies]
    )}


@router.get("/resume-versions")
def resume_versions():
    db = get_database()
    _ensure_master_resume(db)
    versions = [_with_resume_aliases(item) for item in db.list_resume_versions()]
    return {"versions": versions, "resumes": versions}


@router.post("/resume-versions/tailor")
def tailor_resume_version(body: TailorResumeRequest):
    profile = _profile()
    tailoring = ResumeTailor.tailor(body.job_description, profile, _knowledge())
    tailored_profile = apply_tailoring(profile, tailoring)
    version_id = str(uuid4())
    artifacts = ResumeDocumentGenerator(RESUME_VERSION_DIR).render(tailored_profile, version_id, body.label)
    pdf_path = Path(artifacts["pdf_path"])
    item = get_database().upsert_resume_version(
        {
            "id": version_id, "filename": pdf_path.name, "label": body.label,
            "sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest(), "storage_path": str(pdf_path),
            "artifacts": artifacts, "profile_snapshot": tailored_profile.model_dump(mode="json"), "make_active": True,
        }
    )
    if body.opportunity_id:
        get_database().patch_opportunity(body.opportunity_id, {"resume_version_id": item["id"]})
    return {"version": _with_resume_aliases(item), "tailoring": tailoring}


@router.patch("/resume-versions/{version_id}")
@router.patch("/resumes/{version_id}")
def patch_resume_version(version_id: str, payload: dict[str, Any] = Body(...)):
    item = get_database().set_resume_default(version_id, bool(payload.get("is_default", payload.get("active", True))))
    if not item:
        raise HTTPException(status_code=404, detail="Resume version not found")
    return _with_resume_aliases(item)


@router.get("/resume-versions/{version_id}/download")
def download_resume_version(version_id: str, format: str = Query(default="pdf", pattern="^(pdf|docx)$")):
    item = get_database().get_resume_version(version_id)
    if not item:
        raise HTTPException(status_code=404, detail="Resume version not found")
    artifacts = item.get("artifacts") or {}
    selected = artifacts.get(f"{format}_path") or (item.get("storage_path") if format == "pdf" else None)
    if not selected:
        raise HTTPException(status_code=404, detail=f"This resume has no {format.upper()} artifact")
    path = Path(selected).resolve()
    if not path.is_relative_to(DATA_DIR.resolve()) or not path.is_file():
        raise HTTPException(status_code=404, detail="Resume artifact is unavailable")
    media_type = "application/pdf" if format == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.post("/application-packets")
def save_application_packet(payload: ApplicationPacketUpsert):
    item = payload.model_dump(exclude_unset=True)
    item["id"] = payload.id
    if not get_database().get_opportunity(item["opportunity_id"]):
        raise HTTPException(status_code=404, detail="Opportunity not found")
    packet = get_database().upsert_packet(item)
    return {"packet": packet, "packet_id": packet["id"]}


@router.post("/teaches")
def save_teach(payload: TeachUpsert):
    field = payload.field
    label = str(field.get("label") or field.get("id") or "unknown")
    mapping = get_database().upsert_learned_mapping(
        {
            "field_label": label, "input_type": field.get("type"), "url": payload.url,
            "value": payload.corrected_value, "confidence": "high",
        }
    )
    return {"teach": mapping}


@router.post("/submissions/confirm")
def confirm_submission(payload: dict[str, Any] = Body(...)):
    if payload.get("user_confirmed") is not True:
        raise HTTPException(status_code=422, detail="Submission receipts require explicit user confirmation")
    receipt = payload.get("receipt") if isinstance(payload.get("receipt"), dict) else {}
    item = {
        "id": str(uuid4()), "opportunity_id": payload.get("opportunity_id"), "packet_id": payload.get("packet_id"),
        "submitted_at": payload.get("submitted_at"), "confirmation_code": receipt.get("confirmation_code"),
        "confirmation_url": receipt.get("url"), "details": {"title": receipt.get("title"), "confirmation_text": receipt.get("confirmation_text")},
        "user_confirmed": True,
    }
    if not item["opportunity_id"] or not get_database().get_opportunity(str(item["opportunity_id"])):
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return {"receipt": get_database().add_receipt(item)}


@router.get("/applications/{application_id}/packet")
def application_packet(application_id: str):
    db = get_database()
    opportunity = db.get_opportunity(application_id)
    application = db.get_application_by_id(application_id)
    if not opportunity and not application:
        raise HTTPException(status_code=404, detail="Application not found")
    related = db.related_records(application_id)
    latest_packet = db.get_latest_packet(application_id)
    resume = None
    resume_id = (latest_packet or {}).get("resume_version_id") or (opportunity or {}).get("resume_version_id")
    if resume_id:
        resume = db.get_resume_version(str(resume_id))
    return {
        "application": opportunity or application, "opportunity": opportunity,
        "job_description": (opportunity or {}).get("job_description") or (application or {}).get("job_description_snippet"),
        "notes": (opportunity or {}).get("notes") or (application or {}).get("notes"),
        "packet": latest_packet,
        "resume": _with_resume_aliases(resume) if resume else None,
        "answers": db.get_application_answers(application_id),
        "receipt": db.get_latest_receipt(application_id),
        "failures": (latest_packet or {}).get("field_failures", []),
        **related,
    }


@router.post("/applications/{application_id}/receipt")
def dashboard_receipt(application_id: str, payload: dict[str, Any] = Body(...)):
    db = get_database()
    opportunity = db.get_opportunity(application_id)
    if not opportunity:
        application = db.get_application_by_id(application_id)
        if not application:
            raise HTTPException(status_code=404, detail="Application not found")
        db.upsert_opportunity({**application, "source": "dashboard", "job_description": application.get("job_description_snippet")})
    item = {
        "id": str(uuid4()), "opportunity_id": application_id,
        "packet_id": (db.get_latest_packet(application_id) or {}).get("id"),
        "submitted_at": payload.get("confirmed_at") or datetime.now(timezone.utc).isoformat(),
        "details": {"source": "dashboard"}, "user_confirmed": True,
    }
    return {"receipt": db.add_receipt(item)}


@router.post("/applications/{application_id}/relationships")
def add_relationship(application_id: str, payload: dict[str, Any] = Body(...)):
    db = get_database()
    if not (db.get_opportunity(application_id) or db.get_application_by_id(application_id)):
        raise HTTPException(status_code=404, detail="Application not found")
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A relationship name is required")
    if payload.get("type") == "interview":
        item = {
            "id": str(uuid4()), "opportunity_id": application_id,
            "scheduled_at": payload.get("scheduled_at") or datetime.now(timezone.utc).isoformat(),
            "interview_type": "interview", "interviewer_names": [name], "notes": payload.get("notes"),
        }
        return {"interview": db.add_interview(item)}
    item = {**payload, "id": str(uuid4()), "opportunity_id": application_id, "relationship": payload.get("type", "contact")}
    return {"contact": db.add_contact(item)}


@router.post("/applications/{application_id}/follow-ups")
def add_follow_up(application_id: str, payload: dict[str, Any] = Body(...)):
    db = get_database()
    if not (db.get_opportunity(application_id) or db.get_application_by_id(application_id)):
        raise HTTPException(status_code=404, detail="Application not found")
    if not payload.get("due_at"):
        raise HTTPException(status_code=422, detail="A follow-up due date is required")
    item = {**payload, "id": str(uuid4()), "opportunity_id": application_id, "notes": payload.get("notes") or payload.get("note")}
    return {"follow_up": db.add_follow_up(item)}


@router.patch("/follow-ups/{follow_up_id}")
def patch_follow_up(follow_up_id: str, payload: dict[str, Any] = Body(...)):
    changes = {
        key: value for key, value in payload.items()
        if key in {"due_at", "kind", "notes", "completed_at"}
    }
    if payload.get("completed") is True and "completed_at" not in changes:
        changes["completed_at"] = datetime.now(timezone.utc).isoformat()
    if payload.get("completed") is False:
        changes["completed_at"] = None
    item = get_database().update_follow_up(follow_up_id, changes)
    if not item:
        raise HTTPException(status_code=404, detail="Follow-up not found")
    return {"follow_up": item}


@router.post("/applications/{application_id}/interviews")
def add_interview(application_id: str, body: InterviewUpsert):
    db = get_database()
    if not (db.get_opportunity(application_id) or db.get_application_by_id(application_id)):
        raise HTTPException(status_code=404, detail="Application not found")
    return {"interview": db.add_interview({**body.model_dump(), "opportunity_id": application_id})}


@router.get("/answer-vault")
def answer_vault(limit: int = Query(default=100, ge=1, le=500)):
    return {"answers": get_database().list_answer_vault(limit)}


@router.post("/answer-vault")
def save_answer(body: AnswerVaultUpsert):
    return {"answer": get_database().upsert_answer_vault(body.model_dump())}


@router.patch("/answer-vault/{answer_id}")
def patch_answer(answer_id: str, payload: dict[str, Any] = Body(...)):
    answer = get_database().patch_answer_vault(answer_id, payload)
    if not answer:
        raise HTTPException(status_code=404, detail="Saved answer not found")
    return {"answer": answer}
