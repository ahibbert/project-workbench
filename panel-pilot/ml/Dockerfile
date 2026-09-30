FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY download_pretrained_model.py serve_manga_detector.py ./
RUN mkdir -p /models && python download_pretrained_model.py /models/manga-panel-detector.onnx

ENV MANGA_MODEL_PATH=/models/manga-panel-detector.onnx
EXPOSE 8091
CMD ["uvicorn", "serve_manga_detector:app", "--host", "0.0.0.0", "--port", "8091"]
