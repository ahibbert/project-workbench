# Household accounts

Panels can provide separate personal experiences over one shared EPUB
catalogue. The login configured by `PANEL_PILOT_AUTH_USER` and
`PANEL_PILOT_AUTH_PASSWORD` is preserved as the owner account when the account
database is first created. Existing owner book progress and preferences are
migrated to its stable account ID.

## Create a books-only account

1. Sign in as the owner.
2. Open **Settings → Account**.
3. Enter a username, display name, and temporary password.
4. Create the account and give the password to the reader securely.

The reader signs in at the normal Panels address. Manga, comics, webtoons,
MangaBaka, visual-reader storage, and their navigation are hidden. The owner
can reset the password or change content access from the same settings section.

## What is shared

- Shelfmark acquisition and its configured providers.
- The CWA EPUB catalogue, covers, and EPUB files.
- Storage for an EPUB that has already been acquired.

If a search result already exists in CWA, another reader can add it immediately
without acquiring a duplicate.

## What is personal

- Library membership and library groups.
- Exact reading location and EPUB reader preferences.
- Recommendations, stats, achievements, and moments.
- Browser-local settings, progress queues, and device data.
- MangaBaka connection and all Suwayomi-facing state for accounts that support
  visual content.

Removing a book removes only that reader's membership and progress. It does
not delete the shared EPUB or remove the book from another reader's library.

## Manga and comics

Secondary accounts are books-only in this release. Panels deliberately refuses
to enable manga, comic, or webtoon access for them because the configured
Suwayomi library is not safely multi-user. If another household member later
wants visual content, run a dedicated Suwayomi service for that reader before
enabling those content types in Panels.

## Backups and security

Back up `accounts.sqlite3` with the rest of the Panels data directory. Passwords
are stored as salted scrypt hashes; Shelfmark, CWA, LibraryThing, and MangaBaka
credentials are never returned in account API responses. Resetting a password
invalidates that account's existing sessions.
