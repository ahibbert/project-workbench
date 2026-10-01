import argparse
import base64
import io
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


DEFAULT_APP = "http://127.0.0.1:8013"
DEFAULT_BASE = "http://localhost:4567"


def request_json(url, body=None, auth=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode("utf-8")).decode("ascii")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def request_bytes(url, auth=None):
    headers = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode("utf-8")).decode("ascii")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()


def graphql(app, base, query, variables, auth):
    url = f"{app}/api/suwayomi/graphql?base={urllib.parse.quote(base, safe='')}"
    payload = request_json(url, {"query": query, "variables": variables}, auth)
    if payload.get("errors"):
        raise RuntimeError(payload["errors"])
    return payload["data"]


def asset_url(app, base, raw_url):
    if raw_url.startswith("http"):
        parsed = urllib.parse.urlparse(raw_url)
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
    else:
        path = raw_url if raw_url.startswith("/") else "/" + raw_url
    return (
        f"{app}/api/suwayomi/asset?"
        f"base={urllib.parse.quote(base, safe='')}&path={urllib.parse.quote(path, safe='')}"
    )


def fetch_chapters(app, base, manga_id, auth):
    query = """
    mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
      fetchChapters(input: $input) {
        chapters { id name chapterNumber sourceOrder pageCount }
      }
    }
    """
    data = graphql(app, base, query, {"input": {"mangaId": manga_id}}, auth)
    chapters = data["fetchChapters"]["chapters"]
    return sorted(chapters, key=lambda item: float(item.get("chapterNumber") or item.get("sourceOrder") or 0))


def fetch_pages(app, base, chapter_id, auth):
    query = """
    mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
      fetchChapterPages(input: $input) { pages }
    }
    """
    data = graphql(app, base, query, {"input": {"chapterId": chapter_id}}, auth)
    return data["fetchChapterPages"]["pages"]


def load_images(app, base, page_urls, auth, limit=None):
    images = []
    for index, page_url in enumerate(page_urls[: limit or len(page_urls)]):
        data = request_bytes(asset_url(app, base, page_url), auth)
        image = Image.open(io.BytesIO(data)).convert("RGBA")
        images.append({"url": page_url, "image": image, "index": index})
    return images


def analyze_image_rows(image, width, height):
    resized = image.resize((width, height), Image.Resampling.BILINEAR).convert("RGBA")
    arr = np.asarray(resized).astype(np.float32)
    alpha = arr[:, :, 3]
    lum = arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114
    mean = lum.mean(axis=1)
    variance = lum.var(axis=1)
    ink_ratio = ((alpha > 16) & (lum < 244)).mean(axis=1)
    edge_ratio = (np.abs(np.diff(lum, axis=1)) > 18).mean(axis=1)

    very_plain = (variance < 70) & (edge_ratio < 0.028)
    plain_white = (mean > 247) & (variance < 120)
    plain_black = (mean < 14) & (variance < 70)
    quiet = plain_white | plain_black | very_plain

    active = (~quiet) & ((variance > 55) | (edge_ratio > 0.018) | (ink_ratio > 0.018))
    return quiet.astype(np.uint8), active.astype(np.uint8)


def analyze_rows(images):
    ratios = [item["image"].height / max(1, item["image"].width) for item in images]
    total_ratio = sum(ratios)
    analysis_width = max(140, min(360, int(9000 / max(1, total_ratio))))
    quiet_parts = []
    active_parts = []
    for item, ratio in zip(images, ratios):
        height = max(1, round(ratio * analysis_width))
        quiet, active = analyze_image_rows(item["image"], analysis_width, height)
        quiet_parts.append(quiet)
        active_parts.append(active)
    return np.concatenate(quiet_parts), np.concatenate(active_parts)


def find_cuts(quiet):
    height = len(quiet)
    min_gap = max(10, round(height * 0.004))
    cuts = [0]
    run_start = -1
    for y, value in enumerate(quiet):
        if value and run_start == -1:
            run_start = y
        if ((not value) or y == height - 1) and run_start != -1:
            run_end = y if value and y == height - 1 else y - 1
            length = run_end - run_start + 1
            center = round((run_start + run_end) / 2)
            if length >= min_gap and center > height * 0.01 and center < height * 0.99:
                cuts.append(center)
            run_start = -1
    cuts.append(height)
    return sorted(set(cuts))


def active_bounds(active, start, end):
    rows = np.flatnonzero(active[start:end])
    if len(rows) == 0:
        return None
    return int(start + rows[0]), int(start + rows[-1] + 1)


def split_tall(panels, image_width, image_height, quiet=None, viewport_ratio=844 / 390):
    viewport_height_px = max(image_width * viewport_ratio, image_width * 0.65)
    max_panel_height_px = max(image_width * 0.55, viewport_height_px * 0.78)
    overlap_px = max(image_width * 0.08, viewport_height_px * 0.16)
    output = []
    for panel in panels:
        start_px = panel["y"] * image_height
        end_px = (panel["y"] + panel["h"]) * image_height
        if end_px - start_px <= max_panel_height_px * 1.08:
            output.append(panel)
            continue
        y_px = start_px
        while y_px < end_px - 1:
            target_end_px = min(y_px + max_panel_height_px, end_px)
            split_end_px = (
                end_px
                if target_end_px >= end_px
                else nearest_quiet_split_px(
                    target_end_px, y_px, end_px, image_width, image_height, overlap_px, quiet
                )
            )
            h_px = split_end_px - y_px
            if h_px < image_width * 0.22 and output:
                output[-1]["h"] = min(1 - output[-1]["y"], output[-1]["h"] + h_px / image_height)
                break
            output.append({**panel, "y": y_px / image_height, "h": h_px / image_height})
            if split_end_px >= end_px:
                break
            y_px = max(y_px + image_width * 0.2, split_end_px - overlap_px)
    return sorted(output, key=lambda item: item["y"])


