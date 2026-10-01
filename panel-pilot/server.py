from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import base64
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from datetime import datetime, timezone


USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
LIBRARY_PATH = os.environ.get("PANEL_PILOT_LIBRARY_PATH", "/app/data/library.json")
REPORTS_PATH = os.environ.get("PANEL_PILOT_REPORTS_PATH", "/app/data/panel-reports")
DOWNLOAD_BUFFER_PATH = os.environ.get("PANEL_PILOT_DOWNLOAD_BUFFER_PATH", "/app/data/download-buffer.json")
MANGABAKA_CONFIG_PATH = os.environ.get("PANEL_PILOT_MANGABAKA_CONFIG_PATH", "/app/data/mangabaka-config.json")
MANGABAKA_API_BASE = "https://api.mangabaka.org"
LIBRARY_LIMIT = 5000
LIBRARY_LOCK = threading.Lock()
REPORT_LOCK = threading.Lock()
DETECTOR_CACHE_LOCK = threading.Lock()
MANGABAKA_LOCK = threading.Lock()
DOWNLOAD_BUFFER_MANAGER = None
SESSION_COOKIE = "panel_pilot_session"
SESSION_MAX_AGE = int(os.environ.get("PANEL_PILOT_SESSION_MAX_AGE", str(30 * 24 * 60 * 60)))
APP_ROOT = Path(__file__).resolve().parent
PROTECTED_STATIC_PATHS = {
    "/.dockerignore",
    "/docker-compose.yml",
    "/dockerfile",
    "/package-lock.json",
    "/package.json",
    "/server.py",
    "/vite.config.js",
}
PROTECTED_STATIC_PREFIXES = ("/.git/", "/__pycache__/", "/data/", "/tests/", "/tools/")


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


