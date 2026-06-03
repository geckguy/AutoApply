"""Field mapping service — maps user profile data to form fields via Gemini."""

import json
import logging
from typing import Optional

from backend.models.profile import UserProfile
from backend.models.form_schema import FormSchema, FillInstruction, FillResponse
from backend.models.application import Correction
from backend.services.gemini import get_gemini_client

logger = logging.getLogger(__name__)


class FieldMapper:
    """Orchestrates mapping of profile data to form fields using Gemini."""

    @staticmethod
    def map_fields(
        form_schema: FormSchema,
        profile: UserProfile,
        knowledge: str = "",
        corrections: Optional[list[Correction]] = None,
    ) -> FillResponse:
        """Map user profile fields to form fields using Gemini.

        Sends the profile, knowledge file, form schema, and past corrections
        to Gemini, which returns intelligent fill instructions with confidence levels.

        Args:
            form_schema: The extracted form schema with fields to fill.
            profile: The user's profile data.
            knowledge: Content from the knowledge.md file.
            corrections: List of past user corrections for learning.

        Returns:
            FillResponse with instructions for each field.
        """
        client = get_gemini_client()

        # Build the corrections section
        corrections_text = ""
        if corrections:
            recent = corrections[-50:]  # Last 50 corrections
            correction_lines = []
            for c in recent:
                correction_lines.append(
                    f'- When asked about "{c.field_label}", use "{c.user_value}" '
                    f'not "{c.agent_value}"'
                )
            corrections_text = (
                "\n\nPAST CORRECTIONS (learn from these — do NOT repeat these mistakes):\n"
                + "\n".join(correction_lines)
            )

        system_instruction = (
            "You are an expert job application assistant. You fill out job application "
            "forms accurately and intelligently using the applicant's profile data. "
            "You must return valid JSON only."
        )

        profile_json = profile.model_dump_json(indent=2, exclude_none=True)

        # Truncate work experience descriptions if profile is too large
        if len(profile_json) > 8000:
            truncated_profile = profile.model_copy(deep=True)
            for exp in truncated_profile.work_experience:
                if exp.description and len(exp.description) > 200:
                    exp.description = exp.description[:200] + "..."
            profile_json = truncated_profile.model_dump_json(indent=2, exclude_none=True)

        # Build field descriptions for the prompt
        fields_desc = []
        for f in form_schema.fields:
            desc = {
                "field_id": f.id,
                "type": f.type,
                "label": f.label or f.name or f.aria_label or f.id,
                "required": f.required,
            }
            if f.options:
                desc["options"] = f.options
            if f.placeholder:
                desc["placeholder"] = f.placeholder
            if f.max_length:
                desc["max_length"] = f.max_length
            fields_desc.append(desc)

        jd_section = ""
        if form_schema.job_description:
            jd_section = f"\n\nJOB DESCRIPTION:\n{form_schema.job_description[:3000]}"

        # Add form step context if available
        step_context = ""
        if hasattr(form_schema, 'step') and form_schema.step is not None:
            total = getattr(form_schema, 'total_steps', None)
            if total is not None:
                step_context = f"\n\nNOTE: This is step {form_schema.step} of {total} in the application form."
            else:
                step_context = f"\n\nNOTE: This is step {form_schema.step} of the application form."

        prompt = f"""Fill out a job application form using the applicant's data.

APPLICANT PROFILE:
{profile_json}

ADDITIONAL KNOWLEDGE ABOUT THE APPLICANT:
{knowledge if knowledge else "(none provided)"}
{corrections_text}
{jd_section}

FORM FIELDS TO FILL:
{json.dumps(fields_desc, indent=2)}
{step_context}

INSTRUCTIONS:
1. Map each form field to the most appropriate value from the profile or knowledge.
2. For dropdown/select fields, pick the CLOSEST matching option from the available choices.
   Return the exact option text that should be selected.
3. For textarea/open-ended questions, write a thoughtful, specific, HUMAN-SOUNDING answer.
   - Do NOT use phrases like "I am excited to", "I am passionate about", "leverage",
     "dynamic team", "fast-paced environment", "thrilled", "eager"
   - Be specific, concise, and natural
   - Reference the actual company/role if you know it from the job description
   - CRITICAL: If the field asks for responsibilities or experience at a SPECIFIC past company, ONLY include details for that specific company. Do NOT copy-paste your entire resume or list all your projects.
4. For numeric fields or questions asking for "years of experience", return ONLY the number (e.g. "5"). Do not append project descriptions or text.
5. For file upload fields, return action "upload" with value "resume".
6. For checkbox/radio fields, return action "check" with the value to select.
7. If you genuinely cannot determine a value, return action "skip" with a reason.
8. Respect the `max_length` constraint on fields. If a field has max_length, ensure your value does not exceed it.
9. For date fields, format dates as the form expects. Common formats: YYYY-MM-DD, MM/DD/YYYY, or Month Year. Check the field's placeholder for hints.
10. Calculate years of experience from work_experience date ranges rather than guessing.
11. For phone numbers, use the format that matches the form's country context.

CONFIDENCE LEVELS:
- "high": Direct match from profile (name, email, phone, etc.)
- "medium": Inferred or fuzzy match (dropdown best guess, formatted dates, etc.)
- "low": Generated content or uncertain match (open-ended answers, ambiguous fields)

Return ONLY a JSON array of fill instructions:
[
  {{"field_id": "...", "action": "fill", "value": "...", "confidence": "high", "source": "profile.personal.email"}},
  {{"field_id": "...", "action": "select", "value": "India", "confidence": "medium", "source": "profile.personal.address.country"}},
  {{"field_id": "...", "action": "upload", "value": "resume", "confidence": "high", "source": "resume.pdf"}},
  {{"field_id": "...", "action": "skip", "value": null, "confidence": "low", "reason": "Cannot determine value"}}
]"""

        # Look up similar past answers
        from backend.services.database import get_database
        db = get_database()
        past_answers_section = ""
        for field in form_schema.fields:
            ftype = (field.type or "").lower()
            if ftype in ("text", "textarea") and field.label:
                similar = db.find_similar_answers(field.label, limit=3)
                if similar:
                    lines = [f'  - Q: "{a["question"]}" -> A: "{a["answer"][:150]}"' for a in similar]
                    past_answers_section += f'\nPast answers for "{field.label}":\n' + '\n'.join(lines)

        if past_answers_section:
            prompt += f"\n\nPAST ANSWERS (use as reference, adapt for this company):{past_answers_section}"

        try:
            result = client.generate_json(prompt, system_instruction)

            instructions = []
            for item in result:
                try:
                    instructions.append(FillInstruction.model_validate(item))
                except Exception as e:
                    logger.warning(f"Skipping invalid fill instruction: {item} — {e}")

            logger.info(
                f"Generated {len(instructions)} fill instructions for {len(form_schema.fields)} fields"
            )
            return FillResponse(instructions=instructions)

        except Exception as e:
            logger.error(f"Field mapping failed: {e}")
            # Return empty instructions rather than crashing
            return FillResponse(
                instructions=[
                    FillInstruction(
                        field_id=f.id,
                        action="skip",
                        confidence="low",
                        reason=f"Mapping failed: {str(e)}",
                    )
                    for f in form_schema.fields
                ]
            )
