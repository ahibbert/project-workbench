# Panels

Panels is a self-hosted, mobile-first PWA for reading a Suwayomi library with
panel-by-panel guidance, device-local chapters, offline launch, and resumable
progress.

## Deploy with an existing Suwayomi

The supported self-hosted path uses Docker Compose. Copy `.env.example` to
`.env`, add strong Panels credentials and a random session secret, point
`SUWAYOMI_INTERNAL_URL` at the existing Suwayomi server, then build and start:

```sh
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose up -d
```

For network choices, HTTPS, verification, backups, and attaching to Suwayomi,
follow [the deployment guide](docs/DEPLOYMENT.md). Maintainers should use the
[release and rollback runbook](docs/RELEASING.md). Do not expose Panels before
reading the [security policy](SECURITY.md) and [privacy and data-flow notes](docs/PRIVACY.md).

## Run locally

Panels requires Node 22.12 or newer. Install the pinned frontend dependencies,
build the PWA, and then start the project server:

```sh
npm ci
npm run build
python server.py 8013
```

Then open:

```text
http://localhost:8013
```

Local execution binds to `127.0.0.1` by default. To test from a trusted phone
on the same Wi-Fi, set `PANEL_PILOT_BIND_ADDRESS=0.0.0.0` together with
`PANEL_PILOT_AUTH_USER`, `PANEL_PILOT_AUTH_PASSWORD`, and a random
`PANEL_PILOT_SESSION_SECRET` before starting the server. Keep it behind your
machine's firewall, then open the computer's LAN address and the same port,
for example:

```text
http://192.168.0.9:8013
```

LAN HTTP is useful for basic reader testing, but browsers do not treat it as a
secure context. Test installation, service workers, and offline chapters
through HTTPS (or on `localhost`).

Panels does not load third-party reading content on startup. For development,
the Test Lab can use a Comick URL entered manually through a same-origin
adapter. Use only sources and content that you are authorized to access.

For frontend development, run the Python backend with the explicit source-mode
opt-in, then start Vite in a second terminal. Vite proxies `/api`, `/login`, and
`/logout` to port 8013:

```powershell
$env:PANEL_PILOT_ALLOW_SOURCE_STATIC = "1"
py -3.12 server.py 8013
npm run dev
```

Production always serves the generated `dist` directory. Override it with
`PANEL_PILOT_STATIC_ROOT` only when the built files live elsewhere.

Run the reproducible-build, artifact-contract, and Chromium smoke suites with:

```sh
npm test
```

## Install and update

Open **Settings → App** to manage the PWA on the current device. Browsers that
support a programmatic install prompt show an **Install Panels** button.
On iPhone and iPad, open Panels in Safari, choose **Share → Add to Home
Screen**, and then tap **Add**.

Panels checks for application updates without interrupting the reader. A
waiting update appears both in Settings and in the global **Update ready**
control. Applying it is always explicit: Panels first persists the current
reading position and sync outboxes, activates the waiting worker, and reloads
once. **Check for updates** performs an on-demand check; a failed check does not
prevent online reading.

After one successful online load, the installed app can reopen its application
shell and locally saved library while offline. Suwayomi chapter rows provide a
per-chapter control to save a complete chapter to the current device. Saved
chapters remain readable offline and can be inspected or removed under
**Settings → Device storage**. These device copies are separate from the
server-side Suwayomi download buffer and do not follow the user to another
device.

The global connection banner shows when the device is offline, reconnecting,
restored, or online while the configured Suwayomi server is unavailable. API
responses, sign-in and sign-out, Test Lab, and chapter media that were not
explicitly saved to the device are never served from the application-shell
fallback.

## Private reading stats

The **Stats** tab can build a prospective, private reading history with active
reading time, pages, finished and reread chapters, reading days, completed
titles, rhythm, and achievements. Tracking is off by default and cannot
reconstruct activity from before it was enabled. Activity queues on the device
while offline and syncs to the self-hosted Panels server; it is never sent to a
third-party analytics service.

Under **Settings → Reading stats**, users can pause collection, hide totals or
rhythm, disable milestone celebrations, export their data, or permanently
reset stats. Resetting stats does not alter the Suwayomi library or reading
progress. See the [privacy and data-flow notes](docs/PRIVACY.md) for storage
details.

### Apple platform support

The supported baseline is iOS/iPadOS 16.4 for Home Screen installation and
the core online/offline reader. Some optional browser capabilities have a
higher platform floor:

- Screen Wake Lock works inside an installed Home Screen app on iOS/iPadOS
  18.4 or newer. On 16.4–18.3, Panels reports that wake lock is unavailable
  and keeps the reader usable without it.
- Full origin-usage estimates and persistent-storage protection require
  iOS/iPadOS 17 or newer. On 16.4, chapter totals and device downloads still
  work, but retention is best-effort and the operating system may evict them.
- Lockdown Mode disables Service Workers and Cache Storage on affected Safari
  versions. Panels remains usable online, but the offline shell and
  device-local chapters cannot work while those platform features are
  disabled.

These limits come from WebKit rather than the Panels server. See WebKit's
[Safari 18.4 feature notes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/),
[storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/), and
[Safari 16.4 feature notes](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/).

The offline shell is intended for a trusted browser profile: locally stored
library metadata, settings, and downloaded chapters are not encrypted and can
be displayed without a fresh server session check. Server data and actions
still require online authentication.

