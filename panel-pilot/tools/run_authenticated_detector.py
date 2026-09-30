#!/usr/bin/env python3
"""Run manga_detector_report through Panel Pilot's in-page login."""

import argparse
import http.cookiejar
import importlib.util
import json
import os
import sys
import urllib.parse
import urllib.request


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--detector", required=True)
    parser.add_argument("--app", default="http://127.0.0.1:8123")
    parser.add_argument("--base", default="http://localhost:4567")
    parser.add_argument("--username", default=os.environ.get("PANEL_PILOT_AUTH_USER", ""))
    parser.add_argument("--password", default=os.environ.get("PANEL_PILOT_AUTH_PASSWORD", ""))
    parser.add_argument("--manga-id", required=True)
    parser.add_argument("--chapter-ids", required=True)
    parser.add_argument("--direction", choices=("rtl", "ltr"), default="rtl")
    parser.add_argument("--mode", choices=("manga", "comic", "webtoon"), default="manga")
    parser.add_argument("--save-pages", action="store_true")
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def load_detector(path):
    spec = importlib.util.spec_from_file_location("panel_pilot_detector", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    args = parse_args()
    if not args.username or not args.password:
        raise SystemExit("PANEL_PILOT_AUTH_USER and PANEL_PILOT_AUTH_PASSWORD are required")

    detector = load_detector(args.detector)
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    login = urllib.parse.urlencode({"username": args.username, "password": args.password}).encode()
    opener.open(urllib.request.Request(f"{args.app}/login", data=login), timeout=30).read()

    def request_json(url, body=None, auth=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
        with opener.open(request, timeout=90) as response:
            return json.loads(response.read().decode("utf-8"))

    def request_bytes(url, auth=None):
        request = urllib.request.Request(
            url,
            headers={"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"},
        )
        with opener.open(request, timeout=90) as response:
            return response.read()

    detector.request_json = request_json
    detector.request_bytes = request_bytes
    os.environ["PANEL_PILOT_AUTH"] = "session-cookie"
    sys.argv = [
        "manga_detector_report",
        "--app",
        args.app,
        "--base",
        args.base,
        "--manga-id",
        args.manga_id,
        "--chapter-ids",
        args.chapter_ids,
        "--direction",
        args.direction,
        "--mode",
        args.mode,
        "--out",
        args.out,
    ]
    if args.save_pages:
        sys.argv.append("--save-pages")
    detector.main()


if __name__ == "__main__":
    main()
