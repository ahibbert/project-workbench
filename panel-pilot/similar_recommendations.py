"""Pure normalization helpers for title-anchored recommendations."""

from __future__ import annotations

from typing import Any, Iterable

from comic_recommendations import normalize_title


MANGA_FORMATS = frozenset(("manga", "webtoon"))
MANGABAKA_TYPES = frozenset(("manga", "manhwa", "manhua", "oel"))


def mangabaka_title(series: dict[str, Any]) -> str:
    titles = series.get("titles") if isinstance(series.get("titles"), list) else []
    candidates = [entry for entry in titles if isinstance(entry, dict) and str(entry.get("title") or "").strip()]
    preferred = next((entry for entry in candidates if entry.get("language") == "en" and entry.get("is_primary")), None)
    preferred = preferred or next((entry for entry in candidates if entry.get("language") == "en"), None)
    preferred = preferred or next((entry for entry in candidates if entry.get("is_primary")), None)
    return str((preferred or {}).get("title") or series.get("title") or "").strip()[:300]


def select_mangabaka_seed(results: Any, title: str) -> dict[str, Any] | None:
    """Choose only an exact normalized work title; ambiguous fuzzy matches fail closed."""

    desired = normalize_title(title)
    if not desired or not isinstance(results, list):
        return None
    exact = []
    for series in results:
        if not isinstance(series, dict):
            continue
        titles = [mangabaka_title(series)]
        titles.extend(
            str(entry.get("title") or "")
            for entry in series.get("titles") or []
            if isinstance(entry, dict)
        )
        if any(normalize_title(candidate) == desired for candidate in titles):
            exact.append(series)
    if not exact:
        return None
    exact.sort(key=lambda item: (
        str(item.get("state") or "") != "active",
        str(item.get("type") or "").lower() not in MANGABAKA_TYPES,
        -int(item.get("rating_count") or 0),
        int(item.get("id") or 0),
    ))
    return exact[0]


def normalize_mangabaka_similar(
    payload: Any,
    *,
    seed_title: str,
    requested_format: str,
    excluded_titles: Iterable[str] = (),
    limit: int = 12,
) -> list[dict[str, Any]]:
    excluded = {normalize_title(seed_title), *(normalize_title(value) for value in excluded_titles)}
    output: list[dict[str, Any]] = []
    seen: set[int] = set()
    rows = payload.get("data") if isinstance(payload, dict) else None
    for row in rows if isinstance(rows, list) else ():
        if not isinstance(row, dict):
            continue
        series = row.get("series") if isinstance(row.get("series"), dict) else row
        series_id = int(series.get("id") or 0)
        title = mangabaka_title(series)
        media_type = str(series.get("type") or series.get("media_type") or "").lower()
        if not series_id or series_id in seen or media_type not in MANGABAKA_TYPES:
            continue
        if normalize_title(title) in excluded:
            continue
        seen.add(series_id)
        tags = []
        for tag in row.get("shared_tags") or []:
            if not isinstance(tag, dict) or not str(tag.get("name") or "").strip():
                continue
            tags.append({"name": str(tag["name"]).strip()[:100], "weight": str(tag.get("weight") or "")[:40]})
        output.append({
            **series,
            "mediaFormat": requested_format,
            "similarity": max(0.0, min(1.0, float(row.get("score") or 0))),
            "reason": {
                "reason_type": "similar_to",
                "reason_seeds": [{"title": seed_title}],
                "top_tags": tags[:3],
                "matched_author": bool(row.get("matched_author")),
                "matched_related": bool(row.get("matched_related")),
            },
        })
        if len(output) >= max(1, min(20, int(limit))):
            break
    return output


__all__ = ["MANGA_FORMATS", "mangabaka_title", "normalize_mangabaka_similar", "select_mangabaka_seed"]
