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

    def test_prepared_chapter_is_not_requeued(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = DownloadBufferManager(str(pathlib.Path(directory) / "buffer.json"))
            manager.prepared_chapters.add(15)
            status = manager.enqueue([15, 16])

            self.assertEqual(status["added"], 1)
            self.assertEqual([item["chapterId"] for item in manager.tasks], [16])

    def test_failure_only_backs_off_the_failed_chapter(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = DownloadBufferManager(str(pathlib.Path(directory) / "buffer.json"))
            manager.enqueue([20, 21])
            manager.active_chapter_id = 20

            with mock.patch("server.time.time", return_value=1_000):
                manager.complete_active(20, downloaded=False)

            self.assertEqual([item["chapterId"] for item in manager.tasks], [21, 20])
            self.assertEqual(manager.tasks[1]["attempts"], 1)
            self.assertEqual(manager.tasks[0]["notBefore"], 0)
            self.assertEqual(manager.tasks[1]["notBefore"], 1_180)
            self.assertIn("stopped", manager.tasks[1]["lastError"].lower())
            self.assertIsNone(manager.active_chapter_id)

    def test_repeated_failure_moves_chapter_to_dead_letter(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = DownloadBufferManager(str(pathlib.Path(directory) / "buffer.json"))
            manager.enqueue([30])
            manager.tasks[0]["attempts"] = manager.MAX_ATTEMPTS - 1
            manager.active_chapter_id = 30

            with mock.patch("server.time.time", return_value=2_000):
                manager.complete_active(30, downloaded=False, error_message="rate limited")

            self.assertEqual(manager.tasks, [])
            self.assertEqual(manager.failures[0]["chapterId"], 30)
            self.assertEqual(manager.status()["failed"], 1)

            status = manager.retry_failures()
            self.assertEqual(status["restored"], 1)
            self.assertEqual(status["failed"], 0)
            self.assertEqual(manager.tasks[0]["chapterId"], 30)


if __name__ == "__main__":
    unittest.main()
