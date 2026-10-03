import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server as panel_pilot_server  # noqa: E402
from server import PanelPilotHandler  # noqa: E402


class StaticRootResolutionTests(unittest.TestCase):
    def test_missing_build_has_clear_error(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_root = pathlib.Path(temporary_directory)
            with mock.patch.object(panel_pilot_server, "APP_ROOT", app_root), mock.patch.dict(
                os.environ,
                {"PANEL_PILOT_STATIC_ROOT": "", "PANEL_PILOT_ALLOW_SOURCE_STATIC": ""},
                clear=False,
            ):
                with self.assertRaisesRegex(RuntimeError, "production frontend build is missing"):
                    panel_pilot_server.resolve_static_root()

    def test_local_dist_is_preferred_to_enabled_source_fallback(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_root = pathlib.Path(temporary_directory)
            (app_root / "index.html").write_text("source", encoding="utf-8")
            (app_root / "login.html").write_text("source login", encoding="utf-8")
            dist = app_root / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("built", encoding="utf-8")
            (dist / "login.html").write_text("built login", encoding="utf-8")
            with mock.patch.object(panel_pilot_server, "APP_ROOT", app_root), mock.patch.dict(
                os.environ,
                {"PANEL_PILOT_STATIC_ROOT": "", "PANEL_PILOT_ALLOW_SOURCE_STATIC": "1"},
                clear=False,
            ):
                self.assertEqual(panel_pilot_server.resolve_static_root(), dist.resolve())

    def test_source_fallback_requires_explicit_opt_in(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_root = pathlib.Path(temporary_directory)
            (app_root / "index.html").write_text("source", encoding="utf-8")
            (app_root / "login.html").write_text("source login", encoding="utf-8")
            with mock.patch.object(panel_pilot_server, "APP_ROOT", app_root), mock.patch.dict(
                os.environ,
                {"PANEL_PILOT_STATIC_ROOT": "", "PANEL_PILOT_ALLOW_SOURCE_STATIC": "1"},
                clear=False,
            ):
                self.assertEqual(panel_pilot_server.resolve_static_root(), app_root.resolve())


class StaticServingTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.static_root = pathlib.Path(self.temporary_directory.name) / "dist"
        self.static_root.mkdir()
        (self.static_root / "index.html").write_text("built app", encoding="utf-8")
        (self.static_root / "login.html").write_text("built login", encoding="utf-8")
        (self.static_root / "assets").mkdir()
        (self.static_root / "assets" / "app-hash.js").write_text("export {};", encoding="utf-8")
        self.environment = mock.patch.dict(
            os.environ,
            {
                "PANEL_PILOT_STATIC_ROOT": str(self.static_root),
                "PANEL_PILOT_AUTH_USER": "",
                "PANEL_PILOT_AUTH_PASSWORD": "",
            },
            clear=False,
        )
        self.environment.start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), PanelPilotHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        self.environment.stop()
        self.temporary_directory.cleanup()

    def status(self, path):
        try:
            with urlopen(f"{self.base_url}{path}", timeout=5) as response:
                return response.status
        except HTTPError as error:
            return error.code

    def test_only_built_files_are_served(self):
        self.assertEqual(self.status("/"), 200)
        self.assertEqual(self.status("/assets/app-hash.js"), 200)
        for path in ("/server.py", "/data/", "/src/main.js", "/package.json"):
            with self.subTest(path=path):
                self.assertEqual(self.status(path), 404)

    def test_directory_listings_are_disabled(self):
        self.assertEqual(self.status("/assets/"), 404)

    def test_login_comes_from_selected_static_root(self):
        with mock.patch.dict(
            os.environ,
            {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": "secret"},
            clear=False,
        ):
            with urlopen(f"{self.base_url}/login", timeout=5) as response:
                self.assertEqual(response.read(), b"built login")

    def test_historical_worker_url_serves_current_worker_without_auth(self):
        with mock.patch.dict(
            os.environ,
            {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": "secret"},
            clear=False,
        ):
            with urlopen(f"{self.base_url}/src/sw.js", timeout=5) as response:
                self.assertEqual(response.status, 200)
                body = response.read().decode("utf-8")
                self.assertIn('self.addEventListener("install"', body)
                self.assertIn("self.skipWaiting()", body)
                self.assertIn('key !== deviceCacheName', body)
                self.assertNotIn("caches.delete(deviceCacheName)", body)
                self.assertEqual(response.headers["Content-Type"], "text/javascript; charset=utf-8")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(response.headers["Service-Worker-Allowed"], "/")

    def test_security_headers_are_sent_without_permissive_cors(self):
        request = panel_pilot_server.Request(
            f"{self.base_url}/",
            headers={"X-Forwarded-Proto": "https"},
        )
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.headers["Server"], "Panels")
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(response.headers["X-Frame-Options"], "DENY")
            self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
            self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
            self.assertEqual(
                response.headers["Strict-Transport-Security"],
                "max-age=31536000; includeSubDomains",
            )
            self.assertIsNone(response.headers["Access-Control-Allow-Origin"])


if __name__ == "__main__":
    unittest.main()
