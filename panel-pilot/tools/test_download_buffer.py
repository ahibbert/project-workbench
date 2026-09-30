import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import DownloadBufferManager  # noqa: E402


class DownloadBufferManagerTests(unittest.TestCase):
    def test_queue_is_deduplicated_and_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "buffer.json"
            manager = DownloadBufferManager(str(path))
            status = manager.enqueue([10, 11, 10, 0, "bad"])
            self.assertEqual(status["added"], 2)
            self.assertEqual(status["queued"], 2)

            restored = DownloadBufferManager(str(path))
            self.assertEqual([item["chapterId"] for item in restored.tasks], [10, 11])

    def test_failure_applies_source_wide_exponential_backoff(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = DownloadBufferManager(str(pathlib.Path(directory) / "buffer.json"))
            manager.enqueue([20, 21])
            manager.active_chapter_id = 20

            with mock.patch("server.time.time", return_value=1_000):
                manager.complete_active(20, downloaded=False)

            self.assertEqual(manager.tasks[0]["attempts"], 1)
            self.assertEqual({item["notBefore"] for item in manager.tasks}, {1_180})
            self.assertIsNone(manager.active_chapter_id)


if __name__ == "__main__":
    unittest.main()
