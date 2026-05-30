"""Pydantic models for application tracking and learning."""

from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import datetime
from uuid import uuid4


class Application(BaseModel):
    """A tracked job application."""
    id: str = Field(default_factory=lambda: str(uuid4()))
    company: str
    role: str
    url: str
    platform: Optional[str] = None
    applied_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    fit_score: Optional[int] = None
    status: Literal["applied", "interview", "rejected", "offer", "withdrawn"] = "applied"
    notes: Optional[str] = None
    job_description_snippet: Optional[str] = None


class Correction(BaseModel):
    """A user correction to an auto-filled field — used for learning."""
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())
    field_label: str
    agent_value: str
    user_value: str
    context: Optional[str] = None  # e.g. "workday form, step 2"
    url: Optional[str] = None


class AnswerBankEntry(BaseModel):
    """A previously generated answer stored for variation tracking."""
    company: str
    role: str
    question_type: str  # e.g. "why_interested", "cover_letter", "strength"
    question: str
    answer: str
    date: str = Field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d"))


class DuplicateCheckResult(BaseModel):
    """Result of checking for duplicate applications."""
    is_duplicate: bool
    existing: Optional[Application] = None
