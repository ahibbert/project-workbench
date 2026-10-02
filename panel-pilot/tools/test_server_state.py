import pathlib
import json
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import PanelPilotHandler, SourceProfileStore, detect_panel_image  # noqa: E402


class DetectorProxyTests(unittest.TestCase):
    def test_manga_and_comic_use_separate_routes_and_cache_entries(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"panels": []}'
        response.status = 200
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict("os.environ", {
            "PANEL_PILOT_MANGA_DETECTOR_URL": "http://detector:8091",
            "PANEL_PILOT_MANGA_DETECTOR_CACHE_PATH": directory,
            "PANEL_PILOT_MANGA_DETECTOR_CACHE_VERSION": "comic-test",
        }), mock.patch("server.open_url", return_value=response) as opener:
            manga = detect_panel_image(b"same-image", "image/jpeg", "manga")
            comic = detect_panel_image(b"same-image", "image/jpeg", "comic")
            cached_manga = detect_panel_image(b"same-image", "image/jpeg", "manga")

        self.assertEqual(manga[1], "miss")
        self.assertEqual(comic[1], "miss")
        self.assertEqual(cached_manga[1], "hit")
        self.assertEqual(opener.call_count, 2)
        self.assertTrue(opener.call_args_list[0].args[0].full_url.endswith("/v1/manga/panels"))
        self.assertTrue(opener.call_args_list[1].args[0].full_url.endswith("/v1/comic/panels"))


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

    def test_library_cleaner_keeps_status_mangabaka_link_and_server_identity(self):
        cleaned = self.handler.clean_library_items([{
            "sourceId": "source",
            "mangaId": 7,
            "mangaTitle": "Kingdom",
            "libraryStatus": "reading",
            "statusExplicit": True,
            "mediaFormat": "comic",
            "started": True,
            "mangabakaId": 1797,
            "mangabakaTitle": "Kingdom",
            "mangabakaMatchSource": "exact-title",
            "mangabakaAccountKey": "user-123",
            "completedChapter": 486.5,
            "serverUrl": "http://suwayomi-a:4567",
        }])

        self.assertEqual(cleaned[0]["libraryStatus"], "reading")
        self.assertTrue(cleaned[0]["statusExplicit"])
        self.assertEqual(cleaned[0]["mediaFormat"], "comic")
        self.assertTrue(cleaned[0]["started"])
        self.assertEqual(cleaned[0]["mangabakaId"], 1797)
        self.assertEqual(cleaned[0]["mangabakaMatchSource"], "exact-title")
        self.assertEqual(cleaned[0]["mangabakaAccountKey"], "user-123")
        self.assertEqual(cleaned[0]["completedChapter"], 486.5)
        self.assertEqual(cleaned[0]["serverUrl"], "http://suwayomi-a:4567")

    def test_atomic_library_migration_replaces_old_and_existing_target_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            library_path = pathlib.Path(directory) / "library.json"
            library_path.write_text(json.dumps({"items": [
                {"sourceId": "old-source", "mangaId": 7, "mangaTitle": "Golden Kamuy", "pageIndex": 8, "updatedAt": "2026-10-01T00:00:00Z"},
                {"sourceId": "new-source", "mangaId": 9, "mangaTitle": "Golden Kamuy", "pageIndex": 1, "updatedAt": "2026-09-01T00:00:00Z"},
                {"sourceId": "other-source", "mangaId": 11, "mangaTitle": "Other", "updatedAt": "2026-10-01T00:00:00Z"},
            ]}), encoding="utf-8")
            replacement = {
                "sourceId": "new-source",
                "mangaId": 9,
                "mangaTitle": "Golden Kamuy",
                "libraryStatus": "reading",
                "pageIndex": 8,
                "updatedAt": "2026-10-02T00:00:00Z",
            }

            with mock.patch("server.LIBRARY_PATH", str(library_path)):
                stored = self.handler.migrate_library_item(
                    {"sourceId": "old-source", "mangaId": 7},
                    replacement,
                )

            identities = [(item["sourceId"], item["mangaId"]) for item in stored]
            self.assertEqual(identities.count(("new-source", 9)), 1)
            self.assertNotIn(("old-source", 7), identities)
            self.assertIn(("other-source", 11), identities)
            persisted = json.loads(library_path.read_text(encoding="utf-8"))["items"]
            self.assertEqual(persisted, stored)


class SourceProfileTests(unittest.TestCase):
    def test_profiles_accumulate_private_operational_evidence_and_rank_failures_lower(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SourceProfileStore(pathlib.Path(directory) / "source-profiles.json")
            summary = store.ingest([
                {"sourceId": "fast", "sourceLabel": "Fast Manga", "operation": "search", "outcome": "success", "latencyMs": 250, "mediaFormat": "manga"},
                {"sourceId": "slow", "sourceLabel": "Slow Manga", "operation": "search", "outcome": "success", "latencyMs": 12000, "mediaFormat": "manga"},
                {"sourceId": "broken", "sourceLabel": "Broken Comics", "operation": "pages", "outcome": "failure", "latencyMs": 800, "mediaFormat": "comic"},
            ])

            profiles = {profile["sourceId"]: profile for profile in summary["profiles"]}
            self.assertGreater(profiles["fast"]["score"], profiles["slow"]["score"])
            self.assertGreater(profiles["slow"]["score"], profiles["broken"]["score"])
            self.assertEqual(profiles["broken"]["consecutiveFailures"], 1)
            self.assertEqual(profiles["fast"]["formats"], {"manga": 1})
            self.assertNotIn("title", (pathlib.Path(directory) / "source-profiles.json").read_text(encoding="utf-8").lower())

    def test_profiles_reject_unbounded_or_identifying_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SourceProfileStore(pathlib.Path(directory) / "source-profiles.json")
            with self.assertRaisesRegex(ValueError, "invalid sourceId"):
                store.ingest([{"sourceId": "../escape", "operation": "search", "outcome": "success"}])
            with self.assertRaisesRegex(ValueError, "invalid operation"):
                store.ingest([{"sourceId": "source", "operation": "chapter-title", "outcome": "success"}])


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
