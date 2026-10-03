import base64
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from books import BookStore  # noqa: E402
JPEG = b"\xff\xd8\xff\xe0" + b"moment-image"


def free_port():
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


class MomentsHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        temporary_root = pathlib.Path(cls.temporary_directory.name)
        cls.moments_root = temporary_root / "moments"
        cls.books_path = temporary_root / "books.sqlite3"
        book_store = BookStore(str(cls.books_path))
        book_store.sync_books([{
            "stableIdentifier": "urn:test:alice",
            "title": "Alice's Adventures in Wonderland",
            "authors": ["Lewis Carroll"],
            "acquisitionHref": "download/alice.epub",
        }])
        book_store.ensure_owner_membership("local")
        cls.book_id = book_store.list_books("local")["books"][0]["id"]
        cls.port = free_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        environment = os.environ.copy()
        for name in ("PANEL_PILOT_AUTH_USER", "PANEL_PILOT_AUTH_PASSWORD", "PANEL_PILOT_SESSION_SECRET"):
            environment.pop(name, None)
        environment.update({
            "PANEL_PILOT_BIND_ADDRESS": "127.0.0.1",
            "PANEL_PILOT_STATIC_ROOT": str(ROOT / "dist"),
            "PANEL_PILOT_MOMENTS_PATH": str(cls.moments_root),
            "PANEL_PILOT_BOOKS_DB_PATH": str(cls.books_path),
            "PANEL_PILOT_READING_STATS_PATH": str(temporary_root / "reading-stats.sqlite3"),
            "BOOKS_ENABLED": "true",
            "SUWAYOMI_INTERNAL_URL": "http://127.0.0.1:4567",
        })
        cls.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), str(cls.port)],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                output = cls.process.stdout.read() if cls.process.stdout else ""
                raise RuntimeError(f"Panels server exited before accepting requests:\n{output}")
            try:
                with urlopen(f"{cls.base_url}/", timeout=0.25) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("Timed out waiting for Panels HTTP fixture")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        cls.temporary_directory.cleanup()

    def request_json(self, path, method="GET", payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"} if body else {},
        )
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_create_list_fetch_and_delete_a_private_moment(self):
        status, created = self.request_json("/api/moments", "POST", {
            "title": "Fixture title",
            "chapterTitle": "Chapter 7",
            "mediaFormat": "manga",
            "pageIndex": 3,
            "panelIndex": 2,
            "width": 1200,
            "height": 900,
            "imageDataUrl": "data:image/jpeg;base64," + base64.b64encode(JPEG).decode("ascii"),
        })
        self.assertEqual(status, 201)
        moment = created["moment"]
        self.assertRegex(moment["id"], r"^[0-9]{13}-[0-9a-f]{16}$")
        self.assertNotIn("imageDataUrl", moment)

        _, listed = self.request_json("/api/moments")
        self.assertEqual([item["id"] for item in listed["moments"]], [moment["id"]])
        with urlopen(f"{self.base_url}{moment['imageUrl']}", timeout=5) as response:
            self.assertEqual(response.headers.get_content_type(), "image/jpeg")
            self.assertEqual(response.read(), JPEG)

        status, deleted = self.request_json(f"/api/moments/{moment['id']}", "DELETE")
        self.assertEqual(status, 200)
        self.assertTrue(deleted["deleted"])
        self.assertEqual(list(self.moments_root.glob("*")), [])

    def test_rejects_a_spoofed_image_media_type(self):
        with self.assertRaises(HTTPError) as caught:
            self.request_json("/api/moments", "POST", {
                "width": 10,
                "height": 10,
                "imageDataUrl": "data:image/png;base64," + base64.b64encode(JPEG).decode("ascii"),
            })
        self.assertEqual(caught.exception.code, 400)

    def test_create_reopen_and_delete_a_book_text_moment(self):
        locator = "epubcfi(/6/4[chapter]!/4/2/2,/1:0,/1:24)"
        status, created = self.request_json("/api/moments", "POST", {
            "momentType": "text",
            "bookId": self.book_id,
            "title": "Alice's Adventures in Wonderland",
            "chapterTitle": "Down the Rabbit-Hole",
            "sourceLabel": "Lewis Carroll",
            "quote": "Alice was beginning to get very tired.",
            "locator": locator,
            "resourceHref": "chapter1.xhtml",
            "progression": 0.05,
        })
        self.assertEqual(status, 201)
        moment = created["moment"]
        self.assertEqual(moment["momentType"], "text")
        self.assertEqual(moment["mediaFormat"], "book")
        self.assertEqual(moment["bookId"], self.book_id)
        self.assertEqual(moment["locator"], locator)
        self.assertNotIn("imageUrl", moment)

        _, listed = self.request_json("/api/moments")
        listed_moment = next(item for item in listed["moments"] if item["id"] == moment["id"])
        self.assertEqual(listed_moment["quote"], "Alice was beginning to get very tired.")
        with self.assertRaises(HTTPError) as caught:
            urlopen(f"{self.base_url}/api/moments/{moment['id']}/image", timeout=5)
        self.assertEqual(caught.exception.code, 404)

        status, deleted = self.request_json(f"/api/moments/{moment['id']}", "DELETE")
        self.assertEqual(status, 200)
        self.assertTrue(deleted["deleted"])

    def test_rejects_book_moment_outside_the_current_library(self):
        with self.assertRaises(HTTPError) as caught:
            self.request_json("/api/moments", "POST", {
                "momentType": "text",
                "bookId": 999999,
                "quote": "Not this reader's book",
                "locator": "epubcfi(/6/4!/4/2/1:0)",
            })
        self.assertEqual(caught.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
