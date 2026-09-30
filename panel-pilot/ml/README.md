# Manga panel model

This service is deliberately manga-only. Comic and webtoon detection remains
separate so those formats can use their own models and thresholds.

The deployed model is the 10 MB ONNX export of
`leoxs22/manga-panel-detector-yolo26n`. The image build downloads a pinned
revision and verifies its SHA-256 checksum. It runs with ONNX Runtime on CPU;
the existing browser detector is retained as an automatic availability
fallback. See `MODEL-NOTICE.md` for attribution and licensing.

## Regression corpus

Build a manifest from the live Suwayomi library, then download a spread of
pages from three chapters per active title:

```sh
python tools/build_suwayomi_manga_test_manifest.py --output test-manifest.json
python tools/download_suwayomi_manga_test_corpus.py \
  --manifest test-manifest.json \
  --out test-corpus \
  --pages-per-chapter 3
```

Benchmark the pinned detector and create per-title contact sheets:

```sh
python ml/benchmark_onnx_detector.py \
  --model /models/manga-panel-detector.onnx \
  --kind yolo26 \
  --pages test-corpus/pages \
  --corpus test-corpus/corpus.json \
  --out benchmark-results
```

The September 2026 acceptance corpus contains 122 pages from 15 available
titles. The model averaged 255 ms/page on the local CPU, produced no reading
order or overlapping-box warnings, and flagged two large single-panel crops for
review. Chainsaw Man is included specifically for its non-standard layouts.
Zero-detection covers, title cards, and splash pages deliberately become a
single full-page view.

## Service contract

- `GET /health`
- `POST /v1/manga/panels` with raw image bytes and an `image/*` content type

The response contains normalized panel boxes and confidence scores. Keep port
8091 on the private Docker network. Panel Pilot uses the service only in manga
mode and automatically returns to the browser detector when the service is not
available.

## Optional future training

The Manga109 conversion and Faster R-CNN training scaffold remains available
for future experiments. Install `requirements-training.txt`, request the
dataset under its own terms, and never commit or redistribute its images or
annotations. A locally trained model should not replace the deployed model
until it beats the Suwayomi regression corpus on missed and duplicate panels.
