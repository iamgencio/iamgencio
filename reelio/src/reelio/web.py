"""Interface web locale (aucune dépendance) : http://127.0.0.1:8765"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources

from . import config, connectors, copywriter, pipeline, publisher, store


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
                ids, warnings = pipeline.create(idea, data.get("reseaux"), bool(data.get("reel") or data.get("voix") or data.get("musique")),
                                                bool(data.get("voix")), bool(data.get("musique")))
                self._json({"ids": ids, "avertissement": " ".join(warnings) or None})
            elif self.path.startswith("/api/posts/") and self.path.endswith("/update"):
                pid = int(self.path.split("/")[3])
                store.update_post(pid, **data)
                self._json({"ok": True})
            elif self.path.startswith("/api/posts/") and self.path.endswith("/export"):
                pid = int(self.path.split("/")[3])
                self._json({"dossier": str(publisher.export_post(pid))})
            elif self.path.startswith("/api/posts/") and self.path.endswith("/publish"):
                pid = int(self.path.split("/")[3])
                self._json({"message": publisher.publish_post(pid)})
            elif self.path.startswith("/api/posts/") and self.path.endswith("/schedule"):
                pid = int(self.path.split("/")[3])
                publisher.schedule(pid, str(data.get("quand", "")))
                self._json({"ok": True})
            else:
                self._send(404, b"{}")
        except (ValueError, KeyError, RuntimeError, connectors.PublishError) as e:
            self._json({"erreur": str(e)}, 400)


def run(port: int = 8765) -> None:
    config.ensure_dirs()
    def tick() -> None:  # publie à l'heure les publications programmées
        while True:
            try:
                publisher.run_due()
            except Exception as e:  # le serveur ne doit jamais s'arrêter à cause d'un réseau
                print(f"Agent : {e}")
            time.sleep(60)

    threading.Thread(target=tick, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)  # local uniquement
    print(f"Reelio — http://127.0.0.1:{port}  (Ctrl+C pour arrêter)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
