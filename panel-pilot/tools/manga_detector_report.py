import argparse
import base64
import io
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


DEFAULT_APP = "https://panel-pilot-hetzner.tailb74d46.ts.net"
DEFAULT_BASE = "http://localhost:4567"
MANGADEX_EN_SOURCE = "2499283573021220255"


def request_json(url, body=None, auth=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode("utf-8")).decode("ascii")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def request_bytes(url, auth=None):
    headers = {"Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode("utf-8")).decode("ascii")
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def graphql(app, base, query, variables, auth):
    url = f"{app}/api/suwayomi/graphql?base={urllib.parse.quote(base, safe='')}"
    payload = request_json(url, {"query": query, "variables": variables}, auth)
    if payload.get("errors"):
        raise RuntimeError(payload["errors"])
    return payload["data"]


def asset_url(app, base, raw_url):
    if raw_url.startswith("/api/image"):
        return urllib.parse.urljoin(app + "/", raw_url.lstrip("/"))
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
    return sorted(chapters, key=chapter_sort_key)


def chapter_sort_key(chapter):
    for key in ("chapterNumber", "sourceOrder"):
        try:
            return float(chapter.get(key) or 0)
        except (TypeError, ValueError):
            pass
    return float(chapter.get("id") or 0)


def fetch_pages(app, base, chapter_id, auth):
    query = """
    mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
      fetchChapterPages(input: $input) {
        chapter {
          realUrl
          manga { source { name displayName } }
        }
        pages
      }
    }
    """
    data = graphql(app, base, query, {"input": {"chapterId": chapter_id}}, auth)
    return resolve_pages(app, data["fetchChapterPages"], auth)


def fetch_chapter_infos(app, base, chapter_ids, auth):
    chapters = []
    query = """
    mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
      fetchChapterPages(input: $input) {
        chapter {
          id
          name
          chapterNumber
          sourceOrder
          pageCount
          realUrl
          manga { source { name displayName } }
        }
        pages
      }
    }
    """
    for chapter_id in chapter_ids:
        data = graphql(app, base, query, {"input": {"chapterId": chapter_id}}, auth)
        fetched = data["fetchChapterPages"]
        chapter = fetched["chapter"]
        chapter["_prefetched_pages"] = resolve_pages(app, fetched, auth)
        chapters.append(chapter)
    return chapters


def resolve_pages(app, fetched, auth):
    pages = fetched.get("pages") or []
    if pages:
        return pages
    chapter = fetched.get("chapter") or {}
    source = ((chapter.get("manga") or {}).get("source") or {})
    source_name = f"{source.get('name') or ''} {source.get('displayName') or ''}"
    real_url = chapter.get("realUrl")
    if "readcomiconline" in source_name.lower() and real_url:
        payload = request_json(
            f"{app}/api/readcomiconline/chapter?url={urllib.parse.quote(real_url, safe='')}",
            auth=auth,
        )
        return payload.get("pages") or []
    return []


def load_image(app, base, page_url, auth):
    data = request_bytes(asset_url(app, base, page_url), auth)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def clamp(value, lo, hi):
    return min(hi, max(lo, value))


def resize_for_detection(image, max_side=900):
    scale = min(1.0, max_side / max(image.width, image.height))
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    if width == image.width and height == image.height:
        return image
    return image.resize((width, height), Image.Resampling.BILINEAR)


def make_masks(image):
    arr = np.asarray(resize_for_detection(image)).astype(np.float32)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    lum = rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114
    visible = alpha > 16
    dark = (visible & (lum < 236)).astype(np.uint8)
    black = (visible & (lum < 80)).astype(np.uint8)
    light = (visible & (lum > 190)).astype(np.uint8)
    return lum, dark, black, light


def axis_stats(lum, dark):
    row_sum = lum.sum(axis=1)
    row_sum_sq = (lum * lum).sum(axis=1)
    col_sum = lum.sum(axis=0)
    col_sum_sq = (lum * lum).sum(axis=0)
    row_dark = dark.sum(axis=1)
    col_dark = dark.sum(axis=0)
    row_run = longest_runs(dark, axis=1)
    col_run = longest_runs(dark, axis=0)
    return {
        "row": {"sum": row_sum, "sum_sq": row_sum_sq, "dark": row_dark, "run": row_run},
        "col": {"sum": col_sum, "sum_sq": col_sum_sq, "dark": col_dark, "run": col_run},
    }


def longest_runs(mask, axis):
    if axis == 1:
        out = np.zeros(mask.shape[0], dtype=np.int32)
        for y, row in enumerate(mask):
            out[y] = longest_true_run(row)
        return out
    out = np.zeros(mask.shape[1], dtype=np.int32)
    for x in range(mask.shape[1]):
        out[x] = longest_true_run(mask[:, x])
    return out


def longest_true_run(values):
    longest = 0
    run = 0
    for value in values:
        if value:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return longest


def content_bounds(mask, x0, y0, x1, y1):
    region = mask[y0:y1, x0:x1]
    ys, xs = np.nonzero(region)
    area = max(1, (x1 - x0) * (y1 - y0))
    if len(xs) / area < 0.004:
        return None
    return {
        "x0": int(x0 + xs.min()),
        "y0": int(y0 + ys.min()),
        "x1": int(x0 + xs.max() + 1),
        "y1": int(y0 + ys.max() + 1),
    }


def find_gutter_cuts(stats, cross_size, size):
    threshold = max(2, round(cross_size * 0.012))
    min_run = max(7, round(size * 0.012))
    cuts = [0]
    run_start = -1
    for i in range(size):
        mean = stats["sum"][i] / cross_size
        variance = max(0, stats["sum_sq"][i] / cross_size - mean * mean)
        quiet_light = variance < 80 and mean > 238
        quiet_dark = variance < 80 and mean < 38
        dark_divider = stats["run"][i] >= cross_size * 0.62
        gutter = stats["dark"][i] <= threshold or quiet_light or quiet_dark or dark_divider
        if gutter and run_start == -1:
            run_start = i
        if ((not gutter) or i == size - 1) and run_start != -1:
            run_end = i if gutter and i == size - 1 else i - 1
            length = run_end - run_start + 1
            center = round((run_start + run_end) / 2)
            if length >= min_run and center > size * 0.06 and center < size * 0.94:
                cuts.append(center)
            run_start = -1
    cuts.append(size)
    return sorted(set(cuts))


def local_line_metrics(lum, dark, black, region, axis, primary):
    x0, y0, x1, y1 = region
    if axis == "x":
        values = lum[y0:y1, primary]
        dark_values = dark[y0:y1, primary]
        black_values = black[y0:y1, primary]
    else:
        values = lum[primary, x0:x1]
        dark_values = dark[primary, x0:x1]
        black_values = black[primary, x0:x1]
    cross_size = max(1, len(values))
    return {
        "mean": float(values.mean()),
        "variance": float(values.var()),
        "dark_density": float(dark_values.mean()),
        "black_density": float(black_values.mean()),
        "black_run": longest_true_run(black_values) / cross_size,
    }


def valid_local_cut(dark, region, axis, center):
    height, width = dark.shape
    x0, y0, x1, y1 = region
    first = (x0, y0, center, y1) if axis == "x" else (x0, y0, x1, center)
    second = (center, y0, x1, y1) if axis == "x" else (x0, center, x1, y1)
    first_bounds = content_bounds(dark, *first)
    second_bounds = content_bounds(dark, *second)
    if not first_bounds or not second_bounds:
        return False
    first_area = (first_bounds["x1"] - first_bounds["x0"]) * (first_bounds["y1"] - first_bounds["y0"])
    second_area = (second_bounds["x1"] - second_bounds["x0"]) * (second_bounds["y1"] - second_bounds["y0"])
    return first_area >= width * height * 0.005 and second_area >= width * height * 0.005


def find_local_gutter_cuts(lum, dark, black, region, axis):
    x0, y0, x1, y1 = region
    size = x1 - x0 if axis == "x" else y1 - y0
    cross_size = y1 - y0 if axis == "x" else x1 - x0
    if size < 80 or cross_size < 80:
        return []
    start = x0 if axis == "x" else y0
    end = x1 if axis == "x" else y1
    candidates = []
    for primary in range(start, end):
        metrics = local_line_metrics(lum, dark, black, region, axis, primary)
        white_gutter = (
            metrics["mean"] > 242 and metrics["variance"] < 520 and metrics["dark_density"] < 0.1
        ) or metrics["dark_density"] < 0.006
        black_divider = metrics["black_run"] > 0.58 and metrics["black_density"] > 0.18
        if not white_gutter and not black_divider:
            continue
        score = (
            (1.1 if white_gutter else 0)
            + (1.7 * metrics["black_run"] if black_divider else 0)
            + min(0.8, metrics["black_density"] * 1.5)
            + (min(0.4, max(0, (metrics["mean"] - 242) / 20)) if white_gutter else 0)
        )
        candidates.append({"pos": primary, "score": score})

    min_run = max(3, round(size * 0.004))
    edge = max(8, round(size * 0.03))
    groups = []
    i = 0
    while i < len(candidates):
        start_i = i
        end_i = i
        while end_i + 1 < len(candidates) and candidates[end_i + 1]["pos"] <= candidates[end_i]["pos"] + 1:
            end_i += 1
        p0 = candidates[start_i]["pos"]
        p1 = candidates[end_i]["pos"]
        length = p1 - p0 + 1
        center = round((p0 + p1) / 2)
        local_center = center - (x0 if axis == "x" else y0)
        base_score = sum(item["score"] for item in candidates[start_i : end_i + 1]) / length
        score = base_score + min(1, length / 18) * 0.3
        if length >= min_run and edge < local_center < size - edge:
            groups.append({"center": center, "score": score, "length": length})
        i = end_i + 1

    kept = []
    for group in sorted(groups, key=lambda item: item["score"], reverse=True):
        if not valid_local_cut(dark, region, axis, group["center"]):
            continue
        if any(abs(item["center"] - group["center"]) <= max(7, size * 0.022) for item in kept):
            continue
        kept.append(group)
    return sorted(kept, key=lambda item: item["center"])[:7]


def split_panel_region(lum, dark, black, region, depth):
    height, width = dark.shape
    bounds = content_bounds(dark, *region)
    if not bounds:
        return []
    padded = (
        max(0, bounds["x0"] - 1),
        max(0, bounds["y0"] - 1),
        min(width, bounds["x1"] + 1),
        min(height, bounds["y1"] + 1),
    )
    region_width = padded[2] - padded[0]
    region_height = padded[3] - padded[1]
    page_area = width * height
    if depth >= 6 or region_width < 70 or region_height < 70 or region_width * region_height < page_area * 0.01:
        return [padded]

    vertical = find_local_gutter_cuts(lum, dark, black, padded, "x")
    horizontal = find_local_gutter_cuts(lum, dark, black, padded, "y")
    if not vertical and not horizontal:
        return [padded]

    vertical_score = average_score(vertical)
    horizontal_score = average_score(horizontal)
    split_axis = "y" if horizontal and (not vertical or horizontal_score > vertical_score * 0.92 or len(horizontal) > len(vertical)) else "x"
    cuts = horizontal if split_axis == "y" else vertical
    start = padded[1] if split_axis == "y" else padded[0]
    end = padded[3] if split_axis == "y" else padded[2]
    coords = [start, *[cut["center"] for cut in cuts], end]
    leaves = []
    for a, b in zip(coords, coords[1:]):
        if b - a < 35:
            continue
        next_region = (padded[0], a, padded[2], b) if split_axis == "y" else (a, padded[1], b, padded[3])
        leaves.extend(split_panel_region(lum, dark, black, next_region, depth + 1))
    return leaves or [padded]


def average_score(cuts):
    return sum(cut["score"] for cut in cuts) / len(cuts) if cuts else 0


def rect_from_bounds(bounds, width, height, page_width, page_height, pad):
    bw = bounds["x1"] - bounds["x0"]
    bh = bounds["y1"] - bounds["y0"]
    return {
        "x": clamp((bounds["x0"] - pad) / width, 0, 1),
        "y": clamp((bounds["y0"] - pad) / height, 0, 1),
        "w": clamp((bw + pad * 2) / width, 0.03, 1),
        "h": clamp((bh + pad * 2) / height, 0.03, 1),
        "pageWidth": page_width,
        "pageHeight": page_height,
    }


def detect_recursive_panels(lum, dark, black, image):
    height, width = dark.shape
    leaves = split_panel_region(lum, dark, black, (0, 0, width, height), 0)
    page_area = width * height
    pad = max(4, round(min(width, height) * 0.006))
    panels = []
    for region in leaves:
        bounds = content_bounds(dark, *region)
        if not bounds:
            continue
        bw = bounds["x1"] - bounds["x0"]
        bh = bounds["y1"] - bounds["y0"]
        area = bw * bh
        if bw < width * 0.08 or bh < height * 0.04 or area < page_area * 0.006:
            continue
        if area > page_area * 0.975:
            panels.append(full_page_panel(image))
        else:
            panels.append(rect_from_bounds(bounds, width, height, image.width, image.height, pad))
    return filter_edge_title_strips(merge_duplicate_panels(panels))


def detect_slanted_manga_panels(lum, dark, black, image):
    height, width = dark.shape
    separators = find_slanted_horizontal_separators(black)
    if not separators:
        return []

    page_area = width * height
    pad = max(6, round(min(width, height) * 0.009))
    overlap = max(8, round(height * 0.012))
    rows = []
    y_start = 0
    for line in separators:
        line_min = min(line["yLeft"], line["yRight"])
        line_max = max(line["yLeft"], line["yRight"])
        rows.append((0, max(0, math.floor(y_start)), width, min(height, math.ceil(line_max + overlap))))
        y_start = max(0, line_min - overlap)
    rows.append((0, max(0, math.floor(y_start)), width, height))

    panels = []
    for row in rows:
        row_bounds = content_bounds(dark, *row)
        if not row_bounds:
            continue
        row_region = (
            max(0, row_bounds["x0"] - 1),
            max(0, row_bounds["y0"] - 1),
            min(width, row_bounds["x1"] + 1),
            min(height, row_bounds["y1"] + 1),
        )
        leaves = split_panel_region(lum, dark, black, row_region, 1)
        for leaf in leaves:
            bounds = content_bounds(dark, *leaf)
            if not bounds:
                continue
            bw = bounds["x1"] - bounds["x0"]
            bh = bounds["y1"] - bounds["y0"]
            area = bw * bh
            if bw < width * 0.1 or bh < height * 0.045 or area < page_area * 0.008:
                continue
            panel = rect_from_bounds(bounds, width, height, image.width, image.height, pad)
            panel["slantedManga"] = True
            panels.append(panel)

    return [p for p in filter_edge_title_strips(merge_duplicate_panels(panels)) if plausible_panel(p)][:14]


def find_slanted_horizontal_separators(black):
    height, width = black.shape
    candidates = []
    y_step = max(5, round(height * 0.008))
    delta_step = max(8, round(height * 0.016))
    min_delta = max(12, round(height * 0.025))
    max_delta = max(min_delta, round(height * 0.18))

    for center in range(round(height * 0.08), round(height * 0.92) + 1, y_step):
        for delta in range(-max_delta, max_delta + 1, delta_step):
            if abs(delta) < min_delta:
                continue
            y_left = center - delta / 2
            y_right = center + delta / 2
            if (
                y_left < height * 0.04
                or y_left > height * 0.96
                or y_right < height * 0.04
                or y_right > height * 0.96
            ):
                continue
            score = slanted_line_score(black, y_left, y_right)
            if score["coverage"] >= 0.58 and score["longestGap"] <= 0.24 and score["hitDensity"] >= 0.06:
                candidates.append(
                    {
                        "yLeft": y_left,
                        "yRight": y_right,
                        "center": center,
                        "score": score["coverage"] + score["hitDensity"] * 1.6 - score["longestGap"],
                    }
                )

    kept = []
    for line in sorted(candidates, key=lambda item: item["score"], reverse=True):
        if any(abs(item["center"] - line["center"]) < height * 0.075 for item in kept):
            continue
        kept.append(line)
    return sorted(kept, key=lambda item: item["center"])[:5]


def slanted_line_score(black, y_left, y_right):
    height, width = black.shape
    samples = 72
    band = max(2, round(height * 0.003))
    hit_bins = 0
    hit_pixels = 0
    longest_miss = 0
    miss_run = 0

    for i in range(samples):
        ratio = i / (samples - 1) if samples > 1 else 0
        x = int(clamp(round(ratio * (width - 1)), 0, width - 1))
        y = y_left + (y_right - y_left) * ratio
        bin_hit = False
        for dy in range(-band, band + 1):
            yy = int(clamp(round(y + dy), 0, height - 1))
            if black[yy, x]:
                hit_pixels += 1
                bin_hit = True
        if bin_hit:
            hit_bins += 1
            miss_run = 0
        else:
            miss_run += 1
            longest_miss = max(longest_miss, miss_run)

    return {
        "coverage": hit_bins / samples,
        "hitDensity": hit_pixels / (samples * (band * 2 + 1)),
        "longestGap": longest_miss / samples,
    }


def detect_connected_light_panels(light, image):
    height, width = light.shape
    visited = np.zeros_like(light, dtype=np.uint8)
    panels = []
    min_width = max(24, width * 0.12)
    min_height = max(24, height * 0.055)
    min_area = width * height * 0.008
    pad = max(6, round(min(width, height) * 0.012))
    for y in range(height):
        for x in range(width):
            if not light[y, x] or visited[y, x]:
                continue
            stack = [(x, y)]
            visited[y, x] = 1
            count = 0
            min_x, min_y, max_x, max_y = width, height, 0, 0
            touches_edge = False
            while stack:
                px, py = stack.pop()
                count += 1
                min_x, max_x = min(min_x, px), max(max_x, px)
                min_y, max_y = min(min_y, py), max(max_y, py)
                touches_edge = touches_edge or px in (0, width - 1) or py in (0, height - 1)
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if 0 <= nx < width and 0 <= ny < height and light[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = 1
                        stack.append((nx, ny))
            box_width = max_x - min_x + 1
            box_height = max_y - min_y + 1
            box_area = box_width * box_height
            fill_ratio = count / max(1, box_area)
            too_small = box_width < min_width or box_height < min_height or box_area < min_area
            whole_page = box_width > width * 0.82 and box_height > height * 0.82
            page_background = touches_edge and (box_width > width * 0.5 or box_height > height * 0.5)
            likely_bubble = fill_ratio > 0.72 and box_width < width * 0.28 and box_height < height * 0.14
            if too_small or whole_page or page_background or likely_bubble:
                continue
            panels.append(
                {
                    "x": clamp((min_x - pad) / width, 0, 1),
                    "y": clamp((min_y - pad) / height, 0, 1),
                    "w": clamp((box_width + pad * 2) / width, 0.03, 1),
                    "h": clamp((box_height + pad * 2) / height, 0.03, 1),
                    "pageWidth": image.width,
                    "pageHeight": image.height,
                }
            )
    return panels


def detect_split_panels(dark, stats, image):
    height, width = dark.shape
    vertical = find_gutter_cuts(stats["col"], height, width)
    horizontal = find_gutter_cuts(stats["row"], width, height)
    page_area = width * height
    pad = max(6, round(min(width, height) * 0.008))
    panels = []
    for y0, y1 in zip(horizontal, horizontal[1:]):
        for x0, x1 in zip(vertical, vertical[1:]):
            bounds = content_bounds(dark, x0, y0, x1, y1)
            if not bounds:
                continue
            bw = bounds["x1"] - bounds["x0"]
            bh = bounds["y1"] - bounds["y0"]
            area = bw * bh
            if bw < width * 0.12 or bh < height * 0.06 or area < page_area * 0.012:
                continue
            panels.append(rect_from_bounds(bounds, width, height, image.width, image.height, pad))
    return panels


def full_page_panel(image):
    return {"x": 0, "y": 0, "w": 1, "h": 1, "pageWidth": image.width, "pageHeight": image.height}


def filter_edge_title_strips(panels):
    output = []
    for panel in panels:
        top_edge = panel["y"] < 0.025
        bottom_edge = panel["y"] + panel["h"] > 0.975
        shallow = panel["h"] < 0.13
        narrow_title_slice = panel["w"] < 0.28 and panel["h"] < 0.16
        if (top_edge or bottom_edge) and (shallow or narrow_title_slice):
            continue
        output.append(panel)
    return output


def iou(a, b):
    x0 = max(a["x"], b["x"])
    y0 = max(a["y"], b["y"])
    x1 = min(a["x"] + a["w"], b["x"] + b["w"])
    y1 = min(a["y"] + a["h"], b["y"] + b["h"])
    intersection = max(0, x1 - x0) * max(0, y1 - y0)
    union = a["w"] * a["h"] + b["w"] * b["h"] - intersection
    return intersection / union if union else 0


def merge_duplicate_panels(panels):
    kept = []
    for panel in panels:
        if not any(iou(panel, item) > 0.82 for item in kept):
            kept.append(panel)
    return kept


def overlap_1d(start_a, end_a, start_b, end_b):
    return max(0, min(end_a, end_b) - max(start_a, start_b))


def should_consolidate_manga_panels(a, b):
    overlap_x = overlap_1d(a["x"], a["x"] + a["w"], b["x"], b["x"] + b["w"])
    overlap_y = overlap_1d(a["y"], a["y"] + a["h"], b["y"], b["y"] + b["h"])
    x_containment = overlap_x / max(0.000001, min(a["w"], b["w"]))
    y_containment = overlap_y / max(0.000001, min(a["h"], b["h"]))
    area_a = max(0.000001, a["w"] * a["h"])
    area_b = max(0.000001, b["w"] * b["h"])
    intersection = overlap_x * overlap_y
    containment = intersection / min(area_a, area_b)
    overlap_iou = intersection / max(0.000001, area_a + area_b - intersection)
    area_ratio = min(area_a, area_b) / max(area_a, area_b)

    repeated_horizontal_band = x_containment >= 0.94 and y_containment >= 0.28
    repeated_vertical_band = y_containment >= 0.94 and x_containment >= 0.28
    near_duplicate = overlap_iou >= 0.68 or (containment >= 0.86 and area_ratio >= 0.42)
    return repeated_horizontal_band or repeated_vertical_band or near_duplicate


def union_panel(a, b):
    x = min(a["x"], b["x"])
    y = min(a["y"], b["y"])
    x1 = max(a["x"] + a["w"], b["x"] + b["w"])
    y1 = max(a["y"] + a["h"], b["y"] + b["h"])
    return {**a, "x": x, "y": y, "w": x1 - x, "h": y1 - y, "manga_consolidated": True}


def consolidate_manga_panels(panels):
    consolidated = [dict(panel) for panel in merge_duplicate_panels(panels)]
    changed = True
    passes = 0
    while changed and passes < 12:
        changed = False
        passes += 1
        for index, first in enumerate(consolidated):
            for other in range(index + 1, len(consolidated)):
                second = consolidated[other]
                if not should_consolidate_manga_panels(first, second):
                    continue
                consolidated[index] = union_panel(first, second)
                consolidated.pop(other)
                changed = True
                break
            if changed:
                break
    return merge_duplicate_panels(consolidated)


def plausible_panel(panel):
    area = panel["w"] * panel["h"]
    return panel["w"] > 0.08 and panel["h"] > 0.045 and area > 0.006 and area < 0.92


def panel_coverage(panels):
    return sum(panel["w"] * panel["h"] for panel in panels)


def plausible_recursive_panel(panel):
    if panel["x"] == 0 and panel["y"] == 0 and panel["w"] == 1 and panel["h"] == 1:
        return True
    return plausible_panel(panel)


def max_panel_area(panels):
    return max((panel["w"] * panel["h"] for panel in panels), default=0)


def choose_panel_set(recursive, connected, split, slanted=None, direction="rtl"):
    raw_recursive = merge_duplicate_panels(recursive)
    recursive = [p for p in merge_duplicate_panels(recursive) if plausible_recursive_panel(p)]
    connected = [p for p in merge_duplicate_panels(connected) if plausible_panel(p)]
    split = [p for p in merge_duplicate_panels(split) if plausible_panel(p)]
    slanted = [p for p in merge_duplicate_panels(slanted or []) if plausible_panel(p)]
    recursive_max_area = max_panel_area(recursive)
    slanted_max_area = max_panel_area(slanted)
    if (
        3 <= len(slanted) <= 14
        and (
            len(slanted) >= max(len(recursive), len(split)) + 1
            or (len(slanted) >= len(recursive) and slanted_max_area < recursive_max_area * 0.78)
        )
        and not has_order_violation(slanted, direction)
    ):
        return slanted, "slanted-manga"
    if 1 <= len(recursive) <= 12:
        return recursive, "recursive"
    if (len(connected) >= 16 or len(merge_duplicate_panels(connected)) > 16) and raw_recursive:
        return raw_recursive, "recursive-large-fallback"
    if len(split) >= 2 and (
        len(connected) > 12 or (len(connected) >= 8 and panel_coverage(connected) < 0.45 and len(split) < len(connected))
    ):
        return split, "split-over-connected"
    if len(split) >= 2 and len(connected) >= 8 and has_order_violation(connected, direction):
        return split, "split-over-ordered-connected"
    if len(connected) >= 2 and has_order_violation(connected, direction) and raw_recursive:
        return raw_recursive, "recursive-over-ordered-connected"
    if 2 <= len(connected) <= 16 and len(connected) >= len(split):
        return connected, "connected"
    if 2 <= len(split) <= 16:
        return split, "split"
    if connected:
        return connected, "connected-fallback"
    return split, "split-fallback"


def choose_comic_panel_set(recursive, connected, split, image, direction="ltr"):
    recursive = [p for p in merge_duplicate_panels(recursive) if plausible_recursive_panel(p)]
    connected = [p for p in merge_duplicate_panels(connected) if plausible_panel(p)]
    split = [p for p in merge_duplicate_panels(split) if plausible_panel(p)]
    recursive_tiny = any(panel["w"] * panel["h"] < 0.014 for panel in recursive)
    recursive_single_large = len(recursive) == 1 and recursive[0]["w"] * recursive[0]["h"] > 0.72

    if 2 <= len(recursive) <= 10 and not recursive_tiny and not has_order_violation(recursive, direction):
        return recursive, "comic-recursive"

    if 2 <= len(split) <= 8 and panel_coverage(split) >= 0.42 and not has_order_violation(split, direction):
        return split, "comic-split"

    focus = make_comic_focus_regions(connected, image)
    if (
        len(connected) >= 10
        and 9 <= len(split) <= 14
        and panel_coverage(split) >= 0.68
        and not has_order_violation(split, direction)
    ):
        return split, "comic-dense-split"

    if (recursive_single_large or recursive_tiny or len(split) > 8) and len(focus) >= 2:
        return focus, "comic-focus"

    if 2 <= len(split) <= 14:
        return split, "comic-split-fallback"
    if len(focus) >= 2:
        return focus, "comic-focus-fallback"
    if len(connected) >= 2:
        return connected, "comic-connected-fallback"
    if recursive:
        return recursive, "comic-recursive-fallback"
    return split, "comic-split-empty"


def choose_comic_flow_set(lum, dark, recursive, connected, split, image, direction="ltr"):
    recursive = [p for p in merge_duplicate_panels(recursive) if plausible_recursive_panel(p)]
    split = [p for p in merge_duplicate_panels(split) if plausible_panel(p)]
    connected = [p for p in merge_duplicate_panels(connected) if plausible_panel(p)]
    recursive_single_large = len(recursive) == 1 and recursive[0]["w"] * recursive[0]["h"] > 0.72

    text_components = detect_text_like_components(lum, dark, image)
    if likely_comic_cover_or_backmatter(recursive, connected, split, text_components):
        return [full_page_panel(image)], "flow-full-page-special"

    if looks_like_caption_strip_page(recursive, connected, split, text_components):
        return make_caption_strip_flow_windows(image.width, image.height), "flow-caption-strip"

    readable_text = make_readable_comic_text_windows(text_components, image.width, image.height)
    if len(readable_text) >= 3:
        return readable_text, "flow-readable-text"

    if needs_comic_story_flow(recursive, connected, split, text_components):
        story_regions = make_comic_story_flow_regions(lum, dark, image, text_components)
        if story_regions:
            return story_regions, "flow-story"

    if (
        2 <= len(recursive) <= 9
        and not recursive_single_large
        and not any(p["w"] * p["h"] < 0.014 for p in recursive)
        and not has_order_violation(recursive, direction)
    ):
        return merge_caption_strips_with_neighbors(recursive), "flow-recursive"
    if (
        2 <= len(split) <= 7
        and panel_coverage(split) >= 0.36
        and not has_order_violation(split, direction)
        and not split_looks_like_montage_slices(split)
    ):
        return split, "flow-split"

    story_regions = make_comic_story_flow_regions(lum, dark, image, text_components)
    if story_regions:
        return story_regions, "flow-story"

    if connected:
        return make_comic_focus_regions(connected, image), "flow-focus"
    if split:
        return split[:12], "flow-split-fallback"
    if recursive:
        return recursive, "flow-recursive-fallback"
    return [full_page_panel(image)], "flow-full-page"


def likely_comic_cover_or_backmatter(recursive, connected, split, text_components):
    if len(connected) <= 1 and (len(recursive) >= 12 or len(split) >= 9):
        return True
    if len(connected) == 0 and len(text_components) == 0:
        return True
    if len(connected) <= 3 and len(split) >= 5 and len(text_components) >= 14:
        return True
    if len(connected) <= 3 and 4 <= len(split) <= 7 and len(text_components) <= 20:
        skinny = sum(1 for panel in split if panel["w"] < 0.18 and panel["h"] > 0.45)
        if skinny >= 2:
            return True
    return False


def needs_comic_story_flow(recursive, connected, split, text_components):
    if split_looks_like_montage_slices(split):
        return True
    if len(text_components) > 20 and (len(recursive) <= 3 or len(split) > 8 or len(connected) >= 4):
        return True
    if len(recursive) >= 6 and len(connected) <= 3 and len(text_components) <= 12:
        return True
    return False


def looks_like_caption_strip_page(recursive, connected, split, text_components):
    if len(recursive) >= 6 and len(connected) <= 3 and len(text_components) <= 12:
        return True
    if len(split) <= 4 and len(connected) <= 1 and len(text_components) <= 4:
        return True
    return False


def split_looks_like_montage_slices(split):
    if len(split) < 4:
        return False
    tall_columns = sum(1 for panel in split if panel["h"] > 0.28 and panel["w"] < 0.38)
    shared_midline = sum(1 for panel in split if panel["x"] < 0.52 < panel["x"] + panel["w"])
    return tall_columns >= 4 or shared_midline >= 4


def merge_caption_strips_with_neighbors(panels):
    ordered = sort_fallback(panels, "ltr")
    output = []
    for panel in ordered:
        shallow_caption = panel["w"] > 0.62 and panel["h"] < 0.085
        narrow_caption = panel["w"] < 0.12 and panel["h"] > 0.16
        if (shallow_caption or narrow_caption) and output:
            previous = output[-1]
            x0 = min(previous["x"], panel["x"])
            y0 = min(previous["y"], panel["y"])
            x1 = max(previous["x"] + previous["w"], panel["x"] + panel["w"])
            y1 = max(previous["y"] + previous["h"], panel["y"] + panel["h"])
            previous["x"], previous["y"], previous["w"], previous["h"] = x0, y0, x1 - x0, y1 - y0
        elif shallow_caption:
            output.append(dict(panel))
        else:
            output.append(dict(panel))
    return output


def make_caption_strip_flow_windows(page_width, page_height):
    return [
        {"x": 0.18, "y": 0, "w": 0.64, "h": 0.38, "pageWidth": page_width, "pageHeight": page_height},
        {"x": 0.18, "y": 0.31, "w": 0.64, "h": 0.38, "pageWidth": page_width, "pageHeight": page_height},
        {"x": 0.18, "y": 0.62, "w": 0.64, "h": 0.38, "pageWidth": page_width, "pageHeight": page_height},
    ]


def make_readable_comic_text_windows(text_components, page_width, page_height):
    components = [
        item
        for item in text_components
        if 0.0008 <= item["w"] * item["h"] <= 0.06 and item["w"] <= 0.42 and item["h"] <= 0.2
    ]
    if len(components) < 3:
        return []

    groups = []
    for component in sort_fallback(components, "ltr"):
        best = None
        best_gap = 999
        for group in groups:
            y_gap = max(0, max(group["y"], component["y"]) - min(group["y"] + group["h"], component["y"] + component["h"]))
            x_gap = max(0, max(group["x"], component["x"]) - min(group["x"] + group["w"], component["x"] + component["w"]))
            vertical_overlap = overlap_1d(group["y"], group["y"] + group["h"], component["y"], component["y"] + component["h"])
            same_row = vertical_overlap > min(group["h"], component["h"]) * 0.25 or y_gap < 0.055
            if same_row and x_gap < 0.16 and y_gap < best_gap:
                best = group
                best_gap = y_gap
        if best:
            x0 = min(best["x"], component["x"])
            y0 = min(best["y"], component["y"])
            x1 = max(best["x"] + best["w"], component["x"] + component["w"])
            y1 = max(best["y"] + best["h"], component["y"] + component["h"])
            best["x"], best["y"], best["w"], best["h"] = x0, y0, x1 - x0, y1 - y0
            best["count"] = best.get("count", 1) + 1
        else:
            groups.append({**component, "count": 1})

    windows = []
    for group in sort_fallback(groups, "ltr")[:12]:
        center_x = group["x"] + group["w"] / 2
        center_y = group["y"] + group["h"] / 2
        width = clamp(group["w"] * 1.75 + 0.18, 0.42, 0.68)
        height = clamp(group["h"] * 2.35 + 0.12, 0.2, 0.42)
        # Keep a little more visual context for multi-balloon dialogue rows.
        if group.get("count", 1) >= 2:
            width = min(0.74, width + 0.08)
            height = min(0.46, height + 0.04)
        windows.append(
            {
                "x": clamp(center_x - width / 2, 0, 1 - width),
                "y": clamp(center_y - height / 2, 0, 1 - height),
                "w": width,
                "h": height,
                "pageWidth": page_width,
                "pageHeight": page_height,
            }
        )
    return suppress_near_duplicate_windows(windows)


def suppress_near_duplicate_windows(windows):
    kept = []
    for window in sort_fallback(windows, "ltr"):
        if kept and iou(window, kept[-1]) > 0.55:
            previous = kept[-1]
            x0 = min(previous["x"], window["x"])
            y0 = min(previous["y"], window["y"])
            x1 = max(previous["x"] + previous["w"], window["x"] + window["w"])
            y1 = max(previous["y"] + previous["h"], window["y"] + window["h"])
            previous["x"] = clamp(x0, 0, 1)
            previous["y"] = clamp(y0, 0, 1)
            previous["w"] = clamp(x1 - x0, 0.42, 0.74)
            previous["h"] = clamp(y1 - y0, 0.2, 0.46)
            previous["x"] = clamp(previous["x"], 0, 1 - previous["w"])
            previous["y"] = clamp(previous["y"], 0, 1 - previous["h"])
            continue
        kept.append(dict(window))
    return kept


def make_comic_story_flow_regions(lum, dark, image, text_components):
    windows = make_comic_row_windows(lum, dark, image, text_components)
    if len(windows) < 3:
        windows = make_text_guided_camera_windows(text_components, image.width, image.height)
    if len(windows) < 3:
        windows = make_default_flow_windows(image.width, image.height)
    windows = smooth_comic_camera_windows(windows, image.width, image.height)
    return [{**panel, "pageWidth": image.width, "pageHeight": image.height} for panel in windows[:9]]


def make_comic_row_windows(lum, dark, image, text_components):
    height, width = dark.shape
    stats = axis_stats(lum, dark)
    cuts = find_gutter_cuts(stats["row"], width, height)
    rows = []
    page_area = width * height
    for y0, y1 in zip(cuts, cuts[1:]):
        if y1 - y0 < height * 0.035:
            continue
        bounds = content_bounds(dark, 0, y0, width, y1)
        if not bounds:
            continue
        area = (bounds["x1"] - bounds["x0"]) * (bounds["y1"] - bounds["y0"])
        if area < page_area * 0.012:
            continue
        row_y = clamp((bounds["y0"] - height * 0.012) / height, 0, 1)
        row_h = clamp((bounds["y1"] - bounds["y0"] + height * 0.024) / height, 0.05, 1)
        focus = focused_comic_row_window(bounds, row_y, row_h, width, height, image, text_components)
        rows.append(focus)
    rows = merge_short_camera_rows(rows, min_height=0.145)
    output = []
    for row in rows:
        output.extend(split_tall_camera_window(row, max_height=0.42, overlap=0.06))
    return output


def focused_comic_row_window(bounds, row_y, row_h, width, height, image, text_components):
    row_y1 = row_y + row_h
    overlapping_text = [
        component
        for component in text_components
        if overlap_1d(row_y, row_y1, component["y"], component["y"] + component["h"]) > min(row_h, component["h"]) * 0.18
    ]
    if overlapping_text:
        min_x = min(component["x"] for component in overlapping_text)
        max_x = max(component["x"] + component["w"] for component in overlapping_text)
        center_x = sum(component["x"] + component["w"] / 2 for component in overlapping_text) / len(overlapping_text)
        desired_w = clamp((max_x - min_x) * 1.9 + 0.22, 0.62, 0.88)
    else:
        content_x0 = bounds["x0"] / width
        content_x1 = bounds["x1"] / width
        center_x = (content_x0 + content_x1) / 2
        desired_w = clamp((content_x1 - content_x0) * 1.08 + 0.08, 0.68, 0.9)
        if content_x1 - content_x0 > 0.86:
            desired_w = 0.82
    return {
        "x": clamp(center_x - desired_w / 2, 0, 1 - desired_w),
        "y": row_y,
        "w": desired_w,
        "h": row_h,
        "pageWidth": image.width,
        "pageHeight": image.height,
    }


def merge_short_camera_rows(rows, min_height):
    merged = []
    for row in sort_fallback(rows, "ltr"):
        if merged and (row["h"] < min_height or merged[-1]["h"] < min_height):
            previous = merged[-1]
            y0 = min(previous["y"], row["y"])
            y1 = max(previous["y"] + previous["h"], row["y"] + row["h"])
            previous["y"] = y0
            previous["h"] = y1 - y0
        else:
            merged.append(dict(row))
    return merged


def split_tall_camera_window(panel, max_height, overlap):
    if panel["h"] <= max_height:
        return [panel]
    windows = []
    start = panel["y"]
    end = panel["y"] + panel["h"]
    y = start
    while y < end - 0.02:
        h = min(max_height, end - y)
        if h < 0.16 and windows:
            previous = windows[-1]
            previous["h"] = min(1 - previous["y"], end - previous["y"])
            break
        windows.append({**panel, "y": y, "h": h})
        if y + h >= end:
            break
        y += max(0.12, h - overlap)
    return windows


def make_text_guided_camera_windows(text_components, page_width, page_height):
    if not text_components:
        return []
    ys = sorted(component["y"] + component["h"] / 2 for component in text_components)
    clusters = []
    for center_y in ys:
        if not clusters or center_y - clusters[-1][-1] > 0.16:
            clusters.append([center_y])
        else:
            clusters[-1].append(center_y)
    windows = []
    for cluster in clusters[:7]:
        center_y = sum(cluster) / len(cluster)
        height = 0.34 if len(cluster) <= 2 else 0.4
        windows.append(
            {
                "x": 0,
                "y": clamp(center_y - height / 2, 0, max(0, 1 - height)),
                "w": 1,
                "h": height,
                "pageWidth": page_width,
                "pageHeight": page_height,
            }
        )
    return windows


def smooth_comic_camera_windows(windows, page_width, page_height):
    ordered = sort_fallback(windows, "ltr")
    smoothed = []
    for window in ordered:
        candidate = {
            "x": clamp(window["x"], 0, 1),
            "y": clamp(window["y"], 0, 1),
            "w": clamp(window["w"], 0.52, 1),
            "h": clamp(window["h"], 0.2, 0.52),
            "pageWidth": page_width,
            "pageHeight": page_height,
        }
        candidate["x"] = clamp(candidate["x"], 0, 1 - candidate["w"])
        candidate["y"] = clamp(candidate["y"], 0, 1 - candidate["h"])
        if smoothed and iou(candidate, smoothed[-1]) > 0.72:
            continue
        if smoothed and candidate["y"] < smoothed[-1]["y"] + smoothed[-1]["h"] * 0.18:
            candidate["y"] = clamp(smoothed[-1]["y"] + smoothed[-1]["h"] * 0.18, 0, 1 - candidate["h"])
        smoothed.append(candidate)
    return smoothed


def make_comic_text_flow_regions(lum, dark, image):
    height, width = dark.shape
    text_components = detect_text_like_components(lum, dark, image)
    groups = group_text_components(text_components)
    windows = [expand_text_group_to_window(group, image.width, image.height) for group in groups]
    windows = add_flow_gap_windows(windows, image.width, image.height)
    return [{**panel, "pageWidth": image.width, "pageHeight": image.height} for panel in sort_fallback(windows, "ltr")[:14]]


def detect_text_like_components(lum, dark, image):
    height, width = dark.shape
    light = lum > 213
    visited = np.zeros((height, width), dtype=np.uint8)
    page_area = width * height
    components = []
    for y in range(height):
        for x in range(width):
            if not light[y, x] or visited[y, x]:
                continue
            stack = [(x, y)]
            visited[y, x] = 1
            count = 0
            min_x, min_y, max_x, max_y = width, height, 0, 0
            touches_edge = False
            while stack:
                px, py = stack.pop()
                count += 1
                min_x, max_x = min(min_x, px), max(max_x, px)
                min_y, max_y = min(min_y, py), max(max_y, py)
                touches_edge = touches_edge or px in (0, width - 1) or py in (0, height - 1)
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if 0 <= nx < width and 0 <= ny < height and light[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = 1
                        stack.append((nx, ny))
            box_w = max_x - min_x + 1
            box_h = max_y - min_y + 1
            box_area = box_w * box_h
            if box_w < width * 0.035 or box_h < height * 0.012:
                continue
            if box_area < page_area * 0.0006 or box_area > page_area * 0.09:
                continue
            if touches_edge and (box_w > width * 0.55 or box_h > height * 0.18):
                continue
            fill = count / max(1, box_area)
            dark_density = dark[min_y : max_y + 1, min_x : max_x + 1].sum() / max(1, box_area)
            if fill < 0.2 or dark_density < 0.004:
                continue
            pad_x = max(5, round(width * 0.01))
            pad_y = max(5, round(height * 0.006))
            components.append(
                {
                    "x": clamp((min_x - pad_x) / width, 0, 1),
                    "y": clamp((min_y - pad_y) / height, 0, 1),
                    "w": clamp((box_w + pad_x * 2) / width, 0.02, 1),
                    "h": clamp((box_h + pad_y * 2) / height, 0.02, 1),
                    "pageWidth": image.width,
                    "pageHeight": image.height,
                }
            )
    return components


def group_text_components(components):
    groups = []
    for component in sort_fallback(components, "ltr"):
        merged = False
        for group in groups:
            if should_group_text_regions(group, component):
                x0 = min(group["x"], component["x"])
                y0 = min(group["y"], component["y"])
                x1 = max(group["x"] + group["w"], component["x"] + component["w"])
                y1 = max(group["y"] + group["h"], component["y"] + component["h"])
                group["x"], group["y"], group["w"], group["h"] = x0, y0, x1 - x0, y1 - y0
                merged = True
                break
        if not merged:
            groups.append(dict(component))
    return groups


def should_group_text_regions(a, b):
    overlap_x = overlap_1d(a["x"], a["x"] + a["w"], b["x"], b["x"] + b["w"])
    overlap_y = overlap_1d(a["y"], a["y"] + a["h"], b["y"], b["y"] + b["h"])
    y_gap = max(0, max(a["y"], b["y"]) - min(a["y"] + a["h"], b["y"] + b["h"]))
    x_gap = max(0, max(a["x"], b["x"]) - min(a["x"] + a["w"], b["x"] + b["w"]))
    same_column = overlap_x > min(a["w"], b["w"]) * 0.22 and y_gap < 0.07
    same_row = overlap_y > min(a["h"], b["h"]) * 0.22 and x_gap < 0.08
    close = x_gap < 0.05 and y_gap < 0.055
    return same_column or same_row or close


def expand_text_group_to_window(group, page_width, page_height):
    center_x = group["x"] + group["w"] / 2
    center_y = group["y"] + group["h"] / 2
    width = min(1, max(0.44, group["w"] * 2.3 + 0.16))
    height = min(0.62, max(0.2, group["h"] * 3.2 + 0.08))
    return {
        "x": clamp(center_x - width / 2, 0, max(0, 1 - width)),
        "y": clamp(center_y - height / 2, 0, max(0, 1 - height)),
        "w": width,
        "h": height,
        "pageWidth": page_width,
        "pageHeight": page_height,
    }


def add_flow_gap_windows(windows, page_width, page_height):
    if not windows:
        return make_default_flow_windows(page_width, page_height)
    output = list(windows)
    if len(output) < 3:
        for candidate in make_default_flow_windows(page_width, page_height):
            if all(iou(candidate, item) < 0.42 for item in output):
                output.append(candidate)
    return output


def make_default_flow_windows(page_width, page_height):
    return [
        {"x": 0, "y": 0, "w": 1, "h": 0.38, "pageWidth": page_width, "pageHeight": page_height},
        {"x": 0, "y": 0.31, "w": 1, "h": 0.38, "pageWidth": page_width, "pageHeight": page_height},
        {"x": 0, "y": 0.62, "w": 1, "h": 0.38, "pageWidth": page_width, "pageHeight": page_height},
    ]


def make_comic_focus_regions(connected, image):
    candidates = []
    for panel in merge_duplicate_panels(connected):
        area = panel["w"] * panel["h"]
        if not plausible_panel(panel) or area >= 0.42:
            continue
        candidates.append(expand_comic_focus_region(panel, image.width, image.height))
    return [{**panel, "pageWidth": image.width, "pageHeight": image.height} for panel in sort_fallback(candidates, "ltr")[:16]]


def expand_comic_focus_region(panel, page_width, page_height):
    center_x = panel["x"] + panel["w"] / 2
    center_y = panel["y"] + panel["h"] / 2
    page_ratio = page_height / max(1, page_width)
    width = max(panel["w"] * 2.55, 0.5)
    height = max(panel["h"] * 3.15, 0.24)
    if page_ratio > 1.35:
        height = max(height, width * 0.58)
    if panel["w"] > 0.45 or panel["h"] > 0.25:
        width = max(panel["w"] * 1.45, 0.55)
        height = max(panel["h"] * 1.65, 0.28)
    width = min(1, width)
    height = min(0.72, height)
    return {
        "x": clamp(center_x - width / 2, 0, max(0, 1 - width)),
        "y": clamp(center_y - height / 2, 0, max(0, 1 - height)),
        "w": width,
        "h": height,
        "pageWidth": page_width,
        "pageHeight": page_height,
    }


def merge_comic_focus_regions(panels):
    merged = []
    for panel in sort_fallback(panels, "ltr"):
        previous = merged[-1] if merged else None
        if previous and should_merge_comic_focus(previous, panel):
            x0 = min(previous["x"], panel["x"])
            y0 = min(previous["y"], panel["y"])
            x1 = max(previous["x"] + previous["w"], panel["x"] + panel["w"])
            y1 = max(previous["y"] + previous["h"], panel["y"] + panel["h"])
            previous["x"] = x0
            previous["y"] = y0
            previous["w"] = x1 - x0
            previous["h"] = y1 - y0
        else:
            merged.append(dict(panel))
    return merged


def should_merge_comic_focus(a, b):
    overlap_x = overlap_1d(a["x"], a["x"] + a["w"], b["x"], b["x"] + b["w"])
    overlap_y = overlap_1d(a["y"], a["y"] + a["h"], b["y"], b["y"] + b["h"])
    smaller_x = min(a["w"], b["w"])
    smaller_y = min(a["h"], b["h"])
    if iou(a, b) > 0.42:
        return True
    return overlap_x > smaller_x * 0.7 and overlap_y > smaller_y * 0.68


def split_bands(panels, axis):
    start_key = axis
    size_key = "w" if axis == "x" else "h"
    bands = []
    for panel in sorted(panels, key=lambda item: item[start_key]):
        start = panel[start_key]
        end = panel[start_key] + panel[size_key]
        if not bands or start >= bands[-1]["end"] - 0.012:
            bands.append({"start": start, "end": end, "panels": [panel]})
        else:
            bands[-1]["end"] = max(bands[-1]["end"], end)
            bands[-1]["panels"].append(panel)
    return bands


def sort_panels(panels, direction="rtl", depth=0):
    if len(panels) <= 1:
        return panels[:]
    if depth > 8:
        return sort_fallback(panels, direction)
    rows = split_bands(panels, "y")
    if len(rows) > 1:
        output = []
        for row in rows:
            output.extend(sort_columns(row["panels"], direction, depth + 1))
        return output
    return sort_columns(panels, direction, depth + 1)


def sort_columns(panels, direction, depth):
    columns = split_bands(panels, "x")
    if len(columns) <= 1:
        return sort_fallback(panels, direction)
    ordered = list(reversed(columns)) if direction == "rtl" else columns
    output = []
    for column in ordered:
        output.extend(sort_panels(column["panels"], direction, depth + 1))
    return output


def sort_fallback(panels, direction):
    return sorted(panels, key=lambda item: (item["y"], -item["x"] if direction == "rtl" else item["x"]))


def repair_reading_order(panels, direction="rtl"):
    ordered = panels[:]
    max_passes = len(ordered) * len(ordered)
    passes = 0
    changed = True
    while changed and passes < max_passes:
        changed = False
        passes += 1
        for index in range(len(ordered) - 1):
            current = ordered[index]
            nxt = ordered[index + 1]
            if not transition_violation(current, nxt, direction):
                continue
            if transition_violation(nxt, current, direction):
                continue
            ordered[index] = nxt
            ordered[index + 1] = current
            changed = True
    return ordered


def has_order_violation(panels, direction="rtl"):
    ordered = repair_reading_order(sort_panels(merge_duplicate_panels(panels), direction), direction)
    return any(transition_violation(current, nxt, direction) for current, nxt in zip(ordered, ordered[1:]))


def transition_violation(current, nxt, direction="rtl"):
    tolerance = 0.035
    current_center_x = current["x"] + current["w"] / 2
    next_center_x = nxt["x"] + nxt["w"] / 2
    current_center_y = current["y"] + current["h"] / 2
    next_center_y = nxt["y"] + nxt["h"] / 2
    vertical_overlap = overlap_1d(current["y"], current["y"] + current["h"], nxt["y"], nxt["y"] + nxt["h"])
    horizontal_overlap = overlap_1d(current["x"], current["x"] + current["w"], nxt["x"], nxt["x"] + nxt["w"])
    same_row = vertical_overlap >= min(current["h"], nxt["h"]) * 0.42
    same_column = horizontal_overlap >= min(current["w"], nxt["w"]) * 0.42
    if direction == "rtl" and same_row and next_center_x > current_center_x + tolerance:
        return True
    if direction == "ltr" and same_row and next_center_x < current_center_x - tolerance:
        return True
    if same_column and next_center_y < current_center_y - tolerance:
        return True
    return False


def detect_manga_panels(image, direction="rtl"):
    lum, dark, black, light = make_masks(image)
    stats = axis_stats(lum, dark)
    recursive = detect_recursive_panels(lum, dark, black, image)
    connected = detect_connected_light_panels(light, image)
    split = detect_split_panels(dark, stats, image)
    slanted = detect_slanted_manga_panels(lum, dark, black, image)
    chosen, strategy = choose_panel_set(recursive, connected, split, slanted, direction)
    chosen = consolidate_manga_panels(chosen)
    chosen = repair_reading_order(sort_panels(chosen, direction), direction)
    if not chosen:
        chosen = [full_page_panel(image)]
        strategy = "full-page"
    return {
        "strategy": strategy,
        "panels": [{**panel, "label": f"Panel {index + 1}"} for index, panel in enumerate(chosen)],
        "candidate_counts": {
            "recursive": len(recursive),
            "connected": len(connected),
            "split": len(split),
            "slanted": len(slanted),
        },
    }


def detect_comic_panels(image, direction="ltr"):
    lum, dark, black, light = make_masks(image)
    stats = axis_stats(lum, dark)
    recursive = detect_recursive_panels(lum, dark, black, image)
    connected = detect_connected_light_panels(light, image)
    split = detect_split_panels(dark, stats, image)
    chosen, strategy = choose_comic_panel_set(recursive, connected, split, image, direction)
    if strategy.startswith("comic-focus"):
        chosen = sort_fallback(chosen, direction)
    else:
        chosen = repair_reading_order(sort_panels(merge_duplicate_panels(chosen), direction), direction)
    if not chosen:
        chosen = [full_page_panel(image)]
        strategy = "comic-full-page"
    return {
        "strategy": strategy,
        "panels": [{**panel, "label": f"Region {index + 1}"} for index, panel in enumerate(chosen)],
        "candidate_counts": {
            "recursive": len(recursive),
            "connected": len(connected),
            "split": len(split),
        },
    }


def detect_comic_flow_panels(image, direction="ltr"):
    lum, dark, black, light = make_masks(image)
    stats = axis_stats(lum, dark)
    recursive = detect_recursive_panels(lum, dark, black, image)
    connected = detect_connected_light_panels(light, image)
    split = detect_split_panels(dark, stats, image)
    chosen, strategy = choose_comic_flow_set(lum, dark, recursive, connected, split, image, direction)
    if strategy.startswith("flow-text") or strategy.startswith("flow-focus"):
        chosen = sort_fallback(chosen, direction)
    else:
        chosen = repair_reading_order(sort_panels(merge_duplicate_panels(chosen), direction), direction)
    if not chosen:
        chosen = [full_page_panel(image)]
        strategy = "flow-full-page"
    return {
        "strategy": strategy,
        "panels": [{**panel, "label": f"Step {index + 1}"} for index, panel in enumerate(chosen)],
        "candidate_counts": {
            "recursive": len(recursive),
            "connected": len(connected),
            "split": len(split),
            "text": len(detect_text_like_components(lum, dark, image)),
        },
    }


def suspicious_reasons(panels, image):
    reasons = []
    ratio = image.height / max(1, image.width)
    if ratio < 2.6 and len(panels) == 1:
        area = panels[0]["w"] * panels[0]["h"]
        if area > 0.72:
            reasons.append("single-large-panel")
    if len(panels) > 13:
        reasons.append("many-panels")
    if any(panel["w"] * panel["h"] < 0.012 for panel in panels):
        reasons.append("tiny-panel")
    if len(panels) >= 2 and max(panel["w"] * panel["h"] for panel in panels) > 0.86:
        reasons.append("large-panel-with-extra")
    for index, panel in enumerate(panels):
        for other in panels[index + 1 :]:
            if iou(panel, other) > 0.55:
                reasons.append("overlap")
                return reasons
    return reasons


def order_violations(panels, direction="rtl"):
    violations = []
    tolerance = 0.035
    for index, (current, nxt) in enumerate(zip(panels, panels[1:]), start=1):
        current_center_x = current["x"] + current["w"] / 2
        next_center_x = nxt["x"] + nxt["w"] / 2
        current_center_y = current["y"] + current["h"] / 2
        next_center_y = nxt["y"] + nxt["h"] / 2
        vertical_overlap = overlap_1d(current["y"], current["y"] + current["h"], nxt["y"], nxt["y"] + nxt["h"])
        horizontal_overlap = overlap_1d(current["x"], current["x"] + current["w"], nxt["x"], nxt["x"] + nxt["w"])
        same_row = vertical_overlap >= min(current["h"], nxt["h"]) * 0.42
        same_column = horizontal_overlap >= min(current["w"], nxt["w"]) * 0.42

        if direction == "rtl" and same_row and next_center_x > current_center_x + tolerance:
            violations.append({"after": index, "type": "rtl-row-moves-right"})
        if direction == "ltr" and same_row and next_center_x < current_center_x - tolerance:
            violations.append({"after": index, "type": "ltr-row-moves-left"})
        if same_column and next_center_y < current_center_y - tolerance:
            violations.append({"after": index, "type": "column-moves-up"})
    return violations


def overlap_1d(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def draw_overlay(image, panels, output):
    scale_width = 360
    scale = scale_width / image.width
    canvas = image.convert("RGB").resize((scale_width, round(image.height * scale)), Image.Resampling.BILINEAR)
    draw = ImageDraw.Draw(canvas)
    colors = ["red", "yellow", "cyan", "lime", "magenta", "orange", "white"]
    for index, panel in enumerate(panels, start=1):
        color = colors[(index - 1) % len(colors)]
        x0 = round(panel["x"] * canvas.width)
        y0 = round(panel["y"] * canvas.height)
        x1 = round((panel["x"] + panel["w"]) * canvas.width)
        y1 = round((panel["y"] + panel["h"]) * canvas.height)
        draw.rectangle((x0, y0, x1, y1), outline=color, width=3)
        draw.rectangle((x0, y0, x0 + 24, y0 + 18), fill="black")
        draw.text((x0 + 5, y0 + 2), str(index), fill=color)
    canvas.save(output, quality=88)


def make_contact_sheet(items, output, columns=5):
    thumbs = []
    for item in items:
        image = Image.open(item["path"]).convert("RGB")
        max_w = 220
        scale = max_w / image.width
        image = image.resize((max_w, round(image.height * scale)), Image.Resampling.BILINEAR)
        label_h = 36
        thumb = Image.new("RGB", (max_w, image.height + label_h), "#151515")
        thumb.paste(image, (0, label_h))
        draw = ImageDraw.Draw(thumb)
        color = "#ff7f70" if item["suspicious"] else "#f4f1ea"
        draw.text((5, 4), item["label"][:36], fill=color)
        draw.text((5, 19), item["meta"][:42], fill=color)
        thumbs.append(thumb)
    if not thumbs:
        return
    rows = math.ceil(len(thumbs) / columns)
    row_heights = []
    for row in range(rows):
        row_heights.append(max(thumb.height for thumb in thumbs[row * columns : (row + 1) * columns]))
    sheet = Image.new("RGB", (columns * 220, sum(row_heights)), "#10100f")
    y = 0
    for row in range(rows):
        x = 0
        for thumb in thumbs[row * columns : (row + 1) * columns]:
            sheet.paste(thumb, (x, y))
            x += 220
        y += row_heights[row]
    sheet.save(output, quality=88)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default=DEFAULT_APP)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--manga-id", type=int, required=True)
    parser.add_argument("--chapter-ids", default="")
    parser.add_argument("--chapters", type=int, default=5)
    parser.add_argument("--pages", type=int, default=0)
    parser.add_argument("--direction", default="rtl", choices=["rtl", "ltr"])
    parser.add_argument("--mode", default="auto", choices=["auto", "manga", "comic", "comic-flow"])
    parser.add_argument("--save-pages", action="store_true", help="Save original pages for external model benchmarks")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    auth = os.environ.get("PANEL_PILOT_AUTH")
    if not auth:
        raise SystemExit("Set PANEL_PILOT_AUTH=username:password")

    out_dir = Path(args.out)
    overlay_dir = out_dir / "overlays"
    overlay_dir.mkdir(parents=True, exist_ok=True)
    page_dir = out_dir / "pages"
    if args.save_pages:
        page_dir.mkdir(parents=True, exist_ok=True)

    if args.chapter_ids.strip():
        chapter_ids = [int(value.strip()) for value in args.chapter_ids.split(",") if value.strip()]
        chapters = fetch_chapter_infos(args.app, args.base, chapter_ids, auth)
    else:
        chapters = fetch_chapters(args.app, args.base, args.manga_id, auth)[: args.chapters]
    chapter_reports = []
    contact_items = []
    for chapter in chapters:
        pages = chapter.pop("_prefetched_pages", None) or fetch_pages(args.app, args.base, chapter["id"], auth)
        page_reports = []
        page_limit = args.pages or len(pages)
        for page_index, page_url in enumerate(pages[:page_limit], start=1):
            image = load_image(args.app, args.base, page_url, auth)
            if args.save_pages:
                page_path = page_dir / f"chapter-{chapter_sort_key(chapter):g}-page-{page_index:03d}.png"
                image.convert("RGB").save(page_path, optimize=True)
            mode = "webtoon" if image.height / max(1, image.width) >= 2.6 else args.mode
            if mode == "auto":
                mode = "manga"
            if mode == "manga":
                result = detect_manga_panels(image, args.direction)
            elif mode == "comic":
                result = detect_comic_panels(image, args.direction)
            elif mode == "comic-flow":
                result = detect_comic_flow_panels(image, args.direction)
            else:
                result = {"strategy": "webtoon-autodetect", "panels": [full_page_panel(image)], "candidate_counts": {}}
            reasons = suspicious_reasons(result["panels"], image) if mode in ("manga", "comic", "comic-flow") else []
            order_flags = order_violations(result["panels"], args.direction) if mode in ("manga", "comic", "comic-flow") else []
            if order_flags:
                reasons.append("order")
            overlay_path = overlay_dir / f"chapter-{chapter_sort_key(chapter):g}-page-{page_index:03d}.jpg"
            draw_overlay(image, result["panels"], overlay_path)
            row = {
                "page": page_index,
                "width": image.width,
                "height": image.height,
                "mode": mode,
                "strategy": result["strategy"],
                "panels": len(result["panels"]),
                "candidate_counts": result["candidate_counts"],
                "suspicious": reasons,
                "order_violations": order_flags,
            }
            page_reports.append(row)
            contact_items.append(
                {
                    "path": overlay_path,
                    "suspicious": bool(reasons),
                    "label": f"Ch {chapter.get('chapterNumber')} p{page_index}",
                    "meta": f"{row['panels']} panels {row['strategy']} {'/'.join(reasons)}",
                }
            )
        chapter_row = {
            "chapter_id": chapter["id"],
            "chapter": chapter.get("chapterNumber"),
            "name": chapter.get("name"),
            "source_pages": len(pages),
            "tested_pages": len(page_reports),
            "pages": page_reports,
            "suspicious_pages": sum(1 for page in page_reports if page["suspicious"]),
            "avg_panels": round(sum(page["panels"] for page in page_reports) / max(1, len(page_reports)), 2),
        }
        chapter_reports.append(chapter_row)
        print(json.dumps({key: chapter_row[key] for key in ("chapter_id", "chapter", "source_pages", "tested_pages", "suspicious_pages", "avg_panels")}, ensure_ascii=False))

    (out_dir / "report.json").write_text(json.dumps(chapter_reports, indent=2, ensure_ascii=False), encoding="utf-8")
    make_contact_sheet(contact_items, out_dir / "contact-sheet.jpg")


if __name__ == "__main__":
    main()
