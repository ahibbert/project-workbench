#!/usr/bin/env python3
"""Download sampled pages for a private Suwayomi detector regression corpus."""

import argparse
import http.cookiejar
import io
import json
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request

from PIL import Image


PAGES_QUERY = """
mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
  fetchChapterPages(input: $input) {
    chapter { id name realUrl manga { title source { name displayName } } }
    pages
  }
}
"""


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--app", default="https://panels.aydins-workbench.com")
    parser.add_argument("--base", default="http://localhost:4567")
    parser.add_argument("--username", default=os.environ.get("PANEL_PILOT_AUTH_USER", ""))
    parser.add_argument("--password", default=os.environ.get("PANEL_PILOT_AUTH_PASSWORD", ""))
    parser.add_argument("--pages-per-chapter", type=int, default=3)
    return parser.parse_args()


def session(app, username, password):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    login = urllib.parse.urlencode({"username": username, "password": password}).encode()
    opener.open(urllib.request.Request(f"{app}/login", data=login), timeout=30).read()
    return opener


def request_json(opener, url, body):
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError(payload["errors"])
    return payload["data"]


def graphql(opener, app, base, query, variables):
    url = f"{app}/api/suwayomi/graphql?base={urllib.parse.quote(base, safe='')}"
    return request_json(opener, url, {"query": query, "variables": variables})


def asset_url(app, base, raw_url):
    if raw_url.startswith("/api/image"):
        return urllib.parse.urljoin(app + "/", raw_url.lstrip("/"))
    if raw_url.startswith("http"):
        parsed = urllib.parse.urlparse(raw_url)
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
    else:
        path = raw_url if raw_url.startswith("/") else "/" + raw_url
    return f"{app}/api/suwayomi/asset?base={urllib.parse.quote(base, safe='')}&path={urllib.parse.quote(path, safe='')}"


def spread_indices(length, count):
    if length <= count:
        return list(range(length))
    if count == 1:
        return [length // 2]
    return sorted({round(index * (length - 1) / (count - 1)) for index in range(count)})


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")[:48] or "manga"


def main():
    args = arguments()
    if not args.username or not args.password:
        raise SystemExit("PANEL_PILOT_AUTH_USER and PANEL_PILOT_AUTH_PASSWORD are required")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    opener = session(args.app, args.username, args.password)
    page_dir = args.out / "pages"
    page_dir.mkdir(parents=True, exist_ok=True)
    corpus = {"format": 1, "mode": "manga", "pages_per_chapter": args.pages_per_chapter, "pages": [], "errors": []}

    for title in manifest["titles"]:
        for chapter in title.get("chapters", []):
            try:
                data = graphql(opener, args.app, args.base, PAGES_QUERY, {"input": {"chapterId": chapter["id"]}})
                fetched = data["fetchChapterPages"]
                pages = fetched.get("pages") or []
                if not pages:
                    raise RuntimeError("chapter returned no page URLs")
                sampled_indices = spread_indices(len(pages), args.pages_per_chapter)
                for page_index in sampled_indices:
                    url = asset_url(args.app, args.base, pages[page_index])
                    with opener.open(urllib.request.Request(url, headers={"Accept": "image/*"}), timeout=120) as response:
                        image = Image.open(io.BytesIO(response.read())).convert("RGB")
                    filename = (
                        f"{slug(title['title'])}--m{title['manga_id']}--c{chapter['id']}--p{page_index + 1:03d}.jpg"
                    )
                    image.save(page_dir / filename, quality=94, optimize=True)
                    corpus["pages"].append({
                        "file": filename,
                        "manga_id": title["manga_id"],
                        "title": title["title"],
                        "source": title.get("source"),
                        "chapter_id": chapter["id"],
                        "chapter_number": chapter.get("number"),
                        "page": page_index + 1,
                        "chapter_pages": len(pages),
                    })
                print(f"{title['title']} chapter {chapter.get('number')}: sampled {len(sampled_indices)}/{len(pages)} pages")
            except Exception as error:
                corpus["errors"].append({"title": title["title"], "chapter_id": chapter["id"], "error": str(error)})
                print(f"{title['title']} chapter {chapter.get('number')}: ERROR {error}")

    (args.out / "corpus.json").write_text(json.dumps(corpus, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"pages": len(corpus["pages"]), "errors": len(corpus["errors"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
