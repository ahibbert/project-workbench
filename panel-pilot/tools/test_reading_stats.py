import json
from contextlib import closing
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server as panel_pilot_server  # noqa: E402
from server import PanelPilotHandler, ReadingStatsRequestError, ReadingStatsStore  # noqa: E402


def event(event_id, event_type, occurred_at, **values):
    return {
        "eventId": event_id,
        "type": event_type,
        "occurredAt": occurred_at,
        "titleKey": values.pop("titleKey", "suwayomi:title-42"),
        **values,
    }


class ReadingStatsStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temporary_directory.name) / "reading-stats.sqlite3"
        self.store = ReadingStatsStore(self.path)
        self.store.update_settings({"enabled": True})

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_schema_is_versioned_wal_and_salt_survives_restart(self):
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            salt = connection.execute(
                "SELECT value FROM stats_meta WHERE key='identifier_salt'"
            ).fetchone()[0]
        ReadingStatsStore(self.path)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(
                connection.execute("SELECT value FROM stats_meta WHERE key='identifier_salt'").fetchone()[0],
                salt,
            )

    def test_events_are_idempotent_private_and_cap_each_utc_minute(self):
        events = [
            event("active-0001", "active_minute", "2026-09-20T00:00:05Z", seconds=45),
            event("active-0002", "active_minute", "2026-09-20T00:00:55Z", seconds=45),
            event("page-view-01", "page_view", "2026-09-20T00:01:00Z", chapterKey="chapter raw", pageKey="page raw"),
            event("chapter-fin-1", "chapter_finish", "2026-09-20T00:02:00Z", chapterKey="chapter raw", attemptId="attempt-one"),
            event("title-done-01", "title_complete", "2026-09-20T00:03:00Z"),
        ]
        result = self.store.ingest(events)
        self.assertEqual(result["accepted"], 5)
        replay = self.store.ingest(events)
        self.assertEqual(replay["accepted"], 0)
        self.assertEqual(replay["duplicate"], 5)

        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT seconds FROM activity_minutes").fetchone()[0], 60)
            serialized = " ".join(
                str(value)
                for row in connection.execute(
                    "SELECT title_hash,chapter_hash,page_hash FROM page_views"
                )
                for value in row
            )
        for private_value in ("title-42", "chapter raw", "page raw", "suwayomi"):
            self.assertNotIn(private_value, serialized)
        self.assertRegex(serialized.split()[0], r"^[0-9a-f]{64}$")

    def test_reread_uses_attempt_identity_and_semantic_duplicate_is_ignored(self):
        first = event("finish-event-1", "chapter_finish", "2026-09-20T01:00:00Z", chapterKey="c1", attemptId="attempt-1")
        same_attempt = event("finish-event-2", "chapter_finish", "2026-09-20T01:01:00Z", chapterKey="c1", attemptId="attempt-1")
        reread = event("finish-event-3", "chapter_finish", "2026-09-20T01:02:00Z", chapterKey="c1", attemptId="attempt-2")
        result = self.store.ingest([first, same_attempt, reread])
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["duplicate"], 1)
        summary = self.store.summary("all", now=datetime(2026, 9, 20, 2, tzinfo=timezone.utc))
        self.assertEqual(summary["totals"]["chapterFinishes"], 2)
        self.assertEqual(summary["totals"]["uniqueChapters"], 1)
        self.assertEqual(summary["totals"]["rereads"], 1)
        self.assertIn("first-reread", {item["id"] for item in summary["achievements"]})

    def test_browser_payload_minute_key_page_index_and_metadata_are_supported(self):
        settings = self.store.update_settings({
            "enabled": True,
            "showStats": True,
            "updatedAt": "2026-09-20T00:00:00.000Z",
            "since": None,
            "schemaVersion": 1,
        })
        self.assertTrue(settings["enabled"])
        result = self.store.ingest([
            event(
                "browser-active", "active_minute", "2026-09-20T00:02:45Z",
                minuteKey="2026-09-20T00:01:00.000Z", activeMs=500,
            ),
            event(
                "browser-page--1", "page_view", "2026-09-20T00:02:45Z",
                chapterKey="chapter", pageIndex=3,
            ),
        ])
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["acknowledgedEventIds"], ["browser-active", "browser-page--1"])
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(
                connection.execute("SELECT minute_utc,seconds FROM activity_minutes").fetchone(),
                ("2026-09-20T00:01:00Z", 1),
            )

    def test_summary_has_ranges_calendar_trend_rhythm_and_prospective_since(self):
        self.store.update_settings({"timezone": "Australia/Sydney", "dayStartHour": 4})
        events = []
        for index in range(4):
            stamp = f"2026-09-{20 + index:02d}T02:00:00Z"
            events.extend([
                event(f"active-day-{index}", "active_minute", stamp, seconds=60),
                event(f"finish-day-{index}", "chapter_finish", stamp, chapterKey=f"chapter-{index}", attemptId=f"attempt-{index}"),
                event(f"page-day---{index}", "page_view", stamp, chapterKey=f"chapter-{index}", pageKey=f"page-{index}"),
            ])
        self.store.ingest(events)
        summary = self.store.summary("7d", now=datetime(2026, 9, 23, 12, tzinfo=timezone.utc))
        self.assertEqual(summary["range"], "7d")
        self.assertEqual(summary["totals"]["pages"], 4)
        self.assertEqual(summary["totals"]["chapterFinishes"], 4)
        self.assertEqual(summary["totals"]["readingDays"], 4)
        self.assertEqual(summary["rhythm"]["currentDays"], 4)
        self.assertEqual(summary["rhythm"]["longestDays"], 4)
        self.assertEqual(len(summary["calendar"]), 4)
        self.assertEqual(len(summary["trend"]), 4)
        self.assertIsNotNone(summary["trendComparison"]["previous"])
        self.assertTrue(summary["prospectiveSince"].endswith("Z"))
        self.assertFalse(summary["privacy"]["thirdPartyTelemetry"])
        for range_name in ("30d", "365d", "all"):
            self.assertEqual(self.store.summary(range_name)["range"], range_name)

    def test_settings_validate_timezone_and_disabled_stats_drop_events(self):
        updated = self.store.update_settings({
            "enabled": False,
            "showStats": False,
            "showRhythm": False,
            "celebrations": False,
            "timezone": "Australia/Sydney",
            "dayStartHour": 3,
        })
        self.assertFalse(updated["enabled"])
        result = self.store.ingest([
            event("disabled-evt", "page_view", "2026-09-20T00:00:00Z", chapterKey="c", pageKey="p")
        ])
        self.assertTrue(result["disabled"])
        self.assertEqual(result["accepted"], 0)
        with self.assertRaisesRegex(ReadingStatsRequestError, "IANA timezone"):
            self.store.update_settings({"timezone": "Mars/Olympus"})

    def test_export_contains_only_opaque_content_and_reset_requires_confirmation(self):
        self.store.ingest([
            event("export-event", "page_view", "2026-09-20T00:00:00Z", titleKey="Secret Manga", chapterKey="Secret Chapter", pageKey="Secret URL")
        ])
        exported = self.store.export_data()
        serialized = json.dumps(exported)
        self.assertNotIn("Secret Manga", serialized)
        self.assertNotIn("Secret Chapter", serialized)
        self.assertNotIn("Secret URL", serialized)
        with self.assertRaisesRegex(ReadingStatsRequestError, "ERASE"):
            self.store.reset("erase")
        self.assertTrue(self.store.reset("ERASE")["erased"])
        self.assertEqual(self.store.summary("all")["totals"]["pages"], 0)


class ReadingStatsAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temporary_directory.name)
        (root / "index.html").write_text("app", encoding="utf-8")
        (root / "login.html").write_text("login", encoding="utf-8")
        self.environment = mock.patch.dict(
            os.environ,
            {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": "secret"},
            clear=False,
        )
        self.environment.start()
        self.path_patch = mock.patch.object(panel_pilot_server, "READING_STATS_PATH", str(root / "stats.sqlite3"))
        self.path_patch.start()
        handler = lambda *args, **kwargs: PanelPilotHandler(*args, directory=root, **kwargs)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        self.path_patch.stop()
        self.environment.stop()
        self.temporary_directory.cleanup()

    def test_every_reading_stats_api_requires_session_authentication(self):
        base = f"http://127.0.0.1:{self.httpd.server_port}"
        for path in ("/api/reading-stats", "/api/reading-stats/export"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as raised:
                urlopen(base + path, timeout=5)
            self.assertEqual(raised.exception.code, 401)
            payload = json.loads(raised.exception.read())
            self.assertEqual(payload["error"], "Authentication required")
        for path in ("/api/reading-stats/events", "/api/reading-stats/settings", "/api/reading-stats/reset"):
            request = Request(
                base + path,
                data=b"{}",
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with self.subTest(path=path), self.assertRaises(HTTPError) as raised:
                urlopen(request, timeout=5)
            self.assertEqual(raised.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
