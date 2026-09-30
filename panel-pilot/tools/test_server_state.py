import pathlib
import sys
import unittest


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


if __name__ == "__main__":
    unittest.main()
