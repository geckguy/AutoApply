"""Answer generation service — produces human-sounding answers for open-ended questions."""

import json
import logging
from typing import Optional

from backend.models.profile import UserProfile
from backend.models.application import AnswerBankEntry
from backend.services.gemini import get_gemini_client

logger = logging.getLogger(__name__)


class AnswerGenerator:
    """Generates human-sounding answers for open-ended application questions."""

    @staticmethod
    def generate_answer(
        question: str,
        job_title: str = "",
        company: str = "",
        job_description: str = "",
        profile: Optional[UserProfile] = None,
        knowledge: str = "",
        past_answers: Optional[list[AnswerBankEntry]] = None,
    ) -> str:
        """Generate a human-sounding answer for an application question.

        Uses carefully crafted prompting to avoid AI-sounding language
        and ensure specificity about the company/role.

        Args:
            question: The question text from the form.
            job_title: The job title being applied for.
            company: The company name.
            job_description: Relevant excerpt from the JD.
            profile: The user's profile.
            knowledge: Content from knowledge.md.
            past_answers: Previously generated answers to avoid repetition.

        Returns:
            A natural, human-sounding answer string.
        """
        client = get_gemini_client()

        # Build profile summary
        profile_summary = ""
        if profile:
            parts = []
            if profile.personal and (profile.personal.first_name or profile.personal.last_name):
                parts.append(f"Name: {profile.personal.first_name or ''} {profile.personal.last_name or ''}".strip())
            if profile.work_experience:
                latest = profile.work_experience[0]
                parts.append(f"Current/Recent: {latest.title} at {latest.company}")
                total_exp = len(profile.work_experience)
                parts.append(f"Total positions: {total_exp}")
            if profile.skills:
                parts.append(f"Key skills: {', '.join(profile.skills[:15])}")
            if profile.education:
                latest_edu = profile.education[0]
                parts.append(
                    f"Education: {latest_edu.degree} in {latest_edu.field} "
                    f"from {latest_edu.institution}"
                )
            profile_summary = "\n".join(parts)

        # Build past answers section
        past_answers_text = ""
        if past_answers:
            recent = past_answers[-10:]
            lines = []
            for a in recent:
                truncated_ans = a.answer[:100] + ("..." if len(a.answer) > 100 else "")
                lines.append(f'- {a.company} ({a.role}): "{truncated_ans}"')
            past_answers_text = (
                "\n\nPAST ANSWERS FOR SIMILAR QUESTIONS (do NOT reuse — write something fresh):\n"
                + "\n".join(lines)
            )

        system_instruction = (
            "You are a job applicant writing answers for a job application. "
            "Write as yourself (first person). Sound like a real human, not an AI. "
            "Be specific, concise, and natural."
        )

        prompt = f"""Write a response to the following job application question.

QUESTION: "{question}"
JOB TITLE: "{job_title or 'Not specified'}"
COMPANY: "{company or 'Not specified'}"

JOB DESCRIPTION CONTEXT:
{job_description[:2000] if job_description else "(not available)"}

ABOUT YOU (the applicant):
{profile_summary if profile_summary else "(profile not loaded)"}

EXTRA CONTEXT:
{knowledge[:2000] if knowledge else "(none)"}
{past_answers_text}

CRITICAL WRITING RULES — FOLLOW THESE EXACTLY:
1. Write as if you're a real person, not an AI
2. Use a casual-professional tone — like a thoughtful text, not a corporate essay
3. Be SPECIFIC — reference the actual company name, role, or something from the JD
4. Keep it concise: 3-5 sentences max
5. Include ONE concrete example from your experience
6. Vary your sentence structure naturally
7. It's okay to start a sentence with "I"

BANNED PHRASES — DO NOT USE ANY OF THESE:
- "I am excited to" / "I'm excited about"
- "I am passionate about" / "passionate"
- "leverage my skills" / "leverage"
- "dynamic team" / "dynamic"
- "fast-paced environment"
- "align with my values" / "aligns with"
- "thrilled" / "eager" / "delighted"
- "cutting-edge" / "innovative" / "groundbreaking"
- "I believe I would be a great fit"
- "unique opportunity"
- "make a meaningful impact"

GOOD TONE EXAMPLES:
- "I've been building Python APIs for about two years now, and the distributed systems
  problems you're tackling at [Company] are the kind of thing I'd want to dig into."
- "Your team's work on [specific thing] caught my attention — I built something similar
  at [previous company] and learned a ton about [specific lesson]."

Write ONLY the answer text, no quotes, no preamble, no explanation."""

        answer = client.generate(prompt, system_instruction)

        # Clean up — remove surrounding quotes if present
        answer = answer.strip().strip('"').strip("'").strip()

        logger.info(f"Generated answer ({len(answer)} chars) for: {question[:50]}...")
        return answer

    @staticmethod
    def classify_question(question: str) -> str:
        """Classify a question into a category for the answer bank.

        Args:
            question: The question text.

        Returns:
            Category string like "why_interested", "strength", "cover_letter", etc.
        """
        q_lower = question.lower()

        if any(
            phrase in q_lower
            for phrase in [
                "why do you want",
                "why are you interested",
                "what interests you",
                "why this role",
                "why this company",
                "what attracted you",
            ]
        ):
            return "why_interested"

        if any(
            phrase in q_lower
            for phrase in ["cover letter", "letter of interest", "letter of motivation"]
        ):
            return "cover_letter"

        if any(
            phrase in q_lower
            for phrase in ["strength", "what are you good at", "best quality"]
        ):
            return "strength"

        if any(
            phrase in q_lower
            for phrase in ["weakness", "area of improvement", "development area"]
        ):
            return "weakness"

        if any(
            phrase in q_lower
            for phrase in [
                "tell us about yourself",
                "describe yourself",
                "about you",
                "introduce yourself",
            ]
        ):
            return "about_self"

        if any(
            phrase in q_lower
            for phrase in [
                "why are you leaving",
                "why are you looking",
                "reason for leaving",
            ]
        ):
            return "reason_for_change"

        return "other"
