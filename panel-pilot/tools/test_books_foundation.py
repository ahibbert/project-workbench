import os
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

from books import BookStore, BooksConfig  # noqa: E402
from opds_client import OpdsClient, OpdsError, parse_opds_feed  # noqa: E402
from shelfmark_client import normalize_metadata_results, normalize_releases  # noqa: E402
from server import PanelPilotHandler  # noqa: E402


OPDS_FIXTURE = b'''<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/">
  <id>urn:panels:test</id><title>Test Library</title><updated>2026-10-02T00:00:00Z</updated>
  <link rel="next" href="?page=2" type="application/atom+xml" />
  <entry>
    <id>urn:uuid:alice</id><title>Alice's Adventures in Wonderland</title>
    <author><name>Lewis Carroll</name></author>
    <summary type="html">&lt;p&gt;A public-domain adventure.&lt;/p&gt;</summary>
    <dcterms:language>en</dcterms:language><dcterms:identifier>urn:isbn:9780000000001</dcterms:identifier>
    <link rel="http://opds-spec.org/image" href="covers/alice.jpg" type="image/jpeg" />
    <link rel="http://opds-spec.org/acquisition" href="download/alice.epub" type="application/epub+zip" />
  </entry>
</feed>'''


class BooksConfigurationTests(unittest.TestCase):
    def test_disabled_books_need_no_credentials_and_create_no_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "books.sqlite3"
            environment = {
                "BOOKS_ENABLED": "false",
                "PANEL_PILOT_BOOKS_DB_PATH": str(path),
                "SHELFMARK_BASE_URL": "",
                "SHELFMARK_API_KEY": "",
                "CWA_OPDS_URL": "",
                "CWA_USERNAME": "",
                "CWA_PASSWORD": "",
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                config = BooksConfig.from_environment(temporary)
            self.assertFalse(config.enabled)
            self.assertFalse(config.shelfmark_configured)
            self.assertFalse(config.cwa_configured)
            self.assertFalse(path.exists())
            self.assertEqual(config.public_status()["enabled"], False)

    def test_public_status_never_contains_credentials_or_upstream_urls(self):
        environment = {
            "BOOKS_ENABLED": "true",
            "SHELFMARK_BASE_URL": "http://shelfmark:8084",
            "SHELFMARK_API_KEY": "super-secret-key",
            "CWA_OPDS_URL": "http://cwa:8083/opds",
            "CWA_USERNAME": "reader@example.invalid",
            "CWA_PASSWORD": "private-password",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            status = BooksConfig.from_environment().public_status()
        serialized = repr(status)
        self.assertNotIn("super-secret-key", serialized)
        self.assertNotIn("private-password", serialized)
        self.assertNotIn("reader@example.invalid", serialized)
        self.assertNotIn("http://", serialized)
        self.assertTrue(status["shelfmarkConfigured"])
        self.assertTrue(status["cwaConfigured"])

    def test_disabled_status_handler_does_not_construct_store(self):
        handler = object.__new__(PanelPilotHandler)
        responses = []
        handler.send_json = lambda payload, status=200: responses.append((status, payload))
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {
            "BOOKS_ENABLED": "false",
            "PANEL_PILOT_BOOKS_DB_PATH": str(pathlib.Path(temporary) / "books.sqlite3"),
            "SHELFMARK_BASE_URL": "",
            "SHELFMARK_API_KEY": "",
            "CWA_OPDS_URL": "",
            "CWA_USERNAME": "",
            "CWA_PASSWORD": "",
        }, clear=False):
            handler.handle_books_status()
            self.assertFalse((pathlib.Path(temporary) / "books.sqlite3").exists())
        self.assertEqual(responses, [(200, {
            "enabled": False,
            "shelfmarkConfigured": False,
            "cwaConfigured": False,
            "syncIntervalSeconds": None,
        })])

    def test_store_uses_separate_versioned_schema(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "books.sqlite3"
            store = BookStore(str(path))
            self.assertEqual(store.counts(), {"books": 0, "activeDownloads": 0})
            with store.connection() as connection:
                tables = {row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )}
                version = connection.execute("PRAGMA user_version").fetchone()[0]
            self.assertEqual(version, 1)
            self.assertTrue({
                "books", "book_progress", "book_reader_preferences",
                "shelfmark_downloads", "book_meta",
            }.issubset(tables))

    def test_opds_sync_is_idempotent_and_matches_a_changed_stable_id_by_unique_isbn(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = BookStore(str(pathlib.Path(temporary) / "books.sqlite3"))
            fixture = {
                "stableIdentifier": "urn:old", "title": "Alice", "authors": ["Lewis Carroll"],
                "isbn": "9780000000001", "acquisitionHref": "http://cwa/old.epub",
                "coverHref": "", "description": "", "subtitle": "", "seriesName": "",
                "seriesPosition": None, "language": "en", "publisher": "", "publishedDate": "",
            }
            self.assertEqual(store.sync_books([fixture])["added"], 1)
            changed = {**fixture, "stableIdentifier": "urn:new", "acquisitionHref": "http://cwa/new.epub"}
            self.assertEqual(store.sync_books([changed]), {"seen": 1, "added": 0, "updated": 1})
            result = store.list_books()
            self.assertEqual(result["total"], 1)
            private = store.get_book(result["books"][0]["id"], public=False)
            self.assertEqual(private["cwa_identifier"], "urn:new")
            self.assertEqual(private["acquisition_href"], "http://cwa/new.epub")
            self.assertNotIn("acquisition_href", result["books"][0])


class ShelfmarkNormalizationTests(unittest.TestCase):
    def test_metadata_search_normalizes_documented_shape(self):
        results = normalize_metadata_results({"books": [{
            "provider": "hardcover",
            "provider_id": 427363,
            "title": "The Mercy of Gods",
            "authors": [{"name": "James S. A. Corey"}],
            "identifiers": {"isbn": "9780356517759"},
        }]})
        self.assertEqual(results[0]["providerBookId"], "427363")
        self.assertEqual(results[0]["authors"], ["James S. A. Corey"])
        self.assertEqual(results[0]["isbn"], "9780356517759")

    def test_releases_are_epub_only(self):
        releases = normalize_releases({"releases": [
            {"source": "direct_download", "source_id": "epub-1", "format": "epub", "size": 1234},
            {"source": "direct_download", "source_id": "pdf-1", "format": "pdf"},
        ]})
        self.assertEqual([item["id"] for item in releases], ["epub-1"])
        self.assertEqual(releases[0]["format"], "EPUB")
        self.assertEqual(releases[0]["sizeBytes"], 1234)


class OpdsParsingTests(unittest.TestCase):
    def test_feed_parser_extracts_acquisition_cover_and_next_page(self):
        result = parse_opds_feed(OPDS_FIXTURE, "http://cwa:8083/opds?page=1")
        self.assertEqual(result["title"], "Test Library")
        self.assertEqual(result["nextHref"], "http://cwa:8083/opds?page=2")
        book = result["books"][0]
        self.assertEqual(book["stableIdentifier"], "urn:uuid:alice")
        self.assertEqual(book["authors"], ["Lewis Carroll"])
        self.assertEqual(book["isbn"], "9780000000001")
        self.assertEqual(book["description"], "A public-domain adventure.")
        self.assertEqual(book["acquisitionHref"], "http://cwa:8083/download/alice.epub")

    def test_malformed_feed_has_normalized_error(self):
        with self.assertRaises(OpdsError) as raised:
            parse_opds_feed(b"<not-closed", "http://cwa:8083/opds")
        self.assertEqual(raised.exception.code, "invalid_feed")
        self.assertNotIn("not-closed", str(raised.exception))

    def test_catalog_follows_navigation_and_pagination_once(self):
        client = object.__new__(OpdsClient)
        client.catalog_url = "http://cwa/opds"
        client._safe_url = lambda url: url
        pages = {
            "http://cwa/opds": {"books": [], "nextHref": "", "navigationHrefs": ["http://cwa/new"]},
            "http://cwa/new": {"books": [{"stableIdentifier": "one"}], "nextHref": "http://cwa/new?page=2", "navigationHrefs": []},
            "http://cwa/new?page=2": {"books": [{"stableIdentifier": "two"}], "nextHref": "", "navigationHrefs": ["http://cwa/new"]},
        }
        client.page = lambda url=None: pages[url]
        self.assertEqual(
            [book["stableIdentifier"] for book in client.catalog()],
            ["one", "two"],
        )


if __name__ == "__main__":
    unittest.main()
