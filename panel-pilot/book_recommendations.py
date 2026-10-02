"""Personalized text-book recommendations with cautious work and series grouping."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Sequence

from comic_recommendations import (
    BookMetadata,
    LibraryThingAdapter,
    OpenLibraryAdapter,
    ResolvedSeed,
    _clean_cover_url,
    _clean_isbns,
    _clean_string_tuple,
    _clean_text,
    _creator_overlap,
    _title_similarity,
    is_comic_metadata,
    normalize_title,
)


SCHEMA_VERSION = 1
_SERIES_SUFFIX = re.compile(
    r"^(?P<name>.+?)(?:\s*[,;:—-]\s*|\s+)(?:(?:book|volume|vol\.?|part)\s*|#)(?P<position>\d+(?:\.\d+)?)$",
    re.IGNORECASE,
)
_TEXT_BOOK_EXCLUSIONS = ("manga", "manhwa", "manhua", "graphic novel", "comic book", "comics")


def _series_parts(name: Any, position: Any = None) -> tuple[str, float | None, str]:
    display = _clean_text(name, 300)
    parsed_position = None
    if position is not None:
        try:
            candidate = float(position)
            parsed_position = candidate if 0 < candidate < 10_000 else None
        except (TypeError, ValueError):
            parsed_position = None
    match = _SERIES_SUFFIX.match(display)
    if match:
        display = match.group("name").strip(" ,;:—-")
        if parsed_position is None:
            parsed_position = float(match.group("position"))
    return display, parsed_position, normalize_title(display)


def _author_key(authors: Sequence[str]) -> str:
    cleaned = _clean_string_tuple(authors, 5)
    return normalize_title(cleaned[0]) if cleaned else ""


def _work_key(title: str, authors: Sequence[str]) -> tuple[str, str]:
    return normalize_title(title), _author_key(authors)


def _is_text_book(metadata: BookMetadata) -> bool:
    normalized = " | ".join(normalize_title(subject) for subject in metadata.subjects)
    return not is_comic_metadata(metadata.subjects) and not any(marker in normalized for marker in _TEXT_BOOK_EXCLUSIONS)


@dataclass(frozen=True)
class BookSeed:
    book_id: int
    title: str
    authors: tuple[str, ...] = ()
    isbn: str = ""
    series_name: str = ""
    series_position: float | None = None
    status: str = ""
    updated_at: str = ""

    def __post_init__(self) -> None:
        title = _clean_text(self.title, 300)
        if not title:
            raise ValueError("Book seed title is required")
        object.__setattr__(self, "book_id", max(0, int(self.book_id)))
        object.__setattr__(self, "title", title)
        object.__setattr__(self, "authors", _clean_string_tuple(self.authors, 12))
        object.__setattr__(self, "isbn", next(iter(_clean_isbns((self.isbn,))), ""))
        series_name, series_position, _ = _series_parts(self.series_name, self.series_position)
        object.__setattr__(self, "series_name", series_name)
        object.__setattr__(self, "series_position", series_position)
        object.__setattr__(self, "status", _clean_text(self.status, 40))
        object.__setattr__(self, "updated_at", _clean_text(self.updated_at, 100))


@dataclass(frozen=True)
class BookRecommendation:
    provider: str
    provider_id: str
    title: str
    authors: tuple[str, ...]
    cover_url: str
    isbns: tuple[str, ...]
    year: int | None
    rank: int
    seed_titles: tuple[str, ...] = ()
    series_name: str = ""
    series_position: float | None = None
    series_confidence: str = ""
    reason_type: str = "because_you_read"

    def __post_init__(self) -> None:
        provider = normalize_title(self.provider).replace(" ", "-")
        provider_id = _clean_text(self.provider_id, 200)
        title = _clean_text(self.title, 300)
        if not provider or not re.fullmatch(r"[A-Za-z0-9._:/-]{1,200}", provider_id) or not title:
            raise ValueError("Recommendation provider, provider ID, and title are required")
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "provider_id", provider_id)
        object.__setattr__(self, "title", title)
        object.__setattr__(self, "authors", _clean_string_tuple(self.authors, 20))
        object.__setattr__(self, "cover_url", _clean_cover_url(self.cover_url))
        object.__setattr__(self, "isbns", _clean_isbns(self.isbns))
        object.__setattr__(self, "seed_titles", _clean_string_tuple(self.seed_titles, 12))
        object.__setattr__(self, "rank", max(1, int(self.rank)))
        series_name, series_position, _ = _series_parts(self.series_name, self.series_position)
        object.__setattr__(self, "series_name", series_name)
        object.__setattr__(self, "series_position", series_position)
        object.__setattr__(self, "series_confidence", "explicit" if series_name else "")
        if self.year is not None and not 1400 <= int(self.year) <= 2200:
            object.__setattr__(self, "year", None)

    @property
    def id(self) -> str:
        return f"{self.provider}:{self.provider_id}"

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "provider": self.provider,
            "providerId": self.provider_id,
            "title": self.title,
            "authors": list(self.authors),
            "coverUrl": self.cover_url,
            "year": self.year,
            "identifiers": {"isbn": list(self.isbns)},
            "series": {
                "name": self.series_name,
                "position": self.series_position,
                "confidence": self.series_confidence,
            } if self.series_name else None,
            "reason": {
                "type": self.reason_type,
                "seedTitles": list(self.seed_titles),
            },
            "rank": self.rank,
        }


@dataclass(frozen=True)
class BookRecommendationFeed:
    mode: str
    seed_titles: tuple[str, ...]
    results: tuple[BookRecommendation, ...]
    cache_key: str

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "mode": self.mode,
            "seedTitles": list(self.seed_titles),
            "cacheKey": self.cache_key,
            "results": [result.to_public_dict() for result in self.results],
        }


def book_inventory_from_library(books: Sequence[dict[str, Any]]) -> tuple[BookSeed, ...]:
    inventory: list[BookSeed] = []
    seen: set[tuple[str, str]] = set()
    for book in books if isinstance(books, Sequence) and not isinstance(books, (str, bytes)) else ():
        if not isinstance(book, dict):
            continue
        title = _clean_text(book.get("title"), 300)
        authors = _clean_string_tuple(book.get("authors"), 12)
        identity = _work_key(title, authors)
        if not identity[0] or identity in seen:
            continue
        seen.add(identity)
        inventory.append(BookSeed(
            book_id=int(book.get("id") or 0),
            title=title,
            authors=authors,
            isbn=str(book.get("isbn") or ""),
            series_name=str(book.get("seriesName") or ""),
            series_position=book.get("seriesPosition"),
            status=str(book.get("libraryStatus") or ""),
            updated_at=str((book.get("progress") or {}).get("updatedAt") or book.get("lastSyncedAt") or ""),
        ))
    return tuple(inventory)


def book_seeds_from_library(books: Sequence[dict[str, Any]], maximum: int = 8) -> tuple[BookSeed, ...]:
    ignored = {"plan_to_read", "considering", "dropped"}
    priorities = {"reading": 0, "rereading": 0, "completed": 1, "paused": 2}
    candidates: list[tuple[int, str, str, BookSeed]] = []
    seen: set[tuple[str, str]] = set()
    for seed in book_inventory_from_library(books):
        status = seed.status
        if status in ignored:
            continue
        identity = _work_key(seed.title, seed.authors)
        if identity in seen:
            continue
        seen.add(identity)
        candidates.append((priorities.get(status, 3), seed.updated_at, seed.title.casefold(), seed))
    candidates.sort(key=lambda item: item[2])
    candidates.sort(key=lambda item: item[1], reverse=True)
    candidates.sort(key=lambda item: item[0])
    return tuple(item[3] for item in candidates[:max(1, min(16, int(maximum)))])


def recommendation_cache_key(seeds: Sequence[BookSeed], *, limit: int, provider_namespace: str) -> str:
    material = {
        "schema": SCHEMA_VERSION,
        "provider": _clean_text(provider_namespace, 120),
        "limit": max(1, min(30, int(limit))),
        "seeds": [{
            "title": normalize_title(seed.title),
            "authors": [normalize_title(author) for author in seed.authors],
            "isbn": seed.isbn,
            "series": normalize_title(seed.series_name),
            "position": seed.series_position,
            "status": seed.status,
        } for seed in seeds],
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"book-recs-v{SCHEMA_VERSION}-{hashlib.sha256(encoded).hexdigest()}"


def _choose_seed_match(seed: BookSeed, candidates: Sequence[BookMetadata]) -> BookMetadata | None:
    ranked: list[tuple[float, BookMetadata]] = []
    for candidate in candidates:
        if not candidate.title or not candidate.isbns or not _is_text_book(candidate):
            continue
        title_score = _title_similarity(seed.title, candidate.title)
        author_score = _creator_overlap(seed.authors, candidate.creators)
        if title_score < 0.58 or (seed.authors and not author_score):
            continue
        score = 0.78 * title_score + 0.2 * author_score + (0.02 if seed.isbn in candidate.isbns else 0)
        ranked.append((score, candidate))
    ranked.sort(key=lambda item: (-item[0], item[1].work_id, item[1].isbns))
    if not ranked or ranked[0][0] < 0.72:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.06:
        first_identity = _work_key(ranked[0][1].title, ranked[0][1].creators)
        second_identity = _work_key(ranked[1][1].title, ranked[1][1].creators)
        if first_identity != second_identity:
            return None
    return ranked[0][1]


class BookRecommendationService:
    def __init__(self, *, librarything: LibraryThingAdapter, open_library: OpenLibraryAdapter) -> None:
        self._librarything = librarything
        self._open_library = open_library

    @property
    def provider_namespace(self) -> str:
        return f"book+{self._librarything.namespace}+{self._open_library.namespace}"

    def cache_key(self, seeds: Sequence[BookSeed], *, limit: int = 12) -> str:
        return recommendation_cache_key(seeds, limit=limit, provider_namespace=self.provider_namespace)

    def _resolve(self, seed: BookSeed) -> ResolvedSeed | None:
        if seed.isbn:
            return ResolvedSeed(
                seed=seed,
                metadata=BookMetadata(
                    title=seed.title,
                    isbns=(seed.isbn,),
                    creators=seed.authors,
                    series_name=seed.series_name,
                    series_position=seed.series_position,
                ),
                confidence=1.0,
            )
        candidates = self._open_library.search_books(seed.title, authors=seed.authors)
        metadata = _choose_seed_match(seed, candidates)
        return ResolvedSeed(seed=seed, metadata=metadata, confidence=0.8) if metadata else None

    def build_feed(
        self,
        seeds: Sequence[BookSeed],
        *,
        owned_books: Sequence[BookSeed] | None = None,
        limit: int = 12,
    ) -> BookRecommendationFeed:
        clean_seeds = tuple(seeds)
        owned = tuple(owned_books or clean_seeds)
        clean_limit = max(1, min(20, int(limit)))
        primary_failed = False
        recommendations: list[BookRecommendation] = []
        owned_isbns = {seed.isbn for seed in owned if seed.isbn}
        owned_works = {_work_key(seed.title, seed.authors) for seed in owned}
        owned_series: dict[tuple[str, str], float] = {}
        for seed in owned:
            _, position, series_key = _series_parts(seed.series_name, seed.series_position)
            if not series_key or position is None:
                continue
            key = (series_key, _author_key(seed.authors))
            owned_series[key] = max(position, owned_series.get(key, 0))
        try:
            resolved = tuple(match for seed in clean_seeds if (match := self._resolve(seed)) is not None)
            hits = self._librarything.recommend(resolved, limit=max(30, clean_limit * 3))
            metadata_by_isbn = self._open_library.lookup_isbns(
                tuple(isbn for hit in hits for isbn in hit.isbns[:3])
            )
            seen: set[tuple[str, str]] = set()
            seen_provider_ids: set[str] = set()
            for hit in hits:
                metadata = next((metadata_by_isbn[isbn] for isbn in hit.isbns if isbn in metadata_by_isbn), None)
                if metadata is None or not _is_text_book(metadata):
                    continue
                identity = _work_key(metadata.title, metadata.creators)
                if identity in owned_works or identity in seen or hit.provider_id in seen_provider_ids:
                    continue
                if owned_isbns.intersection(metadata.isbns or hit.isbns):
                    continue
                series_name, series_position, series_key = _series_parts(
                    metadata.series_name, metadata.series_position
                )
                reason_type = "because_you_read" if hit.seed_titles else "library_match"
                if series_key and series_position is not None:
                    series_identity = (series_key, _author_key(metadata.creators))
                    owned_position = owned_series.get(series_identity)
                    if owned_position is not None:
                        if series_position <= owned_position or series_position > owned_position + 1.01:
                            continue
                        reason_type = "next_in_series"
                recommendations.append(BookRecommendation(
                    provider=hit.provider,
                    provider_id=hit.provider_id,
                    title=metadata.title,
                    authors=metadata.creators,
                    cover_url=metadata.cover_url,
                    isbns=metadata.isbns or hit.isbns,
                    year=metadata.year,
                    rank=hit.rank,
                    seed_titles=hit.seed_titles,
                    series_name=series_name,
                    series_position=series_position,
                    reason_type=reason_type,
                ))
                seen.add(identity)
                seen_provider_ids.add(hit.provider_id)
                if len(recommendations) >= clean_limit:
                    break
        except Exception:
            primary_failed = True
        mode = "unavailable" if primary_failed and not recommendations else "personalized"
        return BookRecommendationFeed(
            mode=mode,
            seed_titles=tuple(seed.title for seed in clean_seeds),
            results=tuple(recommendations[:clean_limit]),
            cache_key=self.cache_key(clean_seeds, limit=clean_limit),
        )


__all__ = [
    "BookRecommendation",
    "BookRecommendationFeed",
    "BookRecommendationService",
    "BookSeed",
    "book_inventory_from_library",
    "book_seeds_from_library",
    "recommendation_cache_key",
]
