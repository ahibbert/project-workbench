# Manga panel model

This service is deliberately manga-only. Comic and webtoon detection remains
separate so those formats can use their own models and thresholds.

The deployed model is the 10 MB ONNX export of
`leoxs22/manga-panel-detector-yolo26n`. The image build downloads a pinned
revision and verifies its SHA-256 checksum. It runs with ONNX Runtime on CPU;
the existing browser detector is retained as an automatic availability
fallback. See `MODEL-NOTICE.md` for attribution and licensing.

Compose builds this optional image from the repository root so the image can
include the project license and model notice. For a direct build, use the same
context:

```sh
docker build -f ml/Dockerfile -t panels-manga-detector .
```

Do not run `docker build ml`; that narrower context does not contain the
required license file.

## Regression corpus

Build a manifest from the live Suwayomi library, then download a spread of
pages from three chapters per active title:

> **Private test data:** `test-manifest.json` can contain library titles,
> internal Suwayomi identifiers, chapter metadata, and source URLs.
> `test-corpus/` and `benchmark-results/` can contain copyrighted manga pages,
> crops, overlays, and reading-history-derived metadata. These paths are
> excluded from Git and Docker build contexts. Never commit, publish, attach,
> or redistribute them; generate them only on a trusted machine and remove
> them when the evaluation is complete.

```sh
python tools/build_suwayomi_manga_test_manifest.py --out test-manifest.json
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

The September 2026 private acceptance corpus contains 122 pages from 15
available titles. The model averaged 255 ms/page on the local CPU, produced no
reading-order or overlapping-box warnings, and flagged two large single-panel
crops for review. The corpus includes a non-standard-layout sample without
publishing its pages or identifying library metadata. Zero-detection covers,
title cards, and splash pages deliberately become a single full-page view.

## Service contract

- `GET /health`
- `POST /v1/manga/panels` with raw image bytes and an `image/*` content type

The response contains normalized panel boxes and confidence scores. Keep port
8091 on the private Docker network. Panels uses the service only in manga
mode and automatically returns to the browser detector when the service is not
available.

## Optional future training

The Manga109 conversion and Faster R-CNN training scaffold remains available
for future experiments. Install `requirements-training.txt`, request the
dataset under its own terms, and never commit or redistribute its images or
annotations. A locally trained model should not replace the deployed model
until it beats the Suwayomi regression corpus on missed and duplicate panels.
Keep dataset inputs and converted training outputs outside this repository so
they cannot enter Git history or a Docker build context accidentally.
