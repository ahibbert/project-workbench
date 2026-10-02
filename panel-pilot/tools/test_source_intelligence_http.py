import http.cookiejar
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
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


ROOT = pathlib.Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


class SourceIntelligenceHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        temporary_root = pathlib.Path(cls.temporary_directory.name)
        cls.database_path = temporary_root / "source-intelligence.sqlite3"
        cls.port = free_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        environment = os.environ.copy()
        environment.update({
            "PANEL_PILOT_BIND_ADDRESS": "127.0.0.1",
            "PANEL_PILOT_STATIC_ROOT": str(ROOT / "dist"),
            "PANEL_PILOT_AUTH_USER": "reader",
            "PANEL_PILOT_AUTH_PASSWORD": "fixture-password-long",
            "PANEL_PILOT_SESSION_SECRET": "ab" * 32,
            "PANEL_PILOT_LIBRARY_PATH": str(temporary_root / "library.json"),
            "PANEL_PILOT_REPORTS_PATH": str(temporary_root / "reports"),
            "PANEL_PILOT_DOWNLOAD_BUFFER_PATH": str(temporary_root / "downloads.json"),
            "PANEL_PILOT_MANGABAKA_CONFIG_PATH": str(temporary_root / "mangabaka.json"),
            "PANEL_PILOT_READING_STATS_PATH": str(temporary_root / "reading-stats.sqlite3"),
            "PANEL_PILOT_SOURCE_INTELLIGENCE_PATH": str(cls.database_path),
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
                with urlopen(f"{cls.base_url}/login", timeout=0.25) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("Timed out waiting for Panels HTTP fixture")

        cls.cookie_jar = http.cookiejar.CookieJar()
        cls.opener = build_opener(HTTPCookieProcessor(cls.cookie_jar))
        login = urlencode({
            "username": "reader",
            "password": "fixture-password-long",
            "next": "/",
        }).encode("utf-8")
        cls.opener.open(Request(
            f"{cls.base_url}/login",
            data=login,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ), timeout=5).read()

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

    def request_json(self, path, method="GET", payload=None, authenticated=True):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        opener = self.opener if authenticated else build_opener()
        with opener.open(request, timeout=5) as response:
            return response.status, response.headers, json.loads(response.read().decode("utf-8"))

    @staticmethod
    def inventory_payload():
        return {
            "schemaVersion": 1,
            "sources": [{
                "sourceId": "2499283573021220255",
                "packageName": "eu.kanade.tachiyomi.extension.en.mangadex",
                "displayName": "MangaDex (EN)",
                "language": "en",
                "storeIdentity": "keiyoushi:release-key",
                "extensionVersion": "1.4.249",
                "installed": True,
                "obsolete": False,
                "formats": ["manga"],
                "formatProvenance": "automatic",
                "formatConfidence": 0.9,
            }],
        }

    def test_endpoints_require_authentication(self):
        with self.assertRaises(HTTPError) as read_error:
            self.request_json("/api/source-intelligence", authenticated=False)
        self.assertEqual(read_error.exception.code, 401)
        with self.assertRaises(HTTPError) as write_error:
            self.request_json(
                "/api/source-intelligence/inventory",
                method="POST",
                payload=self.inventory_payload(),
                authenticated=False,
            )
        self.assertEqual(write_error.exception.code, 401)

    def test_authenticated_inventory_observation_and_benchmark_contract(self):
        status, headers, inventory = self.request_json(
            "/api/source-intelligence/inventory",
            method="POST",
            payload=self.inventory_payload(),
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(inventory["count"], 1)

        _, _, observed = self.request_json(
            "/api/source-intelligence/observations",
            method="POST",
            payload={
                "schemaVersion": 1,
                "observations": [{
                    "sourceId": "2499283573021220255",
                    "operation": "image_fetch",
                    "outcome": "success",
                    "latencyMs": 450,
                    "byteCount": 550_000,
                    "width": 1800,
                    "height": 2600,
                    "codec": "jpeg",
                    "clarity": 0.88,
                    "placeholder": False,
                    "mediaFormat": "manga",
                    "origin": "benchmark",
                    "runId": "passive-run-01",
                    "occurredAt": "2026-10-02T00:00:00Z",
                }],
            },
        )
        self.assertEqual(observed["accepted"], 1)
        self.assertGreater(observed["scores"][0]["quality"], 75)

        _, _, benchmark = self.request_json(
            "/api/source-intelligence/benchmarks",
            method="POST",
            payload={
                "schemaVersion": 1,
                "run": {
                    "runId": "settings-manual-001",
                    "suiteVersion": "suite-1.0",
                    "status": "completed",
                    "startedAt": "2026-10-02T00:00:00Z",
                    "finishedAt": "2026-10-02T00:01:00Z",
                    "requestedBy": "manual",
                    "appVersion": "3aafecf",
                    "errorClass": "",
                },
                "results": [{
                    "caseId": "manga-mainstream-01",
                    "sourceId": "2499283573021220255",
                    "mediaFormat": "manga",
                    "matchScore": 0.92,
                    "usable": True,
                    "chapterCount": 120,
                    "pageCount": 20,
                    "fetchSuccesses": 5,
                    "fetchFailures": 0,
                    "durationMs": 25_000,
                    "errorClass": "",
                }],
            },
        )
        self.assertTrue(benchmark["accepted"])

        _, summary_headers, summary = self.request_json("/api/source-intelligence?format=manga")
        self.assertEqual(summary_headers["Cache-Control"], "no-store")
        self.assertEqual(summary["schemaVersion"], 1)
        self.assertEqual(summary["counts"]["sources"], 1)
        self.assertGreater(summary["scores"][0]["coverage"], 80)
        self.assertIsNotNone(summary["scores"][0]["suitability"])
        self.assertEqual(summary["benchmarkRuns"][0]["resultCount"], 1)

        _, _, filtered = self.request_json("/api/source-intelligence/scores?format=comic")
        self.assertEqual(filtered["count"], 0)
        _, _, detail = self.request_json(
            "/api/source-intelligence/benchmarks?runId=settings-manual-001"
        )
        self.assertEqual(detail["benchmarkRuns"][0]["results"][0]["caseId"], "manga-mainstream-01")

    def test_private_content_fields_are_rejected_before_storage(self):
        self.request_json(
            "/api/source-intelligence/inventory",
            method="POST",
            payload=self.inventory_payload(),
        )
        private_title = "Extremely Private Reading Title"
        with self.assertRaises(HTTPError) as rejected:
            self.request_json(
                "/api/source-intelligence/observations",
                method="POST",
                payload={
                    "schemaVersion": 1,
                    "observations": [{
                        "sourceId": "2499283573021220255",
                        "operation": "search",
                        "outcome": "success",
                        "mediaFormat": "manga",
                        "title": private_title,
                    }],
                },
            )
        self.assertEqual(rejected.exception.code, 400)
        self.assertNotIn(private_title.encode("utf-8"), self.database_path.read_bytes())

        with self.assertRaises(HTTPError) as bad_version:
            self.request_json(
                "/api/source-intelligence/inventory",
                method="POST",
                payload={"schemaVersion": 2, "sources": []},
            )
        self.assertEqual(bad_version.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