Panel view fits the active panel crop into the reader by both width and height.
Use the `Padding` slider to choose how much context is shown around each panel.
When you advance past the final panel of a Comick chapter, the reader attempts
to load the next numbered chapter automatically.

Comick chapter lists load 60 entries at a time. Use `Show more` for older
chapters, or enter a chapter number directly with `Load number`.

## Detection Test Lab

Open the test harness at:

```text
http://localhost:8013/panel-test.html
```

The Test Lab uses the same detector path as the reader. It can load a Suwayomi
library chapter by manga/chapter ID or a manually supplied Comick URL, runs
detection page by page, draws overlay boxes, flags risky overlapping crops, and
lets you enter expected panel counts. Expected counts are stored in
localStorage and can be exported as JSON with the detection report.

Useful query parameters:

```text
panel-test.html?pages=3&autorun=1
panel-test.html?chapter=1&pages=10&autoload=1
panel-test.html?source=suwayomi&mangaId=<manga-id>&chapterId=<chapter-id>&autorun=1
```

## Suwayomi flow

1. Start Suwayomi Server, usually at `http://localhost:4567`.
2. Open Panels and keep the server URL set to that address.
3. Click `Test`.
4. Click `Sources` to load installed source extensions.
5. Search a source, choose a manga, fetch chapters, then read a chapter.

The browser talks to Suwayomi through Panels' local
`/api/suwayomi/graphql` proxy. This matters on a phone: `localhost:4567` means
the PC from the server's point of view, not the phone. The integration uses the
same core operations used by the official WebUI:

- `sources`
- `fetchSourceManga`
- `fetchChapters`
- `fetchChapterPages`

Panels also writes page progress and completed chapters back to Suwayomi.
It refreshes Suwayomi's library on startup and marks a manga as in-library when
you start reading it, so Suwayomi-backed titles use one shared library across
Panels and Tachimanga.
While reading, it asks a persistent Panels server queue to keep the current
and next 10 chapters downloaded in Suwayomi. Resume opens the saved chapter and
page before refreshing the full chapter list, upcoming pages receive a six-page
preparation lead, and next-chapter work waits until that lead is ready. Manga
images are fetched for model inference directly between the Panels and
Suwayomi servers rather than being uploaded again by the phone. The server
downloads one chapter at a time, independently backs off failed chapters, and
moves repeatedly failing work aside so one source cannot stall the queue; it
keeps working after the PWA closes or the server restarts. Progress updates use
a durable browser outbox and model results are cached for repeat visits.
Titles in **Plan to read** also queue their earliest 10 chapters at background
priority; active reading always takes precedence. These are Suwayomi server
downloads, not copies stored on every Panels device.
To share that progress with Tachimanga, enable **Enhanced Tracking → Suwayomi**
in Tachimanga. Tachimanga can then use MangaBaka as a regular tracker; connect
MangaBaka in Tachimanga's Tracking settings. Panels' Settings page has a
manual sync button, and progress is also sent automatically while reading.

Enhanced Tracking only applies to entries opened through Tachimanga's Suwayomi
extension. Existing entries from other Tachimanga extensions need a one-time
source migration (or a backup-assisted migration) before they can share this
progress path.

## Sign in

When `PANEL_PILOT_AUTH_USER` and `PANEL_PILOT_AUTH_PASSWORD` are set, Panels
shows an HTML sign-in page instead of a browser Basic Auth dialog. The
form uses standard `username` and `current-password` autocomplete fields so
password managers can fill it. Sessions last 30 days by default.

For a stable session signing key across password changes or multiple replicas,
set `PANEL_PILOT_SESSION_SECRET` to a long random value. You can optionally set
`PANEL_PILOT_SESSION_MAX_AGE` in seconds. TLS remains the responsibility of the
reverse proxy; do not add a second Basic Auth gate in front of Panels.

## Manga panel model

The supplied Compose stack can optionally build a private CPU-only ONNX service
for manga panel detection. It is used only in manga mode; comic and webtoon
behavior is unchanged. The service downloads a checksum-pinned 10 MB model
during its image build. The default deployment does not enable this profile;
Panels uses the local browser detector unless the operator opts in. If an
enabled service becomes unavailable, reading falls back to that browser
detector.

The model and its Manga109-s training-data attribution are documented in
[`ml/MODEL-NOTICE.md`](ml/MODEL-NOTICE.md). Because the weights are AGPL-3.0,
keep the corresponding Panels source available to anyone using the hosted
service.

## Current limitations

- Manga detection uses a pretrained model with a browser fallback. Covers,
  title cards, and splash pages with no detected panels open as full pages.
- If Suwayomi image responses do not allow canvas access from this app's origin,
  the image will still display but detection may fall back to full-page mode.
  The clean fix is serving this PWA from the same origin as Suwayomi or adding a
  small same-origin proxy.
- The opt-in Comick test path is for local development only. It accepts a
  manually supplied `comick.live` URL and proxies image loading from supported
  Comick CDN URLs.
- Manual panel correction is not implemented yet.
- The optional trained detector is currently manga-only. Comic and webtoon
  models will remain separate rather than sharing manga weights and thresholds.

## License

Panels is licensed under the [GNU Affero General Public License v3.0](LICENSE).
Copyright © 2026 Panels contributors.
The optional manga detector uses separately distributed AGPL-3.0 weights and
has additional attribution in [`ml/MODEL-NOTICE.md`](ml/MODEL-NOTICE.md).
Manga, source extensions, Suwayomi, and third-party service data are not part
of this license or distributed by Panels.
Notices for code included in the generated PWA are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
