from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
import base64
import hashlib
import hmac
import html
import json
import os
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
LIBRARY_LIMIT = 5000
LIBRARY_LOCK = threading.Lock()
REPORT_LOCK = threading.Lock()
SESSION_COOKIE = "panel_pilot_session"
SESSION_MAX_AGE = int(os.environ.get("PANEL_PILOT_SESSION_MAX_AGE", str(30 * 24 * 60 * 60)))


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


class PanelPilotHandler(SimpleHTTPRequestHandler):
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

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "login.html")
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
        if not content_type.startswith("image/"):
            raise ValueError("Manga detector expects an image")
        request = Request(
            f"{detector_base}/v1/manga/panels",
            data=self.rfile.read(length),
            headers={"Content-Type": content_type, "Accept": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=30) as response:
            payload = response.read()
            self.send_response(response.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
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
            if parsed.path == "/api/library":
                self.handle_library_get()
                return
        except Exception as error:
            self.send_json({"error": str(error)}, status=502)
            return

        super().do_GET()

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

    def clean_library_items(self, items):
        if not isinstance(items, list):
            return []
        cleaned = []
        seen = set()
        text_fields = ("mangaTitle", "sourceId", "sourceLabel", "chapterTitle", "panelMode", "readingDirection", "progressLabel", "updatedAt")
        number_fields = ("mangaId", "chapterId", "pageIndex", "panelIndex")
        bool_fields = ("pinned", "hidden", "isNsfw")
        for item in items:
            if not isinstance(item, dict):
                continue
            output = {}
            for field in number_fields:
                value = item.get(field)
                if isinstance(value, int) and value >= 0:
                    output[field] = value
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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
    server = ThreadingHTTPServer(("0.0.0.0", port), PanelPilotHandler)
    print(f"Panel Pilot server running on http://0.0.0.0:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
