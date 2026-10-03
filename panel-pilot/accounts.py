"""Local multi-account identity store for Panels."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import uuid


ALL_CONTENT_TYPES = ("books", "manga", "comic", "webtoon")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AccountError(ValueError):
    pass


class AccountStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._migrate()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 15000")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _migrate(self):
        with self.lock, self.connection() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    display_name TEXT NOT NULL,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    content_types_json TEXT NOT NULL DEFAULT '["books"]',
                    session_version INTEGER NOT NULL DEFAULT 1,
                    disabled INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
            """)

    @staticmethod
    def _password_hash(password: str, salt: bytes) -> bytes:
        return hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32,
        )

    @staticmethod
    def _clean_username(username: str) -> str:
        value = str(username or "").strip()
        if not USERNAME_PATTERN.fullmatch(value):
            raise AccountError("Username must be 2–40 characters using letters, numbers, dots, dashes, or underscores")
        return value

    @staticmethod
    def _clean_password(password: str) -> str:
        value = str(password or "")
        if len(value) < 12 or len(value) > 1024:
            raise AccountError("Password must be at least 12 characters")
        return value

    @staticmethod
    def _clean_content_types(values) -> tuple[str, ...]:
        requested = set(values if isinstance(values, (list, tuple, set)) else ())
        cleaned = tuple(value for value in ALL_CONTENT_TYPES if value in requested)
        if not cleaned:
            raise AccountError("Enable at least one content type")
        return cleaned

    @staticmethod
    def _public(row) -> dict | None:
        if not row:
            return None
        try:
            content_types = json.loads(row["content_types_json"])
        except (json.JSONDecodeError, TypeError):
            content_types = ["books"]
        return {
            "id": row["id"],
            "username": row["username"],
            "displayName": row["display_name"],
            "isAdmin": bool(row["is_admin"]),
            "contentTypes": [value for value in ALL_CONTENT_TYPES if value in content_types],
            "sessionVersion": int(row["session_version"]),
            "disabled": bool(row["disabled"]),
            "createdAt": row["created_at"],
        }

    def ensure_owner(self, username: str, password: str) -> dict | None:
        if not username and not password:
            return None
        # Preserve credentials from deployments that predate household
        # accounts. The stronger username/password policy applies to new and
        # reset secondary accounts, but silently rejecting the configured
        # owner here would lock an existing installation out during upgrade.
        username = str(username or "").replace("\x00", "").strip()[:200]
        password = str(password or "")
        if not username or not password or len(password) > 1024:
            raise AccountError("The configured owner credentials are invalid")
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM accounts WHERE is_admin = 1 ORDER BY created_at LIMIT 1").fetchone()
            now = utc_now()
            if not row:
                salt = secrets.token_bytes(16)
                account_id = f"acct_{uuid.uuid4().hex}"
                connection.execute(
                    "INSERT INTO accounts VALUES (?,?,?,?,?,1,?,1,0,?,?)",
                    (account_id, username, username, salt, self._password_hash(password, salt), json.dumps(ALL_CONTENT_TYPES), now, now),
                )
            else:
                account_id = row["id"]
                password_matches = hmac.compare_digest(
                    bytes(row["password_hash"]), self._password_hash(password, bytes(row["password_salt"])),
                )
                changed = row["username"].casefold() != username.casefold() or not password_matches
                if changed:
                    salt = secrets.token_bytes(16)
                    connection.execute(
                        "UPDATE accounts SET username=?,display_name=?,password_salt=?,password_hash=?,session_version=session_version+1,updated_at=? WHERE id=?",
                        (username, username, salt, self._password_hash(password, salt), now, account_id),
                    )
            row = connection.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        return self._public(row)

    def authenticate(self, username: str, password: str) -> dict | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM accounts WHERE username=? COLLATE NOCASE", (str(username or "").strip(),)).fetchone()
        if not row or row["disabled"]:
            return None
        supplied = self._password_hash(str(password or ""), bytes(row["password_salt"]))
        return self._public(row) if hmac.compare_digest(bytes(row["password_hash"]), supplied) else None

    def by_id(self, account_id: str) -> dict | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM accounts WHERE id=?", (str(account_id or ""),)).fetchone()
        return self._public(row)

    def by_username(self, username: str) -> dict | None:
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT * FROM accounts WHERE username=? COLLATE NOCASE", (str(username or ""),)).fetchone()
        return self._public(row)

    def list_accounts(self) -> list[dict]:
        with self.lock, self.connection() as connection:
            rows = connection.execute("SELECT * FROM accounts ORDER BY is_admin DESC, username COLLATE NOCASE").fetchall()
        return [self._public(row) for row in rows]

    def create(self, username: str, password: str, display_name: str = "", content_types=("books",)) -> dict:
        username = self._clean_username(username)
        password = self._clean_password(password)
        content_types = self._clean_content_types(content_types)
        if any(value != "books" for value in content_types):
            raise AccountError("Additional household accounts are books-only until a dedicated Suwayomi service is attached")
        display_name = str(display_name or username).replace("\x00", "").strip()[:80] or username
        salt = secrets.token_bytes(16)
        now = utc_now()
        account_id = f"acct_{uuid.uuid4().hex}"
        try:
            with self.lock, self.connection() as connection:
                connection.execute(
                    "INSERT INTO accounts VALUES (?,?,?,?,?,0,?,1,0,?,?)",
                    (account_id, username, display_name, salt, self._password_hash(password, salt), json.dumps(content_types), now, now),
                )
        except sqlite3.IntegrityError as error:
            raise AccountError("That username is already in use") from error
        return self.by_id(account_id)

    def update_content_types(self, account_id: str, content_types) -> dict:
        cleaned = self._clean_content_types(content_types)
        with self.lock, self.connection() as connection:
            row = connection.execute("SELECT is_admin FROM accounts WHERE id=?", (account_id,)).fetchone()
            if not row:
                raise AccountError("Account not found")
            if row["is_admin"]:
                cleaned = ALL_CONTENT_TYPES
            elif any(value != "books" for value in cleaned):
                raise AccountError("Attach a dedicated Suwayomi service before enabling manga, comics, or webtoons")
            connection.execute(
                "UPDATE accounts SET content_types_json=?,updated_at=? WHERE id=?",
                (json.dumps(cleaned), utc_now(), account_id),
            )
        return self.by_id(account_id)

    def reset_password(self, account_id: str, password: str) -> dict:
        password = self._clean_password(password)
        salt = secrets.token_bytes(16)
        with self.lock, self.connection() as connection:
            result = connection.execute(
                "UPDATE accounts SET password_salt=?,password_hash=?,session_version=session_version+1,updated_at=? WHERE id=?",
                (salt, self._password_hash(password, salt), utc_now(), account_id),
            )
            if result.rowcount != 1:
                raise AccountError("Account not found")
        return self.by_id(account_id)


__all__ = ["ALL_CONTENT_TYPES", "AccountError", "AccountStore"]