def read_mangabaka_token():
    configured = os.environ.get("MANGABAKA_API_KEY", "").strip()
    if configured:
        return configured
    try:
        with MANGABAKA_LOCK, open(MANGABAKA_CONFIG_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return str(payload.get("token") or "").strip()
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return ""


def write_mangabaka_token(token):
    directory = os.path.dirname(MANGABAKA_CONFIG_PATH) or "."
    os.makedirs(directory, exist_ok=True)
    with MANGABAKA_LOCK:
        if not token:
            try:
                os.unlink(MANGABAKA_CONFIG_PATH)
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
            os.replace(temporary_path, MANGABAKA_CONFIG_PATH)
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
    with urlopen(request, timeout=30) as response:
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
    host = parsed.netloc.lower()
    if parsed.scheme != "https":
        raise ValueError("Only https image URLs are supported")
    if not (
        host.endswith("comicknew.pictures")
        or host.endswith("comick.pictures")
        or host.endswith("bp.blogspot.com")
    ):
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


def detect_manga_image(image_bytes, content_type="application/octet-stream"):
    detector_base = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_URL", "").strip().rstrip("/")
    if not detector_base:
        raise RuntimeError("Manga model service is not configured")
    cache_version = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_CACHE_VERSION", "v1")
    cache_key = hashlib.sha256(cache_version.encode("utf-8") + b"\0" + image_bytes).hexdigest()
    cache_dir = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_CACHE_PATH", "/app/data/detector-cache")
    cache_path = os.path.join(cache_dir, f"{cache_key}.json")
    try:
        with open(cache_path, "rb") as handle:
            return handle.read(), "hit", 200
    except FileNotFoundError:
        pass
    request = Request(
        f"{detector_base}/v1/manga/panels",
        data=image_bytes,
        headers={"Content-Type": content_type, "Accept": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
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


class DownloadBufferManager:
    INTER_CHAPTER_DELAY = 90
    RETRY_BASE_DELAY = 3 * 60
    RETRY_MAX_DELAY = 6 * 60 * 60
    MAX_ATTEMPTS = 6

    def __init__(self, path=DOWNLOAD_BUFFER_PATH):
        self.path = path
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.failures = []
        self.prepared_chapters = set()
        self.requested_chapter_ids = []
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
                }, handle, separators=(",", ":"))
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)

    def enqueue(self, chapter_ids):
        added = 0
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
            window_changed = requested != self.requested_chapter_ids
            self.requested_chapter_ids = requested
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
            if added or window_changed:
                self.save_locked()
        self.wake.set()
        return {**self.status(), "added": added, "rejected": rejected}

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
            requested = list(self.requested_chapter_ids)
            requested_set = set(requested)
            task_by_id = {item["chapterId"]: dict(item) for item in self.tasks if item["chapterId"] in requested_set}
            failure_by_id = {item["chapterId"]: dict(item) for item in self.failures if item["chapterId"] in requested_set}
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
        base = os.environ.get("SUWAYOMI_INTERNAL_URL", "http://localhost:4567").strip().rstrip("/")
        body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        headers = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT}
        username = os.environ.get("SUWAYOMI_AUTH_USER", "").strip()
        password = os.environ.get("SUWAYOMI_AUTH_PASSWORD", "")
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        request = Request(f"{base}/api/graphql", data=body, headers=headers, method="POST")
        with urlopen(request, timeout=timeout) as response:
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
        base = os.environ.get("SUWAYOMI_INTERNAL_URL", "http://localhost:4567").strip().rstrip("/")
        username = os.environ.get("SUWAYOMI_AUTH_USER", "").strip()
        password = os.environ.get("SUWAYOMI_AUTH_PASSWORD", "")
        headers = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "User-Agent": USER_AGENT}
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        warmed = 0
        for path in pages:
            parsed = urlparse(str(path or ""))
            if parsed.scheme or parsed.netloc or not str(path).startswith("/api/v1/"):
                continue
            request = Request(f"{base}{path}", headers=headers, method="GET")
            with urlopen(request, timeout=30) as response:
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
        username = os.environ.get("PANEL_PILOT_AUTH_USER", "").strip()
        password = os.environ.get("PANEL_PILOT_AUTH_PASSWORD", "")
        return username, password

    def auth_enabled(self):
        return all(self.auth_credentials())

    def session_secret(self):
        configured = os.environ.get("PANEL_PILOT_SESSION_SECRET", "")
        if configured:
            return configured.encode("utf-8")
        username, password = self.auth_credentials()
        return hashlib.sha256(f"panel-pilot-session\0{username}\0{password}".encode("utf-8")).digest()

    def make_session_token(self, username):
        payload = json.dumps(
            {"sub": username, "exp": int(time.time()) + SESSION_MAX_AGE},
            separators=(",", ":"),
        ).encode("utf-8")
        encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
        signature = hmac.new(self.session_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
        encoded_signature = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        return f"{encoded}.{encoded_signature}"

    def valid_session(self):
        if not self.auth_enabled():
            return True

        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie[SESSION_COOKIE].value
            encoded, encoded_signature = token.split(".", 1)
            expected = hmac.new(self.session_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
            supplied = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
            if not hmac.compare_digest(expected, supplied):
                return False
            payload_bytes = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
            payload = json.loads(payload_bytes.decode("utf-8"))
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            return False

        try:
            expires_at = int(payload.get("exp", 0))
        except (TypeError, ValueError):
            return False
        username, _ = self.auth_credentials()
        return payload.get("sub") == username and expires_at >= int(time.time())

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
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def safe_next_path(self, value):
        return value if value.startswith("/") and not value.startswith("//") else "/"

    def handle_login_post(self):
        if not self.auth_enabled():
            self.redirect("/")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16384:
            self.redirect("/login?error=1")
            return
        form = parse_qs(self.rfile.read(length).decode("utf-8", errors="replace"))
        username = form.get("username", [""])[0]
        password = form.get("password", [""])[0]
        expected_username, expected_password = self.auth_credentials()
        valid = secrets.compare_digest(username, expected_username) and secrets.compare_digest(password, expected_password)
        next_path = self.safe_next_path(form.get("next", ["/"])[0])
        if not valid:
            self.redirect(f"/login?{urlencode({'error': '1', 'next': next_path})}")
            return

        token = self.make_session_token(expected_username)
        self.redirect(next_path, self.session_cookie_header(token, SESSION_MAX_AGE))

    def handle_logout_post(self):
        self.redirect("/login", self.session_cookie_header("", 0))

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/login":
            self.handle_login_post()
            return
        if parsed.path == "/logout":
            self.handle_logout_post()
            return
        if not self.require_auth(parsed):
            return
        try:
            if parsed.path == "/api/suwayomi/graphql":
                self.handle_suwayomi_graphql(parsed)
                return
            if parsed.path == "/api/library":
                self.handle_library_post()
                return
            if parsed.path == "/api/panel-report":
                self.handle_panel_report_post()
                return
            if parsed.path == "/api/download-buffer":
                self.handle_download_buffer_post()
                return
            if parsed.path == "/api/mangabaka/config":
                self.handle_mangabaka_config_post()
                return
            if parsed.path == "/api/mangabaka/library":
                self.handle_mangabaka_library_post()
                return
            if parsed.path == "/api/detect/manga":
                self.handle_manga_detection()
                return
        except Exception as error:
            self.send_json({"error": str(error)}, status=502)
            return

        self.send_json({"error": "Unknown POST endpoint"}, status=404)

    def handle_manga_detection(self):
        detector_base = os.environ.get("PANEL_PILOT_MANGA_DETECTOR_URL", "").strip().rstrip("/")
        if not detector_base:
            self.send_json({"error": "Manga model service is not configured"}, status=503)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 12000000:
            raise ValueError("Manga detector image is empty or too large")
        content_type = self.headers.get("Content-Type", "application/octet-stream")
        request_body = self.rfile.read(length)
        if content_type.startswith("application/json"):
            if length > 16384:
                raise ValueError("Manga detector URL request is too large")
            payload = json.loads(request_body.decode("utf-8"))
            image_bytes, content_type = self.fetch_manga_detection_asset(payload.get("url", ""))
        elif content_type.startswith("image/"):
            image_bytes = request_body
        else:
            raise ValueError("Manga detector expects an image or a Suwayomi asset URL")
        payload, cache_state, status = detect_manga_image(image_bytes, content_type)
        self.send_detector_payload(payload, cache_state, status=status)

    def fetch_manga_detection_asset(self, raw_url):
        parsed = urlparse(str(raw_url or ""))
        if parsed.scheme or parsed.netloc or parsed.path != "/api/suwayomi/asset":
            raise ValueError("Manga detector URL must be a local Suwayomi asset")
        params = parse_qs(parsed.query)
        base = self.resolve_suwayomi_base(params.get("base", ["http://localhost:4567"])[0])
        path = unquote(params.get("path", [""])[0])
        parsed_path = urlparse(path)
        if parsed_path.scheme or parsed_path.netloc or not path.startswith("/api/v1/") or path.startswith("//"):
            raise ValueError("Manga detector asset path is invalid")
        request = Request(
            f"{base}{path}",
            headers=self.suwayomi_headers(accept="image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
            method="GET",
        )
        with urlopen(request, timeout=30) as response:
            image_bytes = response.read()
            if not image_bytes or len(image_bytes) > 12000000:
                raise ValueError("Manga detector asset is empty or too large")
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
        if payload.get("retryFailed") is True:
            self.send_json(DOWNLOAD_BUFFER_MANAGER.retry_failures())
            return
        remove_chapter_ids = payload.get("removeChapterIds")
        if isinstance(remove_chapter_ids, list):
            self.send_json(DOWNLOAD_BUFFER_MANAGER.remove(remove_chapter_ids))
            return
        chapter_ids = payload.get("chapterIds")
        if not isinstance(chapter_ids, list):
            raise ValueError("chapterIds must be a list")
        self.send_json(DOWNLOAD_BUFFER_MANAGER.enqueue(chapter_ids))

    def do_GET(self):
        parsed = urlparse(self.path)
        if self.protected_static_request(parsed.path):
            self.send_error(404, "Not found")
            return
        if parsed.path == "/login":
            self.serve_login(parsed)
            return
        if not self.require_auth(parsed):
            return
        try:
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
            if parsed.path == "/api/mangabaka/status":
                self.handle_mangabaka_status()
                return
            if parsed.path == "/api/mangabaka/recommendations":
                self.handle_mangabaka_recommendations(parsed)
                return
            if parsed.path == "/api/mangabaka/search":
                self.handle_mangabaka_search(parsed)
                return
        except Exception as error:
            self.send_json({"error": str(error)}, status=502)
            return

        super().do_GET()

    def mangabaka_json(self, path, method="GET", payload=None, token=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Invalid MangaBaka API path")
        headers = {
            "Accept": "application/json",
            "User-Agent": "PanelPilot/1.0 (+https://panels.aydins-workbench.com)",
        }
        active_token = token if token is not None else read_mangabaka_token()
        if active_token:
            headers["x-api-key"] = active_token
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"{MANGABAKA_API_BASE}{path}", data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
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

    def handle_mangabaka_config_post(self):
        payload = self.read_json_request(16384)
        if payload.get("clear") is True:
            if os.environ.get("MANGABAKA_API_KEY", "").strip():
                raise ValueError("The MangaBaka token is configured by the server environment and cannot be removed here")
            write_mangabaka_token("")
            self.send_json({"configured": False})
            return
        token = str(payload.get("token") or "").strip()
        if not token.startswith("mb-") or len(token) < 12 or len(token) > 512:
            raise ValueError("Enter a valid MangaBaka Personal Access Token beginning with mb-")
        profile = self.mangabaka_json("/v1/my/profile", token=token)
        write_mangabaka_token(token)
        self.send_json({"configured": True, "profile": profile.get("data") or profile.get("profile") or {}})

    def handle_mangabaka_status(self):
        token = read_mangabaka_token()
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
        token = read_mangabaka_token()
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

    def handle_mangabaka_search(self, parsed):
        params = parse_qs(parsed.query)
        query = str(params.get("q", [""])[0]).strip()
        if not query or len(query) > 300:
            raise ValueError("Enter a MangaBaka search title")
        api_query = urlencode({"q": query, "limit": 8, "schema": "full"})
        payload = self.mangabaka_json(f"/v2/series/search?{api_query}", token="")
        self.send_json(payload)

    def handle_mangabaka_library_post(self):
        token = read_mangabaka_token()
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

    def read_library_items(self):
        with LIBRARY_LOCK:
            try:
                with open(LIBRARY_PATH, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
            except FileNotFoundError:
                return []
            if isinstance(payload, dict):
                items = payload.get("items", [])
            else:
                items = payload
            return self.clean_library_items(items)

    def write_library_items(self, items):
        cleaned = self.clean_library_items(items)
        directory = os.path.dirname(LIBRARY_PATH)
        with LIBRARY_LOCK:
            os.makedirs(directory, exist_ok=True)
            try:
                with open(LIBRARY_PATH, "r", encoding="utf-8") as handle:
                    existing_payload = json.load(handle)
                existing = self.clean_library_items(
                    existing_payload.get("items", []) if isinstance(existing_payload, dict) else existing_payload
                )
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                existing = []
            cleaned = self.merge_library_items(cleaned, existing)
            fd, temp_path = tempfile.mkstemp(prefix=".library-", suffix=".json", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump({"items": cleaned}, handle, ensure_ascii=True, indent=2)
                    handle.write("\n")
                os.replace(temp_path, LIBRARY_PATH)
            finally:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
        return cleaned

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
        text_fields = ("mangaTitle", "sourceId", "sourceLabel", "chapterTitle", "panelMode", "readingDirection", "progressLabel", "updatedAt", "libraryStatus", "mangabakaTitle", "mangabakaMatchSource", "mangabakaAccountKey")
        number_fields = ("mangaId", "chapterId", "pageIndex", "panelIndex", "mangabakaId")
        bool_fields = ("pinned", "hidden", "isNsfw", "statusExplicit", "suwayomiLibrary", "started")
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
        base = raw_base.strip().rstrip("/")
        parsed_base = urlparse(base)
        internal_base = os.environ.get("SUWAYOMI_INTERNAL_URL", "").strip().rstrip("/")
        using_internal_base = False
        if internal_base and parsed_base.hostname in ("localhost", "127.0.0.1"):
            base = internal_base
            parsed_base = urlparse(base)
            using_internal_base = True
        if parsed_base.scheme not in ("http", "https"):
            raise ValueError("Suwayomi URL must start with http:// or https://")
        allowed_hosts = ("localhost", "127.0.0.1", "0.0.0.0")
        host = parsed_base.hostname or ""
        private_lan = host.startswith("192.168.") or host.startswith("10.") or host.startswith("172.")
        if not using_internal_base and host not in allowed_hosts and not private_lan:
            raise ValueError("Suwayomi proxy only allows localhost or private LAN URLs")
        return base

    def suwayomi_headers(self, accept="application/json", content_type=None):
        headers = {
            "Accept": accept,
            "User-Agent": USER_AGENT,
        }
        if content_type:
            headers["Content-Type"] = content_type
        suwayomi_user = os.environ.get("SUWAYOMI_AUTH_USER", "").strip()
        suwayomi_password = os.environ.get("SUWAYOMI_AUTH_PASSWORD", "")
        if suwayomi_user and suwayomi_password:
            token = base64.b64encode(f"{suwayomi_user}:{suwayomi_password}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        return headers

    def handle_suwayomi_graphql(self, parsed):
        params = parse_qs(parsed.query)
        base = self.resolve_suwayomi_base(params.get("base", ["http://localhost:4567"])[0])
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        request = Request(
            f"{base}/api/graphql",
            data=body,
            headers=self.suwayomi_headers(content_type="application/json"),
            method="POST",
        )
        with urlopen(request, timeout=30) as response:
            payload = response.read()
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type") or "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def handle_suwayomi_asset(self, parsed):
        params = parse_qs(parsed.query)
        base = self.resolve_suwayomi_base(params.get("base", ["http://localhost:4567"])[0])
        path = params.get("path", [""])[0]
        parsed_path = urlparse(path)
        if parsed_path.scheme or parsed_path.netloc or not path.startswith("/") or path.startswith("//"):
            raise ValueError("Suwayomi asset path must be a relative absolute path")
        if not path.startswith("/api/v1/"):
            raise ValueError("Suwayomi asset path must start with /api/v1/")

        request = Request(
            f"{base}{path}",
            headers=self.suwayomi_headers(accept="image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
            method="GET",
        )
        with urlopen(request, timeout=30) as response:
            payload = response.read()
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type") or "application/octet-stream")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Access-Control-Allow-Origin", "*")
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
        image_host = urlparse(raw_url).netloc.lower()
        referer = "https://readcomiconline.li/" if image_host.endswith("bp.blogspot.com") else "https://comick.live/"
        _, headers, body = fetch_url(
            raw_url,
            accept="image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            referer=referer,
        )
        content_type = headers.get("Content-Type") or "image/webp"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global DOWNLOAD_BUFFER_MANAGER
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
    static_root = resolve_static_root()
    DOWNLOAD_BUFFER_MANAGER = DownloadBufferManager()
    DOWNLOAD_BUFFER_MANAGER.start()
    handler = lambda *args, **kwargs: PanelPilotHandler(*args, directory=static_root, **kwargs)
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"Panels server running on http://0.0.0.0:{port} from {static_root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
