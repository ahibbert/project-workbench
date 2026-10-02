"""Isolated book-domain configuration, storage, and connection services."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any

from opds_client import OpdsClient, OpdsConfig, OpdsError
from shelfmark_client import ShelfmarkClient, ShelfmarkConfig, ShelfmarkError


BOOKS_SCHEMA_VERSION = 1


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

    def counts(self) -> dict[str, int]:
        with self.lock, self.connection() as connection:
            books = int(connection.execute("SELECT COUNT(*) FROM books").fetchone()[0])
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

    def list_books(self, query: str = "", limit: int = 100, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(200, int(limit)))
        offset = max(0, int(offset))
        query = str(query or "").strip()[:300]
        where = ""
        parameters: list[Any] = []
        if query:
            where = "WHERE title LIKE ? ESCAPE '\\' OR authors_json LIKE ? ESCAPE '\\'"
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            parameters.extend([f"%{escaped}%", f"%{escaped}%"])
        with self.lock, self.connection() as connection:
            total = int(connection.execute(f"SELECT COUNT(*) FROM books {where}", parameters).fetchone()[0])
            rows = connection.execute(
                f"SELECT * FROM books {where} ORDER BY title COLLATE NOCASE, id LIMIT ? OFFSET ?",
                (*parameters, limit, offset),
            ).fetchall()
        return {"books": [self._row_public(row) for row in rows], "total": total, "limit": limit, "offset": offset}

    def get_book(self, book_id: int, *, public: bool = True) -> dict[str, Any] | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM books WHERE id = ?", (int(book_id),)).fetchone()
        if not row:
            return None
        if public:
            return self._row_public(row)
        return dict(row)

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


class BooksService:
    def __init__(self, config: BooksConfig):
        if not config.enabled:
            raise ValueError("BooksService cannot be created while books are disabled")
        self.config = config
        self.store = BookStore(config.database_path)
        self._sync_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._last_error = ""

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
        return {
            **self.config.public_status(),
            **self.store.counts(),
            "lastSync": self.store.last_sync(),
            "syncError": self._last_error,
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

    def list_books(self, query: str = "", limit: int = 100, offset: int = 0) -> dict[str, Any]:
        return self.store.list_books(query, limit, offset)

    def get_book(self, book_id: int) -> dict[str, Any] | None:
        return self.store.get_book(book_id)

    def cover(self, book_id: int) -> tuple[bytes, str]:
        book = self.store.get_book(book_id, public=False)
        if not book:
            raise KeyError("Book not found")
        if not book["cover_href"]:
            raise KeyError("Book has no cover")
        return self.opds_client().cover(book["cover_href"])


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
