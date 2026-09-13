"""Pydantic models for user profile data."""

from pydantic import BaseModel, Field
from typing import Annotated, Any, Optional

# Every free-text profile field is bounded: the profile is written verbatim to
# disk and embedded in paid model prompts, so an oversized paste must be
# rejected instead of inflating the private store.
ShortText = Annotated[str, Field(max_length=200)]


class Address(BaseModel):
    """Physical address."""
    street: Optional[str] = Field(default=None, max_length=500)
    city: Optional[str] = Field(default=None, max_length=200)
    state: Optional[str] = Field(default=None, max_length=200)
    zip: Optional[str] = Field(default=None, max_length=32)
    country: Optional[str] = Field(default=None, max_length=200)


class WorkExperience(BaseModel):
    """A single work experience entry."""
    company: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=500)
    start_date: Optional[str] = Field(default=None, max_length=64)  # YYYY-MM format
    end_date: Optional[str] = Field(default=None, max_length=64)    # YYYY-MM or "present"
    description: Optional[str] = Field(default=None, max_length=20_000)
    technologies: list[ShortText] = Field(default_factory=list, max_length=100)


class Education(BaseModel):
    """A single education entry."""
    institution: str = Field(min_length=1, max_length=500)
    degree: Optional[str] = Field(default=None, max_length=500)
    field: Optional[str] = Field(default=None, max_length=500)
    gpa: Optional[str] = Field(default=None, max_length=64)
    start_date: Optional[str] = Field(default=None, max_length=64)
    end_date: Optional[str] = Field(default=None, max_length=64)


class Language(BaseModel):
    """A spoken language with proficiency level."""
    language: str = Field(min_length=1, max_length=200)
    proficiency: Optional[str] = Field(default=None, max_length=100)  # Native, Fluent, Intermediate, Basic


class LegalInfo(BaseModel):
    """Legal and demographic information for job applications."""
    authorized_to_work: Optional[bool] = None
    sponsorship_required: Optional[bool] = None
    veteran_status: Optional[str] = Field(default=None, max_length=200)
    disability_status: Optional[str] = Field(default=None, max_length=200)
    gender: Optional[str] = Field(default=None, max_length=100)
    ethnicity: Optional[str] = Field(default=None, max_length=200)


class Preferences(BaseModel):
    """Job search preferences."""
    salary_expectation: Optional[str] = Field(default=None, max_length=200)
    notice_period: Optional[str] = Field(default=None, max_length=200)
    start_date: Optional[str] = Field(default=None, max_length=64)
    willing_to_relocate: Optional[bool] = None
    remote_preference: Optional[str] = Field(default=None, max_length=100)  # Remote, Hybrid, On-site


class Project(BaseModel):
    """A personal or professional project."""
    name: str = Field(min_length=1, max_length=500)
    description: Optional[str] = Field(default=None, max_length=20_000)
    technologies: list[ShortText] = Field(default_factory=list, max_length=100)
    url: Optional[str] = Field(default=None, max_length=4096)
    start_date: Optional[str] = Field(default=None, max_length=64)
    end_date: Optional[str] = Field(default=None, max_length=64)


class PersonalInfo(BaseModel):
    """Personal contact information."""
    first_name: Optional[str] = Field(default=None, max_length=200)
    last_name: Optional[str] = Field(default=None, max_length=200)
    email: Optional[str] = Field(default=None, max_length=320)
    phone: Optional[str] = Field(default=None, max_length=50)
    linkedin: Optional[str] = Field(default=None, max_length=500)
    github: Optional[str] = Field(default=None, max_length=500)
    portfolio: Optional[str] = Field(default=None, max_length=500)
    address: Address = Field(default_factory=Address)
    date_of_birth: Optional[str] = Field(default=None, max_length=64)
    nationality: Optional[str] = Field(default=None, max_length=200)
    summary: Optional[str] = Field(default=None, max_length=20_000)


class CommonAnswers(BaseModel):
    """Template answers for common application questions."""
    why_interested: Optional[str] = Field(default=None, max_length=20_000)
    biggest_strength: Optional[str] = Field(default=None, max_length=20_000)
    biggest_weakness: Optional[str] = Field(default=None, max_length=20_000)
    cover_letter_template: Optional[str] = Field(default=None, max_length=50_000)
    custom: dict[str, Any] = Field(default_factory=dict, max_length=100)


class UserProfile(BaseModel):
    """Complete user profile for job applications."""
    personal: PersonalInfo = Field(default_factory=PersonalInfo)
    work_experience: list[WorkExperience] = Field(default_factory=list, max_length=100)
    education: list[Education] = Field(default_factory=list, max_length=50)
    skills: list[ShortText] = Field(default_factory=list, max_length=500)
    certifications: list[ShortText] = Field(default_factory=list, max_length=200)
    projects: list[Project] = Field(default_factory=list, max_length=100)
    languages_spoken: list[Language] = Field(default_factory=list, max_length=50)
    legal: LegalInfo = Field(default_factory=LegalInfo)
    preferences: Preferences = Field(default_factory=Preferences)
    common_answers: CommonAnswers = Field(default_factory=CommonAnswers)
