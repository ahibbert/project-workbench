#!/usr/bin/env python3
"""Build a diverse, repeatable detector test manifest from a Suwayomi library."""

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request


LIBRARY_QUERY = """
query GET_LIBRARY_MANGAS {
  mangas(condition: { inLibrary: true }, first: 500) {
    nodes {
      id title sourceId
      source { name displayName lang }
    }
  }
}
"""

CHAPTERS_QUERY = """
mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
  fetchChapters(input: $input) {
    chapters {
      id name mangaId scanlator sourceOrder chapterNumber pageCount
      isRead lastPageRead isDownloaded isBookmarked
    }
  }
}
"""


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="https://panels.aydins-workbench.com")
    parser.add_argument("--base", default="http://localhost:4567")
    parser.add_argument("--username", default=os.environ.get("PANEL_PILOT_AUTH_USER", ""))
    parser.add_argument("--password", default=os.environ.get("PANEL_PILOT_AUTH_PASSWORD", ""))
    parser.add_argument("--chapters-per-title", type=int, default=3)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def session(app, username, password):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    login = urllib.parse.urlencode({"username": username, "password": password}).encode()
    opener.open(urllib.request.Request(f"{app}/login", data=login), timeout=30).read()
    return opener


def graphql(opener, app, base, query, variables=None):
    url = f"{app}/api/suwayomi/graphql?base={urllib.parse.quote(base, safe='')}"
    body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError(payload["errors"])
    return payload["data"]


def chapter_number(chapter):
    for key in ("chapterNumber", "sourceOrder"):
        try:
            return float(chapter.get(key) or 0)
        except (TypeError, ValueError):
            pass
    return float(chapter["id"])


def spread_indices(length, count):
    if length <= count:
        return list(range(length))
    if count == 1:
        return [length - 1]
    return sorted({round(index * (length - 1) / (count - 1)) for index in range(count)})


def choose_chapters(chapters, count):
    available = sorted(chapters, key=chapter_number)
    if not available:
        return []
    selected = []
    active = [chapter for chapter in available if chapter.get("lastPageRead", 0) > 0 or chapter.get("isBookmarked")]
    if active:
        selected.append(active[-1])
    for index in spread_indices(len(available), count):
        candidate = available[index]
        if candidate["id"] not in {chapter["id"] for chapter in selected}:
            selected.append(candidate)
        if len(selected) >= count:
            break
    if len(selected) < count:
        for candidate in reversed(available):
            if candidate["id"] not in {chapter["id"] for chapter in selected}:
                selected.append(candidate)
            if len(selected) >= count:
                break
    return sorted(selected, key=chapter_number)


def main():
    args = arguments()
    if not args.username or not args.password:
        raise SystemExit("PANEL_PILOT_AUTH_USER and PANEL_PILOT_AUTH_PASSWORD are required")
    opener = session(args.app, args.username, args.password)
    mangas = graphql(opener, args.app, args.base, LIBRARY_QUERY)["mangas"]["nodes"]
    manifest = {"format": 1, "mode": "manga", "chapters_per_title": args.chapters_per_title, "titles": []}
    for manga in sorted(mangas, key=lambda item: item["title"].casefold()):
        source = manga.get("source") or {}
        try:
            data = graphql(opener, args.app, args.base, CHAPTERS_QUERY, {"input": {"mangaId": manga["id"]}})
            chapters = data["fetchChapters"]["chapters"]
        except Exception as error:
            manifest["titles"].append({
                "manga_id": manga["id"],
                "title": manga["title"],
                "source_id": manga.get("sourceId"),
                "source": source.get("displayName") or source.get("name"),
                "available_chapters": 0,
                "chapters": [],
                "error": str(error),
            })
            print(f"{manga['title']}: unavailable ({error})")
            continue
        chosen = choose_chapters(chapters, args.chapters_per_title)
        manifest["titles"].append({
            "manga_id": manga["id"],
            "title": manga["title"],
            "source_id": manga.get("sourceId"),
            "source": source.get("displayName") or source.get("name"),
            "available_chapters": len(chapters),
            "chapters": [{
                "id": chapter["id"],
                "number": chapter.get("chapterNumber"),
                "name": chapter.get("name"),
                "page_count": chapter.get("pageCount"),
                "is_read": chapter.get("isRead"),
                "last_page_read": chapter.get("lastPageRead"),
            } for chapter in chosen],
        })
        print(f"{manga['title']}: {len(chapters)} available, {len(chosen)} selected")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
