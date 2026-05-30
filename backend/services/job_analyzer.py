"""Job analysis service — fit scoring and job description analysis."""

import json
import logging
from typing import Optional

from backend.models.profile import UserProfile
from backend.models.form_schema import FitScore
from backend.services.gemini import get_gemini_client

logger = logging.getLogger(__name__)


class JobAnalyzer:
    """Analyzes job descriptions against user profile for fit scoring."""

    @staticmethod
    def analyze_job(
        job_description: str,
        profile: UserProfile,
        knowledge: str = "",
    ) -> FitScore:
        """Analyze a job description against the user's profile.

        Returns a fit score with matched/missing skills, experience fit,
        and a recommendation.

        Args:
            job_description: The full job description text.
            profile: The user's profile data.
            knowledge: Content from the knowledge.md file.

        Returns:
            FitScore with detailed analysis.
        """
        client = get_gemini_client()

        profile_json = profile.model_dump_json(indent=2, exclude_none=True)

        system_instruction = (
            "You are an expert job market analyst and career advisor. "
            "Analyze job descriptions against candidate profiles honestly and accurately. "
            "You must return valid JSON only."
        )

        prompt = f"""Analyze how well this candidate matches the job description.

CANDIDATE PROFILE:
{profile_json}

ADDITIONAL KNOWLEDGE ABOUT THE CANDIDATE:
{knowledge if knowledge else "(none provided)"}

JOB DESCRIPTION:
{job_description[:4000]}

Analyze the fit and return a JSON object with this exact structure:
{{
  "score": <integer 0-100, be honest — don't inflate>,
  "verdict": "<short 3-8 word summary, e.g. 'Strong match with minor gaps'>",
  "matched_skills": ["skill1", "skill2", "..."],
  "missing_skills": ["skill1", "skill2", "..."],
  "experience_fit": "<1-2 sentences about experience level match>",
  "notes": "<1-2 sentences of strategic advice, e.g. what to emphasize>",
  "recommendation": "<'apply' if score >= 60, 'stretch' if 40-59, 'skip' if < 40>"
}}

SCORING GUIDELINES:
- 80-100: Excellent match, meets almost all requirements
- 60-79: Good match, meets most key requirements
- 40-59: Stretch, significant gaps but transferable skills
- 0-39: Poor match, missing most key requirements

Be honest and specific. Don't just list generic skills — compare what the JD asks for
against what the candidate actually has.

Return ONLY the JSON object."""

        try:
            result = client.generate_json(prompt, system_instruction)
            fit_score = FitScore.model_validate(result)
            logger.info(
                f"Job fit analysis: {fit_score.score}/100 — {fit_score.verdict}"
            )
            return fit_score

        except Exception as e:
            logger.error(f"Job analysis failed: {e}")
            return FitScore(
                score=0,
                verdict="Analysis failed",
                notes=f"Error: {str(e)}",
                recommendation="unknown",
            )
