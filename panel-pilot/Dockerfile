FROM node:22.21.1-alpine AS frontend-builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html login.html panel-test.html vite.config.js ./
COPY src ./src
COPY public ./public

ARG PANEL_PILOT_BUILD_ID=container
ENV PANEL_PILOT_BUILD_ID=${PANEL_PILOT_BUILD_ID}
RUN npm run build

FROM python:3.12-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/python3.12/site-packages/pip /usr/local/lib/python3.12/site-packages/pip-* /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12 \
    && groupadd --system --gid 10001 panels \
    && useradd --system --uid 10001 --gid panels --home-dir /nonexistent --shell /usr/sbin/nologin panels
ENV PANEL_PILOT_STATIC_ROOT=/app/web
ENV PANEL_PILOT_BIND_ADDRESS=0.0.0.0
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY --chown=panels:panels server.py ./server.py
COPY --chown=panels:panels comic_recommendations.py ./comic_recommendations.py
COPY --chown=panels:panels source_intelligence.py ./source_intelligence.py
COPY --chown=panels:panels books.py shelfmark_client.py opds_client.py ./
COPY --chown=panels:panels LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=panels:panels --from=frontend-builder /build/dist ./web

EXPOSE 8013
USER 10001:10001
CMD ["python", "server.py", "8013"]
