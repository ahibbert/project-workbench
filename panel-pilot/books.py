"""Isolated book-domain configuration, storage, and connection services."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
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


class BooksService:
    def __init__(self, config: BooksConfig):
        if not config.enabled:
            raise ValueError("BooksService cannot be created while books are disabled")
        self.config = config
        self.store = BookStore(config.database_path)

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
        return {**self.config.public_status(), **self.store.counts()}

    def test_connection(self, target: str) -> dict[str, Any]:
        if target == "shelfmark":
            return {"target": target, **self.shelfmark_client().status()}
        if target == "cwa":
            return {"target": target, **self.opds_client().health()}
        raise ValueError("Connection target must be shelfmark or cwa")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
