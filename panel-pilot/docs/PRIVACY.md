# Privacy and data flows

Panels is a self-hosted application. It does not include first-party analytics,
advertising, or telemetry. The operator controls the Panels server, its network,
logs, backups, and the external services described below.

## Data stored by Panels

Panels stores library state, reading progress, source identifiers, settings,
download-queue state, and detector results on the server. The browser can store
settings, a library snapshot, pending sync operations, application files, and
downloaded chapter pages. Browser storage and server data are not encrypted by
Panels; filesystem, device, browser-profile, and backup protections therefore
matter. Signing out ends server access but does not erase all browser storage.

Panels also keeps a private source-reliability profile so matching sources can
be ranked without probing every candidate repeatedly. It records a source ID
and label, operation type, success or failure, response time, inferred media
format, and aggregate timestamps. It does not record which title was searched,
chapter names or IDs, cover URLs, page URLs, or image contents in this profile.
The profile remains on the self-hosted Panels server and is not sent to an
analytics provider.

## Suwayomi

Suwayomi is the core content service. The browser sends same-origin requests to
Panels, and Panels relays the required library, search, chapter, page, progress,
and download operations to the operator-configured Suwayomi server. Suwayomi
credentials remain server-side. Panels and Suwayomi operators, reverse proxies,
and their logs can observe requested titles, chapters, and related metadata.
Chapter pages are stored on a device only when the user explicitly downloads
them there.

## MangaBaka

MangaBaka integration is optional and is not connected by default. When the
operator supplies a token, Panels sends it to MangaBaka and requests profile,
search, recommendation, and tracking data. After a title is matched, Panels can
automatically synchronize library state and chapter progress. The token and
sync metadata are stored unencrypted on the Panels server, while the browser
can retain pending sync operations and account-link metadata. An environment
token must be removed by the operator outside the app; logs and backups may
retain older data according to the operator's retention policy.

## Optional reading stats

Reading stats are off by default and begin prospectively only after a user
enables them. Panels can then record capped active-reading minutes, page views,
chapter finishes and rereads, titles marked complete, reading days, rhythm, and
achievements. The browser keeps a stable random device identifier and a durable
offline outbox. Before upload it converts server, title, and chapter references
to opaque SHA-256 keys; the server applies its own secret-keyed HMAC before
writing events to its SQLite database. Raw title names, cover URLs, content
URLs, device identifiers, and client IP addresses are not stored in the stats
tables.

The Panels server caps credited activity at 60 seconds per UTC minute across
devices and applies the selected timezone and day boundary when calculating
reading days. Stats are not sent to MangaBaka, Suwayomi, or an analytics
provider. Users can pause collection, export their stats, or permanently reset
them under **Settings → Reading stats**. A stats reset leaves the Suwayomi
library and reading progress unchanged. Browser storage, server database files,
logs, exports, and backups remain under the same operator and device protections
described elsewhere in this document.

## Development content adapters

The Comick adapter is an opt-in development and Test Lab feature. It runs only
after a user supplies a Comick URL or chooses a related control; Panels then
retrieves chapter metadata and pages from Comick and supported image CDNs. The
ReadComicOnline compatibility adapter is activated only when a user opens a
matching chapter supplied through their Suwayomi source. These services can
receive the Panels server's IP address, requested URLs, request metadata, and
the adapter's user-agent or referrer headers. Panels bundles no third-party
reading content. Operators are responsible for source terms and content rights.

## Optional panel detector

The browser detector processes chapter images locally. If the operator enables
the server-side detector, Panels sends image bytes from Suwayomi or a selected
adapter to that operator-controlled local service and caches normalized panel
metadata on the Panels server. Runtime inference does not require a hosted
inference provider. Building the optional detector image downloads a pinned
model from Hugging Face, so the build host contacts that service.

## Operator and user controls

Application, reverse-proxy, Suwayomi, and container logs may contain IP
addresses, request paths, and operational metadata. Treat logs, backups,
configuration, tokens, downloaded chapters, and browser profiles as sensitive.
Use Settings to inspect or remove device downloads and to disconnect optional
services. For a complete local reset, also clear the browser's site data and
remove the corresponding server data and backups under the operator's control.
