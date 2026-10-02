"""Authenticated, same-origin OPDS 1 adapter for Calibre-Web Automated."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import html
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, urljoin, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from xml.etree import ElementTree


ATOM = "{http://www.w3.org/2005/Atom}"
DC = "{http://purl.org/dc/terms/}"
OPDS_ACQUISITION = "http://opds-spec.org/acquisition"
EPUB_MEDIA_TYPE = "application/epub+zip"


class OpdsError(RuntimeError):
    def __init__(self, message: str, *, code: str = "unavailable", status: int = 502):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class OpdsConfig:
    url: str
    username: str
    password: str
    timeout_seconds: float = 15.0

    def __post_init__(self) -> None:
        parsed = urlparse(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("CWA_OPDS_URL must be an http(s) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("CWA_OPDS_URL must not contain credentials, a query, or a fragment")
        if not self.username or not self.password:
            raise ValueError("CWA OPDS username and password are required")


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlparse(url)
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


class _SameOriginRedirectHandler(HTTPRedirectHandler):
    def __init__(self, origin: tuple[str, str, int | None]):
        super().__init__()
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _origin(newurl) != self.origin:
            raise OpdsError("CWA redirected to an unexpected host", code="unsafe_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _clean_html(value: str | None, limit: int = 10_000) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()[:limit]


def _text(element: ElementTree.Element | None, limit: int = 1000) -> str:
    return (element.text or "").replace("\x00", "").strip()[:limit] if element is not None else ""


def parse_opds_feed(xml_bytes: bytes, feed_url: str) -> dict[str, Any]:
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError:
        raise OpdsError("CWA returned malformed OPDS XML", code="invalid_feed") from None
    if root.tag != ATOM + "feed":
        raise OpdsError("CWA response is not an OPDS feed", code="invalid_feed")

    books: list[dict[str, Any]] = []
    navigation_hrefs: list[str] = []
    for entry in root.findall(ATOM + "entry"):
        entry_id = _text(entry.find(ATOM + "id"), 1000)
        title = _text(entry.find(ATOM + "title"), 1000)
        if not entry_id or not title:
            continue
        authors = [_text(author.find(ATOM + "name"), 300) for author in entry.findall(ATOM + "author")]
        authors = [author for author in authors if author]
        links = []
        for link in entry.findall(ATOM + "link"):
            href = link.get("href", "").strip()
            if not href:
                continue
            links.append({
                "rel": link.get("rel", "").strip(),
                "type": link.get("type", "").strip().lower(),
                "href": urljoin(feed_url, href),
            })
        acquisition = next((link["href"] for link in links if link["rel"].startswith(OPDS_ACQUISITION) and link["type"] == EPUB_MEDIA_TYPE), "")
        cover = next((link["href"] for link in links if "image" in link["rel"] and link["type"].startswith("image/")), "")
        identifiers = [_text(node, 300) for node in entry.findall(DC + "identifier")]
        isbn = next((value.split(":")[-1] for value in identifiers if "isbn" in value.lower()), "")
        navigation = next((link["href"] for link in links if link["type"] in ("application/atom+xml", "application/xml") and link["rel"] in ("alternate", "subsection", "http://opds-spec.org/subsection")), "")
        if navigation and not acquisition:
            navigation_hrefs.append(navigation)
            continue
        if not acquisition:
            continue
        books.append({
            "stableIdentifier": entry_id,
            "title": title,
            "subtitle": "",
            "description": _clean_html(_text(entry.find(ATOM + "summary"), 20_000) or _text(entry.find(ATOM + "content"), 20_000)),
            "authors": authors,
            "seriesName": "",
            "seriesPosition": None,
            "isbn": isbn[:40],
            "language": _text(entry.find(DC + "language"), 40),
            "publisher": _text(entry.find(DC + "publisher"), 500),
            "publishedDate": _text(entry.find(DC + "issued"), 80),
            "coverHref": cover,
            "acquisitionHref": acquisition,
            "updatedAt": _text(entry.find(ATOM + "updated"), 80),
        })
    next_href = ""
    search_template = ""
    for link in root.findall(ATOM + "link"):
        rel = link.get("rel", "")
        href = link.get("href", "").strip()
        if rel == "next" and href:
            next_href = urljoin(feed_url, href)
        if rel == "search" and href:
            search_template = urljoin(feed_url, href)
    return {
        "title": _text(root.find(ATOM + "title")),
        "books": books,
        "nextHref": next_href,
        "navigationHrefs": navigation_hrefs,
        "searchTemplate": search_template,
    }


class OpdsClient:
    def __init__(self, config: OpdsConfig):
        self.config = config
        self.catalog_url = config.url.rstrip("/")
        self.origin = _origin(self.catalog_url)
        self._opener = build_opener(_SameOriginRedirectHandler(self.origin))
        token = base64.b64encode(f"{config.username}:{config.password}".encode("utf-8")).decode("ascii")
        self._headers = {"Authorization": f"Basic {token}", "User-Agent": "Panels/Books"}

    def _safe_url(self, url: str) -> str:
        absolute = urljoin(self.catalog_url + "/", url)
        parsed = urlparse(absolute)
        if parsed.username or parsed.password or _origin(absolute) != self.origin:
            raise OpdsError("OPDS link points to an unexpected host", code="unsafe_link", status=400)
        return absolute

    def fetch(self, url: str, *, accept: str, maximum: int) -> tuple[bytes, str, str]:
        safe_url = self._safe_url(url)
        request = Request(safe_url, headers={**self._headers, "Accept": accept}, method="GET")
        try:
            with self._opener.open(request, timeout=self.config.timeout_seconds) as response:
                final_url = self._safe_url(response.geturl())
                content = response.read(maximum + 1)
                if len(content) > maximum:
                    raise OpdsError("CWA response was too large", code="response_too_large")
                return content, response.headers.get("Content-Type", "application/octet-stream"), final_url
        except OpdsError:
            raise
        except HTTPError as error:
            try:
                status = 401 if error.code in (401, 403) else 502
                code = "authentication_failed" if status == 401 else "upstream_error"
                raise OpdsError(f"CWA OPDS request failed (HTTP {error.code})", code=code, status=status) from None
            finally:
                error.close()
        except (URLError, TimeoutError, OSError):
            raise OpdsError("CWA OPDS is unavailable", code="unavailable") from None

    def page(self, url: str | None = None) -> dict[str, Any]:
        target = url or self.catalog_url
        content, _, final_url = self.fetch(target, accept="application/atom+xml,application/xml", maximum=8_000_000)
        result = parse_opds_feed(content, final_url)
        for book in result["books"]:
            for field in ("coverHref", "acquisitionHref"):
                if book[field]:
                    book[field] = self._safe_url(book[field])
        if result["nextHref"]:
            result["nextHref"] = self._safe_url(result["nextHref"])
        result["navigationHrefs"] = [self._safe_url(href) for href in result["navigationHrefs"]]
        return result

    def catalog(self, *, maximum_feeds: int = 100, maximum_books: int = 10_000) -> list[dict[str, Any]]:
        """Crawl bounded OPDS navigation and pagination links without leaving CWA."""
        pending = [self.catalog_url]
        visited: set[str] = set()
        books: list[dict[str, Any]] = []
        while pending and len(visited) < maximum_feeds and len(books) < maximum_books:
            target = pending.pop(0)
            safe_target = self._safe_url(target)
            if safe_target in visited:
                continue
            visited.add(safe_target)
            page = self.page(safe_target)
            books.extend(page["books"][:maximum_books - len(books)])
            links = [page.get("nextHref", ""), *page.get("navigationHrefs", [])]
            for link in links:
                if link and link not in visited and link not in pending:
                    pending.append(link)
        if pending:
            raise OpdsError("CWA OPDS catalog exceeded the safe pagination limit", code="catalog_too_large")
        return books

    def cover(self, url: str) -> tuple[bytes, str]:
        content, content_type, _ = self.fetch(url, accept="image/avif,image/webp,image/jpeg,image/png", maximum=12_000_000)
        safe_types = {"image/avif", "image/webp", "image/jpeg", "image/png", "image/gif"}
        if content_type.split(";", 1)[0].lower() not in safe_types:
            raise OpdsError("CWA cover response was not an image", code="invalid_cover")
        return content, content_type.split(";", 1)[0]

    def download_epub(self, url: str, destination, *, maximum: int = 300_000_000) -> tuple[int, str]:
        safe_url = self._safe_url(url)
        request = Request(
            safe_url,
            headers={**self._headers, "Accept": "application/epub+zip,application/octet-stream"},
            method="GET",
        )
        try:
            with self._opener.open(request, timeout=max(60, self.config.timeout_seconds)) as response:
                self._safe_url(response.geturl())
                content_type = response.headers.get("Content-Type", "application/octet-stream").split(";", 1)[0].lower()
                if content_type not in ("application/epub+zip", "application/octet-stream", "application/zip"):
                    raise OpdsError("CWA acquisition response was not an EPUB", code="invalid_epub")
                try:
                    declared = int(response.headers.get("Content-Length", "0") or 0)
                except ValueError:
                    declared = 0
                if declared > maximum:
                    raise OpdsError("EPUB is larger than the configured safety limit", code="epub_too_large")
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > maximum:
                        raise OpdsError("EPUB is larger than the configured safety limit", code="epub_too_large")
                    destination.write(chunk)
                if total < 4:
                    raise OpdsError("CWA returned an empty EPUB", code="invalid_epub")
                return total, content_type
        except OpdsError:
            raise
        except HTTPError as error:
            try:
                status = 401 if error.code in (401, 403) else 502
                code = "authentication_failed" if status == 401 else "acquisition_unavailable"
                raise OpdsError(f"CWA EPUB acquisition failed (HTTP {error.code})", code=code, status=status) from None
            finally:
                error.close()
        except (URLError, TimeoutError, OSError):
            raise OpdsError("CWA EPUB acquisition is unavailable", code="acquisition_unavailable") from None

    def health(self) -> dict[str, Any]:
        page = self.page()
        return {"ok": True, "title": page["title"], "bookCount": len(page["books"])}

    def search(self, query: str) -> dict[str, Any]:
        query = str(query or "").strip()[:300]
        if len(query) < 2:
            raise ValueError("Book search query must contain at least two characters")
        root = self.page()
        template = root.get("searchTemplate", "")
        if template and "{searchTerms}" in template:
            return self.page(template.replace("{searchTerms}", quote_plus(query)))
        separator = "&" if "?" in self.catalog_url else "?"
        return self.page(f"{self.catalog_url}{separator}query={quote_plus(query)}")
