#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATE = {
    "previous": None,
    "updated": None,
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Source-Url, X-Source-Title")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/state":
            self.respond_json(
                {
                    "slots": STATE,
                    "server_time": now_iso(),
                }
            )
            return

        if parsed.path == "/api/reset":
            STATE["previous"] = None
            STATE["updated"] = None
            self.respond_json({"ok": True})
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/import-json":
            self.handle_import_json(parsed)
            return

        self.send_error(404, "Not found")

    def handle_import_json(self, parsed):
        query = parse_qs(parsed.query)
        slot = query.get("slot", [""])[0]
        if slot not in STATE:
          self.send_error(400, "slot must be previous or updated")
          return

        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length).decode("utf-8")

        STATE[slot] = {
            "content": payload,
            "source_url": self.headers.get("X-Source-Url", ""),
            "source_title": self.headers.get("X-Source-Title", ""),
            "updated_at": now_iso(),
        }
        self.respond_json({"ok": True, "slot": slot, "updated_at": STATE[slot]["updated_at"]})

    def respond_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving Optibus comparison app at http://127.0.0.1:{port}")
    server.serve_forever()
