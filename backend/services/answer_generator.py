"""Answer classification service — categorizes open-ended application questions."""


class AnswerGenerator:
    """Classifies open-ended application questions for the answer bank."""

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
