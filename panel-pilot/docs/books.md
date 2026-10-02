# EPUB books (Shelfmark and Calibre-Web Automated)

EPUB support is an optional, isolated subsystem. It is disabled by default and
does not change the Suwayomi library, chapter data, manga progress, or reader.

## Architecture

1. Panels sends authenticated JSON API requests to a user-operated Shelfmark
   instance. Its API key never reaches the browser.
2. Shelfmark places completed EPUB downloads in the shared ingest volume.
3. Calibre-Web Automated (CWA) imports them into its Calibre library and exposes
   the resulting catalog through authenticated OPDS.
4. Panels indexes OPDS metadata and proxies covers and EPUB files. Panels owns
   reading position and reader preferences in `books.sqlite3`.

Before an EPUB reaches the browser, Panels validates its ZIP structure and
expanded size, rejects encrypted/path-traversal entries, strips scripts and
active embedded content, removes remote resource references, and injects a
restrictive document CSP. The reader uses a sandboxed epub.js rendition with
scripted content disabled. The downloaded sanitized EPUB is cached separately
from CWA and addressed only through an authenticated same-origin Panels route.

Reading progress is stored as an exact EPUB CFI plus its resource href and an
optional display percentage. Revisions prevent silent cross-device overwrites.
Theme, typography, line spacing, alignment, content width, and page/scroll flow
preferences are stored in the book database rather than browser storage.

Books use the shared Panels shell without sharing manga data models: EPUBs
appear in the main Library and Continue Reading card, acquisition starts from
**Browse → Find books**, service checks and manual sync live in Settings, and
the Stats view shows a separate EPUB shelf summary. Book details and reader
routes remain isolated internally so a CWA or Shelfmark outage cannot disturb
Suwayomi startup, browsing, or reading.

The reader generates stable EPUB locations in the browser for its scrubber and
approximate time remaining, while the server continues to store an exact CFI as
the canonical position. Side taps, horizontal swipes, arrow/Page keys, and the
visible previous/next controls navigate; a centre tap hides or restores reader
chrome. Rotation preserves the current CFI, internal links and footnotes stay
inside the sanitized publication, and an available browser wake lock keeps the
screen on while the reader is open.

Shelfmark is only an acquisition provider. Panels does not install or configure
Shelfmark download sources and does not handle DRM-protected files.

## Configuration

The canonical Compose file pins Shelfmark `v1.4.0` and CWA `V4.0.8`. Copy
`.env.example` to `.env`, then set:

```dotenv
COMPOSE_PROFILES=books
BOOKS_ENABLED=true
SHELFMARK_BASE_URL=http://shelfmark:8084
SHELFMARK_API_KEY=<a separate random secret>
CWA_OPDS_URL=http://calibre-web-automated:8083/opds
CWA_USERNAME=<CWA OPDS user>
CWA_PASSWORD=<CWA OPDS password>
BOOK_SYNC_INTERVAL_SECONDS=300
```

Generate the Shelfmark key with `openssl rand -base64 32`. Configure the same
value in both the Panels and Shelfmark containers. It grants administrative API
access and must be treated like a root password.

The Shelfmark and CWA web ports bind to `127.0.0.1` by default. Reach their setup
interfaces through an SSH tunnel rather than exposing them publicly:

```sh
ssh -L 8083:127.0.0.1:8083 -L 8084:127.0.0.1:8084 user@server
```

Create the initial CWA account, enable OPDS authentication, and use that account
for `CWA_USERNAME` and `CWA_PASSWORD`. Panels never returns these values, the
Shelfmark key, or upstream acquisition URLs to the client.

In Shelfmark, open **Settings → Metadata Providers** and enable **Open Library**
(or another metadata provider you operate). Open Library needs no API key and
only supplies search metadata; enabling it does not configure a release or
download source. Panel Pilot deliberately leaves download-source selection to
the Shelfmark operator.

## Shared-volume permissions

Both book containers must run with the same `BOOKS_PUID` and `BOOKS_PGID`. The
defaults are `1000:1000`. For bind mounts, create the directories first and make
them writable only by that account:

```sh
install -d -m 0770 -o 1000 -g 1000 /srv/panels-books/{ingest,cwa-config,cwa-library,shelfmark-config}
```

The Compose file uses named volumes by default. CWA removes files from its
ingest directory after import, so the shared ingest location is not a backup.
Keep CWA's library and config volumes in the host backup plan. Shelfmark must
publish completed files atomically into the shared directory; do not expose
partially written downloads to CWA.

## Backup and restore

Back up the CWA config and library volumes together with Panels' `/app/data`
volume. The latter contains `books.sqlite3` (reading locations and preferences)
and the replaceable sanitized EPUB cache. Stop Panels and CWA briefly, or use a
snapshot mechanism that guarantees a consistent SQLite and Calibre-library
snapshot. The ingest volume and Shelfmark search cache are disposable.

Restore CWA's config and library first, then Panels data, start CWA, and finally
start Panels. A manual **Sync library** from Books will reconcile the local book
index without altering manga data.

## Public-domain smoke-test books

For a legal end-to-end reader test, download an EPUB from Project Gutenberg and
place the completed file in CWA's ingest volume. Good small examples are
*Alice's Adventures in Wonderland* (ebook 11) and *Pride and Prejudice* (ebook
1342). Wait for CWA to remove the ingest copy, then use **Settings → Books →
Sync library** in Panels. Direct sample import tests only the CWA → Panels path; Shelfmark's
acquisition path still requires a source configured by the operator.

## Manual verification checklist

1. Start Panels with `BOOKS_ENABLED=false` and no book credentials. Confirm it
   starts normally, Books is absent, and manga browse/reader/progress still work.
2. Start the `books` Compose profile, complete CWA setup through an SSH tunnel,
   and configure its authenticated OPDS user.
3. Enable Books and use **Settings → Books** to test Shelfmark and CWA.
4. Import a public-domain EPUB into CWA, sync Books, and confirm its metadata,
   cover, and details appear in the main Library under the Books filter.
5. Open the EPUB, use Contents, side taps, swipe, next/previous, and the progress
   scrubber; change theme, text size, line spacing, page width, and flow; rotate
   the device; then close it. Reopen it and confirm the exact location and
   preferences return.
6. Use **Browse → Find books**, inspect EPUB-only releases, queue one, and confirm the state
   advances through queued/downloading/importing/ready after CWA imports it.
7. Stop Shelfmark and CWA. Confirm book connection errors are contained and
   existing manga browsing and reading remain available.
8. Inspect browser storage, network responses, and logs to confirm no upstream
   credentials or acquisition URLs are exposed.

## Disabled behavior

With `BOOKS_ENABLED=false`, Panels does not validate book credentials, create
`books.sqlite3`, start a book sync worker, or show any book routes/navigation.
Shelfmark and CWA need not be running. Their Compose services are also behind
the `books` profile.

## Troubleshooting

- **Shelfmark test fails with 401:** verify both containers have the exact same
  API key and restart Shelfmark after changing it.
- **Book search says no metadata provider is configured:** enable Open Library
  under Shelfmark's Metadata Providers settings. This is independent of any
  release/download source.
- **CWA test fails with 401:** verify the OPDS user can open `/opds` using Basic
  authentication.
- **Downloads never import:** check ownership of the shared volume and CWA's
  ingest logs. Confirm the file is a non-DRM EPUB and is moved into the ingest
  directory only after its download completes.
- **Books are absent but manga works:** this is intentional failure isolation.
  Check the Books connection status; CWA downtime must not affect Suwayomi.
