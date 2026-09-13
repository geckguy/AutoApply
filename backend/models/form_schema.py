"""Pydantic models for form field schemas and fill instructions."""

from pydantic import BaseModel, Field
from typing import Optional, Literal


class FormField(BaseModel):
    """A single form field extracted from a web page."""
    id: str = Field(min_length=1, max_length=512)
    type: str = Field(min_length=1, max_length=50)
    label: Optional[str] = Field(default=None, max_length=2_000)
    name: Optional[str] = Field(default=None, max_length=512)
    placeholder: Optional[str] = Field(default=None, max_length=2_000)
    required: bool = False
    value: Optional[str] = Field(default=None, max_length=20_000)
    options: list[str] = Field(default_factory=list, max_length=500)
    accept: Optional[str] = Field(default=None, max_length=500)
    max_length: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    aria_label: Optional[str] = Field(default=None, max_length=2_000)
    group_name: Optional[str] = Field(default=None, max_length=512)


class FormSchema(BaseModel):
    """Complete form schema extracted from a job application page."""
    url: str = Field(min_length=1, max_length=4096)
    platform: Optional[str] = Field(default=None, max_length=100)
    page_title: Optional[str] = Field(default=None, max_length=2_000)
    step: int = Field(default=1, ge=1, le=1_000)
    total_steps: Optional[int] = Field(default=None, ge=1, le=1_000)
    fields: list[FormField] = Field(default_factory=list, max_length=500)
    job_description: Optional[str] = Field(default=None, max_length=100_000)
    opportunity_id: Optional[str] = Field(default=None, max_length=100)
    resume_version_id: Optional[str] = Field(default=None, max_length=100)


class FillInstruction(BaseModel):
    """Instruction for filling a single form field."""
    field_id: str = Field(min_length=1, max_length=512)
    action: Literal["fill", "select", "check", "upload", "skip"]
    value: Optional[str] = Field(default=None, max_length=20_000)
    confidence: Literal["high", "medium", "low"] = "medium"
    source: Optional[str] = Field(default=None, max_length=1_000)
    reason: Optional[str] = Field(default=None, max_length=2_000)
    review_required: bool = False


class FitScore(BaseModel):
    """Job-resume fit analysis result."""
    score: int = Field(ge=0, le=100)
    verdict: str = Field(max_length=500)
    matched_skills: list[str] = Field(default_factory=list, max_length=200)
    missing_skills: list[str] = Field(default_factory=list, max_length=200)
    experience_fit: Optional[str] = Field(default=None, max_length=2_000)
    notes: Optional[str] = Field(default=None, max_length=5_000)
    recommendation: Literal["apply", "stretch", "skip", "unknown"] = "apply"


class FillResponse(BaseModel):
    """Response containing fill instructions and optional fit score."""
    instructions: list[FillInstruction] = Field(default_factory=list, max_length=500)
    fit_score: Optional[FitScore] = None
    duplicate_warning: Optional[str] = Field(default=None, max_length=2_000)
    ai_error: Optional[str] = Field(default=None, max_length=2_000)
    local_count: int = Field(default=0, ge=0, le=500)
    ai_count: int = Field(default=0, ge=0, le=500)
    review_count: int = Field(default=0, ge=0, le=500)
    ready_count: int = Field(default=0, ge=0, le=500)
    skipped_count: int = Field(default=0, ge=0, le=500)
