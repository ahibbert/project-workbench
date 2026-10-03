import unittest

from similar_recommendations import normalize_mangabaka_similar, select_mangabaka_seed


class SimilarRecommendationTests(unittest.TestCase):
    def test_seed_matching_requires_an_exact_title(self):
        results = [
            {"id": 2, "type": "manga", "rating_count": 3, "titles": [{"language": "en", "title": "Golden Kamuy Spin Off", "is_primary": True}]},
            {"id": 1, "type": "manga", "rating_count": 99, "titles": [{"language": "en", "title": "Golden Kamuy", "is_primary": True}]},
        ]
        self.assertEqual(select_mangabaka_seed(results, "Golden Kamuy")["id"], 1)
        self.assertIsNone(select_mangabaka_seed(results, "Golden Kamuy Returns"))

    def test_similar_results_are_safe_deduplicated_and_explainable(self):
        payload = {"data": [
            {"score": 0.82, "shared_tags": [{"name": "Historical", "weight": "defining"}], "matched_author": True,
             "series": {"id": 5, "type": "manga", "titles": [{"language": "en", "title": "Silver Kamuy", "is_primary": True}]}},
            {"score": 0.7, "series": {"id": 5, "type": "manga", "title": "Duplicate"}},
            {"score": 0.9, "series": {"id": 6, "type": "novel", "title": "Not manga"}},
            {"score": 0.6, "series": {"id": 7, "type": "manhwa", "title": "Already owned"}},
        ]}
        results = normalize_mangabaka_similar(
            payload,
            seed_title="Golden Kamuy",
            requested_format="manga",
            excluded_titles=("Already owned",),
        )
        self.assertEqual([item["id"] for item in results], [5])
        self.assertEqual(results[0]["mediaFormat"], "manga")
        self.assertEqual(results[0]["reason"]["top_tags"][0]["name"], "Historical")
        self.assertTrue(results[0]["reason"]["matched_author"])


if __name__ == "__main__":
    unittest.main()
