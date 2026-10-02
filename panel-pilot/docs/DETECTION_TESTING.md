# Detection quality testing

Panels includes a private Detection Test Lab at `/panel-test.html`. It can test
one chapter at a time or step through a local JSON suite covering manga,
Western comics, and webtoons.

The lab shows the detected panel count, confidence, selected presentation
(panels, full page, full width, or spread), overlap risks, count accuracy, and
manual “Looks good” / “Needs work” feedback. Expected counts and feedback stay
in browser storage. Exporting a report is an explicit local download.

## Suite manifest

Create a JSON file with 1–100 cases. Use current Suwayomi IDs for library
chapters or an allowlisted Comick title URL. IDs below are illustrative and
must be replaced with IDs from the running server.

```json
{
  "schemaVersion": 1,
  "cases": [
    {
      "label": "Golden Kamuy representative chapter",
      "format": "manga",
      "mangaId": 123,
      "chapterId": 456,
      "direction": "rtl",
      "maxPages": 12
    },
    {
      "label": "Darth Vader representative issue",
      "format": "comic",
      "mangaId": 789,
      "chapterId": 1011,
      "direction": "ltr",
      "maxPages": 12
    },
    {
      "label": "Webtoon long-strip sample",
      "format": "webtoon",
      "mangaId": 1213,
      "chapterId": 1415,
      "direction": "ltr",
      "maxPages": 8
    }
  ]
}
```

Good comic coverage should include layouts from Darth Vader, Invincible, Saga,
and Y: The Last Man when those books are available in the private library. Do
not commit downloaded pages, source credentials, private server URLs, or report
exports to the repository.

## Review workflow

1. Load the suite and select a case.
2. Load the chapter, then run detection.
3. Enter an expected panel count where count accuracy matters.
4. Mark representative pages as “Looks good” or “Needs work” and choose the
   closest issue type.
5. Export the report only when comparing detector versions.

The report includes geometry and diagnostic metrics. Treat it as private even
though the app never uploads it automatically.
