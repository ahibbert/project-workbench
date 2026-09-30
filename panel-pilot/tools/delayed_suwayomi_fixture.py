"""Small delayed GraphQL fixture used by reader cancellation smoke tests."""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        time.sleep(3)
        query = request.get("query", "")
        if "GET_CHAPTER_PAGES_FETCH" in query:
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
