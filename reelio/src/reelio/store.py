"""Stockage local SQLite : brouillons, file d'attente et historique."""
import sqlite3
import time

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea TEXT NOT NULL,
  network TEXT NOT NULL,
  title TEXT DEFAULT '',
  text TEXT NOT NULL,
  hashtags TEXT DEFAULT '',
  reel_path TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'brouillon',
  created_at REAL NOT NULL
)"""
STATUSES = ("brouillon", "approuve", "exporte", "publie", "echec")


def connect() -> sqlite3.Connection:
    config.ensure_dirs()
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute(SCHEMA)
    return con


def add_post(idea, network, text, hashtags, title="", reel_path="") -> int:
    with connect() as con:
        cur = con.execute(
            "INSERT INTO posts (idea, network, title, text, hashtags, reel_path, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (idea, network, title, text, " ".join(hashtags), str(reel_path), time.time()))
        return cur.lastrowid


def list_posts(status: str | None = None) -> list[dict]:
    with connect() as con:
        q, args = "SELECT * FROM posts", ()
        if status:
            q, args = q + " WHERE status=?", (status,)
        return [dict(r) for r in con.execute(q + " ORDER BY id DESC", args)]


def get_post(post_id: int) -> dict | None:
    with connect() as con:
        row = con.execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone()
        return dict(row) if row else None


def update_post(post_id: int, **fields) -> None:
    allowed = {"title", "text", "hashtags", "reel_path", "status"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if fields.get("status") and fields["status"] not in STATUSES:
        raise ValueError(f"Statut inconnu : {fields['status']}")
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    with connect() as con:
        con.execute(f"UPDATE posts SET {sets} WHERE id=?", (*fields.values(), post_id))
