import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from book_recommendations import (  # noqa: E402
    BookRecommendationService,
    BookSeed,
    book_inventory_from_library,
    book_seeds_from_library,
    recommendation_cache_key,
)
from comic_recommendations import BookMetadata, ProviderRecommendationHit  # noqa: E402


class FakeLibraryThing:
    namespace = "librarything-test"

    def __init__(self, hits=(), error=None):
        self.hits = tuple(hits)
        self.error = error

    def recommend(self, resolved, *, limit):
        if self.error:
            raise self.error
        return self.hits[:limit]


class FakeOpenLibrary:
    namespace = "openlibrary-test"

    def __init__(self, metadata=(), search=()):
        self.metadata = {isbn: book for book in metadata for isbn in book.isbns}
        self.search = tuple(search)

    def lookup_isbns(self, isbns):
        return {isbn: self.metadata[isbn] for isbn in isbns if isbn in self.metadata}

    def search_books(self, title, *, authors=(), result_limit=10):
        return self.search[:result_limit]


def metadata(title, isbn, author="James S. A. Corey", *, series="", position=None, subjects=("Science fiction",)):
    return BookMetadata(
        title=title,
        isbns=(isbn,),
        creators=(author,),
        subjects=subjects,
        work_id=f"/works/{isbn}",
        series_name=series,
        series_position=position,
    )


class BookRecommendationTests(unittest.TestCase):
    def test_seed_selection_uses_positive_groups_and_keeps_full_inventory(self):
        books = [
            {"id": 1, "title": "Leviathan Wakes", "authors": ["James S. A. Corey"], "isbn": "9780316129084", "libraryStatus": "completed", "lastSyncedAt": "2026-01-01"},
            {"id": 2, "title": "A Future Read", "authors": ["Someone"], "libraryStatus": "plan_to_read"},
            {"id": 3, "title": "In Progress", "authors": ["Writer"], "libraryStatus": "reading", "progress": {"updatedAt": "2026-10-01"}},
        ]
        self.assertEqual([seed.title for seed in book_seeds_from_library(books)], ["In Progress", "Leviathan Wakes"])
        self.assertEqual(len(book_inventory_from_library(books)), 3)

    def test_owned_work_and_isbn_are_excluded_and_next_series_volume_is_kept(self):
        owned = (
            BookSeed(1, "Leviathan Wakes", ("James S. A. Corey",), "9780316129084", "The Expanse", 1, "completed"),
            BookSeed(2, "Already Here", ("A Writer",), "9780000000002", status="plan_to_read"),
        )
        candidates = (
            metadata("Caliban's War", "9780316129060", series="The Expanse", position=2),
            metadata("Abaddon's Gate", "9780316129077", series="The Expanse", position=3),
            metadata("Already Here", "9780000000002", author="A Writer"),
            metadata("Ancillary Justice", "9780316246620", author="Ann Leckie"),
        )
        hits = tuple(
            ProviderRecommendationHit("librarything", str(index), index, book.isbns, ("Leviathan Wakes",))
            for index, book in enumerate(candidates, 1)
        )
        service = BookRecommendationService(
            librarything=FakeLibraryThing(hits),
            open_library=FakeOpenLibrary(candidates),
        )
        feed = service.build_feed((owned[0],), owned_books=owned, limit=10)
        self.assertEqual([item.title for item in feed.results], ["Caliban's War", "Ancillary Justice"])
        self.assertEqual(feed.results[0].reason_type, "next_in_series")
        self.assertEqual(feed.results[0].series_position, 2)

    def test_comics_are_not_returned_as_text_books(self):
        comic = metadata("Saga", "9781607066019", author="Brian K. Vaughan", subjects=("Comic books", "Graphic novels"))
        hit = ProviderRecommendationHit("librarything", "saga", 1, comic.isbns, ("A Seed",))
        service = BookRecommendationService(
            librarything=FakeLibraryThing((hit,)),
            open_library=FakeOpenLibrary((comic,)),
        )
        feed = service.build_feed((BookSeed(1, "A Seed", ("Writer",), "9780000000001", status="completed"),))
        self.assertEqual(feed.results, ())

    def test_unavailable_feed_contains_no_provider_error_or_credentials(self):
        service = BookRecommendationService(
            librarything=FakeLibraryThing(error=RuntimeError("secret key: abc")),
            open_library=FakeOpenLibrary(),
        )
        seed = BookSeed(1, "A Seed", ("Writer",), "9780000000001", status="completed")
        public = service.build_feed((seed,)).to_public_dict()
        self.assertEqual(public["mode"], "unavailable")
        self.assertNotIn("secret", str(public).lower())

    def test_cache_key_changes_with_library_and_provider(self):
        seed = BookSeed(1, "A Seed", ("Writer",), "9780000000001", status="completed")
        first = recommendation_cache_key((seed,), limit=12, provider_namespace="one")
        self.assertEqual(first, recommendation_cache_key((seed,), limit=12, provider_namespace="one"))
        self.assertNotEqual(first, recommendation_cache_key((seed,), limit=12, provider_namespace="two"))

    def test_open_library_hash_series_suffix_is_normalized(self):
        seed = BookSeed(1, "Leviathan Wakes", ("James S. A. Corey",), "9780316129084", "The Expanse #1", status="completed")
        self.assertEqual(seed.series_name, "The Expanse")
        self.assertEqual(seed.series_position, 1)


if __name__ == "__main__":
    unittest.main()
