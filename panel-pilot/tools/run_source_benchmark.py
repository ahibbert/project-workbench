#!/usr/bin/env python3
"""Run the fixed, privacy-safe source benchmark through an authenticated Panels instance."""

import argparse
import http.cookiejar
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from source_benchmark import (  # noqa: E402
    BenchmarkError,
    SourceBenchmarkRunner,
    assert_sanitized_report,
    benchmark_summary,
    classify_exception,
    load_benchmark_checkpoint,
    load_suite_manifest,
    save_benchmark_checkpoint,
)


SEARCH_QUERY = """
mutation GET_SOURCE_MANGAS_FETCH($input: FetchSourceMangaInput!) {
  fetchSourceManga(input: $input) {
    mangas { id title sourceId }
  }
}
"""
CHAPTERS_QUERY = """
mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
  fetchChapters(input: $input) {
    chapters { id chapterNumber sourceOrder pageCount }
  }
}
"""
PAGES_QUERY = """
mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
  fetchChapterPages(input: $input) { pages }
}
"""


class PanelsBenchmarkGateway:
    def __init__(self, app, base, opener, timeout=30):
        self.app = str(app).rstrip("/")
        self.base = str(base).rstrip("/")
        self.opener = opener
        self.timeout = max(1, min(120, int(timeout)))

    def request_json(self, path, method="GET", payload=None):
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.app}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def graphql(self, query, variables):
        base = urllib.parse.quote(self.base, safe="")
        payload = self.request_json(
            f"/api/suwayomi/graphql?base={base}",
            method="POST",
            payload={"query": query, "variables": variables},
        )
        if payload.get("errors"):
            error_class = classify_exception(BenchmarkError("upstream"))
            encoded = json.dumps(payload.get("errors"), separators=(",", ":")).lower()
            if "rate limit" in encoded or "too many requests" in encoded:
                error_class = "rate_limited"
            elif "forbidden" in encoded or "cloudflare" in encoded:
                error_class = "blocked"
            elif "timeout" in encoded:
                error_class = "timeout"
            raise BenchmarkError(error_class)
        data = payload.get("data")
        if not isinstance(data, dict):
            raise BenchmarkError("empty")
        return data

    def inventory(self):
        payload = self.request_json("/api/source-intelligence/inventory")
        inventory = payload.get("inventory")
        if not isinstance(inventory, list):
            raise BenchmarkError("empty")
        return inventory

    def search(self, source_id, query):
        data = self.graphql(SEARCH_QUERY, {
            "input": {"source": source_id, "query": query, "page": 1, "type": "SEARCH"},
        })
        return (data.get("fetchSourceManga") or {}).get("mangas") or []

    def chapters(self, manga_id):
        data = self.graphql(CHAPTERS_QUERY, {"input": {"mangaId": manga_id}})
        return (data.get("fetchChapters") or {}).get("chapters") or []

    def pages(self, chapter_id):
        data = self.graphql(PAGES_QUERY, {"input": {"chapterId": chapter_id}})
        return (data.get("fetchChapterPages") or {}).get("pages") or []

    def image(self, page_reference):
        raw = str(page_reference or "")
        if raw.startswith("/api/image"):
            path = raw
        else:
            parsed = urllib.parse.urlparse(raw)
            if parsed.username or parsed.password:
                raise BenchmarkError("blocked")
            asset_path = parsed.path if parsed.scheme or parsed.netloc else raw.split("?", 1)[0]
            asset_query = parsed.query if parsed.scheme or parsed.netloc else (raw.split("?", 1)[1] if "?" in raw else "")
            if not asset_path.startswith("/"):
                asset_path = "/" + asset_path
            upstream_path = asset_path + (("?" + asset_query) if asset_query else "")
            path = (
                "/api/suwayomi/asset?"
                + urllib.parse.urlencode({"base": self.base, "path": upstream_path})
            )
        request = urllib.request.Request(
            f"{self.app}{path}",
            headers={"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"},
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            body = response.read(20_000_001)
            if not body:
                raise BenchmarkError("empty")
            if len(body) > 20_000_000:
                raise BenchmarkError("invalid_image")
            return body, response.headers.get("Content-Type", "")

    def post_report(self, report):
        assert_sanitized_report(report)
        if report["benchmark"]["run"]["status"] != "completed":
            raise BenchmarkError("blocked")
        run_id = report["benchmark"]["run"]["runId"]
        existing = self.request_json(
            "/api/source-intelligence/benchmarks?"
            + urllib.parse.urlencode({"runId": run_id})
        )
        if existing.get("benchmarkRuns"):
            raise BenchmarkError("blocked")
        observation_response = self.request_json(
            "/api/source-intelligence/observations",
            method="POST",
            payload=report["observations"],
        )
        benchmark_response = self.request_json(
            "/api/source-intelligence/benchmarks",
            method="POST",
            payload=report["benchmark"],
        )
        return {
            "runId": run_id,
            "observationsAccepted": observation_response.get("accepted", 0),
            "benchmarkAccepted": bool(benchmark_response.get("accepted")),
            "resultCount": benchmark_response.get("resultCount", 0),
        }


def authenticated_opener(app, username, password, timeout):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    if username or password:
        if not username or not password:
            raise ValueError("Both Panels username and password must be configured")
        login = urllib.parse.urlencode({
            "username": username,
            "password": password,
            "next": "/",
        }).encode("utf-8")
        request = urllib.request.Request(
            f"{str(app).rstrip('/')}/login",
            data=login,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        opener.open(request, timeout=timeout).read()
    return opener


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Benchmark explicitly selected installed sources without saving titles, URLs, or images.",
    )
    parser.add_argument("--app", default="http://127.0.0.1:8013")
    parser.add_argument("--base", default="http://localhost:4567")
    parser.add_argument("--manifest", type=pathlib.Path, default=ROOT / "tools" / "source_suite_manifest.json")
    parser.add_argument("--username", default=os.environ.get("PANEL_PILOT_AUTH_USER", ""))
    parser.add_argument(
        "--password-env",
        default="PANEL_PILOT_AUTH_PASSWORD",
        help="Environment variable containing the Panels password (default: PANEL_PILOT_AUTH_PASSWORD)",
    )
    parser.add_argument("--format", action="append", choices=("manga", "comic", "webtoon"))
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--source-id", action="append", default=[])
    selection.add_argument("--all-sources", action="store_true")
    parser.add_argument("--max-sources", type=int, default=12)
    parser.add_argument("--images-per-case", type=int, choices=(1, 2, 3), default=1)
    parser.add_argument("--delay-ms", type=int, default=500)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--app-version", default=os.environ.get("PANEL_PILOT_BUILD_ID", "benchmark-cli-1"))
    parser.add_argument("--run-id")
    parser.add_argument("--checkpoint", type=pathlib.Path)
    parser.add_argument("--resume", action="store_true", help="Resume the exact run stored in --checkpoint.")
    parser.add_argument("--summary-only", action="store_true", help="Print aggregate coverage, quality, and reliability only.")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Perform read-only source searches/page fetches; otherwise only print the selected plan.",
    )
    parser.add_argument(
        "--post",
        action="store_true",
        help="After execution, post sanitized observations and benchmark results to Panels.",
    )
    return parser.parse_args(argv)


