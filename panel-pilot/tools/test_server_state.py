import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import PanelPilotHandler  # noqa: E402


class LibraryMergeTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(PanelPilotHandler)

    def test_stale_full_library_write_cannot_replace_newer_progress(self):
        incoming = [{
            "sourceId": "source",
            "mangaId": 1,
            "pageIndex": 3,
            "updatedAt": "2026-09-30T10:00:00.000Z",
        }]
        existing = [{
            "sourceId": "source",
            "mangaId": 1,
            "pageIndex": 8,
            "updatedAt": "2026-09-30T10:01:00.000Z",
        }]

        merged = self.handler.merge_library_items(incoming, existing)

        self.assertEqual(merged[0]["pageIndex"], 8)

    def test_newer_flags_and_progress_replace_older_item(self):
        incoming = [{
            "sourceId": "source",
            "mangaId": 1,
            "pageIndex": 9,
            "pinned": True,
            "updatedAt": "2026-09-30T10:02:00.000Z",
        }]
        existing = [{
            "sourceId": "source",
            "mangaId": 1,
            "pageIndex": 8,
            "pinned": False,
            "updatedAt": "2026-09-30T10:01:00.000Z",
        }]

        merged = self.handler.merge_library_items(incoming, existing)

        self.assertEqual(merged[0]["pageIndex"], 9)
        self.assertTrue(merged[0]["pinned"])

    def test_library_cleaner_keeps_status_and_mangabaka_link(self):
        cleaned = self.handler.clean_library_items([{
            "sourceId": "source",
            "mangaId": 7,
            "mangaTitle": "Kingdom",
            "libraryStatus": "reading",
            "statusExplicit": True,
            "started": True,
            "mangabakaId": 1797,
            "mangabakaTitle": "Kingdom",
            "mangabakaMatchSource": "exact-title",
            "mangabakaAccountKey": "user-123",
            "completedChapter": 486.5,
        }])

        self.assertEqual(cleaned[0]["libraryStatus"], "reading")
        self.assertTrue(cleaned[0]["statusExplicit"])
        self.assertTrue(cleaned[0]["started"])
        self.assertEqual(cleaned[0]["mangabakaId"], 1797)
        self.assertEqual(cleaned[0]["mangabakaMatchSource"], "exact-title")
        self.assertEqual(cleaned[0]["mangabakaAccountKey"], "user-123")
        self.assertEqual(cleaned[0]["completedChapter"], 486.5)


class MangaBakaSyncTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(PanelPilotHandler)
        self.responses = []
        self.handler.send_json = lambda payload, status=200: self.responses.append((status, payload))

    @mock.patch("server.read_mangabaka_token", return_value="token-account-a")
    def test_batch_uses_captured_token_after_profile_verification(self, _read_token):
        self.handler.read_json_request = lambda maximum: {
            "accountKey": "account-a",
            "entries": [{"series_id": 7, "state": "reading", "progress_chapter": 12}],
        }
        calls = []

        def manga_json(path, method="GET", payload=None, token=None):
            calls.append((path, method, payload, token))
            if path == "/v1/my/profile":
                return {"data": {"id": "account-a"}}
            return {"updated": 1}

        self.handler.mangabaka_json = manga_json
        self.handler.handle_mangabaka_library_post()

        self.assertEqual(calls[-1][0], "/v1/my/library/batch")
        self.assertEqual(calls[-1][3], "token-account-a")
        self.assertEqual(self.responses, [(200, {"updated": 1})])

    @mock.patch("server.read_mangabaka_token", return_value="token-account-b")
    def test_batch_rejects_account_switch_before_write(self, _read_token):
        self.handler.read_json_request = lambda maximum: {
            "accountKey": "account-a",
            "entries": [{"series_id": 7, "state": "reading"}],
        }
        calls = []

        def manga_json(path, method="GET", payload=None, token=None):
            calls.append(path)
            return {"data": {"id": "account-b"}}

        self.handler.mangabaka_json = manga_json
        self.handler.handle_mangabaka_library_post()

        self.assertEqual(calls, ["/v1/my/profile"])
        self.assertEqual(self.responses[0][0], 409)


if __name__ == "__main__":
    unittest.main()
