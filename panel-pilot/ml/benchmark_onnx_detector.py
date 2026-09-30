#!/usr/bin/env python3
"""Benchmark pretrained ONNX manga panel detectors on a page directory."""

import argparse
import json
import math
from pathlib import Path
import re
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))
from manga_detector_report import (  # noqa: E402
    consolidate_manga_panels,
    order_violations,
    repair_reading_order,
    sort_panels,
    suspicious_reasons,
)


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--kind", choices=("rtdetr", "yolo26", "deepghs-yolo"), required=True)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, help="Optional corpus.json used for per-title summaries")
    parser.add_argument("--threshold", type=float)
    parser.add_argument("--input-size", type=int)
    parser.add_argument("--direction", choices=("rtl", "ltr"), default="rtl")
    return parser.parse_args()


def letterbox(image, size):
    width, height = image.size
    scale = min(size / width, size / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    resized = image.resize((resized_width, resized_height), Image.Resampling.BILINEAR)
    left = (size - resized_width) // 2
    top = (size - resized_height) // 2
    canvas = Image.new("RGB", (size, size), "white")
    canvas.paste(resized, (left, top))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    return array.transpose(2, 0, 1)[None], scale, left, top


def box_iou(box, boxes):
    x0 = np.maximum(box[0], boxes[:, 0])
    y0 = np.maximum(box[1], boxes[:, 1])
    x1 = np.minimum(box[2], boxes[:, 2])
    y1 = np.minimum(box[3], boxes[:, 3])
    intersection = np.maximum(0, x1 - x0) * np.maximum(0, y1 - y0)
    area_a = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    area_b = np.maximum(0, boxes[:, 2] - boxes[:, 0]) * np.maximum(0, boxes[:, 3] - boxes[:, 1])
    return intersection / np.maximum(1e-6, area_a + area_b - intersection)


def nms(boxes, scores, threshold=.55):
    order = scores.argsort()[::-1]
    kept = []
    while order.size:
        current = int(order[0])
        kept.append(current)
        if order.size == 1:
            break
        remaining = order[1:]
        order = remaining[box_iou(boxes[current], boxes[remaining]) < threshold]
    return kept


def normalize_boxes(boxes, width, height):
    panels = []
    for x0, y0, x1, y1, score in boxes:
        x0 = min(width, max(0.0, float(x0)))
        y0 = min(height, max(0.0, float(y0)))
        x1 = min(width, max(0.0, float(x1)))
        y1 = min(height, max(0.0, float(y1)))
        if x1 - x0 < 3 or y1 - y0 < 3:
            continue
        panels.append({
            "x": x0 / width,
            "y": y0 / height,
            "w": (x1 - x0) / width,
            "h": (y1 - y0) / height,
            "score": float(score),
        })
    return panels


class Detector:
    def __init__(self, model, kind, threshold=None, input_size=None):
        self.kind = kind
        self.session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        defaults = {"rtdetr": .5, "yolo26": .25, "deepghs-yolo": .361}
        sizes = {"rtdetr": 1280, "yolo26": 1024, "deepghs-yolo": 1024}
        self.threshold = defaults[kind] if threshold is None else threshold
        self.input_size = sizes[kind] if input_size is None else input_size

    def __call__(self, image):
        if self.kind == "rtdetr":
            return self.detect_rtdetr(image)
        if self.kind == "yolo26":
            return self.detect_yolo26(image)
        return self.detect_deepghs(image)

    def detect_rtdetr(self, image):
        width, height = image.size
        resized = image.resize((self.input_size, self.input_size), Image.Resampling.BILINEAR)
        tensor = (np.asarray(resized, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]
        labels, boxes, scores = self.session.run(
            None,
            {"images": tensor, "orig_target_sizes": np.array([[width, height]], dtype=np.int64)},
        )
        keep = (labels[0] == 2) & (scores[0] >= self.threshold)
        selected = np.column_stack((boxes[0][keep], scores[0][keep]))
        return normalize_boxes(selected, width, height)

    def detect_yolo26(self, image):
        width, height = image.size
        tensor, scale, left, top = letterbox(image, self.input_size)
        output = self.session.run(None, {"images": tensor})[0][0]
        output = output[(output[:, 5] == 0) & (output[:, 4] >= self.threshold)]
        boxes = []
        for x0, y0, x1, y1, score, _class_id in output:
            boxes.append([(x0 - left) / scale, (y0 - top) / scale, (x1 - left) / scale, (y1 - top) / scale, score])
        return normalize_boxes(np.asarray(boxes).reshape(-1, 5), width, height)

    def detect_deepghs(self, image):
        width, height = image.size
        tensor, scale, left, top = letterbox(image, self.input_size)
        output = self.session.run(None, {"images": tensor})[0][0].T
        scores = output[:, 4:]
        class_ids = scores.argmax(axis=1)
        confidences = scores.max(axis=1)
        keep = (class_ids == 2) & (confidences >= self.threshold)
        predictions = output[keep, :4]
        confidences = confidences[keep]
        xyxy = np.empty_like(predictions)
        xyxy[:, 0] = predictions[:, 0] - predictions[:, 2] / 2
        xyxy[:, 1] = predictions[:, 1] - predictions[:, 3] / 2
        xyxy[:, 2] = predictions[:, 0] + predictions[:, 2] / 2
        xyxy[:, 3] = predictions[:, 1] + predictions[:, 3] / 2
        kept = nms(xyxy, confidences)
        boxes = []
        for index in kept:
            x0, y0, x1, y1 = xyxy[index]
            boxes.append([(x0 - left) / scale, (y0 - top) / scale, (x1 - left) / scale, (y1 - top) / scale,
                          confidences[index]])
        return normalize_boxes(np.asarray(boxes).reshape(-1, 5), width, height)


def draw_overlay(image, panels, output):
    canvas = image.copy()
    draw = ImageDraw.Draw(canvas)
    colors = ("red", "yellow", "cyan", "lime", "magenta", "orange", "blue")
    for index, panel in enumerate(panels, start=1):
        x0 = round(panel["x"] * canvas.width)
        y0 = round(panel["y"] * canvas.height)
        x1 = round((panel["x"] + panel["w"]) * canvas.width)
        y1 = round((panel["y"] + panel["h"]) * canvas.height)
        color = colors[(index - 1) % len(colors)]
        draw.rectangle((x0, y0, x1, y1), outline=color, width=max(2, canvas.width // 300))
        draw.rectangle((x0, y0, x0 + 30, y0 + 20), fill="black")
        draw.text((x0 + 5, y0 + 3), str(index), fill=color)
    canvas.save(output, quality=90)


def contact_sheet(items, output, columns=5):
    width = 220
    label_height = 38
    thumbs = []
    for item in items:
        image = Image.open(item["path"]).convert("RGB")
        scale = width / image.width
        image = image.resize((width, round(image.height * scale)), Image.Resampling.BILINEAR)
        thumb = Image.new("RGB", (width, image.height + label_height), "#151515")
        thumb.paste(image, (0, label_height))
        draw = ImageDraw.Draw(thumb)
        draw.text((5, 4), item["name"], fill="white")
        draw.text((5, 20), item["meta"], fill="#ff7f70" if item["suspicious"] else "#cccccc")
        thumbs.append(thumb)
    rows = math.ceil(len(thumbs) / columns)
    row_heights = [max(thumb.height for thumb in thumbs[row * columns:(row + 1) * columns]) for row in range(rows)]
    sheet = Image.new("RGB", (columns * width, sum(row_heights)), "#10100f")
    y = 0
    for row, row_height in enumerate(row_heights):
        for column, thumb in enumerate(thumbs[row * columns:(row + 1) * columns]):
            sheet.paste(thumb, (column * width, y))
        y += row_height
    sheet.save(output, quality=88)


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "untitled"


def load_corpus(path):
    if not path:
        return {}
    document = json.loads(path.read_text(encoding="utf-8"))
    return {page["file"]: page for page in document.get("pages", [])}


def summarize_rows(rows):
    return {
        "pages": len(rows),
        "average_panels": round(sum(row["panels"] for row in rows) / max(1, len(rows)), 2),
        "average_elapsed_ms": round(sum(row["elapsed_ms"] for row in rows) / max(1, len(rows)), 1),
        "zero_panel_pages": sum(row["panels"] == 0 for row in rows),
        "suspicious_pages": sum(bool(row["suspicious"]) for row in rows),
    }


def main():
    args = arguments()
    args.out.mkdir(parents=True, exist_ok=True)
    overlays = args.out / "overlays"
    overlays.mkdir(exist_ok=True)
    detector = Detector(args.model, args.kind, args.threshold, args.input_size)
    corpus = load_corpus(args.corpus)
    rows = []
    contacts = []
    for page_path in sorted(args.pages.glob("*")):
        if page_path.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
            continue
        image = Image.open(page_path).convert("RGB")
        started = time.perf_counter()
        raw = detector(image)
        elapsed_ms = (time.perf_counter() - started) * 1000
        panels = consolidate_manga_panels(raw)
        panels = repair_reading_order(sort_panels(panels, args.direction), args.direction)
        reasons = suspicious_reasons(panels, image)
        violations = order_violations(panels, args.direction)
        if violations:
            reasons.append("order")
        overlay_path = overlays / f"{page_path.stem}.jpg"
        draw_overlay(image, panels, overlay_path)
        row = {
            "page": page_path.name,
            "title": corpus.get(page_path.name, {}).get("title", "Unknown"),
            "chapter_number": corpus.get(page_path.name, {}).get("chapter_number"),
            "page_number": corpus.get(page_path.name, {}).get("page"),
            "width": image.width,
            "height": image.height,
            "raw_panels": len(raw),
            "panels": len(panels),
            "mean_score": round(sum(panel.get("score", 0) for panel in panels) / max(1, len(panels)), 4),
            "elapsed_ms": round(elapsed_ms, 1),
            "suspicious": reasons,
            "order_violations": violations,
            "boxes": panels,
        }
        rows.append(row)
        contacts.append({
            "path": overlay_path,
            "name": page_path.stem,
            "meta": f"{len(panels)} panels {elapsed_ms:.0f}ms {'/'.join(reasons)}",
            "suspicious": bool(reasons),
        })
        print(f"{page_path.name}: {len(raw)} raw -> {len(panels)} panels, {elapsed_ms:.0f} ms, {reasons}")
    totals = summarize_rows(rows)
    titles = {}
    for title in sorted({row["title"] for row in rows}):
        title_rows = [row for row in rows if row["title"] == title]
        titles[title] = summarize_rows(title_rows)
        title_contacts = [item for item, row in zip(contacts, rows) if row["title"] == title]
        if title_contacts:
            contact_sheet(title_contacts, args.out / f"contact-{slugify(title)}.jpg", columns=3)
    summary = {
        "model": args.model.name,
        "kind": args.kind,
        "threshold": detector.threshold,
        "input_size": detector.input_size,
        **totals,
        "titles": titles,
        "results": rows,
    }
    (args.out / "report.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if contacts:
        contact_sheet(contacts, args.out / "contact-sheet.jpg")
    print(json.dumps({key: summary[key] for key in ("model", "pages", "average_panels", "average_elapsed_ms", "zero_panel_pages", "suspicious_pages", "titles")}, indent=2))


if __name__ == "__main__":
    main()
