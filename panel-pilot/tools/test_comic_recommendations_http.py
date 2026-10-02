import http.cookiejar
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server as panel_server  # noqa: E402


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


class FakeFeed:
    def __init__(self, cache_key, mode="personalized"):
        self.cache_key = cache_key
        self.mode = mode

    def to_public_dict(self):
        return {
            "schemaVersion": 1,
            "mode": self.mode,
            "seedTitles": ["Saga"],
            "cacheKey": self.cache_key,
            "results": [{
                "id": "librarything:paper-girls",
                "provider": "librarything",
                "providerId": "paper-girls",
                "title": "Paper Girls",
                "searchTitles": ["Paper Girls"],
                "mediaFormat": "comic",
                "coverUrl": "https://covers.openlibrary.org/b/id/1-M.jpg",
                "creators": ["Brian K. Vaughan"],
                "year": 2015,
                "reason": {"type": "because_you_read", "seedTitles": ["Saga"]},
                "identifiers": {"isbn": ["9781632156747"]},
                "rank": 1,
            }],
        }


class FakeService:
    cache_key_value = "comic-recs-v1-" + "a" * 64

    def __init__(self, mode="personalized"):
        self.mode = mode
        self.build_calls = 0
        self.seeds = ()

    def cache_key(self, seeds, *, limit):
        self.seeds = tuple(seeds)
        return self.cache_key_value

    def build_feed(self, seeds, *, limit):
        self.build_calls += 1
        return FakeFeed(self.cache_key_value, self.mode)


class RecommendationServerUnitTests(unittest.TestCase):
    def test_seed_selection_only_uses_positive_comic_entries(self):
        seeds = panel_server.comic_seeds_from_library([
            {"mangaTitle": "Saga", "mediaFormat": "comic", "libraryStatus": "completed", "updatedAt": "2026-01-01"},
            {"mangaTitle": "Invincible", "mediaFormat": "comic", "libraryStatus": "reading", "updatedAt": "2026-01-02"},
            {"mangaTitle": "Monster", "mediaFormat": "manga", "libraryStatus": "reading", "updatedAt": "2026-01-03"},
            {"mangaTitle": "Watchmen", "mediaFormat": "comic", "libraryStatus": "plan_to_read", "updatedAt": "2026-01-04"},
        ])

        self.assertEqual([seed.title for seed in seeds], ["Invincible", "Saga"])

    def test_transport_error_redacts_librarything_query_secret(self):
        secret = "never-serialize-this-key"
        error = HTTPError(
            f"https://www.librarything.com/api/multirecommendations.php?apiKey={secret}",
            503,
            "Unavailable",
            {},
            None,
        )
        with mock.patch("server.open_url", side_effect=error):
            with self.assertRaises(panel_server.RecommendationProviderError) as raised:
                panel_server.RecommendationJsonHttpClient().get_json(
                    "https://www.librarything.com/api/multirecommendations.php",
                    params={"apiKey": secret},
                )

        self.assertEqual(str(raised.exception), "Recommendation metadata provider is unavailable")
        self.assertNotIn(secret, str(raised.exception))


class ComicRecommendationHttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_directory = tempfile.TemporaryDirectory()
        temporary_root = pathlib.Path(cls.temporary_directory.name)
        cls.original_environment = os.environ.copy()
        os.environ.update({
            "PANEL_PILOT_AUTH_USER": "reader",
            "PANEL_PILOT_AUTH_PASSWORD": "fixture-password-long",
            "PANEL_PILOT_SESSION_SECRET": "cd" * 32,
        })
        cls.original_library_path = panel_server.LIBRARY_PATH
        cls.original_cache_path = panel_server.COMIC_RECOMMENDATIONS_CACHE_PATH
        panel_server.LIBRARY_PATH = str(temporary_root / "library.json")
        panel_server.COMIC_RECOMMENDATIONS_CACHE_PATH = str(temporary_root / "comic-recommendations.json")
        pathlib.Path(panel_server.LIBRARY_PATH).write_text(json.dumps({"items": [{
            "sourceId": "fixture-comics",
            "sourceLabel": "Fixture Comics",
            "mangaId": 1,
            "mangaTitle": "Saga",
            "mediaFormat": "comic",
            "libraryStatus": "reading",
            "updatedAt": "2026-10-02T01:00:00.000Z",
        }]}), encoding="utf-8")

        cls.port = free_port()
        handler = lambda *args, **kwargs: panel_server.PanelPilotHandler(
            *args, directory=str(ROOT / "dist"), **kwargs
        )
        cls.httpd = panel_server.ThreadingHTTPServer(("127.0.0.1", cls.port), handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"

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
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        panel_server.LIBRARY_PATH = cls.original_library_path
        panel_server.COMIC_RECOMMENDATIONS_CACHE_PATH = cls.original_cache_path
        os.environ.clear()
        os.environ.update(cls.original_environment)
        cls.temporary_directory.cleanup()

    def request_json(self, path, authenticated=True):
        opener = self.opener if authenticated else build_opener()
        with opener.open(Request(f"{self.base_url}{path}", headers={"Accept": "application/json"}), timeout=5) as response:
            return response.status, response.headers, json.loads(response.read().decode("utf-8"))

    def setUp(self):
        try:
            pathlib.Path(panel_server.COMIC_RECOMMENDATIONS_CACHE_PATH).unlink()
        except FileNotFoundError:
            pass

    def test_endpoint_requires_authentication(self):
        with mock.patch("server.build_comic_recommendation_service", return_value=None):
            with self.assertRaises(HTTPError) as raised:
                self.request_json("/api/comic-recommendations", authenticated=False)
        self.assertEqual(raised.exception.code, 401)

    def test_unconfigured_is_a_clear_normal_response(self):
        with mock.patch("server.build_comic_recommendation_service", return_value=None):
            status, headers, payload = self.request_json("/api/comic-recommendations")

        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertFalse(payload["configured"])
        self.assertEqual(payload["status"], "unconfigured")
        self.assertEqual(payload["results"], [])

    def test_personalized_feed_is_persistently_cached_without_a_secret(self):
        service = FakeService()
        with mock.patch("server.build_comic_recommendation_service", return_value=service):
            _, first_headers, first = self.request_json("/api/comic-recommendations?limit=12")
            _, second_headers, second = self.request_json("/api/comic-recommendations?limit=12")

        self.assertEqual(first["cacheStatus"], "miss")
        self.assertEqual(second["cacheStatus"], "hit")
        self.assertEqual(service.build_calls, 1)
        self.assertEqual([seed.title for seed in service.seeds], ["Saga"])
        self.assertEqual(first_headers["Cache-Control"], "no-store")
        self.assertEqual(second_headers["Cache-Control"], "no-store")
        serialized_cache = pathlib.Path(panel_server.COMIC_RECOMMENDATIONS_CACHE_PATH).read_text(encoding="utf-8")
        self.assertNotIn("never-serialize-this-key", serialized_cache)
        self.assertEqual(second["results"][0]["mediaFormat"], "comic")

    def test_stale_feed_is_used_when_the_provider_is_unavailable(self):
        ready_service = FakeService()
        with mock.patch("server.build_comic_recommendation_service", return_value=ready_service):
            self.request_json("/api/comic-recommendations")
        cache_path = pathlib.Path(panel_server.COMIC_RECOMMENDATIONS_CACHE_PATH)
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        cached["entries"][FakeService.cache_key_value]["createdAt"] = 0
        cache_path.write_text(json.dumps(cached), encoding="utf-8")

        unavailable_service = FakeService(mode="unavailable")
        with mock.patch("server.build_comic_recommendation_service", return_value=unavailable_service):
            _, _, payload = self.request_json("/api/comic-recommendations")

        self.assertEqual(unavailable_service.build_calls, 1)
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["cacheStatus"], "stale")
        self.assertEqual(payload["results"][0]["title"], "Paper Girls")


if __name__ == "__main__":
    unittest.main()
