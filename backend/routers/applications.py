"""Application tracking endpoints — history, duplicate detection."""

import csv
import io
import logging
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from backend.models.application import Application, DuplicateCheckResult
from backend.services.database import get_database

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/applications", tags=["applications"])


@router.get("/")
async def list_applications(
    limit: int = Query(default=50, ge=1, le=500),
    status: Optional[str] = Query(default=None),
):
    """List all tracked applications.

    Args:
        limit: Maximum number of applications to return (most recent first).
        status: Filter by status (applied, interview, rejected, offer, withdrawn).
    """
    db = get_database()
    apps = db.get_applications(limit=limit, status=status)
    return apps


@router.post("/")
async def log_application(application: Application):
    """Log a completed job application.

    Called by the extension after the user finishes filling a form.
    """
    db = get_database()
    db.add_application(application.model_dump())

    logger.info(
        f"Application logged: {application.company} — {application.role} "
        f"(score: {application.fit_score})"
    )

    # Get total count for the response
    total_apps = db.count_applications()
    return {
        "status": "success",
        "message": f"Application to {application.company} logged",
        "total_applications": total_apps,
    }


@router.get("/check-duplicate", response_model=DuplicateCheckResult)
async def check_duplicate(
    url: str = Query(default=""),
    company: str = Query(default=""),
    role: str = Query(default=""),
):
    """Check if a similar application already exists.

    Checks by URL match or by company+role fuzzy match.

    Args:
        url: The job posting URL to check.
        company: Company name to check.
        role: Role/title to check.
    """
    db = get_database()

    # Check 1: Exact URL match (normalize URLs first)
    if url:
        normalized_url = _normalize_url(url)
        existing = db.check_duplicate_url(normalized_url)
        if existing:
            return DuplicateCheckResult(
                is_duplicate=True,
                existing=Application.model_validate(existing),
            )

    # Check 2: Company + role fuzzy match
    if company and role:
        existing = db.check_duplicate_company_role(company, role)
        if existing:
            return DuplicateCheckResult(
                is_duplicate=True,
                existing=Application.model_validate(existing),
            )

    return DuplicateCheckResult(is_duplicate=False)


@router.put("/{app_id}/status")
async def update_status(app_id: str, body: dict):
    """Update the status of an application.

    Args:
        app_id: The application ID to update.
        body: JSON body with 'status' and optional 'notes'.
    """
    new_status = body.get("status")
    if new_status not in ("applied", "interview", "rejected", "offer", "withdrawn"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status: {new_status}",
        )

    db = get_database()
    notes = body.get("notes")
    found = db.update_application_status(app_id, new_status, notes)

    if not found:
        raise HTTPException(status_code=404, detail=f"Application {app_id} not found")

    return {"status": "success", "message": f"Application {app_id} updated to {new_status}"}


@router.get("/export")
async def export_applications():
    """Export all applications as CSV."""
    db = get_database()
    apps = db.get_applications(limit=10000)

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=[
            "applied_at",
            "company",
            "role",
            "platform",
            "fit_score",
            "status",
            "url",
            "notes",
        ],
    )
    writer.writeheader()
    for app in apps:
        writer.writerow(
            {
                "applied_at": app.get("applied_at", ""),
                "company": app.get("company", ""),
                "role": app.get("role", ""),
                "platform": app.get("platform", ""),
                "fit_score": app.get("fit_score", ""),
                "status": app.get("status", ""),
                "url": app.get("url", ""),
                "notes": app.get("notes", ""),
            }
        )

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=autoapply_applications.csv"},
    )



def _normalize_url(url: str) -> str:
    """Normalize a URL for comparison (strip trailing slashes, query params, fragments)."""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if hostname is None:
        return url.lower().rstrip("/")
    # Keep scheme, host, and path; strip query and fragment
    normalized = f"{parsed.scheme}://{hostname}{parsed.path}".rstrip("/").lower()
    return normalized
