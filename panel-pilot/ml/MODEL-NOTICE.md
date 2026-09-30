# Manga panel model notice

Panel Pilot's optional manga detector uses the `leoxs22/manga-panel-detector-yolo26n`
weights via the ONNX export published by `mednasserallah`. The upstream weights are
licensed AGPL-3.0 and were trained on Manga109-s. The model is downloaded during the
detector image build and is not committed to this repository.

- Model: https://huggingface.co/leoxs22/manga-panel-detector-yolo26n
- ONNX export: https://huggingface.co/mednasserallah/manga-panel-detector-yolo26n-onnx
- Dataset terms: https://huggingface.co/datasets/hal-utokyo/Manga109-s

Do not redistribute Manga109-s images or annotations with Panel Pilot.
