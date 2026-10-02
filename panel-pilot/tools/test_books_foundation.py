import os
import pathlib
import sqlite3
from datetime import datetime, timedelta, timezone
import tempfile
import unittest
from unittest import mock
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

from books import (  # noqa: E402
    BookRequestError, BookStore, BooksConfig, BooksService,
    sanitize_epub_archive, validate_epub_archive,
)
from opds_client import OpdsClient, OpdsError, parse_opds_feed  # noqa: E402
from shelfmark_client import normalize_metadata_results, normalize_releases  # noqa: E402
from server import PanelPilotHandler  # noqa: E402


OPDS_FIXTURE = b'''<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata">
  <id>urn:panels:test</id><title>Test Library</title><updated>2026-10-02T00:00:00Z</updated>
  <link rel="next" href="?page=2" type="application/atom+xml" />
  <entry>
    <id>urn:uuid:alice</id><title>Alice's Adventures in Wonderland</title>
    <author><name>Lewis Carroll</name></author>
    <summary type="html">&lt;p&gt;A public-domain adventure.&lt;/p&gt;</summary>
    <dcterms:language>en</dcterms:language><dcterms:identifier>urn:isbn:9780000000001</dcterms:identifier>
    <calibre:series>Alice</calibre:series><calibre:series_index>1</calibre:series_index>
    <link rel="http://opds-spec.org/image" href="covers/alice.jpg" type="image/jpeg" />
    <link rel="http://opds-spec.org/acquisition" href="download/alice.epub" type="application/epub+zip" />
  </entry>
</feed>'''


