import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from comic_recommendations import (  # noqa: E402
    BookMetadata,
    ComicRecommendation,
    ComicRecommendationService,
    ComicSeed,
    LibraryThingAdapter,
    OpenLibraryAdapter,
    RecommendationProviderError,
    base_series_title,
    choose_seed_match,
    collapse_duplicate_editions,
    is_comic_metadata,
    recommendation_cache_key,
)


def book(title, isbn, *, creators=(), subjects=("Graphic novels",), year=2015, cover_url=""):
    return BookMetadata(
        title=title,
        isbns=(isbn,),
        creators=tuple(creators),
        subjects=tuple(subjects),
        year=year,
        cover_url=cover_url,
    )


class RecordingHttp:
    def __init__(self, responder):
        self.responder = responder
        self.calls = []

    def get_json(self, url, *, params, headers=None):
        self.calls.append({"url": url, "params": dict(params), "headers": dict(headers or {})})
        return self.responder(url, dict(params))


class SeedMatchingTests(unittest.TestCase):
    def test_rejects_non_comic_first_result_and_selects_correct_invincible_record(self):
        seed = ComicSeed("Invincible", creators=("Robert Kirkman",))
        candidates = (
            book("Invincible", "1410474461", creators=("Diana Palmer",), subjects=("Romance fiction",)),
            book("Invincible, Vol. 1", "9781413194265", creators=("Robert Kirkman", "Cory Walker")),
        )

        resolved = choose_seed_match(seed, candidates)

        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.metadata.isbns, ("9781413194265",))
        self.assertGreaterEqual(resolved.confidence, 0.72)

    def test_darth_vader_prefers_series_edition_over_similarly_named_comic(self):
        seed = ComicSeed("Darth Vader")
        candidates = (
            book("Darth Vader and Son", "9781452138220", creators=("Jeffrey Brown",)),
            book("Darth Vader Omnibus", "9781302908218", creators=("Kieron Gillen",)),
        )

        resolved = choose_seed_match(seed, candidates)

        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.metadata.title, "Darth Vader Omnibus")

    def test_rejects_two_distinct_equally_plausible_comics(self):
        seed = ComicSeed("Blackout")
        candidates = (
            book("Blackout", "9780000000001", creators=("First Creator",)),
            book("Blackout", "9780000000002", creators=("Second Creator",)),
        )

        self.assertIsNone(choose_seed_match(seed, candidates))

    def test_equivalent_editions_do_not_create_false_ambiguity(self):
        seed = ComicSeed("Saga", creators=("Brian K. Vaughan",))
        candidates = (
            book("Saga", "9781607066019", creators=("Brian K. Vaughan",)),
            book("Saga", "9781607066927", creators=("Brian K. Vaughan",), year=2013),
            book("Fear Street Saga", "9780000000003", creators=("R. L. Stine",), subjects=("Horror fiction",)),
        )

        resolved = choose_seed_match(seed, candidates)

        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.metadata.title, "Saga")


class NormalizationTests(unittest.TestCase):
    def recommendation(self, provider_id, title, rank, cover_url=""):
        return ComicRecommendation(
            provider="librarything",
            provider_id=provider_id,
            title=title,
            search_titles=(base_series_title(title), title),
            cover_url=cover_url,
            creators=("Brian K. Vaughan",),
            year=2015,
            seed_titles=("Saga",),
            isbns=(f"97800000000{rank:02d}",),
            rank=rank,
        )

    def test_duplicate_collected_editions_collapse_to_best_rank(self):
        collapsed = collapse_duplicate_editions((
            self.recommendation("11", "Paper Girls, Vol. 1", 1),
            self.recommendation("12", "Paper Girls Deluxe Edition", 3, "https://covers.example/paper.jpg"),
            self.recommendation("13", "Ex Machina, Vol. 1", 2),
        ))

        self.assertEqual([item.provider_id for item in collapsed], ["11", "13"])
        self.assertEqual(base_series_title("Paper Girls Deluxe Edition"), "Paper Girls")

    def test_public_contract_is_strict_and_comic_only(self):
        public = self.recommendation("11", "Paper Girls, Vol. 1", 1).to_public_dict()

        self.assertEqual(set(public), {
            "id", "provider", "providerId", "title", "searchTitles", "mediaFormat",
            "coverUrl", "creators", "year", "reason", "identifiers", "rank",
        })
        self.assertEqual(public["mediaFormat"], "comic")
        self.assertEqual(set(public["reason"]), {"type", "seedTitles"})
        self.assertEqual(set(public["identifiers"]), {"isbn"})

    def test_western_comic_filter_rejects_manga_subjects(self):
        self.assertTrue(is_comic_metadata(("Graphic novels", "Superheroes")))
        self.assertFalse(is_comic_metadata(("Graphic novels", "Manga", "Japanese comics")))

    def test_public_contract_drops_unsafe_cover_urls(self):
        recommendation = ComicRecommendation(
            provider="librarything",
            provider_id="safe-id",
            title="Paper Girls",
            search_titles=("Paper Girls",),
            cover_url="javascript:alert(1)",
            creators=(),
            year=2015,
            seed_titles=("Saga",),
            isbns=("9781632156747",),
            rank=1,
        )

        self.assertEqual(recommendation.to_public_dict()["coverUrl"], "")

    def test_cache_key_is_deterministic_opaque_and_provider_scoped(self):
        seeds = (ComicSeed("Saga", creators=("Brian K. Vaughan",)),)
        first = recommendation_cache_key(seeds, limit=12, provider_namespace="lt+ol")
        second = recommendation_cache_key(seeds, limit=12, provider_namespace="lt+ol")
        changed = recommendation_cache_key(seeds, limit=12, provider_namespace="metron")

        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)
        self.assertNotIn("saga", first.lower())


