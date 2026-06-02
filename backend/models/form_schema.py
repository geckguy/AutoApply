"""Pydantic models for form field schemas and fill instructions."""

from pydantic import BaseModel, Field
from typing import Optional, Literal


class FormField(BaseModel):
    """A single form field extracted from a web page."""
    id: str
    type: str  # text, email, tel, number, select, textarea, radio, checkbox, file, date, url, password
    label: Optional[str] = None
    name: Optional[str] = None
    placeholder: Optional[str] = None
    required: bool = False
    value: Optional[str] = None
    options: list[str] = Field(default_factory=list)  # For select/radio
    accept: Optional[str] = None  # For file inputs
    max_length: Optional[int] = None
    aria_label: Optional[str] = None
    group_name: Optional[str] = None  # For radio/checkbox groups


class FormSchema(BaseModel):
    """Complete form schema extracted from a job application page."""
    url: str
    platform: Optional[str] = None  # workday, greenhouse, lever, ashby, custom
    page_title: Optional[str] = None
    step: int = 1
    total_steps: Optional[int] = None
    fields: list[FormField] = Field(default_factory=list)
    job_description: Optional[str] = None


class FillInstruction(BaseModel):
    """Instruction for filling a single form field."""
    field_id: str
    action: Literal["fill", "select", "check", "upload", "skip"]
    value: Optional[str] = None
    confidence: Literal["high", "medium", "low"] = "medium"
    source: Optional[str] = None  # Which profile field this came from
    reason: Optional[str] = None  # Why this value was chosen (for skips/low confidence)


class FitScore(BaseModel):
    """Job-resume fit analysis result."""
    score: int = Field(ge=0, le=100)
    verdict: str
    matched_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    experience_fit: Optional[str] = None
    notes: Optional[str] = None
    recommendation: Literal["apply", "stretch", "skip", "unknown"] = "apply"


class FillResponse(BaseModel):
    """Response containing fill instructions and optional fit score."""
    instructions: list[FillInstruction] = Field(default_factory=list)
    fit_score: Optional[FitScore] = None
    duplicate_warning: Optional[str] = None
