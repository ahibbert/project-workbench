"""Small, typed Shelfmark JSON API client used only by the books feature."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler


class ShelfmarkError(RuntimeError):
    """A normalized Shelfmark failure safe to return to an authenticated user."""

    def __init__(self, message: str, *, code: str = "unavailable", status: int = 502):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class ShelfmarkConfig:
    base_url: str
    api_key: str
    timeout_seconds: float = 15.0

    def __post_init__(self) -> None:
        parsed = urlparse(self.base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("SHELFMARK_BASE_URL must be an http(s) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("SHELFMARK_BASE_URL must not contain credentials, a query, or a fragment")
        if not self.api_key.strip():
            raise ValueError("SHELFMARK_API_KEY is required")


class _SameOriginRedirectHandler(HTTPRedirectHandler):
    def __init__(self, origin: tuple[str, str, int | None]):
        super().__init__()
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlparse(newurl)
        target = (parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port)
        if target != self.origin:
            raise ShelfmarkError("Shelfmark redirected to an unexpected host", code="unsafe_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlparse(url)
    return (parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port)


def _first_list(payload: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in keys:
        candidate = payload.get(key)
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
        if isinstance(candidate, dict):
            nested = _first_list(candidate, keys)
            if nested:
                return nested
    return []


def _text(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _authors(value: Any) -> list[str]:
    if isinstance(value, str):
        values = [part.strip() for part in value.split(",")]
    elif isinstance(value, list):
        values = [item.get("name") if isinstance(item, dict) else item for item in value]
    else:
        values = []
    return [_text(item, 200) for item in values if _text(item, 200)][:20]


def normalize_metadata_results(payload: Any) -> list[dict[str, Any]]:
    """Normalize known Shelfmark metadata-provider response shapes."""
    normalized: list[dict[str, Any]] = []
    for item in _first_list(payload, ("results", "books", "items", "data")):
        provider = _text(item.get("provider") or item.get("source"), 100)
        provider_id = _text(
            item.get("book_id") or item.get("bookId") or item.get("provider_id") or item.get("provider_book_id") or item.get("id"),
            300,
        )
        title = _text(item.get("title"), 500)
        if not provider_id or not title:
            continue
        identifiers = item.get("identifiers") if isinstance(item.get("identifiers"), dict) else {}
        normalized.append({
            "provider": provider,
            "providerBookId": provider_id,
            "title": title,
            "subtitle": _text(item.get("subtitle"), 500),
            "authors": _authors(item.get("authors") or item.get("author")),
            "description": _text(item.get("description") or item.get("summary"), 5000),
            "coverUrl": _text(item.get("cover_url") or item.get("coverUrl") or item.get("thumbnail"), 2000),
            "isbn": _text(item.get("isbn") or identifiers.get("isbn") or identifiers.get("ISBN"), 40),
            "language": _text(item.get("language"), 40),
            "publishedDate": _text(item.get("published_date") or item.get("publishedDate") or item.get("year"), 40),
        })
    return normalized


def _is_epub(item: dict[str, Any]) -> bool:
    values = (
        item.get("format"), item.get("extension"), item.get("file_type"), item.get("content_type"),
        item.get("media_type"), item.get("title"),
    )
    joined = " ".join(_text(value, 300).lower() for value in values)
    return "epub" in joined or joined.strip() == "ebook"


def normalize_releases(payload: Any) -> list[dict[str, Any]]:
    """Return only EPUB releases while retaining the full object server-side."""
    normalized: list[dict[str, Any]] = []
    for item in _first_list(payload, ("releases", "results", "items", "data")):
        if not _is_epub(item):
            continue
        source = _text(item.get("source") or item.get("provider"), 100)
        source_id = _text(item.get("source_id") or item.get("sourceId") or item.get("id"), 500)
        if not source or not source_id:
            continue
        size = item.get("size") or item.get("size_bytes") or item.get("sizeBytes")
        try:
            size_bytes = max(0, int(size)) if size is not None else None
        except (TypeError, ValueError):
            size_bytes = None
        normalized.append({
            "id": source_id,
            "source": source,
            "title": _text(item.get("title") or item.get("name"), 500),
            "language": _text(item.get("language"), 40),
            "format": "EPUB",
            "sizeBytes": size_bytes,
            "seeders": item.get("seeders") if isinstance(item.get("seeders"), int) else None,
            "_release": item,
        })
    return normalized


class ShelfmarkClient:
    def __init__(self, config: ShelfmarkConfig):
        self.config = config
        self.base_url = config.base_url.rstrip("/") + "/"
        self._opener = build_opener(_SameOriginRedirectHandler(_origin(self.base_url)))

    def _redact(self, value: str) -> str:
        redacted = value.replace(self.config.api_key, "[redacted]")
        return redacted.replace(self.base_url.rstrip("/"), "Shelfmark")

    def _request(self, path: str, *, query: dict[str, str] | None = None, method: str = "GET", payload: Any = None, authenticated: bool = True) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Shelfmark API path must be absolute")
        url = urljoin(self.base_url, path.lstrip("/"))
        if query:
            url += "?" + urlencode(query)
        headers = {"Accept": "application/json", "User-Agent": "Panels/Books"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.config.timeout_seconds) as response:
                if _origin(response.geturl()) != _origin(self.base_url):
                    raise ShelfmarkError("Shelfmark returned an unexpected host", code="unsafe_redirect")
                content = response.read(8_000_001)
                if len(content) > 8_000_000:
                    raise ShelfmarkError("Shelfmark response was too large", code="response_too_large")
                return json.loads(content.decode("utf-8") or "{}")
        except ShelfmarkError:
            raise
        except HTTPError as error:
            status = 401 if error.code in (401, 403) else 502
            code = "authentication_failed" if status == 401 else "upstream_error"
            raise ShelfmarkError(f"Shelfmark request failed (HTTP {error.code})", code=code, status=status) from None
        except (URLError, TimeoutError, OSError) as error:
            reason = self._redact(str(getattr(error, "reason", error)))[:300]
            raise ShelfmarkError(f"Shelfmark is unavailable: {reason}", code="unavailable") from None
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ShelfmarkError("Shelfmark returned invalid JSON", code="invalid_response") from None

    def health(self) -> dict[str, Any]:
        payload = self._request("/api/health", authenticated=False)
        return {"ok": True, "status": _text(payload.get("status") if isinstance(payload, dict) else "ok", 80) or "ok"}

    def status(self) -> dict[str, Any]:
        payload = self._request("/api/status")
        return {"ok": True, "status": _text(payload.get("status") if isinstance(payload, dict) else "ok", 80) or "ok"}

    def search(self, query: str) -> list[dict[str, Any]]:
        query = _text(query, 300)
        if len(query) < 2:
            raise ValueError("Book search query must contain at least two characters")
        return normalize_metadata_results(self._request("/api/metadata/search", query={"query": query}))

    def releases(self, provider: str, provider_book_id: str) -> list[dict[str, Any]]:
        payload = self._request("/api/releases", query={
            "provider": _text(provider, 100),
            "book_id": _text(provider_book_id, 300),
            "content_type": "ebook",
        })
        return normalize_releases(payload)

    def queue_download(self, release: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(release, dict) or not release.get("source") or not (release.get("source_id") or release.get("sourceId") or release.get("id")):
            raise ValueError("Shelfmark release is missing its source identifier")
        payload = self._request("/api/releases/download", method="POST", payload=release)
        if not isinstance(payload, dict):
            raise ShelfmarkError("Shelfmark returned an invalid download response", code="invalid_response")
        return payload

    def downloads(self) -> Any:
        try:
            return self._request("/api/downloads/active")
        except ShelfmarkError as error:
            if error.code not in ("upstream_error", "invalid_response"):
                raise
            return self._request("/api/status")
