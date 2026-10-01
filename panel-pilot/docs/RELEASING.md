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
python tools/test_server_security.py
python tools/test_server_state.py
python tools/test_manga_detector.py
python tools/test_download_buffer.py
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

For the real-device gate, keep iOS/iPadOS 16.4 as the core install and reader
floor, but judge optional platform features against their actual WebKit floor:

- On an installed Home Screen app, successful Screen Wake Lock acquisition is
  required only on iOS/iPadOS 18.4 or newer. On 16.4–18.3, verify the truthful
  unavailable fallback and uninterrupted reading instead.
- Full storage estimates and persistent-storage protection are required only
  on iOS/iPadOS 17 or newer. On 16.4, verify chapter totals, best-effort
  downloads, eviction detection, and repair behavior.
- Lockdown Mode disables Service Workers and Cache Storage on affected Safari
  versions, so offline installation behavior is not an achievable acceptance
  criterion while Lockdown Mode is enabled.

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

## 6. Publish the source release

Complete this checklist before making the release public. It is intentionally
separate from deployment: a healthy private instance does not prove that the
source package is safe or understandable for another operator.

- [ ] Decide the permanent repository URL and default branch. Confirm the
  repository, issue, and homepage links in `package.json` and this documentation
  resolve after publication.
- [ ] Merge the reviewed release commit to the public default branch with a
  clean worktree. Do not publish from an unreviewed feature branch.
- [ ] Confirm `.env`, `data/`, backups, logs, detector caches, test output,
  browser profiles, Python bytecode, and private deployment files are neither
  tracked nor present anywhere in the commits being published.
- [ ] Run a secret scanner over the complete history to be published, not only
  the current checkout. Rotate any credential that ever entered Git history
  before publication; deleting the current file is insufficient.
- [ ] Verify that `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`,
  `.env.example`, `compose.yaml`, and `deploy/Caddyfile.example` are present and
  contain no instance-specific domains, IP addresses, usernames, or paths.
- [ ] Review `ml/MODEL-NOTICE.md` and the upstream model/dataset terms. Do not
  attach model weights or Manga109-s material to the source release. If a
  detector container is distributed, satisfy the additional source and notice
  obligations described in the deployment guide.
- [ ] Run all tests in section 1 from a fresh clone, then follow
  `docs/DEPLOYMENT.md` on a clean host using only the published files. Verify
  login, HTTPS installation, Suwayomi connectivity, a chapter read, a
  device-local chapter, and explicit PWA update activation.
- [ ] Run `npm audit` and review the Docker build's OS and Python dependency
  scan. Record accepted findings and versions; do not imply that a zero-count
  npm result scans the Python or container layers.
- [ ] Enable GitHub private vulnerability reporting, add an issue template or
  clearly documented support path, and verify the security contact described
  in `SECURITY.md` is usable without exposing a private address.
- [ ] Create signed or annotated tag `v0.x.y` at the verified commit. Publish
  release notes containing the commit, image digest if an image is distributed,
  upgrade/rollback notes, known limitations, and the detector's opt-in status.
- [ ] Recheck the release archive itself before publishing it. GitHub-generated
  source archives should contain the source and notices, not local build output
  or operator data.

For the first public release, keep the previous private image and backup until
the public build has also passed a real iPhone/iPad install, update, offline
chapter, and cross-device progress test. Publication is complete only when a
new operator can reproduce the deployment without access to the maintainer's
private Compose files or environment.
