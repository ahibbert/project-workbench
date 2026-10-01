FROM python:3.12-slim

WORKDIR /app
COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ml/download_pretrained_model.py ml/serve_manga_detector.py ./
RUN mkdir -p /models && python download_pretrained_model.py /models/manga-panel-detector.onnx

COPY LICENSE /usr/share/doc/panels-manga-detector/AGPL-3.0.txt
COPY ml/MODEL-NOTICE.md /usr/share/doc/panels-manga-detector/MODEL-NOTICE.md
RUN test -s /usr/share/doc/panels-manga-detector/AGPL-3.0.txt \
    && test -s /usr/share/doc/panels-manga-detector/MODEL-NOTICE.md

ENV MANGA_MODEL_PATH=/models/manga-panel-detector.onnx
EXPOSE 8091
CMD ["uvicorn", "serve_manga_detector:app", "--host", "0.0.0.0", "--port", "8091"]
