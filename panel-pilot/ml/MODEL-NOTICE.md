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

## Speech-bubble detector

Bubble-aware panel framing uses the `bubble_detector.onnx` artifact from
`Remidesbois/Poneglyph-ReaderNet`. The artifact is an AGPL-3.0 YOLO26n export
and is downloaded from a pinned revision during the detector image build. It
is not committed to this repository.

- Model: https://huggingface.co/Remidesbois/Poneglyph-ReaderNet
- Pinned revision: `d97d4cd2903a7ebe49276a5269c4f3b7df608be7`
- SHA-256: `fa28ece56ba9e5ccf4361fbb4d2533e088906b0a0d1cd187c02422ba7d6f5688`

## Western-comic panel and reading-order models

Comic mode uses the `best.onnx` YOLOv8-n panel detector and
`panel-order-model.onnx` pairwise ordering model from
`cedarrapidsboy/inkwell-panel-models`. Both files are downloaded from pinned
revision `fa7afba52ba7dc7b0840c7702b767972b5e17a9b` during the detector image
build and are not committed to this repository.

The detector weights are AGPL-3.0 because they derive from Ultralytics YOLOv8.
The ordering model is MIT-licensed and was trained from scratch over geometric
features. Panels itself is AGPL-3.0 and includes the corresponding source.

- Model: https://huggingface.co/cedarrapidsboy/inkwell-panel-models
- Detector SHA-256: `f240e1296efd048126b26ea4ffeddc97d7c3aa667a37e3127c2afc6d5e9b9578`
- Ordering SHA-256: `84eb78fc5ec31a3e986a7a16ce10f7baa657ef5c5b4a98877b40aa9354ff3464`