class AdapterTests(unittest.TestCase):
    def test_open_library_adapter_scores_all_candidates_instead_of_taking_first(self):
        def respond(_url, _params):
            return {
                "docs": [
                    {
                        "key": "/works/OL-NOVEL",
                        "title": "Invincible",
                        "author_name": ["Diana Palmer"],
                        "first_publish_year": 2014,
                        "isbn": ["1410474461"],
                        "subject": ["Romance fiction"],
                    },
                    {
                        "key": "/works/OL-COMIC",
                        "title": "Invincible, Vol. 1",
                        "author_name": ["Robert Kirkman", "Cory Walker"],
                        "first_publish_year": 2003,
                        "isbn": ["9781413194265"],
                        "subject": ["Graphic novels", "Superheroes"],
                        "cover_i": 123,
                    },
                ]
            }

        http = RecordingHttp(respond)
        adapter = OpenLibraryAdapter(http)

        resolved = adapter.resolve_seed(ComicSeed("Invincible", creators=("Robert Kirkman",)))

        self.assertEqual(resolved.metadata.work_id, "/works/OL-COMIC")
        self.assertEqual(http.calls[0]["params"]["title"], "Invincible")

    def test_librarything_secret_is_only_sent_upstream_and_never_represented(self):
        secret = "private-librarything-key"

        def respond(_url, _params):
            return {
                "request": [{"isbn": "9781607066019", "work": "seed-work"}],
                "recommendations": [{
                    "rank": 1,
                    "work": "recommended-work",
                    "fromworks": ["seed-work"],
                    "isbns": ["9781632156747"],
                }],
            }

        http = RecordingHttp(respond)
        adapter = LibraryThingAdapter(http, api_key=secret)
        seed = ComicSeed("Saga", creators=("Brian K. Vaughan",))
        resolved = (ResolvedSeedFixture(seed, book("Saga", "9781607066019", creators=seed.creators)),)

        hits = adapter.recommend(resolved)
        serialized = json.dumps([hit.__dict__ for hit in hits])

        self.assertEqual(hits[0].seed_titles, ("Saga",))
        self.assertEqual(http.calls[0]["params"]["apiKey"], secret)
        self.assertNotIn(secret, repr(adapter))
        self.assertNotIn(secret, serialized)

    def test_librarything_errors_are_normalized(self):
        http = RecordingHttp(lambda _url, _params: {"errorCode": "aut00001", "shortDesc": "Unauthorized"})
        adapter = LibraryThingAdapter(http, api_key="secret")
        seed = ComicSeed("Saga")

        with self.assertRaisesRegex(RecommendationProviderError, "Unauthorized"):
            adapter.recommend((ResolvedSeedFixture(seed, book("Saga", "9781607066019")),))


def ResolvedSeedFixture(seed, metadata):
    # Kept as a helper so test fixtures do not depend on adapter internals.
    from comic_recommendations import ResolvedSeed
    return ResolvedSeed(seed=seed, metadata=metadata, confidence=0.98)


class FakeFallback:
    namespace = "metron-test-v1"

    def __init__(self):
        self.calls = []

    def recommend(self, seeds, *, excluded_title_keys, limit):
        self.calls.append((tuple(seeds), excluded_title_keys, limit))
        return (
            ComicRecommendation(
                provider="metron",
                provider_id="8477",
                title="Paper Girls",
                search_titles=("Paper Girls",),
                cover_url="https://static.metron.example/paper-girls.jpg",
                creators=("Brian K. Vaughan",),
                year=2015,
                seed_titles=("Saga",),
                isbns=("9781632156747",),
                rank=1,
                reason_type="catalog_fallback",
            ),
        )[:limit]