def select_sources(inventory, formats, source_ids, all_sources, maximum):
    requested_formats = set(formats or ("manga", "comic", "webtoon"))
    requested_ids = set(map(str, source_ids or []))
    selected = []
    for source in inventory:
        source_id = str(source.get("sourceId") or "")
        source_formats = set(source.get("formats") or []) & requested_formats
        if not source.get("installed") or source.get("obsolete") or not source_formats:
            continue
        if requested_ids and source_id not in requested_ids:
            continue
        selected.append({"sourceId": source_id, "formats": sorted(source_formats)})
    selected.sort(key=lambda item: item["sourceId"])
    if requested_ids:
        missing = sorted(requested_ids - {item["sourceId"] for item in selected})
        if missing:
            raise ValueError("Requested source IDs are not eligible in the current inventory")
    if all_sources:
        if maximum < 1:
            raise ValueError("--max-sources must be at least 1")
        selected = selected[:maximum]
    elif not requested_ids:
        selected = []
    return selected


def default_run_id():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"source-bench-{stamp}-{uuid.uuid4().hex[:8]}"


def main(argv=None):
    args = parse_args(argv)
    if args.post and not args.execute:
        raise SystemExit("--post requires --execute")
    if args.resume and not args.checkpoint:
        raise SystemExit("--resume requires --checkpoint")
    if args.summary_only and not args.execute:
        raise SystemExit("--summary-only requires --execute")
    if args.delay_ms < 0 or args.timeout < 1:
        raise SystemExit("Delay and timeout must be positive")
    password = os.environ.get(args.password_env, "")
    try:
        opener = authenticated_opener(args.app, args.username, password, args.timeout)
        gateway = PanelsBenchmarkGateway(args.app, args.base, opener, args.timeout)
        manifest = load_suite_manifest(args.manifest)
        sources = select_sources(
            gateway.inventory(), args.format, args.source_id, args.all_sources, args.max_sources
        )
        if not sources:
            raise ValueError("Select at least one eligible source with --source-id or --all-sources")
        selected_formats = set(args.format or ("manga", "comic", "webtoon"))
        selected_cases = tuple(case for case in manifest["cases"] if case.media_format in selected_formats)
        plan = {
            "suiteVersion": manifest["suiteVersion"],
            "sourceIds": [source["sourceId"] for source in sources],
            "caseIds": [case.case_id for case in selected_cases],
            "combinationCount": sum(
                1 for source in sources for case in selected_cases if case.media_format in source["formats"]
            ),
        }
        if plan["combinationCount"] > 500:
            raise ValueError("Selection exceeds the 500-result API limit")
        if plan["combinationCount"] * (3 + args.images_per_case) > 500:
            raise ValueError("Selection exceeds the 500-observation API limit")
        if not args.execute:
            print(json.dumps({"mode": "plan", **plan}, indent=2))
            return 0
        resume_report = None
        if args.resume:
            resume_report = load_benchmark_checkpoint(args.checkpoint)
        elif args.checkpoint and args.checkpoint.exists():
            raise ValueError("Checkpoint already exists; pass --resume or choose a new path")
        previous_run = (resume_report or {}).get("benchmark", {}).get("run", {})
        run_id = previous_run.get("runId") or args.run_id or default_run_id()
        if args.run_id and previous_run and args.run_id != previous_run.get("runId"):
            raise ValueError("--run-id does not match the checkpoint")
        app_version = previous_run.get("appVersion") or args.app_version
        runner = SourceBenchmarkRunner(
            gateway,
            cases=selected_cases,
            images_per_case=args.images_per_case,
            delay_seconds=args.delay_ms / 1000,
        )
        checkpoint = (
            (lambda partial: save_benchmark_checkpoint(args.checkpoint, partial))
            if args.checkpoint else None
        )
        report = runner.run(
            sources,
            run_id,
            suite_version=manifest["suiteVersion"],
            app_version=app_version,
            resume_report=resume_report,
            checkpoint=checkpoint,
        )
        summary = benchmark_summary(report)
        if args.post:
            posted = gateway.post_report(report)
            print(json.dumps({"mode": "posted", **plan, **posted, "summary": summary}, indent=2))
        elif args.summary_only:
            print(json.dumps(summary, indent=2))
        else:
            print(json.dumps(report, indent=2))
        return 0
    except (BenchmarkError, ValueError, OSError) as error:
        error_class = classify_exception(error)
        print(f"Source benchmark stopped ({error_class}). No raw upstream details were written.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
