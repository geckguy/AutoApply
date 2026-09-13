"""Cover letter generation service."""
import logging
from backend.models.profile import UserProfile
from backend.services.llm_client import (
    MAX_KNOWLEDGE_CHARS,
    LLMResponseError,
    ProviderBusy,
    ProviderNotConfigured,
    get_llm_client,
    profile_prompt_json,
)

logger = logging.getLogger(__name__)

class CoverLetterGenerator:
    @staticmethod
    def generate(
        job_description: str,
        company: str,
        role: str,
        profile: UserProfile,
        knowledge: str = "",
    ) -> str:
        system_instruction = (
            "You write cover letters that sound like a real person wrote them. "
            "BANNED phrases: 'I am excited to', 'passionate about', 'leverage my skills', "
            "'dynamic team', 'fast-paced environment', 'thrilled', 'eager', 'align with my values'. "
            "Write in first person. Be specific about the company and role. "
            "Keep it to 3-4 paragraphs, under 300 words total. "
            "Include one concrete example from the applicant's experience. "
            "Do NOT use flowery language. Sound confident but not arrogant."
        )
        
        profile_json = profile_prompt_json(profile)
        
        prompt = f"""Write a cover letter for this application:

COMPANY: {company}
ROLE: {role}

JOB DESCRIPTION:
{job_description[:3000]}

APPLICANT PROFILE:
{profile_json[:5000]}

ADDITIONAL CONTEXT:
{knowledge[:MAX_KNOWLEDGE_CHARS]}

Return ONLY the cover letter text, no subject line, no greeting format instructions."""

        try:
            client = get_llm_client()
            return client.generate(prompt, system_instruction=system_instruction)
        except (ProviderNotConfigured, ProviderBusy, LLMResponseError):
            # Typed provider state; the API layer maps it to an actionable status.
            raise
        except Exception as error:
            raise LLMResponseError(f"Cover letter generation failed: {error}") from error
