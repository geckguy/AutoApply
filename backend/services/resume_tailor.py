"""Resume tailoring service - generates a JD-optimized resume summary."""
import logging
from backend.models.profile import UserProfile
from backend.services.gemini import get_gemini_client

logger = logging.getLogger(__name__)

class ResumeTailor:
    @staticmethod
    def tailor(
        job_description: str,
        profile: UserProfile,
        knowledge: str = "",
    ) -> dict:
        """Generate a tailored resume summary optimized for the JD.
        
        Returns dict with:
            - summary: str (tailored professional summary)
            - highlighted_skills: list[str] (skills to emphasize)
            - experience_bullets: list[dict] (tailored bullet points per role)
            - suggestions: list[str] (what to add/change)
        """
        client = get_gemini_client()
        profile_json = profile.model_dump_json(indent=2, exclude_none=True)
        
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
        
        return client.generate_json(prompt, system_instruction=system_instruction)