class ServiceTests(unittest.TestCase):
    def test_build_feed_filters_non_comics_excludes_existing_and_collapses_editions(self):
        def respond(url, params):
            if url.endswith("search.json"):
                return {
                    "docs": [{
                        "key": "/works/SAGA",
                        "title": "Saga",
                        "author_name": ["Brian K. Vaughan"],
                        "first_publish_year": 2012,
                        "isbn": ["9781607066019"],
                        "subject": ["Graphic novels"],
                    }]
                }
            if "multirecommendations" in url:
                return {
                    "request": [{"isbn": "9781607066019", "work": "seed-saga"}],
                    "recommendations": [
                        {"rank": 1, "work": "paper-1", "fromworks": ["seed-saga"], "isbns": ["9781632156747"]},
                        {"rank": 2, "work": "novel", "fromworks": ["seed-saga"], "isbns": ["9780000000002"]},
                        {"rank": 3, "work": "paper-deluxe", "fromworks": ["seed-saga"], "isbns": ["9780000000003"]},
                        {"rank": 4, "work": "existing-saga", "fromworks": ["seed-saga"], "isbns": ["9780000000004"]},
                    ],
                }
            return {
                "ISBN:9781632156747": {
                    "title": "Paper Girls, Vol. 1",
                    "authors": [{"name": "Brian K. Vaughan"}],
                    "subjects": [{"name": "Graphic novels"}],
                    "identifiers": {"isbn_13": ["9781632156747"]},
                    "publish_date": "2016",
                    "cover": {"medium": "https://covers.example/paper.jpg"},
                },
                "ISBN:9780000000002": {
                    "title": "Ordinary Novel",
                    "authors": [{"name": "A. Writer"}],
                    "subjects": [{"name": "Domestic fiction"}],
                    "identifiers": {"isbn_13": ["9780000000002"]},
                },
                "ISBN:9780000000003": {
                    "title": "Paper Girls Deluxe Edition",
                    "authors": [{"name": "Brian K. Vaughan"}],
                    "subjects": [{"name": "Comic books, strips, etc."}],
                    "identifiers": {"isbn_13": ["9780000000003"]},
                },
                "ISBN:9780000000004": {
                    "title": "Saga, Vol. 2",
                    "authors": [{"name": "Brian K. Vaughan"}],
                    "subjects": [{"name": "Graphic novels"}],
                    "identifiers": {"isbn_13": ["9780000000004"]},
                },
            }

        http = RecordingHttp(respond)
        service = ComicRecommendationService(
            librarything=LibraryThingAdapter(http, api_key="secret-key"),
            open_library=OpenLibraryAdapter(http),
        )

        feed = service.build_feed((ComicSeed("Saga", creators=("Brian K. Vaughan",)),), limit=12)
        public = feed.to_public_dict()

        self.assertEqual(public["schemaVersion"], 1)
        self.assertEqual(public["mode"], "personalized")
        self.assertEqual([item["title"] for item in public["results"]], ["Paper Girls, Vol. 1"])
        self.assertEqual(public["results"][0]["reason"]["seedTitles"], ["Saga"])
        self.assertEqual(public["results"][0]["searchTitles"], ["Paper Girls", "Paper Girls, Vol. 1"])
        self.assertNotIn("secret-key", json.dumps(public))

    def test_metron_hook_fills_feed_when_primary_provider_fails(self):
        def respond(url, _params):
            if url.endswith("search.json"):
                return {
                    "docs": [{
                        "key": "/works/SAGA",
                        "title": "Saga",
                        "author_name": ["Brian K. Vaughan"],
                        "isbn": ["9781607066019"],
                        "subject": ["Graphic novels"],
                    }]
                }
            return {"errorCode": "upstream", "shortDesc": "Temporarily unavailable"}

        fallback = FakeFallback()
        http = RecordingHttp(respond)
        service = ComicRecommendationService(
            librarything=LibraryThingAdapter(http, api_key="secret-key"),
            open_library=OpenLibraryAdapter(http),
            fallback=fallback,
        )

        feed = service.build_feed((ComicSeed("Saga", creators=("Brian K. Vaughan",)),), limit=12)

        self.assertEqual(feed.mode, "fallback")
        self.assertEqual(feed.results[0].provider, "metron")
        self.assertEqual(len(fallback.calls), 1)
        self.assertIn("saga", fallback.calls[0][1])

    def test_provider_failure_without_fallback_is_reported_as_unavailable(self):
        http = RecordingHttp(lambda _url, _params: (_ for _ in ()).throw(OSError("offline")))
        service = ComicRecommendationService(
            librarything=LibraryThingAdapter(http, api_key="secret-key"),
            open_library=OpenLibraryAdapter(http),
        )

        feed = service.build_feed((ComicSeed("Saga"),), limit=12)

        self.assertEqual(feed.mode, "unavailable")
        self.assertEqual(feed.results, ())


if __name__ == "__main__":
    unittest.main()
