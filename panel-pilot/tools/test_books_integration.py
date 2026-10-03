import base64
from contextlib import contextmanager
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pathlib
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlparse


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from books import BooksConfig, BooksService  # noqa: E402
from opds_client import OpdsClient, OpdsConfig, OpdsError  # noqa: E402
from shelfmark_client import ShelfmarkClient, ShelfmarkConfig  # noqa: E402


EPUB_BYTES = base64.b64decode(
    (ROOT / "tests" / "fixtures" / "alice-public-domain.epub.b64").read_text(encoding="utf-8")
)


class UpstreamHandler(BaseHTTPRequestHandler):
    api_key = "fixture-secret-key"
    basic = "Basic " + base64.b64encode(b"reader:fixture-password").decode("ascii")
    requests = []

    def log_message(self, *_args):
        return

    def record(self, body=b""):
        self.__class__.requests.append({
            "method": self.command,
            "path": self.path,
            "authorization": self.headers.get("Authorization", ""),
            "body": body,
        })

    def send_payload(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload, status=200):
        self.send_payload(status, "application/json", json.dumps(payload).encode("utf-8"))

    def require_bearer(self):
        if self.headers.get("Authorization") != f"Bearer {self.api_key}":
            self.send_json({"error": "Unauthorized"}, 401)
            return False
        return True

    def require_basic(self):
        if self.headers.get("Authorization") != self.basic:
            self.send_json({"error": "Unauthorized"}, 401)
            return False
        return True

    def do_GET(self):
        self.record()
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"status": "ok"})
            return
        if parsed.path.startswith("/api/"):
            if not self.require_bearer():
                return
            if parsed.path == "/api/status":
                self.send_json({"queued": {}, "downloading": {}, "complete": {}})
            elif parsed.path == "/api/metadata/search":
                self.send_json({
                    "provider": "openlibrary",
                    "books": [{
                        "provider_id": "OL138052W", "title": "Alice's Adventures in Wonderland",
                        "authors": ["Lewis Carroll"], "isbn_13": "9780000000001", "publish_year": 1865,
                    }],
                })
            elif parsed.path == "/api/releases":
                self.send_json({"releases": [
                    {"source": "direct_download", "source_id": "epub-1", "title": "Alice.epub", "format": "epub", "download_url": "https://private.invalid/alice"},
                    {"source": "direct_download", "source_id": "pdf-1", "title": "Alice.pdf", "format": "pdf"},
                ]})
            else:
                self.send_json({"error": "missing"}, 404)
            return
        if not self.require_basic():
            return
        host = f"http://127.0.0.1:{self.server.server_address[1]}"
        if parsed.path == "/opds":
            body = f'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>root</id><title>Fixture</title><link rel="search" type="application/atom+xml" href="{host}/opds/search/{{searchTerms}}"/><entry><id>nav</id><title>Alphabetical Books</title><link type="application/atom+xml;profile=opds-catalog" href="{host}/opds/books"/></entry></feed>'''.encode()
            self.send_payload(200, "application/atom+xml", body)
        elif parsed.path == "/opds/books":
            body = f'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>letters</id><title>Books</title><entry><id>all</id><title>All</title><link rel="subsection" type="application/atom+xml;profile=opds-catalog" href="{host}/opds/books/letter/00?page=1"/></entry></feed>'''.encode()
            self.send_payload(200, "application/atom+xml", body)
        elif parsed.path == "/opds/books/letter/00" and parse_qs(parsed.query).get("page") == ["1"]:
            body = f'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>page1</id><title>Books</title><link rel="next" href="{host}/opds/books/letter/00?page=2"/><entry><id>urn:alice</id><title>Alice</title><author><name>Lewis Carroll</name></author><link rel="http://opds-spec.org/image" type="image/jpeg" href="{host}/cover.jpg"/><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="{host}/alice.epub"/></entry></feed>'''.encode()
            self.send_payload(200, "application/atom+xml", body)
        elif parsed.path == "/opds/books/letter/00":
            body = f'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>page2</id><title>Books</title><entry><id>urn:pride</id><title>Pride and Prejudice</title><author><name>Jane Austen</name></author><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="{host}/missing.epub"/></entry></feed>'''.encode()
            self.send_payload(200, "application/atom+xml", body)
        elif parsed.path == "/opds/search/Alice":
            body = f'''<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>search</id><title>Search</title><entry><id>urn:alice</id><title>Alice</title><author><name>Lewis Carroll</name></author><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="{host}/alice.epub"/></entry></feed>'''.encode()
            self.send_payload(200, "application/atom+xml", body)
        elif parsed.path == "/cover.jpg":
            self.send_payload(200, "image/jpeg", b"\xff\xd8\xff\xd9")
        elif parsed.path == "/alice.epub":
            self.send_payload(200, "application/epub+zip", EPUB_BYTES)
        else:
            self.send_json({"error": "missing"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.record(body)
        if not self.require_bearer():
            return
        if urlparse(self.path).path == "/api/releases/download":
            release = json.loads(body)
            self.send_json({"status": "queued", "id": release["source_id"]})
        else:
            self.send_json({"error": "missing"}, 404)


@contextmanager
def upstream_server():
    UpstreamHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class ShelfmarkIntegrationTests(unittest.TestCase):
    def test_documented_search_release_download_and_status_flow(self):
        with upstream_server() as base:
            client = ShelfmarkClient(ShelfmarkConfig(base, UpstreamHandler.api_key))
            self.assertTrue(client.health()["ok"])
            books = client.search("Alice")
            self.assertEqual(books[0]["provider"], "openlibrary")
            self.assertEqual(books[0]["providerBookId"], "OL138052W")
            releases = client.releases("openlibrary", "OL138052W")
            self.assertEqual(len(releases), 1)
            self.assertEqual(releases[0]["format"], "EPUB")
            queued = client.queue_download(releases[0]["_release"])
            self.assertEqual(queued["id"], "epub-1")
            self.assertIsInstance(client.download_status(), dict)
            protected = [request for request in UpstreamHandler.requests if request["path"].startswith("/api/") and request["path"] != "/api/health"]
            self.assertTrue(all(request["authorization"] == f"Bearer {UpstreamHandler.api_key}" for request in protected))


class OpdsIntegrationTests(unittest.TestCase):
    def test_authenticated_catalog_pagination_cover_and_epub_acquisition(self):
        with upstream_server() as base, tempfile.TemporaryDirectory() as temporary:
            client = OpdsClient(OpdsConfig(f"{base}/opds", "reader", "fixture-password"))
            books = client.catalog()
            self.assertEqual([book["title"] for book in books], ["Alice", "Pride and Prejudice"])
            self.assertEqual([book["title"] for book in client.search("Alice")], ["Alice"])
            cover, content_type = client.cover(books[0]["coverHref"])
            self.assertEqual(content_type, "image/jpeg")
            self.assertEqual(cover[:2], b"\xff\xd8")
            target = pathlib.Path(temporary) / "alice.epub"
            with open(target, "wb") as handle:
                size, content_type = client.download_epub(books[0]["acquisitionHref"], handle)
            self.assertEqual(size, len(EPUB_BYTES))
            self.assertEqual(content_type, "application/epub+zip")
            self.assertEqual(target.read_bytes(), EPUB_BYTES)
            opds_requests = [request for request in UpstreamHandler.requests if not request["path"].startswith("/api/")]
            self.assertTrue(all(request["authorization"] == UpstreamHandler.basic for request in opds_requests))

    def test_unavailable_acquisition_has_a_normalized_error(self):
        with upstream_server() as base, tempfile.TemporaryDirectory() as temporary:
            client = OpdsClient(OpdsConfig(f"{base}/opds", "reader", "fixture-password"))
            books = client.catalog()
            with open(pathlib.Path(temporary) / "missing.epub", "wb") as handle:
                with self.assertRaises(OpdsError) as raised:
                    client.download_epub(books[1]["acquisitionHref"], handle)
            self.assertEqual(raised.exception.code, "acquisition_unavailable")
            self.assertNotIn("fixture-password", str(raised.exception))


class BooksServiceIntegrationTests(unittest.TestCase):
    def test_shelfmark_to_opds_to_sanitized_epub_vertical_slice(self):
        with upstream_server() as base, tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            config = BooksConfig(
                enabled=True,
                shelfmark_base_url=base,
                shelfmark_api_key=UpstreamHandler.api_key,
                cwa_opds_url=f"{base}/opds",
                cwa_username="reader",
                cwa_password="fixture-password",
                database_path=str(root / "books.sqlite3"),
                cache_path=str(root / "cache"),
                sync_interval_seconds=300,
            )
            service = BooksService(config)

            synced = service.sync_library()
            self.assertEqual(synced["status"], "complete")
            library = service.list_books("local")
            self.assertEqual(library["total"], 2)
            alice = next(book for book in library["books"] if book["title"] == "Alice")

            results = service.search("Alice")
            releases = service.releases(results[0]["provider"], results[0]["providerBookId"])
            queued = service.queue_download(releases[0]["token"], results[0]["token"])
            self.assertEqual(queued["status"], "queued")

            epub = service.epub_path(alice["id"])
            self.assertTrue(epub.is_file())
            self.assertGreater(epub.stat().st_size, 0)
            self.assertTrue(service.store.get_book(alice["id"], public=False)["content_hash"])


if __name__ == "__main__":
    unittest.main()
