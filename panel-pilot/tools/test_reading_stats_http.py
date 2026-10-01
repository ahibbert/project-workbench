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


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


class ReadingStatsHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        temporary_root = pathlib.Path(cls.temporary_directory.name)
        cls.port = free_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        environment = os.environ.copy()
        for name in ("PANEL_PILOT_AUTH_USER", "PANEL_PILOT_AUTH_PASSWORD", "PANEL_PILOT_SESSION_SECRET"):
            environment.pop(name, None)
        environment.update({
            "PANEL_PILOT_BIND_ADDRESS": "127.0.0.1",
            "PANEL_PILOT_STATIC_ROOT": str(ROOT / "dist"),
            "PANEL_PILOT_LIBRARY_PATH": str(temporary_root / "library.json"),
            "PANEL_PILOT_REPORTS_PATH": str(temporary_root / "reports"),
            "PANEL_PILOT_DOWNLOAD_BUFFER_PATH": str(temporary_root / "downloads.json"),
            "PANEL_PILOT_MANGABAKA_CONFIG_PATH": str(temporary_root / "mangabaka.json"),
            "PANEL_PILOT_READING_STATS_PATH": str(temporary_root / "reading-stats.sqlite3"),
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
        if hasattr(cls, "process"):
            cls.process.terminate()
            try:
                cls.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.process.kill()
                cls.process.wait(timeout=5)
        if hasattr(cls, "temporary_directory"):
            cls.temporary_directory.cleanup()

    def request_json(self, path, method="GET", payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        with urlopen(request, timeout=3) as response:
            return response, json.loads(response.read().decode("utf-8"))

    def test_endpoint_family_is_no_store_and_uses_the_versioned_event_contract(self):
        response, initial = self.request_json("/api/reading-stats?range=30d")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(initial["schemaVersion"], 1)
        self.assertFalse(initial["settings"]["enabled"])

        _, settings = self.request_json(
            "/api/reading-stats/settings",
            method="POST",
            payload={
                "enabled": True,
                "showStats": True,
                "showRhythm": True,
                "celebrations": True,
                "timezone": "Australia/Sydney",
                "dayStartHour": 4,
            },
        )
        self.assertTrue(settings["enabled"])
        self.assertIsNotNone(settings["since"])

        event = {
            "schemaVersion": 1,
            "eventId": "http-finish-1",
            "deviceId": "phone",
            "type": "chapter_finish",
            "occurredAt": "2026-10-01T08:00:00Z",
            "titleKey": "sha256:title",
            "chapterKey": "sha256:chapter",
            "attemptId": "attempt-1",
            "offline": True,
        }
        page_event = {
            "schemaVersion": 1,
            "eventId": "http-page-001",
            "deviceId": "phone",
            "type": "page_view",
            "occurredAt": "2026-10-01T07:59:00Z",
            "titleKey": "sha256:title",
            "chapterKey": "sha256:chapter",
            "pageIndex": 7,
            "offline": True,
        }
        _, ingested = self.request_json(
            "/api/reading-stats/events", method="POST", payload={"events": [page_event, event, event]}
        )
        self.assertEqual(ingested["accepted"], 2)
        self.assertEqual(ingested["duplicates"], 1)

        _, summary = self.request_json("/api/reading-stats?range=all")
        self.assertEqual(summary["chapterFinishes"], 1)
        self.assertEqual(summary["uniqueChapters"], 1)
        self.assertEqual(summary["rereads"], 0)
        self.assertEqual(summary["pages"], 1)

    def test_export_is_an_attachment_and_reset_requires_the_exact_confirmation(self):
        request = Request(f"{self.base_url}/api/reading-stats/export", headers={"Accept": "application/json"})
        with urlopen(request, timeout=3) as response:
            exported = json.loads(response.read().decode("utf-8"))
            self.assertRegex(response.headers["Content-Disposition"], r"attachment;.*\.json")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(exported["schemaVersion"], 1)
        self.assertNotIn("mangaTitle", json.dumps(exported))

        with self.assertRaises(HTTPError) as invalid:
            self.request_json("/api/reading-stats/reset", method="POST", payload={"confirm": "erase"})
        self.assertEqual(invalid.exception.code, 400)

        _, erased = self.request_json(
            "/api/reading-stats/reset", method="POST", payload={"confirm": "ERASE"}
        )
        self.assertTrue(erased["reset"])
        _, summary = self.request_json("/api/reading-stats?range=all")
        self.assertEqual(summary["chapterFinishes"], 0)
        self.assertIsNone(summary["since"])

    def test_invalid_ranges_and_event_shapes_are_rejected_without_mutating_history(self):
        with self.assertRaises(HTTPError) as bad_range:
            self.request_json("/api/reading-stats?range=everything")
        self.assertEqual(bad_range.exception.code, 400)

        self.request_json(
            "/api/reading-stats/settings",
            method="POST",
            payload={"enabled": True},
        )

        with self.assertRaises(HTTPError) as bad_event:
            self.request_json(
                "/api/reading-stats/events",
                method="POST",
                payload={"events": [{"eventId": "missing-required-fields"}]},
            )
        self.assertEqual(bad_event.exception.code, 400)

        _, summary = self.request_json("/api/reading-stats?range=all")
        self.assertEqual(summary["chapterFinishes"], 0)


if __name__ == "__main__":
    unittest.main()
