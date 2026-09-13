"""Resume tailoring service - generates a JD-optimized resume summary."""
import logging
from backend.models.profile import UserProfile
from backend.services.llm_client import (
    LLMResponseError,
    ProviderBusy,
    ProviderNotConfigured,
    get_llm_client,
    profile_prompt_json,
)

logger = logging.getLogger(__name__)

class ResumeTailor:
    @staticmethod
    def tailor(
        job_description: str,
        profile: UserProfile,
        knowledge: str = "",
    ) -> dict | None:
        """Generate a tailored resume summary optimized for the JD.
        
        Returns dict with:
            - summary: str (tailored professional summary)
            - highlighted_skills: list[str] (skills to emphasize)
            - experience_bullets: list[dict] (tailored bullet points per role)
            - suggestions: list[str] (what to add/change)

        Returns None when the model did not return a JSON object.
        """
        profile_json = profile_prompt_json(profile)
        
        system_instruction = (
            "You are a resume optimization expert. You tailor resumes to match job descriptions. "
            "Focus on: reordering skills to match JD priorities, rephrasing experience bullets "
            "to use the JD's terminology, and highlighting the most relevant achievements. "
            "Return valid JSON only."
        )
        
        prompt = f"""Given this job description and applicant profile, generate a tailored resume optimization.

JOB DESCRIPTION:
{job_description[:3000]}

APPLICANT PROFILE:
{profile_json[:6000]}

Return JSON with this structure:
{{
    "summary": "A 2-3 sentence professional summary tailored to this role",
    "highlighted_skills": ["skill1", "skill2", ...],
    "experience_bullets": [
        {{
            "company": "Company Name",
            "title": "Job Title",
            "bullets": ["Tailored bullet 1", "Tailored bullet 2"]
        }}
    ],
    "suggestions": ["Add X certification", "Mention Y project", ...]
}}"""
        
        try:
            client = get_llm_client()
            result = client.generate_json(prompt, system_instruction=system_instruction)
        except (ProviderNotConfigured, ProviderBusy, LLMResponseError):
            # Typed provider state; the API layer maps it to an actionable status.
            raise
        except Exception as error:
            raise LLMResponseError(f"Resume tailoring failed: {error}") from error

        if not isinstance(result, dict):
            logger.warning(
                "Tailoring provider returned %s instead of a JSON object",
                type(result).__name__,
            )
            return None
        return result
