"""Sortie des publications : API officielles si configurées, sinon export local prêt à publier."""
import shutil
import time
from datetime import datetime
from pathlib import Path

from . import config, connectors, llm, store


def export_post(post_id: int) -> Path:
    post = store.get_post(post_id)
    if not post:
        raise KeyError(f"Publication {post_id} introuvable")
    folder = config.EXPORT_DIR / f"{post_id:04d}-{post['network']}"
    folder.mkdir(parents=True, exist_ok=True)
    content = (f"{post['title']}\n\n" if post["title"] else "") + post["text"]
    if post["hashtags"]:
        content += f"\n\n{post['hashtags']}"
    (folder / "publication.txt").write_text(content, encoding="utf-8")
    if post["reel_path"] and Path(post["reel_path"]).exists():
        shutil.copy(post["reel_path"], folder / "reel.mp4")
    store.update_post(post_id, status="exporte")
    return folder


def publish_post(post_id: int) -> str:
    """Publie via l'API du réseau. Sans configuration, exporte. Retourne un message lisible."""
    post = store.get_post(post_id)
    if not post:
        raise KeyError(f"Publication {post_id} introuvable")
    try:
        ext = connectors.publish(post)
    except connectors.NotConfigured as e:
        folder = export_post(post_id)
        return f"{e} Exporté dans {folder}."
    except connectors.PublishError as e:
        store.update_post(post_id, status="echec", error=str(e))
        raise
    store.update_post(post_id, status="publie", external_id=str(ext), error="")
    return f"Publié sur {post['network']} (id {ext})."


def schedule(post_id: int, when: str) -> float:
    """Programme une publication ('AAAA-MM-JJ HH:MM', heure locale) et l'approuve."""
    try:
        ts = datetime.strptime(when, "%Y-%m-%d %H:%M").timestamp()
    except ValueError as e:
        raise ValueError("Format attendu : AAAA-MM-JJ HH:MM (ex. 2026-11-02 18:30)") from e
    if not store.get_post(post_id):
        raise KeyError(f"Publication {post_id} introuvable")
    store.update_post(post_id, scheduled_at=ts, status="approuve")
    return ts


def run_due(now: float | None = None) -> list[str]:
    """Traite les publications programmées arrivées à échéance. Hors ligne : elles attendent."""
    due = store.due_posts(now)
    if not due:
        return []
    if not llm.is_online():
        return [f"Hors ligne : {len(due)} publication(s) en attente de connexion."]
    out = []
    for p in due:
        try:
            out.append(f"#{p['id']} {publish_post(p['id'])}")
        except connectors.PublishError as e:
            out.append(f"#{p['id']} échec : {e}")
    return out
