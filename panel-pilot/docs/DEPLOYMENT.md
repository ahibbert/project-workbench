# Deploying Panels with Suwayomi

Panels is a self-hosted PWA. Its Python server serves the built frontend and
proxies authenticated requests to an existing Suwayomi server. The browser
never needs direct network access to Suwayomi.

## Prerequisites

- Docker Engine with Docker Compose v2
- A running Suwayomi Server whose port 4567 is reachable from the Panels
  container
- A domain with HTTPS for installation as a PWA on phones and tablets

Panels is intended for a trusted individual or household, not as a public
multi-tenant service. Read [SECURITY.md](../SECURITY.md) before exposing it to
a network.

## Configure

Clone the standalone source repository and enter it:

```sh
git clone https://github.com/ahibbert/panels.git
cd panels
```

Create the local configuration:

```sh
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `PANEL_PILOT_SESSION_SECRET`, then set a long,
unique `PANEL_PILOT_AUTH_PASSWORD` in `.env`. Both are intentionally blank in
the example, and Compose refuses to start until they are set. Keep `.env`
private; it is ignored by Git. Leave both `SUWAYOMI_AUTH_*` values empty unless
the Suwayomi server uses Basic Auth; when it does, set both values.
The recommended 64-character hexadecimal session secret is decoded as 32
random bytes; older literal-hex and password-derived sessions are accepted
during migration so an ordinary upgrade does not sign users out.

The important Suwayomi setting is `SUWAYOMI_INTERNAL_URL`. It is resolved by
the Panels container, not by the phone:

- If Suwayomi publishes port 4567 on the Docker host, keep
  `http://host.docker.internal:4567`. The supplied Compose file maps that name
  to Docker's host gateway on Linux.
- If Suwayomi is on another reachable machine, use its private HTTP or HTTPS
  URL.
- If both services share an external Docker network, attach `panels` to that
  network with a Compose override and use the Suwayomi service name, such as
  `http://suwayomi:4567`.

Set `SUWAYOMI_AUTH_USER` and `SUWAYOMI_AUTH_PASSWORD` when Suwayomi uses Basic
Auth. These credentials stay on the Panels server and are not sent to the
browser.

`MANGABAKA_API_KEY` is optional. A token entered later in Panels Settings is
stored in `data/panels/mangabaka-config.json` with restricted file permissions.

## Start and verify

Validate the rendered Compose configuration before building. This catches
unset required values without displaying them:

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 panels
```

Open `http://127.0.0.1:8013` on the Docker host. A request without a session
should redirect to `/login`; sign in with the Panels credentials, then use
**Settings → Suwayomi → Test connection** and **Load sources**.

Panels uses its built-in browser detector by default. To enable the optional
server-side manga panel, speech-bubble, and Western-comic detectors, uncomment `COMPOSE_PROFILES` and
`PANEL_PILOT_MANGA_DETECTOR_URL` in `.env`, then run `docker compose up -d`
again. The detector stays private to the Compose network, and its model is
downloaded from the checksum-pinned location documented in
[`ml/MODEL-NOTICE.md`](../ml/MODEL-NOTICE.md). If it becomes unavailable,
Panels falls back to the browser detector. Bubble-aware framing is an optional
camera refinement: if the bubble model is unavailable, ordinary panel framing
continues unchanged.

## Put HTTPS in front

Keep the published Panels port on `127.0.0.1` and terminate TLS in a reverse
proxy. Installed PWAs and service workers require a secure context outside
localhost. Caddy running directly on the Docker host can use
[`deploy/Caddyfile.example`](../deploy/Caddyfile.example):

```sh
PANELS_DOMAIN=panels.example.com PANELS_PORT=8013 caddy run --config deploy/Caddyfile.example
```

Caddy automatically forwards the original scheme, allowing Panels to mark its
session cookie `Secure`. If the reverse proxy itself runs in Docker, attach it
to the same network and proxy to `panels:8013` rather than host loopback.

Validate the example before the first start, and reload Caddy after subsequent
configuration changes:

```sh
PANELS_DOMAIN=panels.example.com PANELS_PORT=8013 caddy validate --config deploy/Caddyfile.example
PANELS_DOMAIN=panels.example.com PANELS_PORT=8013 caddy reload --config deploy/Caddyfile.example
```

Do not add a second authentication prompt at the reverse proxy: it interferes
with the app's login, service-worker update, and API flows. Use Panels' own
authentication and a long, unique password. Restrict direct access to port
8013: the application trusts `X-Forwarded-Proto` from the reverse proxy when
deciding whether its session cookie is secure.

## Persistent and device-local data

Server state is under `data/panels`:

- `library.json` — the Panels library and resumable reading state
- `download-buffer.json` — Suwayomi server-download queue
- `source-profiles.json` — aggregate source reliability and latency history
- `panel-reports/` and `detector-cache/` — detector output and cache
- `mangabaka-config.json` — optional MangaBaka credential

Back up this directory as sensitive data. Device-local chapter downloads,
browser settings, pending browser outboxes, and the offline shell live in each
browser profile and are not contained in the server backup or synchronized to
another device.

The project does not bundle manga, Suwayomi extensions, or MangaBaka data.
Operators are responsible for the licenses and terms of the sources they add.

## Upgrade

Follow the tested build, backup, rollout, and rollback sequence in
[`RELEASING.md`](RELEASING.md). After a server upgrade, an installed PWA keeps
the current worker until the reader chooses **Update ready → Apply update**;
this preserves the active reading position and queued progress first.

## Optional detector distribution

Enabling the `manga-detector` profile builds an image that downloads and embeds
third-party AGPL-3.0 model weights. Review and retain
[`ml/MODEL-NOTICE.md`](../ml/MODEL-NOTICE.md) with any distribution of that
image, preserve the upstream attribution for both manga and comic models, and make the corresponding source
for the detector image and your modifications available as required by the
applicable license. The Manga109-s dataset itself is not distributed by this
project and must not be added to the image or release artifacts.
