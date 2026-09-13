"""Pydantic models for application tracking and learning."""

from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import datetime
from uuid import uuid4

ApplicationStatus = Literal[
    "saved", "preparing", "ready_to_review", "applied", "submitted", "interview",
    "negotiating", "offer", "accepted", "rejected", "no_response", "withdrawn", "archived"
]


class Application(BaseModel):
    """A tracked job application."""
    id: str = Field(default_factory=lambda: str(uuid4()))
    company: str = Field(min_length=1, max_length=500)
    role: str = Field(min_length=1, max_length=500)
    url: str = Field(min_length=1, max_length=4096)
    platform: Optional[str] = Field(default=None, max_length=100)
    applied_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    fit_score: Optional[int] = Field(default=None, ge=0, le=100)
    status: ApplicationStatus = "applied"
    notes: Optional[str] = Field(default=None, max_length=20_000)
    job_description_snippet: Optional[str] = Field(default=None, max_length=5_000)


class Correction(BaseModel):
    """A user correction to an auto-filled field — used for learning."""
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())
    field_label: str = Field(min_length=1, max_length=2_000)
    agent_value: str = Field(max_length=20_000)
    user_value: str = Field(max_length=20_000)
    context: Optional[str] = Field(default=None, max_length=1_000)
    url: Optional[str] = Field(default=None, max_length=4096)


class AnswerBankEntry(BaseModel):
    """A previously generated answer stored for variation tracking."""
    company: str = Field(max_length=500)
    role: str = Field(max_length=500)
    question_type: str = Field(max_length=100)
    question: str = Field(max_length=5_000)
    answer: str = Field(max_length=20_000)
    date: str = Field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d"))


class DuplicateCheckResult(BaseModel):
    """Result of checking for duplicate applications."""
    is_duplicate: bool
    existing: Optional[Application] = None


class ApplicationStatusUpdate(BaseModel):
    """Validated application status/notes update."""

    status: ApplicationStatus
    notes: Optional[str] = Field(default=None, max_length=20_000)
