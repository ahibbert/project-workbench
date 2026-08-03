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

The Test Lab uses the same browser detector as the reader. It loads a chapter,
runs detection page by page, draws overlay boxes, and lets you enter expected
panel counts. Expected counts are stored in localStorage and can be exported as
JSON with the detection report.

Useful query parameters:

```text
panel-test.html?pages=3&autorun=1
panel-test.html?chapter=1&pages=10&autoload=1
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

## Current limitations

- Panel detection is local and heuristic-based. It works best on pages with
  visible gutters and rectangular panels.
- If Suwayomi image responses do not allow canvas access from this app's origin,
  the image will still display but detection may fall back to full-page mode.
  The clean fix is serving this PWA from the same origin as Suwayomi or adding a
  small same-origin proxy.
- The Comick test path is for local development only. It currently supports
  `comick.live` chapter lists and proxied image loading from Comick CDN URLs.
- Manual panel correction is not implemented yet.

## Next steps

- Add manual split, merge, reorder, and skip controls.
- Cache detected panel metadata in IndexedDB by chapter/page.
- Add direct MangaDex and Comick adapters as optional alternatives to Suwayomi.
- Package as an iOS-friendly standalone PWA or native wrapper.
