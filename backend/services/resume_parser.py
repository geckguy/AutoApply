"""Resume parsing service — extracts text from PDF and structures it via Gemini."""

import logging
from pathlib import Path
from typing import Optional

import pdfplumber

from backend.models.profile import UserProfile
from backend.services.gemini import get_gemini_client

logger = logging.getLogger(__name__)


class ResumeParser:
    """Parses PDF resumes into structured profile data."""

    @staticmethod
    def extract_text(pdf_path: str) -> str:
        """Extract all text content from a PDF file.

        Args:
            pdf_path: Path to the PDF file.

        Returns:
            Concatenated text from all pages.
        """
        text_parts = []
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages):
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
                    logger.debug(f"Extracted {len(page_text)} chars from page {i + 1}")

        full_text = "\n\n".join(text_parts)
        logger.info(
            f"Extracted {len(full_text)} total characters from {len(text_parts)} pages"
        )
        return full_text

    @staticmethod
    def parse_resume(pdf_path: str) -> UserProfile:
        """Parse a PDF resume into a structured UserProfile.

        Extracts raw text from the PDF, then uses Gemini to structure it
        into the UserProfile JSON schema.

        Args:
            pdf_path: Path to the PDF resume.

        Returns:
            Parsed UserProfile with all extractable information.
        """
        # Extract raw text
        raw_text = ResumeParser.extract_text(pdf_path)
        if not raw_text.strip():
            raise ValueError("Could not extract any text from the PDF. Is it a scanned image?")

        # Send to Gemini for structuring
        client = get_gemini_client()

        system_instruction = (
            "You are an expert resume parser. Your job is to extract structured "
            "information from resume text and return it as a JSON object. "
            "Be thorough — extract everything you can find. "
            "For fields you cannot determine, use null."
        )

        prompt = f"""Parse the following resume text into a structured JSON object.

RESUME TEXT:
---
{raw_text}
---

Return a JSON object with this exact structure:
{{
  "personal": {{
    "first_name": "string or null",
    "last_name": "string or null",
    "email": "string or null",
    "phone": "string or null",
    "linkedin": "LinkedIn URL or null",
    "github": "GitHub URL or null",
    "portfolio": "portfolio/website URL or null",
    "address": {{
      "street": "string or null",
      "city": "string or null",
      "state": "string or null",
      "zip": "string or null",
      "country": "string or null"
    }},
    "date_of_birth": "string or null",
    "nationality": "string or null",
    "summary": "professional summary/objective from resume or null"
  }},
  "work_experience": [
    {{
      "company": "company name",
      "title": "job title",
      "start_date": "YYYY-MM or null",
      "end_date": "YYYY-MM or 'present' or null",
      "description": "role description and achievements",
      "technologies": ["tech1", "tech2"]
    }}
  ],
  "education": [
    {{
      "institution": "school name",
      "degree": "degree type (B.Tech, M.S., etc.)",
      "field": "field of study",
      "gpa": "GPA or percentage or null",
      "start_date": "YYYY-MM or null",
      "end_date": "YYYY-MM or null"
    }}
  ],
  "skills": ["skill1", "skill2", "..."],
  "certifications": ["cert1", "cert2"],
  "projects": [
    {{
      "name": "project name",
      "description": "brief project description",
      "technologies": ["tech1", "tech2"],
      "url": "project URL or null",
      "start_date": "YYYY-MM or null",
      "end_date": "YYYY-MM or null"
    }}
  ],
  "languages_spoken": [
    {{
      "language": "English",
      "proficiency": "Fluent/Native/Intermediate/Basic"
    }}
  ],
  "legal": {{
    "authorized_to_work": null,
    "sponsorship_required": null,
    "veteran_status": null,
    "disability_status": null,
    "gender": null,
    "ethnicity": null
  }},
  "preferences": {{
    "salary_expectation": null,
    "notice_period": null,
    "start_date": null,
    "willing_to_relocate": null,
    "remote_preference": null
  }},
  "common_answers": {{
    "why_interested": null,
    "biggest_strength": null,
    "biggest_weakness": null,
    "cover_letter_template": null,
    "custom": {{}}
  }}
}}

IMPORTANT:
- Extract ALL information you can find from the resume
- For work experience, include detailed descriptions with achievements
- For technologies, list each one separately
- Parse dates into YYYY-MM format where possible
- If the resume mentions a location, put it in the address fields
- If the resume has a summary/objective section, extract it into personal.summary
- Extract all projects mentioned in the resume into the projects array
- Return ONLY the JSON object, no other text"""

        result = client.generate_json(prompt, system_instruction)
        profile = UserProfile.model_validate(result)
        logger.info(
            f"Successfully parsed resume: {profile.personal.first_name} {profile.personal.last_name}"
        )
        return profile
