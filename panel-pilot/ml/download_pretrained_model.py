#!/usr/bin/env python3
"""Download the pinned ONNX detector exports and verify them before image creation."""

import hashlib
from pathlib import Path
import sys
from urllib.request import Request, urlopen


PANEL_URL = "https://huggingface.co/mednasserallah/manga-panel-detector-yolo26n-onnx/resolve/f6b7f3c/manga_panel_detector_fp32_1024.onnx?download=true"
PANEL_SHA256 = "e66667bc6d5f00013ff27efc15d21e521825369d44dfd5d7f6e43cda2ca512b7"
BUBBLE_URL = "https://huggingface.co/Remidesbois/Poneglyph-ReaderNet/resolve/d97d4cd2903a7ebe49276a5269c4f3b7df608be7/bubble_detector.onnx?download=true"
BUBBLE_SHA256 = "fa28ece56ba9e5ccf4361fbb4d2533e088906b0a0d1cd187c02422ba7d6f5688"
COMIC_URL = "https://huggingface.co/cedarrapidsboy/inkwell-panel-models/resolve/fa7afba52ba7dc7b0840c7702b767972b5e17a9b/best.onnx?download=true"
COMIC_SHA256 = "f240e1296efd048126b26ea4ffeddc97d7c3aa667a37e3127c2afc6d5e9b9578"
COMIC_ORDER_URL = "https://huggingface.co/cedarrapidsboy/inkwell-panel-models/resolve/fa7afba52ba7dc7b0840c7702b767972b5e17a9b/panel-order-model.onnx?download=true"
COMIC_ORDER_SHA256 = "84eb78fc5ec31a3e986a7a16ce10f7baa657ef5c5b4a98877b40aa9354ff3464"


def download(url, sha256, destination):
    request = Request(url, headers={"User-Agent": "Panels model downloader"})
    with urlopen(request, timeout=120) as response:
        payload = response.read()
    digest = hashlib.sha256(payload).hexdigest()
    if digest != sha256:
        raise RuntimeError(f"Unexpected model checksum for {destination.name}: {digest}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    print(f"Downloaded {destination} ({len(payload)} bytes, sha256={digest})")


def main():
    panel_destination = Path(sys.argv[1] if len(sys.argv) > 1 else "manga-panel-detector.onnx")
    bubble_destination = Path(sys.argv[2] if len(sys.argv) > 2 else panel_destination.with_name("speech-bubble-detector.onnx"))
    comic_destination = Path(sys.argv[3] if len(sys.argv) > 3 else panel_destination.with_name("comic-panel-detector.onnx"))
    order_destination = Path(sys.argv[4] if len(sys.argv) > 4 else panel_destination.with_name("comic-panel-order.onnx"))
    download(PANEL_URL, PANEL_SHA256, panel_destination)
    download(BUBBLE_URL, BUBBLE_SHA256, bubble_destination)
    download(COMIC_URL, COMIC_SHA256, comic_destination)
    download(COMIC_ORDER_URL, COMIC_ORDER_SHA256, order_destination)


if __name__ == "__main__":
    main()
