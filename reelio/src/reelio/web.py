"""Interface web locale (aucune dépendance) : http://127.0.0.1:8765"""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources

from . import config, copywriter, publisher, reel, store


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode())

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, *a) -> None:  # silence
        pass

    def do_GET(self) -> None:
        if self.path == "/":
            html = resources.files("reelio").joinpath("static/index.html").read_bytes()
            self._send(200, html, "text/html")
        elif self.path == "/api/posts":
            self._json(store.list_posts())
        elif self.path == "/api/networks":
            self._json({k: v["label"] for k, v in copywriter.NETWORKS.items()})
        else:
            self._send(404, b"{}")

    def do_POST(self) -> None:
        try:
            data = self._body()
            if self.path == "/api/generate":
                idea = str(data.get("idee", "")).strip()
                if not idea:
                    return self._json({"erreur": "Écrivez d'abord une idée."}, 400)
                reel_path = ""
                if data.get("reel"):
                    reel_path = str(reel.make_reel(
                        reel.script_from_idea(idea), config.REELS_DIR / f"reel-{int(time.time())}.mp4"))
                posts, warning = copywriter.generate(idea, data.get("reseaux"))
                ids = [store.add_post(idea, n, p.text, p.hashtags, p.title, reel_path)
                       for n, p in posts.items()]
                self._json({"ids": ids, "avertissement": warning})
            elif self.path.startswith("/api/posts/") and self.path.endswith("/update"):
                pid = int(self.path.split("/")[3])
                store.update_post(pid, **data)
                self._json({"ok": True})
            elif self.path.startswith("/api/posts/") and self.path.endswith("/export"):
                pid = int(self.path.split("/")[3])
                self._json({"dossier": str(publisher.export_post(pid))})
            else:
                self._send(404, b"{}")
        except (ValueError, KeyError, RuntimeError) as e:
            self._json({"erreur": str(e)}, 400)


def run(port: int = 8765) -> None:
    config.ensure_dirs()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)  # local uniquement
    print(f"Reelio — http://127.0.0.1:{port}  (Ctrl+C pour arrêter)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
