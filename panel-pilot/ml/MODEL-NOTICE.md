# Manga panel model notice

Panels' optional manga detector uses the `leoxs22/manga-panel-detector-yolo26n`
weights via the ONNX export published by `mednasserallah`. The upstream weights are
licensed AGPL-3.0 and were trained on Manga109-s. The model is downloaded during the
detector image build and is not committed to this repository.

The detector image includes this notice and the AGPL-3.0 license text under
`/usr/share/doc/panels-manga-detector/` so the applicable terms and attribution
travel with the embedded weights.

The ONNX conversion repository currently labels its export Apache-2.0. The
upstream model author subsequently corrected the original weights to
AGPL-3.0, explaining that the earlier Apache label was not valid because the
weights are derived from Ultralytics' AGPL-3.0 model. Panels therefore treats
the unchanged ONNX conversion as AGPL-3.0 rather than relying on the
converter's stale metadata.

- Model: https://huggingface.co/leoxs22/manga-panel-detector-yolo26n
- ONNX export: https://huggingface.co/mednasserallah/manga-panel-detector-yolo26n-onnx
- Dataset terms: https://huggingface.co/datasets/hal-utokyo/Manga109-s

Do not redistribute Manga109-s images or annotations with Panels.
