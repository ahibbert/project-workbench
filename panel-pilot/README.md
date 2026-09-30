# Panel Pilot

A static PWA prototype for a Suwayomi-backed manga reader with panel-by-panel
guided reading.

## Run locally

Use the project server when testing real Comick chapters:

```sh
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
2. Open Panel Pilot and keep the server URL set to that address.
3. Click `Test`.
4. Click `Sources` to load installed source extensions.
5. Search a source, choose a manga, fetch chapters, then read a chapter.

The browser talks to Suwayomi through Panel Pilot's local
`/api/suwayomi/graphql` proxy. This matters on a phone: `localhost:4567` means
the PC from the server's point of view, not the phone. The integration uses the
same core operations used by the official WebUI:

- `sources`
- `fetchSourceManga`
- `fetchChapters`
- `fetchChapterPages`

Panel Pilot also writes page progress and completed chapters back to Suwayomi.
It refreshes Suwayomi's library on startup and marks a manga as in-library when
you start reading it, so Suwayomi-backed titles use one shared library across
Panel Pilot and Tachimanga.
While reading, it prepares upcoming pages in parallel and preloads the next
Suwayomi chapter. Chapter-page requests and image loads use bounded retries,
and manga model results are cached on the Panel Pilot server so revisiting a
page does not rerun the model.
To share that progress with Tachimanga, enable **Enhanced Tracking → Suwayomi**
in Tachimanga. Tachimanga can then use MangaBaka as a regular tracker; connect
MangaBaka in Tachimanga's Tracking settings. Panel Pilot's Settings page has a
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
reverse proxy; do not add a second Basic Auth gate in front of Panel Pilot.

## Manga panel model

The production compose stack includes a private CPU-only ONNX service for manga
panel detection. It is used only in manga mode; comic and webtoon behavior is
unchanged. The service downloads a checksum-pinned 10 MB model during its image
build. If the service is unavailable, Panel Pilot automatically uses the local
browser detector, so reading still works.

The model and its Manga109-s training-data attribution are documented in
[`ml/MODEL-NOTICE.md`](ml/MODEL-NOTICE.md). Because the weights are AGPL-3.0,
keep the corresponding Panel Pilot source available to anyone using the hosted
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
