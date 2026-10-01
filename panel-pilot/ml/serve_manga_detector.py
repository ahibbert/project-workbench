#!/usr/bin/env python3
"""Private ONNX inference service for Panels' manga and comic readers."""

import io
import os

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from PIL import Image, UnidentifiedImageError


MODEL_PATH = os.environ.get("MANGA_MODEL_PATH", "/models/manga-panel-detector.onnx")
BUBBLE_MODEL_PATH = os.environ.get("BUBBLE_MODEL_PATH", "/models/speech-bubble-detector.onnx")
COMIC_MODEL_PATH = os.environ.get("COMIC_MODEL_PATH", "/models/comic-panel-detector.onnx")
COMIC_ORDER_MODEL_PATH = os.environ.get("COMIC_ORDER_MODEL_PATH", "/models/comic-panel-order.onnx")
SCORE_THRESHOLD = float(os.environ.get("MANGA_SCORE_THRESHOLD", "0.25"))
BUBBLE_SCORE_THRESHOLD = float(os.environ.get("BUBBLE_SCORE_THRESHOLD", "0.25"))
COMIC_SCORE_THRESHOLD = float(os.environ.get("COMIC_SCORE_THRESHOLD", "0.25"))
COMIC_NMS_THRESHOLD = float(os.environ.get("COMIC_NMS_THRESHOLD", "0.45"))
INPUT_SIZE = int(os.environ.get("MANGA_INPUT_SIZE", "1024"))
BUBBLE_INPUT_SIZE = int(os.environ.get("BUBBLE_INPUT_SIZE", "800"))
COMIC_INPUT_SIZE = int(os.environ.get("COMIC_INPUT_SIZE", "640"))
MAX_IMAGE_BYTES = int(os.environ.get("MANGA_MAX_IMAGE_BYTES", str(12 * 1024 * 1024)))

app = FastAPI(title="Panels detector service", version="3")
session = None
bubble_session = None
comic_session = None
comic_order_session = None


