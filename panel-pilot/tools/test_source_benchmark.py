import json
import pathlib
import struct
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from source_benchmark import (  # noqa: E402
    BenchmarkCase,
    SourceBenchmarkRunner,
    assert_sanitized_report,
    image_metadata,
)
from run_source_benchmark import PanelsBenchmarkGateway, select_sources  # noqa: E402


def png(width=1800, height=2600):
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"


class StepClock:
    def __init__(self, step=0.1):
        self.value = 0.0
        self.step = step

    def __call__(self):
        value = self.value
        self.value += self.step
        return value


class FakeGateway:
    def __init__(self, title="Golden Kamuy"):
        self.title = title
        self.calls = []
        self.private_page_reference = "https://private.example/signed/page.png?token=secret"

    def search(self, source_id, query):
        self.calls.append(("search", source_id, query))
        return [{"id": 44, "title": self.title, "sourceId": source_id}]

    def chapters(self, manga_id):
        self.calls.append(("chapters", manga_id))
        return [{"id": 70}, {"id": 71}, {"id": 72}]

    def pages(self, chapter_id):
        self.calls.append(("pages", chapter_id))
        return [self.private_page_reference, "https://private.example/page-2.png"]

    def image(self, page_reference):
        self.calls.append(("image", page_reference))
        return png(), "image/png"


class FakeResponse:
    def __init__(self, payload, content_type="application/json"):
        self.payload = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, maximum=None):
        return self.payload if maximum is None else self.payload[:maximum]


class FakeOpener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        if request.full_url.endswith("/api/source-intelligence/observations"):
            return FakeResponse({"accepted": 4})
        if request.full_url.endswith("/api/source-intelligence/benchmarks"):
            return FakeResponse({"accepted": True, "resultCount": 1})
        if "/api/source-intelligence/benchmarks?" in request.full_url:
            return FakeResponse({"benchmarkRuns": []})
        raise AssertionError(f"Unexpected offline request: {request.full_url}")


