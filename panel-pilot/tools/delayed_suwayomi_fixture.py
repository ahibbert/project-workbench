"""Small delayed GraphQL fixture used by reader cancellation smoke tests."""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        query = request.get("query", "")
        if "GET_CHAPTER_PAGES_FETCH" in query:
            time.sleep(3)
            payload = {
                "data": {
                    "fetchChapterPages": {
                        "chapter": {"id": 12, "name": "Delayed test chapter", "pageCount": 1},
                        "pages": [
                            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'%3E%3Crect width='800' height='1200' fill='white'/%3E%3C/svg%3E"
                        ],
                    }
                }
            }
        elif "__schema" in query:
            payload = {"data": {"__schema": {"queryType": {"name": "Query"}, "mutationType": {"name": "Mutation"}}}}
        elif "GET_SOURCES_LIST" in query:
            payload = {
                "data": {
                    "sources": {
                        "nodes": [{
                            "id": "fixture-source",
                            "name": "Fixture Manga",
                            "displayName": "Fixture Manga",
                            "lang": "en",
                            "isNsfw": False,
                            "supportsLatest": True,
                        }]
                    }
                }
            }
        elif "GET_SOURCE_MANGAS_FETCH" in query:
            title = str(request.get("variables", {}).get("input", {}).get("query") or "Fixture Manga")
            payload = {
                "data": {
                    "fetchSourceManga": {
                        "hasNextPage": False,
                        "mangas": [{
                            "id": 101,
                            "title": title,
                            "thumbnailUrl": "",
                            "inLibrary": False,
                            "initialized": True,
                            "sourceId": "fixture-source",
                        }],
                    }
                }
            }
        elif "GET_MANGA_CHAPTERS_FETCH" in query:
            payload = {
                "data": {
                    "fetchChapters": {
                        "chapters": [{
                            "id": 12,
                            "name": "Chapter 1",
                            "mangaId": 101,
                            "scanlator": "Fixture",
                            "sourceOrder": 1,
                            "chapterNumber": 1,
                            "pageCount": 1,
                            "isRead": False,
                            "lastPageRead": 0,
                            "isDownloaded": True,
                            "isBookmarked": False,
                        }]
                    }
                }
            }
        elif "UPDATE_MANGA_LIBRARY" in query:
            payload = {"data": {"updateManga": {"manga": {"id": 101, "inLibrary": True}}}}
        elif "GET_LIBRARY_MANGAS" in query:
            payload = {"data": {"mangas": {"totalCount": 0, "nodes": []}}}
        else:
            payload = {"data": {}}
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4568
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
