from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
import base64
from contextlib import contextmanager
import hashlib
import hmac
import html
import ipaddress
import json
import math
import os
import posixpath
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from source_intelligence import SourceIntelligenceError, SourceIntelligenceStore
from books import BookRequestError, BooksConfig, BooksService
from opds_client import OpdsError
from shelfmark_client import ShelfmarkError
from comic_recommendations import (
    ComicRecommendationService,
    ComicSeed,
    LibraryThingAdapter,
    OpenLibraryAdapter,
    RecommendationProviderError,
)
from book_recommendations import (
    BookRecommendationService,
    BookSeed,
    book_inventory_from_library,
    book_seeds_from_library,
)
from similar_recommendations import (
    MANGA_FORMATS,
    normalize_mangabaka_similar,
    select_mangabaka_seed,
)
from accounts import AccountError, AccountStore


USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
LIBRARY_PATH = os.environ.get("PANEL_PILOT_LIBRARY_PATH", "/app/data/library.json")
REPORTS_PATH = os.environ.get("PANEL_PILOT_REPORTS_PATH", "/app/data/panel-reports")
DOWNLOAD_BUFFER_PATH = os.environ.get("PANEL_PILOT_DOWNLOAD_BUFFER_PATH", "/app/data/download-buffer.json")
MANGABAKA_CONFIG_PATH = os.environ.get("PANEL_PILOT_MANGABAKA_CONFIG_PATH", "/app/data/mangabaka-config.json")
DATA_ROOT = os.environ.get("PANEL_PILOT_DATA_ROOT", "/app/data")
ACCOUNTS_PATH = os.environ.get("PANEL_PILOT_ACCOUNTS_PATH", os.path.join(DATA_ROOT, "accounts.sqlite3"))
READING_STATS_PATH = os.environ.get(
    "PANEL_PILOT_READING_STATS_PATH",
    os.path.join(DATA_ROOT, "reading-stats.sqlite3"),
)
MOMENTS_PATH = os.environ.get("PANEL_PILOT_MOMENTS_PATH", os.path.join(DATA_ROOT, "moments"))
SOURCE_PROFILES_PATH = os.environ.get("PANEL_PILOT_SOURCE_PROFILES_PATH", os.path.join(DATA_ROOT, "source-profiles.json"))
SOURCE_INTELLIGENCE_PATH = os.environ.get(
    "PANEL_PILOT_SOURCE_INTELLIGENCE_PATH",
    os.path.join(DATA_ROOT, "source-intelligence.sqlite3"),
)
COMIC_RECOMMENDATIONS_CACHE_PATH = os.environ.get(
    "PANEL_PILOT_COMIC_RECOMMENDATIONS_CACHE_PATH",
    os.path.join(DATA_ROOT, "comic-recommendations-cache.json"),
)
BOOK_RECOMMENDATIONS_CACHE_PATH = os.environ.get(
    "PANEL_PILOT_BOOK_RECOMMENDATIONS_CACHE_PATH",
    os.path.join(DATA_ROOT, "book-recommendations-cache.json"),
)
COMIC_RECOMMENDATIONS_CONFIG_PATH = os.environ.get(
    "PANEL_PILOT_COMIC_RECOMMENDATIONS_CONFIG_PATH",
    os.path.join(DATA_ROOT, "comic-recommendations-config.json"),
)
COMIC_RECOMMENDATIONS_CACHE_TTL = 7 * 24 * 60 * 60
MANGABAKA_API_BASE = "https://api.mangabaka.org"
LIBRARY_LIMIT = 5000
LIBRARY_LOCK = threading.Lock()
REPORT_LOCK = threading.Lock()
DETECTOR_CACHE_LOCK = threading.Lock()
MANGABAKA_LOCK = threading.Lock()
DOWNLOAD_BUFFER_MANAGER = None
BOOKS_SERVICE = None
BOOKS_SERVICE_LOCK = threading.Lock()
ACCOUNT_STORE = None
ACCOUNT_STORE_LOCK = threading.Lock()
ACCOUNT_OWNER_FINGERPRINT = ""
READING_STATS_LOCK = threading.RLock()
MOMENTS_LOCK = threading.Lock()
SOURCE_PROFILES_LOCK = threading.Lock()
COMIC_RECOMMENDATIONS_CACHE_LOCK = threading.Lock()
COMIC_RECOMMENDATIONS_CONFIG_LOCK = threading.Lock()
MOMENT_ID_PATTERN = re.compile(r"^[0-9]{13}-[0-9a-f]{16}$")
SOURCE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9._:-]{1,100}$")


class SourceProfileStore:
    OPERATIONS = ("search", "pages", "download")
    FORMATS = ("manga", "comic", "webtoon")

    def __init__(self, path=None):
        self.path = Path(path or SOURCE_PROFILES_PATH).expanduser().resolve()

    def _read_locked(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {"version": 1, "sources": {}}
        if not isinstance(payload, dict) or not isinstance(payload.get("sources"), dict):
            return {"version": 1, "sources": {}}
        return payload

    def _write_locked(self, payload):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent, prefix=".source-profiles-", delete=False) as temporary:
            json.dump(payload, temporary, ensure_ascii=True, indent=2)
            temporary.write("\n")
            temporary_path = Path(temporary.name)
        try:
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()

    def clean_observation(self, observation):
        if not isinstance(observation, dict):
            raise ValueError("Source observation must be an object")
        source_id = str(observation.get("sourceId") or "").strip()
        if not SOURCE_ID_PATTERN.fullmatch(source_id):
            raise ValueError("Source observation has an invalid sourceId")
        operation = str(observation.get("operation") or "")
        if operation not in self.OPERATIONS:
            raise ValueError("Source observation has an invalid operation")
        outcome = str(observation.get("outcome") or "")
        if outcome not in ("success", "failure"):
            raise ValueError("Source observation has an invalid outcome")
        try:
            latency_ms = max(0, min(120000, int(observation.get("latencyMs") or 0)))
        except (TypeError, ValueError) as error:
            raise ValueError("Source observation has an invalid latency") from error
        source_label = str(observation.get("sourceLabel") or "").replace("\x00", "").strip()[:200]
        media_format = str(observation.get("mediaFormat") or "")
        return {
            "sourceId": source_id,
            "sourceLabel": source_label,
            "operation": operation,
            "outcome": outcome,
            "latencyMs": latency_ms,
            "mediaFormat": media_format if media_format in self.FORMATS else "",
        }

    def ingest(self, observations):
        if not isinstance(observations, list) or not 1 <= len(observations) <= 100:
            raise ValueError("Source observations must contain between 1 and 100 entries")
        cleaned = [self.clean_observation(observation) for observation in observations]
        now = datetime.now(timezone.utc).isoformat()
        with SOURCE_PROFILES_LOCK:
            payload = self._read_locked()
            sources = payload["sources"]
            for observation in cleaned:
                source_id = observation["sourceId"]
                profile = sources.setdefault(source_id, {
                    "sourceId": source_id,
                    "sourceLabel": observation["sourceLabel"],
                    "attempts": 0,
                    "successes": 0,
                    "failures": 0,
                    "successLatencyMs": 0,
                    "health": 0.8,
                    "consecutiveFailures": 0,
                    "operations": {},
                    "formats": {},
                })
                success = observation["outcome"] == "success"
                profile["sourceLabel"] = observation["sourceLabel"] or profile.get("sourceLabel", "")
                profile["attempts"] = min(1000000, int(profile.get("attempts", 0)) + 1)
                result_key = "successes" if success else "failures"
                profile[result_key] = min(1000000, int(profile.get(result_key, 0)) + 1)
                if success:
                    profile["successLatencyMs"] = min(120000000000, int(profile.get("successLatencyMs", 0)) + observation["latencyMs"])
                    profile["consecutiveFailures"] = 0
                    profile["lastSuccessAt"] = now
                else:
                    profile["consecutiveFailures"] = min(1000, int(profile.get("consecutiveFailures", 0)) + 1)
                    profile["lastFailureAt"] = now
                previous_health = max(0.0, min(1.0, float(profile.get("health", 0.8))))
                profile["health"] = round(previous_health * 0.8 + (0.2 if success else 0.0), 6)
                operation = profile["operations"].setdefault(observation["operation"], {"attempts": 0, "successes": 0, "failures": 0})
                operation["attempts"] += 1
                operation[result_key] += 1
                if observation["mediaFormat"]:
                    formats = profile["formats"]
                    formats[observation["mediaFormat"]] = int(formats.get(observation["mediaFormat"], 0)) + 1
                profile["updatedAt"] = now
            self._write_locked(payload)
        return self.summary()

    def public_profile(self, profile):
        attempts = max(0, int(profile.get("attempts", 0)))
        successes = max(0, int(profile.get("successes", 0)))
        failures = max(0, int(profile.get("failures", 0)))
        average_latency = round(int(profile.get("successLatencyMs", 0)) / successes) if successes else 0
        health = max(0.0, min(1.0, float(profile.get("health", 0.8))))
        latency_score = max(0.0, 1.0 - (average_latency / 15000)) if successes else 0.5
        score = round(100 * ((0.85 * health) + (0.15 * latency_score)))
        confidence = "established" if attempts >= 10 else "developing" if attempts >= 3 else "early"
        return {
            "sourceId": str(profile.get("sourceId") or ""),
            "sourceLabel": str(profile.get("sourceLabel") or "")[:200],
            "score": max(0, min(100, score)),
            "confidence": confidence,
            "attempts": attempts,
            "successes": successes,
            "failures": failures,
            "successRate": round(successes / attempts, 3) if attempts else None,
            "averageLatencyMs": average_latency,
            "consecutiveFailures": max(0, int(profile.get("consecutiveFailures", 0))),
            "operations": profile.get("operations", {}),
            "formats": profile.get("formats", {}),
            "lastSuccessAt": profile.get("lastSuccessAt"),
            "lastFailureAt": profile.get("lastFailureAt"),
            "updatedAt": profile.get("updatedAt"),
        }

    def summary(self):
        with SOURCE_PROFILES_LOCK:
            profiles = [self.public_profile(profile) for profile in self._read_locked()["sources"].values()]
        profiles.sort(key=lambda profile: (-profile["score"], -profile["attempts"], profile["sourceLabel"]))
        return {"schemaVersion": 1, "profiles": profiles}


IMAGE_CDN_DOMAINS = (
    "comicknew.pictures",
    "comick.pictures",
    "bp.blogspot.com",
)


def suwayomi_auth_credentials():
    username = os.environ.get("SUWAYOMI_AUTH_USER", "").strip()
    password = os.environ.get("SUWAYOMI_AUTH_PASSWORD", "")
    if bool(username) != bool(password):
        raise RuntimeError(
            "SUWAYOMI_AUTH_USER and SUWAYOMI_AUTH_PASSWORD must either both be set or both be unset"
        )
    return username, password


def validate_suwayomi_url(parsed_url):
    if parsed_url.scheme not in ("http", "https"):
        raise ValueError("Suwayomi URL must start with http:// or https://")
    if parsed_url.username is not None or parsed_url.password is not None:
        raise ValueError("Suwayomi URL must not contain embedded credentials")
    if not parsed_url.hostname:
        raise ValueError("Suwayomi URL must include a host")
    try:
        parsed_url.port
    except ValueError as error:
        raise ValueError("Suwayomi URL must include a valid port") from error


def normalize_suwayomi_base_url(raw_base):
    base = str(raw_base or "").strip().rstrip("/")
    parsed = urlparse(base)
    validate_suwayomi_url(parsed)
    return base


