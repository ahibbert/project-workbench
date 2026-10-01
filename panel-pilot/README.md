# Panels

A static PWA prototype for a Suwayomi-backed manga reader with panel-by-panel
guided reading.

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

From a phone on the same Wi-Fi, open the computer's LAN address and the same
port, for example:

```text
http://192.168.0.9:8013
```

The app loads Frieren chapter 1 from Comick on startup, so the panel reader can
be tested against real pages without a running Suwayomi server. The custom
server also exposes a small same-origin Comick test proxy for that flow.

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
shell and locally saved library while offline. The global connection banner
shows when the device is offline, reconnecting, restored, or online while the
configured Suwayomi server is unavailable. API responses, sign-in and sign-out,
Test Lab, and chapter media are never served from this shell fallback.

The offline shell is intended for a trusted browser profile: locally stored
library metadata and settings are not encrypted and can be displayed without a
fresh server session check. Server data and actions still require online
authentication. Device-local chapter reading is introduced separately and is
not part of the current offline shell.

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

The Test Lab uses the same detector path as the reader. It can load a
Suwayomi library chapter by manga/chapter ID or a Comick chapter, runs detection
page by page, draws overlay boxes, flags risky overlapping crops, and lets you
enter expected panel counts. Expected counts are stored in localStorage and can
be exported as JSON with the detection report.

Useful query parameters:

```text
panel-test.html?pages=3&autorun=1
panel-test.html?chapter=1&pages=10&autoload=1
panel-test.html?source=suwayomi&mangaId=1916&chapterId=4016&autorun=1
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
To share that progress with Tachimanga, enable **Enhanced Tracking → Suwayomi**
in Tachimanga. Tachimanga can then use MangaBaka as a regular tracker; connect
MangaBaka in Tachimanga's Tracking settings. Panels' Settings page has a
manual sync button, and progress is also sent automatically while reading.

Enhanced Tracking only applies to entries opened through Tachimanga's Suwayomi
extension. Existing entries from other Tachimanga extensions need a one-time
source migration (or a backup-assisted migration) before they can share this
progress path.

## Sign in

When `PANEL_PILOT_AUTH_USER` and `PANEL_PILOT_AUTH_PASSWORD` are set, Panel
Pilot shows an HTML sign-in page instead of a browser Basic Auth dialog. The
form uses standard `username` and `current-password` autocomplete fields so
password managers can fill it. Sessions last 30 days by default.

For a stable session signing key across password changes or multiple replicas,
set `PANEL_PILOT_SESSION_SECRET` to a long random value. You can optionally set
`PANEL_PILOT_SESSION_MAX_AGE` in seconds. TLS remains the responsibility of the
reverse proxy; do not add a second Basic Auth gate in front of Panels.

## Manga panel model

The production compose stack includes a private CPU-only ONNX service for manga
panel detection. It is used only in manga mode; comic and webtoon behavior is
unchanged. The service downloads a checksum-pinned 10 MB model during its image
build. If the service is unavailable, Panels automatically uses the local
browser detector, so reading still works.

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
- The Comick test path is for local development only. It currently supports
  `comick.live` chapter lists and proxied image loading from Comick CDN URLs.
- Manual panel correction is not implemented yet.
- The optional trained detector is currently manga-only. Comic and webtoon
  models will remain separate rather than sharing manga weights and thresholds.

## Next steps

- Follow the [panel performance and Tachimanga migration plan](PERFORMANCE_AND_SYNC_PLAN.md).
- Add manual split, merge, reorder, and skip controls.
- Add direct MangaDex and Comick adapters as optional alternatives to Suwayomi.
- Package as an iOS-friendly standalone PWA or native wrapper.
