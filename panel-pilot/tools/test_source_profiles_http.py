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
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


class SourceProfilesHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        cls.profile_path = pathlib.Path(cls.temporary_directory.name) / "source-profiles.json"
        cls.port = free_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        environment = os.environ.copy()
        for name in ("PANEL_PILOT_AUTH_USER", "PANEL_PILOT_AUTH_PASSWORD", "PANEL_PILOT_SESSION_SECRET"):
            environment.pop(name, None)
        environment.update({
            "PANEL_PILOT_BIND_ADDRESS": "127.0.0.1",
            "PANEL_PILOT_STATIC_ROOT": str(ROOT / "dist"),
            "PANEL_PILOT_SOURCE_PROFILES_PATH": str(cls.profile_path),
            "PANEL_PILOT_READING_STATS_PATH": str(pathlib.Path(cls.temporary_directory.name) / "reading-stats.sqlite3"),
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
                raise RuntimeError(cls.process.stdout.read() if cls.process.stdout else "Panels server exited")
            try:
                with urlopen(f"{cls.base_url}/", timeout=0.25) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("Timed out waiting for Panels HTTP fixture")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        cls.temporary_directory.cleanup()

    def request_json(self, path, method="GET", payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"} if body else {},
        )
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_observations_are_persisted_without_title_history(self):
        status, payload = self.request_json("/api/source-profiles", "POST", {"observations": [{
            "sourceId": "2499283573021220255",
            "sourceLabel": "MangaDex (EN)",
            "operation": "search",
            "outcome": "success",
            "latencyMs": 360,
            "mediaFormat": "manga",
            "title": "This must not be stored",
        }]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["profiles"][0]["attempts"], 1)
        _, loaded = self.request_json("/api/source-profiles")
        self.assertEqual(loaded["profiles"][0]["sourceLabel"], "MangaDex (EN)")
        self.assertNotIn("This must not be stored", self.profile_path.read_text(encoding="utf-8"))

    def test_invalid_observation_is_a_client_error(self):
        with self.assertRaises(HTTPError) as caught:
            self.request_json("/api/source-profiles", "POST", {"observations": [{
                "sourceId": "../invalid",
                "operation": "search",
                "outcome": "success",
            }]})
        self.assertEqual(caught.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
