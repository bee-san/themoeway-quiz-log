import unittest
from pathlib import Path

from build_anki_tier import TIERS, card_templates, load_terms, normalize_tier, select_tier_terms


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "tmw-terms.json.gz"


class AnkiTierTests(unittest.TestCase):
    def test_combined_labels_collapse_to_one_of_nine_canonical_tiers(self):
        self.assertEqual(TIERS, ("Student", "Trainee", "Debut", "Major", "Prima", "Divine", "Eternal", "Immortal", "Mythic"))
        self.assertEqual(normalize_tier("Trainee, Mythic"), "Trainee")
        self.assertEqual(normalize_tier("ETERNAL, Immortal, Mythic"), "Eternal")
        self.assertEqual(normalize_tier("Unknown, Mythic"), "")

    def test_trainee_export_contains_only_its_identified_terms(self):
        terms = load_terms(DATA)
        trainee = select_tier_terms(terms, "Trainee")
        self.assertEqual(len(trainee), 726)
        self.assertTrue(all(term["tier"] == "Trainee" for term in trainee))
        self.assertTrue(all(term["id"] and term["term"] and term["reading"] for term in trainee))
        self.assertTrue(all("meaning" not in term for term in trainee))

    def test_anki_question_requires_typed_reading_before_reveal(self):
        question, answer = card_templates()
        self.assertIn("{{type:Reading}}", question)
        self.assertIn("{{Reading}}", answer)
        self.assertIn("{{FrontSide}}", answer)


if __name__ == "__main__":
    unittest.main()
