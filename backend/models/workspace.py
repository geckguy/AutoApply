"""Models for the local job-search workspace.

These models are deliberately additive: the original ``Application`` model and
``/api/applications`` API remain supported for installed extensions.
"""

from datetime import datetime
from typing import Any, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field


OpportunityStatus = Literal[
    "draft", "saved", "preparing", "ready_to_review", "submitted", "applied",
    "interview", "negotiating", "offer", "accepted", "rejected", "withdrawn",
    "no_response", "archived",
]

FieldPolicyAction = Literal[
    "fill", "select", "check", "skip", "ask", "always", "fixed", "never", "ask_every_time"
]


class OpportunityUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    company: str = Field(min_length=1, max_length=500)
    role: str = Field(min_length=1, max_length=500)
    url: Optional[str] = Field(default=None, max_length=4096)
    platform: Optional[str] = Field(default=None, max_length=100)
    page_title: Optional[str] = Field(default=None, max_length=1000)
    job_description_snippet: Optional[str] = Field(default=None, max_length=10_000)
    status: OpportunityStatus = "draft"
    source: Optional[str] = Field(default=None, max_length=100)
    fit_score: Optional[int] = Field(default=None, ge=0, le=100)
    job_description: Optional[str] = Field(default=None, max_length=100_000)
    notes: Optional[str] = Field(default=None, max_length=20_000)
    resume_version_id: Optional[str] = Field(default=None, max_length=100)
    target_date: Optional[str] = Field(default=None, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Duplicate handling is resolved client-side before the write; these two
    # fields steer that decision and are never persisted.
    duplicate_resolution: Optional[str] = Field(default=None, max_length=100)
    existing_id: Optional[str] = Field(default=None, max_length=100)


class OpportunityPatch(BaseModel):
    company: Optional[str] = Field(default=None, min_length=1, max_length=500)
    role: Optional[str] = Field(default=None, min_length=1, max_length=500)
    url: Optional[str] = Field(default=None, max_length=4096)
    platform: Optional[str] = Field(default=None, max_length=100)
    page_title: Optional[str] = Field(default=None, max_length=1000)
    job_description_snippet: Optional[str] = Field(default=None, max_length=10_000)
    status: Optional[OpportunityStatus] = None
    source: Optional[str] = Field(default=None, max_length=100)
    fit_score: Optional[int] = Field(default=None, ge=0, le=100)
    job_description: Optional[str] = Field(default=None, max_length=100_000)
    notes: Optional[str] = Field(default=None, max_length=20_000)
    resume_version_id: Optional[str] = Field(default=None, max_length=100)
    target_date: Optional[str] = Field(default=None, max_length=64)
    metadata: Optional[dict[str, Any]] = None


class ResumeVersionUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    filename: str = Field(min_length=1, max_length=500)
    label: Optional[str] = Field(default=None, max_length=500)
    sha256: str = Field(min_length=16, max_length=128)
    storage_path: Optional[str] = Field(default=None, max_length=4096)
    profile_snapshot: dict[str, Any] = Field(default_factory=dict)
    make_active: bool = True
    is_default: Optional[bool] = None
    tailoring: dict[str, Any] = Field(default_factory=dict)


class AnswerVaultUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    question: str = Field(min_length=1, max_length=10_000)
    answer: str = Field(min_length=1, max_length=50_000)
    question_type: Optional[str] = Field(default=None, max_length=100)
    company: Optional[str] = Field(default=None, max_length=500)
    role: Optional[str] = Field(default=None, max_length=500)
    platform: Optional[str] = Field(default=None, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field(default="user", max_length=100)
    approved: bool = False


class FieldPolicyUpsert(BaseModel):
    field_key: str = Field(min_length=1, max_length=500)
    action: FieldPolicyAction = "ask"
    value: Optional[Any] = None
    confidence: Literal["high", "medium", "low"] = "high"
    scope: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class LearnedMappingUpsert(BaseModel):
    field_fingerprint: str = Field(min_length=1, max_length=1000)
    field_label: Optional[str] = Field(default=None, max_length=2000)
    input_type: Optional[str] = Field(default=None, max_length=100)
    source_path: Optional[str] = Field(default=None, max_length=1000)
    value: Any
    confidence: Literal["high", "medium", "low"] = "high"
    evidence_increment: int = Field(default=1, ge=1, le=100)


class ApplicationAnswerUpsert(BaseModel):
    field_key: str = Field(min_length=1, max_length=1000)
    question: Optional[str] = Field(default=None, max_length=10_000)
    value: Any
    source: str = Field(default="user", max_length=100)
    confidence: Literal["high", "medium", "low"] = "high"
    approved: bool = False
    answer_vault_id: Optional[str] = Field(default=None, max_length=100)


class ApplicationPacketUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    opportunity_id: str = Field(min_length=1, max_length=100)
    stage: Optional[str] = Field(default=None, max_length=100)
    page_url: Optional[str] = Field(default=None, max_length=4096)
    instructions: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)
    field_failures: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)
    resume_version_id: Optional[str] = Field(default=None, max_length=100)
    cover_letter: Optional[str] = Field(default=None, max_length=50_000)
    tailored_resume: Optional[str] = Field(default=None, max_length=100_000)
    form_snapshot: dict[str, Any] = Field(default_factory=dict)
    status: str = Field(default="draft", max_length=100)


class TeachUpsert(BaseModel):
    """A user correction captured from the overlay for future autofills."""

    opportunity_id: Optional[str] = Field(default=None, max_length=100)
    packet_id: Optional[str] = Field(default=None, max_length=100)
    url: Optional[str] = Field(default=None, max_length=4096)
    field: dict[str, Any] = Field(min_length=1)
    proposed_value: Optional[Any] = None
    corrected_value: Optional[Any] = None
    failure_reason: Optional[str] = Field(default=None, max_length=2000)


class PolicyToggle(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    enabled: bool = False
    action: Optional[FieldPolicyAction] = None


class PolicyToggleList(BaseModel):
    policies: list[PolicyToggle] = Field(default_factory=list, max_length=500)


class SubmissionReceiptCreate(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    submitted_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    confirmation_code: Optional[str] = Field(default=None, max_length=1000)
    confirmation_url: Optional[str] = Field(default=None, max_length=4096)
    screenshot_path: Optional[str] = Field(default=None, max_length=4096)
    details: dict[str, Any] = Field(default_factory=dict)


class ContactUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str = Field(min_length=1, max_length=500)
    email: Optional[str] = Field(default=None, max_length=500)
    phone: Optional[str] = Field(default=None, max_length=100)
    title: Optional[str] = Field(default=None, max_length=500)
    relationship: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = Field(default=None, max_length=20_000)


class FollowUpUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    contact_id: Optional[str] = Field(default=None, max_length=100)
    due_at: str = Field(min_length=1, max_length=64)
    kind: str = Field(default="follow_up", max_length=100)
    notes: Optional[str] = Field(default=None, max_length=20_000)
    completed_at: Optional[str] = Field(default=None, max_length=64)


class InterviewUpsert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    scheduled_at: str = Field(min_length=1, max_length=64)
    interview_type: str = Field(default="interview", max_length=100)
    timezone: Optional[str] = Field(default=None, max_length=100)
    location: Optional[str] = Field(default=None, max_length=1000)
    interviewer_names: list[str] = Field(default_factory=list, max_length=20)
    notes: Optional[str] = Field(default=None, max_length=20_000)
    outcome: Optional[str] = Field(default=None, max_length=200)
