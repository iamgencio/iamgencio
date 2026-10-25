"""Enchaînement commun à la ligne de commande et à l'interface web."""
import time

from . import config, copywriter, reel, scenario, store


def create(idea: str, networks: list[str] | None = None, with_reel: bool = False,
           voice: bool = False, music: bool = False) -> tuple[list[int], list[str]]:
    """Génère publications (+ reel). Retourne (ids, avertissements)."""
    warnings: list[str] = []
    reel_path = ""
    if with_reel:
        scenes, warn = scenario.write(idea)
        if warn:
            warnings.append(warn)
        reel_path = str(reel.make_reel(scenes, config.REELS_DIR / f"reel-{int(time.time())}.mp4",
                                       voice=voice, music=music))
    posts, warn = copywriter.generate(idea, networks)
    if warn:
        warnings.append(warn)
    ids = [store.add_post(idea, n, p.text, p.hashtags, p.title, reel_path) for n, p in posts.items()]
    return ids, warnings
