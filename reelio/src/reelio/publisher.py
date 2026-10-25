"""Sortie des publications.

Version actuelle : export local d'un « paquet prêt à publier » (texte + vidéo) par réseau.
Les connecteurs API officiels (Meta, X, YouTube, TikTok) viendront s'ajouter ici ; ils
nécessitent la création d'applications développeur et une validation par chaque plateforme.
"""
import shutil
from pathlib import Path

from . import config, store


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
