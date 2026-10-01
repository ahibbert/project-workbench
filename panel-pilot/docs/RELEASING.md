# Build, release, and rollback

This runbook keeps the source version, frontend build, container tag, and
rollback artifact identifiable. It does not publish an image or release by
itself.

## 1. Prepare and test

Use Node 22.12 or newer and Python 3.12. `package.json` is the single
application-version source.

```sh
npm version --no-git-tag-version 0.x.y
npm ci
npm test
python tools/test_server_static.py
python tools/test_server_state.py
python tools/test_manga_detector.py
```

Review the version-only changes to both `package.json` and `package-lock.json`.
Do not manually edit version strings in HTML, JavaScript, the manifest, or the
service worker.

Commit the reviewed release source and require a clean worktree before the
container build. For an identifiable, reproducible frontend build, set
`PANELS_BUILD_ID` to that full Git commit. The frontend build deliberately
contains no wall-clock timestamp.

```sh
git diff --check
git status --short
git rev-parse HEAD
```

## 2. Build and inspect the candidate

Set these values in `.env` before building:

```text
PANELS_IMAGE_TAG=0.x.y
PANELS_BUILD_ID=<full-git-commit>
```

Then build without replacing the running container:

```sh
docker compose build --pull
docker image inspect panels:0.x.y
```

Record the resolved base-image and optional detector-image IDs with the
release. The Docker base images and detector Python dependency ranges are not
yet digest/lockfile pinned, so the complete container build is not guaranteed
to be byte-for-byte reproducible at a later date.

The Panels runtime image must contain only the Python server, generated web
assets, and license notices (plus its mounted data directory at runtime). It
must not contain `src`, tests, package metadata, or the Node dependency tree:

```sh
docker run --rm --entrypoint python panels:0.x.y -c \
  "import os; print(sorted(os.listdir('/app')))"
```

Expected entries are `LICENSE`, `THIRD_PARTY_NOTICES.md`, `server.py`, and
`web`.

## 3. Capture rollback state

Identify and retain the exact image currently serving Panels:

```sh
mkdir -p backups
current_image="$(docker inspect --format '{{.Image}}' "$(docker compose ps -q panels)")"
rollback_tag="rollback-$(date -u +%Y%m%dT%H%M%SZ)"
docker image tag "$current_image" "panels:$rollback_tag"
```

Pause writes while copying server state:

```sh
docker compose stop panels
tar -czf "backups/panels-data-$rollback_tag.tar.gz" -C data panels
sha256sum "backups/panels-data-$rollback_tag.tar.gz" > \
  "backups/panels-data-$rollback_tag.tar.gz.sha256"
docker compose start panels
```

Store the rollback tag, source commit, image ID, backup checksum, and release
version together. Treat the archive as sensitive because it can include a
MangaBaka token and reading history.

## 4. Roll out and verify

With `PANELS_IMAGE_TAG` still set to the candidate tag in `.env`:

```sh
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 panels
```

Verify through the public HTTPS origin:

1. An unauthenticated request redirects to `/login`.
2. Sign-in succeeds and a reload keeps the session.
3. Library, Browse, Settings, and Test Lab load without console errors.
4. Suwayomi connection, source loading, chapter pages, and progress updates
   succeed.
5. The manifest and service worker load, and the update waits for explicit
   activation instead of interrupting the reader.
6. `/server.py`, `/data/`, `/package.json`, and `/src/` return 404.
7. Container restart count is stable and `data/panels` is mounted at
   `/app/data`.

Retain the prior image and data archive until this verification and a real
device install/update test have passed.

## 5. Roll back

Set `PANELS_IMAGE_TAG` in `.env` to the recorded rollback tag, then restore the
old image without rebuilding:

```sh
docker compose up -d --no-build panels
docker compose ps
docker compose logs --tail=100 panels
```

Normally, roll back only the image; current reading progress should be kept.
Restore the data archive only when the release changed persistent data
incompatibly or corrupted it. A data restore discards progress written after
the backup:

```sh
docker compose stop panels
mv data/panels "data/panels.failed-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p data
tar -xzf backups/panels-data-<rollback-tag>.tar.gz -C data
docker compose up -d --no-build panels
```

Re-run the public verification checklist after rollback. Keep the failed data
directory until its state has been inspected or recovered.
