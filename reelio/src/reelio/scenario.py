"""Scénario de reel écrit par l'IA : texte à l'écran + phrase de voix off pour chaque scène."""
import json

from . import config, llm


def fallback(idea: str) -> list[dict]:
    parts = [p.strip() for p in idea.replace("\n", ". ").split(".") if p.strip()][:6] or [idea]
    return [{"texte": p, "voix": p} for p in parts]


def write(idea: str, scenes: int = 5) -> tuple[list[dict], str | None]:
    """Retourne (scènes, avertissement). Chaque scène : {"texte": ..., "voix": ...}."""
    system = (f"Tu es un scénariste de reels francophone. Domaine : {config.NICHE}. Ton : {config.TONE}.")
    prompt = (
        f"Idée : {idea}\n\nÉcris un reel de {scenes} scènes : une accroche, des points utiles, "
        "un appel à l'action final. Pour chaque scène : \"texte\" (à l'écran, 12 mots maximum) et "
        "\"voix\" (phrase naturelle à dire à voix haute, 25 mots maximum).\n"
        'Réponds uniquement en JSON : {"scenes": [{"texte": "...", "voix": "..."}]}'
    )
    try:
        data = json.loads(llm.ask(prompt, system))
        out = [{"texte": str(s["texte"]).strip(), "voix": str(s.get("voix") or s["texte"]).strip()}
               for s in data["scenes"] if str(s.get("texte", "")).strip()][:8]
        if out:
            return out, None
    except (llm.LLMUnavailable, json.JSONDecodeError, KeyError, TypeError, AttributeError):
        pass
    return fallback(idea), "Scénario simple (aucun modèle IA disponible) : à retoucher."
