FROM python:3.12-slim

WORKDIR /app
RUN groupadd --system --gid 10001 panels-detector \
    && useradd --system --uid 10001 --gid panels-detector --home-dir /nonexistent --shell /usr/sbin/nologin panels-detector
COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ml/download_pretrained_model.py ml/serve_manga_detector.py ./
RUN mkdir -p /models && python download_pretrained_model.py \
    /models/manga-panel-detector.onnx \
    /models/speech-bubble-detector.onnx \
    /models/comic-panel-detector.onnx \
    /models/comic-panel-order.onnx
RUN python -m pip uninstall -y pip setuptools wheel

COPY LICENSE /usr/share/doc/panels-manga-detector/AGPL-3.0.txt
COPY ml/MODEL-NOTICE.md /usr/share/doc/panels-manga-detector/MODEL-NOTICE.md
RUN test -s /usr/share/doc/panels-manga-detector/AGPL-3.0.txt \
    && test -s /usr/share/doc/panels-manga-detector/MODEL-NOTICE.md

ENV MANGA_MODEL_PATH=/models/manga-panel-detector.onnx
ENV BUBBLE_MODEL_PATH=/models/speech-bubble-detector.onnx
ENV COMIC_MODEL_PATH=/models/comic-panel-detector.onnx
ENV COMIC_ORDER_MODEL_PATH=/models/comic-panel-order.onnx
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
EXPOSE 8091
USER 10001:10001
CMD ["uvicorn", "serve_manga_detector:app", "--host", "0.0.0.0", "--port", "8091"]
