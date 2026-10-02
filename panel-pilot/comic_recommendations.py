"""Provider-neutral Western-comic recommendation building blocks.

The module deliberately contains no server routing, credential persistence, or
network implementation.  Callers inject a JSON HTTP transport and own caching;
the pure cache key and normalized feed contract make that boundary explicit.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Mapping, Protocol, Sequence
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json"
OPEN_LIBRARY_BOOKS_URL = "https://openlibrary.org/api/books"
LIBRARYTHING_RECOMMENDATIONS_URL = "https://www.librarything.com/api/multirecommendations.php"

_SPACE_PATTERN = re.compile(r"\s+")
_NON_WORD_PATTERN = re.compile(r"[^a-z0-9]+")
_EDITION_SUFFIX_PATTERN = re.compile(
    r"(?:\s*[-:,]?\s*)"
    r"(?:"
    r"(?:vol(?:ume)?|book|part)\.?\s*(?:no\.?\s*)?(?:\d+|[ivxlcdm]+)"
    r"|(?:deluxe|ultimate)\s+(?:edition|collection)(?:\s*(?:vol(?:ume)?\.?\s*)?(?:\d+|[ivxlcdm]+))?"
    r"|(?:omnibus|compendium)(?:\s*(?:vol(?:ume)?\.?\s*)?(?:\d+|[ivxlcdm]+))?"
    r")\s*$",
    re.IGNORECASE,
)
_TRAILING_YEAR_PATTERN = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")
_COMIC_SUBJECT_MARKERS = (
    "comic",
    "graphic novel",
    "sequential art",
    "superhero",
    "supervillain",
    "bandes dessinees",
    "bande dessinee",
    "comics strips",
)
_NON_WESTERN_COMIC_MARKERS = (
    "manga",
    "manhwa",
    "manhua",
    "japanese comic",
    "korean comic",
    "chinese comic",
)


class JsonHttpClient(Protocol):
    """Minimal injectable transport used by metadata adapters."""

    def get_json(
        self,
        url: str,
        *,
        params: Mapping[str, str],
        headers: Mapping[str, str] | None = None,
    ) -> Mapping[str, Any]: ...


class FallbackRecommendationProvider(Protocol):
    """Hook implemented by a future Metron (or other) provider."""

    namespace: str

    def recommend(
        self,
        seeds: Sequence["ComicSeed"],
        *,
        excluded_title_keys: frozenset[str],
        limit: int,
    ) -> Sequence["ComicRecommendation"]: ...


class RecommendationError(RuntimeError):
    """Base error for recommendation providers."""


class RecommendationProviderError(RecommendationError):
    """An upstream provider failed or returned an invalid response."""


def _clean_text(value: Any, maximum: int = 500) -> str:
    return _SPACE_PATTERN.sub(" ", str(value or "").replace("\x00", " ")).strip()[:maximum]


def _clean_cover_url(value: Any) -> str:
    url = _clean_text(value, 2000)
    if url.startswith("http://covers.openlibrary.org/"):
        url = f"https://{url.removeprefix('http://')}"
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return ""
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        return ""
    return url


def normalize_title(value: Any) -> str:
    """Normalize a title for matching without applying edition heuristics."""

    return _SPACE_PATTERN.sub(" ", _NON_WORD_PATTERN.sub(" ", _clean_text(value).lower())).strip()


def base_series_title(value: Any) -> str:
    """Remove common collected-edition suffixes while preserving the display title."""

    title = _TRAILING_YEAR_PATTERN.sub("", _clean_text(value))
    previous = None
    while title and title != previous:
        previous = title
        title = _EDITION_SUFFIX_PATTERN.sub("", title).strip(" -:,.")
    return title or _clean_text(value)


def title_key(value: Any) -> str:
    return normalize_title(base_series_title(value))


def _clean_string_tuple(values: Any, maximum_items: int = 30) -> tuple[str, ...]:
    if isinstance(values, str):
        values = (values,)
    if not isinstance(values, Sequence):
        return ()
    output: list[str] = []
    seen: set[str] = set()
    for value in values[:maximum_items]:
        if isinstance(value, Mapping):
            value = value.get("name") or value.get("title")
        text = _clean_text(value, 300)
        key = normalize_title(text)
        if not text or not key or key in seen:
            continue
        seen.add(key)
        output.append(text)
    return tuple(output)


def _clean_isbns(values: Any, maximum_items: int = 20) -> tuple[str, ...]:
    if isinstance(values, str):
        values = (values,)
    if not isinstance(values, Sequence):
        return ()
    output: list[str] = []
    for value in values[:maximum_items]:
        isbn = re.sub(r"[^0-9Xx]", "", str(value or "")).upper()
        if len(isbn) not in (10, 13) or isbn in output:
            continue
        output.append(isbn)
    return tuple(output)


def is_comic_metadata(subjects: Sequence[str]) -> bool:
    normalized = " | ".join(normalize_title(subject) for subject in subjects)
    return (
        any(marker in normalized for marker in _COMIC_SUBJECT_MARKERS)
        and not any(marker in normalized for marker in _NON_WESTERN_COMIC_MARKERS)
    )


def _creator_keys(creators: Sequence[str]) -> set[str]:
    return {normalize_title(creator) for creator in creators if normalize_title(creator)}


def _creator_overlap(left: Sequence[str], right: Sequence[str]) -> float:
    left_keys = _creator_keys(left)
    right_keys = _creator_keys(right)
    if not left_keys or not right_keys:
        return 0.0
    exact = left_keys & right_keys
    if exact:
        return len(exact) / max(1, len(left_keys))
    left_surnames = {key.split()[-1] for key in left_keys}
    right_surnames = {key.split()[-1] for key in right_keys}
    return 0.6 if left_surnames & right_surnames else 0.0


def _title_similarity(left: str, right: str) -> float:
    left_full = normalize_title(left)
    right_full = normalize_title(right)
    left_base = title_key(left)
    right_base = title_key(right)
    if not left_full or not right_full:
        return 0.0
    if left_full == right_full:
        return 1.0
    if left_base and left_base == right_base:
        return 0.96
    left_tokens = set(left_base.split())
    right_tokens = set(right_base.split())
    if not left_tokens or not right_tokens:
        return 0.0
    overlap = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
    if left_base in right_base or right_base in left_base:
        overlap = max(overlap, 0.7)
    return overlap


@dataclass(frozen=True)
class ComicSeed:
    title: str
    creators: tuple[str, ...] = ()
    publisher: str = ""
    year: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "title", _clean_text(self.title, 300))
        object.__setattr__(self, "creators", _clean_string_tuple(self.creators, 12))
        object.__setattr__(self, "publisher", _clean_text(self.publisher, 200))
        if not self.title:
            raise ValueError("Comic seed title is required")
        if self.year is not None and not 1800 <= int(self.year) <= 2200:
            object.__setattr__(self, "year", None)


@dataclass(frozen=True)
class BookMetadata:
    title: str
    isbns: tuple[str, ...]
    creators: tuple[str, ...] = ()
    subjects: tuple[str, ...] = ()
    publisher: str = ""
    year: int | None = None
    cover_url: str = ""
    work_id: str = ""
    series_name: str = ""
    series_position: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "title", _clean_text(self.title, 300))
        object.__setattr__(self, "isbns", _clean_isbns(self.isbns))
        object.__setattr__(self, "creators", _clean_string_tuple(self.creators, 20))
        object.__setattr__(self, "subjects", _clean_string_tuple(self.subjects, 60))
        object.__setattr__(self, "publisher", _clean_text(self.publisher, 200))
        object.__setattr__(self, "cover_url", _clean_cover_url(self.cover_url))
        object.__setattr__(self, "work_id", _clean_text(self.work_id, 100))
        object.__setattr__(self, "series_name", _clean_text(self.series_name, 300))
        if self.series_position is not None:
            try:
                position = float(self.series_position)
            except (TypeError, ValueError):
                position = None
            object.__setattr__(self, "series_position", position if position is not None and 0 < position < 10000 else None)
        if self.year is not None and not 1800 <= int(self.year) <= 2200:
            object.__setattr__(self, "year", None)


@dataclass(frozen=True)
class ResolvedSeed:
    seed: ComicSeed
    metadata: BookMetadata
    confidence: float


@dataclass(frozen=True)
class ProviderRecommendationHit:
    provider: str
    provider_id: str
    rank: int
    isbns: tuple[str, ...]
    seed_titles: tuple[str, ...] = ()


@dataclass(frozen=True)
class ComicRecommendation:
    provider: str
    provider_id: str
    title: str
    search_titles: tuple[str, ...]
    cover_url: str
    creators: tuple[str, ...]
    year: int | None
    seed_titles: tuple[str, ...]
    isbns: tuple[str, ...]
    rank: int
    reason_type: str = "because_you_read"

    def __post_init__(self) -> None:
        provider = normalize_title(self.provider).replace(" ", "-")
        provider_id = _clean_text(self.provider_id, 200)
        title = _clean_text(self.title, 300)
        if not provider or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", provider_id) or not title:
            raise ValueError("Recommendation provider, provider_id, and title are required")
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "provider_id", provider_id)
        object.__setattr__(self, "title", title)
        search_titles = _clean_string_tuple(self.search_titles, 8)
        if not search_titles:
            search_titles = (base_series_title(title),)
        object.__setattr__(self, "search_titles", search_titles)
        object.__setattr__(self, "cover_url", _clean_cover_url(self.cover_url))
        object.__setattr__(self, "creators", _clean_string_tuple(self.creators, 20))
        object.__setattr__(self, "seed_titles", _clean_string_tuple(self.seed_titles, 12))
        object.__setattr__(self, "isbns", _clean_isbns(self.isbns))
        object.__setattr__(self, "rank", max(1, int(self.rank)))
        if self.year is not None and not 1800 <= int(self.year) <= 2200:
            object.__setattr__(self, "year", None)
        reason_type = _clean_text(self.reason_type, 60)
        object.__setattr__(self, "reason_type", reason_type or "catalog_fallback")

    @property
    def id(self) -> str:
        return f"{self.provider}:{self.provider_id}"

    def to_public_dict(self) -> dict[str, Any]:
        """Return the strict browser/cache contract; adapters and secrets are absent."""

        return {
            "id": self.id,
            "provider": self.provider,
            "providerId": self.provider_id,
            "title": self.title,
            "searchTitles": list(self.search_titles),
            "mediaFormat": "comic",
            "coverUrl": self.cover_url,
            "creators": list(self.creators),
            "year": self.year,
            "reason": {
                "type": self.reason_type,
                "seedTitles": list(self.seed_titles),
            },
            "identifiers": {"isbn": list(self.isbns)},
            "rank": self.rank,
        }


@dataclass(frozen=True)
class RecommendationFeed:
    mode: str
    seed_titles: tuple[str, ...]
    results: tuple[ComicRecommendation, ...]
    cache_key: str

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "mode": self.mode,
            "seedTitles": list(self.seed_titles),
            "cacheKey": self.cache_key,
            "results": [result.to_public_dict() for result in self.results],
        }


def recommendation_cache_key(
    seeds: Sequence[ComicSeed],
    *,
    limit: int,
    provider_namespace: str,
) -> str:
    """Return a stable opaque key without exposing seed titles or credentials."""

    material = {
        "schema": SCHEMA_VERSION,
        "provider": _clean_text(provider_namespace, 100),
        "limit": max(1, min(50, int(limit))),
        "seeds": [
            {
                "title": title_key(seed.title),
                "creators": sorted(_creator_keys(seed.creators)),
                "publisher": normalize_title(seed.publisher),
                "year": seed.year,
            }
            for seed in seeds
        ],
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"comic-recs-v{SCHEMA_VERSION}-{hashlib.sha256(encoded).hexdigest()}"


def score_seed_candidate(seed: ComicSeed, candidate: BookMetadata) -> float:
    """Score a bibliographic record, rejecting non-comics before title matching."""

    if not candidate.title or not candidate.isbns or not is_comic_metadata(candidate.subjects):
        return 0.0
    title_score = _title_similarity(seed.title, candidate.title)
    if title_score < 0.5:
        return 0.0
    score = 0.62 * title_score + 0.2
    creator_score = _creator_overlap(seed.creators, candidate.creators)
    if seed.creators:
        score += 0.16 * creator_score
        if not creator_score:
            score -= 0.12
    if seed.publisher and candidate.publisher:
        score += 0.04 if normalize_title(seed.publisher) == normalize_title(candidate.publisher) else 0.0
    if seed.year and candidate.year:
        difference = abs(seed.year - candidate.year)
        score += 0.04 if difference <= 1 else 0.02 if difference <= 5 else 0.0
    return round(max(0.0, min(1.0, score)), 6)


def choose_seed_match(
    seed: ComicSeed,
    candidates: Sequence[BookMetadata],
    *,
    minimum_confidence: float = 0.72,
    ambiguity_margin: float = 0.08,
) -> ResolvedSeed | None:
    """Select a high-confidence work and reject genuinely ambiguous top results.

    Multiple editions with the same base title and creator identity are treated
    as one work-equivalent group before the ambiguity check.
    """

    grouped: dict[tuple[str, tuple[str, ...]], tuple[float, BookMetadata]] = {}
    for candidate in candidates:
        score = score_seed_candidate(seed, candidate)
        if score <= 0:
            continue
        creator_identity = tuple(sorted(_creator_keys(candidate.creators)))
        if not creator_identity:
            creator_identity = (candidate.work_id or candidate.isbns[0],)
        group_key = (title_key(candidate.title), creator_identity)
        current = grouped.get(group_key)
        if current is None or score > current[0]:
            grouped[group_key] = (score, candidate)
    ranked = sorted(grouped.values(), key=lambda item: (-item[0], item[1].title, item[1].isbns))
    if not ranked or ranked[0][0] < minimum_confidence:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < ambiguity_margin:
        return None
    return ResolvedSeed(seed=seed, metadata=ranked[0][1], confidence=ranked[0][0])


def collapse_duplicate_editions(
    recommendations: Sequence[ComicRecommendation],
) -> tuple[ComicRecommendation, ...]:
    """Collapse volumes/omnibus editions while retaining the best ranked record."""

    chosen: dict[tuple[str, str], ComicRecommendation] = {}
    for recommendation in sorted(recommendations, key=lambda item: (item.rank, item.id)):
        creator_key = next(iter(sorted(_creator_keys(recommendation.creators))), "")
        key = (title_key(recommendation.title), creator_key)
        existing = chosen.get(key)
        if existing is None:
            chosen[key] = recommendation
            continue
    return tuple(sorted(chosen.values(), key=lambda item: (item.rank, item.id)))


class OpenLibraryAdapter:
    namespace = "openlibrary-v1"

    def __init__(self, http: JsonHttpClient, *, user_agent: str = "Panels comic recommendations") -> None:
        self._http = http
        self._user_agent = _clean_text(user_agent, 300) or "Panels comic recommendations"

    @property
    def _headers(self) -> Mapping[str, str]:
        return {"User-Agent": self._user_agent, "Accept": "application/json"}

    def resolve_seed(self, seed: ComicSeed, *, result_limit: int = 10) -> ResolvedSeed | None:
        candidates = self.search_books(seed.title, authors=seed.creators, result_limit=result_limit)
        return choose_seed_match(seed, candidates)

    def search_books(
        self,
        title: str,
        *,
        authors: Sequence[str] = (),
        result_limit: int = 10,
    ) -> tuple[BookMetadata, ...]:
        params = {
            "title": _clean_text(title, 300),
            "language": "eng",
            "limit": str(max(3, min(20, int(result_limit)))),
            "fields": "key,title,author_name,first_publish_year,isbn,cover_i,subject,publisher,series",
        }
        clean_authors = _clean_string_tuple(authors, 3)
        if clean_authors:
            params["author"] = clean_authors[0]
        payload = self._http.get_json(
            OPEN_LIBRARY_SEARCH_URL,
            params=params,
            headers=self._headers,
        )
        documents = payload.get("docs") if isinstance(payload, Mapping) else None
        if not isinstance(documents, Sequence) or isinstance(documents, (str, bytes)):
            raise RecommendationProviderError("Open Library search returned an invalid response")
        candidates = tuple(self._metadata_from_search_document(document) for document in documents)
        return tuple(candidate for candidate in candidates if candidate)

    def lookup_isbns(self, isbns: Sequence[str]) -> Mapping[str, BookMetadata]:
        cleaned = _clean_isbns(isbns, 100)
        if not cleaned:
            return {}
        payload = self._http.get_json(
            OPEN_LIBRARY_BOOKS_URL,
            params={
                "bibkeys": ",".join(f"ISBN:{isbn}" for isbn in cleaned),
                "jscmd": "data",
                "format": "json",
            },
            headers=self._headers,
        )
        if not isinstance(payload, Mapping):
            raise RecommendationProviderError("Open Library books lookup returned an invalid response")
        output: dict[str, BookMetadata] = {}
        for isbn in cleaned:
            record = payload.get(f"ISBN:{isbn}")
            if not isinstance(record, Mapping):
                continue
            metadata = self._metadata_from_books_record(isbn, record)
            if metadata:
                output[isbn] = metadata
        return output

    @staticmethod
    def _metadata_from_search_document(document: Any) -> BookMetadata | None:
        if not isinstance(document, Mapping):
            return None
        title = _clean_text(document.get("title"), 300)
        isbns = _clean_isbns(document.get("isbn"))
        if not title or not isbns:
            return None
        publishers = _clean_string_tuple(document.get("publisher"), 10)
        cover_id = document.get("cover_i")
        cover_url = f"https://covers.openlibrary.org/b/id/{int(cover_id)}-M.jpg" if isinstance(cover_id, int) else ""
        year = document.get("first_publish_year")
        series = _clean_string_tuple(document.get("series"), 5)
        return BookMetadata(
            title=title,
            isbns=isbns,
            creators=_clean_string_tuple(document.get("author_name"), 20),
            subjects=_clean_string_tuple(document.get("subject"), 60),
            publisher=publishers[0] if publishers else "",
            year=int(year) if isinstance(year, int) else None,
            cover_url=cover_url,
            work_id=_clean_text(document.get("key"), 100),
            series_name=series[0] if series else "",
        )

    @staticmethod
    def _metadata_from_books_record(isbn: str, record: Mapping[str, Any]) -> BookMetadata | None:
        title = _clean_text(record.get("title"), 300)
        if not title:
            return None
        identifiers = record.get("identifiers") if isinstance(record.get("identifiers"), Mapping) else {}
        record_isbns = _clean_isbns(
            tuple(identifiers.get("isbn_10") or ()) + tuple(identifiers.get("isbn_13") or ()) + (isbn,)
        )
        cover = record.get("cover") if isinstance(record.get("cover"), Mapping) else {}
        publishers = _clean_string_tuple(record.get("publishers"), 10)
        publish_date = _clean_text(record.get("publish_date"), 100)
        year_match = re.search(r"(?:19|20)\d{2}", publish_date)
        url = _clean_text(record.get("url"), 1000)
        work_match = re.search(r"/works/([^/?#]+)", url)
        series = _clean_string_tuple(record.get("series"), 5)
        return BookMetadata(
            title=title,
            isbns=record_isbns,
            creators=_clean_string_tuple(record.get("authors"), 20),
            subjects=_clean_string_tuple(record.get("subjects"), 60),
            publisher=publishers[0] if publishers else "",
            year=int(year_match.group(0)) if year_match else None,
            cover_url=_clean_text(cover.get("medium") or cover.get("large") or cover.get("small"), 2000),
            work_id=work_match.group(1) if work_match else "",
            series_name=series[0] if series else "",
        )


class LibraryThingAdapter:
    namespace = "librarything-v1"

    def __init__(self, http: JsonHttpClient, *, api_key: str) -> None:
        api_key = str(api_key or "").strip()
        if not api_key or len(api_key) > 500:
            raise ValueError("LibraryThing API key is required")
        self._http = http
        self._api_key = api_key

    def __repr__(self) -> str:
        return "LibraryThingAdapter(api_key=<redacted>)"

    def recommend(
        self,
        resolved_seeds: Sequence[ResolvedSeed],
        *,
        limit: int = 25,
    ) -> tuple[ProviderRecommendationHit, ...]:
        seed_by_isbn: dict[str, ComicSeed] = {}
        for resolved in resolved_seeds:
            if resolved.metadata.isbns:
                seed_by_isbn[resolved.metadata.isbns[0]] = resolved.seed
        if not seed_by_isbn:
            return ()
        payload = self._http.get_json(
            LIBRARYTHING_RECOMMENDATIONS_URL,
            params={
                "apiKey": self._api_key,
                "isbns": ",".join(seed_by_isbn),
                "maxItems": str(max(1, min(50, int(limit)))),
                "maxPerAuthor": "2",
            },
            headers={"Accept": "application/json"},
        )
        if not isinstance(payload, Mapping) or payload.get("errorCode"):
            message = payload.get("shortDesc") if isinstance(payload, Mapping) else "invalid response"
            raise RecommendationProviderError(f"LibraryThing recommendations failed: {_clean_text(message, 200)}")
        request_items = payload.get("request")
        recommendations = payload.get("recommendations")
        if not isinstance(request_items, Sequence) or not isinstance(recommendations, Sequence):
            raise RecommendationProviderError("LibraryThing recommendations returned an invalid response")
        title_by_work: dict[str, str] = {}
        for item in request_items:
            if not isinstance(item, Mapping):
                continue
            isbn = next(iter(_clean_isbns((item.get("isbn"),))), "")
            work = _clean_text(item.get("work"), 100)
            if isbn in seed_by_isbn and work:
                title_by_work[work] = seed_by_isbn[isbn].title
        hits: list[ProviderRecommendationHit] = []
        for position, item in enumerate(recommendations, start=1):
            if not isinstance(item, Mapping):
                continue
            provider_id = _clean_text(item.get("work"), 100)
            isbns = _clean_isbns(item.get("isbns"))
            if not provider_id or not isbns:
                continue
            raw_rank = item.get("rank")
            rank = int(raw_rank) if isinstance(raw_rank, int) and raw_rank > 0 else position
            seed_titles = tuple(
                title_by_work[work]
                for work in _clean_string_tuple(item.get("fromworks"), 20)
                if work in title_by_work
            )
            hits.append(ProviderRecommendationHit("librarything", provider_id, rank, isbns, seed_titles))
        return tuple(sorted(hits, key=lambda hit: (hit.rank, hit.provider_id)))


class ComicRecommendationService:
    """Stateless orchestration suitable for a route-level persistent cache."""

    def __init__(
        self,
        *,
        librarything: LibraryThingAdapter,
        open_library: OpenLibraryAdapter,
        fallback: FallbackRecommendationProvider | None = None,
    ) -> None:
        self._librarything = librarything
        self._open_library = open_library
        self._fallback = fallback

    @property
    def provider_namespace(self) -> str:
        fallback_namespace = getattr(self._fallback, "namespace", "none")
        return f"{self._librarything.namespace}+{self._open_library.namespace}+{fallback_namespace}"

    def cache_key(self, seeds: Sequence[ComicSeed], *, limit: int = 12) -> str:
        return recommendation_cache_key(seeds, limit=limit, provider_namespace=self.provider_namespace)

    def build_feed(self, seeds: Sequence[ComicSeed], *, limit: int = 12) -> RecommendationFeed:
        clean_seeds = tuple(seeds)
        clean_limit = max(1, min(30, int(limit)))
        excluded = frozenset(title_key(seed.title) for seed in clean_seeds)
        results: list[ComicRecommendation] = []
        primary_failed = False
        try:
            resolved = tuple(
                match
                for seed in clean_seeds
                if (match := self._open_library.resolve_seed(seed)) is not None
            )
            hits = self._librarything.recommend(resolved, limit=max(25, clean_limit * 2))
            lookup_isbns = tuple(isbn for hit in hits for isbn in hit.isbns[:3])
            metadata_by_isbn = self._open_library.lookup_isbns(lookup_isbns)
            for hit in hits:
                metadata = next((metadata_by_isbn[isbn] for isbn in hit.isbns if isbn in metadata_by_isbn), None)
                if metadata is None or not is_comic_metadata(metadata.subjects):
                    continue
                base_title = base_series_title(metadata.title)
                if title_key(base_title) in excluded:
                    continue
                results.append(ComicRecommendation(
                    provider=hit.provider,
                    provider_id=hit.provider_id,
                    title=metadata.title,
                    search_titles=tuple(dict.fromkeys((base_title, metadata.title))),
                    cover_url=metadata.cover_url,
                    creators=metadata.creators,
                    year=metadata.year,
                    seed_titles=hit.seed_titles,
                    isbns=metadata.isbns or hit.isbns,
                    rank=hit.rank,
                ))
        except Exception:
            primary_failed = True

        collapsed = list(collapse_duplicate_editions(results))
        if self._fallback and len(collapsed) < clean_limit:
            fallback_exclusions = frozenset((*excluded, *(title_key(item.title) for item in collapsed)))
            try:
                fallback_results = self._fallback.recommend(
                    clean_seeds,
                    excluded_title_keys=fallback_exclusions,
                    limit=clean_limit - len(collapsed),
                )
            except Exception:
                fallback_results = ()
            for item in fallback_results:
                if title_key(item.title) in fallback_exclusions:
                    continue
                collapsed.append(item)
                fallback_exclusions = frozenset((*fallback_exclusions, title_key(item.title)))
                if len(collapsed) >= clean_limit:
                    break

        final_results = tuple(collapsed[:clean_limit])
        if primary_failed and not final_results:
            mode = "unavailable"
        elif final_results and (primary_failed or all(item.provider != "librarything" for item in final_results)):
            mode = "fallback"
        else:
            mode = "personalized"
        return RecommendationFeed(
            mode=mode,
            seed_titles=tuple(seed.title for seed in clean_seeds),
            results=final_results,
            cache_key=self.cache_key(clean_seeds, limit=clean_limit),
        )


__all__ = [
    "BookMetadata",
    "ComicRecommendation",
    "ComicRecommendationService",
    "ComicSeed",
    "FallbackRecommendationProvider",
    "JsonHttpClient",
    "LibraryThingAdapter",
    "OpenLibraryAdapter",
    "ProviderRecommendationHit",
    "RecommendationError",
    "RecommendationFeed",
    "RecommendationProviderError",
    "ResolvedSeed",
    "base_series_title",
    "choose_seed_match",
    "collapse_duplicate_editions",
    "is_comic_metadata",
    "normalize_title",
    "recommendation_cache_key",
    "score_seed_candidate",
    "title_key",
]
