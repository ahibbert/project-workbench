import pathlib
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from source_intelligence import SourceIntelligenceError, SourceIntelligenceStore  # noqa: E402


def variant(source_id="source-001", version="1.6.0", formats=None, **values):
    return {
        "sourceId": source_id,
        "packageName": values.pop("packageName", "eu.example.source"),
        "displayName": values.pop("displayName", "Example (EN)"),
        "language": values.pop("language", "en"),
        "extensionVersion": version,
        "storeIdentity": values.pop("storeIdentity", "keiyoushi:test-key"),
        "formats": formats or ["manga"],
        **values,
    }


def observation(source_id="source-001", outcome="success", **values):
    return {
        "sourceId": source_id,
        "operation": values.pop("operation", "image_fetch"),
        "outcome": outcome,
        "latencyMs": values.pop("latencyMs", 500),
        "mediaFormat": values.pop("mediaFormat", "manga"),
        "origin": values.pop("origin", "benchmark"),
        "occurredAt": values.pop("occurredAt", "2026-10-02T00:00:00Z"),
        **values,
    }


class SourceIntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temporary_directory.name) / "source-intelligence.sqlite3"
        self.store = SourceIntelligenceStore(self.path)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_schema_is_versioned_wal_and_inventory_preserves_package_identity(self):
        inventory = self.store.sync_inventory([
            variant(formats=["manga", "comic"]),
            variant("source-002", packageName="eu.example.webtoon", displayName="Webtoon (EN)", formats=["webtoon"]),
        ])
        self.assertEqual(len(inventory), 2)
        self.assertEqual(inventory[0]["formats"], ["comic", "manga"])
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_scores_keep_reliability_quality_and_coverage_separate(self):
        self.store.sync_inventory([variant()])
        rows = [
            observation(
                byteCount=450_000, width=1800, height=2600, codec="jpeg", clarity=0.85,
                runId=f"run-{index:04d}", occurredAt=f"2026-10-02T00:{index:02d}:00Z",
            )
            for index in range(10)
        ]
        score = self.store.record_observations(rows)[0]
        self.assertGreater(score["reliability"], 80)
        self.assertGreater(score["quality"], 75)
        self.assertIsNone(score["coverage"])
        self.assertEqual(score["confidence"], "established")

    def test_bayesian_prior_prevents_one_success_beating_established_source(self):
        self.store.sync_inventory([variant(), variant("source-002", packageName="eu.example.second")])
        self.store.record_observations([observation()])
        established = []
        for index in range(20):
            established.append(observation(
                "source-002", outcome="failure" if index == 0 else "success",
                operation="image_fetch", runId=f"run-{index % 3:04d}",
                occurredAt=f"2026-10-02T01:{index:02d}:00Z",
            ))
        scores = self.store.record_observations(established)
        by_id = {item["sourceId"]: item for item in scores}
        self.assertGreater(by_id["source-002"]["reliability"], by_id["source-001"]["reliability"])

    def test_extension_update_marks_old_evidence_stale(self):
        self.store.sync_inventory([variant(version="1.6.0")])
        self.store.record_observations([observation()])
        self.store.sync_inventory([variant(version="1.6.1")])
        scores = self.store.scores()
        self.assertTrue(scores[0]["stale"])
        self.assertEqual(scores[0]["extensionVersion"], "1.6.0")

    def test_observations_are_bounded_and_cannot_store_titles_or_urls(self):
        self.store.sync_inventory([variant()])
        with self.assertRaisesRegex(SourceIntelligenceError, "classification"):
            self.store.record_observations([observation(operation="arbitrary")])
        with self.assertRaisesRegex(SourceIntelligenceError, "sourceId"):
            self.store.record_observations([observation(source_id="https://private.example/title")])
        with self.assertRaisesRegex(SourceIntelligenceError, "unsupported fields: title"):
            self.store.record_observations([observation(title="Private reading title")])
        with self.assertRaisesRegex(SourceIntelligenceError, "storeIdentity"):
            self.store.sync_inventory([variant(storeIdentity="https://extensions.example/index.min.json")])
        with closing(sqlite3.connect(self.path)) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(source_observations)")}
        self.assertNotIn("title", columns)
        self.assertNotIn("url", columns)

    def test_benchmark_run_is_transactional_idempotent_and_updates_coverage(self):
        self.store.sync_inventory([variant(formats=["manga", "comic"])])
        run = {
            "runId": "run-20261002-001",
            "suiteVersion": "suite-1.0",
            "status": "completed",
            "startedAt": "2026-10-02T00:00:00Z",
            "finishedAt": "2026-10-02T00:02:00Z",
            "requestedBy": "manual",
            "appVersion": "3aafecf",
            "errorClass": "",
        }
        results = [{
            "caseId": "manga-mainstream-01",
            "sourceId": "source-001",
            "mediaFormat": "manga",
            "matchScore": 0.9,
            "usable": True,
            "chapterCount": 120,
            "pageCount": 20,
            "fetchSuccesses": 5,
            "fetchFailures": 0,
            "durationMs": 12_000,
            "errorClass": "",
        }]
        response = self.store.record_benchmark(run, results)
        self.assertTrue(response["accepted"])
        self.assertEqual(response["resultCount"], 1)
        score = self.store.scores("manga")[0]
        self.assertGreater(score["coverage"], 80)
        self.assertEqual(score["evidenceCount"], 1)
        detail = self.store.benchmark_runs(run_id=run["runId"])[0]
        self.assertEqual(detail["results"][0]["caseId"], "manga-mainstream-01")
        duplicate = self.store.record_benchmark(run, results)
        self.assertFalse(duplicate["accepted"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len(self.store.benchmark_runs(run_id=run["runId"])), 1)

    def test_failed_benchmark_may_record_an_empty_run_without_private_error_text(self):
        self.store.sync_inventory([variant()])
        response = self.store.record_benchmark({
            "runId": "run-20261002-failed",
            "suiteVersion": "suite-1.0",
            "status": "failed",
            "startedAt": "2026-10-02T00:00:00Z",
            "finishedAt": "2026-10-02T00:00:01Z",
            "requestedBy": "scheduled",
            "appVersion": "3aafecf",
            "errorClass": "network",
        }, [])
        self.assertTrue(response["accepted"])
        self.assertEqual(response["resultCount"], 0)
        with self.assertRaisesRegex(SourceIntelligenceError, "unsupported fields: errorMessage"):
            self.store.record_benchmark({
                "runId": "run-unsafe",
                "suiteVersion": "suite-1.0",
                "status": "failed",
                "startedAt": "2026-10-02T00:00:00Z",
                "finishedAt": "2026-10-02T00:00:01Z",
                "requestedBy": "manual",
                "appVersion": "3aafecf",
                "errorClass": "network",
                "errorMessage": "request for a private title failed",
            }, [])


if __name__ == "__main__":
    unittest.main()
