# Source benchmark and extension catalog

Panels keeps source selection private and evidence-based. The source suite uses public title queries only while it is running. Persisted checkpoints, summaries, and API payloads contain opaque case IDs, source IDs, aggregate counts, bounded error classes, latency, and image dimensions/byte counts. They never contain titles, page URLs, image bodies, or upstream error text.

The reviewed catalog is the official [Keiyoushi extension repository](https://github.com/keiyoushi/extensions). The manifest pins its current signing-key fingerprint and canonical `index.json` metadata endpoint. Catalog validation stops if the signing key, package identity, content-warning classification, or expected source IDs drift.

## Fixed suite

`tools/source_suite_manifest.json` contains eleven representative probes:

- four end-to-end manga searches;
- four Western-comic searches, including long-running and franchise titles;
- three vertical-webtoon searches.

No page or cover fixtures are checked into Git. A live run samples one to three image headers in memory, records dimensions, codec and byte count, then discards the bytes and page reference.

## Catalog-only review

This command fetches and validates official metadata, then prints a URL-free report. It cannot install, update, or remove an extension.

```powershell
py -3.12 tools/source_catalog_report.py
```

For an inventory-aware report, export the authenticated `GET /api/source-intelligence/inventory` response to a private local file and pass it with `--inventory`. That file must not be committed.

```powershell
py -3.12 tools/source_catalog_report.py --inventory C:\private\panels-source-inventory.json
```

The report distinguishes extension packages from their individual source variants. `review-install` and `review-update` are recommendations for operator review, not actions.

## Recommended review cohort

The metadata snapshot was verified on 2026-10-02. Re-run the catalog report immediately before changing Suwayomi because versions and source health change independently of Panels.

| Order | Format | Extension package | Verified version | Policy |
|---:|---|---|---|---|
| 1 | Comic | `eu.kanade.tachiyomi.extension.en.readallcomicscom` | 1.4.8 | Safe-content candidate |
| 2 | Comic | `eu.kanade.tachiyomi.extension.en.readcomicsonline` | 1.6.0 | Safe-content candidate |
| 3 | Webtoon | `eu.kanade.tachiyomi.extension.all.webtoons` | 1.6.1 | Safe-content candidate |
| 4 | Webtoon | `eu.kanade.tachiyomi.extension.en.asurascans` | 1.6.69 | Safe-content candidate |
| 5 | Webtoon | `eu.kanade.tachiyomi.extension.en.flamecomics` | 1.6.0 | Safe-content candidate |
| 6 | Manga | `eu.kanade.tachiyomi.extension.en.weebcentral` | 1.6.25 | Mixed-content candidate; review filters |
| 7 | Manga | `eu.kanade.tachiyomi.extension.all.mangafire` | 1.6.34 | Mixed-content candidate; review filters |

Before adding candidates, review/update the existing baseline packages reported obsolete by Suwayomi. The baseline is MangaDex, MangaReader.site, Mangack, Comick (Unoriginal), XOXO Comics, ReadComicOnline and Comivex. Manhwa18.cc is represented as `excluded` because the official catalog marks it NSFW; it is never an automatic recommendation.

Install only the first candidate for a format, refresh Panels inventory, run that format's benchmark, and keep it only if it adds useful coverage or quality. This isolates rate limits and makes regressions attributable to one package.

## Benchmark plan, run, and resume

The CLI defaults to a read-only plan and requires explicit source IDs. Use IDs returned by the Panels inventory endpoint; keep them as strings because Suwayomi IDs exceed JavaScript's safe integer range.

```powershell
$env:PANEL_PILOT_AUTH_USER = "reader"
$env:PANEL_PILOT_AUTH_PASSWORD = "use-your-existing-secret"

py -3.12 tools/run_source_benchmark.py `
  --app https://your-panels-host `
  --base http://localhost:4567 `
  --format comic `
  --source-id 8061953015808280611
```

Add `--execute` to perform the read-only search/chapter/page/image requests. Add a private checkpoint path so an interrupted run can resume without repeating completed source/case pairs:

```powershell
py -3.12 tools/run_source_benchmark.py `
  --app https://your-panels-host `
  --base http://localhost:4567 `
  --format comic `
  --source-id 8061953015808280611 `
  --execute `
  --checkpoint C:\private\panels-comic-benchmark.json `
  --summary-only

# Resume the same run and selection
py -3.12 tools/run_source_benchmark.py `
  --app https://your-panels-host `
  --base http://localhost:4567 `
  --format comic `
  --source-id 8061953015808280611 `
  --execute `
  --checkpoint C:\private\panels-comic-benchmark.json `
  --resume `
  --summary-only
```

Only add `--post` after reviewing the sanitized checkpoint/summary. Posting sends the existing allowlisted observations and benchmark contracts to Panels. It does not modify extension configuration.

## Interpretation

- **Coverage** combines title match, available chapters, page lists and a usable sampled image.
- **Quality** uses image width and a bounded bytes-per-pixel signal. It is comparative, not a claim about artistic quality.
- **Reliability** uses successful versus failed operations with a prior so one lucky request cannot dominate established evidence.
- **Latency** is the median successful request latency for the source and format.

Treat `recommended` as permission to compare a source, not as a permanent guarantee. Sources are external services and may change, rate-limit, or disappear. Keep no more extensions enabled than are useful, run the suite sequentially with its default delay, and respect each service's terms and content controls.
