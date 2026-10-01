#!/usr/bin/env python3
"""Unit checks for the shared ONNX panel and speech-bubble box adapter."""

from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.serve_manga_detector import detect_boxes, detect_yolov8_boxes, order_comic_panels  # noqa: E402


class FakeSession:
    def __init__(self, output):
        self.output = np.asarray([output], dtype=np.float32)

    def run(self, _outputs, inputs):
        assert inputs["images"].shape == (1, 3, 800, 800)
        return [self.output]


class FakeInput:
    name = "images"


class FakeYoloSession:
    def __init__(self, predictions):
        self.output = np.asarray([np.asarray(predictions, dtype=np.float32).T])

    def get_inputs(self):
        return [FakeInput()]

    def run(self, _outputs, inputs):
        assert inputs["images"].shape == (1, 3, 640, 640)
        return [self.output]


class FakeOrderSession:
    def get_inputs(self):
        return [FakeInput()]

    def run(self, _outputs, inputs):
        probabilities = (inputs["images"][:, 0] > 0).astype(np.float32)
        return [np.zeros(len(probabilities), dtype=np.int64), np.column_stack((1 - probabilities, probabilities))]


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

    def test_yolov8_comic_boxes_are_letterbox_corrected_and_nms_filtered(self):
        session = FakeYoloSession([
            [320, 160, 256, 192, 0.90],
            [323, 163, 256, 192, 0.70],
            [320, 464, 256, 224, 0.85],
            *[[20, 20, 10, 10, 0.10] for _ in range(7)],
        ])
        image = Image.new("RGB", (100, 200), "white")

        boxes = detect_yolov8_boxes(session, image, 640, 0.25, 0.45)

        self.assertEqual(len(boxes), 2)
        self.assertAlmostEqual(boxes[0]["x"], 0.10, places=5)
        self.assertAlmostEqual(boxes[0]["y"], 0.10, places=5)
        self.assertAlmostEqual(boxes[1]["y"], 0.55, places=5)

    def test_comic_order_model_ranks_left_panel_before_right_panel(self):
        panels = [
            {"x": 0.05, "y": 0.05, "w": 0.4, "h": 0.4},
            {"x": 0.55, "y": 0.05, "w": 0.4, "h": 0.4},
        ]

        self.assertEqual(order_comic_panels(panels, FakeOrderSession()), [0, 1])


if __name__ == "__main__":
    unittest.main()
