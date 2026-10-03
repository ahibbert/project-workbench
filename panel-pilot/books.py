"""Isolated book-domain configuration, storage, and connection services."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import tempfile
import threading
import time
from typing import Any
import zipfile
from xml.etree import ElementTree

from opds_client import OpdsClient, OpdsConfig, OpdsError
from shelfmark_client import ShelfmarkClient, ShelfmarkConfig, ShelfmarkError


BOOKS_SCHEMA_VERSION = 6
BOOK_IMPORT_TIMEOUT_SECONDS = 60 * 60
BOOK_LIBRARY_STATUSES = {
    "reading", "plan_to_read", "paused", "completed", "dropped", "rereading", "considering",
}


class BookRequestError(ValueError):
    def __init__(self, message: str, *, status: int = 400, code: str = "invalid_request", current=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.current = current


def classify_download_failure(message: str) -> dict[str, str]:
    """Turn variable upstream text into stable, credential-safe user guidance."""
    normalized = re.sub(r"\s+", " ", str(message or "").strip().casefold())
    rules = (
        (("all download sources failed", "all sources failed", "no download sources"),
         "sources_exhausted", "Every configured source failed to retrieve this EPUB.",
         "Try another release. If every edition fails, check Shelfmark source health."),
        (("rate limit", "too many requests", "quota", "donator"),
         "rate_limited", "The selected source is temporarily rate-limited.",
         "Wait briefly or choose another release; check the server-side source plan if this persists."),
        (("unauthorized", "forbidden", "authentication", "invalid key", "api key", "http 401", "http 403"),
         "source_authorization", "The selected source rejected Shelfmark's access.",
         "Check the server-side source credential, then retry or choose another release."),
        (("not found", "removed", "unavailable", "http 404", "dead link"),
         "source_missing", "This release is no longer available from its source.",
         "Choose another release; this one is unlikely to succeed on an immediate retry."),
        (("timeout", "timed out", "deadline"),
         "source_timeout", "The selected source did not respond in time.",
         "Retry once or choose another release if the source remains slow."),
        (("invalid epub", "malformed", "corrupt", "unsupported format"),
         "invalid_file", "The downloaded file was not a usable EPUB.",
         "Choose another release, preferably from a different source."),
    )
    for needles, code, public_message, action in rules:
        if any(needle in normalized for needle in needles):
            return {"code": code, "message": public_message, "action": action}
    return {
        "code": "download_failed",
        "message": "Shelfmark could not download this EPUB.",
        "action": "Retry once or choose another release. Check Shelfmark health if several releases fail.",
    }


def score_book_release(
    release: dict[str, Any], reliability: dict[str, Any] | None = None,
) -> tuple[int, list[str]]:
    """Return a transparent quality/reliability score without probing a source again."""
    score = 50.0
    reasons: list[str] = []
    language = str(release.get("language") or "").strip().casefold()
    if language in {"en", "eng", "english"} or language.startswith("en-"):
        score += 14
        reasons.append("English match")
    elif not language or language in {"unknown", "und"}:
        score += 2
        reasons.append("Language not reported")
    else:
        score -= 18
        reasons.append(f"Reported as {release.get('language')}")

    size = release.get("sizeBytes")
    if isinstance(size, int) and size > 0:
        if 250_000 <= size <= 150_000_000:
            score += 8
            reasons.append("Plausible EPUB size")
        elif size < 100_000:
            score -= 22
            reasons.append("Unusually small file")
        elif size > 500_000_000:
            score -= 8
            reasons.append("Unusually large file")
    else:
        reasons.append("File size not reported")

    metadata_fields = sum(bool(release.get(key)) for key in ("author", "publisher", "publishedYear"))
    if metadata_fields >= 2:
        score += 7
        reasons.append("Edition metadata available")
    elif metadata_fields == 1:
        score += 3

    downloads = release.get("downloads")
    if isinstance(downloads, int) and downloads > 0:
        score += min(10, max(1, math.log10(downloads + 1) * 3))
        reasons.append("Used by other readers")

    if reliability and int(reliability.get("attempts") or 0) > 0:
        attempts = int(reliability.get("attempts") or 0)
        successes = int(reliability.get("successes") or 0)
        smoothed = (successes + 2) / (attempts + 4)
        score += (smoothed - 0.5) * 32
        if successes:
            reasons.append(f"Worked {successes} of {attempts} tracked attempt{'s' if attempts != 1 else ''}")
        else:
            reasons.append(f"No success in {attempts} tracked attempt{'s' if attempts != 1 else ''}")
    else:
        reasons.append("No reliability history yet")
    return max(0, min(100, round(score))), reasons[:5]


def validate_epub_archive(path: Path) -> None:
    try:
        with zipfile.ZipFile(path, "r") as archive:
            entries = archive.infolist()
            if not 1 <= len(entries) <= 5000:
                raise BookRequestError("EPUB contains an unsafe number of files", status=422, code="malformed_epub")
            names = {entry.filename for entry in entries}
            if "mimetype" not in names or "META-INF/container.xml" not in names:
                raise BookRequestError("EPUB is missing required package files", status=422, code="malformed_epub")
            mimetype = archive.read("mimetype")
            if mimetype.strip() != b"application/epub+zip":
                raise BookRequestError("EPUB has an invalid mimetype", status=422, code="malformed_epub")
            total_uncompressed = 0
            for entry in entries:
                normalized = entry.filename.replace("\\", "/")
                parts = [part for part in normalized.split("/") if part]
                if normalized.startswith("/") or ".." in parts or entry.flag_bits & 0x1:
                    raise BookRequestError("EPUB contains unsafe archive entries", status=422, code="malformed_epub")
                total_uncompressed += max(0, entry.file_size)
                if entry.file_size > 100_000_000:
                    raise BookRequestError("EPUB contains an oversized resource", status=422, code="malformed_epub")
                if entry.compress_size and entry.file_size / entry.compress_size > 500:
                    raise BookRequestError("EPUB contains an unsafe compressed resource", status=422, code="malformed_epub")
            if total_uncompressed > 1_000_000_000:
                raise BookRequestError("EPUB expands beyond the safety limit", status=422, code="malformed_epub")
    except BookRequestError:
        raise
    except (OSError, zipfile.BadZipFile, KeyError, RuntimeError):
        raise BookRequestError("EPUB file is malformed", status=422, code="malformed_epub") from None


_REMOTE_RESOURCE = re.compile(r"^\s*(?:https?:)?//", re.IGNORECASE)
_CSS_REMOTE_URL = re.compile(r"url\(\s*(['\"]?)(?:https?:)?//.*?\1\s*\)", re.IGNORECASE)
_CSS_REMOTE_IMPORT = re.compile(r"@import\s+(?:url\()?\s*(['\"]?)(?:https?:)?//.*?(?:\1|\))\s*;?", re.IGNORECASE)


def _sanitize_xml_document(content: bytes) -> bytes:
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError:
        raise BookRequestError("EPUB contains malformed HTML", status=422, code="malformed_epub") from None
    dangerous = {"script", "iframe", "object", "embed", "form", "base"}
    for parent in root.iter():
        for child in list(parent):
            if child.tag.split("}")[-1].lower() in dangerous:
                parent.remove(child)
        for name, value in list(parent.attrib.items()):
            local_name = name.split("}")[-1].lower()
            text = str(value or "").strip()
            if local_name.startswith("on") or text.lower().startswith("javascript:"):
                del parent.attrib[name]
                continue
            if local_name in ("src", "href", "poster", "action", "formaction", "xlink:href") and _REMOTE_RESOURCE.match(text):
                del parent.attrib[name]
                continue
            if local_name == "style":
                parent.attrib[name] = _CSS_REMOTE_IMPORT.sub("", _CSS_REMOTE_URL.sub("none", text))
    if root.tag.split("}")[-1].lower() == "html":
        namespace = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
        head_tag = f"{{{namespace}}}head" if namespace else "head"
        meta_tag = f"{{{namespace}}}meta" if namespace else "meta"
        head = next((node for node in root if node.tag == head_tag), None)
        if head is None:
            head = ElementTree.Element(head_tag)
            root.insert(0, head)
        policy = ElementTree.Element(meta_tag, {
            "http-equiv": "Content-Security-Policy",
            "content": "default-src 'self' data: blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
        })
        head.insert(0, policy)
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


def sanitize_epub_archive(source: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(destination, "w") as outgoing:
            mimetype = incoming.read("mimetype")
            outgoing.writestr("mimetype", mimetype, compress_type=zipfile.ZIP_STORED)
            for entry in incoming.infolist():
                if entry.filename == "mimetype" or entry.is_dir():
                    continue
                content = incoming.read(entry)
                suffix = Path(entry.filename).suffix.lower()
                if suffix in (".xhtml", ".html", ".htm", ".svg"):
                    if len(content) > 10_000_000:
                        raise BookRequestError("EPUB contains oversized HTML", status=422, code="malformed_epub")
                    content = _sanitize_xml_document(content)
                elif suffix == ".css":
                    if len(content) > 10_000_000:
                        raise BookRequestError("EPUB contains oversized CSS", status=422, code="malformed_epub")
                    text = content.decode("utf-8", errors="replace")
                    content = _CSS_REMOTE_IMPORT.sub("", _CSS_REMOTE_URL.sub("none", text)).encode("utf-8")
                outgoing.writestr(entry.filename, content, compress_type=zipfile.ZIP_DEFLATED)
    except BookRequestError:
        raise
    except (OSError, zipfile.BadZipFile, KeyError, RuntimeError):
        raise BookRequestError("EPUB sanitization failed", status=422, code="malformed_epub") from None


def _enabled(value: str | None) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _positive_int(value: str | None, default: int, minimum: int = 15, maximum: int = 86_400) -> int:
    try:
        parsed = int(value or default)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


@dataclass(frozen=True)
class BooksConfig:
    enabled: bool
    database_path: str
    cache_path: str
    sync_interval_seconds: int
    shelfmark_base_url: str
    shelfmark_api_key: str
    cwa_opds_url: str
    cwa_username: str
    cwa_password: str

    @classmethod
    def from_environment(cls, data_root: str = "/app/data") -> "BooksConfig":
        return cls(
            enabled=_enabled(os.environ.get("BOOKS_ENABLED")),
            database_path=os.environ.get("PANEL_PILOT_BOOKS_DB_PATH", os.path.join(data_root, "books.sqlite3")),
            cache_path=os.environ.get("PANEL_PILOT_BOOK_CACHE_PATH", os.path.join(data_root, "book-cache")),
            sync_interval_seconds=_positive_int(os.environ.get("BOOK_SYNC_INTERVAL_SECONDS"), 300),
            shelfmark_base_url=os.environ.get("SHELFMARK_BASE_URL", "").strip(),
            shelfmark_api_key=os.environ.get("SHELFMARK_API_KEY", "").strip(),
            cwa_opds_url=os.environ.get("CWA_OPDS_URL", "").strip(),
            cwa_username=os.environ.get("CWA_USERNAME", "").strip(),
            cwa_password=os.environ.get("CWA_PASSWORD", ""),
        )

    @property
    def shelfmark_configured(self) -> bool:
        return bool(self.shelfmark_base_url and self.shelfmark_api_key)

    @property
    def cwa_configured(self) -> bool:
        return bool(self.cwa_opds_url and self.cwa_username and self.cwa_password)

    def public_status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "shelfmarkConfigured": self.shelfmark_configured,
            "cwaConfigured": self.cwa_configured,
            "syncIntervalSeconds": self.sync_interval_seconds if self.enabled else None,
        }


class BookStore:
    """Books-only SQLite store. Construction performs its private migration."""

    def __init__(self, path: str):
        self.path = Path(path).expanduser().resolve()
        self.lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _migrate(self) -> None:
        with self.lock, self.connection() as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > BOOKS_SCHEMA_VERSION:
                raise RuntimeError("Books database was created by a newer Panels version")
            if version < 1:
                connection.executescript("""
                    CREATE TABLE books (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        provider TEXT NOT NULL DEFAULT 'cwa-opds',
                        provider_book_id TEXT,
                        cwa_identifier TEXT NOT NULL UNIQUE,
                        title TEXT NOT NULL,
                        subtitle TEXT NOT NULL DEFAULT '',
                        description TEXT NOT NULL DEFAULT '',
                        authors_json TEXT NOT NULL DEFAULT '[]',
                        series_name TEXT NOT NULL DEFAULT '',
                        series_position REAL,
                        isbn TEXT NOT NULL DEFAULT '',
                        language TEXT NOT NULL DEFAULT '',
                        publisher TEXT NOT NULL DEFAULT '',
                        published_date TEXT NOT NULL DEFAULT '',
                        cover_href TEXT NOT NULL DEFAULT '',
                        acquisition_href TEXT NOT NULL DEFAULT '',
                        content_hash TEXT NOT NULL DEFAULT '',
                        date_added TEXT NOT NULL,
                        last_synced_at TEXT NOT NULL,
                        UNIQUE(provider, provider_book_id)
                    );
                    CREATE INDEX books_isbn_idx ON books(isbn) WHERE isbn <> '';
                    CREATE INDEX books_content_hash_idx ON books(content_hash) WHERE content_hash <> '';
                    CREATE TABLE book_progress (
                        user_id TEXT NOT NULL,
                        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                        locator_type TEXT NOT NULL,
                        locator TEXT NOT NULL,
                        resource_href TEXT NOT NULL DEFAULT '',
                        progression REAL,
                        revision INTEGER NOT NULL DEFAULT 1,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY(user_id, book_id)
                    );
                    CREATE TABLE book_reader_preferences (
                        user_id TEXT PRIMARY KEY,
                        theme TEXT NOT NULL DEFAULT 'light',
                        font_family TEXT NOT NULL DEFAULT 'publisher',
                        font_size INTEGER NOT NULL DEFAULT 100,
                        line_height REAL NOT NULL DEFAULT 1.5,
                        content_width INTEGER NOT NULL DEFAULT 720,
                        reading_flow TEXT NOT NULL DEFAULT 'paginated',
                        text_alignment TEXT NOT NULL DEFAULT 'start',
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE shelfmark_downloads (
                        task_id TEXT PRIMARY KEY,
                        provider TEXT NOT NULL DEFAULT '',
                        provider_book_id TEXT NOT NULL DEFAULT '',
                        title TEXT NOT NULL,
                        status TEXT NOT NULL,
                        progress REAL,
                        error TEXT NOT NULL DEFAULT '',
                        expected_isbn TEXT NOT NULL DEFAULT '',
                        expected_authors_json TEXT NOT NULL DEFAULT '[]',
                        book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE book_meta (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    PRAGMA user_version = 1;
                """)
                version = 1
            if version < 2:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(books)")}
                if "library_status" not in columns:
                    connection.execute(
                        "ALTER TABLE books ADD COLUMN library_status TEXT NOT NULL DEFAULT 'plan_to_read'"
                    )
                connection.execute("""
                    UPDATE books SET library_status = 'reading'
                    WHERE id IN (SELECT book_id FROM book_progress)
                """)
                connection.execute("""
                    UPDATE books SET library_status = 'completed'
                    WHERE id IN (SELECT book_id FROM book_progress WHERE progression >= 0.995)
                """)
                connection.execute("PRAGMA user_version = 2")
                version = 2
            if version < 3:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(books)")}
                if "removed_at" not in columns:
                    connection.execute(
                        "ALTER TABLE books ADD COLUMN removed_at TEXT NOT NULL DEFAULT ''"
                    )
                connection.execute("PRAGMA user_version = 3")
                version = 3
            if version < 4:
                connection.executescript("""
                    CREATE TABLE book_library_membership (
                        user_id TEXT NOT NULL,
                        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                        library_status TEXT NOT NULL DEFAULT 'plan_to_read',
                        date_added TEXT NOT NULL,
                        removed_at TEXT NOT NULL DEFAULT '',
                        PRIMARY KEY(user_id, book_id)
                    );
                    CREATE INDEX book_membership_user_idx
                    ON book_library_membership(user_id, removed_at, library_status);
                """)
                download_columns = {row[1] for row in connection.execute("PRAGMA table_info(shelfmark_downloads)")}
                if download_columns and "requested_by_user_id" not in download_columns:
                    connection.execute(
                        "ALTER TABLE shelfmark_downloads ADD COLUMN requested_by_user_id TEXT NOT NULL DEFAULT ''"
                    )
                connection.execute("PRAGMA user_version = 4")
                version = 4
            if version < 5:
                connection.executescript("""
                    CREATE TABLE book_reader_profiles (
                        user_id TEXT NOT NULL,
                        scope_key TEXT NOT NULL,
                        preferences_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY(user_id, scope_key)
                    );
                    PRAGMA user_version = 5;
                """)
                version = 5
            if version < 6:
                download_columns = {row[1] for row in connection.execute("PRAGMA table_info(shelfmark_downloads)")}
                additions = {
                    "release_id": "TEXT NOT NULL DEFAULT ''",
                    "source": "TEXT NOT NULL DEFAULT ''",
                    "catalog_source": "TEXT NOT NULL DEFAULT ''",
                    "failure_code": "TEXT NOT NULL DEFAULT ''",
                    "failure_action": "TEXT NOT NULL DEFAULT ''",
                    "reliability_recorded": "INTEGER NOT NULL DEFAULT 0",
                }
                for column, declaration in additions.items():
                    if download_columns and column not in download_columns:
                        connection.execute(f"ALTER TABLE shelfmark_downloads ADD COLUMN {column} {declaration}")
                if download_columns:
                    connection.execute("UPDATE shelfmark_downloads SET release_id=task_id WHERE release_id='' OR release_id IS NULL")
                connection.executescript("""
                    CREATE TABLE book_source_reliability (
                        source_key TEXT PRIMARY KEY,
                        display_name TEXT NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        successes INTEGER NOT NULL DEFAULT 0,
                        failures INTEGER NOT NULL DEFAULT 0,
                        last_failure_code TEXT NOT NULL DEFAULT '',
                        last_error TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL
                    );
                    PRAGMA user_version = 6;
                """)

    def ensure_owner_membership(self, owner_user_id: str, legacy_username: str = "") -> None:
        owner_user_id = str(owner_user_id or "local")
        now = utc_now()
        with self.lock, self.connection() as connection:
            connection.execute("""
                INSERT OR IGNORE INTO book_library_membership(user_id,book_id,library_status,date_added,removed_at)
                SELECT ?,id,library_status,date_added,'' FROM books WHERE removed_at=''
            """, (owner_user_id,))
            if legacy_username and legacy_username != owner_user_id:
                connection.execute(
                    "UPDATE OR IGNORE book_progress SET user_id=? WHERE user_id=?",
                    (owner_user_id, legacy_username),
                )
                connection.execute("DELETE FROM book_progress WHERE user_id=?", (legacy_username,))
                connection.execute(
                    "UPDATE OR IGNORE book_reader_preferences SET user_id=? WHERE user_id=?",
                    (owner_user_id, legacy_username),
                )
                connection.execute("DELETE FROM book_reader_preferences WHERE user_id=?", (legacy_username,))
            connection.execute(
                "UPDATE shelfmark_downloads SET requested_by_user_id=? WHERE requested_by_user_id=''",
                (owner_user_id,),
            )

    def counts(self) -> dict[str, int]:
        with self.lock, self.connection() as connection:
            books = int(connection.execute("SELECT COUNT(*) FROM books WHERE removed_at = ''").fetchone()[0])
            active = int(connection.execute(
                "SELECT COUNT(*) FROM shelfmark_downloads WHERE status NOT IN ('ready', 'failed', 'cancelled')"
            ).fetchone()[0])
        return {"books": books, "activeDownloads": active}

    @staticmethod
    def _authors(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(author).replace("\x00", "").strip()[:300] for author in value if str(author).strip()][:20]

    @staticmethod
    def _normalized_title(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()

    @staticmethod
    def _row_public(row: sqlite3.Row) -> dict[str, Any]:
        book_id = int(row["id"])
        try:
            authors = json.loads(row["authors_json"] or "[]")
        except json.JSONDecodeError:
            authors = []
        return {
            "id": book_id,
            "title": row["title"],
            "subtitle": row["subtitle"],
            "description": row["description"],
            "authors": authors,
            "seriesName": row["series_name"],
            "seriesPosition": row["series_position"],
            "isbn": row["isbn"],
            "language": row["language"],
            "publisher": row["publisher"],
            "publishedDate": row["published_date"],
            "coverUrl": f"/api/books/{book_id}/cover" if row["cover_href"] else "",
            "epubUrl": f"/api/books/{book_id}/epub" if row["acquisition_href"] else "",
            "hasEpub": bool(row["acquisition_href"]),
            "libraryStatus": row["membership_status"] if "membership_status" in row.keys() else row["library_status"],
            "dateAdded": row["date_added"],
            "lastSyncedAt": row["last_synced_at"],
        }

    def _match_existing_id(self, connection: sqlite3.Connection, book: dict[str, Any]) -> int | None:
        row = connection.execute(
            "SELECT id FROM books WHERE cwa_identifier = ?",
            (book["stableIdentifier"],),
        ).fetchone()
        if row:
            return int(row["id"])
        isbn = str(book.get("isbn") or "").strip()
        if isbn:
            matches = connection.execute("SELECT id FROM books WHERE isbn = ? LIMIT 2", (isbn,)).fetchall()
            if len(matches) == 1:
                return int(matches[0]["id"])
        content_hash = str(book.get("contentHash") or "").strip().lower()
        if content_hash:
            matches = connection.execute(
                "SELECT id FROM books WHERE content_hash = ? LIMIT 2", (content_hash,)
            ).fetchall()
            if len(matches) == 1:
                return int(matches[0]["id"])
        title_key = self._normalized_title(book.get("title", ""))
        authors = self._authors(book.get("authors"))
        if not title_key or not authors:
            return None
        candidates = connection.execute("SELECT id, title, authors_json FROM books").fetchall()
        matches = []
        first_author = self._normalized_title(authors[0])
        for candidate in candidates:
            try:
                candidate_authors = json.loads(candidate["authors_json"] or "[]")
            except json.JSONDecodeError:
                candidate_authors = []
            if (
                self._normalized_title(candidate["title"]) == title_key
                and candidate_authors
                and self._normalized_title(candidate_authors[0]) == first_author
            ):
                matches.append(int(candidate["id"]))
        return matches[0] if len(matches) == 1 else None

    def catalog_match(self, book: dict[str, Any]) -> int | None:
        with self.lock, self.connection() as connection:
            isbn = str(book.get("isbn") or "").strip()
            if isbn:
                matches = connection.execute("SELECT id FROM books WHERE isbn=? LIMIT 2", (isbn,)).fetchall()
                if len(matches) == 1:
                    return int(matches[0]["id"])
            title_key = self._normalized_title(book.get("title"))
            authors = self._authors(book.get("authors"))
            if not title_key or not authors:
                return None
            author_key = self._normalized_title(authors[0])
            matches = []
            for row in connection.execute("SELECT id,title,authors_json FROM books").fetchall():
                try:
                    row_authors = json.loads(row["authors_json"] or "[]")
                except json.JSONDecodeError:
                    row_authors = []
                if self._normalized_title(row["title"]) == title_key and row_authors and self._normalized_title(row_authors[0]) == author_key:
                    matches.append(int(row["id"]))
            return matches[0] if len(matches) == 1 else None

    def sync_books(self, books: list[dict[str, Any]]) -> dict[str, int]:
        now = utc_now()
        added = 0
        updated = 0
        with self.lock, self.connection() as connection:
            for book in books:
                if not book.get("stableIdentifier") or not book.get("title") or not book.get("acquisitionHref"):
                    continue
                authors_json = json.dumps(self._authors(book.get("authors")), ensure_ascii=True)
                values = (
                    str(book.get("stableIdentifier"))[:1000], str(book.get("title"))[:1000],
                    str(book.get("subtitle") or "")[:1000], str(book.get("description") or "")[:20_000],
                    authors_json, str(book.get("seriesName") or "")[:1000], book.get("seriesPosition"),
                    str(book.get("isbn") or "")[:40], str(book.get("language") or "")[:40],
                    str(book.get("publisher") or "")[:500], str(book.get("publishedDate") or "")[:80],
                    str(book.get("coverHref") or "")[:4000], str(book.get("acquisitionHref") or "")[:4000], now,
                )
                existing_id = self._match_existing_id(connection, book)
                if existing_id is None:
                    connection.execute("""
                        INSERT INTO books (
                            cwa_identifier, title, subtitle, description, authors_json,
                            series_name, series_position, isbn, language, publisher,
                            published_date, cover_href, acquisition_href, date_added, last_synced_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (*values[:-1], now, values[-1]))
                    added += 1
                else:
                    connection.execute("""
                        UPDATE books SET cwa_identifier = ?, title = ?, subtitle = ?, description = ?,
                            authors_json = ?, series_name = ?, series_position = ?, isbn = ?, language = ?,
                            publisher = ?, published_date = ?, cover_href = ?, acquisition_href = ?,
                            last_synced_at = ? WHERE id = ?
                    """, (*values, existing_id))
                    updated += 1
            connection.execute(
                "INSERT INTO book_meta(key, value, updated_at) VALUES('last_sync', ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (json.dumps({"added": added, "updated": updated, "seen": len(books)}), now),
            )
        return {"seen": len(books), "added": added, "updated": updated}

    def list_books(self, user_id: str = "local", query: str = "", limit: int = 100, offset: int = 0) -> dict[str, Any]:
        if user_id == "local":
            self.ensure_owner_membership("local")
        limit = max(1, min(200, int(limit)))
        offset = max(0, int(offset))
        query = str(query or "").strip()[:300]
        where = "WHERE b.removed_at = '' AND m.user_id = ? AND m.removed_at = ''"
        parameters: list[Any] = [str(user_id)]
        if query:
            where += " AND (b.title LIKE ? ESCAPE '\\' OR b.authors_json LIKE ? ESCAPE '\\')"
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            parameters.extend([f"%{escaped}%", f"%{escaped}%"])
        with self.lock, self.connection() as connection:
            joins = "FROM books b JOIN book_library_membership m ON m.book_id=b.id"
            total = int(connection.execute(f"SELECT COUNT(*) {joins} {where}", parameters).fetchone()[0])
            rows = connection.execute(
                f"SELECT b.*,m.library_status AS membership_status {joins} {where} ORDER BY b.title COLLATE NOCASE,b.id LIMIT ? OFFSET ?",
                (*parameters, limit, offset),
            ).fetchall()
        return {"books": [self._row_public(row) for row in rows], "total": total, "limit": limit, "offset": offset}

    def progress_for_books(self, user_id: str, book_ids: list[int]) -> dict[int, dict[str, Any]]:
        if not book_ids:
            return {}
        placeholders = ",".join("?" for _ in book_ids)
        with self.lock, self.connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM book_progress WHERE user_id = ? AND book_id IN ({placeholders})",
                (user_id, *book_ids),
            ).fetchall()
        return {int(row["book_id"]): self._progress_public(row) for row in rows}

    @staticmethod
    def _progress_public(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "bookId": int(row["book_id"]),
            "locatorType": row["locator_type"],
            "locator": row["locator"],
            "resourceHref": row["resource_href"],
            "progression": row["progression"],
            "revision": int(row["revision"]),
            "updatedAt": row["updated_at"],
        }

    def get_progress(self, user_id: str, book_id: int) -> dict[str, Any] | None:
        with self.lock, self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM book_progress WHERE user_id = ? AND book_id = ?",
                (str(user_id), int(book_id)),
            ).fetchone()
        return self._progress_public(row) if row else None

    def save_progress(self, user_id: str, book_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BookRequestError("Progress payload must be an object")
        locator_type = str(payload.get("locatorType") or "")
        locator = str(payload.get("locator") or "").strip()
        if locator_type != "cfi" or not locator.startswith("epubcfi(") or len(locator) > 8192:
            raise BookRequestError("Progress requires a valid EPUB CFI locator")
        resource_href = str(payload.get("resourceHref") or "").replace("\x00", "").strip()[:2000]
        progression = payload.get("progression")
        if progression is not None:
            try:
                progression = float(progression)
            except (TypeError, ValueError):
                raise BookRequestError("Progression must be a number") from None
            if not 0 <= progression <= 1:
                raise BookRequestError("Progression must be between 0 and 1")
        try:
            base_revision = int(payload.get("revision") or 0)
        except (TypeError, ValueError):
            raise BookRequestError("Progress revision is invalid") from None
        now = utc_now()
        with self.lock, self.connection() as connection:
            if not connection.execute(
                "SELECT 1 FROM book_library_membership WHERE user_id=? AND book_id=? AND removed_at=''",
                (str(user_id), int(book_id)),
            ).fetchone():
                if connection.execute("SELECT 1 FROM books WHERE id=? AND removed_at=''", (int(book_id),)).fetchone():
                    connection.execute(
                        "INSERT OR IGNORE INTO book_library_membership(user_id,book_id,library_status,date_added,removed_at) VALUES(?,?,'plan_to_read',?,'')",
                        (str(user_id), int(book_id), utc_now()),
                    )
                else:
                    raise BookRequestError("Book not found", status=404, code="not_found")
            current = connection.execute(
                "SELECT * FROM book_progress WHERE user_id = ? AND book_id = ?",
                (str(user_id), int(book_id)),
            ).fetchone()
            current_revision = int(current["revision"]) if current else 0
            if base_revision != current_revision:
                raise BookRequestError(
                    "Reading position changed on another device",
                    status=409,
                    code="progress_conflict",
                    current=self._progress_public(current) if current else None,
                )
            next_revision = current_revision + 1
            connection.execute("""
                INSERT INTO book_progress (
                    user_id, book_id, locator_type, locator, resource_href,
                    progression, revision, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, book_id) DO UPDATE SET
                    locator_type = excluded.locator_type,
                    locator = excluded.locator,
                    resource_href = excluded.resource_href,
                    progression = excluded.progression,
                    revision = excluded.revision,
                    updated_at = excluded.updated_at
            """, (
                str(user_id), int(book_id), locator_type, locator, resource_href,
                progression, next_revision, now,
            ))
            if progression is not None and progression >= 0.995:
                connection.execute(
                    "UPDATE book_library_membership SET library_status='completed' WHERE user_id=? AND book_id=? AND library_status IN ('reading','rereading','plan_to_read','considering')",
                    (str(user_id), int(book_id)),
                )
            else:
                connection.execute(
                    "UPDATE book_library_membership SET library_status='reading' WHERE user_id=? AND book_id=? AND library_status IN ('plan_to_read','considering')",
                    (str(user_id), int(book_id)),
                )
        return self.get_progress(user_id, book_id)

    def set_library_status(self, user_id: str | int, book_id: int | str, status: str | None = None) -> dict[str, Any]:
        if status is None:
            user_id, book_id, status = "local", user_id, book_id
        status = str(status or "").strip()
        if status not in BOOK_LIBRARY_STATUSES:
            raise BookRequestError("Invalid book library group")
        with self.lock, self.connection() as connection:
            result = connection.execute(
                "UPDATE book_library_membership SET library_status=? WHERE user_id=? AND book_id=? AND removed_at=''",
                (status, str(user_id), int(book_id)),
            )
            if result.rowcount != 1:
                raise BookRequestError("Book not found", status=404, code="not_found")
        return self.get_book_for_user(user_id, book_id)

    def add_to_library(self, user_id: str, book_id: int, status: str = "plan_to_read") -> dict[str, Any]:
        if status not in BOOK_LIBRARY_STATUSES:
            raise BookRequestError("Invalid book library group")
        now = utc_now()
        with self.lock, self.connection() as connection:
            if not connection.execute("SELECT 1 FROM books WHERE id=?", (int(book_id),)).fetchone():
                raise BookRequestError("Book not found", status=404, code="not_found")
            connection.execute("""
                INSERT INTO book_library_membership(user_id,book_id,library_status,date_added,removed_at)
                VALUES(?,?,?,?, '')
                ON CONFLICT(user_id,book_id) DO UPDATE SET
                    library_status=excluded.library_status,removed_at='',date_added=excluded.date_added
            """, (str(user_id), int(book_id), status, now))
        return self.get_book_for_user(user_id, book_id)

    @staticmethod
    def default_preferences() -> dict[str, Any]:
        return {
            "theme": "light", "fontFamily": "publisher", "fontSize": 100,
            "lineHeight": 1.5, "contentWidth": 720, "readingFlow": "paginated",
            "textAlignment": "start",
        }

    def get_preferences(self, user_id: str) -> dict[str, Any]:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM book_reader_preferences WHERE user_id = ?", (str(user_id),)).fetchone()
        if not row:
            return self.default_preferences()
        return {
            "theme": row["theme"], "fontFamily": row["font_family"], "fontSize": int(row["font_size"]),
            "lineHeight": float(row["line_height"]), "contentWidth": int(row["content_width"]),
            "readingFlow": row["reading_flow"], "textAlignment": row["text_alignment"],
        }

    def save_preferences(self, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        values = self._validated_preferences(self.get_preferences(user_id), payload)
        with self.lock, self.connection() as connection:
            connection.execute("""
                INSERT INTO book_reader_preferences (
                    user_id, theme, font_family, font_size, line_height,
                    content_width, reading_flow, text_alignment, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    theme = excluded.theme, font_family = excluded.font_family,
                    font_size = excluded.font_size, line_height = excluded.line_height,
                    content_width = excluded.content_width, reading_flow = excluded.reading_flow,
                    text_alignment = excluded.text_alignment, updated_at = excluded.updated_at
            """, (
                str(user_id), values["theme"], values["fontFamily"], values["fontSize"], values["lineHeight"],
                values["contentWidth"], values["readingFlow"], values["textAlignment"], utc_now(),
            ))
        return self.get_preferences(user_id)

    def _validated_preferences(self, base: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise BookRequestError("Reader preferences must be an object")
        unknown = set(payload) - set(self.default_preferences())
        if unknown:
            raise BookRequestError(f"Unknown reader preferences: {', '.join(sorted(unknown))}")
        values = {**base, **payload}
        if values["theme"] not in ("light", "dark", "sepia"):
            raise BookRequestError("Invalid book theme")
        if values["fontFamily"] not in ("publisher", "serif", "sans"):
            raise BookRequestError("Invalid font family")
        if values["readingFlow"] not in ("paginated", "scrolled"):
            raise BookRequestError("Invalid reading flow")
        if values["textAlignment"] not in ("start", "left", "justify"):
            raise BookRequestError("Invalid text alignment")
        try:
            values["fontSize"] = max(75, min(180, int(values["fontSize"])))
            values["lineHeight"] = max(1.1, min(2.2, float(values["lineHeight"])))
            values["contentWidth"] = max(480, min(1200, int(values["contentWidth"])))
        except (TypeError, ValueError):
            raise BookRequestError("Reader preference values are invalid") from None
        return values

    def _reader_scope(self, user_id: str, book_id: int) -> tuple[str, dict[str, Any]]:
        book = self.get_book_for_user(user_id, book_id)
        if not book:
            raise BookRequestError("Book not found", status=404, code="not_found")
        series = self._normalized_title(book.get("seriesName"))
        return (f"series:{series}" if series else f"book:{int(book_id)}"), book

    def get_scoped_preferences(self, user_id: str, book_id: int) -> dict[str, Any]:
        scope_key, book = self._reader_scope(user_id, book_id)
        preferences = self.get_preferences(user_id)
        with self.lock, self.connection() as connection:
            row = connection.execute(
                "SELECT preferences_json FROM book_reader_profiles WHERE user_id=? AND scope_key=?",
                (str(user_id), scope_key),
            ).fetchone()
        if row:
            try:
                overrides = json.loads(row["preferences_json"])
                if isinstance(overrides, dict):
                    preferences = self._validated_preferences(preferences, overrides)
            except (json.JSONDecodeError, BookRequestError):
                pass
        return {
            "preferences": preferences,
            "scope": "series" if scope_key.startswith("series:") else "book",
            "scopeLabel": book.get("seriesName") or book.get("title") or "This book",
        }

    def save_scoped_preferences(self, user_id: str, book_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        scope_key, _ = self._reader_scope(user_id, book_id)
        current = self.get_scoped_preferences(user_id, book_id)["preferences"]
        values = self._validated_preferences(current, payload)
        defaults = self.get_preferences(user_id)
        overrides = {key: value for key, value in values.items() if value != defaults.get(key)}
        with self.lock, self.connection() as connection:
            connection.execute("""
                INSERT INTO book_reader_profiles(user_id,scope_key,preferences_json,updated_at)
                VALUES(?,?,?,?) ON CONFLICT(user_id,scope_key) DO UPDATE SET
                    preferences_json=excluded.preferences_json,updated_at=excluded.updated_at
            """, (str(user_id), scope_key, json.dumps(overrides, separators=(",", ":")), utc_now()))
        return self.get_scoped_preferences(user_id, book_id)

    def get_book(self, book_id: int, *, public: bool = True, include_removed: bool = False) -> dict[str, Any] | None:
        with self.lock, self.connection() as connection:
            query = "SELECT * FROM books WHERE id = ?" + ("" if include_removed else " AND removed_at = ''")
            row = connection.execute(query, (int(book_id),)).fetchone()
        if not row:
            return None
        if public:
            return self._row_public(row)
        return dict(row)

    def get_book_for_user(self, user_id: str, book_id: int) -> dict[str, Any] | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("""
                SELECT b.*,m.library_status AS membership_status
                FROM books b JOIN book_library_membership m ON m.book_id=b.id
                WHERE b.id=? AND m.user_id=? AND m.removed_at=''
            """, (int(book_id), str(user_id))).fetchone()
        return self._row_public(row) if row else None

    def series_context(self, user_id: str, book_id: int) -> dict[str, Any] | None:
        current = self.get_book_for_user(user_id, book_id)
        series_name = str((current or {}).get("seriesName") or "").strip()
        if not current or not series_name:
            return None
        with self.lock, self.connection() as connection:
            rows = connection.execute("""
                SELECT b.*,m.library_status AS membership_status,m.removed_at AS membership_removed,
                       p.progression AS reader_progression
                FROM books b
                LEFT JOIN book_library_membership m ON m.book_id=b.id AND m.user_id=?
                LEFT JOIN book_progress p ON p.book_id=b.id AND p.user_id=?
                WHERE b.removed_at='' AND b.series_name=? COLLATE NOCASE
                ORDER BY CASE WHEN b.series_position IS NULL THEN 1 ELSE 0 END,
                         b.series_position,b.published_date,b.id
            """, (str(user_id), str(user_id), series_name)).fetchall()
        items = []
        for row in rows:
            item = self._row_public(row)
            item["inLibrary"] = bool(row["membership_status"] and not row["membership_removed"])
            item["progression"] = row["reader_progression"]
            if not item["inLibrary"]:
                item["libraryStatus"] = ""
                item["coverUrl"] = ""
                item["epubUrl"] = ""
            items.append(item)
        current_index = next((index for index, item in enumerate(items) if item["id"] == int(book_id)), 0)
        next_item = items[current_index + 1] if current_index + 1 < len(items) else None
        numbered = sorted({
            int(item["seriesPosition"])
            for item in items
            if isinstance(item.get("seriesPosition"), (int, float)) and float(item["seriesPosition"]).is_integer()
            and int(item["seriesPosition"]) > 0
        })
        missing_positions = list(range(numbered[0], numbered[-1] + 1)) if len(numbered) > 1 else []
        missing_positions = [position for position in missing_positions if position not in numbered]
        return {
            "name": series_name,
            "currentBookId": int(book_id),
            "items": items,
            "nextBook": next_item,
            "missingPositions": missing_positions[:50],
        }

    def remove_book(self, user_id: str | int, book_id: int | None = None) -> dict[str, Any]:
        legacy_global_remove = book_id is None
        if book_id is None:
            user_id, book_id = "local", user_id
        now = utc_now()
        with self.lock, self.connection() as connection:
            row = connection.execute(
                "SELECT b.id,b.title FROM books b JOIN book_library_membership m ON m.book_id=b.id WHERE b.id=? AND m.user_id=? AND m.removed_at=''",
                (int(book_id), str(user_id)),
            ).fetchone()
            if not row:
                raise BookRequestError("Book not found", status=404, code="not_found")
            connection.execute("DELETE FROM book_progress WHERE user_id=? AND book_id=?", (str(user_id), int(book_id)))
            connection.execute("UPDATE book_library_membership SET removed_at=? WHERE user_id=? AND book_id=?", (now, str(user_id), int(book_id)))
            if legacy_global_remove:
                connection.execute("UPDATE books SET removed_at=? WHERE id=?", (now, int(book_id)))
        return {"id": int(row["id"]), "title": row["title"], "removed": True}

    def update_content_hash(self, book_id: int, content_hash: str) -> None:
        with self.lock, self.connection() as connection:
            connection.execute("UPDATE books SET content_hash = ? WHERE id = ?", (content_hash, int(book_id)))

    def last_sync(self) -> dict[str, Any] | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT value, updated_at FROM book_meta WHERE key = 'last_sync'").fetchone()
        if not row:
            return None
        try:
            result = json.loads(row["value"])
        except json.JSONDecodeError:
            result = {}
        return {**result, "at": row["updated_at"]}

    def save_download(
        self, *, task_id: str, provider: str, provider_book_id: str, title: str,
        isbn: str, authors: list[str], user_id: str = "local", release_id: str = "",
        source: str = "", catalog_source: str = "",
    ) -> dict[str, Any]:
        now = utc_now()
        with self.lock, self.connection() as connection:
            connection.execute("""
                INSERT INTO shelfmark_downloads (
                    task_id, provider, provider_book_id, title, status, progress, error,
                    expected_isbn, expected_authors_json, created_at, updated_at, requested_by_user_id,
                    release_id, source, catalog_source, failure_code, failure_action, reliability_recorded
                ) VALUES (?, ?, ?, ?, 'queued', 0, '', ?, ?, ?, ?, ?, ?, ?, ?, '', '', 0)
                ON CONFLICT(task_id) DO UPDATE SET
                    provider = excluded.provider,
                    provider_book_id = excluded.provider_book_id,
                    title = excluded.title,
                    status = 'queued', progress = 0, error = '',
                    expected_isbn = excluded.expected_isbn,
                    expected_authors_json = excluded.expected_authors_json,
                    book_id = NULL, updated_at = excluded.updated_at,
                    requested_by_user_id = excluded.requested_by_user_id,
                    release_id = excluded.release_id,
                    source = excluded.source,
                    catalog_source = excluded.catalog_source,
                    failure_code = '', failure_action = '', reliability_recorded = 0
            """, (
                str(task_id)[:1000], str(provider)[:100], str(provider_book_id)[:300], str(title)[:1000],
                str(isbn or "")[:40], json.dumps(self._authors(authors), ensure_ascii=True), now, now, str(user_id),
                str(release_id or task_id)[:500], str(source)[:100], str(catalog_source or source)[:100],
            ))
        return self.get_download(task_id)

    @staticmethod
    def _download_public(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "taskId": row["task_id"],
            "providerBookId": row["provider_book_id"],
            "title": row["title"],
            "status": row["status"],
            "progress": row["progress"],
            "error": row["error"],
            "errorCode": row["failure_code"] if "failure_code" in row.keys() else "",
            "errorAction": row["failure_action"] if "failure_action" in row.keys() else "",
            "source": row["catalog_source"] if "catalog_source" in row.keys() else "",
            "bookId": row["book_id"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def get_download(self, task_id: str) -> dict[str, Any] | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM shelfmark_downloads WHERE task_id = ?", (str(task_id),)).fetchone()
        return self._download_public(row) if row else None

    def list_downloads(self, user_id: str = "local", limit: int = 100) -> list[dict[str, Any]]:
        with self.lock, self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM shelfmark_downloads WHERE requested_by_user_id=? ORDER BY updated_at DESC LIMIT ?",
                (str(user_id), max(1, min(500, int(limit)))),
            ).fetchall()
        return [self._download_public(row) for row in rows]

    def download_attempts(self, user_id: str, provider: str, provider_book_id: str) -> dict[str, dict[str, Any]]:
        with self.lock, self.connection() as connection:
            rows = connection.execute(
                """SELECT task_id,release_id,status,error,failure_code,failure_action,updated_at FROM shelfmark_downloads
                   WHERE requested_by_user_id=? AND provider=? AND provider_book_id=?
                   ORDER BY updated_at DESC""",
                (str(user_id), str(provider), str(provider_book_id)),
            ).fetchall()
        return {
            str(row["release_id"] or row["task_id"]): {
                "status": row["status"], "error": row["error"],
                "errorCode": row["failure_code"], "errorAction": row["failure_action"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        }

    def update_download(
        self, task_id: str, *, status: str, progress: float | None = None, error: str = "",
        failure_code: str = "", failure_action: str = "",
    ) -> None:
        allowed = {"queued", "downloading", "importing", "ready", "failed", "cancelled"}
        if status not in allowed:
            raise ValueError("Invalid book download status")
        with self.lock, self.connection() as connection:
            connection.execute(
                """UPDATE shelfmark_downloads
                   SET status=?, progress=COALESCE(?, progress), error=?, failure_code=?, failure_action=?, updated_at=?
                   WHERE task_id=?""",
                (
                    status, progress, str(error or "")[:500], str(failure_code or "")[:80],
                    str(failure_action or "")[:500], utc_now(), str(task_id),
                ),
            )
        if status in {"ready", "failed"}:
            self.record_download_outcome(task_id)

    @staticmethod
    def _source_key(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", str(value or "").casefold()).strip("-")[:100]

    def record_download_outcome(self, task_id: str) -> bool:
        """Record one terminal result per task for source ranking."""
        with self.lock, self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM shelfmark_downloads WHERE task_id=?", (str(task_id),)
            ).fetchone()
            if not row or row["status"] not in {"ready", "failed"} or int(row["reliability_recorded"] or 0):
                return False
            display = str(row["catalog_source"] or row["source"] or "Unknown source")[:100]
            key = self._source_key(display) or "unknown"
            success = 1 if row["status"] == "ready" else 0
            failure = 1 - success
            connection.execute("""
                INSERT INTO book_source_reliability(
                    source_key,display_name,attempts,successes,failures,last_failure_code,last_error,updated_at
                ) VALUES(?,?,1,?,?,?, ?,?)
                ON CONFLICT(source_key) DO UPDATE SET
                    display_name=excluded.display_name,
                    attempts=book_source_reliability.attempts+1,
                    successes=book_source_reliability.successes+excluded.successes,
                    failures=book_source_reliability.failures+excluded.failures,
                    last_failure_code=CASE WHEN excluded.failures=1 THEN excluded.last_failure_code ELSE book_source_reliability.last_failure_code END,
                    last_error=CASE WHEN excluded.failures=1 THEN excluded.last_error ELSE book_source_reliability.last_error END,
                    updated_at=excluded.updated_at
            """, (
                key, display, success, failure, str(row["failure_code"] or "")[:80],
                str(row["error"] or "")[:500], utc_now(),
            ))
            connection.execute(
                "UPDATE shelfmark_downloads SET reliability_recorded=1 WHERE task_id=?", (str(task_id),)
            )
        return True

    def source_reliability(self) -> dict[str, dict[str, Any]]:
        with self.lock, self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM book_source_reliability ORDER BY attempts DESC, display_name"
            ).fetchall()
        return {
            str(row["source_key"]): {
                "source": row["display_name"],
                "attempts": int(row["attempts"]),
                "successes": int(row["successes"]),
                "failures": int(row["failures"]),
                "successRate": round(int(row["successes"]) / max(1, int(row["attempts"])), 3),
                "lastFailureCode": row["last_failure_code"],
            }
            for row in rows
        }

    def reconcile_downloads(self) -> int:
        ready = 0
        now = utc_now()
        with self.lock, self.connection() as connection:
            downloads = connection.execute(
                "SELECT * FROM shelfmark_downloads WHERE status NOT IN ('ready', 'failed', 'cancelled')"
            ).fetchall()
            books = connection.execute("SELECT * FROM books").fetchall()
            for download in downloads:
                candidates = []
                expected_isbn = str(download["expected_isbn"] or "")
                if expected_isbn:
                    candidates = [book for book in books if book["isbn"] == expected_isbn]
                if not candidates:
                    title_key = self._normalized_title(download["title"])
                    try:
                        expected_authors = json.loads(download["expected_authors_json"] or "[]")
                    except json.JSONDecodeError:
                        expected_authors = []
                    author_key = self._normalized_title(expected_authors[0]) if expected_authors else ""
                    for book in books:
                        try:
                            book_authors = json.loads(book["authors_json"] or "[]")
                        except json.JSONDecodeError:
                            book_authors = []
                        if self._normalized_title(book["title"]) != title_key:
                            continue
                        if author_key and (not book_authors or self._normalized_title(book_authors[0]) != author_key):
                            continue
                        candidates.append(book)
                if len(candidates) == 1:
                    book_id = int(candidates[0]["id"])
                    connection.execute(
                        "UPDATE shelfmark_downloads SET status = 'ready', progress = 1, error = '', book_id = ?, updated_at = ? WHERE task_id = ?",
                        (book_id, now, download["task_id"]),
                    )
                    connection.execute("""
                        INSERT INTO book_library_membership(user_id,book_id,library_status,date_added,removed_at)
                        VALUES(?,?,'plan_to_read',?,'')
                        ON CONFLICT(user_id,book_id) DO UPDATE SET removed_at=''
                    """, (download["requested_by_user_id"], book_id, now))
                    ready += 1
            completed = [str(row["task_id"]) for row in connection.execute(
                "SELECT task_id FROM shelfmark_downloads WHERE status='ready' AND reliability_recorded=0"
            ).fetchall()]
        for task_id in completed:
            self.record_download_outcome(task_id)
        return ready

    def fail_stale_imports(self, timeout_seconds: int = BOOK_IMPORT_TIMEOUT_SECONDS, now: datetime | None = None) -> int:
        cutoff = (now or datetime.now(timezone.utc)).timestamp() - max(60, int(timeout_seconds))
        failed = 0
        with self.lock, self.connection() as connection:
            rows = connection.execute(
                "SELECT task_id, updated_at FROM shelfmark_downloads WHERE status = 'importing'"
            ).fetchall()
            for row in rows:
                try:
                    updated = datetime.fromisoformat(row["updated_at"]).timestamp()
                except (TypeError, ValueError):
                    updated = 0
                if updated <= cutoff:
                    connection.execute(
                        """UPDATE shelfmark_downloads SET status='failed', error=?, failure_code='import_timeout',
                           failure_action=?, updated_at=? WHERE task_id=?""",
                        (
                            "CWA did not import this EPUB within one hour",
                            "Check CWA ingest health, then retry or choose another release.",
                            utc_now(), row["task_id"],
                        ),
                    )
                    failed += 1
            terminal = [str(row["task_id"]) for row in connection.execute(
                "SELECT task_id FROM shelfmark_downloads WHERE status='failed' AND reliability_recorded=0"
            ).fetchall()]
        for task_id in terminal:
            self.record_download_outcome(task_id)
        return failed


class BooksService:
    def __init__(self, config: BooksConfig, *, owner_user_id: str = "local", legacy_owner_username: str = ""):
        if not config.enabled:
            raise ValueError("BooksService cannot be created while books are disabled")
        self.config = config
        self.store = BookStore(config.database_path)
        self.owner_user_id = str(owner_user_id or "local")
        self.store.ensure_owner_membership(self.owner_user_id, legacy_owner_username)
        self._sync_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._last_error = ""
        self._release_tokens: dict[str, tuple[float, dict[str, Any]]] = {}
        self._book_tokens: dict[str, tuple[float, dict[str, Any]]] = {}
        self._release_lock = threading.Lock()
        self._epub_lock = threading.Lock()

    def shelfmark_client(self) -> ShelfmarkClient:
        if not self.config.shelfmark_configured:
            raise ShelfmarkError("Shelfmark is not configured", code="not_configured", status=503)
        return ShelfmarkClient(ShelfmarkConfig(self.config.shelfmark_base_url, self.config.shelfmark_api_key))

    def opds_client(self) -> OpdsClient:
        if not self.config.cwa_configured:
            raise OpdsError("CWA OPDS is not configured", code="not_configured", status=503)
        return OpdsClient(OpdsConfig(
            self.config.cwa_opds_url,
            self.config.cwa_username,
            self.config.cwa_password,
        ))

    def status(self) -> dict[str, Any]:
        source_history = list(self.store.source_reliability().values())
        return {
            **self.config.public_status(),
            **self.store.counts(),
            "lastSync": self.store.last_sync(),
            "syncError": self._last_error,
            "sourceReliability": source_history,
        }

    def test_connection(self, target: str) -> dict[str, Any]:
        if target == "shelfmark":
            return {"target": target, **self.shelfmark_client().status()}
        if target == "cwa":
            return {"target": target, **self.opds_client().health()}
        raise ValueError("Connection target must be shelfmark or cwa")

    def sync_library(self) -> dict[str, Any]:
        if not self._sync_lock.acquire(blocking=False):
            return {"status": "already_running", **self.store.counts()}
        try:
            books = self.opds_client().catalog()
            result = self.store.sync_books(books)
            if self.owner_user_id == "local":
                self.store.ensure_owner_membership("local")
            result["downloadsReady"] = self.store.reconcile_downloads()
            self._last_error = ""
            return {"status": "complete", **result}
        except Exception as error:
            self._last_error = str(error)[:500]
            raise
        finally:
            self._sync_lock.release()

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._run, name="panels-book-sync", daemon=True)
        self._worker.start()

    def _run(self) -> None:
        delay = 2
        while not self._stop_event.wait(delay):
            if self.config.cwa_configured:
                try:
                    self.sync_library()
                except Exception:
                    pass
            delay = self.config.sync_interval_seconds

    def list_books(self, user_id: str, query: str = "", limit: int = 100, offset: int = 0) -> dict[str, Any]:
        result = self.store.list_books(user_id, query, limit, offset)
        progress = self.store.progress_for_books(user_id, [book["id"] for book in result["books"]])
        for book in result["books"]:
            book["progress"] = progress.get(book["id"])
        return result

    def get_book(self, book_id: int, user_id: str | None = None) -> dict[str, Any] | None:
        return self.store.get_book_for_user(user_id, book_id) if user_id else self.store.get_book(book_id)

    def series_context(self, user_id: str, book_id: int) -> dict[str, Any] | None:
        return self.store.series_context(user_id, book_id)

    def add_to_library(self, user_id: str, book_id: int) -> dict[str, Any]:
        return self.store.add_to_library(user_id, book_id)

    def progress(self, user_id: str, book_id: int) -> dict[str, Any] | None:
        return self.store.get_progress(user_id, book_id)

    def save_progress(self, user_id: str, book_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        return self.store.save_progress(user_id, book_id, payload)

    def set_library_status(self, user_id: str, book_id: int, status: str) -> dict[str, Any]:
        return self.store.set_library_status(user_id, book_id, status)

    def remove_book(self, user_id: str, book_id: int) -> dict[str, Any]:
        return self.store.remove_book(user_id, book_id)

    def preferences(self, user_id: str) -> dict[str, Any]:
        return self.store.get_preferences(user_id)

    def save_preferences(self, user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.store.save_preferences(user_id, payload)

    def scoped_preferences(self, user_id: str, book_id: int) -> dict[str, Any]:
        return self.store.get_scoped_preferences(user_id, book_id)

    def save_scoped_preferences(self, user_id: str, book_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        return self.store.save_scoped_preferences(user_id, book_id, payload)

    def epub_path(self, book_id: int) -> Path:
        book = self.store.get_book(book_id, public=False)
        if not book:
            raise BookRequestError("Book not found", status=404, code="not_found")
        if not book["acquisition_href"]:
            raise BookRequestError("This book has no EPUB acquisition link", status=404, code="epub_unavailable")
        cache_root = Path(self.config.cache_path).expanduser().resolve()
        cache_root.mkdir(parents=True, exist_ok=True)
        target = cache_root / f"{int(book_id)}.epub"
        with self._epub_lock:
            if target.exists() and target.is_file() and target.stat().st_size >= 4:
                try:
                    validate_epub_archive(target)
                    return target
                except BookRequestError:
                    target.unlink()
            temporary_path = None
            sanitized_path = None
            try:
                with tempfile.NamedTemporaryFile("wb", dir=cache_root, prefix=f".{int(book_id)}-", suffix=".epub", delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    self.opds_client().download_epub(book["acquisition_href"], temporary)
                validate_epub_archive(temporary_path)
                with tempfile.NamedTemporaryFile("wb", dir=cache_root, prefix=f".{int(book_id)}-sanitized-", suffix=".epub", delete=False) as sanitized:
                    sanitized_path = Path(sanitized.name)
                sanitize_epub_archive(temporary_path, sanitized_path)
                validate_epub_archive(sanitized_path)
                digest = hashlib.sha256()
                with open(sanitized_path, "rb") as handle:
                    while chunk := handle.read(1024 * 1024):
                        digest.update(chunk)
                os.replace(sanitized_path, target)
                sanitized_path = None
                self.store.update_content_hash(book_id, digest.hexdigest())
                return target
            finally:
                if temporary_path and temporary_path.exists():
                    temporary_path.unlink()
                if sanitized_path and sanitized_path.exists():
                    sanitized_path.unlink()

    def cover(self, book_id: int) -> tuple[bytes, str]:
        book = self.store.get_book(book_id, public=False)
        if not book:
            raise KeyError("Book not found")
        if not book["cover_href"]:
            raise KeyError("Book has no cover")
        return self.opds_client().cover(book["cover_href"])

    def search(self, query: str, user_id: str = "") -> list[dict[str, Any]]:
        results = self.shelfmark_client().search(query)
        now = time.monotonic()
        public = []
        with self._release_lock:
            self._book_tokens = {token: value for token, value in self._book_tokens.items() if value[0] > now}
            for result in results:
                token = secrets.token_urlsafe(24)
                self._book_tokens[token] = (now + 30 * 60, dict(result))
                catalog_id = self.store.catalog_match(result)
                in_library = bool(catalog_id and self.store.get_book_for_user(user_id, catalog_id))
                public.append({
                    **result,
                    "coverUrl": "",
                    "token": token,
                    "catalogBookId": catalog_id,
                    "inLibrary": in_library,
                })
        return public

    def releases(
        self, provider: str, provider_book_id: str, user_id: str = "local",
        *, title: str = "", authors: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        releases = self.shelfmark_client().releases(provider, provider_book_id, title=title, authors=authors)
        attempts = self.store.download_attempts(user_id, provider, provider_book_id)
        reliability_by_source = self.store.source_reliability()
        now = time.monotonic()
        public = []
        with self._release_lock:
            self._release_tokens = {
                token: value for token, value in self._release_tokens.items() if value[0] > now
            }
            for release in releases:
                token = secrets.token_urlsafe(24)
                release_id = str(release.get("id") or "")
                attempt = attempts.get(release_id)
                raw = release.pop("_release")
                self._release_tokens[token] = (now + 15 * 60, raw)
                source_name = str(release.get("catalogSource") or release.get("source") or "Unknown source")
                reliability = reliability_by_source.get(self.store._source_key(source_name))
                score, score_reasons = score_book_release(release, reliability)
                public.append({
                    **{key: value for key, value in release.items() if key != "id"},
                    "token": token,
                    "score": score,
                    "scoreReasons": score_reasons,
                    "sourceReliability": reliability or {
                        "source": source_name, "attempts": 0, "successes": 0, "failures": 0,
                        "successRate": None, "lastFailureCode": "",
                    },
                    "attemptStatus": attempt.get("status") if attempt else "",
                    "attemptError": attempt.get("error") if attempt else "",
                    "attemptErrorCode": attempt.get("errorCode") if attempt else "",
                    "attemptErrorAction": attempt.get("errorAction") if attempt else "",
                })
            if len(self._release_tokens) > 2000:
                oldest = sorted(self._release_tokens.items(), key=lambda item: item[1][0])
                for token, _ in oldest[:len(self._release_tokens) - 2000]:
                    self._release_tokens.pop(token, None)
        priority = {"": 0, "queued": 1, "downloading": 1, "importing": 1, "ready": 1, "failed": 2, "cancelled": 2}
        ranked = sorted(public, key=lambda item: (
            priority.get(item.get("attemptStatus", ""), 1),
            -int(item.get("score") or 0),
            -(item.get("downloads") or 0),
        ))
        untried = [item for item in ranked if not item.get("attemptStatus")]
        for item in ranked:
            if item.get("attemptStatus") == "failed":
                item["recommendation"] = "Previously failed"
            elif item is (untried[0] if untried else None):
                item["recommendation"] = "Recommended"
            elif not item.get("attemptStatus"):
                item["recommendation"] = "Alternative"
            else:
                item["recommendation"] = "In progress"
        return ranked

    def queue_download(self, release_token: str, book_token: str, user_id: str = "local") -> dict[str, Any]:
        with self._release_lock:
            cached = self._release_tokens.pop(str(release_token or ""), None)
            cached_book = self._book_tokens.get(str(book_token or ""))
        if not cached or cached[0] <= time.monotonic():
            raise ValueError("This release selection expired; search for releases again")
        if not cached_book or cached_book[0] <= time.monotonic():
            raise ValueError("This book selection expired; search for the book again")
        book = cached_book[1]
        title = str(book.get("title") or "").strip()[:1000]
        provider = str(book.get("provider") or "").strip()[:100]
        provider_book_id = str(book.get("providerBookId") or "").strip()[:300]
        if not title or not provider or not provider_book_id:
            raise ValueError("Book metadata is incomplete")
        raw_release = dict(cached[1])
        raw_release.update({
            "title": raw_release.get("title") or title,
            "author": ", ".join(self.store._authors(book.get("authors"))),
            "content_type": "ebook",
        })
        response = self.shelfmark_client().queue_download(raw_release)
        task_id = str(
            response.get("task_id") or response.get("taskId") or response.get("id")
            or raw_release.get("source_id") or raw_release.get("sourceId") or raw_release.get("id")
        )
        extra = raw_release.get("extra") if isinstance(raw_release.get("extra"), dict) else {}
        release_id = str(raw_release.get("source_id") or raw_release.get("sourceId") or raw_release.get("id") or task_id)
        source = str(raw_release.get("source") or raw_release.get("provider") or "")
        catalog_source = str(extra.get("direct_download_provider") or raw_release.get("indexer") or source)
        download = self.store.save_download(
            task_id=task_id,
            provider=provider,
            provider_book_id=provider_book_id,
            title=title,
            isbn=str(book.get("isbn") or ""),
            authors=self.store._authors(book.get("authors")),
            user_id=user_id,
            release_id=release_id,
            source=source,
            catalog_source=catalog_source,
        )
        self.store.reconcile_downloads()
        return self.store.get_download(task_id) or download

    def refresh_downloads(self, user_id: str = "local") -> list[dict[str, Any]]:
        tracked = {item["taskId"]: item for item in self.store.list_downloads(user_id)}
        if not tracked:
            return list(tracked.values())
        if not self.config.shelfmark_configured:
            self.store.fail_stale_imports()
            return self.store.list_downloads(user_id)
        payload = self.shelfmark_client().download_status()
        if isinstance(payload, dict):
            mappings = {
                "queued": "queued", "resolving": "downloading", "locating": "downloading",
                "downloading": "downloading", "complete": "importing", "available": "importing",
                "done": "importing", "error": "failed", "cancelled": "cancelled",
            }
            for shelfmark_status, local_status in mappings.items():
                entries = payload.get(shelfmark_status)
                if isinstance(entries, dict):
                    iterator = entries.items()
                elif isinstance(entries, list):
                    iterator = ((str(item.get("id") or item.get("source_id") or ""), item) for item in entries if isinstance(item, dict))
                else:
                    continue
                for task_id, item in iterator:
                    if task_id not in tracked:
                        continue
                    if tracked[task_id]["status"] == "importing" and local_status == "importing":
                        continue
                    progress_value = item.get("progress") if isinstance(item, dict) else None
                    try:
                        progress = max(0.0, min(1.0, float(progress_value) / (100 if float(progress_value) > 1 else 1)))
                    except (TypeError, ValueError):
                        progress = None
                    status_message = str(item.get("status_message") or item.get("message") or "").strip() if isinstance(item, dict) else ""
                    failure = classify_download_failure(status_message) if local_status == "failed" else {
                        "code": "", "message": "", "action": "",
                    }
                    self.store.update_download(
                        task_id, status=local_status, progress=progress, error=failure["message"],
                        failure_code=failure["code"], failure_action=failure["action"],
                    )
        self.store.reconcile_downloads()
        self.store.fail_stale_imports()
        return self.store.list_downloads(user_id)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
