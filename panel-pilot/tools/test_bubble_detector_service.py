#!/usr/bin/env python3
"""Unit checks for the shared ONNX panel and speech-bubble box adapter."""

from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.serve_manga_detector import detect_boxes  # noqa: E402


class FakeSession:
    def __init__(self, output):
        self.output = np.asarray([output], dtype=np.float32)

    def run(self, _outputs, inputs):
        assert inputs["images"].shape == (1, 3, 800, 800)
        return [self.output]


class DetectionBoxAdapterTests(unittest.TestCase):
    def test_letterboxed_coordinates_are_returned_in_source_image_space(self):
        # A 100x200 image is scaled by four and horizontally padded by 200px.
        session = FakeSession([
            [240, 80, 520, 320, 0.90, 0],
            [200, 0, 600, 800, 0.10, 0],
        ])
        image = Image.new("RGB", (100, 200), "white")

        boxes = detect_boxes(session, image, 800, 0.25)

        self.assertEqual(len(boxes), 1)
        self.assertAlmostEqual(boxes[0]["x"], 0.10, places=5)
        self.assertAlmostEqual(boxes[0]["y"], 0.10, places=5)
        self.assertAlmostEqual(boxes[0]["w"], 0.70, places=5)
        self.assertAlmostEqual(boxes[0]["h"], 0.30, places=5)
        self.assertAlmostEqual(boxes[0]["score"], 0.90, places=5)


if __name__ == "__main__":
    unittest.main()
