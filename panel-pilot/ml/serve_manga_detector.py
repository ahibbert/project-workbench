#!/usr/bin/env python3
"""Private ONNX inference service for Panel Pilot's manga reader."""

import io
import os

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from PIL import Image, UnidentifiedImageError


MODEL_PATH = os.environ.get("MANGA_MODEL_PATH", "/models/manga-panel-detector.onnx")
BUBBLE_MODEL_PATH = os.environ.get("BUBBLE_MODEL_PATH", "/models/speech-bubble-detector.onnx")
SCORE_THRESHOLD = float(os.environ.get("MANGA_SCORE_THRESHOLD", "0.25"))
BUBBLE_SCORE_THRESHOLD = float(os.environ.get("BUBBLE_SCORE_THRESHOLD", "0.25"))
INPUT_SIZE = int(os.environ.get("MANGA_INPUT_SIZE", "1024"))
BUBBLE_INPUT_SIZE = int(os.environ.get("BUBBLE_INPUT_SIZE", "800"))
MAX_IMAGE_BYTES = int(os.environ.get("MANGA_MAX_IMAGE_BYTES", str(12 * 1024 * 1024)))

app = FastAPI(title="Panel Pilot manga detector", version="2")
session = None
bubble_session = None


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


@app.on_event("startup")
def load_model():
    global session, bubble_session
    if os.path.exists(MODEL_PATH):
        session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    if os.path.exists(BUBBLE_MODEL_PATH):
        bubble_session = ort.InferenceSession(BUBBLE_MODEL_PATH, providers=["CPUExecutionProvider"])


@app.get("/health")
def health():
    return {
        "ready": session is not None,
        "model": "manga-yolo26n-1024",
        "threshold": SCORE_THRESHOLD,
        "bubbleModelReady": bubble_session is not None,
        "bubbleModel": "poneglyph-yolo26n-800" if bubble_session is not None else None,
        "bubbleThreshold": BUBBLE_SCORE_THRESHOLD,
    }


@app.post("/v1/manga/panels")
async def detect_panels(request: Request):
    if session is None:
        raise HTTPException(status_code=503, detail="Manga model is not loaded")
    body = await request.body()
    if not body or len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is empty or too large")
    try:
        source = Image.open(io.BytesIO(body)).convert("RGB")
    except (UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=400, detail="Invalid image") from error

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