class SameOriginRedirectHandler(HTTPRedirectHandler):
    """Allow ordinary redirects only when they stay on the same origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlparse(urljoin(req.full_url, newurl))
        source = urlparse(req.full_url)
        try:
            source_origin = (source.scheme, source.hostname, source.port)
            target_origin = (target.scheme, target.hostname, target.port)
        except ValueError as error:
            raise ValueError("Invalid redirect URL") from error
        if (
            target.username is not None
            or target.password is not None
            or target_origin != source_origin
        ):
            raise ValueError("Cross-origin redirects are not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_url(request, timeout=30):
    return build_opener(SameOriginRedirectHandler).open(request, timeout=timeout)


COMIC_RECOMMENDATIONS_UPSTREAM_LOCK = threading.Lock()
COMIC_RECOMMENDATIONS_LAST_REQUEST = {}


class RecommendationJsonHttpClient:
    """Small, allowlisted JSON transport for recommendation metadata providers."""

    ALLOWED_HOSTS = frozenset(("openlibrary.org", "www.librarything.com"))
    RESPONSE_LIMIT = 6_000_000

    def get_json(self, url, *, params, headers=None):
        parsed = urlparse(str(url or ""))
        if (
            parsed.scheme != "https"
            or parsed.hostname not in self.ALLOWED_HOSTS
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
        ):
            raise RecommendationProviderError("Recommendation provider URL is not allowed")
        query = urlencode({str(key): str(value) for key, value in dict(params or {}).items()})
        target = f"{url}?{query}" if query else url
        request_headers = {str(key): str(value) for key, value in dict(headers or {}).items()}
        request = Request(target, headers=request_headers, method="GET")

        # Open Library asks unidentified clients to stay at or below one request
        # per second. A configured contact identifies this self-hosted instance.
        contact = os.environ.get("PANEL_PILOT_OPEN_LIBRARY_CONTACT", "").replace("\r", "").replace("\n", "").strip()[:200]
        minimum_interval = 0.35 if parsed.hostname == "openlibrary.org" and contact else 1.05
        if parsed.hostname == "www.librarything.com":
            minimum_interval = 1.05
        try:
            with COMIC_RECOMMENDATIONS_UPSTREAM_LOCK:
                previous = COMIC_RECOMMENDATIONS_LAST_REQUEST.get(parsed.hostname, 0.0)
                delay = minimum_interval - (time.monotonic() - previous)
                if delay > 0:
                    time.sleep(delay)
                try:
                    with open_url(request, timeout=20) as response:
                        body = response.read(self.RESPONSE_LIMIT)
                        if len(body) >= self.RESPONSE_LIMIT:
                            raise RecommendationProviderError("Recommendation provider response was too large")
                finally:
                    COMIC_RECOMMENDATIONS_LAST_REQUEST[parsed.hostname] = time.monotonic()
            payload = json.loads(body.decode("utf-8") or "{}")
        except RecommendationProviderError:
            raise
        except (HTTPError, URLError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            # Deliberately omit the request URL because LibraryThing credentials
            # are query parameters.
            raise RecommendationProviderError("Recommendation metadata provider is unavailable") from error
        if not isinstance(payload, dict):
            raise RecommendationProviderError("Recommendation metadata provider returned an invalid response")
        return payload


class ComicRecommendationCache:
    VERSION = 1
    MAX_ENTRIES = 24

    def __init__(self, path=None, ttl_seconds=COMIC_RECOMMENDATIONS_CACHE_TTL, key_prefix="comic-recs", label="comic"):
        self.path = Path(path or COMIC_RECOMMENDATIONS_CACHE_PATH).expanduser().resolve()
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.key_prefix = str(key_prefix)
        self.label = str(label)

    def _read_locked(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {"version": self.VERSION, "entries": {}}
        if payload.get("version") != self.VERSION or not isinstance(payload.get("entries"), dict):
            return {"version": self.VERSION, "entries": {}}
        return payload

    def get(self, cache_key):
        if not re.fullmatch(rf"{re.escape(self.key_prefix)}-v\d+-[0-9a-f]{{64}}", str(cache_key or "")):
            return None, "miss"
        with COMIC_RECOMMENDATIONS_CACHE_LOCK:
            entry = self._read_locked()["entries"].get(cache_key)
        if not isinstance(entry, dict) or not isinstance(entry.get("feed"), dict):
            return None, "miss"
        try:
            age = max(0.0, time.time() - float(entry.get("createdAt")))
        except (TypeError, ValueError):
            return None, "miss"
        return entry["feed"], "hit" if age <= self.ttl_seconds else "stale"

    def put(self, cache_key, feed):
        if not re.fullmatch(rf"{re.escape(self.key_prefix)}-v\d+-[0-9a-f]{{64}}", str(cache_key or "")):
            raise ValueError(f"Invalid {self.label} recommendation cache key")
        if not isinstance(feed, dict):
            raise ValueError(f"Invalid {self.label} recommendation cache payload")
        with COMIC_RECOMMENDATIONS_CACHE_LOCK:
            payload = self._read_locked()
            payload["entries"][cache_key] = {"createdAt": time.time(), "feed": feed}
            def created_at(entry_item):
                try:
                    return float(entry_item[1].get("createdAt") or 0)
                except (AttributeError, TypeError, ValueError):
                    return 0.0
            ordered = sorted(
                payload["entries"].items(),
                key=created_at,
                reverse=True,
            )[:self.MAX_ENTRIES]
            payload["entries"] = dict(ordered)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=self.path.parent, prefix=f".{self.label}-recommendations-", delete=False
            ) as temporary:
                json.dump(payload, temporary, ensure_ascii=True, separators=(",", ":"))
                temporary.write("\n")
                temporary_path = Path(temporary.name)
            try:
                os.replace(temporary_path, self.path)
            finally:
                if temporary_path.exists():
                    temporary_path.unlink()


def comic_seeds_from_library(items, maximum=6):
    """Select positive, explicit Western-comic library entries deterministically."""

    ignored_statuses = {"plan_to_read", "considering", "dropped"}
    status_priority = {"reading": 0, "rereading": 0, "completed": 1, "paused": 2}
    candidates = []
    seen = set()
    for item in items if isinstance(items, list) else ():
        if not isinstance(item, dict) or item.get("mediaFormat") != "comic" or item.get("isNsfw") or item.get("privateSource"):
            continue
        status = str(item.get("libraryStatus") or "")
        if status in ignored_statuses:
            continue
        title = str(item.get("mangaTitle") or "").replace("\x00", "").strip()[:300]
        title_key = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if not title or not title_key or title_key in seen:
            continue
        seen.add(title_key)
        candidates.append((
            status_priority.get(status, 3),
            str(item.get("updatedAt") or ""),
            title.lower(),
            ComicSeed(title),
        ))
    candidates.sort(key=lambda item: item[2])
    candidates.sort(key=lambda item: item[1], reverse=True)
    candidates.sort(key=lambda item: item[0])
    return tuple(item[3] for item in candidates[:max(1, min(12, int(maximum)))])


def build_comic_recommendation_service():
    config = read_comic_recommendations_config()
    api_key = config["apiKey"]
    if not api_key:
        return None
    contact = config["contact"]
    user_agent = "Panels comic recommendations"
    if contact:
        user_agent += f" ({contact})"
    http = RecommendationJsonHttpClient()
    return ComicRecommendationService(
        librarything=LibraryThingAdapter(http, api_key=api_key),
        open_library=OpenLibraryAdapter(http, user_agent=user_agent),
    )


def build_book_recommendation_service():
    config = read_comic_recommendations_config()
    api_key = config["apiKey"]
    if not api_key:
        return None
    contact = config["contact"]
    user_agent = "Panels book recommendations"
    if contact:
        user_agent += f" ({contact})"
    http = RecommendationJsonHttpClient()
    return BookRecommendationService(
        librarything=LibraryThingAdapter(http, api_key=api_key),
        open_library=OpenLibraryAdapter(http, user_agent=user_agent),
    )


def host_matches_domain(host, domain):
    normalized_host = str(host or "").rstrip(".").lower()
    normalized_domain = str(domain or "").rstrip(".").lower()
    return normalized_host == normalized_domain or normalized_host.endswith(f".{normalized_domain}")


def safe_suwayomi_asset_path(raw_path):
    path = unquote(str(raw_path or ""))
    for _ in range(2):
        decoded_path = unquote(path)
        if decoded_path == path:
            break
        path = decoded_path
    parsed = urlparse(path)
    decoded_path = parsed.path
    segments = decoded_path.split("/")
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or not decoded_path.startswith("/")
        or decoded_path.startswith("//")
        or "\\" in decoded_path
        or any(segment in (".", "..") for segment in segments)
        or not decoded_path.startswith("/api/v1/")
    ):
        raise ValueError("Suwayomi asset path must be a canonical /api/v1/ path")
    canonical_path = posixpath.normpath(decoded_path)
    if canonical_path != decoded_path or not canonical_path.startswith("/api/v1/"):
        raise ValueError("Suwayomi asset path must be a canonical /api/v1/ path")
    return decoded_path + (f"?{parsed.query}" if parsed.query else "")


def sanitize_library_server_url(value):
    """Return a credential-free HTTP(S) URL, or None for invalid values."""
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if parsed.username is None and parsed.password is None:
        return raw
    hostname = parsed.hostname
    host_part = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    netloc = host_part if port is None else f"{host_part}:{port}"
    return parsed._replace(netloc=netloc, fragment="").geturl().rstrip("/")


def panel_auth_credentials():
    username = os.environ.get("PANEL_PILOT_AUTH_USER", "").strip()
    password = os.environ.get("PANEL_PILOT_AUTH_PASSWORD", "")
    return username, password


def validate_panel_auth_configuration():
    username, password = panel_auth_credentials()
    if bool(username) != bool(password):
        raise RuntimeError(
            "PANEL_PILOT_AUTH_USER and PANEL_PILOT_AUTH_PASSWORD must either both be set or both be unset"
        )
    return username, password


def resolve_bind_address():
    return os.environ.get("PANEL_PILOT_BIND_ADDRESS", "").strip() or "127.0.0.1"


SESSION_COOKIE = "panel_pilot_session"
SESSION_MAX_AGE = int(os.environ.get("PANEL_PILOT_SESSION_MAX_AGE", str(30 * 24 * 60 * 60)))
LOGIN_FAILURE_LIMIT = 5
LOGIN_GLOBAL_FAILURE_LIMIT = 100
LOGIN_FAILURE_WINDOW = 15 * 60
APP_ROOT = Path(__file__).resolve().parent
PROTECTED_STATIC_PATHS = {
    "/.dockerignore",
    "/docker-compose.yml",
    "/dockerfile",
    "/package-lock.json",
    "/package.json",
    "/accounts.py",
    "/comic_recommendations.py",
    "/similar_recommendations.py",
    "/server.py",
    "/vite.config.js",
}
PROTECTED_STATIC_PREFIXES = ("/.git/", "/__pycache__/", "/data/", "/tests/", "/tools/")
LEGACY_SERVICE_WORKER_BRIDGE = b"""const shellCachePattern = /^panel-pilot-v\\d+$/;
const deviceCacheName = "panels-device-chapters-v1";
const devicePathPrefix = "/__panels_device_chapters/v1/";
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== deviceCacheName && shellCachePattern.test(key)).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "DEVICE_CHAPTER_CAPABILITY") event.ports?.[0]?.postMessage({ supported: true, version: 1 });
  if (event.data?.type === "APP_LIFECYCLE_CAPABILITY") event.ports?.[0]?.postMessage({ supported: true, protocolVersion: 0, buildId: "legacy-bridge" });
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(devicePathPrefix)) {
    event.respondWith(caches.open(deviceCacheName).then(async (cache) => (
      await cache.match(request, { ignoreSearch: true }) || new Response("Device chapter media not found", { status: 404 })
    )));
    return;
  }
  event.respondWith(fetch(request));
});
"""


def resolve_static_root():
    configured = os.environ.get("PANEL_PILOT_STATIC_ROOT", "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            candidate = APP_ROOT / candidate
        source = "PANEL_PILOT_STATIC_ROOT"
    else:
        built_root = APP_ROOT / "dist"
        if built_root.is_dir():
            candidate = built_root
            source = "the local dist directory"
        elif os.environ.get("PANEL_PILOT_ALLOW_SOURCE_STATIC", "").strip() == "1":
            candidate = APP_ROOT
            source = "the explicitly enabled development source fallback"
        else:
            raise RuntimeError(
                "Panels' production frontend build is missing. Run `npm ci` and "
                "`npm run build`, set PANEL_PILOT_STATIC_ROOT to a built frontend, or "
                "set PANEL_PILOT_ALLOW_SOURCE_STATIC=1 for development only."
            )

    root = candidate.resolve()
    missing = [name for name in ("index.html", "login.html") if not (root / name).is_file()]
    if missing:
        raise RuntimeError(
            f"Invalid Panels static root from {source}: {root}. "
            f"Missing required build output: {', '.join(missing)}."
        )
    return root


def decode_session_secret(configured):
    value = str(configured or "")
    if re.fullmatch(r"[0-9a-fA-F]{64}", value):
        return bytes.fromhex(value)
    return value.encode("utf-8")


def bind_address_is_loopback(bind_address):
    normalized = str(bind_address or "").strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def validate_runtime_security(bind_address):
    username, password = validate_panel_auth_configuration()
    if SESSION_MAX_AGE < 300 or SESSION_MAX_AGE > 31 * 24 * 60 * 60:
        raise RuntimeError("PANEL_PILOT_SESSION_MAX_AGE must be between 300 seconds and 31 days")
    if bind_address_is_loopback(bind_address):
        return username, password
    if not username or not password:
        raise RuntimeError("Panels authentication is required when binding outside loopback")
    if len(password) < 16:
        raise RuntimeError("PANEL_PILOT_AUTH_PASSWORD must be at least 16 characters")
    configured_secret = os.environ.get("PANEL_PILOT_SESSION_SECRET", "")
    if len(decode_session_secret(configured_secret)) < 32:
        raise RuntimeError("PANEL_PILOT_SESSION_SECRET must contain at least 32 bytes of entropy")
    return username, password


def account_store():
    global ACCOUNT_STORE, ACCOUNT_OWNER_FINGERPRINT
    username, password = validate_panel_auth_configuration()
    with ACCOUNT_STORE_LOCK:
        path = str(Path(ACCOUNTS_PATH).expanduser().resolve())
        if ACCOUNT_STORE is None or str(ACCOUNT_STORE.path) != path:
            ACCOUNT_STORE = AccountStore(path)
            ACCOUNT_OWNER_FINGERPRINT = ""
        fingerprint = hashlib.sha256(f"{username}\0{password}".encode("utf-8")).hexdigest()
        if fingerprint != ACCOUNT_OWNER_FINGERPRINT:
            ACCOUNT_STORE.ensure_owner(username, password)
            ACCOUNT_OWNER_FINGERPRINT = fingerprint
        return ACCOUNT_STORE


class LoginAttemptLimiter:
    def __init__(
        self,
        per_client_limit=LOGIN_FAILURE_LIMIT,
        global_limit=LOGIN_GLOBAL_FAILURE_LIMIT,
        window=LOGIN_FAILURE_WINDOW,
    ):
        self.per_client_limit = per_client_limit
        self.global_limit = global_limit
        self.window = window
        self.failures = {}
        self.lock = threading.Lock()

    def _prune_locked(self, now):
        cutoff = now - self.window
        for key, attempts in list(self.failures.items()):
            remaining = [attempt for attempt in attempts if attempt > cutoff]
            if remaining:
                self.failures[key] = remaining
            else:
                self.failures.pop(key, None)

    def retry_after(self, client_key, now=None):
        instant = time.monotonic() if now is None else now
        with self.lock:
            self._prune_locked(instant)
            retry_values = []
            for key, limit in ((client_key, self.per_client_limit), ("*", self.global_limit)):
                attempts = self.failures.get(key, [])
                if len(attempts) >= limit:
                    retry_values.append(max(1, int(self.window - (instant - attempts[0])) + 1))
            return max(retry_values, default=0)

    def record_failure(self, client_key, now=None):
        instant = time.monotonic() if now is None else now
        with self.lock:
            self._prune_locked(instant)
            self.failures.setdefault(client_key, []).append(instant)
            self.failures.setdefault("*", []).append(instant)

    def clear_client(self, client_key):
        with self.lock:
            self.failures.pop(client_key, None)


LOGIN_ATTEMPTS = LoginAttemptLimiter()


class ReadingStatsRequestError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ReadingStatsStore:
    """Private, prospective reading telemetry stored on the Panels server only."""

    SCHEMA_VERSION = 1
    EVENT_TYPES = {"active_minute", "page_view", "chapter_finish", "title_complete"}
    RANGE_DAYS = {"7d": 7, "30d": 30, "365d": 365, "all": None}
    ACHIEVEMENTS = (
        ("first-finish", "First finish", "Finish your first chapter"),
        ("ten-finishes", "Chapter scout", "Finish 10 unique chapters"),
        ("twenty-five-finishes", "Turning pages", "Finish 25 unique chapters"),
        ("fifty-finishes", "Shelf momentum", "Finish 50 unique chapters"),
        ("hundred-finishes", "Century reader", "Finish 100 unique chapters"),
        ("two-fifty-finishes", "Chapter titan", "Finish 250 unique chapters"),
        ("hundred-pages", "Page turner", "Read 100 pages"),
        ("five-hundred-pages", "Paper trail", "Read 500 pages"),
        ("thousand-pages", "Thousand-page stare", "Read 1,000 pages"),
        ("five-thousand-pages", "Ink ocean", "Read 5,000 pages"),
        ("one-reading-hour", "Settling in", "Spend an hour reading"),
        ("ten-reading-hours", "Lost in the panels", "Spend 10 hours reading"),
        ("fifty-reading-hours", "Long-form legend", "Spend 50 hours reading"),
        ("hundred-reading-hours", "Time well read", "Spend 100 hours reading"),
        ("three-titles", "Curious reader", "Explore three titles"),
        ("ten-titles", "Genre hopper", "Explore 10 titles"),
        ("twenty-five-titles", "Library wanderer", "Explore 25 titles"),
        ("first-title-complete", "The end", "Complete your first series"),
        ("five-titles-complete", "Series finisher", "Complete five series"),
        ("ten-titles-complete", "Closing credits", "Complete 10 series"),
        ("seven-reading-days", "A week of reading", "Read on seven days"),
        ("thirty-reading-days", "Regular visitor", "Read on 30 different days"),
        ("hundred-reading-days", "Well-worn bookmark", "Read on 100 different days"),
        ("three-day-rhythm", "Finding a rhythm", "Read for three days in a row"),
        ("seven-day-rhythm", "Seven-day rhythm", "Read for seven days in a row"),
        ("fourteen-day-rhythm", "Fortnight flow", "Read for 14 days in a row"),
        ("thirty-day-rhythm", "Month in motion", "Read for 30 days in a row"),
        ("first-reread", "Worth another look", "Finish a chapter again"),
        ("five-rereads", "Second-pass scholar", "Reread five chapters"),
        ("twenty-five-rereads", "Comfort chapters", "Reread 25 chapters"),
        ("ten-chapter-day", "Chapter sprint", "Finish 10 chapters in one reading day"),
        ("hundred-page-day", "Page storm", "Read 100 pages in one reading day"),
        ("two-hour-day", "Deep dive", "Read for two hours in one reading day"),
    )

    def __init__(self, path=None):
        self.path = str(path or READING_STATS_PATH)
        self._initialize()

    @staticmethod
    def _utc_now():
        return datetime.now(timezone.utc).replace(microsecond=0)

    @staticmethod
    def _iso(value):
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    @classmethod
    def _parse_timestamp(cls, value, field="occurredAt"):
        if not isinstance(value, str) or len(value) > 40:
            raise ReadingStatsRequestError(f"{field} must be an ISO-8601 timestamp")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ReadingStatsRequestError(f"{field} must be an ISO-8601 timestamp") from error
        if parsed.tzinfo is None:
            raise ReadingStatsRequestError(f"{field} must include a timezone")
        return parsed.astimezone(timezone.utc).replace(microsecond=0)

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def _database(self):
        connection = self._connect()
        try:
            yield connection
            if connection.in_transaction:
                connection.commit()
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        with READING_STATS_LOCK, self._database() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > self.SCHEMA_VERSION:
                raise RuntimeError(
                    f"Reading stats database schema {version} is newer than supported schema {self.SCHEMA_VERSION}"
                )
            if version < 1:
                self._migrate_v1(connection)
            connection.execute(f"PRAGMA user_version = {self.SCHEMA_VERSION}")

    def _migrate_v1(self, connection):
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS stats_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stats_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                show_stats INTEGER NOT NULL CHECK (show_stats IN (0, 1)),
                show_rhythm INTEGER NOT NULL CHECK (show_rhythm IN (0, 1)),
                celebrations INTEGER NOT NULL CHECK (celebrations IN (0, 1)),
                timezone TEXT NOT NULL,
                day_start_hour INTEGER NOT NULL CHECK (day_start_hour BETWEEN 0 AND 12),
                prospective_since TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ingested_events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                ingested_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activity_minutes (
                minute_utc TEXT PRIMARY KEY,
                seconds INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 60),
                last_event_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activity_minute_titles (
                minute_utc TEXT NOT NULL,
                title_hash TEXT NOT NULL,
                seconds INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 60),
                PRIMARY KEY (minute_utc, title_hash),
                FOREIGN KEY (minute_utc) REFERENCES activity_minutes(minute_utc) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS page_views (
                event_id TEXT PRIMARY KEY,
                title_hash TEXT NOT NULL,
                chapter_hash TEXT NOT NULL,
                page_hash TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                FOREIGN KEY (event_id) REFERENCES ingested_events(event_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS chapter_finishes (
                event_id TEXT PRIMARY KEY,
                title_hash TEXT NOT NULL,
                chapter_hash TEXT NOT NULL,
                attempt_hash TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                UNIQUE (title_hash, chapter_hash, attempt_hash),
                FOREIGN KEY (event_id) REFERENCES ingested_events(event_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS title_completions (
                event_id TEXT PRIMARY KEY,
                title_hash TEXT NOT NULL UNIQUE,
                occurred_at TEXT NOT NULL,
                FOREIGN KEY (event_id) REFERENCES ingested_events(event_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS achievements (
                achievement_id TEXT PRIMARY KEY,
                unlocked_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_occurred ON ingested_events(occurred_at);
            CREATE INDEX IF NOT EXISTS idx_pages_occurred ON page_views(occurred_at);
            CREATE INDEX IF NOT EXISTS idx_finishes_occurred ON chapter_finishes(occurred_at);
            """
        )
        now = self._iso(self._utc_now())
        connection.execute(
            "INSERT OR IGNORE INTO stats_meta(key, value) VALUES ('identifier_salt', ?)",
            (secrets.token_hex(32),),
        )
        connection.execute(
            """INSERT OR IGNORE INTO stats_profile(
                id, enabled, show_stats, show_rhythm, celebrations, timezone,
                day_start_hour, prospective_since, updated_at
            ) VALUES (1, 0, 1, 1, 1, 'UTC', 4, NULL, ?)""",
            (now,),
        )

    @staticmethod
    def _validate_identity(value, field):
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ReadingStatsRequestError(f"{field} must be a non-empty string of at most 500 characters")
        return value.strip()

    @staticmethod
    def _validate_token(value, field, maximum=160):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,%d}" % maximum, value):
            raise ReadingStatsRequestError(f"{field} has an invalid format")
        return value

    @staticmethod
    def _active_seconds(event):
        seconds = event.get("seconds")
        if isinstance(seconds, int) and not isinstance(seconds, bool) and 1 <= seconds <= 60:
            return seconds
        active_ms = event.get("activeMs")
        if isinstance(active_ms, (int, float)) and not isinstance(active_ms, bool) and 0 < active_ms <= 60000:
            return min(60, max(1, int((active_ms + 999) // 1000)))
        raise ReadingStatsRequestError("active_minute must include seconds from 1 to 60 or activeMs from 1 to 60000")

    @classmethod
    def _page_identity(cls, event):
        page_key = event.get("pageKey")
        if page_key is not None:
            return cls._validate_identity(page_key, "pageKey")
        page_index = event.get("pageIndex")
        if isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
            raise ReadingStatsRequestError("page_view must include pageKey or a non-negative pageIndex")
        return f"index:{page_index}"

    def _hash(self, connection, namespace, value):
        salt = connection.execute(
            "SELECT value FROM stats_meta WHERE key = 'identifier_salt'"
        ).fetchone()[0]
        return hmac.new(
            bytes.fromhex(salt),
            f"{namespace}\0{value}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def _settings_from_row(row):
        return {
            "enabled": bool(row["enabled"]),
            "showStats": bool(row["show_stats"]),
            "showRhythm": bool(row["show_rhythm"]),
            "celebrations": bool(row["celebrations"]),
            "timezone": row["timezone"],
            "dayStartHour": row["day_start_hour"],
        }

    def get_settings(self):
        with READING_STATS_LOCK, self._database() as connection:
            row = connection.execute("SELECT * FROM stats_profile WHERE id = 1").fetchone()
            return {
                "schemaVersion": self.SCHEMA_VERSION,
                "prospectiveSince": row["prospective_since"],
                "since": row["prospective_since"],
                **self._settings_from_row(row),
            }

    def update_settings(self, payload):
        if not isinstance(payload, dict):
            raise ReadingStatsRequestError("Settings must be an object")
        allowed = {
            "enabled", "showStats", "showRhythm", "celebrations", "timezone", "dayStartHour",
            # Device-local metadata is accepted but never persisted server-side.
            "since", "prospectiveSince", "startedAt", "updatedAt", "schemaVersion",
        }
        unknown = set(payload) - allowed
        if unknown:
            raise ReadingStatsRequestError(f"Unknown settings: {', '.join(sorted(unknown))}")
        with READING_STATS_LOCK, self._database() as connection:
            row = connection.execute("SELECT * FROM stats_profile WHERE id = 1").fetchone()
            values = self._settings_from_row(row)
            for field in ("enabled", "showStats", "showRhythm", "celebrations"):
                if field in payload:
                    if not isinstance(payload[field], bool):
                        raise ReadingStatsRequestError(f"{field} must be true or false")
                    values[field] = payload[field]
            if "timezone" in payload:
                timezone_name = payload["timezone"]
                if not isinstance(timezone_name, str) or len(timezone_name) > 100:
                    raise ReadingStatsRequestError("timezone must be an IANA timezone name")
                try:
                    ZoneInfo(timezone_name)
                except (ZoneInfoNotFoundError, ValueError) as error:
                    raise ReadingStatsRequestError("timezone must be an IANA timezone name") from error
                values["timezone"] = timezone_name
            if "dayStartHour" in payload:
                hour = payload["dayStartHour"]
                if isinstance(hour, bool) or not isinstance(hour, int) or not 0 <= hour <= 12:
                    raise ReadingStatsRequestError("dayStartHour must be an integer from 0 to 12")
                values["dayStartHour"] = hour
            prospective_since = row["prospective_since"]
            if values["enabled"] and not bool(row["enabled"]) and not prospective_since:
                prospective_since = self._iso(self._utc_now())
            connection.execute(
                """UPDATE stats_profile SET enabled=?, show_stats=?, show_rhythm=?, celebrations=?,
                    timezone=?, day_start_hour=?, prospective_since=?, updated_at=? WHERE id=1""",
                (
                    int(values["enabled"]), int(values["showStats"]), int(values["showRhythm"]),
                    int(values["celebrations"]), values["timezone"], values["dayStartHour"],
                    prospective_since,
                    self._iso(self._utc_now()),
                ),
            )
        return self.get_settings()

    def ingest(self, events):
        if not isinstance(events, list) or not events or len(events) > 500:
            raise ReadingStatsRequestError("events must contain 1 to 500 event objects")
        # Validate the entire batch even while collection is disabled. This keeps
        # the versioned API contract predictable and prevents malformed offline
        # outbox entries from appearing to have synced successfully.
        for event in events:
            if not isinstance(event, dict):
                raise ReadingStatsRequestError("Each reading event must be an object")
            self._validate_token(event.get("eventId"), "eventId")
            event_type = event.get("type")
            if event_type not in self.EVENT_TYPES:
                raise ReadingStatsRequestError("Unsupported reading event type")
            occurred = self._parse_timestamp(event.get("occurredAt"))
            if occurred > self._utc_now() + timedelta(hours=24):
                raise ReadingStatsRequestError("occurredAt cannot be more than 24 hours in the future")
            self._validate_identity(event.get("titleKey"), "titleKey")
            if event_type == "active_minute":
                self._active_seconds(event)
                if event.get("minuteKey") is not None or event.get("minute") is not None:
                    self._parse_timestamp(event.get("minuteKey") or event.get("minute"), "minuteKey")
            elif event_type == "page_view":
                self._validate_identity(event.get("chapterKey"), "chapterKey")
                self._page_identity(event)
            elif event_type == "chapter_finish":
                self._validate_identity(event.get("chapterKey"), "chapterKey")
                if event.get("attemptId") is not None:
                    self._validate_identity(event.get("attemptId"), "attemptId")
        accepted = 0
        duplicate = 0
        acknowledged = [event["eventId"] for event in events]
        now = self._utc_now()
        with READING_STATS_LOCK, self._database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            profile = connection.execute("SELECT * FROM stats_profile WHERE id=1").fetchone()
            if not profile["enabled"]:
                connection.rollback()
                return {"schemaVersion": 1, "accepted": 0, "duplicate": 0, "duplicates": 0, "disabled": True, "acknowledgedEventIds": [], "newAchievements": [], "newlyUnlocked": []}
            if not profile["prospective_since"]:
                connection.execute(
                    "UPDATE stats_profile SET prospective_since=?, updated_at=? WHERE id=1",
                    (self._iso(now), self._iso(now)),
                )
            before = {row[0] for row in connection.execute("SELECT achievement_id FROM achievements")}
            for event in events:
                if not isinstance(event, dict):
                    raise ReadingStatsRequestError("Each reading event must be an object")
                event_id = self._validate_token(event.get("eventId"), "eventId")
                stored_event_id = self._hash(connection, "event", event_id)
                event_type = event.get("type")
                if event_type not in self.EVENT_TYPES:
                    raise ReadingStatsRequestError("Unsupported reading event type")
                occurred = self._parse_timestamp(event.get("occurredAt"))
                occurred_iso = self._iso(occurred)
                inserted = connection.execute(
                    "INSERT OR IGNORE INTO ingested_events(event_id,event_type,occurred_at,ingested_at) VALUES (?,?,?,?)",
                    (stored_event_id, event_type, occurred_iso, self._iso(now)),
                ).rowcount
                if not inserted:
                    duplicate += 1
                    continue
                title_key = self._validate_identity(event.get("titleKey"), "titleKey")
                title_hash = self._hash(connection, "title", title_key)
                changed = True
                if event_type == "active_minute":
                    seconds = self._active_seconds(event)
                    bucket_time = self._parse_timestamp(
                        event.get("minuteKey") or event.get("minute") or occurred_iso,
                        "minuteKey",
                    )
                    minute = bucket_time.replace(second=0)
                    minute_iso = self._iso(minute)
                    existing = connection.execute(
                        "SELECT seconds FROM activity_minutes WHERE minute_utc=?", (minute_iso,)
                    ).fetchone()
                    available = 60 - (existing["seconds"] if existing else 0)
                    credited = min(seconds, max(0, available))
                    if existing:
                        connection.execute(
                            "UPDATE activity_minutes SET seconds=seconds+?, last_event_at=? WHERE minute_utc=?",
                            (credited, occurred_iso, minute_iso),
                        )
                    else:
                        connection.execute(
                            "INSERT INTO activity_minutes(minute_utc,seconds,last_event_at) VALUES (?,?,?)",
                            (minute_iso, credited, occurred_iso),
                        )
                    if credited:
                        connection.execute(
                            """INSERT INTO activity_minute_titles(minute_utc,title_hash,seconds) VALUES (?,?,?)
                            ON CONFLICT(minute_utc,title_hash) DO UPDATE SET seconds=seconds+excluded.seconds""",
                            (minute_iso, title_hash, credited),
                        )
                elif event_type == "page_view":
                    chapter = self._validate_identity(event.get("chapterKey"), "chapterKey")
                    page = self._page_identity(event)
                    connection.execute(
                        "INSERT INTO page_views(event_id,title_hash,chapter_hash,page_hash,occurred_at) VALUES (?,?,?,?,?)",
                        (stored_event_id, title_hash, self._hash(connection, "chapter", chapter), self._hash(connection, "page", page), occurred_iso),
                    )
                elif event_type == "chapter_finish":
                    chapter = self._validate_identity(event.get("chapterKey"), "chapterKey")
                    attempt = event.get("attemptId") or f"first:{chapter}"
                    attempt = self._validate_identity(attempt, "attemptId")
                    changed = bool(connection.execute(
                        "INSERT OR IGNORE INTO chapter_finishes(event_id,title_hash,chapter_hash,attempt_hash,occurred_at) VALUES (?,?,?,?,?)",
                        (stored_event_id, title_hash, self._hash(connection, "chapter", chapter), self._hash(connection, "attempt", attempt), occurred_iso),
                    ).rowcount)
                else:
                    changed = bool(connection.execute(
                        "INSERT OR IGNORE INTO title_completions(event_id,title_hash,occurred_at) VALUES (?,?,?)",
                        (stored_event_id, title_hash, occurred_iso),
                    ).rowcount)
                if changed:
                    accepted += 1
                else:
                    duplicate += 1
            self._refresh_achievements(connection, profile)
            after_rows = connection.execute("SELECT achievement_id, unlocked_at FROM achievements").fetchall()
            connection.commit()
        new_achievements = [
            {"id": row["achievement_id"], "unlockedAt": row["unlocked_at"]}
            for row in after_rows if row["achievement_id"] not in before
        ]
        return {
            "schemaVersion": self.SCHEMA_VERSION,
            "accepted": accepted,
            "duplicate": duplicate,
            "duplicates": duplicate,
            "disabled": False,
            "acknowledgedEventIds": acknowledged,
            "newAchievements": new_achievements,
            "newlyUnlocked": new_achievements,
        }

    @staticmethod
    def _reading_date(timestamp, timezone_name, day_start_hour):
        instant = ReadingStatsStore._parse_timestamp(timestamp, "stored timestamp")
        local = instant.astimezone(ZoneInfo(timezone_name)) - timedelta(hours=day_start_hour)
        return local.date().isoformat()

    def _all_rows(self, connection):
        return {
            "activity": connection.execute(
                "SELECT minute_utc, seconds, last_event_at FROM activity_minutes ORDER BY minute_utc"
            ).fetchall(),
            "activityTitles": connection.execute(
                "SELECT minute_utc, title_hash, seconds FROM activity_minute_titles ORDER BY minute_utc"
            ).fetchall(),
            "pages": connection.execute("SELECT * FROM page_views ORDER BY occurred_at,event_id").fetchall(),
            "finishes": connection.execute("SELECT * FROM chapter_finishes ORDER BY occurred_at,event_id").fetchall(),
            "completions": connection.execute("SELECT * FROM title_completions ORDER BY occurred_at,event_id").fetchall(),
        }

    def _aggregate(self, rows, settings, first_day=None, last_day=None):
        timezone_name = settings["timezone"]
        boundary = settings["dayStartHour"]
        days = {}
        titles = {}

        def day_for(timestamp):
            return self._reading_date(timestamp, timezone_name, boundary)

        def included(day):
            return (first_day is None or day >= first_day) and (last_day is None or day <= last_day)

        def bucket(day):
            return days.setdefault(day, {"date": day, "activeSeconds": 0, "pages": 0, "chapterFinishes": 0, "completedTitles": 0})

        for row in rows["activity"]:
            day = day_for(row["minute_utc"])
            if included(day):
                bucket(day)["activeSeconds"] += row["seconds"]
        for row in rows["activityTitles"]:
            day = day_for(row["minute_utc"])
            if included(day):
                titles[row["title_hash"]] = titles.get(row["title_hash"], 0) + row["seconds"]
        for row in rows["pages"]:
            day = day_for(row["occurred_at"])
            if included(day):
                bucket(day)["pages"] += 1
        finishes = []
        for row in rows["finishes"]:
            day = day_for(row["occurred_at"])
            if included(day):
                bucket(day)["chapterFinishes"] += 1
                finishes.append(row)
                titles.setdefault(row["title_hash"], 0)
        completions = []
        for row in rows["completions"]:
            day = day_for(row["occurred_at"])
            if included(day):
                bucket(day)["completedTitles"] += 1
                completions.append(row)
                titles.setdefault(row["title_hash"], 0)
        day_list = [days[key] for key in sorted(days)]
        for day in day_list:
            day["readingDay"] = day["activeSeconds"] >= 120 or day["chapterFinishes"] >= 1
        reading_days = [day for day in day_list if day["readingDay"]]
        unique_chapters = {(row["title_hash"], row["chapter_hash"]) for row in finishes}
        explored = {key for key, seconds in titles.items() if seconds >= 60}
        explored.update(row["title_hash"] for row in finishes)
        explored.update(row["title_hash"] for row in completions)
        totals = {
            "pages": sum(day["pages"] for day in day_list),
            "activeSeconds": sum(day["activeSeconds"] for day in day_list),
            "chapterFinishes": len(finishes),
            "uniqueChapters": len(unique_chapters),
            "rereads": max(0, len(finishes) - len(unique_chapters)),
            "completedTitles": len({row["title_hash"] for row in completions}),
            "readingDays": len(reading_days),
            "titlesExplored": len(explored),
        }
        return {"totals": totals, "days": day_list, "readingDayDates": [day["date"] for day in reading_days]}

    @staticmethod
    def _rhythm(reading_dates, today):
        dates = sorted(datetime.fromisoformat(day).date() for day in set(reading_dates))
        longest = 0
        run = 0
        previous = None
        for day in dates:
            run = run + 1 if previous and day == previous + timedelta(days=1) else 1
            longest = max(longest, run)
            previous = day
        active_end = today if today in dates else today - timedelta(days=1)
        current = 0
        cursor = active_end
        date_set = set(dates)
        while cursor in date_set:
            current += 1
            cursor -= timedelta(days=1)
        return {"currentDays": current, "longestDays": longest, "through": active_end.isoformat() if current else None}

    def _achievement_candidates(self, rows, settings):
        all_data = self._aggregate(rows, settings)
        candidates = {}
        finishes = list(rows["finishes"])
        chapter_targets = {
            1: "first-finish",
            10: "ten-finishes",
            25: "twenty-five-finishes",
            50: "fifty-finishes",
            100: "hundred-finishes",
            250: "two-fifty-finishes",
        }
        unique_seen = set()
        reread_count = 0
        reread_targets = {1: "first-reread", 5: "five-rereads", 25: "twenty-five-rereads"}
        for row in finishes:
            key = (row["title_hash"], row["chapter_hash"])
            if key in unique_seen:
                reread_count += 1
                achievement_id = reread_targets.get(reread_count)
                if achievement_id:
                    candidates[achievement_id] = row["occurred_at"]
                continue
            unique_seen.add(key)
            achievement_id = chapter_targets.get(len(unique_seen))
            if achievement_id:
                candidates[achievement_id] = row["occurred_at"]

        page_targets = {
            100: "hundred-pages",
            500: "five-hundred-pages",
            1_000: "thousand-pages",
            5_000: "five-thousand-pages",
        }
        for count, row in enumerate(rows["pages"], start=1):
            achievement_id = page_targets.get(count)
            if achievement_id:
                candidates[achievement_id] = row["occurred_at"]

        reading_seconds = 0
        time_targets = {
            3_600: "one-reading-hour",
            36_000: "ten-reading-hours",
            180_000: "fifty-reading-hours",
            360_000: "hundred-reading-hours",
        }
        remaining_time_targets = dict(time_targets)
        for row in rows["activity"]:
            reading_seconds += row["seconds"]
            for threshold, achievement_id in list(remaining_time_targets.items()):
                if reading_seconds >= threshold:
                    candidates[achievement_id] = row["minute_utc"]
                    remaining_time_targets.pop(threshold)

        title_qualified_at = {}
        title_active_seconds = {}
        for row in rows["activityTitles"]:
            title_hash = row["title_hash"]
            title_active_seconds[title_hash] = title_active_seconds.get(title_hash, 0) + row["seconds"]
            if title_active_seconds[title_hash] >= 60 and title_hash not in title_qualified_at:
                title_qualified_at[title_hash] = row["minute_utc"]
        for collection in (finishes, rows["completions"]):
            for row in collection:
                title_hash = row["title_hash"]
                title_qualified_at[title_hash] = min(
                    title_qualified_at.get(title_hash, row["occurred_at"]),
                    row["occurred_at"],
                )
        qualified_times = sorted(title_qualified_at.values())
        for target, achievement_id in (
            (3, "three-titles"),
            (10, "ten-titles"),
            (25, "twenty-five-titles"),
        ):
            if len(qualified_times) >= target:
                candidates[achievement_id] = qualified_times[target - 1]

        completions = list(rows["completions"])
        for target, achievement_id in (
            (1, "first-title-complete"),
            (5, "five-titles-complete"),
            (10, "ten-titles-complete"),
        ):
            if len(completions) >= target:
                candidates[achievement_id] = completions[target - 1]["occurred_at"]

        reading_dates = sorted(all_data["readingDayDates"])
        for target, achievement_id in (
            (7, "seven-reading-days"),
            (30, "thirty-reading-days"),
            (100, "hundred-reading-days"),
        ):
            if len(reading_dates) >= target:
                candidates[achievement_id] = f"{reading_dates[target - 1]}T23:59:59Z"
        date_values = [datetime.fromisoformat(day).date() for day in reading_dates]
        for target, achievement_id in (
            (3, "three-day-rhythm"),
            (7, "seven-day-rhythm"),
            (14, "fourteen-day-rhythm"),
            (30, "thirty-day-rhythm"),
        ):
            run = 0
            previous = None
            for day in date_values:
                run = run + 1 if previous and day == previous + timedelta(days=1) else 1
                if run >= target:
                    candidates[achievement_id] = f"{day.isoformat()}T23:59:59Z"
                    break
                previous = day

        for day in all_data["days"]:
            unlocked_at = f"{day['date']}T23:59:59Z"
            if day["chapterFinishes"] >= 10 and "ten-chapter-day" not in candidates:
                candidates["ten-chapter-day"] = unlocked_at
            if day["pages"] >= 100 and "hundred-page-day" not in candidates:
                candidates["hundred-page-day"] = unlocked_at
            if day["activeSeconds"] >= 7_200 and "two-hour-day" not in candidates:
                candidates["two-hour-day"] = unlocked_at
        return candidates

    def _refresh_achievements(self, connection, profile=None):
        profile = profile or connection.execute("SELECT * FROM stats_profile WHERE id=1").fetchone()
        settings = self._settings_from_row(profile)
        candidates = self._achievement_candidates(self._all_rows(connection), settings)
        for achievement_id, unlocked_at in candidates.items():
            connection.execute(
                """INSERT INTO achievements(achievement_id,unlocked_at) VALUES (?,?)
                ON CONFLICT(achievement_id) DO UPDATE SET unlocked_at=MIN(unlocked_at,excluded.unlocked_at)""",
                (achievement_id, unlocked_at),
            )

    def summary(self, range_name, now=None):
        if range_name not in self.RANGE_DAYS:
            raise ReadingStatsRequestError("range must be one of 7d, 30d, 365d, or all")
        now = now or self._utc_now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        with READING_STATS_LOCK, self._database() as connection:
            profile = connection.execute("SELECT * FROM stats_profile WHERE id=1").fetchone()
            settings = self._settings_from_row(profile)
            rows = self._all_rows(connection)
            self._refresh_achievements(connection, profile)
            achievement_rows = connection.execute("SELECT * FROM achievements ORDER BY unlocked_at,achievement_id").fetchall()
        local_today = (now.astimezone(ZoneInfo(settings["timezone"])) - timedelta(hours=settings["dayStartHour"])).date()
        length = self.RANGE_DAYS[range_name]
        first_day = (local_today - timedelta(days=length - 1)).isoformat() if length else None
        current = self._aggregate(rows, settings, first_day, local_today.isoformat())
        previous = None
        if length:
            previous_last = local_today - timedelta(days=length)
            previous_first = previous_last - timedelta(days=length - 1)
            previous = self._aggregate(rows, settings, previous_first.isoformat(), previous_last.isoformat())["totals"]
        all_through_today = self._aggregate(rows, settings, last_day=local_today.isoformat())
        rhythm_all = self._rhythm(all_through_today["readingDayDates"], local_today)
        definitions = {item[0]: item[1:] for item in self.ACHIEVEMENTS}
        achievements = [
            {"id": row["achievement_id"], "name": definitions[row["achievement_id"]][0], "title": definitions[row["achievement_id"]][0],
             "description": definitions[row["achievement_id"]][1], "unlockedAt": row["unlocked_at"]}
            for row in achievement_rows if row["achievement_id"] in definitions
        ]
        return {
            "schemaVersion": self.SCHEMA_VERSION,
            "range": range_name,
            "generatedAt": self._iso(now),
            "prospectiveSince": profile["prospective_since"],
            "since": profile["prospective_since"],
            "settings": settings,
            **current["totals"],
            "totals": current["totals"],
            "calendar": current["days"],
            "trend": current["days"],
            "trendComparison": {"current": current["totals"], "previous": previous},
            "rhythm": {
                **rhythm_all,
                "current": rhythm_all["currentDays"],
                "longest": rhythm_all["longestDays"],
                "currentRhythm": rhythm_all["currentDays"],
                "longestRhythm": rhythm_all["longestDays"],
            },
            "currentRhythm": rhythm_all["currentDays"],
            "longestRhythm": rhythm_all["longestDays"],
            "achievements": achievements,
            "privacy": {"storage": "self-hosted", "thirdPartyTelemetry": False, "identifiers": "opaque-hmac-sha256"},
        }

    def export_data(self):
        with READING_STATS_LOCK, self._database() as connection:
            profile = connection.execute("SELECT * FROM stats_profile WHERE id=1").fetchone()
            tables = {}
            for table in ("activity_minutes", "activity_minute_titles", "page_views", "chapter_finishes", "title_completions", "achievements"):
                tables[table] = [dict(row) for row in connection.execute(f"SELECT * FROM {table}").fetchall()]
        return {
            "schemaVersion": self.SCHEMA_VERSION,
            "exportedAt": self._iso(self._utc_now()),
            "prospectiveSince": profile["prospective_since"],
            "settings": self._settings_from_row(profile),
            "data": tables,
            "notice": "Identifiers are opaque hashes. Panels does not store title names, covers, URLs, or IP addresses in reading stats.",
        }

    def reset(self, confirm, scope="all"):
        if confirm != "ERASE":
            raise ReadingStatsRequestError("Reset requires confirm to equal ERASE")
        if scope not in {"all", "activity", "achievements"}:
            raise ReadingStatsRequestError("scope must be all, activity, or achievements")
        with READING_STATS_LOCK, self._database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if scope in {"all", "activity"}:
                for table in ("activity_minute_titles", "activity_minutes", "page_views", "chapter_finishes", "title_completions", "ingested_events", "achievements"):
                    connection.execute(f"DELETE FROM {table}")
                if scope == "all":
                    now = self._iso(self._utc_now())
                    connection.execute(
                        "UPDATE stats_profile SET enabled=0, prospective_since=NULL, updated_at=? WHERE id=1",
                        (now,),
                    )
            else:
                connection.execute("DELETE FROM achievements")
            connection.commit()
        return {"schemaVersion": self.SCHEMA_VERSION, "erased": True, "reset": True, "scope": scope}


def read_mangabaka_token(path=MANGABAKA_CONFIG_PATH, allow_environment=True):
    configured = os.environ.get("MANGABAKA_API_KEY", "").strip() if allow_environment else ""
    if configured:
        return configured
    try:
        with MANGABAKA_LOCK, open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return str(payload.get("token") or "").strip()
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return ""


def write_mangabaka_token(token, path=MANGABAKA_CONFIG_PATH):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    with MANGABAKA_LOCK:
        if not token:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            return
        temporary_path = ""
        try:
            with tempfile.NamedTemporaryFile("w", dir=directory, delete=False, encoding="utf-8") as handle:
                temporary_path = handle.name
                json.dump({"token": token}, handle)
                handle.write("\n")
            try:
                os.chmod(temporary_path, 0o600)
            except OSError:
                pass
            os.replace(temporary_path, path)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)


def read_comic_recommendations_config():
    environment_key = os.environ.get("PANEL_PILOT_LIBRARYTHING_API_KEY", "").strip()
    environment_contact = os.environ.get("PANEL_PILOT_OPEN_LIBRARY_CONTACT", "").replace("\r", "").replace("\n", "").strip()[:200]
    if environment_key:
        return {"apiKey": environment_key, "contact": environment_contact, "managedByEnvironment": True}
    try:
        with COMIC_RECOMMENDATIONS_CONFIG_LOCK, open(COMIC_RECOMMENDATIONS_CONFIG_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return {
            "apiKey": str(payload.get("apiKey") or "").strip(),
            "contact": str(payload.get("contact") or "").replace("\r", "").replace("\n", "").strip()[:200],
            "managedByEnvironment": False,
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        return {"apiKey": "", "contact": environment_contact, "managedByEnvironment": False}


def write_comic_recommendations_config(api_key, contact=""):
    directory = os.path.dirname(COMIC_RECOMMENDATIONS_CONFIG_PATH) or "."
    os.makedirs(directory, exist_ok=True)
    with COMIC_RECOMMENDATIONS_CONFIG_LOCK:
        if not api_key:
            try:
                os.unlink(COMIC_RECOMMENDATIONS_CONFIG_PATH)
            except FileNotFoundError:
                pass
            return
        temporary_path = ""
        try:
            with tempfile.NamedTemporaryFile("w", dir=directory, delete=False, encoding="utf-8") as handle:
                temporary_path = handle.name
                json.dump({"apiKey": api_key, "contact": contact}, handle, ensure_ascii=True, separators=(",", ":"))
                handle.write("\n")
            try:
                os.chmod(temporary_path, 0o600)
            except OSError:
                pass
            os.replace(temporary_path, COMIC_RECOMMENDATIONS_CONFIG_PATH)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)


def fetch_url(url, accept="*/*", referer="https://comick.live/"):
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
            "Referer": referer,
        },
    )
    with open_url(request, timeout=30) as response:
        return response.status, response.headers, response.read()


def comick_slug_from_url(raw_url):
    parsed = urlparse(raw_url)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "comic":
        return parts[1]
    if len(parts) == 1:
        return parts[0]
    raise ValueError("Expected a Comick comic URL or slug")


def safe_comick_page_url(raw_url):
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http/https URLs are supported")
    if parsed.netloc not in ("comick.live", "www.comick.live"):
        raise ValueError("Only comick.live chapter URLs are supported")
    return raw_url


def safe_image_url(raw_url):
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https":
        raise ValueError("Only https image URLs are supported")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Image URLs must not contain embedded credentials")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Image URLs must use a valid HTTPS port") from error
    if port not in (None, 443):
        raise ValueError("Image URLs must use the standard HTTPS port")
    if not any(host_matches_domain(host, domain) for domain in IMAGE_CDN_DOMAINS):
        raise ValueError("Unsupported image CDN")
    return raw_url


def safe_readcomiconline_url(raw_url):
    parsed = urlparse(raw_url)
    host = parsed.netloc.lower()
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http/https URLs are supported")
    if host not in ("rcostation.xyz", "www.rcostation.xyz"):
        raise ValueError("Only ReadComicOnline chapter URLs are supported")
    if not parsed.path.startswith("/Comic/"):
        raise ValueError("Expected a ReadComicOnline chapter URL")
    return raw_url


def unique(values):
    seen = set()
    output = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def readcomiconline_step1(value):
    return value[15:33] + value[50:]


def readcomiconline_step2(value):
    return value[:-11] + value[-2:]


def decode_readcomiconline_path(raw_path, replacements=None):
    value = raw_path
    for pattern, replacement in replacements or []:
        value = value.replace(pattern, replacement)
    value = value.replace("pw_.g28x", "b").replace("d2pr.x_27", "h")
    query_index = value.find("?")
    query = value[query_index:] if query_index >= 0 else ""

    if "=s0?" in value:
        encoded = value[: value.find("=s0?")]
        suffix = "=s0"
    elif "=s1600?" in value:
        encoded = value[: value.find("=s1600?")]
        suffix = "=s1600"
    else:
        encoded = value[:query_index] if query_index >= 0 else value
        suffix = "=s1600"

    core = readcomiconline_step2(readcomiconline_step1(encoded))
    core += "=" * (-len(core) % 4)
    decoded = base64.b64decode(core).decode("utf-8", errors="replace")
    decoded = decoded[:13] + decoded[17:]
    return f"https://2.bp.blogspot.com/{decoded[:-2]}{suffix}{query}"


def detect_panel_image(image_bytes, content_type="application/octet-stream", mode="manga"):
    detector_base = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_URL", "").strip().rstrip("/")
    if not detector_base:
        raise RuntimeError("Panel model service is not configured")
    if mode not in ("manga", "comic"):
        raise ValueError("Unsupported panel detector mode")
    cache_version = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_CACHE_VERSION", "v1")
    cache_key = hashlib.sha256(cache_version.encode("utf-8") + b"\0" + mode.encode("ascii") + b"\0" + image_bytes).hexdigest()
    cache_dir = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_CACHE_PATH", "/app/data/detector-cache")
    cache_path = os.path.join(cache_dir, f"{cache_key}.json")
    try:
        with open(cache_path, "rb") as handle:
            return handle.read(), "hit", 200
    except FileNotFoundError:
        pass
    request = Request(
        f"{detector_base}/v1/{mode}/panels",
        data=image_bytes,
        headers={"Content-Type": content_type, "Accept": "application/json"},
        method="POST",
    )
    with open_url(request, timeout=30) as response:
        payload = response.read()
        status = response.status
    if status == 200:
        os.makedirs(cache_dir, exist_ok=True)
        with DETECTOR_CACHE_LOCK:
            temporary_path = ""
            try:
                with tempfile.NamedTemporaryFile(dir=cache_dir, delete=False) as handle:
                    temporary_path = handle.name
                    handle.write(payload)
                os.replace(temporary_path, cache_path)
            finally:
                if temporary_path and os.path.exists(temporary_path):
                    os.unlink(temporary_path)
    return payload, "miss", status


def detect_manga_image(image_bytes, content_type="application/octet-stream"):
    return detect_panel_image(image_bytes, content_type, "manga")


class DownloadBufferManager:
    INTER_CHAPTER_DELAY = 90
    RETRY_BASE_DELAY = 3 * 60
    RETRY_MAX_DELAY = 6 * 60 * 60
    MAX_ATTEMPTS = 6
    RETENTION_SCHEMA_VERSION = 1
    RETENTION_PURPOSES = {"reading-ahead", "plan-to-read", "source-test"}
    RETENTION_SCOPE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    DEFAULT_RETENTION_POLICY = {
        "readRetentionDays": 30,
        "keepRecentCount": 2,
        "sourceTestRetentionDays": 1,
    }

    def __init__(self, path=DOWNLOAD_BUFFER_PATH):
        self.path = path
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.failures = []
        self.prepared_chapters = set()
        self.requested_chapter_ids = []
        self.retention_ledger = []
        self.retention_policy = dict(self.DEFAULT_RETENTION_POLICY)
        self.last_retention_cleanup_at = None
        self.tasks = self.load_tasks()
        self.active_chapter_id = None
        self.thread = threading.Thread(target=self.run, name="panel-pilot-download-buffer", daemon=True)

    def start(self):
        self.thread.start()

    def load_tasks(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []
        detector_version = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_CACHE_VERSION", "v1")
        if payload.get("preparedVersion") == detector_version:
            self.prepared_chapters = {
                int(value) for value in payload.get("preparedChapters", []) if str(value).isdigit()
            }
        self.requested_chapter_ids = [
            int(value) for value in payload.get("requestedChapterIds", [])[:25] if str(value).isdigit()
        ]
        retention = payload.get("retention") if isinstance(payload.get("retention"), dict) else {}
        try:
            self.retention_policy = self.normalize_retention_policy(retention.get("policy"))
        except ValueError:
            self.retention_policy = dict(self.DEFAULT_RETENTION_POLICY)
        self.last_retention_cleanup_at = self.normalize_retention_iso(retention.get("lastCleanupAt"))
        self.retention_ledger = []
        for item in retention.get("ledger", [])[:5000] if isinstance(retention.get("ledger"), list) else []:
            if not isinstance(item, dict):
                continue
            try:
                chapter_id = int(item.get("chapterId"))
            except (TypeError, ValueError):
                continue
            if chapter_id < 1:
                continue
            raw_scope_id = item.get("scopeId")
            scope_id = str(raw_scope_id).strip() if raw_scope_id is not None else ""
            if not self.RETENTION_SCOPE_PATTERN.fullmatch(scope_id):
                scope_id = ""
            entry = {
                "schemaVersion": item.get("schemaVersion"),
                "managedBy": str(item.get("managedBy") or "")[:20],
                "chapterId": chapter_id,
                "scopeId": scope_id,
                "purpose": str(item.get("purpose") or "")[:30],
                "managedAt": self.normalize_retention_iso(item.get("managedAt")),
            }
            read_at = self.normalize_retention_iso(item.get("readAt"))
            if read_at:
                entry["readAt"] = read_at
            self.retention_ledger.append(entry)
        tasks = []
        seen = set()
        for item in payload.get("tasks", []):
            try:
                chapter_id = int(item.get("chapterId"))
            except (TypeError, ValueError):
                continue
            if chapter_id < 1 or chapter_id in seen:
                continue
            seen.add(chapter_id)
            tasks.append({
                "chapterId": chapter_id,
                "attempts": max(0, int(item.get("attempts") or 0)),
                "notBefore": max(0, float(item.get("notBefore") or 0)),
                "lastError": str(item.get("lastError") or "")[:500],
            })
        self.failures = [
            {
                "chapterId": int(item.get("chapterId")),
                "attempts": max(0, int(item.get("attempts") or 0)),
                "lastError": str(item.get("lastError") or "")[:500],
                "failedAt": max(0, float(item.get("failedAt") or 0)),
            }
            for item in payload.get("failures", [])[-100:]
            if isinstance(item, dict) and str(item.get("chapterId", "")).isdigit()
        ]
        return tasks

    def save_locked(self):
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        temporary_path = ""
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as handle:
                temporary_path = handle.name
                json.dump({
                    "format": 3,
                    "tasks": self.tasks,
                    "failures": self.failures[-100:],
                    "preparedVersion": os.environ.get("PANEL_PILOT_MANGA_DETECTOR_CACHE_VERSION", "v1"),
                    "preparedChapters": sorted(self.prepared_chapters)[-1000:],
                    "requestedChapterIds": self.requested_chapter_ids,
                    "retention": {
                        "schemaVersion": self.RETENTION_SCHEMA_VERSION,
                        "policy": self.retention_policy,
                        "ledger": self.retention_ledger[-5000:],
                        **({"lastCleanupAt": self.last_retention_cleanup_at} if self.last_retention_cleanup_at else {}),
                    },
                }, handle, separators=(",", ":"))
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)

    @classmethod
    def normalize_retention_iso(cls, value):
        if value in (None, ""):
            return None
        try:
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                parsed = datetime.fromtimestamp(float(value), timezone.utc)
            else:
                parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                parsed = parsed.astimezone(timezone.utc)
        except (OverflowError, TypeError, ValueError):
            return None
        return parsed.isoformat().replace("+00:00", "Z")

    @classmethod
    def retention_timestamp(cls, value):
        normalized = cls.normalize_retention_iso(value)
        if not normalized:
            return None
        return datetime.fromisoformat(normalized.replace("Z", "+00:00")).timestamp()

    @staticmethod
    def retention_iso_now(now=None):
        value = time.time() if now is None else float(now)
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")

    @classmethod
    def normalize_retention_policy(cls, policy=None, base=None):
        if policy is None:
            return dict(base or cls.DEFAULT_RETENTION_POLICY)
        if not isinstance(policy, dict):
            raise ValueError("retentionPolicy must be an object")
        normalized = dict(base or cls.DEFAULT_RETENTION_POLICY)
        for key in ("readRetentionDays", "sourceTestRetentionDays"):
            if key not in policy:
                continue
            value = policy[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or value > 36500:
                raise ValueError(f"retentionPolicy.{key} must be a number from 0 to 36500")
            normalized[key] = value
        if "keepRecentCount" in policy:
            value = policy["keepRecentCount"]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 10000:
                raise ValueError("retentionPolicy.keepRecentCount must be an integer from 0 to 10000")
            normalized["keepRecentCount"] = value
        return normalized

    @classmethod
    def normalize_enqueue_retention(cls, purpose=None, scope_id=None):
        if purpose is None and scope_id is None:
            return None
        if purpose not in cls.RETENTION_PURPOSES:
            raise ValueError("purpose must be reading-ahead, plan-to-read, or source-test")
        normalized_scope_id = str(scope_id or "").strip()
        if not cls.RETENTION_SCOPE_PATTERN.fullmatch(normalized_scope_id):
            raise ValueError("scopeId must be a privacy-safe opaque identifier")
        return {"purpose": purpose, "scopeId": normalized_scope_id}

    @staticmethod
    def normalize_retention_chapter_ids(chapter_ids, limit=100):
        normalized = []
        for raw_id in chapter_ids[:limit] if isinstance(chapter_ids, list) else []:
            if isinstance(raw_id, bool):
                continue
            if isinstance(raw_id, int):
                chapter_id = raw_id
            elif isinstance(raw_id, str) and raw_id.isdigit():
                chapter_id = int(raw_id)
            else:
                continue
            if chapter_id > 0 and chapter_id not in normalized:
                normalized.append(chapter_id)
        return normalized

    def record_retention_enqueue_locked(self, chapter_ids, metadata, now=None):
        if not metadata or not chapter_ids:
            return
        managed_at = self.retention_iso_now(now)
        for chapter_id in chapter_ids:
            matching = [item for item in self.retention_ledger if item.get("chapterId") == chapter_id]
            if not matching:
                self.retention_ledger.append({
                    "schemaVersion": self.RETENTION_SCHEMA_VERSION,
                    "managedBy": "panels",
                    "chapterId": chapter_id,
                    "scopeId": metadata["scopeId"],
                    "purpose": metadata["purpose"],
                    "managedAt": managed_at,
                })
            elif len(matching) == 1 and matching[0].get("schemaVersion") == self.RETENTION_SCHEMA_VERSION and matching[0].get("managedBy") == "panels":
                matching[0].update({
                    "scopeId": metadata["scopeId"],
                    "purpose": metadata["purpose"],
                    "managedAt": managed_at,
                })
                matching[0].pop("readAt", None)

    def enqueue(self, chapter_ids, priority="foreground", purpose=None, scope_id=None):
        if priority not in ("foreground", "background"):
            raise ValueError("Download buffer priority must be foreground or background")
        retention_metadata = self.normalize_enqueue_retention(purpose, scope_id)
        added = 0
        added_chapter_ids = []
        candidates = []
        for raw_id in chapter_ids[:25]:
            try:
                chapter_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if chapter_id > 0 and chapter_id not in candidates:
                candidates.append(chapter_id)
        requested = self.library_chapter_ids(candidates)
        rejected = len(candidates) - len(requested)
        with self.lock:
            window_changed = priority == "foreground" and requested != self.requested_chapter_ids
            if priority == "foreground":
                self.requested_chapter_ids = requested
            before_order = [item["chapterId"] for item in self.tasks]
            existing = {item["chapterId"] for item in self.tasks}
            if self.active_chapter_id:
                existing.add(self.active_chapter_id)
            for chapter_id in requested:
                if chapter_id < 1 or chapter_id in existing:
                    continue
                if chapter_id in self.prepared_chapters:
                    continue
                self.failures = [item for item in self.failures if item["chapterId"] != chapter_id]
                self.tasks.append({"chapterId": chapter_id, "attempts": 0, "notBefore": 0, "lastError": ""})
                existing.add(chapter_id)
                added += 1
                added_chapter_ids.append(chapter_id)
            if priority == "foreground":
                requested_set = set(requested)
                available = {item["chapterId"] for item in self.tasks}
                preferred = [
                    next(item for item in self.tasks if item["chapterId"] == chapter_id)
                    for chapter_id in requested
                    if chapter_id in available
                ]
                self.tasks = preferred + [item for item in self.tasks if item["chapterId"] not in requested_set]
            order_changed = before_order != [item["chapterId"] for item in self.tasks]
            self.record_retention_enqueue_locked(added_chapter_ids, retention_metadata)
            if added or window_changed or order_changed:
                self.save_locked()
        self.wake.set()
        return {**self.status(), "added": added, "rejected": rejected}

    def retention_preview_locked(self, active_reader_chapter_ids=None, now=None):
        now_value = time.time() if now is None else float(now)
        active_ids = set(self.normalize_retention_chapter_ids(active_reader_chapter_ids or []))
        if self.active_chapter_id:
            active_ids.add(self.active_chapter_id)
        by_chapter = {}
        for entry in self.retention_ledger:
            chapter_id = entry.get("chapterId")
            if isinstance(chapter_id, int) and chapter_id > 0:
                by_chapter.setdefault(chapter_id, []).append(entry)

        decisions = []
        read_candidates = []
        for chapter_id, entries in by_chapter.items():
            reason = None
            candidate = None
            if chapter_id in active_ids:
                reason = "active-reader"
            elif len(entries) != 1:
                reason = "ambiguous-ledger"
            else:
                entry = entries[0]
                if entry.get("schemaVersion") != self.RETENTION_SCHEMA_VERSION:
                    reason = "legacy-ledger"
                elif entry.get("managedBy") != "panels":
                    reason = "unmanaged-download"
                elif entry.get("purpose") not in self.RETENTION_PURPOSES or not self.RETENTION_SCOPE_PATTERN.fullmatch(str(entry.get("scopeId") or "")):
                    reason = "invalid-ledger"
                elif entry["purpose"] == "source-test":
                    managed_at = self.retention_timestamp(entry.get("managedAt"))
                    if managed_at is None:
                        reason = "missing-timestamp"
                    elif now_value - managed_at < self.retention_policy["sourceTestRetentionDays"] * 86400:
                        reason = "source-test-retention"
                    else:
                        candidate = {
                            "chapterId": chapter_id,
                            "reason": "source-test-expired",
                            "purpose": entry["purpose"],
                            "scopeId": entry["scopeId"],
                            "effectiveAt": managed_at,
                        }
                else:
                    read_at = self.retention_timestamp(entry.get("readAt"))
                    if read_at is None:
                        reason = "unread"
                    elif now_value - read_at < self.retention_policy["readRetentionDays"] * 86400:
                        reason = "read-retention"
                    else:
                        candidate = {
                            "chapterId": chapter_id,
                            "reason": "read-retention-expired",
                            "purpose": entry["purpose"],
                            "scopeId": entry["scopeId"],
                            "effectiveAt": read_at,
                        }
                        read_candidates.append(candidate)
            if candidate:
                decisions.append(candidate)
            else:
                decisions.append({"chapterId": chapter_id, "reason": reason or "invalid-ledger", "protected": True})

        candidates_by_scope = {}
        for candidate in read_candidates:
            candidates_by_scope.setdefault(candidate["scopeId"], []).append(candidate)
        for candidates in candidates_by_scope.values():
            candidates.sort(key=lambda item: (-item["effectiveAt"], item["chapterId"]))
            for candidate in candidates[:self.retention_policy["keepRecentCount"]]:
                candidate["reason"] = "keep-recent"
                candidate["protected"] = True

        eligible = sorted(
            (
                {"chapterId": item["chapterId"], "reason": item["reason"]}
                for item in decisions if not item.get("protected")
            ),
            key=lambda item: item["chapterId"],
        )
        protected = [item for item in decisions if item.get("protected")]
        reasons = {}
        for item in decisions:
            reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
        result = {
            "policy": dict(self.retention_policy),
            "preview": {
                "managed": len(by_chapter),
                "eligible": len(eligible),
                "protected": len(protected),
                "reasons": dict(sorted(reasons.items())),
            },
            "eligible": eligible,
        }
        if self.last_retention_cleanup_at:
            result["lastCleanupAt"] = self.last_retention_cleanup_at
        return result

    def retention_status(self, active_reader_chapter_ids=None, policy=None):
        with self.lock:
            if policy is not None:
                normalized_policy = self.normalize_retention_policy(policy, self.retention_policy)
                if normalized_policy != self.retention_policy:
                    self.retention_policy = normalized_policy
                    self.save_locked()
            retention = self.retention_preview_locked(active_reader_chapter_ids)
        status = self.status()
        status["retention"] = retention
        return status

    def mark_retention_read(self, chapter_ids):
        requested = self.normalize_retention_chapter_ids(chapter_ids)
        marked = 0
        read_at = self.retention_iso_now()
        with self.lock:
            for chapter_id in requested:
                matching = [item for item in self.retention_ledger if item.get("chapterId") == chapter_id]
                if len(matching) != 1:
                    continue
                entry = matching[0]
                if entry.get("schemaVersion") != self.RETENTION_SCHEMA_VERSION or entry.get("managedBy") != "panels":
                    continue
                if entry.get("purpose") not in self.RETENTION_PURPOSES:
                    continue
                if not self.RETENTION_SCOPE_PATTERN.fullmatch(str(entry.get("scopeId") or "")):
                    continue
                entry["readAt"] = read_at
                marked += 1
            if marked:
                self.save_locked()
        return {**self.status(), "markedRead": marked}

    def dequeue_retention_chapters(self, chapter_ids):
        if not chapter_ids:
            return
        self.graphql(
            "mutation($input:DequeueChapterDownloadsInput!){dequeueChapterDownloads(input:$input){downloadStatus{state}}}",
            {"input": {"ids": chapter_ids}},
        )

    def delete_retention_chapters(self, chapter_ids):
        if not chapter_ids:
            return
        self.graphql(
            "mutation($input:DeleteDownloadedChaptersInput!){deleteDownloadedChapters(input:$input){chapters{id}}}",
            {"input": {"ids": chapter_ids}},
        )

    def cleanup_retention(self, active_reader_chapter_ids=None, policy=None):
        deleted_ids = []
        with self.lock:
            if policy is not None:
                self.retention_policy = self.normalize_retention_policy(policy, self.retention_policy)
            retention = self.retention_preview_locked(active_reader_chapter_ids)
            eligible_ids = [item["chapterId"] for item in retention["eligible"]]
            if eligible_ids:
                eligible_set = set(eligible_ids)
                self.tasks = [item for item in self.tasks if item["chapterId"] not in eligible_set]
                self.failures = [item for item in self.failures if item["chapterId"] not in eligible_set]
                self.requested_chapter_ids = [chapter_id for chapter_id in self.requested_chapter_ids if chapter_id not in eligible_set]
                self.save_locked()
                self.dequeue_retention_chapters(eligible_ids)
                self.delete_retention_chapters(eligible_ids)
                self.retention_ledger = [item for item in self.retention_ledger if item.get("chapterId") not in eligible_set]
                self.prepared_chapters.difference_update(eligible_set)
                deleted_ids = eligible_ids
            self.last_retention_cleanup_at = self.retention_iso_now()
            self.save_locked()
            completed_retention = self.retention_preview_locked(active_reader_chapter_ids)
        self.wake.set()
        status = self.status()
        status["retention"] = completed_retention
        status["retentionCleanup"] = {"removed": len(deleted_ids)}
        return status

    def status_locked(self):
        return {
            "activeChapterId": self.active_chapter_id,
            "queued": len(self.tasks),
            "failed": len(self.failures),
            "prepared": len(self.prepared_chapters),
            "preparedChapterIds": sorted(self.prepared_chapters)[-1000:],
            "requestedChapterIds": list(self.requested_chapter_ids),
            "nextAttemptAt": min((item["notBefore"] for item in self.tasks), default=0),
            "tasks": [
                {
                    "chapterId": item["chapterId"],
                    "attempts": item["attempts"],
                    "notBefore": item["notBefore"],
                    "lastError": item.get("lastError", ""),
                }
                for item in self.tasks[:25]
            ],
        }

    def status(self):
        with self.lock:
            status = self.status_locked()
            status["retention"] = self.retention_preview_locked()
            requested = list(self.requested_chapter_ids)
            requested_set = set(requested)
            task_by_id = {item["chapterId"]: dict(item) for item in self.tasks if item["chapterId"] in requested_set}
            failure_records = [dict(item) for item in self.failures]
            failure_by_id = {item["chapterId"]: item for item in failure_records if item["chapterId"] in requested_set}
            prepared_chapters = set(self.prepared_chapters)
        status.update({
            "windowSize": len(requested),
            "downloaded": 0,
            "downloadStateKnown": not requested,
            "queuedFresh": sum(1 for chapter_id in requested if chapter_id != status["activeChapterId"] and task_by_id.get(chapter_id, {}).get("attempts", 0) == 0 and chapter_id in task_by_id),
            "retrying": sum(1 for chapter_id in requested if chapter_id != status["activeChapterId"] and task_by_id.get(chapter_id, {}).get("attempts", 0) > 0),
            "failedInWindow": len(failure_by_id),
            "panelReady": len(requested_set & prepared_chapters),
            "windowChapters": [],
            "failedChapters": [
                {
                    "chapterId": failure["chapterId"],
                    "state": "failed",
                    "attempts": failure.get("attempts", 0),
                    "lastError": str(failure.get("lastError") or "")[:500],
                    "failedAt": failure.get("failedAt", 0),
                    "panelReady": failure["chapterId"] in prepared_chapters,
                }
                for failure in reversed(failure_records)
            ],
        })
        if requested:
            try:
                details = self.chapter_download_details(requested)
                status["windowChapters"] = []
                for chapter_id in requested:
                    detail = details.get(chapter_id, {"chapterId": chapter_id})
                    task = task_by_id.get(chapter_id, {})
                    failure = failure_by_id.get(chapter_id, {})
                    if detail.get("isDownloaded"):
                        state = "downloaded"
                    elif chapter_id == status["activeChapterId"]:
                        state = "downloading"
                    elif failure:
                        state = "failed"
                    elif task.get("attempts", 0) > 0:
                        state = "retrying"
                    elif task:
                        state = "queued"
                    else:
                        state = "pending"
                    status["windowChapters"].append({
                        **detail,
                        "state": state,
                        "attempts": max(task.get("attempts", 0), failure.get("attempts", 0)),
                        "lastError": str(task.get("lastError") or failure.get("lastError") or "")[:500],
                        "panelReady": chapter_id in prepared_chapters,
                    })
                status["downloaded"] = sum(1 for detail in status["windowChapters"] if detail.get("isDownloaded"))
                status["downloadStateKnown"] = True
            except Exception as error:
                status["statusError"] = str(error)[:300]
        if failure_records:
            try:
                failure_details = self.chapter_download_details([
                    failure["chapterId"] for failure in reversed(failure_records[-25:])
                ])
                status["failedChapters"] = [
                    {
                        **failure_details.get(failure["chapterId"], {"chapterId": failure["chapterId"]}),
                        "state": "failed",
                        "attempts": failure.get("attempts", 0),
                        "lastError": str(failure.get("lastError") or "")[:500],
                        "failedAt": failure.get("failedAt", 0),
                        "panelReady": failure["chapterId"] in prepared_chapters,
                    }
                    for failure in reversed(failure_records)
                ]
            except Exception as error:
                status["statusError"] = str(error)[:300] if not status.get("statusError") else status["statusError"]
        return status

    def remove(self, chapter_ids):
        remove_ids = set()
        for raw_id in chapter_ids[:100]:
            try:
                chapter_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if chapter_id > 0:
                remove_ids.add(chapter_id)
        with self.lock:
            before = len(self.tasks) + len(self.failures)
            self.tasks = [item for item in self.tasks if item["chapterId"] not in remove_ids]
            self.failures = [item for item in self.failures if item["chapterId"] not in remove_ids]
            self.requested_chapter_ids = [chapter_id for chapter_id in self.requested_chapter_ids if chapter_id not in remove_ids]
            removed = before - len(self.tasks) - len(self.failures)
            self.save_locked()
        self.wake.set()
        return {**self.status(), "removed": removed}

    def retry_failures(self):
        with self.lock:
            existing = {item["chapterId"] for item in self.tasks}
            restored = 0
            for failure in self.failures:
                chapter_id = failure["chapterId"]
                if chapter_id in existing or chapter_id == self.active_chapter_id:
                    continue
                self.tasks.append({"chapterId": chapter_id, "attempts": 0, "notBefore": 0, "lastError": ""})
                existing.add(chapter_id)
                restored += 1
            self.failures = []
            self.save_locked()
        self.wake.set()
        return {**self.status(), "restored": restored}

    def graphql(self, query, variables=None, timeout=30):
        base = normalize_suwayomi_base_url(os.environ.get("SUWAYOMI_INTERNAL_URL", "http://localhost:4567"))
        body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        headers = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT}
        username, password = suwayomi_auth_credentials()
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        request = Request(f"{base}/api/graphql", data=body, headers=headers, method="POST")
        with open_url(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("errors"):
            raise RuntimeError(" / ".join(item.get("message", "Suwayomi error") for item in payload["errors"]))
        return payload.get("data") or {}

    def chapter_download_state(self, chapter_id):
        data = self.graphql(
            "query($id:Int!){chapter(id:$id){id isDownloaded} downloadStatus{state}}",
            {"id": chapter_id},
        )
        return bool(data.get("chapter", {}).get("isDownloaded")), data.get("downloadStatus", {}).get("state")

    def chapter_download_details(self, chapter_ids):
        ids = []
        for chapter_id in chapter_ids[:25]:
            chapter_id = int(chapter_id)
            if chapter_id > 0 and chapter_id not in ids:
                ids.append(chapter_id)
        if not ids:
            return {}
        fields = " ".join(
            f"chapter{index}:chapter(id:{chapter_id}){{id name chapterNumber isDownloaded manga{{id sourceId title source{{displayName}}}}}}"
            for index, chapter_id in enumerate(ids)
        )
        data = self.graphql(f"query{{{fields}}}", timeout=10)
        output = {}
        for index, chapter_id in enumerate(ids):
            chapter = data.get(f"chapter{index}") or {}
            manga = chapter.get("manga") or {}
            source = manga.get("source") or {}
            output[chapter_id] = {
                "chapterId": chapter_id,
                "name": str(chapter.get("name") or ""),
                "chapterNumber": chapter.get("chapterNumber"),
                "isDownloaded": bool(chapter.get("isDownloaded")),
                "mangaId": manga.get("id"),
                "sourceId": manga.get("sourceId"),
                "mangaTitle": str(manga.get("title") or ""),
                "sourceLabel": str(source.get("displayName") or ""),
            }
        return output

    def library_chapter_ids(self, chapter_ids):
        ids = []
        for chapter_id in chapter_ids[:25]:
            chapter_id = int(chapter_id)
            if chapter_id > 0 and chapter_id not in ids:
                ids.append(chapter_id)
        if not ids:
            return []
        fields = " ".join(
            f"chapter{index}:chapter(id:{chapter_id}){{id manga{{inLibrary}}}}"
            for index, chapter_id in enumerate(ids)
        )
        data = self.graphql(f"query{{{fields}}}", timeout=10)
        return [
            chapter_id for index, chapter_id in enumerate(ids)
            if bool(((data.get(f"chapter{index}") or {}).get("manga") or {}).get("inLibrary"))
        ]

    def warm_chapter_detection(self, chapter_id):
        data = self.graphql(
            "mutation($input:FetchChapterPagesInput!){fetchChapterPages(input:$input){pages}}",
            {"input": {"chapterId": chapter_id}},
            timeout=45,
        )
        pages = data.get("fetchChapterPages", {}).get("pages") or []
        if not pages:
            return False
        base = normalize_suwayomi_base_url(os.environ.get("SUWAYOMI_INTERNAL_URL", "http://localhost:4567"))
        username, password = suwayomi_auth_credentials()
        headers = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "User-Agent": USER_AGENT}
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        warmed = 0
        for path in pages:
            try:
                safe_path = safe_suwayomi_asset_path(path)
            except ValueError:
                continue
            request = Request(f"{base}{safe_path}", headers=headers, method="GET")
            with open_url(request, timeout=30) as response:
                image_bytes = response.read()
                if not image_bytes or len(image_bytes) > 12000000:
                    continue
                detect_manga_image(image_bytes, response.headers.get("Content-Type") or "application/octet-stream")
                warmed += 1
        return warmed == len(pages)

    def download_chapter(self, chapter_id):
        self.graphql(
            "mutation($input:EnqueueChapterDownloadsInput!){enqueueChapterDownloads(input:$input){downloadStatus{state}}}",
            {"input": {"ids": [chapter_id]}},
        )
        self.graphql(
            "mutation($input:StartDownloaderInput!){startDownloader(input:$input){downloadStatus{state}}}",
            {"input": {}},
        )
        for poll in range(45):
            if self.wake.wait(4):
                self.wake.clear()
            downloaded, downloader_state = self.chapter_download_state(chapter_id)
            if downloaded:
                return True
            if poll >= 1 and downloader_state == "STOPPED":
                return False
        return False

    def complete_active(self, chapter_id, downloaded, error_message=""):
        now = time.time()
        with self.lock:
            self.active_chapter_id = None
            if downloaded:
                cooldown_until = now + self.INTER_CHAPTER_DELAY
                for item in self.tasks:
                    item["notBefore"] = max(item["notBefore"], cooldown_until)
            else:
                task = next((item for item in self.tasks if item["chapterId"] == chapter_id), None)
                if task:
                    task["attempts"] += 1
                    task["lastError"] = str(error_message or "Downloader stopped before the chapter completed")[:500]
                    if task["attempts"] >= self.MAX_ATTEMPTS:
                        self.tasks = [item for item in self.tasks if item["chapterId"] != chapter_id]
                        self.failures.append({
                            "chapterId": chapter_id,
                            "attempts": task["attempts"],
                            "lastError": task["lastError"],
                            "failedAt": now,
                        })
                        self.failures = self.failures[-100:]
                    else:
                        delay = min(self.RETRY_MAX_DELAY, self.RETRY_BASE_DELAY * (2 ** min(task["attempts"] - 1, 8)))
                        task["notBefore"] = now + delay
                        self.tasks = [item for item in self.tasks if item["chapterId"] != chapter_id] + [task]
            self.save_locked()

    def run(self):
        while True:
            with self.lock:
                now = time.time()
                due = next((item for item in self.tasks if item["notBefore"] <= now), None)
                wait_seconds = min((max(1, item["notBefore"] - now) for item in self.tasks), default=60)
                if due:
                    chapter_id = due["chapterId"]
                    self.active_chapter_id = chapter_id
                else:
                    chapter_id = None
            if chapter_id is None:
                self.wake.wait(min(wait_seconds, 60))
                self.wake.clear()
                continue

            downloaded = False
            error_message = ""
            try:
                already_downloaded, _ = self.chapter_download_state(chapter_id)
                downloaded = already_downloaded or self.download_chapter(chapter_id)
            except Exception as error:
                error_message = str(error)
                print(f"Download buffer chapter {chapter_id} paused: {error}", flush=True)

            if downloaded and chapter_id not in self.prepared_chapters:
                try:
                    if self.warm_chapter_detection(chapter_id):
                        with self.lock:
                            self.prepared_chapters.add(chapter_id)
                except Exception as error:
                    print(f"Download buffer could not prepare chapter {chapter_id}: {error}", flush=True)

            with self.lock:
                if downloaded:
                    self.tasks = [item for item in self.tasks if item["chapterId"] != chapter_id]
            try:
                self.complete_active(chapter_id, downloaded, error_message)
            except Exception as error:
                print(f"Download buffer could not persist chapter {chapter_id}: {error}", flush=True)
                with self.lock:
                    self.active_chapter_id = None
                self.wake.wait(60)
                self.wake.clear()


class PanelPilotHandler(SimpleHTTPRequestHandler):
    server_version = "Panels"
    sys_version = ""

    def __init__(self, *args, directory=None, **kwargs):
        static_root = Path(directory).resolve() if directory else resolve_static_root()
        super().__init__(*args, directory=str(static_root), **kwargs)

    def translate_path(self, path):
        static_root = Path(self.directory).resolve()
        translated = Path(super().translate_path(path)).resolve()
        try:
            translated.relative_to(static_root)
        except ValueError:
            return str(static_root / ".panel-pilot-not-found")
        return str(translated)

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def protected_static_request(self, path):
        normalized = "/" + unquote(path).lstrip("/").lower()
        if normalized in PROTECTED_STATIC_PATHS:
            return True
        if any(normalized.startswith(prefix) for prefix in PROTECTED_STATIC_PREFIXES):
            return True
        return any(part.startswith(".") for part in normalized.split("/") if part)

    def auth_credentials(self):
        return validate_panel_auth_configuration()

    def auth_enabled(self):
        return all(self.auth_credentials())

    def session_secrets(self):
        configured = os.environ.get("PANEL_PILOT_SESSION_SECRET", "")
        username, password = self.auth_credentials()
        password_derived = hashlib.sha256(
            f"panel-pilot-session\0{username}\0{password}".encode("utf-8")
        ).digest()
        if not configured:
            return (password_derived,)
        return (decode_session_secret(configured),)

    def session_secret(self):
        return self.session_secrets()[0]

    def make_session_token(self, account):
        if isinstance(account, str):
            account = account_store().by_username(account)
        if not account:
            raise ValueError("Unknown Panels account")
        payload = json.dumps(
            {
                "sub": account["id"],
                "ver": int(account["sessionVersion"]),
                "iat": int(time.time()),
                "exp": int(time.time()) + SESSION_MAX_AGE,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
        signature = hmac.new(self.session_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
        encoded_signature = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        return f"{encoded}.{encoded_signature}"

    def session_account(self):
        if not self.auth_enabled():
            return {
                "id": "local", "username": "local", "displayName": "Local reader",
                "isAdmin": True, "contentTypes": ["books", "manga", "comic", "webtoon"],
                "sessionVersion": 1, "disabled": False,
            }

        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie[SESSION_COOKIE].value
            encoded, encoded_signature = token.split(".", 1)
            supplied = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
            if not any(
                hmac.compare_digest(
                    hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest(),
                    supplied,
                )
                for secret in self.session_secrets()
            ):
                return None
            payload_bytes = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
            payload = json.loads(payload_bytes.decode("utf-8"))
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            return None

        try:
            issued_at = int(payload.get("iat", 0))
            expires_at = int(payload.get("exp", 0))
        except (TypeError, ValueError):
            return None
        account = account_store().by_id(payload.get("sub"))
        now = int(time.time())
        valid = (
            bool(account)
            and not account["disabled"]
            and hmac.compare_digest(str(payload.get("ver") or ""), str(account["sessionVersion"]))
            and issued_at <= now + 60
            and issued_at <= expires_at <= issued_at + SESSION_MAX_AGE
            and expires_at >= now
        )
        return account if valid else None

    def valid_session(self):
        return bool(self.session_account())

    def current_account(self):
        return self.session_account()

    def account_allows(self, content_type):
        account = self.current_account() or {}
        return content_type in (account.get("contentTypes") or ())

    def account_data_path(self, legacy_path, name=None):
        account = self.current_account() or {"id": "local", "isAdmin": True}
        if account.get("isAdmin"):
            return str(Path(legacy_path).expanduser().resolve())
        account_id = str(account.get("id") or "local")
        if not re.fullmatch(r"acct_[0-9a-f]{32}", account_id):
            raise ValueError("Invalid account storage identity")
        target_name = name or Path(legacy_path).name
        return str((Path(DATA_ROOT).expanduser().resolve() / "accounts" / account_id / target_name).resolve())

    def library_path(self):
        return self.account_data_path(LIBRARY_PATH, "library.json")

    def reading_stats_store(self):
        return ReadingStatsStore(self.account_data_path(READING_STATS_PATH, "reading-stats.sqlite3"))

    def mangabaka_config_path(self):
        return self.account_data_path(MANGABAKA_CONFIG_PATH, "mangabaka-config.json")

    def read_account_mangabaka_token(self):
        account = self.current_account() or {}
        return read_mangabaka_token(self.mangabaka_config_path(), allow_environment=bool(account.get("isAdmin")))

    def authorize_account_api(self, parsed):
        path = parsed.path
        if path.startswith(("/api/books", "/api/book-recommendations")) and not self.account_allows("books"):
            self.send_json({"error": "Books are not enabled for this account", "code": "content_disabled"}, status=403)
            return False
        visual_paths = (
            "/api/suwayomi", "/api/library", "/api/moments", "/api/mangabaka",
            "/api/detect/", "/api/download-buffer", "/api/source-profiles",
            "/api/source-intelligence", "/api/comick", "/api/readcomiconline",
        )
        if path.startswith(visual_paths) and not any(self.account_allows(value) for value in ("manga", "comic", "webtoon")):
            self.send_json({"error": "Manga and comics are not enabled for this account", "code": "content_disabled"}, status=403)
            return False
        return True

    def require_auth(self, parsed):
        if self.valid_session():
            return True

        if parsed.path.startswith("/api/"):
            self.send_json({"error": "Authentication required", "login": "/login"}, status=401)
            return False

        next_path = parsed.path
        if parsed.query:
            next_path += f"?{parsed.query}"
        self.redirect(f"/login?{urlencode({'next': next_path})}")
        return False

    def secure_request(self):
        forwarded = self.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower()
        return forwarded == "https"

    def version_string(self):
        return "Panels"

    def content_security_policy(self):
        if urlparse(self.path).path in ("/login", "/api/app-recovery"):
            return "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        return (
            "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
            "form-action 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data: blob: https:; connect-src 'self'; "
            "worker-src 'self' blob:; manifest-src 'self'; font-src 'self'"
        )

    def end_headers(self):
        self.send_header("Content-Security-Policy", self.content_security_policy())
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self), screen-wake-lock=(self)")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Permitted-Cross-Domain-Policies", "none")
        if self.secure_request():
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        super().end_headers()

    def client_rate_key(self):
        forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        candidates = (forwarded, str(self.client_address[0] if self.client_address else ""))
        for candidate in candidates:
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                continue
        return "unknown"

    def mutation_origin_allowed(self):
        supplied_origin = self.headers.get("Origin", "").strip()
        fetch_site = self.headers.get("Sec-Fetch-Site", "").strip().lower()
        if not supplied_origin:
            return fetch_site != "cross-site"
        if supplied_origin == "null":
            return fetch_site == "same-origin"
        try:
            origin = urlparse(supplied_origin)
            request_scheme = "https" if self.secure_request() else "http"
            request_origin = urlparse(f"{request_scheme}://{self.headers.get('Host', '')}")
            origin_port = origin.port or (443 if origin.scheme == "https" else 80)
            request_port = request_origin.port or (443 if request_origin.scheme == "https" else 80)
        except ValueError:
            return False
        return (
            origin.scheme in ("http", "https")
            and origin.username is None
            and origin.password is None
            and origin.hostname == request_origin.hostname
            and origin_port == request_port
            and origin.scheme == request_origin.scheme
        )

    def reject_cross_origin_mutation(self, parsed):
        if self.mutation_origin_allowed():
            return False
        if parsed.path.startswith("/api/"):
            self.send_json({"error": "Cross-origin request rejected"}, status=403)
        else:
            self.send_error(403, "Cross-origin request rejected")
        return True

    def session_cookie_header(self, value, max_age):
        parts = [
            f"{SESSION_COOKIE}={value}",
            "Path=/",
            f"Max-Age={max_age}",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if self.secure_request():
            parts.append("Secure")
        return "; ".join(parts)

    def redirect(self, target, cookie_header=None):
        self.send_response(303)
        self.send_header("Location", target)
        self.send_header("Cache-Control", "no-store")
        if cookie_header:
            self.send_header("Set-Cookie", cookie_header)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def serve_login(self, parsed):
        if not self.auth_enabled():
            self.redirect("/")
            return
        if self.valid_session():
            self.redirect(self.safe_next_path(parse_qs(parsed.query).get("next", ["/"])[0]))
            return

        path = os.path.join(self.directory, "login.html")
        with open(path, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_legacy_service_worker_bridge(self):
        """Update workers installed from the historical /src/sw.js URL."""
        body = LEGACY_SERVICE_WORKER_BRIDGE
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_app_recovery(self):
        """Offer an explicit stale-worker repair without erasing reader data."""
        body = b"""<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Repair Panels</title><style>body{box-sizing:border-box;max-width:36rem;margin:auto;padding:2rem 1rem;font:17px/1.5 system-ui;background:#f7f6f1;color:#252822}main{padding:1.2rem;border:1px solid #d9ddd8;border-radius:18px;background:white}button{width:100%;min-height:3rem;border:0;border-radius:12px;background:#236c6e;color:white;font:inherit;font-weight:750}p{color:#626861}</style><main><h1>Repair Panels</h1><p>This refreshes a stuck app shell. Downloaded chapters, book positions, library data and preferences are kept.</p><button id=\"repair\">Repair and reopen Panels</button><p id=\"status\" role=\"status\"></p></main><script>document.querySelector('#repair').addEventListener('click',async function(){this.disabled=true;document.querySelector('#status').textContent='Repairing the app shell...';if('serviceWorker'in navigator){const registrations=await navigator.serviceWorker.getRegistrations();await Promise.all(registrations.map(registration=>registration.unregister()))}if('caches'in window){const names=await caches.keys();await Promise.all(names.filter(name=>/^panel-pilot-v\\d+$/.test(name)&&name!=='panels-device-chapters-v1').map(name=>caches.delete(name)))}location.replace('/?recovered='+Date.now())})</script></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def safe_next_path(self, value):
        return value if value.startswith("/") and not value.startswith("//") else "/"

    def handle_login_post(self):
        if not self.auth_enabled():
            self.redirect("/")
            return
        client_key = self.client_rate_key()
        retry_after = LOGIN_ATTEMPTS.retry_after(client_key)
        if retry_after:
            body = b"Too many sign-in attempts. Try again later.\n"
            self.send_response(429)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Retry-After", str(retry_after))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16384:
            self.redirect("/login?error=1")
            return
        form = parse_qs(self.rfile.read(length).decode("utf-8", errors="replace"))
        username = form.get("username", [""])[0]
        password = form.get("password", [""])[0]
        account = account_store().authenticate(username, password)
        next_path = self.safe_next_path(form.get("next", ["/"])[0])
        if not account:
            LOGIN_ATTEMPTS.record_failure(client_key)
            self.redirect(f"/login?{urlencode({'error': '1', 'next': next_path})}")
            return

        LOGIN_ATTEMPTS.clear_client(client_key)
        token = self.make_session_token(account)
        self.redirect(next_path, self.session_cookie_header(token, SESSION_MAX_AGE))

    def handle_logout_post(self):
        self.redirect("/login", self.session_cookie_header("", 0))

    def do_POST(self):
        parsed = urlparse(self.path)
        if self.reject_cross_origin_mutation(parsed):
            return
        if parsed.path == "/login":
            self.handle_login_post()
            return
        if parsed.path == "/logout":
            self.handle_logout_post()
            return
        if not self.require_auth(parsed):
            return
        if not self.authorize_account_api(parsed):
            return
        try:
            if parsed.path == "/api/suwayomi/graphql":
                self.handle_suwayomi_graphql(parsed)
                return
            if parsed.path == "/api/books/connections/test":
                self.handle_books_connection_test()
                return
            if parsed.path == "/api/accounts":
                self.handle_accounts_post()
                return
            account_password = re.fullmatch(r"/api/accounts/([^/]+)/password", parsed.path)
            if account_password:
                self.handle_account_password_post(account_password.group(1))
                return
            account_content = re.fullmatch(r"/api/accounts/([^/]+)/content", parsed.path)
            if account_content:
                self.handle_account_content_post(account_content.group(1))
                return
            if parsed.path == "/api/books/sync":
                self.handle_books_sync()
                return
            if parsed.path == "/api/books/downloads":
                self.handle_books_download_post()
                return
            if parsed.path == "/api/books/preferences":
                self.handle_books_preferences_post()
                return
            book_library_status = re.fullmatch(r"/api/books/(\d+)/library-status", parsed.path)
            if book_library_status:
                self.handle_book_library_status_post(int(book_library_status.group(1)))
                return
            book_library_add = re.fullmatch(r"/api/books/(\d+)/library", parsed.path)
            if book_library_add:
                self.handle_book_library_add_post(int(book_library_add.group(1)))
                return
            book_progress = re.fullmatch(r"/api/books/(\d+)/progress", parsed.path)
            if book_progress:
                self.handle_book_progress_post(int(book_progress.group(1)))
                return
            if parsed.path == "/api/library":
                self.handle_library_post()
                return
            if parsed.path == "/api/library/migrate":
                try:
                    self.handle_library_migrate_post()
                except (ValueError, json.JSONDecodeError) as error:
                    self.send_json({"error": str(error)}, status=400)
                return
            if parsed.path == "/api/moments":
                try:
                    self.handle_moments_post()
                except (ValueError, json.JSONDecodeError) as error:
                    self.send_json({"error": str(error)}, status=400)
                return
            if parsed.path == "/api/panel-report":
                self.handle_panel_report_post()
                return
            if parsed.path == "/api/download-buffer":
                try:
                    self.handle_download_buffer_post()
                except (ValueError, json.JSONDecodeError) as error:
                    self.send_json({"error": str(error)}, status=400)
                return
            if parsed.path == "/api/mangabaka/config":
                self.handle_mangabaka_config_post()
                return
            if parsed.path == "/api/comic-recommendations/config":
                self.handle_comic_recommendations_config_post()
                return
            if parsed.path == "/api/recommendations/similar":
                self.handle_similar_recommendations()
                return
            if parsed.path == "/api/mangabaka/library":
                self.handle_mangabaka_library_post()
                return
            if parsed.path == "/api/detect/manga":
                self.handle_panel_detection("manga")
                return
            if parsed.path == "/api/detect/comic":
                self.handle_panel_detection("comic")
                return
            if parsed.path == "/api/reading-stats/events":
                self.handle_reading_stats_events()
                return
            if parsed.path == "/api/reading-stats/settings":
                self.handle_reading_stats_settings()
                return
            if parsed.path == "/api/reading-stats/reset":
                self.handle_reading_stats_reset()
                return
            if parsed.path == "/api/source-profiles":
                try:
                    self.handle_source_profiles_post()
                except (ValueError, json.JSONDecodeError) as error:
                    self.send_json({"error": str(error)}, status=400)
                return
            if parsed.path.startswith("/api/source-intelligence/"):
                try:
                    self.handle_source_intelligence_post(parsed)
                except (SourceIntelligenceError, ValueError, json.JSONDecodeError) as error:
                    self.send_json({"error": str(error)}, status=400)
                return
        except BookRequestError as error:
            payload = {"error": str(error), "code": error.code}
            if error.current is not None:
                payload["current"] = error.current
            self.send_json(payload, status=error.status)
            return
        except (ShelfmarkError, OpdsError) as error:
            self.send_json({"error": str(error), "code": error.code}, status=error.status)
            return
        except ReadingStatsRequestError as error:
            self.send_json({"error": str(error)}, status=error.status)
            return
        except Exception as error:
            self.send_json({"error": str(error)}, status=502)
            return

        self.send_json({"error": "Unknown POST endpoint"}, status=404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if self.reject_cross_origin_mutation(parsed):
            return
        if not self.require_auth(parsed):
            return
        if not self.authorize_account_api(parsed):
            return
        try:
            book_match = re.fullmatch(r"/api/books/(\d+)", parsed.path)
            if book_match:
                self.handle_book_delete(int(book_match.group(1)))
                return
            moment_match = re.fullmatch(r"/api/moments/([^/]+)", parsed.path)
            if moment_match:
                self.handle_moment_delete(moment_match.group(1))
                return
            self.send_json({"error": "Unknown DELETE endpoint"}, status=404)
        except BookRequestError as error:
            self.send_json({"error": str(error), "code": error.code}, status=error.status)
        except Exception as error:
            self.send_json({"error": str(error)}, status=502)

    def handle_panel_detection(self, mode):
        detector_base = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_URL", "").strip().rstrip("/")
        if not detector_base:
            self.send_json({"error": "Panel model service is not configured"}, status=503)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 12000000:
            raise ValueError("Panel detector image is empty or too large")
        content_type = self.headers.get("Content-Type", "application/octet-stream")
        request_body = self.rfile.read(length)
        if content_type.startswith("application/json"):
            if length > 16384:
                raise ValueError("Panel detector URL request is too large")
            payload = json.loads(request_body.decode("utf-8"))
            image_bytes, content_type = self.fetch_panel_detection_asset(payload.get("url", ""))
        elif content_type.startswith("image/"):
            image_bytes = request_body
        else:
            raise ValueError("Panel detector expects an image or a Suwayomi asset URL")
        payload, cache_state, status = detect_panel_image(image_bytes, content_type, mode)
        self.send_detector_payload(payload, cache_state, status=status)

    def fetch_panel_detection_asset(self, raw_url):
        parsed = urlparse(str(raw_url or ""))
        if parsed.scheme or parsed.netloc or parsed.path != "/api/suwayomi/asset":
            raise ValueError("Panel detector URL must be a local Suwayomi asset")
        params = parse_qs(parsed.query)
        base = self.resolve_suwayomi_base(params.get("base", ["http://localhost:4567"])[0])
        path = safe_suwayomi_asset_path(params.get("path", [""])[0])
        request = Request(
            f"{base}{path}",
            headers=self.suwayomi_headers(accept="image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
            method="GET",
        )
        with open_url(request, timeout=30) as response:
            image_bytes = response.read()
            if not image_bytes or len(image_bytes) > 12000000:
                raise ValueError("Panel detector asset is empty or too large")
            return image_bytes, response.headers.get("Content-Type") or "application/octet-stream"

    def send_detector_payload(self, payload, cache_state, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Panel-Pilot-Detector-Cache", cache_state)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_download_buffer_post(self):
        if not DOWNLOAD_BUFFER_MANAGER:
            self.send_json({"error": "Download buffer is unavailable"}, status=503)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 65536:
            raise ValueError("Download buffer request is empty or too large")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Download buffer request must be an object")
        if payload.get("retryFailed") is True:
            self.send_json(DOWNLOAD_BUFFER_MANAGER.retry_failures())
            return
        remove_chapter_ids = payload.get("removeChapterIds")
        if isinstance(remove_chapter_ids, list):
            self.send_json(DOWNLOAD_BUFFER_MANAGER.remove(remove_chapter_ids))
            return
        mark_read_chapter_ids = payload.get("markReadChapterIds")
        if mark_read_chapter_ids is not None:
            if not isinstance(mark_read_chapter_ids, list):
                raise ValueError("markReadChapterIds must be a list")
            self.send_json(DOWNLOAD_BUFFER_MANAGER.mark_retention_read(mark_read_chapter_ids))
            return
        retention_preview = payload.get("retentionPreview") is True
        cleanup_retention = payload.get("cleanupRetention") is True
        if retention_preview or cleanup_retention:
            active_reader_chapter_ids = payload.get("activeReaderChapterIds", [])
            if not isinstance(active_reader_chapter_ids, list):
                raise ValueError("activeReaderChapterIds must be a list")
            retention_policy = payload.get("retentionPolicy")
            if retention_policy is not None and not isinstance(retention_policy, dict):
                raise ValueError("retentionPolicy must be an object")
            if cleanup_retention:
                self.send_json(DOWNLOAD_BUFFER_MANAGER.cleanup_retention(
                    active_reader_chapter_ids=active_reader_chapter_ids,
                    policy=retention_policy,
                ))
            else:
                self.send_json(DOWNLOAD_BUFFER_MANAGER.retention_status(
                    active_reader_chapter_ids=active_reader_chapter_ids,
                    policy=retention_policy,
                ))
            return
        chapter_ids = payload.get("chapterIds")
        if not isinstance(chapter_ids, list):
            raise ValueError("chapterIds must be a list")
        priority = payload.get("priority", "foreground")
        if priority not in ("foreground", "background"):
            raise ValueError("priority must be foreground or background")
        self.send_json(DOWNLOAD_BUFFER_MANAGER.enqueue(
            chapter_ids,
            priority=priority,
            purpose=payload.get("purpose"),
            scope_id=payload.get("scopeId"),
        ))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/src/sw.js":
            self.serve_legacy_service_worker_bridge()
            return
        if self.protected_static_request(parsed.path):
            self.send_error(404, "Not found")
            return
        if parsed.path == "/login":
            self.serve_login(parsed)
            return
        if parsed.path == "/api/app-version":
            self.send_json({
                "buildId": os.environ.get("PANEL_PILOT_BUILD_ID", "unknown"),
                "minimumLifecycleProtocol": 2,
            })
            return
        if parsed.path == "/api/app-recovery":
            self.serve_app_recovery()
            return
        if not self.require_auth(parsed):
            return
        if not self.authorize_account_api(parsed):
            return
        try:
            if parsed.path == "/api/books/status":
                self.handle_books_status()
                return
            if parsed.path == "/api/session":
                account = self.current_account()
                self.send_json({"account": account})
                return
            if parsed.path == "/api/accounts":
                self.handle_accounts_get()
                return
            if parsed.path == "/api/books":
                self.handle_books_list(parsed)
                return
            if parsed.path == "/api/books/search":
                self.handle_books_search(parsed)
                return
            if parsed.path == "/api/books/releases":
                self.handle_books_releases(parsed)
                return
            if parsed.path == "/api/books/downloads":
                self.handle_books_downloads_get()
                return
            if parsed.path == "/api/books/preferences":
                self.handle_books_preferences_get()
                return
            if parsed.path == "/api/book-recommendations":
                self.handle_book_recommendations(parsed)
                return
            book_progress = re.fullmatch(r"/api/books/(\d+)/progress", parsed.path)
            if book_progress:
                self.handle_book_progress_get(int(book_progress.group(1)))
                return
            book_epub = re.fullmatch(r"/api/books/(\d+)/epub", parsed.path)
            if book_epub:
                self.handle_book_epub(int(book_epub.group(1)))
                return
            book_cover = re.fullmatch(r"/api/books/(\d+)/cover", parsed.path)
            if book_cover:
                self.handle_book_cover(int(book_cover.group(1)))
                return
            book_detail = re.fullmatch(r"/api/books/(\d+)", parsed.path)
            if book_detail:
                self.handle_book_detail(int(book_detail.group(1)))
                return
            if parsed.path.startswith("/api/books"):
                if not self.books_config().enabled:
                    self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
                else:
                    self.send_json({"error": "Unknown books endpoint"}, status=404)
                return
            if parsed.path == "/api/comick/chapters":
                self.handle_comick_chapters(parsed)
                return
            if parsed.path == "/api/comick/chapter":
                self.handle_comick_chapter(parsed)
                return
            if parsed.path == "/api/readcomiconline/chapter":
                self.handle_readcomiconline_chapter(parsed)
                return
            if parsed.path == "/api/image":
                self.handle_image_proxy(parsed)
                return
            if parsed.path == "/api/suwayomi/asset":
                self.handle_suwayomi_asset(parsed)
                return
            if parsed.path == "/api/download-buffer/status":
                self.send_json(DOWNLOAD_BUFFER_MANAGER.status() if DOWNLOAD_BUFFER_MANAGER else {"queued": 0})
                return
            if parsed.path == "/api/library":
                self.handle_library_get()
                return
            if parsed.path == "/api/moments":
                self.handle_moments_get()
                return
            moment_image = re.fullmatch(r"/api/moments/([^/]+)/image", parsed.path)
            if moment_image:
                self.handle_moment_image_get(moment_image.group(1))
                return
            if parsed.path == "/api/mangabaka/status":
                self.handle_mangabaka_status()
                return
            if parsed.path == "/api/mangabaka/recommendations":
                self.handle_mangabaka_recommendations(parsed)
                return
            if parsed.path == "/api/comic-recommendations":
                self.handle_comic_recommendations(parsed)
                return
            if parsed.path == "/api/comic-recommendations/config":
                self.handle_comic_recommendations_config_get()
                return
            if parsed.path == "/api/mangabaka/search":
                self.handle_mangabaka_search(parsed)
                return
            if parsed.path == "/api/reading-stats":
                self.handle_reading_stats_get(parsed)
                return
            if parsed.path == "/api/source-profiles":
                self.send_json(SourceProfileStore().summary())
                return
            if parsed.path == "/api/source-intelligence" or parsed.path.startswith("/api/source-intelligence/"):
                try:
                    self.handle_source_intelligence_get(parsed)
                except SourceIntelligenceError as error:
                    self.send_json({"error": str(error)}, status=400)
                return
            if parsed.path == "/api/reading-stats/export":
                self.send_json_attachment(
                    self.reading_stats_store().export_data(),
                    f"panels-reading-stats-{datetime.now(timezone.utc).date().isoformat()}.json",
                )
                return
        except BookRequestError as error:
            payload = {"error": str(error), "code": error.code}
            if error.current is not None:
                payload["current"] = error.current
            self.send_json(payload, status=error.status)
            return
        except (ShelfmarkError, OpdsError) as error:
            self.send_json({"error": str(error), "code": error.code}, status=error.status)
            return
        except ReadingStatsRequestError as error:
            self.send_json({"error": str(error)}, status=error.status)
            return
        except Exception as error:
            self.send_json({"error": str(error)}, status=502)
            return

        super().do_GET()

    def books_config(self):
        return BooksConfig.from_environment(DATA_ROOT)

    def books_service(self):
        global BOOKS_SERVICE
        config = self.books_config()
        if not config.enabled:
            raise ValueError("Books are disabled")
        with BOOKS_SERVICE_LOCK:
            if BOOKS_SERVICE is None or BOOKS_SERVICE.config != config:
                owner = next((account for account in account_store().list_accounts() if account["isAdmin"]), None)
                legacy_username, _ = self.auth_credentials()
                BOOKS_SERVICE = BooksService(
                    config,
                    owner_user_id=(owner or {}).get("id") or "local",
                    legacy_owner_username=legacy_username,
                )
                BOOKS_SERVICE.start()
            return BOOKS_SERVICE

    def handle_books_status(self):
        config = self.books_config()
        if not config.enabled:
            self.send_json(config.public_status())
            return
        service = self.books_service()
        status = service.status()
        status["books"] = service.list_books(self.book_user_id(), limit=1, offset=0)["total"]
        self.send_json(status)

    def book_user_id(self):
        account = self.current_account()
        return str((account or {}).get("id") or "local")

    def require_admin_account(self):
        account = self.current_account()
        if not account or not account.get("isAdmin"):
            self.send_json({"error": "Administrator access is required"}, status=403)
            return None
        return account

    def handle_accounts_get(self):
        if not self.require_admin_account():
            return
        self.send_json({"accounts": account_store().list_accounts()})

    def handle_accounts_post(self):
        if not self.require_admin_account():
            return
        payload = self.read_json_request(16384)
        try:
            account = account_store().create(
                payload.get("username"), payload.get("password"), payload.get("displayName"),
                payload.get("contentTypes") or ("books",),
            )
        except AccountError as error:
            self.send_json({"error": str(error)}, status=400)
            return
        self.send_json({"account": account}, status=201)

    def handle_account_password_post(self, account_id):
        if not self.require_admin_account():
            return
        payload = self.read_json_request(4096)
        try:
            account = account_store().reset_password(account_id, payload.get("password"))
        except AccountError as error:
            self.send_json({"error": str(error)}, status=400)
            return
        self.send_json({"account": account})

    def handle_account_content_post(self, account_id):
        if not self.require_admin_account():
            return
        payload = self.read_json_request(4096)
        try:
            account = account_store().update_content_types(account_id, payload.get("contentTypes"))
        except AccountError as error:
            self.send_json({"error": str(error)}, status=400)
            return
        self.send_json({"account": account})

    def handle_books_connection_test(self):
        config = self.books_config()
        if not config.enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        payload = self.read_json_request(4096)
        self.send_json(self.books_service().test_connection(str(payload.get("target") or "")))

    def handle_books_sync(self):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        self.send_json(self.books_service().sync_library())

    def handle_books_list(self, parsed):
        config = self.books_config()
        if not config.enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        params = parse_qs(parsed.query)
        self.send_json(self.books_service().list_books(
            self.book_user_id(),
            params.get("q", [""])[0],
            params.get("limit", [100])[0],
            params.get("offset", [0])[0],
        ))

    def handle_book_detail(self, book_id):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        book = self.books_service().get_book(book_id, self.book_user_id())
        if not book:
            self.send_json({"error": "Book not found"}, status=404)
            return
        self.send_json({"book": book, "progress": self.books_service().progress(self.book_user_id(), book_id)})

    def handle_book_delete(self, book_id):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        self.send_json(self.books_service().remove_book(self.book_user_id(), book_id))

    def handle_book_recommendations(self, parsed):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        params = parse_qs(parsed.query)
        try:
            limit = max(1, min(20, int(params.get("limit", [12])[0])))
        except (TypeError, ValueError):
            self.send_json({"error": "limit must be an integer between 1 and 20"}, status=400)
            return
        service = build_book_recommendation_service()
        if service is None:
            self.send_json({
                "schemaVersion": 1, "configured": False, "status": "unconfigured",
                "mode": "unconfigured", "seedTitles": [], "cacheKey": "",
                "cacheStatus": "disabled", "results": [],
            })
            return
        library = self.books_service().list_books(self.book_user_id(), limit=200, offset=0)["books"]
        seeds = book_seeds_from_library(library)
        if not seeds:
            self.send_json({
                "schemaVersion": 1, "configured": True, "status": "needs-library",
                "mode": "needs-library", "seedTitles": [], "cacheKey": "",
                "cacheStatus": "miss", "results": [],
            })
            return
        owned = book_inventory_from_library(library)
        cache = ComicRecommendationCache(
            path=BOOK_RECOMMENDATIONS_CACHE_PATH,
            key_prefix="book-recs",
            label="book",
        )
        cache_key = service.cache_key(seeds, limit=limit)
        cached, cache_status = cache.get(cache_key)
        if cache_status == "hit":
            self.send_json({**cached, "configured": True, "status": "ready", "cacheStatus": "hit"})
            return
        feed = service.build_feed(seeds, owned_books=owned, limit=limit).to_public_dict()
        if feed.get("mode") == "unavailable":
            if cached is not None:
                self.send_json({**cached, "configured": True, "status": "ready", "cacheStatus": "stale"})
            else:
                self.send_json({**feed, "configured": True, "status": "unavailable", "cacheStatus": "miss"})
            return
        response_cache_status = "miss"
        try:
            cache.put(cache_key, feed)
        except OSError:
            response_cache_status = "bypass"
        self.send_json({**feed, "configured": True, "status": "ready", "cacheStatus": response_cache_status})

    def handle_similar_recommendations(self):
        payload = self.read_json_request(16384)
        media_format = str(payload.get("mediaFormat") or "").strip().lower()
        if media_format not in ("book", "manga", "comic", "webtoon"):
            self.send_json({"error": "mediaFormat must be book, comic, manga, or webtoon"}, status=400)
            return
        if not self.account_allows("books" if media_format == "book" else media_format):
            self.send_json({"error": f"{media_format.title()} is not enabled for this account"}, status=403)
            return
        try:
            limit = max(1, min(20, int(payload.get("limit") or 12)))
        except (TypeError, ValueError):
            self.send_json({"error": "limit must be an integer between 1 and 20"}, status=400)
            return
        if media_format == "book":
            self.handle_similar_book_recommendations(payload, limit)
            return
        if media_format == "comic":
            self.handle_similar_comic_recommendations(payload, limit)
            return
        if media_format in MANGA_FORMATS:
            self.handle_similar_mangabaka_recommendations(payload, media_format, limit)
            return
        self.send_json({"error": "mediaFormat must be book, comic, manga, or webtoon"}, status=400)

    @staticmethod
    def similar_response(*, status, provider, seed_title, results=(), configured=True):
        return {
            "schemaVersion": 1,
            "configured": bool(configured),
            "status": status,
            "provider": provider,
            "seedTitle": seed_title,
            "results": list(results),
        }

    def handle_similar_book_recommendations(self, payload, limit):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        try:
            book_id = int(payload.get("bookId") or 0)
        except (TypeError, ValueError):
            book_id = 0
        book = self.books_service().get_book(book_id, self.book_user_id()) if book_id > 0 else None
        if not book:
            self.send_json({"error": "Book not found"}, status=404)
            return
        service = build_book_recommendation_service()
        if service is None:
            self.send_json(self.similar_response(
                status="unconfigured", provider="librarything", seed_title=book["title"], configured=False,
            ))
            return
        library = self.books_service().list_books(self.book_user_id(), limit=200, offset=0)["books"]
        owned = book_inventory_from_library(library)
        seed = BookSeed(
            book_id=book_id,
            title=book.get("title") or "",
            authors=tuple(book.get("authors") or ()),
            isbn=book.get("isbn") or "",
            series_name=book.get("seriesName") or "",
            series_position=book.get("seriesPosition"),
            status=book.get("libraryStatus") or "",
            updated_at=(book.get("progress") or {}).get("updatedAt") or book.get("lastSyncedAt") or "",
        )
        feed = service.build_feed((seed,), owned_books=owned, limit=limit).to_public_dict()
        status = "unavailable" if feed.get("mode") == "unavailable" else "ready"
        self.send_json(self.similar_response(
            status=status,
            provider="librarything",
            seed_title=seed.title,
            results=feed.get("results") or (),
        ))

    def handle_similar_comic_recommendations(self, payload, limit):
        title = str(payload.get("title") or "").replace("\x00", "").strip()[:300]
        if not title:
            self.send_json({"error": "A comic title is required"}, status=400)
            return
        service = build_comic_recommendation_service()
        if service is None:
            self.send_json(self.similar_response(
                status="unconfigured", provider="librarything", seed_title=title, configured=False,
            ))
            return
        creators = tuple(
            str(value).replace("\x00", "").strip()[:200]
            for value in payload.get("creators") or ()
            if str(value).strip()
        )[:12]
        seed = ComicSeed(title=title, creators=creators)
        feed = service.build_feed((seed,), limit=limit).to_public_dict()
        owned_titles = {
            re.sub(r"[^a-z0-9]+", " ", str(item.get("mangaTitle") or "").lower()).strip()
            for item in self.read_library_items()
            if isinstance(item, dict)
        }
        results = [
            result for result in feed.get("results") or ()
            if re.sub(r"[^a-z0-9]+", " ", str(result.get("title") or "").lower()).strip() not in owned_titles
        ][:limit]
        status = "unavailable" if feed.get("mode") == "unavailable" else "ready"
        self.send_json(self.similar_response(
            status=status, provider="librarything", seed_title=title, results=results,
        ))

    def handle_similar_mangabaka_recommendations(self, payload, media_format, limit):
        title = str(payload.get("title") or "").replace("\x00", "").strip()[:300]
        if not title:
            self.send_json({"error": "A title is required"}, status=400)
            return
        try:
            series_id = int(payload.get("mangabakaId") or 0)
        except (TypeError, ValueError):
            series_id = 0
        if series_id <= 0:
            query = urlencode({"q": title, "limit": 8, "schema": "full"})
            search = self.mangabaka_json(f"/v2/series/search?{query}", token="")
            seed = select_mangabaka_seed(search.get("data") if isinstance(search, dict) else None, title)
            series_id = int((seed or {}).get("id") or 0)
        if series_id <= 0:
            self.send_json(self.similar_response(
                status="no-match", provider="mangabaka", seed_title=title,
            ))
            return
        query = urlencode({
            "limit": limit,
            "content_rating": ["safe", "suggestive"],
        }, doseq=True)
        similar = self.mangabaka_json(f"/v2/series/{series_id}/similar?{query}", token="")
        excluded_titles = (
            str(item.get("mangaTitle") or "")
            for item in self.read_library_items()
            if isinstance(item, dict)
        )
        results = normalize_mangabaka_similar(
            similar,
            seed_title=title,
            requested_format=media_format,
            excluded_titles=excluded_titles,
            limit=limit,
        )
        self.send_json(self.similar_response(
            status="ready", provider="mangabaka", seed_title=title, results=results,
        ))

    def handle_book_cover(self, book_id):
        if not self.books_config().enabled:
            self.send_error(404, "Not found")
            return
        if not self.books_service().get_book(book_id, self.book_user_id()):
            self.send_error(404, "Not found")
            return
        try:
            content, content_type = self.books_service().cover(book_id)
        except KeyError:
            self.send_error(404, "Not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def handle_books_search(self, parsed):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        try:
            query = parse_qs(parsed.query).get("query", [""])[0]
            self.send_json({"books": self.books_service().search(query, self.book_user_id())})
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)

    def handle_books_releases(self, parsed):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        params = parse_qs(parsed.query)
        provider = params.get("provider", [""])[0]
        provider_book_id = params.get("bookId", [""])[0]
        if not provider or not provider_book_id:
            self.send_json({"error": "provider and bookId are required"}, status=400)
            return
        self.send_json({"releases": self.books_service().releases(provider, provider_book_id)})

    def handle_books_download_post(self):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        try:
            payload = self.read_json_request(65536)
            download = self.books_service().queue_download(
                payload.get("releaseToken"), payload.get("bookToken"), self.book_user_id()
            )
            self.send_json({"download": download}, status=202)
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)

    def handle_books_downloads_get(self):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        self.send_json({"downloads": self.books_service().refresh_downloads(self.book_user_id())})

    def handle_book_progress_get(self, book_id):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        if not self.books_service().get_book(book_id, self.book_user_id()):
            self.send_json({"error": "Book not found"}, status=404)
            return
        self.send_json({"progress": self.books_service().progress(self.book_user_id(), book_id)})

    def handle_book_progress_post(self, book_id):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        payload = self.read_json_request(16384)
        self.send_json({"progress": self.books_service().save_progress(self.book_user_id(), book_id, payload)})

    def handle_book_library_status_post(self, book_id):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        payload = self.read_json_request(4096)
        self.send_json({"book": self.books_service().set_library_status(self.book_user_id(), book_id, payload.get("status"))})

    def handle_book_library_add_post(self, book_id):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        self.send_json({"book": self.books_service().add_to_library(self.book_user_id(), book_id)}, status=201)

    def handle_books_preferences_get(self):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        self.send_json({"preferences": self.books_service().preferences(self.book_user_id())})

    def handle_books_preferences_post(self):
        if not self.books_config().enabled:
            self.send_json({"error": "Books are disabled", "code": "feature_disabled"}, status=404)
            return
        payload = self.read_json_request(16384)
        self.send_json({"preferences": self.books_service().save_preferences(self.book_user_id(), payload)})

    def handle_book_epub(self, book_id):
        if not self.books_config().enabled:
            self.send_error(404, "Not found")
            return
        if not self.books_service().get_book(book_id, self.book_user_id()):
            self.send_error(404, "Not found")
            return
        path = self.books_service().epub_path(book_id)
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/epub+zip")
        self.send_header("Content-Disposition", f'inline; filename="book-{int(book_id)}.epub"')
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        try:
            with open(path, "rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    def mangabaka_json(self, path, method="GET", payload=None, token=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Invalid MangaBaka API path")
        headers = {
            "Accept": "application/json",
            "User-Agent": "Panels (+https://github.com/ahibbert/panels)",
        }
        active_token = token if token is not None else self.read_account_mangabaka_token()
        if active_token:
            headers["x-api-key"] = active_token
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"{MANGABAKA_API_BASE}{path}", data=body, headers=headers, method=method)
        try:
            with open_url(request, timeout=30) as response:
                content = response.read(6000000)
                if len(content) >= 6000000:
                    raise ValueError("MangaBaka response was too large")
                return json.loads(content.decode("utf-8") or "{}")
        except HTTPError as error:
            try:
                detail = json.loads(error.read(65536).decode("utf-8", errors="replace"))
                message = detail.get("message") or detail.get("error") or f"HTTP {error.code}"
            except Exception:
                message = f"HTTP {error.code}"
            raise RuntimeError(f"MangaBaka request failed: {message}") from error

    def read_json_request(self, maximum=131072):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > maximum:
            raise ValueError("Request body is empty or too large")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def handle_reading_stats_events(self):
        payload = self.read_json_request(524288)
        if not isinstance(payload, dict):
            raise ReadingStatsRequestError("Reading stats payload must be an object")
        version = payload.get("schemaVersion", 1)
        if version != ReadingStatsStore.SCHEMA_VERSION:
            raise ReadingStatsRequestError("Unsupported reading event schemaVersion", status=409)
        self.send_json(self.reading_stats_store().ingest(payload.get("events")))

    def handle_reading_stats_settings(self):
        payload = self.read_json_request(16384)
        self.send_json(self.reading_stats_store().update_settings(payload))

    def handle_reading_stats_reset(self):
        payload = self.read_json_request(16384)
        if not isinstance(payload, dict):
            raise ReadingStatsRequestError("Reset payload must be an object")
        self.send_json(self.reading_stats_store().reset(payload.get("confirm"), payload.get("scope", "all")))

    def handle_reading_stats_get(self, parsed):
        params = parse_qs(parsed.query)
        range_name = params.get("range", ["30d"])[0]
        self.send_json(self.reading_stats_store().summary(range_name))

    def handle_source_profiles_post(self):
        payload = self.read_json_request(65536)
        if not isinstance(payload, dict):
            raise ValueError("Source profile payload must be an object")
        self.send_json(SourceProfileStore().ingest(payload.get("observations")))

    @staticmethod
    def validate_source_intelligence_payload(payload, expected_fields):
        if not isinstance(payload, dict):
            raise SourceIntelligenceError("Source intelligence payload must be an object")
        unknown = sorted(set(payload) - {"schemaVersion", *expected_fields})
        if unknown:
            raise SourceIntelligenceError(
                f"Source intelligence payload contains unsupported fields: {', '.join(unknown)}"
            )
        if payload.get("schemaVersion") != SourceIntelligenceStore.SCHEMA_VERSION:
            raise SourceIntelligenceError("Unsupported source intelligence schemaVersion")

    def handle_source_intelligence_post(self, parsed):
        payload = self.read_json_request(524288)
        store = SourceIntelligenceStore(SOURCE_INTELLIGENCE_PATH)
        if parsed.path == "/api/source-intelligence/inventory":
            self.validate_source_intelligence_payload(payload, {"sources"})
            inventory = store.sync_inventory(payload.get("sources"))
            self.send_json({
                "schemaVersion": store.SCHEMA_VERSION,
                "inventory": inventory,
                "count": len(inventory),
            })
            return
        if parsed.path == "/api/source-intelligence/observations":
            self.validate_source_intelligence_payload(payload, {"observations"})
            scores = store.record_observations(payload.get("observations"))
            self.send_json({
                "schemaVersion": store.SCHEMA_VERSION,
                "accepted": len(payload.get("observations") or []),
                "scores": scores,
            })
            return
        if parsed.path == "/api/source-intelligence/benchmarks":
            self.validate_source_intelligence_payload(payload, {"run", "results"})
            self.send_json(store.record_benchmark(payload.get("run"), payload.get("results")))
            return
        self.send_json({"error": "Unknown source intelligence POST endpoint"}, status=404)

    def handle_source_intelligence_get(self, parsed):
        store = SourceIntelligenceStore(SOURCE_INTELLIGENCE_PATH)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/source-intelligence":
            media_format = params.get("format", [None])[0]
            self.send_json(store.summary(media_format))
            return
        if parsed.path == "/api/source-intelligence/inventory":
            inventory = store.inventory()
            self.send_json({
                "schemaVersion": store.SCHEMA_VERSION,
                "inventory": inventory,
                "count": len(inventory),
            })
            return
        if parsed.path == "/api/source-intelligence/scores":
            media_format = params.get("format", [None])[0]
            scores = store.scores(media_format)
            self.send_json({
                "schemaVersion": store.SCHEMA_VERSION,
                "scores": scores,
                "count": len(scores),
            })
            return
        if parsed.path == "/api/source-intelligence/benchmarks":
            run_id = params.get("runId", [None])[0]
            limit = params.get("limit", [10])[0]
            runs = store.benchmark_runs(limit=limit, run_id=run_id)
            self.send_json({
                "schemaVersion": store.SCHEMA_VERSION,
                "benchmarkRuns": runs,
                "count": len(runs),
            })
            return
        self.send_json({"error": "Unknown source intelligence GET endpoint"}, status=404)

    def handle_mangabaka_config_post(self):
        payload = self.read_json_request(16384)
        if payload.get("clear") is True:
            if os.environ.get("MANGABAKA_API_KEY", "").strip():
                raise ValueError("The MangaBaka token is configured by the server environment and cannot be removed here")
            write_mangabaka_token("", self.mangabaka_config_path())
            self.send_json({"configured": False})
            return
        token = str(payload.get("token") or "").strip()
        if not token.startswith("mb-") or len(token) < 12 or len(token) > 512:
            raise ValueError("Enter a valid MangaBaka Personal Access Token beginning with mb-")
        profile = self.mangabaka_json("/v1/my/profile", token=token)
        write_mangabaka_token(token, self.mangabaka_config_path())
        self.send_json({"configured": True, "profile": profile.get("data") or profile.get("profile") or {}})

    def handle_mangabaka_status(self):
        token = self.read_account_mangabaka_token()
        if not token:
            self.send_json({"configured": False, "connected": False})
            return
        try:
            profile = self.mangabaka_json("/v1/my/profile", token=token)
            readiness = self.mangabaka_json("/v1/my/series/recommendations/status", token=token)
        except Exception as error:
            self.send_json({"configured": True, "connected": False, "error": str(error)})
            return
        self.send_json({
            "configured": True,
            "connected": True,
            "profile": profile.get("data") or profile.get("profile") or {},
            "recommendations": readiness,
        })

    def handle_mangabaka_recommendations(self, parsed):
        params = parse_qs(parsed.query)
        limit = max(1, min(20, int(params.get("limit", [12])[0])))
        token = self.read_account_mangabaka_token()
        ratings = [("content_rating", "safe"), ("content_rating", "suggestive")]
        if token:
            query = urlencode([("limit", limit), *ratings])
            try:
                payload = self.mangabaka_json(f"/v1/my/series/recommendations?{query}", token=token)
                self.send_json({"configured": True, "mode": "personalized", **payload})
                return
            except Exception:
                # Discovery remains useful while a revoked or under-scoped token is repaired.
                token = ""

        public_rails = []
        per_rail = limit
        public_paths = (
            ("rising", "/v2/series/discover/rising"),
            ("hidden_gem", "/v2/series/discover/hidden-gems"),
        )
        for reason_type, path in public_paths:
            query = urlencode([("limit", per_rail), *ratings])
            payload = self.mangabaka_json(f"{path}?{query}", token="")
            rail = []
            for series in payload.get("data") or []:
                if str(series.get("type") or series.get("media_type") or "").lower() not in {"manga", "manhwa", "manhua", "oel"}:
                    continue
                rail.append({
                    **series,
                    "reason": {"reason_type": reason_type, "top_tags": [], "reason_seeds": []},
                })
            public_rails.append(rail)
        public_results = []
        for index in range(per_rail):
            for rail in public_rails:
                if index < len(rail):
                    public_results.append(rail[index])
        unique_results = []
        seen = set()
        for series in public_results:
            series_id = int(series.get("id") or 0)
            if not series_id or series_id in seen:
                continue
            seen.add(series_id)
            unique_results.append(series)
            if len(unique_results) >= limit:
                break
        self.send_json({"configured": False, "mode": "public", "results": unique_results})

    def handle_comic_recommendations(self, parsed):
        params = parse_qs(parsed.query)
        try:
            limit = max(1, min(20, int(params.get("limit", [12])[0])))
        except (TypeError, ValueError):
            self.send_json({"error": "limit must be an integer between 1 and 20"}, status=400)
            return

        service = build_comic_recommendation_service()
        if service is None:
            self.send_json({
                "schemaVersion": 1,
                "configured": False,
                "status": "unconfigured",
                "mode": "unconfigured",
                "seedTitles": [],
                "cacheKey": "",
                "cacheStatus": "disabled",
                "results": [],
            })
            return

        seeds = comic_seeds_from_library(self.read_library_items())
        if not seeds:
            self.send_json({
                "schemaVersion": 1,
                "configured": True,
                "status": "needs-library",
                "mode": "needs-library",
                "seedTitles": [],
                "cacheKey": "",
                "cacheStatus": "miss",
                "results": [],
            })
            return

        cache = ComicRecommendationCache()
        cache_key = service.cache_key(seeds, limit=limit)
        cached, cache_status = cache.get(cache_key)
        if cache_status == "hit":
            self.send_json({**cached, "configured": True, "status": "ready", "cacheStatus": "hit"})
            return

        feed = service.build_feed(seeds, limit=limit).to_public_dict()
        if feed.get("mode") == "unavailable":
            if cached is not None:
                self.send_json({**cached, "configured": True, "status": "ready", "cacheStatus": "stale"})
            else:
                self.send_json({**feed, "configured": True, "status": "unavailable", "cacheStatus": "miss"})
            return

        response_cache_status = "miss"
        try:
            cache.put(cache_key, feed)
        except OSError:
            response_cache_status = "bypass"
        self.send_json({**feed, "configured": True, "status": "ready", "cacheStatus": response_cache_status})

    def handle_comic_recommendations_config_get(self):
        config = read_comic_recommendations_config()
        self.send_json({
            "configured": bool(config["apiKey"]),
            "managedByEnvironment": bool(config["managedByEnvironment"]),
            "hasContact": bool(config["contact"]),
        })

    def handle_comic_recommendations_config_post(self):
        if not self.require_admin_account():
            return
        payload = self.read_json_request(16384)
        existing = read_comic_recommendations_config()
        if payload.get("clear") is True:
            if existing["managedByEnvironment"]:
                raise ValueError("The LibraryThing key is configured by the server environment and cannot be removed here")
            write_comic_recommendations_config("")
            self.send_json({"configured": False, "managedByEnvironment": False, "hasContact": False})
            return
        if existing["managedByEnvironment"]:
            raise ValueError("The LibraryThing key is configured by the server environment and cannot be replaced here")
        api_key = str(payload.get("apiKey") or "").strip()
        contact = str(payload.get("contact") or "").replace("\r", "").replace("\n", "").strip()[:200]
        if len(api_key) < 8 or len(api_key) > 500 or re.search(r"\s", api_key):
            raise ValueError("Enter a valid LibraryThing developer key")
        write_comic_recommendations_config(api_key, contact)
        self.send_json({"configured": True, "managedByEnvironment": False, "hasContact": bool(contact)})

    def handle_mangabaka_search(self, parsed):
        params = parse_qs(parsed.query)
        query = str(params.get("q", [""])[0]).strip()
        if not query or len(query) > 300:
            raise ValueError("Enter a MangaBaka search title")
        api_query = urlencode({"q": query, "limit": 8, "schema": "full"})
        payload = self.mangabaka_json(f"/v2/series/search?{api_query}", token="")
        self.send_json(payload)

    def handle_mangabaka_library_post(self):
        token = self.read_account_mangabaka_token()
        if not token:
            self.send_json({"error": "Connect MangaBaka before syncing reading progress"}, status=409)
            return
        payload = self.read_json_request(131072)
        expected_account = str(payload.get("accountKey") or "").strip()
        if not expected_account or len(expected_account) > 200:
            raise ValueError("MangaBaka library sync requires the connected account identity")
        profile_payload = self.mangabaka_json("/v1/my/profile", token=token)
        profile = profile_payload.get("data") or profile_payload.get("profile") or {}
        active_account = str(profile.get("id") or profile.get("uuid") or profile.get("preferred_username") or "")
        if not active_account or not hmac.compare_digest(active_account, expected_account):
            self.send_json({"error": "MangaBaka account changed before this sync could finish"}, status=409)
            return
        entries = payload.get("entries")
        if not isinstance(entries, list) or not entries or len(entries) > 100:
            raise ValueError("MangaBaka library sync expects 1 to 100 entries")
        allowed_states = {"considering", "completed", "dropped", "paused", "plan_to_read", "reading", "rereading"}
        cleaned = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            series_id = int(entry.get("series_id") or 0)
            state = str(entry.get("state") or "reading")
            if series_id < 1 or state not in allowed_states:
                continue
            output = {"series_id": series_id, "state": state}
            progress = entry.get("progress_chapter")
            if isinstance(progress, (int, float)) and 0 <= progress <= 10000:
                output["progress_chapter"] = progress
            cleaned.append(output)
        if not cleaned:
            raise ValueError("No valid MangaBaka library entries were supplied")
        result = self.mangabaka_json("/v1/my/library/batch", method="POST", payload=cleaned, token=token)
        self.send_json(result)

    def handle_panel_report_post(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 4000000:
            raise ValueError("Panel report payload is too large")
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        report = self.clean_panel_report(payload)
        report_id = report["id"]

        image_data = payload.get("snapshotDataUrl")
        if isinstance(image_data, str) and image_data.startswith("data:image/"):
            header, _, encoded = image_data.partition(",")
            extension = ".jpg" if "jpeg" in header or "jpg" in header else ".png"
            image_bytes = base64.b64decode(encoded, validate=True)
            if len(image_bytes) > 2500000:
                raise ValueError("Panel report snapshot is too large")
            report["snapshotFile"] = f"{report_id}{extension}"

        with REPORT_LOCK:
            os.makedirs(REPORTS_PATH, exist_ok=True)
            if report.get("snapshotFile"):
                with open(os.path.join(REPORTS_PATH, report["snapshotFile"]), "wb") as handle:
                    handle.write(image_bytes)
            report_path = os.path.join(REPORTS_PATH, f"{report_id}.json")
            with open(report_path, "w", encoding="utf-8") as handle:
                json.dump(report, handle, ensure_ascii=True, indent=2)
                handle.write("\n")

        self.send_json({"id": report_id, "saved": True, "path": f"panel-reports/{report_id}.json"})

    def clean_panel_report(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Panel report must be an object")
        created = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        title = self.clean_text(payload.get("chapterTitle") or payload.get("mangaTitle") or "panel-report", 60)
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", title).strip("-").lower()[:42] or "panel-report"
        report_id = f"{created}-{slug}"
        text_fields = (
            "appVersion",
            "detectorVersion",
            "mangaTitle",
            "sourceId",
            "sourceLabel",
            "chapterTitle",
            "activeChapterType",
            "panelMode",
            "readingDirection",
            "pageUrl",
        )
        number_fields = ("mangaId", "chapterId", "pageIndex", "panelIndex", "naturalWidth", "naturalHeight")
        report = {
            "id": report_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        for field in text_fields:
            value = payload.get(field)
            if isinstance(value, (str, int, float)):
                report[field] = self.clean_text(value, 1200)
        for field in number_fields:
            value = payload.get(field)
            if isinstance(value, (int, float)) and value >= 0:
                report[field] = value
        report["selectedPanel"] = self.clean_panel(payload.get("selectedPanel"))
        panels = payload.get("panels")
        if isinstance(panels, list):
            report["panels"] = [self.clean_panel(panel) for panel in panels[:80] if self.clean_panel(panel)]
        else:
            report["panels"] = []
        bubbles = payload.get("bubbles")
        if isinstance(bubbles, list):
            report["bubbles"] = [self.clean_panel(bubble) for bubble in bubbles[:120] if self.clean_panel(bubble)]
        else:
            report["bubbles"] = []
        return report

    def clean_text(self, value, limit):
        return str(value).replace("\x00", "")[:limit]

    def clean_panel(self, panel):
        if not isinstance(panel, dict):
            return None
        output = {}
        for field in ("x", "y", "w", "h", "pageWidth", "pageHeight"):
            value = panel.get(field)
            if isinstance(value, (int, float)):
                output[field] = value
        label = panel.get("label")
        if isinstance(label, str):
            output["label"] = label[:80]
        return output if output else None

    def handle_library_get(self):
        self.send_json({"items": self.read_library_items()})

    def handle_library_post(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2000000:
            raise ValueError("Library payload is too large")
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        items = payload.get("items", [])
        if not isinstance(items, list):
            raise ValueError("Library items must be an array")
        stored = self.write_library_items(items)
        self.send_json({"items": stored})

    def handle_library_migrate_post(self):
        payload = self.read_json_request(2000000)
        if not isinstance(payload, dict):
            raise ValueError("Library migration payload must be an object")
        previous = payload.get("from")
        replacement = payload.get("item")
        if not isinstance(previous, dict) or not isinstance(replacement, dict):
            raise ValueError("Library migration requires from and item objects")
        stored = self.migrate_library_item(previous, replacement)
        self.send_json({"items": stored})

    def moments_root(self):
        root = Path(self.account_data_path(MOMENTS_PATH, "moments")).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    def valid_moment_id(self, moment_id):
        if not MOMENT_ID_PATTERN.fullmatch(str(moment_id or "")):
            raise ValueError("Invalid moment id")
        return str(moment_id)

    def clean_moment_text(self, value, limit):
        return str(value or "").replace("\x00", "").strip()[:limit]

    def clean_moment_metadata(self, payload, moment_id, image_name, byte_size, created_at):
        def clean_integer(name, minimum=0, maximum=100000):
            try:
                value = int(payload.get(name, 0))
            except (TypeError, ValueError):
                value = 0
            return max(minimum, min(maximum, value))

        media_format = self.clean_moment_text(payload.get("mediaFormat"), 16)
        if media_format not in ("manga", "comic", "webtoon"):
            media_format = "manga"
        return {
            "id": moment_id,
            "title": self.clean_moment_text(payload.get("title"), 300) or "Untitled",
            "chapterTitle": self.clean_moment_text(payload.get("chapterTitle"), 300),
            "sourceLabel": self.clean_moment_text(payload.get("sourceLabel"), 200),
            "isNsfw": bool(payload.get("isNsfw")),
            "mediaFormat": media_format,
            "pageIndex": clean_integer("pageIndex"),
            "panelIndex": clean_integer("panelIndex"),
            "width": clean_integer("width", 1, 12000),
            "height": clean_integer("height", 1, 24000),
            "createdAt": created_at,
            "imageName": image_name,
            "byteSize": byte_size,
            "imageUrl": f"/api/moments/{moment_id}/image",
        }

    def handle_moments_post(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 24000000:
            raise ValueError("Moment payload is empty or too large")
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        encoded = payload.get("imageDataUrl", "")
        match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)", str(encoded))
        if not match:
            raise ValueError("Moment must contain a JPEG, PNG, or WebP image")
        try:
            image_bytes = base64.b64decode(match.group(2), validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("Moment image is not valid base64") from error
        if not image_bytes or len(image_bytes) > 16000000:
            raise ValueError("Moment image is empty or too large")
        mime_type = match.group(1)
        signatures = {
            "image/jpeg": image_bytes.startswith(b"\xff\xd8\xff"),
            "image/png": image_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/webp": image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP",
        }
        if not signatures.get(mime_type):
            raise ValueError("Moment image contents do not match its media type")
        extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime_type]
        moment_id = f"{int(time.time() * 1000):013d}-{secrets.token_hex(8)}"
        image_name = f"{moment_id}.{extension}"
        created_at = datetime.now(timezone.utc).isoformat()
        metadata = self.clean_moment_metadata(payload, moment_id, image_name, len(image_bytes), created_at)
        root = self.moments_root()
        with MOMENTS_LOCK:
            image_path = root / image_name
            metadata_path = root / f"{moment_id}.json"
            with tempfile.NamedTemporaryFile(dir=root, prefix=".moment-", delete=False) as temporary:
                temporary.write(image_bytes)
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, image_path)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=root, prefix=".moment-", delete=False) as temporary:
                json.dump(metadata, temporary, ensure_ascii=False, separators=(",", ":"))
                temporary_metadata_path = Path(temporary.name)
            os.replace(temporary_metadata_path, metadata_path)
        self.send_json({"moment": metadata}, status=201)

    def read_moments(self):
        root = self.moments_root()
        moments = []
        with MOMENTS_LOCK:
            for metadata_path in root.glob("*.json"):
                try:
                    with open(metadata_path, "r", encoding="utf-8") as handle:
                        metadata = json.load(handle)
                    if not isinstance(metadata, dict):
                        continue
                    moment_id = self.valid_moment_id(metadata.get("id"))
                    image_name = str(metadata.get("imageName", ""))
                    if image_name != Path(image_name).name or not (root / image_name).is_file():
                        continue
                    metadata["imageUrl"] = f"/api/moments/{moment_id}/image"
                    moments.append(metadata)
                except (OSError, ValueError, json.JSONDecodeError, TypeError):
                    continue
        return sorted(moments, key=lambda item: item.get("createdAt", ""), reverse=True)[:2000]

    def handle_moments_get(self):
        self.send_json({"moments": self.read_moments()})

    def handle_moment_image_get(self, moment_id):
        moment_id = self.valid_moment_id(moment_id)
        root = self.moments_root()
        metadata_path = root / f"{moment_id}.json"
        try:
            with MOMENTS_LOCK:
                with open(metadata_path, "r", encoding="utf-8") as handle:
                    metadata = json.load(handle)
                if not isinstance(metadata, dict):
                    raise FileNotFoundError
                image_name = str(metadata.get("imageName", ""))
                if image_name != Path(image_name).name:
                    raise FileNotFoundError
                image_path = root / image_name
                body = image_path.read_bytes()
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            self.send_json({"error": "Moment not found"}, status=404)
            return
        content_type = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(image_path.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "private, max-age=86400")
        self.send_header("Content-Disposition", f'inline; filename="panels-moment-{moment_id}{image_path.suffix}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_moment_delete(self, moment_id):
        moment_id = self.valid_moment_id(moment_id)
        root = self.moments_root()
        metadata_path = root / f"{moment_id}.json"
        deleted = False
        with MOMENTS_LOCK:
            try:
                with open(metadata_path, "r", encoding="utf-8") as handle:
                    metadata = json.load(handle)
                if not isinstance(metadata, dict):
                    raise FileNotFoundError
                image_name = str(metadata.get("imageName", ""))
                if image_name == Path(image_name).name:
                    image_path = root / image_name
                    if image_path.is_file():
                        image_path.unlink()
                metadata_path.unlink()
                deleted = True
            except FileNotFoundError:
                pass
        self.send_json({"deleted": deleted, "id": moment_id}, status=200 if deleted else 404)

    def read_library_items(self):
        library_path = self.library_path()
        with LIBRARY_LOCK:
            try:
                with open(library_path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
            except FileNotFoundError:
                return []
            if isinstance(payload, dict):
                items = payload.get("items", [])
            else:
                items = payload
            cleaned = self.clean_library_items(items)
            if cleaned != items or not isinstance(payload, dict):
                try:
                    self._replace_library_items_locked(cleaned)
                except OSError:
                    # Keep serving the sanitized in-memory view if migration cannot
                    # write immediately; the next successful write retries it.
                    print(
                        "Warning: could not persist the sanitized library migration; it will be retried.",
                        file=sys.stderr,
                        flush=True,
                    )
            return cleaned

    def _replace_library_items_locked(self, items):
        library_path = self.library_path()
        directory = os.path.dirname(library_path) or "."
        os.makedirs(directory, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(prefix=".library-", suffix=".json", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"items": items}, handle, ensure_ascii=True, indent=2)
                handle.write("\n")
            os.replace(temp_path, library_path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def write_library_items(self, items):
        cleaned = self.clean_library_items(items)
        library_path = self.library_path()
        with LIBRARY_LOCK:
            try:
                with open(library_path, "r", encoding="utf-8") as handle:
                    existing_payload = json.load(handle)
                existing = self.clean_library_items(
                    existing_payload.get("items", []) if isinstance(existing_payload, dict) else existing_payload
                )
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                existing = []
            cleaned = self.merge_library_items(cleaned, existing)
            self._replace_library_items_locked(cleaned)
        return cleaned

    def migrate_library_item(self, previous, replacement):
        previous_source_id = str(previous.get("sourceId") or "").strip()
        previous_manga_id = previous.get("mangaId")
        if not previous_source_id or not isinstance(previous_manga_id, int) or previous_manga_id < 1:
            raise ValueError("Previous library identity is invalid")
        cleaned_replacement = self.clean_library_items([replacement])
        if len(cleaned_replacement) != 1:
            raise ValueError("Replacement library item is invalid")
        replacement_item = cleaned_replacement[0]
        previous_key = f"{previous_source_id}:{previous_manga_id}"
        replacement_key = f"{replacement_item.get('sourceId', 'source')}:{replacement_item.get('mangaId', '')}"
        with LIBRARY_LOCK:
            library_path = self.library_path()
            try:
                with open(library_path, "r", encoding="utf-8") as handle:
                    existing_payload = json.load(handle)
                existing = self.clean_library_items(
                    existing_payload.get("items", []) if isinstance(existing_payload, dict) else existing_payload
                )
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                existing = []
            retained = [
                item for item in existing
                if f"{item.get('sourceId', 'source')}:{item.get('mangaId', '')}" not in (previous_key, replacement_key)
            ]
            stored = [replacement_item, *retained][:LIBRARY_LIMIT]
            self._replace_library_items_locked(stored)
        return stored

    def merge_library_items(self, incoming, existing):
        incoming_by_key = {
            f"{item.get('sourceId', 'source')}:{item.get('mangaId', '')}": item
            for item in incoming
        }
        existing_by_key = {
            f"{item.get('sourceId', 'source')}:{item.get('mangaId', '')}": item
            for item in existing
        }
        ordered_keys = list(incoming_by_key)
        ordered_keys.extend(key for key in existing_by_key if key not in incoming_by_key)
        merged = []
        for key in ordered_keys:
            new_item = incoming_by_key.get(key)
            old_item = existing_by_key.get(key)
            if not old_item:
                merged.append(new_item)
                continue
            if not new_item:
                merged.append(old_item)
                continue
            new_updated = str(new_item.get("updatedAt") or "")
            old_updated = str(old_item.get("updatedAt") or "")
            merged.append(new_item if new_updated >= old_updated else old_item)
        return merged[:LIBRARY_LIMIT]

    def clean_library_items(self, items):
        if not isinstance(items, list):
            return []
        cleaned = []
        seen = set()
        text_fields = ("mangaTitle", "sourceId", "sourceLabel", "chapterTitle", "panelMode", "mediaFormat", "readingDirection", "progressLabel", "updatedAt", "libraryStatus", "mangabakaTitle", "mangabakaMatchSource", "mangabakaAccountKey")
        number_fields = ("mangaId", "chapterId", "pageIndex", "panelIndex", "mangabakaId")
        bool_fields = ("pinned", "hidden", "isNsfw", "privateSource", "statusExplicit", "suwayomiLibrary", "started")
        for item in items:
            if not isinstance(item, dict):
                continue
            output = {}
            for field in number_fields:
                value = item.get(field)
                if isinstance(value, int) and value >= 0:
                    output[field] = value
            completed_chapter = item.get("completedChapter")
            if isinstance(completed_chapter, (int, float)) and completed_chapter >= 0:
                output["completedChapter"] = completed_chapter
            for field in text_fields:
                value = item.get(field)
                if isinstance(value, (str, int, float)):
                    output[field] = str(value)[:300]
            if output.get("mediaFormat") not in ("manga", "comic", "webtoon"):
                output.pop("mediaFormat", None)
            server_url = sanitize_library_server_url(item.get("serverUrl"))
            if server_url:
                output["serverUrl"] = server_url[:300]
            thumbnail_url = item.get("thumbnailUrl")
            if isinstance(thumbnail_url, str):
                output["thumbnailUrl"] = thumbnail_url[:2000]
            for field in bool_fields:
                output[field] = bool(item.get(field))
            key = f"{output.get('sourceId', 'source')}:{output.get('mangaId', '')}"
            if not output.get("mangaId") or key in seen:
                continue
            seen.add(key)
            cleaned.append(output)
            if len(cleaned) >= LIBRARY_LIMIT:
                break
        return cleaned

    def resolve_suwayomi_base(self, raw_base):
        base = normalize_suwayomi_base_url(raw_base)
        parsed_base = urlparse(base)
        internal_base = normalize_suwayomi_base_url(os.environ["SUWAYOMI_INTERNAL_URL"]) if os.environ.get("SUWAYOMI_INTERNAL_URL", "").strip() else ""
        using_internal_base = False
        if internal_base and parsed_base.hostname in ("localhost", "127.0.0.1", "::1"):
            base = internal_base
            parsed_base = urlparse(base)
            using_internal_base = True
        if not using_internal_base and not self.suwayomi_host_is_local(parsed_base.hostname):
            raise ValueError("Suwayomi proxy only allows localhost or private LAN URLs")
        return base

    def validate_suwayomi_url(self, parsed_url):
        validate_suwayomi_url(parsed_url)

    def suwayomi_host_is_local(self, host):
        normalized_host = (host or "").lower()
        if normalized_host == "localhost":
            return True
        try:
            address = ipaddress.ip_address(normalized_host)
        except ValueError:
            return False
        private_networks = (
            ipaddress.ip_network("10.0.0.0/8"),
            ipaddress.ip_network("172.16.0.0/12"),
            ipaddress.ip_network("192.168.0.0/16"),
            ipaddress.ip_network("fc00::/7"),
        )
        return address.is_loopback or address.is_unspecified or any(
            address in network for network in private_networks
        )

    def suwayomi_headers(self, accept="application/json", content_type=None):
        headers = {
            "Accept": accept,
            "User-Agent": USER_AGENT,
        }
        if content_type:
            headers["Content-Type"] = content_type
        suwayomi_user, suwayomi_password = suwayomi_auth_credentials()
        if suwayomi_user and suwayomi_password:
            token = base64.b64encode(f"{suwayomi_user}:{suwayomi_password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        return headers

    def handle_suwayomi_graphql(self, parsed):
        params = parse_qs(parsed.query)
        base = self.resolve_suwayomi_base(params.get("base", ["http://localhost:4567"])[0])
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 2000000:
            raise ValueError("Suwayomi GraphQL request is empty or too large")
        body = self.rfile.read(length)
        request = Request(
            f"{base}/api/graphql",
            data=body,
            headers=self.suwayomi_headers(content_type="application/json"),
            method="POST",
        )
        with open_url(request, timeout=30) as response:
            payload = response.read(16000001)
            if len(payload) > 16000000:
                raise ValueError("Suwayomi GraphQL response was too large")
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type") or "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def handle_suwayomi_asset(self, parsed):
        params = parse_qs(parsed.query)
        base = self.resolve_suwayomi_base(params.get("base", ["http://localhost:4567"])[0])
        path = safe_suwayomi_asset_path(params.get("path", [""])[0])

        request = Request(
            f"{base}{path}",
            headers=self.suwayomi_headers(accept="image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
            method="GET",
        )
        with open_url(request, timeout=30) as response:
            payload = response.read(64000001)
            if len(payload) > 64000000:
                raise ValueError("Suwayomi asset was too large")
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type") or "application/octet-stream")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def handle_comick_chapters(self, parsed):
        params = parse_qs(parsed.query)
        raw_url = params.get("url", [""])[0]
        lang = params.get("lang", ["en"])[0] or "en"
        slug = comick_slug_from_url(raw_url)
        upstream_params = {"lang": lang}
        for key in ("chap", "page", "chapOrder", "dateOrder"):
            value = params.get(key, [""])[0]
            if value:
                upstream_params[key] = value
        api_url = f"https://comick.live/api/comics/{quote(slug)}/chapter-list?{urlencode(upstream_params)}"
        _, _, body = fetch_url(api_url, accept="application/json")
        payload = json.loads(body.decode("utf-8"))
        chapters = []
        requested_chap = params.get("chap", [""])[0].strip()

        for chapter in payload.get("data", []):
            hid = chapter.get("hid")
            chap = chapter.get("chap")
            chapter_lang = chapter.get("lang") or lang
            if not hid or not chap:
                continue
            if requested_chap and str(chap).strip() != requested_chap:
                continue
            title = chapter.get("title") or ""
            label = f"Chapter {chap}"
            if title:
                label += f" - {title}"
            chapters.append(
                {
                    "hid": hid,
                    "chap": chap,
                    "lang": chapter_lang,
                    "title": title,
                    "label": label,
                    "group": ", ".join(chapter.get("group_name") or []),
                    "url": f"https://comick.live/comic/{slug}/{hid}-chapter-{chap}-{chapter_lang}",
                }
            )

        self.send_json({"slug": slug, "lang": lang, "chapters": chapters})

    def handle_comick_chapter(self, parsed):
        params = parse_qs(parsed.query)
        raw_url = safe_comick_page_url(params.get("url", [""])[0])
        _, _, body = fetch_url(raw_url, accept="text/html")
        text = body.decode("utf-8", errors="replace")

        escaped = re.findall(r"https?:\\\/\\\/[^\"']+?\.webp", text)
        direct = re.findall(r"https?://[^\"']+?\.webp", text)
        page_urls = []
        for value in escaped:
            page_urls.append(html.unescape(value).replace("\\/", "/"))
        for value in direct:
            page_urls.append(html.unescape(value))

        page_urls = [
            value
            for value in unique(page_urls)
            if "comicknew.pictures" in value and "/covers/" not in value
        ]
        page_urls.sort(key=self.image_page_sort_key)
        proxied = [f"/api/image?url={quote(value, safe='')}" for value in page_urls]
        title_match = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        title = html.unescape(title_match.group(1)).strip() if title_match else "Comick chapter"
        self.send_json({"title": title, "pages": proxied, "sourcePages": page_urls})

    def handle_readcomiconline_chapter(self, parsed):
        params = parse_qs(parsed.query)
        raw_url = safe_readcomiconline_url(params.get("url", [""])[0])
        _, _, body = fetch_url(raw_url, accept="text/html", referer="https://readcomiconline.li/")
        text = body.decode("utf-8", errors="replace")

        page_urls = []
        blocks = re.findall(r"pth\s*=\s*'([^']+)';(.*?)(?:_\w+\.push\(pth\);)", text, re.DOTALL)
        for raw_path, script_block in blocks:
            try:
                replacements = re.findall(
                    r"pth\s*=\s*pth\.replace\(/(.+?)/g,\s*'([^']*)'\);",
                    script_block,
                )
                page_urls.append(decode_readcomiconline_path(raw_path, replacements))
            except Exception:
                continue
        page_urls = unique(page_urls)
        if not page_urls:
            page_urls = unique(
                html.unescape(value)
                for value in re.findall(r"https://[^'\"\s<>]+?bp\.blogspot\.com/[^'\"\s<>]+", text)
            )

        proxied = [f"/api/image?url={quote(value, safe='')}" for value in page_urls]
        title_match = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        title = html.unescape(title_match.group(1)).strip() if title_match else "ReadComicOnline chapter"
        self.send_json({"title": title, "pages": proxied, "sourcePages": page_urls})

    def handle_image_proxy(self, parsed):
        params = parse_qs(parsed.query)
        raw_url = safe_image_url(unquote(params.get("url", [""])[0]))
        image_host = urlparse(raw_url).hostname or ""
        referer = "https://readcomiconline.li/" if host_matches_domain(image_host, "bp.blogspot.com") else "https://comick.live/"
        _, headers, body = fetch_url(
            raw_url,
            accept="image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            referer=referer,
        )
        content_type = headers.get("Content-Type") or "image/webp"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def image_page_sort_key(self, url):
        match = re.search(r"/(\d+)\.webp(?:$|\?)", url)
        return int(match.group(1)) if match else 999999

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json_attachment(self, payload, filename):
        body = json.dumps(payload).encode("utf-8")
        safe_filename = re.sub(r"[^a-zA-Z0-9._-]", "-", filename)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Disposition", f'attachment; filename="{safe_filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global DOWNLOAD_BUFFER_MANAGER, BOOKS_SERVICE, ACCOUNT_STORE
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
    bind_address = resolve_bind_address()
    validate_runtime_security(bind_address)
    ACCOUNT_STORE = account_store()
    suwayomi_auth_credentials()
    normalize_suwayomi_base_url(os.environ.get("SUWAYOMI_INTERNAL_URL", "http://localhost:4567"))
    os.umask(0o077)
    static_root = resolve_static_root()
    DOWNLOAD_BUFFER_MANAGER = DownloadBufferManager()
    DOWNLOAD_BUFFER_MANAGER.start()
    books_config = BooksConfig.from_environment(DATA_ROOT)
    if books_config.enabled:
        owner = next((account for account in ACCOUNT_STORE.list_accounts() if account["isAdmin"]), None)
        legacy_username, _ = panel_auth_credentials()
        BOOKS_SERVICE = BooksService(
            books_config,
            owner_user_id=(owner or {}).get("id") or "local",
            legacy_owner_username=legacy_username,
        )
        BOOKS_SERVICE.start()
    handler = lambda *args, **kwargs: PanelPilotHandler(*args, directory=static_root, **kwargs)
    server = ThreadingHTTPServer((bind_address, port), handler)
    print(f"Panels server running on http://{bind_address}:{port} from {static_root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