class SourceBenchmarkTests(unittest.TestCase):
    def test_successful_run_measures_quality_without_persisting_titles_or_urls(self):
        gateway = FakeGateway()
        benchmark_case = BenchmarkCase(
            "manga-primary-01", "manga", "Golden Kamuy", ("Golden Kamuy", "Golden Kamui")
        )
        runner = SourceBenchmarkRunner(
            gateway,
            cases=(benchmark_case,),
            images_per_case=1,
            delay_seconds=0,
            clock=StepClock(),
            timestamp=lambda: "2026-10-02T00:00:00Z",
            sleeper=lambda _seconds: None,
        )
        report = runner.run(
            [{"sourceId": "source-001", "formats": ["manga"]}],
            "source-bench-test-001",
            app_version="test-1",
        )
        assert_sanitized_report(report)
        serialized = json.dumps(report)
        self.assertNotIn("Golden Kamuy", serialized)
        self.assertNotIn("private.example", serialized)
        self.assertNotIn("token=secret", serialized)

        result = report["benchmark"]["results"][0]
        self.assertEqual(result["matchScore"], 1.0)
        self.assertEqual(result["chapterCount"], 3)
        self.assertEqual(result["pageCount"], 2)
        self.assertEqual(result["fetchSuccesses"], 1)
        self.assertTrue(result["usable"])
        image_observation = next(
            item for item in report["observations"]["observations"]
            if item["operation"] == "image_fetch"
        )
        self.assertEqual(image_observation["width"], 1800)
        self.assertEqual(image_observation["height"], 2600)
        self.assertEqual(image_observation["byteCount"], len(png()))
        self.assertEqual(image_observation["codec"], "png")
        self.assertGreater(image_observation["latencyMs"], 0)

    def test_coverage_miss_stops_before_chapter_or_image_requests(self):
        gateway = FakeGateway(title="Completely Different Work")
        runner = SourceBenchmarkRunner(
            gateway,
            cases=(BenchmarkCase("comic-primary-01", "comic", "Invincible", ("Invincible",)),),
            delay_seconds=0,
            clock=StepClock(),
            timestamp=lambda: "2026-10-02T00:00:00Z",
            sleeper=lambda _seconds: None,
        )
        report = runner.run(
            [{"sourceId": "source-002", "formats": ["comic"]}],
            "source-bench-test-002",
        )
        result = report["benchmark"]["results"][0]
        self.assertFalse(result["usable"])
        self.assertEqual(result["chapterCount"], 0)
        self.assertEqual([call[0] for call in gateway.calls], ["search"])
        self.assertEqual(
            report["observations"]["observations"][0]["outcome"],
            "coverage_miss",
        )

    def test_network_failures_are_reduced_to_a_bounded_error_class(self):
        class FailingGateway(FakeGateway):
            def search(self, source_id, query):
                raise TimeoutError("private.example/secret-title timed out")

        runner = SourceBenchmarkRunner(
            FailingGateway(),
            cases=(BenchmarkCase("webtoon-primary-01", "webtoon", "Solo Leveling", ("Solo Leveling",)),),
            delay_seconds=0,
            clock=StepClock(),
            timestamp=lambda: "2026-10-02T00:00:00Z",
            sleeper=lambda _seconds: None,
        )
        report = runner.run(
            [{"sourceId": "source-003", "formats": ["webtoon"]}],
            "source-bench-test-003",
        )
        serialized = json.dumps(report)
        self.assertNotIn("private.example", serialized)
        self.assertEqual(report["benchmark"]["results"][0]["errorClass"], "timeout")
        self.assertEqual(report["observations"]["observations"][0]["errorClass"], "timeout")

    def test_image_header_probe_is_bounded_and_does_not_decode_content(self):
        self.assertEqual(image_metadata(png(1080, 12000)), (1080, 12000, "png"))
        gif = b"GIF89a" + struct.pack("<HH", 640, 960) + b"\x00" * 20
        self.assertEqual(image_metadata(gif), (640, 960, "gif"))

    def test_inventory_selection_requires_explicit_eligible_sources(self):
        inventory = [
            {"sourceId": "one", "formats": ["manga"], "installed": True, "obsolete": False},
            {"sourceId": "two", "formats": ["comic"], "installed": True, "obsolete": True},
            {"sourceId": "three", "formats": ["webtoon"], "installed": False, "obsolete": False},
        ]
        self.assertEqual(select_sources(inventory, ["manga"], [], False, 12), [])
        self.assertEqual(
            select_sources(inventory, ["manga"], ["one"], False, 12),
            [{"sourceId": "one", "formats": ["manga"]}],
        )
        self.assertEqual(
            select_sources(inventory, ["manga", "comic"], [], True, 12),
            [{"sourceId": "one", "formats": ["manga"]}],
        )
        with self.assertRaisesRegex(ValueError, "not eligible"):
            select_sources(inventory, None, ["two"], False, 12)

    def test_sanitizer_rejects_extra_content_fields(self):
        runner = SourceBenchmarkRunner(
            FakeGateway(),
            cases=(BenchmarkCase("manga-primary-01", "manga", "Golden Kamuy", ("Golden Kamuy",)),),
            delay_seconds=0,
            clock=StepClock(),
            timestamp=lambda: "2026-10-02T00:00:00Z",
            sleeper=lambda _seconds: None,
        )
        report = runner.run([{"sourceId": "source-001", "formats": ["manga"]}], "safe-run")
        report["benchmark"]["results"][0]["title"] = "must not leave memory"
        with self.assertRaisesRegex(ValueError, "unsafe fields"):
            assert_sanitized_report(report)

    def test_http_post_uses_only_the_sanitized_endpoint_payloads_offline(self):
        runner = SourceBenchmarkRunner(
            FakeGateway(),
            cases=(BenchmarkCase("manga-primary-01", "manga", "Golden Kamuy", ("Golden Kamuy",)),),
            delay_seconds=0,
            clock=StepClock(),
            timestamp=lambda: "2026-10-02T00:00:00Z",
            sleeper=lambda _seconds: None,
        )
        report = runner.run([{"sourceId": "source-001", "formats": ["manga"]}], "safe-post-run")
        opener = FakeOpener()
        gateway = PanelsBenchmarkGateway(
            "http://panels.invalid", "http://suwayomi.invalid", opener, timeout=5
        )
        response = gateway.post_report(report)
        self.assertTrue(response["benchmarkAccepted"])
        posted = [
            json.loads(request.data.decode("utf-8"))
            for request, _timeout in opener.requests
            if request.data is not None
        ]
        self.assertEqual(posted, [report["observations"], report["benchmark"]])
        serialized = json.dumps(posted)
        self.assertNotIn("Golden Kamuy", serialized)
        self.assertNotIn("http://", serialized)


if __name__ == "__main__":
    unittest.main()
