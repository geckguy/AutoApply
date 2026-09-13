import unittest
from unittest.mock import Mock, patch

from backend.models.form_schema import FillResponse, FormField, FormSchema
from backend.models.profile import Address, LegalInfo, PersonalInfo, Preferences, UserProfile
from backend.routers.autofill import autofill
from backend.services.local_mapper import (
    LocalFieldMapper,
    answer_similarity,
    best_answer,
    classify_field,
)


class LocalFieldMapperTests(unittest.TestCase):
    def setUp(self):
        self.profile = UserProfile(
            personal=PersonalInfo(
                first_name="Ada",
                last_name="Lovelace",
                email="ada@example.test",
            ),
            legal=LegalInfo(authorized_to_work=True, gender="Female"),
        )

    def test_maps_direct_profile_fields_and_upload_without_ai(self):
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            resume_version_id="resume-2",
            fields=[
                FormField(id="first", type="text", label="First name"),
                FormField(id="email", type="email", label="Email address"),
                FormField(id="auth", type="select", label="Authorized to work?", options=["Yes", "No"]),
                FormField(id="resume", type="file", label="Resume"),
            ],
        )

        result = LocalFieldMapper.map_fields(schema, self.profile)

        self.assertEqual([], result.unresolved)
        self.assertEqual(
            [(item.field_id, item.action, item.value) for item in result.instructions],
            [
                ("first", "fill", "Ada"),
                ("email", "fill", "ada@example.test"),
                ("auth", "select", "Yes"),
                ("resume", "upload", "resume-2"),
            ],
        )

    def test_sensitive_fields_require_review_by_default(self):
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[FormField(id="gender", type="select", label="Gender", options=["Female", "Male"])],
        )

        result = LocalFieldMapper.map_fields(schema, self.profile)

        self.assertEqual("skip", result.instructions[0].action)
        self.assertIn("sensitive", result.instructions[0].reason)

    def test_fixed_policy_and_learned_mapping_take_precedence(self):
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            platform="example",
            fields=[
                FormField(id="salary", type="text", label="Expected salary"),
                FormField(id="nickname", type="text", label="Preferred name"),
            ],
        )
        result = LocalFieldMapper.map_fields(
            schema,
            self.profile,
            policies=[{"field_key": "salary_expectation", "action": "fixed", "fixed_value": "120000"}],
            learned_mappings=[
                {"field_label": "Preferred name", "platform": "example", "value": "Ada"}
            ],
        )

        self.assertEqual(["120000", "Ada"], [item.value for item in result.instructions])

    def test_reuses_only_similar_approved_answers(self):
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[FormField(id="interest", type="textarea", label="Why do you want to work here?")],
        )
        result = LocalFieldMapper.map_fields(
            schema,
            self.profile,
            answer_entries=[
                {
                    "id": 7,
                    "question": "Why do you want to work here?",
                    "answer": "The product and role closely match my systems experience.",
                    "approved": 1,
                }
            ],
        )

        self.assertEqual("answer_vault:7", result.instructions[0].source)
        self.assertGreater(answer_similarity("Why this role?", "Why are you interested in this role?"), 0.4)

    def test_statement_labels_do_not_classify_as_state(self):
        for label in ("Personal statement", "Statement of interest", "Research statement"):
            with self.subTest(label=label):
                self.assertIsNone(classify_field(FormField(id="field", type="textarea", label=label)))

        self.assertEqual("state", classify_field(FormField(id="field", type="text", label="State")))

    def test_ethnicity_labels_are_sensitive_and_never_auto_filled(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.address = Address(city="Hyderabad")

        for label in ("Ethnicity", "Race/Ethnicity"):
            with self.subTest(label=label):
                field = FormField(id="ethnicity", type="select", label=label, options=["Asian", "White"])
                self.assertEqual("ethnicity", classify_field(field))

                result = LocalFieldMapper.map_fields(
                    FormSchema(url="https://jobs.example.test/apply", fields=[field]), profile
                )

                self.assertEqual(
                    [("ethnicity", "skip")],
                    [(item.field_id, item.action) for item in result.instructions],
                )
                self.assertIn("sensitive", result.instructions[0].reason)

    def test_work_authorization_question_is_not_classified_as_state(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.address = Address(state="Telangana")
        field = FormField(
            id="auth",
            type="select",
            label="Are you legally authorized to work in the United States?",
            options=["Yes", "No"],
        )
        self.assertEqual("authorized_to_work", classify_field(field))

        result = LocalFieldMapper.map_fields(
            FormSchema(url="https://jobs.example.test/apply", fields=[field]), profile
        )

        self.assertEqual(
            [("auth", "select", "Yes")],
            [(item.field_id, item.action, item.value) for item in result.instructions],
        )

    def test_ordinary_labels_still_classify_on_word_boundaries(self):
        cases = {
            "Email address": "email",
            "Current company email": "email",
            "City": "city",
            "State": "state",
            "Country": "country",
        }
        for label, expected in cases.items():
            with self.subTest(label=label):
                self.assertEqual(expected, classify_field(FormField(id="field", type="text", label=label)))

    def test_boolean_profile_value_never_invents_a_true_option(self):
        profile = self.profile.model_copy(deep=True)
        profile.preferences = Preferences(willing_to_relocate=True)
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[
                FormField(id="relocate", type="select", label="Willing to relocate?", options=["Remote", "Hybrid"])
            ],
        )

        result = LocalFieldMapper.map_fields(schema, profile)

        self.assertEqual([], result.instructions)
        self.assertEqual(["relocate"], [item.id for item in result.unresolved])

        matching = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[FormField(id="relocate", type="select", label="Willing to relocate?", options=["Yes", "No"])],
        )
        matched = LocalFieldMapper.map_fields(matching, profile)
        self.assertEqual(
            [("relocate", "select", "Yes")],
            [(item.field_id, item.action, item.value) for item in matched.instructions],
        )

    def test_third_party_contact_fields_are_not_filled_with_applicant_details(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.phone = "+1 555 0100"
        fields = [
            FormField(id="referrer", type="text", label="Referrer email"),
            FormField(id="company", type="text", label="Company email"),
            FormField(id="emergency", type="text", label="Emergency contact phone"),
        ]

        result = LocalFieldMapper.map_fields(
            FormSchema(url="https://jobs.example.test/apply", fields=fields), profile
        )

        self.assertEqual(
            [("referrer", "skip"), ("company", "skip"), ("emergency", "skip")],
            [(item.field_id, item.action) for item in result.instructions],
        )
        filled_values = {item.value for item in result.instructions if item.value}
        self.assertNotIn(profile.personal.email, filled_values)
        self.assertNotIn(profile.personal.phone, filled_values)

    def test_website_labels_fill_the_portfolio_url(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.portfolio = "https://ada.example.test"
        profile.personal.linkedin = "https://linkedin.com/in/ada"
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[
                FormField(id="website", type="url", label="Website"),
                FormField(id="personal", type="url", label="Personal website"),
                FormField(id="portfolio", type="url", label="Portfolio"),
                FormField(id="blog", type="url", label="Blog"),
                FormField(id="homepage", type="url", label="Homepage"),
            ],
        )

        result = LocalFieldMapper.map_fields(schema, profile)

        self.assertEqual(
            [("website", "fill", "https://ada.example.test"),
             ("personal", "fill", "https://ada.example.test"),
             ("portfolio", "fill", "https://ada.example.test"),
             ("blog", "fill", "https://ada.example.test"),
             ("homepage", "fill", "https://ada.example.test")],
            [(item.field_id, item.action, item.value) for item in result.instructions],
        )
        # The applicant's LinkedIn URL is not a website and must never land here.
        self.assertNotIn("linkedin.com", " ".join(item.value or "" for item in result.instructions))

    def test_website_labels_without_a_portfolio_skip_with_an_actionable_reason(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.portfolio = None
        profile.personal.linkedin = "https://linkedin.com/in/ada"
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[
                FormField(id="website", type="url", label="Website"),
                FormField(id="blog", type="url", label="Blog"),
            ],
        )

        result = LocalFieldMapper.map_fields(schema, profile)

        self.assertEqual(
            [("website", "skip"), ("blog", "skip")],
            [(item.field_id, item.action) for item in result.instructions],
        )
        for item in result.instructions:
            self.assertEqual("profile.missing", item.source)
            self.assertIn("portfolio", item.reason.casefold())
            self.assertIsNone(item.value)

    def test_github_labels_fill_the_github_url_not_the_portfolio(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.github = "https://github.com/ada"
        profile.personal.portfolio = "https://ada.example.test"
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[
                FormField(id="github", type="url", label="GitHub"),
                FormField(id="github_profile", type="url", label="GitHub Profile"),
                FormField(id="gitlab", type="url", label="GitLab Profile"),
            ],
        )

        result = LocalFieldMapper.map_fields(schema, profile)

        self.assertEqual(
            [("github", "fill", "https://github.com/ada"),
             ("github_profile", "fill", "https://github.com/ada"),
             ("gitlab", "fill", "https://github.com/ada")],
            [(item.field_id, item.action, item.value) for item in result.instructions],
        )
        for item in result.instructions:
            self.assertEqual("profile.personal.github", item.source)

    def test_github_labels_without_a_github_url_skip_instead_of_borrowing_the_portfolio(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.github = None
        profile.personal.portfolio = "https://ada.example.test"
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[FormField(id="github", type="url", label="GitHub Profile")],
        )

        result = LocalFieldMapper.map_fields(schema, profile)

        self.assertEqual(
            [("github", "skip")],
            [(item.field_id, item.action) for item in result.instructions],
        )
        self.assertIn("github", result.instructions[0].reason.casefold())
        self.assertIsNone(result.instructions[0].value)

    def test_linkedin_labels_still_fill_the_linkedin_url(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.linkedin = "https://linkedin.com/in/ada"
        profile.personal.portfolio = "https://ada.example.test"
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[
                FormField(id="li_profile", type="url", label="LinkedIn Profile"),
                FormField(id="li_url", type="url", label="LinkedIn URL"),
            ],
        )

        self.assertEqual("linkedin", classify_field(schema.fields[0]))
        self.assertEqual("linkedin", classify_field(schema.fields[1]))
        result = LocalFieldMapper.map_fields(schema, profile)

        self.assertEqual(
            [("li_profile", "fill", "https://linkedin.com/in/ada"),
             ("li_url", "fill", "https://linkedin.com/in/ada")],
            [(item.field_id, item.action, item.value) for item in result.instructions],
        )
        for item in result.instructions:
            self.assertEqual("profile.personal.linkedin", item.source)

    def test_third_party_url_fields_are_not_filled_with_the_applicant_url(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.linkedin = "https://linkedin.com/in/ada"
        profile.personal.portfolio = "https://ada.example.test"
        fields = [
            FormField(id="company_site", type="url", label="Company website"),
            FormField(id="referrer_li", type="url", label="Referrer LinkedIn"),
        ]

        result = LocalFieldMapper.map_fields(
            FormSchema(url="https://jobs.example.test/apply", fields=fields), profile
        )

        self.assertEqual(
            [("company_site", "skip"), ("referrer_li", "skip")],
            [(item.field_id, item.action) for item in result.instructions],
        )
        for item in result.instructions:
            self.assertEqual("policy.third_party", item.source)
            self.assertIn("someone else", item.reason.casefold())
            self.assertIsNone(item.value)

    def test_word_boundary_classifications_for_statement_ethnicity_and_email_labels(self):
        cases = {
            "Personal statement": None,
            "Statement of interest": None,
            "Ethnicity": "ethnicity",
            "Race/Ethnicity": "ethnicity",
            "Current company email": "email",
            "City": "city",
        }
        for label, expected in cases.items():
            with self.subTest(label=label):
                self.assertEqual(expected, classify_field(FormField(id="field", type="text", label=label)))

    def test_learned_mapping_only_applies_on_its_own_host(self):
        fields = [FormField(id="nickname", type="text", label="Preferred name")]
        # Learned mappings persisted by older clients carry the site in the
        # fingerprint, not in a dedicated domain column.
        learned = [
            {
                "field_label": "Preferred name",
                "field_fingerprint": "https://jobs.example.test/apply|nickname",
                "value": "Ada L",
            }
        ]

        same_host = LocalFieldMapper.map_fields(
            FormSchema(url="https://jobs.example.test/apply", fields=fields),
            self.profile,
            learned_mappings=learned,
        )
        other_host = LocalFieldMapper.map_fields(
            FormSchema(url="https://other.example.test/apply", fields=fields),
            self.profile,
            learned_mappings=learned,
        )

        self.assertEqual(["Ada L"], [item.value for item in same_host.instructions])
        self.assertEqual([], other_host.instructions)
        self.assertEqual(["nickname"], [item.id for item in other_host.unresolved])

    def test_fuzzy_option_matches_are_reviewed_not_verified(self):
        profile = self.profile.model_copy(deep=True)
        profile.personal.address = Address(state="Telangana")
        field = FormField(id="state", type="select", label="State", options=["Telangana State", "Andhra Pradesh"])

        result = LocalFieldMapper.map_fields(
            FormSchema(url="https://jobs.example.test/apply", fields=[field]), profile
        )

        self.assertEqual("Telangana State", result.instructions[0].value)
        self.assertEqual("medium", result.instructions[0].confidence)

    def test_best_answer_requires_an_explicit_approval_flag(self):
        entry = {
            "id": 1,
            "question": "Why do you want to work here?",
            "answer": "The product and role closely match my systems experience.",
        }

        self.assertIsNone(best_answer("Why do you want to work here?", [entry]))
        self.assertIsNone(best_answer("Why do you want to work here?", [{**entry, "approved": False}]))
        approved = {**entry, "approved": 1}
        self.assertIs(approved, best_answer("Why do you want to work here?", [approved]))

    @patch("backend.routers.autofill._save_generated_answers")
    @patch("backend.routers.autofill._load_corrections", return_value=[])
    @patch("backend.routers.autofill._load_knowledge", return_value="")
    @patch("backend.routers.autofill._load_profile")
    @patch("backend.routers.autofill.get_database")
    @patch("backend.routers.autofill.FieldMapper.map_fields")
    def test_autofill_does_not_call_ai_when_every_field_is_local(
        self,
        ai_map,
        get_database,
        load_profile,
        _load_knowledge,
        _load_corrections,
        _save_answers,
    ):
        load_profile.return_value = self.profile
        database = Mock()
        database.get_field_policies.return_value = []
        database.get_learned_mappings.return_value = []
        database.get_answers.return_value = []
        get_database.return_value = database
        schema = FormSchema(
            url="https://example.test/apply",
            fields=[FormField(id="email", type="email", label="Email")],
        )

        response = autofill(schema)

        self.assertEqual(1, response.local_count)
        self.assertEqual(0, response.ai_count)
        self.assertEqual(1, response.ready_count)
        self.assertEqual(0, response.review_count)
        self.assertEqual(0, response.skipped_count)
        self.assertFalse(response.instructions[0].review_required)
        ai_map.assert_not_called()

    @patch("backend.routers.autofill._save_generated_answers")
    @patch("backend.routers.autofill._load_corrections", return_value=[])
    @patch("backend.routers.autofill._load_knowledge", return_value="")
    @patch("backend.routers.autofill._load_profile")
    @patch("backend.routers.autofill.get_database")
    @patch("backend.routers.autofill.FieldMapper.map_fields")
    def test_unresolved_boolean_select_is_never_reported_ready(
        self,
        ai_map,
        get_database,
        load_profile,
        _load_knowledge,
        _load_corrections,
        _save_answers,
    ):
        profile = self.profile.model_copy(deep=True)
        profile.preferences = Preferences(willing_to_relocate=True)
        load_profile.return_value = profile
        database = Mock()
        database.get_field_policies.return_value = []
        database.get_learned_mappings.return_value = []
        database.get_answers.return_value = []
        get_database.return_value = database
        # The open question is unresolved locally, so it reaches the provider;
        # an unavailable provider must not turn it into a ready instruction.
        ai_map.return_value = FillResponse(instructions=[], ai_error="Provider unavailable")
        schema = FormSchema(
            url="https://jobs.example.test/apply",
            fields=[
                FormField(
                    id="relocate",
                    type="select",
                    label="Willing to relocate?",
                    options=["Remote", "Hybrid"],
                )
            ],
        )

        response = autofill(schema)

        self.assertEqual(0, response.ready_count)
        self.assertFalse(any(item.value == "true" for item in response.instructions))


if __name__ == "__main__":
    unittest.main()