def nearest_quiet_split_px(target_px, start_px, end_px, image_width, image_height, search_px, quiet):
    if quiet is None or len(quiet) == 0:
        return target_px

    def to_row(px):
        return max(0, min(len(quiet) - 1, round((px / image_height) * len(quiet))))

    def to_px(row):
        return (row / len(quiet)) * image_height

    target_row = to_row(target_px)
    search_rows = max(2, to_row(search_px))
    min_before_px = image_width * 0.35
    min_after_px = image_width * 0.22

    for offset in range(search_rows + 1):
        candidates = [target_row] if offset == 0 else [target_row - offset, target_row + offset]
        for row in candidates:
            if row < 0 or row >= len(quiet) or not quiet[row]:
                continue
            px = to_px(row)
            if px - start_px < min_before_px or end_px - px < min_after_px:
                continue
            return px
    return target_px


def detect_webtoon(images):
    strip_width = max(item["image"].width for item in images)
    strip_height = sum(item["image"].height * (strip_width / item["image"].width) for item in images)
    quiet, active = analyze_rows(images)
    height = len(quiet)
    cuts = find_cuts(quiet)
    panels = []
    min_panel_height = max(0.025, 18 / height)
    pad = max(4, round(height * 0.003))
    for start, end in zip(cuts, cuts[1:]):
        bounds = active_bounds(active, start, end)
        if not bounds:
            continue
        y0 = max(0, (bounds[0] - pad) / height)
        y1 = min(1, (bounds[1] + pad) / height)
        if y1 - y0 < min_panel_height:
            continue
        panels.append({"x": 0, "y": y0, "w": 1, "h": y1 - y0})
    normalized = split_tall(panels, strip_width, strip_height, quiet)
    if not normalized:
        normalized = split_tall([{"x": 0, "y": 0, "w": 1, "h": 1}], strip_width, strip_height, quiet)
    if len(normalized) == 1 and normalized[0]["h"] * strip_height > strip_width * (844 / 390) * 1.08:
        normalized = split_tall([{"x": 0, "y": 0, "w": 1, "h": 1}], strip_width, strip_height, quiet)
    fallback = len(panels) == 0 or (len(panels) == 1 and panels[0]["h"] > 0.9)
    return {
        "strip_width": strip_width,
        "strip_height": strip_height,
        "analysis_height": height,
        "cuts": len(cuts),
        "raw_panels": len(panels),
        "panels": normalized,
        "fallback": fallback,
        "quiet_ratio": float(quiet.mean()),
        "active_ratio": float(active.mean()),
    }


def draw_debug(images, result, output):
    width = 320
    total_height = int(sum(item["image"].height * (width / item["image"].width) for item in images))
    canvas = Image.new("RGB", (width, max(1, total_height)), "white")
    y = 0
    for item in images:
        h = int(item["image"].height * (width / item["image"].width))
        canvas.paste(item["image"].convert("RGB").resize((width, h), Image.Resampling.BILINEAR), (0, y))
        y += h
    draw = ImageDraw.Draw(canvas)
    for index, panel in enumerate(result["panels"], start=1):
        y0 = int(panel["y"] * total_height)
        y1 = int((panel["y"] + panel["h"]) * total_height)
        draw.rectangle((0, y0, width - 1, y1), outline="red", width=3)
        draw.text((5, y0 + 4), str(index), fill="yellow")
    canvas.save(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default=DEFAULT_APP)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--manga-id", type=int, default=251)
    parser.add_argument("--chapter-id", type=int, default=0)
    parser.add_argument("--chapters", type=int, default=5)
    parser.add_argument("--pages", type=int, default=0)
    parser.add_argument("--out", default="panel-pilot/test-output/webtoon")
    args = parser.parse_args()

    auth = os.environ.get("PANEL_PILOT_AUTH")
    if not auth:
        raise SystemExit("Set PANEL_PILOT_AUTH=username:password")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.chapter_id:
        chapters = [{"id": args.chapter_id, "chapterNumber": str(args.chapter_id), "name": f"Chapter {args.chapter_id}"}]
    else:
        chapters = fetch_chapters(args.app, args.base, args.manga_id, auth)[: args.chapters]
    report = []
    for chapter in chapters:
        pages = fetch_pages(args.app, args.base, chapter["id"], auth)
        images = load_images(args.app, args.base, pages, auth, args.pages or None)
        result = detect_webtoon(images)
        row = {
            "chapter_id": chapter["id"],
            "chapter": chapter.get("chapterNumber"),
            "name": chapter.get("name"),
            "source_pages": len(pages),
            "tested_pages": len(images),
            "panels": len(result["panels"]),
            "raw_panels": result["raw_panels"],
            "fallback": result["fallback"],
            "quiet_ratio": round(result["quiet_ratio"], 4),
            "active_ratio": round(result["active_ratio"], 4),
            "max_panel_h": round(max((p["h"] for p in result["panels"]), default=0), 4),
        }
        report.append(row)
        draw_debug(images, result, out_dir / f"chapter-{chapter['chapterNumber']}.jpg")
        print(json.dumps(row))

    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
