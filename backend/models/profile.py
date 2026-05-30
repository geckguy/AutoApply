"""Pydantic models for user profile data."""

from pydantic import BaseModel, Field
from typing import Optional, Any


class Address(BaseModel):
    """Physical address."""
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    country: Optional[str] = None


class WorkExperience(BaseModel):
    """A single work experience entry."""
    company: str
    title: str
    start_date: Optional[str] = None  # YYYY-MM format
    end_date: Optional[str] = None    # YYYY-MM or "present"
    description: Optional[str] = None
    technologies: list[str] = Field(default_factory=list)


class Education(BaseModel):
    """A single education entry."""
    institution: str
    degree: Optional[str] = None
    field: Optional[str] = None
    gpa: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class Language(BaseModel):
    """A spoken language with proficiency level."""
    language: str
    proficiency: Optional[str] = None  # Native, Fluent, Intermediate, Basic


class LegalInfo(BaseModel):
    """Legal and demographic information for job applications."""
    authorized_to_work: Optional[bool] = None
    sponsorship_required: Optional[bool] = None
    veteran_status: Optional[str] = None
    disability_status: Optional[str] = None
    gender: Optional[str] = None
    ethnicity: Optional[str] = None


class Preferences(BaseModel):
    """Job search preferences."""
    salary_expectation: Optional[str] = None
    notice_period: Optional[str] = None
    start_date: Optional[str] = None
    willing_to_relocate: Optional[bool] = None
    remote_preference: Optional[str] = None  # Remote, Hybrid, On-site


class Project(BaseModel):
    """A personal or professional project."""
    name: str
    description: Optional[str] = None
    technologies: list[str] = Field(default_factory=list)
    url: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class PersonalInfo(BaseModel):
    """Personal contact information."""
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    linkedin: Optional[str] = None
    github: Optional[str] = None
    portfolio: Optional[str] = None
    address: Address = Field(default_factory=Address)
    date_of_birth: Optional[str] = None
    nationality: Optional[str] = None
    summary: Optional[str] = None


class CommonAnswers(BaseModel):
    """Template answers for common application questions."""
    why_interested: Optional[str] = None
    biggest_strength: Optional[str] = None
    biggest_weakness: Optional[str] = None
    cover_letter_template: Optional[str] = None
    custom: dict[str, Any] = Field(default_factory=dict)


class UserProfile(BaseModel):
    """Complete user profile for job applications."""
    personal: PersonalInfo = Field(default_factory=PersonalInfo)
    work_experience: list[WorkExperience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    languages_spoken: list[Language] = Field(default_factory=list)
    legal: LegalInfo = Field(default_factory=LegalInfo)
    preferences: Preferences = Field(default_factory=Preferences)
    common_answers: CommonAnswers = Field(default_factory=CommonAnswers)
