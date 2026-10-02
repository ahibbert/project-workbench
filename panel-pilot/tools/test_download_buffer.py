import io
import pathlib
import json
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import DownloadBufferManager, PanelPilotHandler  # noqa: E402


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

    def test_managed_enqueue_persists_v1_retention_ledger_without_claiming_existing_work(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "buffer.json"
            manager = self.make_manager(directory)
            manager.prepared_chapters.add(12)

            with mock.patch("server.time.time", return_value=1_700_000_000):
                manager.enqueue(
                    [10, 11, 12],
                    priority="background",
                    purpose="reading-ahead",
                    scope_id="series_opaque_1",
                )
            manager.enqueue([20], priority="background")

            self.assertEqual([item["chapterId"] for item in manager.retention_ledger], [10, 11])
            self.assertEqual(manager.retention_ledger[0], {
                "schemaVersion": 1,
                "managedBy": "panels",
                "chapterId": 10,
                "scopeId": "series_opaque_1",
                "purpose": "reading-ahead",
                "managedAt": "2023-11-14T22:13:20Z",
            })
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["retention"]["schemaVersion"], 1)
            self.assertEqual(payload["retention"]["policy"], {
                "readRetentionDays": 30,
                "keepRecentCount": 2,
                "sourceTestRetentionDays": 1,
            })

            restored = DownloadBufferManager(str(path))
            self.assertEqual(restored.retention_ledger, manager.retention_ledger)
            self.assertNotIn(12, [item["chapterId"] for item in restored.retention_ledger])
            self.assertNotIn(20, [item["chapterId"] for item in restored.retention_ledger])

    def test_enqueue_metadata_requires_known_purpose_and_safe_opaque_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)

            with self.assertRaisesRegex(ValueError, "purpose"):
                manager.enqueue([10], purpose="manual", scope_id="safe")
            with self.assertRaisesRegex(ValueError, "scopeId"):
                manager.enqueue([10], purpose="plan-to-read", scope_id="Private title / URL")

            self.assertEqual(manager.tasks, [])
            self.assertEqual(manager.retention_ledger, [])

    def test_mark_read_and_preview_apply_retention_and_keep_recent_per_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            with mock.patch("server.time.time", return_value=1_000):
                manager.enqueue([1, 2, 3], priority="background", purpose="plan-to-read", scope_id="series-a")
                manager.enqueue([4], priority="background", purpose="reading-ahead", scope_id="series-b")
            with mock.patch("server.time.time", return_value=2_000):
                marked = manager.mark_retention_read([1, 2, 3, 4, 999])

            self.assertEqual(marked["markedRead"], 4)
            read_times = {
                1: "2023-01-01T00:00:00Z",
                2: "2023-02-01T00:00:00Z",
                3: "2023-03-01T00:00:00Z",
                4: "2023-01-01T00:00:00Z",
            }
            for entry in manager.retention_ledger:
                entry["readAt"] = read_times[entry["chapterId"]]

            preview = manager.retention_status(
                policy={"readRetentionDays": 30, "keepRecentCount": 1},
            )["retention"]

            self.assertEqual(preview["eligible"], [
                {"chapterId": 1, "reason": "read-retention-expired"},
                {"chapterId": 2, "reason": "read-retention-expired"},
            ])
            self.assertEqual(preview["preview"], {
                "managed": 4,
                "eligible": 2,
                "protected": 2,
                "reasons": {"keep-recent": 2, "read-retention-expired": 2},
            })

    def test_cleanup_recomputes_then_dequeues_all_eligible_before_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.enqueue([1, 2, 3], priority="background", purpose="source-test", scope_id="source-suite")
            manager.enqueue([99], priority="background")
            for entry in manager.retention_ledger:
                entry["managedAt"] = "2020-01-01T00:00:00Z"
            graphql_calls = []

            def graphql(query, variables=None, timeout=30):
                graphql_calls.append((query, variables))
                return {}

            manager.graphql = graphql
            result = manager.cleanup_retention(
                active_reader_chapter_ids=[2],
                policy={"sourceTestRetentionDays": 0},
            )

            self.assertEqual(len(graphql_calls), 2)
            self.assertIn("dequeueChapterDownloads", graphql_calls[0][0])
            self.assertEqual(graphql_calls[0][1], {"input": {"ids": [1, 3]}})
            self.assertIn("deleteDownloadedChapters", graphql_calls[1][0])
            self.assertEqual(graphql_calls[1][1], {"input": {"ids": [1, 3]}})
            self.assertEqual(result["retentionCleanup"], {"removed": 2})
            self.assertEqual([item["chapterId"] for item in manager.retention_ledger], [2])
            self.assertIn(2, [item["chapterId"] for item in manager.tasks])
            self.assertIn(99, [item["chapterId"] for item in manager.tasks])
            self.assertNotIn(99, graphql_calls[0][1]["input"]["ids"])
            self.assertIn("lastCleanupAt", result["retention"])

    def test_ambiguous_legacy_and_unmanaged_records_never_reach_cleanup_mutations(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.retention_ledger = [
                {
                    "schemaVersion": 1,
                    "managedBy": "panels",
                    "chapterId": 5,
                    "scopeId": "series",
                    "purpose": "source-test",
                    "managedAt": "2020-01-01T00:00:00Z",
                },
                {
                    "schemaVersion": 1,
                    "managedBy": "panels",
                    "chapterId": 5,
                    "scopeId": "series",
                    "purpose": "source-test",
                    "managedAt": "2020-01-01T00:00:00Z",
                },
                {
                    "schemaVersion": 0,
                    "managedBy": "panels",
                    "chapterId": 6,
                    "scopeId": "series",
                    "purpose": "source-test",
                    "managedAt": "2020-01-01T00:00:00Z",
                },
                {
                    "schemaVersion": 1,
                    "managedBy": "manual",
                    "chapterId": 7,
                    "scopeId": "series",
                    "purpose": "source-test",
                    "managedAt": "2020-01-01T00:00:00Z",
                },
            ]
            manager.tasks.append({"chapterId": 8, "attempts": 0, "notBefore": 0, "lastError": ""})
            manager.graphql = mock.Mock(side_effect=AssertionError("protected records must not be mutated"))

            result = manager.cleanup_retention(policy={"sourceTestRetentionDays": 0})

            manager.graphql.assert_not_called()
            self.assertEqual(result["retentionCleanup"]["removed"], 0)
            self.assertEqual(result["retention"]["preview"]["reasons"], {
                "ambiguous-ledger": 1,
                "legacy-ledger": 1,
                "unmanaged-download": 1,
            })
            self.assertIn(8, [item["chapterId"] for item in manager.tasks])

    def test_retention_policy_validation_and_payload_are_privacy_minimized(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = self.make_manager(directory)
            manager.enqueue([10], purpose="reading-ahead", scope_id="opaque-series")
            manager.retention_ledger[0]["readAt"] = "2020-01-01T00:00:00Z"

            with self.assertRaisesRegex(ValueError, "keepRecentCount"):
                manager.retention_status(policy={"keepRecentCount": -1})
            with self.assertRaisesRegex(ValueError, "readRetentionDays"):
                manager.retention_status(policy={"readRetentionDays": float("inf")})

            retention = manager.retention_status(policy={"keepRecentCount": 0})["retention"]
            encoded = json.dumps(retention)
            self.assertNotIn("title", encoded.lower())
            self.assertNotIn("url", encoded.lower())
            self.assertNotIn("opaque-series", encoded)
            self.assertEqual(set(retention), {"policy", "preview", "eligible"})


class DownloadBufferHandlerTests(unittest.TestCase):
    def post(self, payload, manager):
        body = json.dumps(payload).encode("utf-8")
        handler = object.__new__(PanelPilotHandler)
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.send_json = mock.Mock()
        with mock.patch("server.DOWNLOAD_BUFFER_MANAGER", manager):
            handler.handle_download_buffer_post()
        return handler.send_json

    def test_handler_forwards_exact_enqueue_retention_fields(self):
        manager = mock.Mock()
        manager.enqueue.return_value = {"queued": 1}

        sent = self.post({
            "chapterIds": [10],
            "priority": "background",
            "purpose": "reading-ahead",
            "scopeId": "opaque-series",
        }, manager)

        manager.enqueue.assert_called_once_with(
            [10],
            priority="background",
            purpose="reading-ahead",
            scope_id="opaque-series",
        )
        sent.assert_called_once_with({"queued": 1})

    def test_handler_routes_mark_preview_and_cleanup_payloads(self):
        manager = mock.Mock()
        manager.mark_retention_read.return_value = {"markedRead": 2}
        sent = self.post({"markReadChapterIds": [10, 11]}, manager)
        manager.mark_retention_read.assert_called_once_with([10, 11])
        sent.assert_called_once_with({"markedRead": 2})

        manager.reset_mock()
        manager.retention_status.return_value = {"retention": {"eligible": []}}
        policy = {"readRetentionDays": 14, "keepRecentCount": 1, "sourceTestRetentionDays": 2}
        sent = self.post({
            "retentionPreview": True,
            "retentionPolicy": policy,
            "activeReaderChapterIds": [12],
        }, manager)
        manager.retention_status.assert_called_once_with(
            active_reader_chapter_ids=[12],
            policy=policy,
        )
        sent.assert_called_once_with({"retention": {"eligible": []}})

        manager.reset_mock()
        manager.cleanup_retention.return_value = {"retentionCleanup": {"removed": 1}}
        sent = self.post({
            "cleanupRetention": True,
            "retentionPolicy": policy,
            "activeReaderChapterIds": [13],
        }, manager)
        manager.cleanup_retention.assert_called_once_with(
            active_reader_chapter_ids=[13],
            policy=policy,
        )
        sent.assert_called_once_with({"retentionCleanup": {"removed": 1}})


if __name__ == "__main__":
    unittest.main()
