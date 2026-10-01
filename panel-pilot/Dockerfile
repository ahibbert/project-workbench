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
ENV PANEL_PILOT_STATIC_ROOT=/app/web
ENV PANEL_PILOT_BIND_ADDRESS=0.0.0.0

COPY server.py ./server.py
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY --from=frontend-builder /build/dist ./web

EXPOSE 8013
CMD ["python", "server.py", "8013"]
