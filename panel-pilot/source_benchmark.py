"""Privacy-safe, read-only source benchmarking for a Panels/Suwayomi installation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
import json
import re
import struct
import time
from typing import Callable, Protocol


FORMATS = {"manga", "comic", "webtoon"}
ERROR_CLASSES = {
    "", "timeout", "rate_limited", "blocked", "network", "upstream",
    "invalid_image", "empty", "unknown",
}
RUN_FIELDS = {
    "runId", "suiteVersion", "status", "startedAt", "finishedAt",
    "requestedBy", "appVersion", "errorClass",
}
RESULT_FIELDS = {
    "caseId", "sourceId", "mediaFormat", "matchScore", "usable",
    "chapterCount", "pageCount", "fetchSuccesses", "fetchFailures",
    "durationMs", "errorClass",
}
OBSERVATION_FIELDS = {
    "sourceId", "operation", "outcome", "errorClass", "latencyMs", "byteCount",
    "width", "height", "codec", "clarity", "placeholder", "mediaFormat",
    "origin", "runId", "occurredAt",
}
SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9._+:-]{1,80}$")


class BenchmarkError(RuntimeError):
    """An intentionally generic benchmark failure safe to classify and report."""

    def __init__(self, error_class="unknown"):
        super().__init__(error_class)
        self.error_class = error_class if error_class in ERROR_CLASSES else "unknown"


@dataclass(frozen=True)
class BenchmarkCase:
    case_id: str
    media_format: str
    query: str
    aliases: tuple[str, ...]

    def __post_init__(self):
        if not SAFE_ID_PATTERN.fullmatch(self.case_id):
            raise ValueError("Benchmark case ID is invalid")
        if self.media_format not in FORMATS:
            raise ValueError("Benchmark media format is invalid")
        if not self.query.strip() or not self.aliases:
            raise ValueError("Benchmark cases require an in-memory query and aliases")


# These public, fixed probes are deliberately kept out of every persisted payload.
DEFAULT_CASES = (
    BenchmarkCase("manga-primary-01", "manga", "Golden Kamuy", ("Golden Kamuy", "Golden Kamui")),
    BenchmarkCase("manga-primary-02", "manga", "Monster", ("Monster",)),
    BenchmarkCase("comic-primary-01", "comic", "Invincible", ("Invincible", "Invincible (2003)")),
    BenchmarkCase("comic-primary-02", "comic", "Saga", ("Saga",)),
    BenchmarkCase("comic-primary-03", "comic", "Y The Last Man", ("Y: The Last Man", "Y The Last Man")),
    BenchmarkCase("webtoon-primary-01", "webtoon", "Solo Leveling", ("Solo Leveling",)),
    BenchmarkCase("webtoon-primary-02", "webtoon", "Tower of God", ("Tower of God",)),
)


class SourceGateway(Protocol):
    def search(self, source_id: str, query: str) -> list[dict]: ...
    def chapters(self, manga_id) -> list[dict]: ...
    def pages(self, chapter_id) -> list[str]: ...
    def image(self, page_reference: str) -> tuple[bytes, str]: ...


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_title(value):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).split())


def title_match_score(title, aliases):
    candidate = normalize_title(title)
    if not candidate:
        return 0.0
    scores = []
    for alias in aliases:
        expected = normalize_title(alias)
        if candidate == expected:
            return 1.0
        ratio = SequenceMatcher(None, candidate, expected).ratio()
        candidate_tokens = set(candidate.split())
        expected_tokens = set(expected.split())
        overlap = len(candidate_tokens & expected_tokens) / max(1, len(expected_tokens))
        scores.append(0.7 * ratio + 0.3 * overlap)
    return max(scores, default=0.0)


def image_metadata(payload, content_type=""):
    """Return width, height and a bounded codec using only image headers."""
    data = bytes(payload or b"")
    lowered_type = str(content_type or "").lower()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24]) + ("png",)
    if data[:3] == b"GIF" and len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return width, height, "gif"
    if data.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 9 <= len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            offset += 2
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if offset + 2 > len(data):
                break
            length = int.from_bytes(data[offset:offset + 2], "big")
            if length < 2 or offset + length > len(data):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(data[offset + 3:offset + 5], "big")
                width = int.from_bytes(data[offset + 5:offset + 7], "big")
                return width, height, "jpeg"
            offset += length
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
            return width, height, "webp"
        if chunk == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1, "webp"
        if chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
            return width, height, "webp"
    if b"ftypavif" in data[:32] or b"ftypavis" in data[:32] or "avif" in lowered_type:
        offset = data.find(b"ispe")
        if offset >= 0 and offset + 16 <= len(data):
            width = int.from_bytes(data[offset + 8:offset + 12], "big")
            height = int.from_bytes(data[offset + 12:offset + 16], "big")
            if width and height:
                return width, height, "avif"
    raise BenchmarkError("invalid_image")


def classify_exception(error):
    if isinstance(error, BenchmarkError):
        return error.error_class
    name = type(error).__name__.lower()
    message = str(error).lower()
    code = getattr(error, "code", None)
    if code == 429 or "rate limit" in message or "too many requests" in message:
        return "rate_limited"
    if code in (401, 403) or "forbidden" in message or "cloudflare" in message:
        return "blocked"
    if "timeout" in name or "timeout" in message:
        return "timeout"
    if code is not None and int(code) >= 500:
        return "upstream"
    if isinstance(error, (ConnectionError, OSError)):
        return "network"
    return "unknown"


def spread_indices(length, count):
    if length <= 0 or count <= 0:
        return []
    if count >= length:
        return list(range(length))
    if count == 1:
        return [length // 2]
    return sorted({round(index * (length - 1) / (count - 1)) for index in range(count)})


class SourceBenchmarkRunner:
    def __init__(
        self,
        gateway: SourceGateway,
        *,
        cases=DEFAULT_CASES,
        images_per_case=1,
        minimum_match=0.72,
        delay_seconds=0.5,
        clock: Callable[[], float] = time.monotonic,
        timestamp: Callable[[], str] = utc_now,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        self.gateway = gateway
        self.cases = tuple(cases)
        self.images_per_case = max(1, min(3, int(images_per_case)))
        self.minimum_match = float(minimum_match)
        self.delay_seconds = max(0, float(delay_seconds))
        self.clock = clock
        self.timestamp = timestamp
        self.sleeper = sleeper

    def _timed(self, callback):
        started = self.clock()
        try:
            return callback(), max(0, round((self.clock() - started) * 1000)), ""
        except Exception as error:
            return None, max(0, round((self.clock() - started) * 1000)), classify_exception(error)

    def _observation(self, source_id, media_format, run_id, operation, outcome, latency_ms, **values):
        item = {
            "sourceId": source_id,
            "operation": operation,
            "outcome": outcome,
            "errorClass": values.pop("errorClass", ""),
            "latencyMs": latency_ms,
            "byteCount": values.pop("byteCount", 0),
            "width": values.pop("width", 0),
            "height": values.pop("height", 0),
            "codec": values.pop("codec", ""),
            "clarity": None,
            "placeholder": False,
            "mediaFormat": media_format,
            "origin": "benchmark",
            "runId": run_id,
            "occurredAt": self.timestamp(),
        }
        if values:
            raise ValueError("Unexpected observation fields")
        return item

    def benchmark_case(self, source_id, case, run_id):
        started = self.clock()
        observations = []
        fetch_successes = 0
        fetch_failures = 0
        chapter_count = 0
        page_count = 0
        top_error = ""

        mangas, latency, error_class = self._timed(lambda: self.gateway.search(source_id, case.query))
        if error_class:
            observations.append(self._observation(
                source_id, case.media_format, run_id, "search", "failure", latency, errorClass=error_class
            ))
            return self._result(case, source_id, started, 0, False, 0, 0, 0, 1, error_class), observations

        candidates = mangas if isinstance(mangas, list) else []
        ranked = sorted(
            (
                (title_match_score(item.get("title"), case.aliases), item)
                for item in candidates
                if isinstance(item, dict) and item.get("id") is not None
            ),
            key=lambda entry: entry[0],
            reverse=True,
        )
        match_score, manga = ranked[0] if ranked else (0.0, None)
        if manga is None or match_score < self.minimum_match:
            observations.append(self._observation(
                source_id, case.media_format, run_id, "search", "coverage_miss", latency
            ))
            return self._result(case, source_id, started, match_score, False, 0, 0, 0, 0, ""), observations
        observations.append(self._observation(
            source_id, case.media_format, run_id, "search", "success", latency
        ))
        self.sleeper(self.delay_seconds)

        chapters, latency, error_class = self._timed(lambda: self.gateway.chapters(manga.get("id")))
        if error_class:
            observations.append(self._observation(
                source_id, case.media_format, run_id, "chapters", "failure", latency, errorClass=error_class
            ))
            return self._result(case, source_id, started, match_score, False, 0, 0, 0, 1, error_class), observations
        chapters = [chapter for chapter in (chapters or []) if isinstance(chapter, dict) and chapter.get("id") is not None]
        chapter_count = len(chapters)
        outcome = "success" if chapters else "coverage_miss"
        observations.append(self._observation(
            source_id, case.media_format, run_id, "chapters", outcome, latency
        ))
        if not chapters:
            return self._result(case, source_id, started, match_score, False, 0, 0, 0, 0, ""), observations
        self.sleeper(self.delay_seconds)

        chapter = chapters[len(chapters) // 2]
        pages, latency, error_class = self._timed(lambda: self.gateway.pages(chapter["id"]))
        if error_class:
            observations.append(self._observation(
                source_id, case.media_format, run_id, "page_list", "failure", latency, errorClass=error_class
            ))
            return self._result(case, source_id, started, match_score, False, chapter_count, 0, 0, 1, error_class), observations
        pages = [page for page in (pages or []) if isinstance(page, str) and page]
        page_count = len(pages)
        outcome = "success" if pages else "coverage_miss"
        observations.append(self._observation(
            source_id, case.media_format, run_id, "page_list", outcome, latency
        ))
        if not pages:
            return self._result(case, source_id, started, match_score, False, chapter_count, 0, 0, 0, ""), observations

        for page_index in spread_indices(page_count, self.images_per_case):
            self.sleeper(self.delay_seconds)
            response, latency, error_class = self._timed(lambda index=page_index: self.gateway.image(pages[index]))
            if error_class:
                fetch_failures += 1
                top_error = top_error or error_class
                observations.append(self._observation(
                    source_id, case.media_format, run_id, "image_fetch", "failure", latency,
                    errorClass=error_class,
                ))
                continue
            try:
                image_bytes, content_type = response
                width, height, codec = image_metadata(image_bytes, content_type)
            except Exception as error:
                fetch_failures += 1
                error_class = classify_exception(error)
                top_error = top_error or error_class
                byte_count = len(response[0]) if (
                    isinstance(response, tuple) and response and isinstance(response[0], (bytes, bytearray))
                ) else 0
                observations.append(self._observation(
                    source_id, case.media_format, run_id, "image_fetch", "failure", latency,
                    errorClass=error_class, byteCount=byte_count,
                ))
                continue
            fetch_successes += 1
            observations.append(self._observation(
                source_id, case.media_format, run_id, "image_fetch", "success", latency,
                byteCount=len(image_bytes), width=width, height=height, codec=codec,
            ))

        usable = bool(page_count and fetch_successes)
        return self._result(
            case, source_id, started, match_score, usable, chapter_count, page_count,
            fetch_successes, fetch_failures, top_error,
        ), observations

    def _result(
        self, case, source_id, started, match_score, usable, chapter_count, page_count,
        fetch_successes, fetch_failures, error_class,
    ):
        return {
            "caseId": case.case_id,
            "sourceId": source_id,
            "mediaFormat": case.media_format,
            "matchScore": round(max(0, min(1, float(match_score))), 4),
            "usable": bool(usable),
            "chapterCount": int(chapter_count),
            "pageCount": int(page_count),
            "fetchSuccesses": int(fetch_successes),
            "fetchFailures": int(fetch_failures),
            "durationMs": max(0, round((self.clock() - started) * 1000)),
            "errorClass": error_class if error_class in ERROR_CLASSES else "unknown",
        }

    def run(self, sources, run_id, suite_version="source-suite-1", app_version="benchmark-cli-1"):
        if not SAFE_ID_PATTERN.fullmatch(str(run_id or "")):
            raise ValueError("Benchmark run ID is invalid")
        if not VERSION_PATTERN.fullmatch(str(suite_version or "")):
            raise ValueError("Benchmark suite version is invalid")
        if not VERSION_PATTERN.fullmatch(str(app_version or "")):
            raise ValueError("Benchmark app version is invalid")
        started_at = self.timestamp()
        results = []
        observations = []
        for source in sources:
            source_id = str(source.get("sourceId") or "")
            formats = set(source.get("formats") or []) & FORMATS
            if not SAFE_ID_PATTERN.fullmatch(source_id) or not formats:
                raise ValueError("Benchmark source inventory is invalid")
            for case in self.cases:
                if case.media_format not in formats:
                    continue
                result, case_observations = self.benchmark_case(source_id, case, run_id)
                results.append(result)
                observations.extend(case_observations)
        if not results:
            raise ValueError("No source/case combinations were selected")
        if len(results) > 500 or len(observations) > 500:
            raise ValueError("Benchmark selection exceeds the Panels 500-record request limit")
        report = {
            "benchmark": {
                "schemaVersion": 1,
                "run": {
                    "runId": run_id,
                    "suiteVersion": suite_version,
                    "status": "completed",
                    "startedAt": started_at,
                    "finishedAt": self.timestamp(),
                    "requestedBy": "cli",
                    "appVersion": app_version,
                    "errorClass": "",
                },
                "results": results,
            },
            "observations": {
                "schemaVersion": 1,
                "observations": observations,
            },
        }
        assert_sanitized_report(report)
        return report


def assert_sanitized_report(report):
    if set(report) != {"benchmark", "observations"}:
        raise ValueError("Benchmark report envelope is invalid")
    benchmark = report["benchmark"]
    observations = report["observations"]
    if set(benchmark) != {"schemaVersion", "run", "results"} or benchmark.get("schemaVersion") != 1:
        raise ValueError("Benchmark payload is invalid")
    if set(benchmark.get("run") or {}) != RUN_FIELDS:
        raise ValueError("Benchmark run contains unsafe fields")
    if any(set(result) != RESULT_FIELDS for result in benchmark.get("results") or []):
        raise ValueError("Benchmark result contains unsafe fields")
    if set(observations) != {"schemaVersion", "observations"} or observations.get("schemaVersion") != 1:
        raise ValueError("Observation payload is invalid")
    if any(set(item) != OBSERVATION_FIELDS for item in observations.get("observations") or []):
        raise ValueError("Benchmark observation contains unsafe fields")
    serialized = json.dumps(report, separators=(",", ":")).lower()
    for prohibited in ("title", "url", "query", "imagebytes", "blob"):
        if f'"{prohibited}"' in serialized:
            raise ValueError("Benchmark report contains private content fields")
    if "http://" in serialized or "https://" in serialized:
        raise ValueError("Benchmark report contains a URL")
    return report
