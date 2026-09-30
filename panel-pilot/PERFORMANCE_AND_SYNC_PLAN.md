# Panel performance and Tachimanga migration

This is the next implementation phase after the signed-off v87 mobile redesign.

## Outcomes

- The current page becomes readable as soon as its image is decoded.
- Panel detection does not block taps, animation, or navigation.
- Returning to a detected page reuses saved panel metadata.
- Panel accuracy does not regress on the existing manga/comic test corpus.
- The user's current Tachimanga library, read chapters, and reading positions are
  available through Suwayomi and therefore visible in Panel Pilot.

## Performance baseline

Instrument these stages separately for every page:

1. image fetch and decode;
2. canvas downsample and pixel readback;
3. mask/stat generation;
4. panel candidate generation and ordering;
5. first reader render.

Record cold and warm results in the existing panel test report. Test on the
actual phone as well as desktop because main-thread stalls and image decoding
cost differ substantially.

Initial acceptance targets:

- show the current page immediately after decode, before background work;
- no detector task should block the UI thread for more than 50 ms;
- cached panel metadata should be available in under 50 ms;
- prepare only the current and next page eagerly;
- preserve or improve the existing expected-panel results.

## Implementation order

1. Add timing marks and long-task observation to the reader and test lab.
2. Cache sanitized panel boxes in IndexedDB using image URL, detector version,
   panel mode, and reading direction as the key. A detector-version change
   invalidates old entries without deleting the user's library.
3. Prioritize current page, next page, then the adjacent previous page. Process
   the rest only while the browser is idle and keep concurrency bounded.
4. Move canvas sampling and detector computation to a Web Worker using
   `createImageBitmap` and `OffscreenCanvas` where supported. Keep a chunked
   main-thread fallback for older iOS versions.
5. Share the luminance/mask preprocessing between manga and comic pipelines to
   avoid duplicate allocations and work.
6. Benchmark the imported current-reading titles and tune against the slowest
   real pages, not only the synthetic/demo chapter.

## Tachimanga migration path

Tachimanga's backup includes titles, read chapters, tracking, and reading
history. Create one in **Settings → Backup & Restore → Create Backup**. On iOS,
the file is normally under **Files → On My iPhone → Tachimanga → backups**.

Keep the original backup untouched. The migration should run locally and use a
copy:

1. Inspect the backup and report its format, title count, history count, and
   source identifiers without modifying either app.
2. Convert the copy to a Mihon/Tachiyomi-compatible backup if needed.
3. Restore that backup into the connected Suwayomi server.
4. Compare title/read/history counts before accepting the restore.
5. In Tachimanga, enable **Enhanced Tracking → Suwayomi** and use **Match
   existing library manga** for titles from compatible extensions.
6. Open several in-progress titles in Panel Pilot and verify chapter/page
   progress in both directions before enabling routine sync.

Relevant format/integration references:

- Tachimanga backup guide: <https://tachimanga.app/help/guides/backups.html>
- Tachimanga Enhanced Tracking guide: <https://tachimanga.app/help/guides/tracking.html>
- Tachimanga Sync guide: <https://tachimanga.app/help/guides/sync.html>
- Tachimanga-to-Mihon converter: <https://github.com/Ectalite/tachimanga_bk>
- Browser-local `.tmb` converter: <https://github.com/Janlery/MANGA-TENSEI>

## Required input

Provide a fresh Tachimanga backup file. Before any restore, Panel Pilot should
produce a dry-run summary and keep rollback copies of the Suwayomi data and the
original Tachimanga backup.