class BooksConfigurationTests(unittest.TestCase):
    def test_opds_extracts_calibre_series_metadata(self):
        parsed = parse_opds_feed(OPDS_FIXTURE, "http://cwa/opds")
        self.assertEqual(parsed["books"][0]["seriesName"], "Alice")
        self.assertEqual(parsed["books"][0]["seriesPosition"], 1.0)

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
            self.assertEqual(version, 3)
            self.assertTrue({
                "books", "book_progress", "book_reader_preferences",
                "shelfmark_downloads", "book_meta",
            }.issubset(tables))

    def test_version_one_store_migrates_book_library_groups_and_removal_tombstone(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "books.sqlite3"
            connection = sqlite3.connect(path)
            connection.executescript("""
                CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
                CREATE TABLE book_progress (book_id INTEGER, progression REAL);
                PRAGMA user_version = 1;
            """)
            connection.close()
            store = BookStore(str(path))
            with store.connection() as migrated:
                version = migrated.execute("PRAGMA user_version").fetchone()[0]
                columns = {row[1] for row in migrated.execute("PRAGMA table_info(books)")}
            self.assertEqual(version, 3)
            self.assertIn("library_status", columns)
            self.assertIn("removed_at", columns)

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

    def test_exact_cfi_progress_uses_optimistic_revisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = BookStore(str(pathlib.Path(temporary) / "books.sqlite3"))
            store.sync_books([{
                "stableIdentifier": "urn:alice", "title": "Alice", "authors": ["Lewis Carroll"],
                "isbn": "", "acquisitionHref": "http://cwa/alice.epub", "coverHref": "",
            }])
            book_id = store.list_books()["books"][0]["id"]
            self.assertEqual(store.get_book(book_id)["libraryStatus"], "plan_to_read")
            self.assertEqual(store.set_library_status(book_id, "paused")["libraryStatus"], "paused")
            with self.assertRaisesRegex(BookRequestError, "Invalid book library group"):
                store.set_library_status(book_id, "on_fire")
            store.set_library_status(book_id, "plan_to_read")
            first = store.save_progress("reader", book_id, {
                "locatorType": "cfi", "locator": "epubcfi(/6/2!/4/2/1:0)",
                "resourceHref": "chapter-1.xhtml", "progression": 0.125, "revision": 0,
            })
            self.assertEqual(first["revision"], 1)
            self.assertEqual(store.get_book(book_id)["libraryStatus"], "reading")
            self.assertEqual(store.get_progress("reader", book_id)["locator"], "epubcfi(/6/2!/4/2/1:0)")
            with self.assertRaises(BookRequestError) as raised:
                store.save_progress("reader", book_id, {
                    "locatorType": "cfi", "locator": "epubcfi(/6/4!/4/2/1:0)", "revision": 0,
                })
            self.assertEqual(raised.exception.status, 409)
            self.assertEqual(raised.exception.current["revision"], 1)

    def test_remove_book_hides_it_and_prevents_opds_sync_from_restoring_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = BookStore(str(pathlib.Path(temporary) / "books.sqlite3"))
            fixture = {
                "stableIdentifier": "urn:alice", "title": "Alice", "authors": ["Lewis Carroll"],
                "isbn": "9780000000001", "acquisitionHref": "http://cwa/alice.epub", "coverHref": "",
            }
            store.sync_books([fixture])
            book_id = store.list_books()["books"][0]["id"]
            self.assertTrue(store.remove_book(book_id)["removed"])
            self.assertEqual(store.list_books()["total"], 0)
            self.assertIsNone(store.get_book(book_id))
            store.sync_books([{**fixture, "title": "Alice Updated"}])
            self.assertEqual(store.list_books()["total"], 0)
            self.assertEqual(store.get_book(book_id, public=False, include_removed=True)["title"], "Alice Updated")

    def test_reader_preferences_are_validated_and_persisted(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = BookStore(str(pathlib.Path(temporary) / "books.sqlite3"))
            saved = store.save_preferences("reader", {
                "theme": "sepia", "fontSize": 125, "lineHeight": 1.8, "readingFlow": "scrolled",
            })
            self.assertEqual(saved["theme"], "sepia")
            self.assertEqual(saved["fontSize"], 125)
            self.assertEqual(saved["readingFlow"], "scrolled")
            with self.assertRaisesRegex(BookRequestError, "Invalid book theme"):
                store.save_preferences("reader", {"theme": "neon"})

    def test_cwa_import_timeout_becomes_a_manageable_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = BookStore(str(pathlib.Path(temporary) / "books.sqlite3"))
            store.save_download(
                task_id="stale-import", provider="openlibrary", provider_book_id="alice",
                title="Alice", isbn="", authors=["Lewis Carroll"],
            )
            store.update_download("stale-import", status="importing", progress=1)
            old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
            with store.connection() as connection:
                connection.execute(
                    "UPDATE shelfmark_downloads SET updated_at = ? WHERE task_id = 'stale-import'", (old,)
                )
            self.assertEqual(store.fail_stale_imports(), 1)
            failed = store.get_download("stale-import")
            self.assertEqual(failed["status"], "failed")
            self.assertIn("did not import", failed["error"])


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

    def test_release_tokens_keep_raw_download_urls_server_side(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = BooksConfig(
                enabled=True,
                database_path=str(pathlib.Path(temporary) / "books.sqlite3"),
                cache_path=str(pathlib.Path(temporary) / "cache"),
                sync_interval_seconds=300,
                shelfmark_base_url="http://shelfmark:8084",
                shelfmark_api_key="secret-key",
                cwa_opds_url="http://cwa:8083/opds",
                cwa_username="reader",
                cwa_password="password",
            )
            service = BooksService(config)

            class FakeShelfmark:
                queued = None

                def releases(self, provider, provider_book_id):
                    return [{
                        "id": "release-1", "source": "direct_download", "title": "Alice EPUB",
                        "language": "en", "format": "EPUB", "sizeBytes": 2048, "seeders": None,
                        "_release": {
                            "source": "direct_download", "source_id": "release-1", "format": "epub",
                            "download_url": "https://secret-upstream.invalid/alice.epub",
                        },
                    }]

                def queue_download(self, release):
                    self.queued = release
                    return {"status": "queued"}

                def download_status(self):
                    return {"error": {"release-1": {"id": "release-1"}}}

            fake = FakeShelfmark()
            service.shelfmark_client = lambda: fake
            service._book_tokens["book-token"] = (9999999999, {
                "provider": "openlibrary", "providerBookId": "alice", "title": "Alice",
                "authors": ["Lewis Carroll"], "isbn": "9780000000001",
            })
            public = service.releases("openlibrary", "alice")
            self.assertEqual(len(public), 1)
            self.assertIn("token", public[0])
            self.assertNotIn("_release", public[0])
            self.assertNotIn("download_url", repr(public))
            download = service.queue_download(public[0]["token"], "book-token")
            self.assertEqual(download["status"], "queued")
            self.assertEqual(download["taskId"], "release-1")
            self.assertEqual(fake.queued["download_url"], "https://secret-upstream.invalid/alice.epub")
            failed = service.refresh_downloads()[0]
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["error"], "Shelfmark reported a download failure")
            with self.assertRaisesRegex(ValueError, "expired"):
                service.queue_download(public[0]["token"], "book-token")


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

    def test_cwa_profile_navigation_prefers_books_then_all(self):
        root = parse_opds_feed(b'''<feed xmlns="http://www.w3.org/2005/Atom">
          <id>root</id><title>CWA</title>
          <entry><id>authors</id><title>Authors</title><link href="/opds/author" type="application/atom+xml;profile=opds-catalog"/></entry>
          <entry><id>books</id><title>Alphabetical Books</title><link href="/opds/books" type="application/atom+xml;profile=opds-catalog"/></entry>
        </feed>''', "http://cwa:8083/opds")
        self.assertEqual(root["navigationHrefs"], ["http://cwa:8083/opds/books"])
        letters = parse_opds_feed(b'''<feed xmlns="http://www.w3.org/2005/Atom">
          <id>letters</id><title>CWA</title>
          <entry><id>all</id><title>All</title><link rel="subsection" href="/opds/books/letter/00" type="application/atom+xml;profile=opds-catalog"/></entry>
          <entry><id>a</id><title>A</title><link rel="subsection" href="/opds/books/letter/A" type="application/atom+xml;profile=opds-catalog"/></entry>
        </feed>''', "http://cwa:8083/opds/books")
        self.assertEqual(letters["navigationHrefs"], ["http://cwa:8083/opds/books/letter/00"])

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


class EpubValidationTests(unittest.TestCase):
    def test_minimal_public_domain_epub_fixture_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "alice-excerpt.epub"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
                archive.writestr("META-INF/container.xml", """<?xml version='1.0'?><container xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='EPUB/package.opf' media-type='application/oebps-package+xml'/></rootfiles></container>""")
                archive.writestr("EPUB/package.opf", """<?xml version='1.0'?><package xmlns='http://www.idpf.org/2007/opf' version='3.0'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>Alice excerpt</dc:title><dc:language>en</dc:language><dc:identifier>public-domain-fixture</dc:identifier></metadata><manifest><item id='c1' href='c1.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='c1'/></spine></package>""")
                archive.writestr("EPUB/c1.xhtml", "<html xmlns='http://www.w3.org/1999/xhtml'><body><p>Alice was beginning to get very tired.</p></body></html>")
            validate_epub_archive(path)

    def test_malformed_and_path_traversal_epubs_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            malformed = pathlib.Path(temporary) / "malformed.epub"
            malformed.write_bytes(b"not a zip")
            with self.assertRaises(BookRequestError) as raised:
                validate_epub_archive(malformed)
            self.assertEqual(raised.exception.code, "malformed_epub")

            traversal = pathlib.Path(temporary) / "traversal.epub"
            with zipfile.ZipFile(traversal, "w") as archive:
                archive.writestr("mimetype", "application/epub+zip")
                archive.writestr("META-INF/container.xml", "container")
                archive.writestr("../escape.xhtml", "unsafe")
            with self.assertRaisesRegex(BookRequestError, "unsafe archive"):
                validate_epub_archive(traversal)

    def test_epub_sanitizer_removes_scripts_handlers_and_remote_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary) / "source.epub"
            destination = pathlib.Path(temporary) / "sanitized.epub"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
                archive.writestr("META-INF/container.xml", "container")
                archive.writestr("EPUB/c1.xhtml", """<html xmlns='http://www.w3.org/1999/xhtml'><head/><body onload='steal()'><script>alert(1)</script><img src='https://tracker.invalid/pixel'/><a href='javascript:steal()'>Safe text</a></body></html>""")
                archive.writestr("EPUB/book.css", "@import 'https://tracker.invalid/style.css'; p{background:url(//tracker.invalid/pixel)}")
            sanitize_epub_archive(source, destination)
            with zipfile.ZipFile(destination) as archive:
                html = archive.read("EPUB/c1.xhtml").decode("utf-8")
                css = archive.read("EPUB/book.css").decode("utf-8")
            self.assertNotIn("<script", html)
            self.assertNotIn("onload", html)
            self.assertNotIn("tracker.invalid", html)
            self.assertNotIn("javascript:", html)
            self.assertIn("Content-Security-Policy", html)
            self.assertNotIn("tracker.invalid", css)


if __name__ == "__main__":
    unittest.main()
