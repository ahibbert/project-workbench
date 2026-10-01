#!/usr/bin/env python3
"""Download the pinned ONNX export and verify it before image creation."""

import hashlib
from pathlib import Path
import sys
from urllib.request import Request, urlopen


URL = "https://huggingface.co/mednasserallah/manga-panel-detector-yolo26n-onnx/resolve/f6b7f3c/manga_panel_detector_fp32_1024.onnx?download=true"
SHA256 = "e66667bc6d5f00013ff27efc15d21e521825369d44dfd5d7f6e43cda2ca512b7"


def main():
    destination = Path(sys.argv[1] if len(sys.argv) > 1 else "manga-panel-detector.onnx")
    request = Request(URL, headers={"User-Agent": "Panels model downloader"})
    with urlopen(request, timeout=120) as response:
        payload = response.read()
    digest = hashlib.sha256(payload).hexdigest()
    if digest != SHA256:
        raise RuntimeError(f"Unexpected model checksum: {digest}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    print(f"Downloaded {destination} ({len(payload)} bytes, sha256={digest})")


if __name__ == "__main__":
    main()
