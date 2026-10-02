"""Private, version-aware source reliability and image-quality intelligence."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import math
from pathlib import Path
import re
import sqlite3
import threading


SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
PACKAGE_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,240}$")
FORMATS = {"manga", "comic", "webtoon"}
OPERATIONS = {"search", "chapters", "page_list", "image_fetch", "download"}
OUTCOMES = {"success", "failure", "coverage_miss"}
ORIGINS = {"passive", "benchmark"}
FORMAT_PROVENANCE = {"automatic", "manual", "benchmark"}


class SourceIntelligenceError(ValueError):
    pass


def _bounded_text(value, field, maximum, pattern=None, allow_empty=False):
    text = str(value or "").replace("\x00", "").strip()
    if (not text and not allow_empty) or len(text) > maximum or (text and pattern and not pattern.fullmatch(text)):
        raise SourceIntelligenceError(f"{field} is invalid")
    return text


def _bounded_integer(value, field, minimum=0, maximum=120_000_000):
    if isinstance(value, bool):
        raise SourceIntelligenceError(f"{field} is invalid")
    try:
        number = int(value or 0)
    except (TypeError, ValueError) as error:
        raise SourceIntelligenceError(f"{field} is invalid") from error
    if not minimum <= number <= maximum:
        raise SourceIntelligenceError(f"{field} is invalid")
    return number


def _bounded_score(value, field):
    if value is None:
        return None
    if isinstance(value, bool):
        raise SourceIntelligenceError(f"{field} is invalid")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise SourceIntelligenceError(f"{field} is invalid") from error
    if not math.isfinite(number) or not 0 <= number <= 1:
        raise SourceIntelligenceError(f"{field} is invalid")
    return number


def _timestamp(value, field="occurredAt"):
    text = _bounded_text(value, field, 40)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise SourceIntelligenceError(f"{field} is invalid") from error
    if parsed.tzinfo is None:
        raise SourceIntelligenceError(f"{field} is invalid")
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class SourceIntelligenceStore:
    SCHEMA_VERSION = 1
    QUALITY_WIDTH_TARGETS = {"manga": 1400, "comic": 1600, "webtoon": 1080}

    def __init__(self, path):
        self.path = str(Path(path).expanduser().resolve())
        self.lock = threading.RLock()
        self._initialize()

    @contextmanager
    def _database(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
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

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def _initialize(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.lock, self._database() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS source_variants(
                    source_id TEXT PRIMARY KEY,
                    package_name TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    language TEXT NOT NULL,
                    store_identity TEXT NOT NULL DEFAULT '',
                    extension_version TEXT NOT NULL,
                    installed INTEGER NOT NULL DEFAULT 1,
                    obsolete INTEGER NOT NULL DEFAULT 0,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_format_labels(
                    source_id TEXT NOT NULL REFERENCES source_variants(source_id) ON DELETE CASCADE,
                    media_format TEXT NOT NULL,
                    provenance TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(source_id, media_format)
                );
                CREATE TABLE IF NOT EXISTS source_observations(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id TEXT NOT NULL REFERENCES source_variants(source_id) ON DELETE CASCADE,
                    extension_version TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    error_class TEXT NOT NULL DEFAULT '',
                    latency_ms INTEGER NOT NULL DEFAULT 0,
                    byte_count INTEGER NOT NULL DEFAULT 0,
                    width INTEGER NOT NULL DEFAULT 0,
                    height INTEGER NOT NULL DEFAULT 0,
                    codec TEXT NOT NULL DEFAULT '',
                    clarity REAL,
                    placeholder INTEGER NOT NULL DEFAULT 0,
                    media_format TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    run_id TEXT
                );
                CREATE INDEX IF NOT EXISTS source_observations_score_idx
                    ON source_observations(source_id, extension_version, media_format, occurred_at);
                CREATE TABLE IF NOT EXISTS benchmark_runs(
                    id TEXT PRIMARY KEY,
                    suite_version TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    requested_by TEXT NOT NULL,
                    app_version TEXT NOT NULL,
                    error_class TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS benchmark_results(
                    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
                    case_id TEXT NOT NULL,
                    source_id TEXT NOT NULL REFERENCES source_variants(source_id) ON DELETE CASCADE,
                    media_format TEXT NOT NULL,
                    match_score REAL NOT NULL DEFAULT 0,
                    usable INTEGER NOT NULL DEFAULT 0,
                    chapter_count INTEGER NOT NULL DEFAULT 0,
                    page_count INTEGER NOT NULL DEFAULT 0,
                    fetch_successes INTEGER NOT NULL DEFAULT 0,
                    fetch_failures INTEGER NOT NULL DEFAULT 0,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    error_class TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY(run_id, case_id, source_id)
                );
                CREATE TABLE IF NOT EXISTS source_scores(
                    source_id TEXT NOT NULL REFERENCES source_variants(source_id) ON DELETE CASCADE,
                    media_format TEXT NOT NULL,
                    extension_version TEXT NOT NULL,
                    reliability REAL NOT NULL,
                    quality REAL,
                    coverage REAL,
                    confidence TEXT NOT NULL,
                    evidence_count INTEGER NOT NULL,
                    computed_at TEXT NOT NULL,
                    PRIMARY KEY(source_id, media_format, extension_version)
                );
                """
            )
            connection.execute(f"PRAGMA user_version = {self.SCHEMA_VERSION}")

    @staticmethod
    def _clean_variant(item):
        if not isinstance(item, dict):
            raise SourceIntelligenceError("source variant must be an object")
        formats = item.get("formats") or []
        if not isinstance(formats, list) or any(value not in FORMATS for value in formats):
            raise SourceIntelligenceError("formats is invalid")
        provenance = _bounded_text(item.get("formatProvenance") or "automatic", "formatProvenance", 20)
        if provenance not in FORMAT_PROVENANCE:
            raise SourceIntelligenceError("formatProvenance is invalid")
        return {
            "sourceId": _bounded_text(item.get("sourceId"), "sourceId", 100, SOURCE_ID_PATTERN),
            "packageName": _bounded_text(item.get("packageName"), "packageName", 240, PACKAGE_PATTERN),
            "displayName": _bounded_text(item.get("displayName"), "displayName", 240),
            "language": _bounded_text(item.get("language"), "language", 35),
            "storeIdentity": _bounded_text(item.get("storeIdentity"), "storeIdentity", 300, allow_empty=True),
            "extensionVersion": _bounded_text(item.get("extensionVersion"), "extensionVersion", 80),
            "installed": bool(item.get("installed", True)),
            "obsolete": bool(item.get("obsolete", False)),
            "formats": sorted(set(formats)),
            "formatProvenance": provenance,
            "formatConfidence": _bounded_score(item.get("formatConfidence", 0.5), "formatConfidence"),
        }

    def sync_inventory(self, variants):
        if not isinstance(variants, list) or not 1 <= len(variants) <= 1000:
            raise SourceIntelligenceError("variants must contain 1 to 1000 entries")
        cleaned = [self._clean_variant(item) for item in variants]
        if len({item["sourceId"] for item in cleaned}) != len(cleaned):
            raise SourceIntelligenceError("variants contains duplicate sourceId values")
        now = self._now()
        with self.lock, self._database() as connection:
            connection.execute("UPDATE source_variants SET installed=0")
            for item in cleaned:
                connection.execute(
                    """INSERT INTO source_variants(
                        source_id,package_name,display_name,language,store_identity,extension_version,
                        installed,obsolete,first_seen_at,last_seen_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(source_id) DO UPDATE SET
                        package_name=excluded.package_name, display_name=excluded.display_name,
                        language=excluded.language, store_identity=excluded.store_identity,
                        extension_version=excluded.extension_version, installed=excluded.installed,
                        obsolete=excluded.obsolete, last_seen_at=excluded.last_seen_at""",
                    (
                        item["sourceId"], item["packageName"], item["displayName"], item["language"],
                        item["storeIdentity"], item["extensionVersion"], int(item["installed"]),
                        int(item["obsolete"]), now, now,
                    ),
                )
                connection.execute("DELETE FROM source_format_labels WHERE source_id=?", (item["sourceId"],))
                for media_format in item["formats"]:
                    connection.execute(
                        """INSERT INTO source_format_labels(source_id,media_format,provenance,confidence,updated_at)
                        VALUES (?,?,?,?,?) ON CONFLICT(source_id,media_format) DO UPDATE SET
                        provenance=excluded.provenance,confidence=excluded.confidence,updated_at=excluded.updated_at""",
                        (item["sourceId"], media_format, item["formatProvenance"], item["formatConfidence"], now),
                    )
        return self.inventory()

    @staticmethod
    def _clean_observation(item):
        if not isinstance(item, dict):
            raise SourceIntelligenceError("observation must be an object")
        operation = str(item.get("operation") or "")
        outcome = str(item.get("outcome") or "")
        media_format = str(item.get("mediaFormat") or "")
        origin = str(item.get("origin") or "passive")
        if operation not in OPERATIONS or outcome not in OUTCOMES or media_format not in FORMATS or origin not in ORIGINS:
            raise SourceIntelligenceError("observation classification is invalid")
        return {
            "sourceId": _bounded_text(item.get("sourceId"), "sourceId", 100, SOURCE_ID_PATTERN),
            "operation": operation,
            "outcome": outcome,
            "errorClass": _bounded_text(item.get("errorClass"), "errorClass", 80, allow_empty=True),
            "latencyMs": _bounded_integer(item.get("latencyMs"), "latencyMs", maximum=120_000),
            "byteCount": _bounded_integer(item.get("byteCount"), "byteCount"),
            "width": _bounded_integer(item.get("width"), "width", maximum=100_000),
            "height": _bounded_integer(item.get("height"), "height", maximum=1_000_000),
            "codec": _bounded_text(item.get("codec"), "codec", 30, allow_empty=True).lower(),
            "clarity": _bounded_score(item.get("clarity"), "clarity"),
            "placeholder": bool(item.get("placeholder", False)),
            "mediaFormat": media_format,
            "origin": origin,
            "runId": _bounded_text(item.get("runId"), "runId", 100, SOURCE_ID_PATTERN, allow_empty=True) or None,
            "occurredAt": _timestamp(item.get("occurredAt") or SourceIntelligenceStore._now()),
        }

    def record_observations(self, observations):
        if not isinstance(observations, list) or not 1 <= len(observations) <= 500:
            raise SourceIntelligenceError("observations must contain 1 to 500 entries")
        cleaned = [self._clean_observation(item) for item in observations]
        touched = set()
        with self.lock, self._database() as connection:
            versions = {
                row["source_id"]: row["extension_version"]
                for row in connection.execute("SELECT source_id,extension_version FROM source_variants")
            }
            for item in cleaned:
                version = versions.get(item["sourceId"])
                if version is None:
                    raise SourceIntelligenceError("observation sourceId is not in the current inventory")
                connection.execute(
                    """INSERT INTO source_observations(
                        source_id,extension_version,operation,outcome,error_class,latency_ms,byte_count,
                        width,height,codec,clarity,placeholder,media_format,origin,occurred_at,run_id
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        item["sourceId"], version, item["operation"], item["outcome"], item["errorClass"],
                        item["latencyMs"], item["byteCount"], item["width"], item["height"], item["codec"],
                        item["clarity"], int(item["placeholder"]), item["mediaFormat"], item["origin"],
                        item["occurredAt"], item["runId"],
                    ),
                )
                touched.add((item["sourceId"], item["mediaFormat"], version))
            for source_id, media_format, version in touched:
                self._recompute_score(connection, source_id, media_format, version)
        return self.scores()

    @staticmethod
    def _bayesian_rate(rows):
        successes = sum(1 for row in rows if row["outcome"] == "success")
        attempts = sum(1 for row in rows if row["outcome"] in ("success", "failure"))
        return (successes + 8) / (attempts + 10)

    def _quality_score(self, rows, media_format):
        samples = [row for row in rows if row["operation"] in ("image_fetch", "download") and row["outcome"] == "success" and row["width"] > 0]
        if not samples:
            return None
        resolution = sum(min(1, row["width"] / self.QUALITY_WIDTH_TARGETS[media_format]) for row in samples) / len(samples)
        compression_values = []
        for row in samples:
            pixels = row["width"] * row["height"]
            compression_values.append(min(1, (row["byte_count"] / pixels) / 0.18) if pixels and row["byte_count"] else 0.5)
        compression = sum(compression_values) / len(compression_values)
        clarity_values = [row["clarity"] for row in samples if row["clarity"] is not None]
        clarity = sum(clarity_values) / len(clarity_values) if clarity_values else 0.5
        widths = [row["width"] for row in samples]
        mean_width = sum(widths) / len(widths)
        width_variance = sum((value - mean_width) ** 2 for value in widths) / len(widths)
        consistency = max(0, 1 - (math.sqrt(width_variance) / max(1, mean_width)))
        placeholder_rate = sum(int(row["placeholder"]) for row in samples) / len(samples)
        consistency *= 1 - placeholder_rate
        return round(100 * (0.5 * resolution + 0.2 * compression + 0.2 * clarity + 0.1 * consistency), 1)

    def _coverage_score(self, connection, source_id, media_format):
        rows = connection.execute(
            """SELECT usable,match_score,chapter_count,page_count FROM benchmark_results
            WHERE source_id=? AND media_format=?""",
            (source_id, media_format),
        ).fetchall()
        if not rows:
            return None
        values = [
            (0.55 * float(row["match_score"]) + 0.25 * int(bool(row["chapter_count"])) + 0.2 * int(bool(row["page_count"])))
            * int(bool(row["usable"]))
            for row in rows
        ]
        return round(100 * sum(values) / len(values), 1)

    def _recompute_score(self, connection, source_id, media_format, version):
        rows = connection.execute(
            """SELECT * FROM source_observations WHERE source_id=? AND media_format=? AND extension_version=?
            ORDER BY occurred_at,id""",
            (source_id, media_format, version),
        ).fetchall()
        by_operation = {operation: [row for row in rows if row["operation"] == operation] for operation in OPERATIONS}
        transfer_rows = by_operation["download"] or by_operation["image_fetch"]
        discovery_rows = by_operation["chapters"] + by_operation["search"]
        successful_latencies = [row["latency_ms"] for row in rows if row["outcome"] == "success" and row["latency_ms"]]
        average_latency = sum(successful_latencies) / len(successful_latencies) if successful_latencies else 7500
        latency_score = max(0, 1 - average_latency / 15_000)
        recent = rows[-5:]
        recent_failures = sum(1 for row in recent if row["outcome"] == "failure")
        stability = max(0, 1 - recent_failures / 5)
        reliability = 100 * (
            0.45 * self._bayesian_rate(transfer_rows)
            + 0.25 * self._bayesian_rate(by_operation["page_list"])
            + 0.15 * self._bayesian_rate(discovery_rows)
            + 0.10 * latency_score
            + 0.05 * stability
        )
        quality = self._quality_score(rows, media_format)
        coverage = self._coverage_score(connection, source_id, media_format)
        run_count = len({row["run_id"] for row in rows if row["run_id"]})
        confidence = "established" if len(rows) >= 10 and run_count >= 3 else "developing" if len(rows) >= 3 else "early"
        connection.execute(
            """INSERT INTO source_scores(
                source_id,media_format,extension_version,reliability,quality,coverage,confidence,evidence_count,computed_at
            ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,media_format,extension_version) DO UPDATE SET
                reliability=excluded.reliability,quality=excluded.quality,coverage=excluded.coverage,
                confidence=excluded.confidence,evidence_count=excluded.evidence_count,computed_at=excluded.computed_at""",
            (source_id, media_format, version, round(reliability, 1), quality, coverage, confidence, len(rows), self._now()),
        )

    def inventory(self):
        with self.lock, self._database() as connection:
            rows = connection.execute(
                """SELECT v.*,GROUP_CONCAT(f.media_format) AS formats FROM source_variants v
                LEFT JOIN source_format_labels f ON f.source_id=v.source_id
                GROUP BY v.source_id ORDER BY v.display_name"""
            ).fetchall()
        return [{
            "sourceId": row["source_id"], "packageName": row["package_name"], "displayName": row["display_name"],
            "language": row["language"], "storeIdentity": row["store_identity"],
            "extensionVersion": row["extension_version"], "installed": bool(row["installed"]),
            "obsolete": bool(row["obsolete"]), "formats": sorted(filter(None, str(row["formats"] or "").split(","))),
        } for row in rows]

    def scores(self):
        with self.lock, self._database() as connection:
            rows = connection.execute(
                """SELECT s.*,v.display_name,v.package_name,v.installed,v.obsolete,
                CASE WHEN s.extension_version=v.extension_version THEN 0 ELSE 1 END AS stale
                FROM source_scores s JOIN source_variants v ON v.source_id=s.source_id
                ORDER BY s.media_format,s.reliability DESC,s.evidence_count DESC"""
            ).fetchall()
        return [{
            "sourceId": row["source_id"], "displayName": row["display_name"], "packageName": row["package_name"],
            "mediaFormat": row["media_format"], "extensionVersion": row["extension_version"],
            "reliability": row["reliability"], "quality": row["quality"], "coverage": row["coverage"],
            "confidence": row["confidence"], "evidenceCount": row["evidence_count"],
            "installed": bool(row["installed"]), "obsolete": bool(row["obsolete"]), "stale": bool(row["stale"]),
            "computedAt": row["computed_at"],
        } for row in rows]
