import os
import pathlib
import sys
import tempfile
import unittest
import base64
import hashlib
import hmac
import json
import time
from unittest import mock
from urllib.request import Request


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server as panel_pilot_server  # noqa: E402
from server import PanelPilotHandler  # noqa: E402


class ServerConfigurationTests(unittest.TestCase):
    def test_local_bind_defaults_to_loopback(self):
        with mock.patch.dict(os.environ, {"PANEL_PILOT_BIND_ADDRESS": ""}, clear=False):
            self.assertEqual(panel_pilot_server.resolve_bind_address(), "127.0.0.1")

    def test_explicit_bind_address_is_preserved(self):
        with mock.patch.dict(
            os.environ, {"PANEL_PILOT_BIND_ADDRESS": "0.0.0.0"}, clear=False
        ):
            self.assertEqual(panel_pilot_server.resolve_bind_address(), "0.0.0.0")

    def test_partial_auth_configuration_is_rejected(self):
        configurations = (
            {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": ""},
            {"PANEL_PILOT_AUTH_USER": "", "PANEL_PILOT_AUTH_PASSWORD": "secret"},
        )
        for environment in configurations:
            with self.subTest(environment=environment), mock.patch.dict(
                os.environ, environment, clear=False
            ):
                with self.assertRaisesRegex(RuntimeError, "must either both be set"):
                    panel_pilot_server.validate_panel_auth_configuration()

    def test_partial_auth_configuration_stops_startup_before_side_effects(self):
        with mock.patch.dict(
            os.environ,
            {
                "PANEL_PILOT_AUTH_USER": "reader",
                "PANEL_PILOT_AUTH_PASSWORD": "",
            },
            clear=False,
        ), mock.patch.object(sys, "argv", ["server.py", "8013"]), mock.patch.object(
            panel_pilot_server, "resolve_static_root"
        ) as resolve_static_root, mock.patch.object(
            panel_pilot_server, "DownloadBufferManager"
        ) as download_buffer_manager:
            with self.assertRaisesRegex(RuntimeError, "must either both be set"):
                panel_pilot_server.main()
            resolve_static_root.assert_not_called()
            download_buffer_manager.assert_not_called()

    def test_complete_or_disabled_auth_configuration_is_accepted(self):
        configurations = (
            ({"PANEL_PILOT_AUTH_USER": "", "PANEL_PILOT_AUTH_PASSWORD": ""}, ("", "")),
            (
                {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": "secret"},
                ("reader", "secret"),
            ),
        )
        for environment, expected in configurations:
            with self.subTest(environment=environment), mock.patch.dict(
                os.environ, environment, clear=False
            ):
                self.assertEqual(
                    panel_pilot_server.validate_panel_auth_configuration(), expected
                )

    def test_partial_suwayomi_auth_configuration_is_rejected(self):
        configurations = (
            {"SUWAYOMI_AUTH_USER": "reader", "SUWAYOMI_AUTH_PASSWORD": ""},
            {"SUWAYOMI_AUTH_USER": "", "SUWAYOMI_AUTH_PASSWORD": "fixture-password"},
        )
        for environment in configurations:
            with self.subTest(environment=environment), mock.patch.dict(
                os.environ, environment, clear=False
            ):
                with self.assertRaisesRegex(RuntimeError, "must either both be set"):
                    panel_pilot_server.suwayomi_auth_credentials()

    def test_partial_suwayomi_auth_stops_startup_before_side_effects(self):
        with mock.patch.dict(
            os.environ,
            {
                "PANEL_PILOT_AUTH_USER": "",
                "PANEL_PILOT_AUTH_PASSWORD": "",
                "SUWAYOMI_AUTH_USER": "reader",
                "SUWAYOMI_AUTH_PASSWORD": "",
            },
            clear=False,
        ), mock.patch.object(sys, "argv", ["server.py", "8013"]), mock.patch.object(
            panel_pilot_server, "resolve_static_root"
        ) as resolve_static_root, mock.patch.object(
            panel_pilot_server, "DownloadBufferManager"
        ) as download_buffer_manager:
            with self.assertRaisesRegex(RuntimeError, "must either both be set"):
                panel_pilot_server.main()
            resolve_static_root.assert_not_called()
            download_buffer_manager.assert_not_called()

    def test_container_configuration_explicitly_uses_all_interfaces(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("ENV PANEL_PILOT_BIND_ADDRESS=0.0.0.0", dockerfile)
        self.assertIn("PANEL_PILOT_BIND_ADDRESS: 0.0.0.0", compose)
        self.assertIn("USER 10001:10001", dockerfile)
        self.assertIn("COPY --chown=panels:panels source_intelligence.py ./source_intelligence.py", dockerfile)
        self.assertIn("read_only: true", compose)
        self.assertIn("no-new-privileges:true", compose)
        self.assertIn("cap_drop:", compose)

    def test_hex_session_secret_uses_raw_bytes_and_rejects_pre_migration_tokens(self):
        handler = object.__new__(PanelPilotHandler)
        configured = "ab" * 32
        environment = {
            "PANEL_PILOT_AUTH_USER": "reader",
            "PANEL_PILOT_AUTH_PASSWORD": "fixture-password",
            "PANEL_PILOT_SESSION_SECRET": configured,
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            self.assertEqual(handler.session_secret(), bytes.fromhex(configured))
            payload = json.dumps(
                {"sub": "reader", "exp": int(time.time()) + 300},
                separators=(",", ":"),
            ).encode("utf-8")
            encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
            legacy_secret = hashlib.sha256(
                b"panel-pilot-session\0reader\0fixture-password"
            ).digest()
            signature = hmac.new(legacy_secret, encoded.encode("ascii"), hashlib.sha256).digest()
            token = f"{encoded}.{base64.urlsafe_b64encode(signature).decode('ascii').rstrip('=')}"
            handler.headers = {"Cookie": f"panel_pilot_session={token}"}
            self.assertFalse(handler.valid_session())

    def test_current_session_is_bound_to_the_configured_password(self):
        handler = object.__new__(PanelPilotHandler)
        environment = {
            "PANEL_PILOT_AUTH_USER": "reader",
            "PANEL_PILOT_AUTH_PASSWORD": "fixture-password-long",
            "PANEL_PILOT_SESSION_SECRET": "ab" * 32,
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            token = handler.make_session_token("reader")
            handler.headers = {"Cookie": f"panel_pilot_session={token}"}
            self.assertTrue(handler.valid_session())
            os.environ["PANEL_PILOT_AUTH_PASSWORD"] = "rotated-password-long"
            self.assertFalse(handler.valid_session())

    def test_non_loopback_runtime_requires_strong_auth_and_session_secret(self):
        configurations = (
            (
                {"PANEL_PILOT_AUTH_USER": "", "PANEL_PILOT_AUTH_PASSWORD": "", "PANEL_PILOT_SESSION_SECRET": ""},
                "authentication is required",
            ),
            (
                {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": "too-short", "PANEL_PILOT_SESSION_SECRET": "ab" * 32},
                "at least 16 characters",
            ),
            (
                {"PANEL_PILOT_AUTH_USER": "reader", "PANEL_PILOT_AUTH_PASSWORD": "fixture-password-long", "PANEL_PILOT_SESSION_SECRET": "short"},
                "at least 32 bytes",
            ),
        )
        for environment, message in configurations:
            with self.subTest(message=message), mock.patch.dict(os.environ, environment, clear=False):
                with self.assertRaisesRegex(RuntimeError, message):
                    panel_pilot_server.validate_runtime_security("0.0.0.0")

        with mock.patch.dict(
            os.environ,
            {
                "PANEL_PILOT_AUTH_USER": "reader",
                "PANEL_PILOT_AUTH_PASSWORD": "fixture-password-long",
                "PANEL_PILOT_SESSION_SECRET": "ab" * 32,
            },
            clear=False,
        ):
            self.assertEqual(
                panel_pilot_server.validate_runtime_security("0.0.0.0"),
                ("reader", "fixture-password-long"),
            )

    def test_loopback_runtime_can_remain_unauthenticated_for_local_development(self):
        with mock.patch.dict(
            os.environ,
            {"PANEL_PILOT_AUTH_USER": "", "PANEL_PILOT_AUTH_PASSWORD": "", "PANEL_PILOT_SESSION_SECRET": ""},
            clear=False,
        ):
            self.assertEqual(panel_pilot_server.validate_runtime_security("127.0.0.1"), ("", ""))

    def test_login_attempt_limiter_expires_failures(self):
        limiter = panel_pilot_server.LoginAttemptLimiter(per_client_limit=2, global_limit=10, window=60)
        limiter.record_failure("203.0.113.4", now=100)
        self.assertEqual(limiter.retry_after("203.0.113.4", now=101), 0)
        limiter.record_failure("203.0.113.4", now=102)
        self.assertGreater(limiter.retry_after("203.0.113.4", now=103), 0)
        self.assertEqual(limiter.retry_after("203.0.113.4", now=163), 0)

    def test_mutation_origin_must_match_public_request_origin(self):
        handler = object.__new__(PanelPilotHandler)
        handler.client_address = ("127.0.0.1", 1234)
        handler.headers = {
            "Host": "panels.example.com",
            "X-Forwarded-Proto": "https",
            "Origin": "https://panels.example.com",
        }
        self.assertTrue(handler.mutation_origin_allowed())
        handler.headers["Origin"] = "https://attacker.example"
        self.assertFalse(handler.mutation_origin_allowed())
        handler.headers = {"Host": "panels.example.com", "Sec-Fetch-Site": "cross-site"}
        self.assertFalse(handler.mutation_origin_allowed())
        handler.headers = {"Host": "panels.example.com", "Origin": "null", "Sec-Fetch-Site": "same-origin"}
        self.assertTrue(handler.mutation_origin_allowed())


class SuwayomiUrlSecurityTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(PanelPilotHandler)

    def resolve(self, url, internal_url=""):
        with mock.patch.dict(
            os.environ, {"SUWAYOMI_INTERNAL_URL": internal_url}, clear=False
        ):
            return self.handler.resolve_suwayomi_base(url)

    def test_localhost_and_rfc1918_addresses_are_allowed(self):
        urls = (
            "http://localhost:4567",
            "http://127.0.0.1:4567",
            "http://10.20.30.40:4567",
            "http://172.16.0.1:4567",
            "http://172.31.255.254:4567",
            "http://192.168.1.20:4567",
            "http://[::1]:4567",
            "http://[fd00::1]:4567",
        )
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(self.resolve(url), url)

    def test_addresses_outside_172_16_12_are_rejected(self):
        for url in ("http://172.15.255.255:4567", "http://172.32.0.1:4567"):
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "private LAN"):
                    self.resolve(url)

    def test_public_address_and_hostname_are_rejected(self):
        for url in ("http://8.8.8.8:4567", "https://example.com"):
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "private LAN"):
                    self.resolve(url)

    def test_url_userinfo_is_rejected(self):
        for url in (
            "http://reader@127.0.0.1:4567",
            "http://reader:secret@192.168.1.20:4567",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "embedded credentials"):
                    self.resolve(url)

    def test_internal_url_userinfo_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "embedded credentials"):
            self.resolve(
                "http://localhost:4567",
                internal_url="http://reader:secret@suwayomi:4567",
            )

    def test_credential_free_internal_service_url_remains_supported(self):
        self.assertEqual(
            self.resolve(
                "http://localhost:4567", internal_url="http://suwayomi:4567"
            ),
            "http://suwayomi:4567",
        )

    def test_shared_internal_url_normalizer_rejects_userinfo(self):
        with self.assertRaisesRegex(ValueError, "embedded credentials"):
            panel_pilot_server.normalize_suwayomi_base_url(
                "http://reader:fixture-password@suwayomi:4567"
            )

    def test_asset_paths_reject_dot_segments_and_encoded_traversal(self):
        self.assertEqual(
            panel_pilot_server.safe_suwayomi_asset_path("/api/v1/manga/123/page/1"),
            "/api/v1/manga/123/page/1",
        )
        for path in (
            "/api/v1/../../admin",
            "/api/v1/%2e%2e/%2e%2e/admin",
            "/api/v1/%252e%252e/admin",
            "/api/v1/..\\admin",
        ):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "canonical"):
                panel_pilot_server.safe_suwayomi_asset_path(path)


class ServerProxySecurityTests(unittest.TestCase):
    def test_image_host_boundary_is_enforced(self):
        self.assertEqual(
            panel_pilot_server.safe_image_url("https://cdn.comicknew.pictures/page.webp"),
            "https://cdn.comicknew.pictures/page.webp",
        )
        self.assertEqual(
            panel_pilot_server.safe_image_url("https://a.cdn.comicknew.pictures/page.webp"),
            "https://a.cdn.comicknew.pictures/page.webp",
        )
        for url in (
            "https://evilcomicknew.pictures/page.webp",
            "https://evilbp.blogspot.com/page.webp",
            "https://reader:fixture-password@cdn.comicknew.pictures/page.webp",
            "https://cdn.comicknew.pictures:8443/page.webp",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                panel_pilot_server.safe_image_url(url)

    def test_cross_origin_redirect_is_rejected(self):
        handler = panel_pilot_server.SameOriginRedirectHandler()
        request = Request("https://allowed.example/page")
        with self.assertRaisesRegex(ValueError, "Cross-origin"):
            handler.redirect_request(
                request,
                None,
                302,
                "Found",
                {"Location": "https://attacker.example/secret"},
                "https://attacker.example/secret",
            )

    def test_open_url_installs_the_same_origin_redirect_handler(self):
        opener = mock.Mock()
        opener.open.return_value = object()
        request = Request("https://allowed.example/page")
        with mock.patch.object(panel_pilot_server, "build_opener", return_value=opener) as build:
            result = panel_pilot_server.open_url(request, timeout=17)
        self.assertIs(result, opener.open.return_value)
        self.assertIs(build.call_args.args[0], panel_pilot_server.SameOriginRedirectHandler)
        opener.open.assert_called_once_with(request, timeout=17)


class LibraryStorageSecurityTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(PanelPilotHandler)

    def test_library_input_strips_credentials(self):
        item = {
            "mangaId": 1,
            "sourceId": "source-1",
            "serverUrl": "https://reader:fixture-password@suwayomi.example:4567/",
        }
        cleaned = self.handler.clean_library_items([item])
        self.assertEqual(cleaned[0]["serverUrl"], "https://suwayomi.example:4567")

    def test_existing_library_is_migrated_atomically_on_read(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            panel_pilot_server, "LIBRARY_PATH", str(pathlib.Path(directory) / "library.json")
        ):
            path = pathlib.Path(panel_pilot_server.LIBRARY_PATH)
            path.write_text(
                '{"items":[{"mangaId":1,"sourceId":"source-1",'
                '"serverUrl":"https://reader:fixture-password@suwayomi.example:4567/"}]}\n',
                encoding="utf-8",
            )
            items = self.handler.read_library_items()
            self.assertEqual(items[0]["serverUrl"], "https://suwayomi.example:4567")
            persisted = path.read_text(encoding="utf-8")
            self.assertNotIn("fixture-password", persisted)
            self.assertNotIn("reader@", persisted)


if __name__ == "__main__":
    unittest.main()
