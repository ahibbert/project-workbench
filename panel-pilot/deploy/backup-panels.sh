#!/usr/bin/env sh
# Create a consistent, stopped-state Panels backup. Run on the Docker host.
set -eu

stack_dir=${1:-/opt/manga-stack}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$stack_dir/backups"
archive="$backup_dir/panels-data-$stamp.tar.gz"

test -f "$stack_dir/docker-compose.yml"
mkdir -p "$backup_dir"
cd "$stack_dir"

docker compose stop panel-pilot
trap 'docker compose start panel-pilot >/dev/null 2>&1 || true' EXIT INT TERM
tar -czf "$archive" -C "$stack_dir/data" panel-pilot books/cwa-config books/cwa-library
sha256sum "$archive" > "$archive.sha256"
docker compose start panel-pilot
trap - EXIT INT TERM
printf '%s\n' "$archive"