def letterbox(image, input_size):
    width, height = image.size
    scale = min(input_size / width, input_size / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    resized = image.resize((resized_width, resized_height), Image.Resampling.BILINEAR)
    left = (input_size - resized_width) // 2
    top = (input_size - resized_height) // 2
    canvas = Image.new("RGB", (input_size, input_size), "white")
    canvas.paste(resized, (left, top))
    tensor = np.asarray(canvas, dtype=np.float32) / 255.0
    return tensor.transpose(2, 0, 1)[None], scale, left, top


def detect_boxes(model_session, source, input_size, threshold):
    width, height = source.size
    tensor, scale, left, top = letterbox(source, input_size)
    output = model_session.run(None, {"images": tensor})[0][0]
    output = output[(output[:, 5] == 0) & (output[:, 4] >= threshold)]
    boxes = []
    for x0, y0, x1, y1, score, _class_id in output:
        x0 = min(width, max(0.0, float(x0 - left) / scale))
        y0 = min(height, max(0.0, float(y0 - top) / scale))
        x1 = min(width, max(0.0, float(x1 - left) / scale))
        y1 = min(height, max(0.0, float(y1 - top) / scale))
        if x1 - x0 < 3 or y1 - y0 < 3:
            continue
        boxes.append({
            "x": x0 / width,
            "y": y0 / height,
            "w": (x1 - x0) / width,
            "h": (y1 - y0) / height,
            "score": float(score),
        })
    return boxes


def box_iou(box, boxes):
    x0 = np.maximum(box[0], boxes[:, 0])
    y0 = np.maximum(box[1], boxes[:, 1])
    x1 = np.minimum(box[2], boxes[:, 2])
    y1 = np.minimum(box[3], boxes[:, 3])
    intersection = np.maximum(0, x1 - x0) * np.maximum(0, y1 - y0)
    area_a = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    area_b = np.maximum(0, boxes[:, 2] - boxes[:, 0]) * np.maximum(0, boxes[:, 3] - boxes[:, 1])
    return intersection / np.maximum(1e-6, area_a + area_b - intersection)


def non_maximum_suppression(boxes, scores, threshold):
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


def detect_yolov8_boxes(model_session, source, input_size, score_threshold, nms_threshold):
    width, height = source.size
    tensor, scale, left, top = letterbox(source, input_size)
    input_name = model_session.get_inputs()[0].name
    output = np.asarray(model_session.run(None, {input_name: tensor})[0][0])
    if output.ndim != 2:
        raise RuntimeError(f"Unexpected comic detector output shape: {output.shape}")
    if output.shape[0] <= 8 and output.shape[1] > output.shape[0]:
        output = output.T
    if output.shape[1] < 5:
        raise RuntimeError(f"Unexpected comic detector output shape: {output.shape}")
    scores = output[:, 4]
    keep = scores >= score_threshold
    predictions = output[keep, :4]
    scores = scores[keep]
    if not predictions.size:
        return []
    boxes = np.empty_like(predictions)
    boxes[:, 0] = predictions[:, 0] - predictions[:, 2] / 2
    boxes[:, 1] = predictions[:, 1] - predictions[:, 3] / 2
    boxes[:, 2] = predictions[:, 0] + predictions[:, 2] / 2
    boxes[:, 3] = predictions[:, 1] + predictions[:, 3] / 2
    selected = non_maximum_suppression(boxes, scores, nms_threshold)
    panels = []
    for index in selected:
        x0, y0, x1, y1 = boxes[index]
        x0 = min(width, max(0.0, float(x0 - left) / scale))
        y0 = min(height, max(0.0, float(y0 - top) / scale))
        x1 = min(width, max(0.0, float(x1 - left) / scale))
        y1 = min(height, max(0.0, float(y1 - top) / scale))
        if x1 - x0 < 3 or y1 - y0 < 3:
            continue
        panels.append({
            "x": x0 / width,
            "y": y0 / height,
            "w": (x1 - x0) / width,
            "h": (y1 - y0) / height,
            "score": float(scores[index]),
        })
    return panels


def positive_class_probabilities(outputs):
    probabilities = outputs[1]
    if isinstance(probabilities, list):
        return np.asarray([item.get(1, item.get("1", 0.0)) for item in probabilities], dtype=np.float64)
    return np.asarray(probabilities)[:, 1]


def order_comic_panels(panels, model_session):
    count = len(panels)
    if count <= 1:
        return list(range(count))
    if model_session is None:
        return sorted(range(count), key=lambda index: (panels[index]["y"], panels[index]["x"]))
    boxes = [{
        **panel,
        "cx": panel["x"] + panel["w"] / 2,
        "cy": panel["y"] + panel["h"] / 2,
        "x2": panel["x"] + panel["w"],
        "y2": panel["y"] + panel["h"],
    } for panel in panels]
    median_height = float(np.median([panel["h"] for panel in boxes]))
    normalized_count = count / 20.0

    def features(a, b):
        dx, dy = b["cx"] - a["cx"], b["cy"] - a["cy"]
        vertical = max(0.0, min(a["y2"], b["y2"]) - max(a["y"], b["y"])) / max(1e-6, min(a["h"], b["h"]))
        horizontal = max(0.0, min(a["x2"], b["x2"]) - max(a["x"], b["x"])) / max(1e-6, min(a["w"], b["w"]))
        return [
            dx, dy, vertical, horizontal, a["h"] / max(1e-6, b["h"]), a["w"] / max(1e-6, b["w"]),
            float(a["cx"] < .5), float(b["cx"] < .5), float(a["cy"] < .5), float(b["cy"] < .5),
            float(a["h"] > median_height * 1.4), float(b["h"] > median_height * 1.4), normalized_count,
            float(vertical >= .3 and dx > 0),
        ]

    input_name = model_session.get_inputs()[0].name
    scores = np.zeros(count)
    for index, panel in enumerate(boxes):
        batch = np.asarray([features(panel, other) for other_index, other in enumerate(boxes) if other_index != index], dtype=np.float32)
        scores[index] = positive_class_probabilities(model_session.run(None, {input_name: batch})).sum()
    return list(np.argsort(-scores))


async def request_image(request):
    body = await request.body()
    if not body or len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is empty or too large")
    try:
        return Image.open(io.BytesIO(body)).convert("RGB")
    except (UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=400, detail="Invalid image") from error


@app.on_event("startup")
def load_model():
    global session, bubble_session, comic_session, comic_order_session
    if os.path.exists(MODEL_PATH):
        session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    if os.path.exists(BUBBLE_MODEL_PATH):
        bubble_session = ort.InferenceSession(BUBBLE_MODEL_PATH, providers=["CPUExecutionProvider"])
    if os.path.exists(COMIC_MODEL_PATH):
        comic_session = ort.InferenceSession(COMIC_MODEL_PATH, providers=["CPUExecutionProvider"])
    if os.path.exists(COMIC_ORDER_MODEL_PATH):
        comic_order_session = ort.InferenceSession(COMIC_ORDER_MODEL_PATH, providers=["CPUExecutionProvider"])


@app.get("/health")
def health():
    return {
        "ready": session is not None,
        "model": "manga-yolo26n-1024",
        "threshold": SCORE_THRESHOLD,
        "bubbleModelReady": bubble_session is not None,
        "bubbleModel": "poneglyph-yolo26n-800" if bubble_session is not None else None,
        "bubbleThreshold": BUBBLE_SCORE_THRESHOLD,
        "comicModelReady": comic_session is not None,
        "comicModel": "inkwell-yolov8n-640" if comic_session is not None else None,
        "comicOrderModelReady": comic_order_session is not None,
        "comicOrderModel": "inkwell-gradient-boosting" if comic_order_session is not None else None,
        "comicThreshold": COMIC_SCORE_THRESHOLD,
    }


@app.post("/v1/manga/panels")
async def detect_panels(request: Request):
    if session is None:
        raise HTTPException(status_code=503, detail="Manga model is not loaded")
    source = await request_image(request)

    width, height = source.size
    panels = detect_boxes(session, source, INPUT_SIZE, SCORE_THRESHOLD)
    bubbles = detect_boxes(bubble_session, source, BUBBLE_INPUT_SIZE, BUBBLE_SCORE_THRESHOLD) if bubble_session else []
    return {
        "model": "manga-yolo26n-1024",
        "bubbleModel": "poneglyph-yolo26n-800" if bubble_session is not None else None,
        "width": width,
        "height": height,
        "panels": panels,
        "bubbles": bubbles,
    }


@app.post("/v1/comic/panels")
async def detect_comic_panels(request: Request):
    if comic_session is None:
        raise HTTPException(status_code=503, detail="Comic model is not loaded")
    source = await request_image(request)
    width, height = source.size
    panels = detect_yolov8_boxes(
        comic_session, source, COMIC_INPUT_SIZE, COMIC_SCORE_THRESHOLD, COMIC_NMS_THRESHOLD,
    )
    order = order_comic_panels(panels, comic_order_session)
    return {
        "model": "inkwell-yolov8n-640",
        "orderModel": "inkwell-gradient-boosting" if comic_order_session is not None else None,
        "width": width,
        "height": height,
        "panels": [panels[index] for index in order],
    }
