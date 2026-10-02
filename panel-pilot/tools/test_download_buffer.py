import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import DownloadBufferManager  # noqa: E402


class DownloadBufferManagerTests(unittest.TestCase):
    def make_manager(self, directory):
        manager = DownloadBufferManager(str(pathlib.Path(directory) / "buffer.json"))
        manager.library_chapter_ids = lambda chapter_ids: list(chapter_ids)
        manager.chapter_download_details = lambda chapter_ids: {
            chapter_id: {"chapterId": chapter_id, "isDownloaded": False}
            for chapter_id in chapter_ids
        }
        return manager

    def test_queue_is_deduplicated_and_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "buffer.json"
            manager = self.make_manager(directory)
            status = manager.enqueue([10, 11, 10, 0, "bad"])
            self.assertEqual(status["added"], 2)
            self.assertEqual(status["queued"], 2)

            restored = DownloadBufferManager(str(path))
            self.assertEqual([item["chapterId"] for item in restored.tasks], [10, 11])

    def test_prepared_chapter_is_not_requeued(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.prepared_chapters.add(15)
            status = manager.enqueue([15, 16])

            self.assertEqual(status["added"], 1)
            self.assertEqual([item["chapterId"] for item in manager.tasks], [16])

    def test_failure_only_backs_off_the_failed_chapter(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
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
            manager = self.make_manager(directory)
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

    def test_status_includes_failed_chapter_details_outside_the_active_window(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.requested_chapter_ids = [40]
            manager.failures = [{
                "chapterId": 30,
                "attempts": manager.MAX_ATTEMPTS,
                "lastError": "rate limited",
                "failedAt": 2_000,
            }]
            manager.chapter_download_details = lambda chapter_ids: {
                chapter_id: {
                    "chapterId": chapter_id,
                    "name": f"Chapter {chapter_id}",
                    "mangaTitle": "Fixture title",
                    "sourceLabel": "Fixture source",
                    "isDownloaded": chapter_id == 40,
                }
                for chapter_id in chapter_ids
            }

            status = manager.status()

            self.assertEqual(status["failed"], 1)
            self.assertEqual(status["failedInWindow"], 0)
            self.assertEqual(status["windowChapters"][0]["state"], "downloaded")
            self.assertEqual(status["failedChapters"], [{
                "chapterId": 30,
                "name": "Chapter 30",
                "mangaTitle": "Fixture title",
                "sourceLabel": "Fixture source",
                "isDownloaded": False,
                "state": "failed",
                "attempts": manager.MAX_ATTEMPTS,
                "lastError": "rate limited",
                "failedAt": 2_000,
                "panelReady": False,
            }])

    def test_background_enqueue_retains_foreground_window_and_all_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.enqueue([101, 102])

            status = manager.enqueue([201, 202, 203], priority="background")

            self.assertEqual(status["requestedChapterIds"], [101, 102])
            self.assertEqual([item["chapterId"] for item in manager.tasks], [101, 102, 201, 202, 203])
            self.assertEqual(status["added"], 3)
            self.assertEqual(status["rejected"], 0)

    def test_foreground_enqueue_replaces_window_and_preempts_background_backlog(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.enqueue([201, 202, 203], priority="background")

            status = manager.enqueue([102, 103, 102])

            self.assertEqual(status["requestedChapterIds"], [102, 103])
            self.assertEqual([item["chapterId"] for item in manager.tasks], [102, 103, 201, 202, 203])
            self.assertEqual(status["added"], 2)

    def test_foreground_enqueue_moves_existing_background_tasks_to_front(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.enqueue([201, 202, 203], priority="background")

            status = manager.enqueue([203, 202])

            self.assertEqual(status["requestedChapterIds"], [203, 202])
            self.assertEqual([item["chapterId"] for item in manager.tasks], [203, 202, 201])
            self.assertEqual(status["added"], 0)

    def test_partial_library_rejection_is_reported_and_not_queued(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.library_chapter_ids = lambda chapter_ids: [
                chapter_id for chapter_id in chapter_ids if chapter_id != 302
            ]

            status = manager.enqueue([301, 302, 303], priority="background")

            self.assertEqual(status["rejected"], 1)
            self.assertEqual(status["added"], 2)
            self.assertEqual([item["chapterId"] for item in manager.tasks], [301, 303])
            self.assertEqual(status["requestedChapterIds"], [])


if __name__ == "__main__":
    unittest.main()
