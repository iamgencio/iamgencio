"""Rédaction des publications et hashtags, adaptés à chaque réseau."""
import json
import re
from dataclasses import dataclass, field

from . import config, llm

# Contraintes par réseau : limite de caractères du texte, nombre de hashtags conseillé.
NETWORKS = {
    "facebook": {"label": "Facebook", "max_chars": 800, "hashtags": 3,
                 "style": "conversationnel, paragraphes courts, question finale pour susciter les commentaires"},
    "instagram": {"label": "Instagram", "max_chars": 1500, "hashtags": 12,
                  "style": "accroche forte dès la première ligne, emojis dosés, appel à l'action"},
    "x": {"label": "X (Twitter)", "max_chars": 280, "hashtags": 2,
          "style": "percutant, une seule idée, très concis"},
    "youtube": {"label": "YouTube", "max_chars": 1000, "hashtags": 5,
                "style": "titre accrocheur (max 100 caractères) puis description claire"},
    "tiktok": {"label": "TikTok", "max_chars": 150, "hashtags": 4,
               "style": "légende très courte, ton vivant, hashtags tendance"},
}


@dataclass
class Post:
    network: str
    text: str
    hashtags: list[str] = field(default_factory=list)
    title: str = ""

    def full_text(self) -> str:
        tags = " ".join(self.hashtags)
        return f"{self.text}\n\n{tags}" if tags else self.text


def clean_hashtag(tag: str) -> str:
    tag = re.sub(r"[^\w]", "", tag.strip().lstrip("#"), flags=re.UNICODE)
    return f"#{tag}" if tag else ""


def _normalize(network: str, raw: dict) -> Post:
    spec = NETWORKS[network]
    text = str(raw.get("texte") or raw.get("text") or "").strip()
    tags = [clean_hashtag(t) for t in raw.get("hashtags", [])]
    tags = list(dict.fromkeys(t for t in tags if t))[: spec["hashtags"]]
    limit = spec["max_chars"]
    if network == "x":  # sur X, les hashtags comptent dans les 280 caractères
        limit -= len(" ".join(tags)) + 2 if tags else 0
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return Post(network, text, tags, str(raw.get("titre") or raw.get("title") or "").strip()[:100])


def _fallback(idea: str, network: str) -> Post:
    """Brouillon simple quand aucun modèle n'est disponible : à retoucher à la main."""
    spec = NETWORKS[network]
    base = {"facebook": f"{idea}\n\nEt vous, qu'en pensez-vous ? Dites-le-nous en commentaire !",
            "instagram": f"{idea}\n\nEnregistrez ce post et partagez-le avec quelqu'un à qui il servira.",
            "x": idea, "youtube": f"{idea}\n\nAbonnez-vous pour ne rien manquer.",
            "tiktok": idea}[network]
    words = ["communitymanagement", "creation", "web", "appmobile", "digital", "marketing",
             "contenu", "reels", "astuces", "entrepreneur", "design", "reseauxsociaux"]
    tags = [clean_hashtag(w) for w in words][: spec["hashtags"]]
    title = idea[:100] if network == "youtube" else ""
    post = _normalize(network, {"texte": base, "hashtags": tags, "titre": title})
    return post


def generate(idea: str, networks: list[str] | None = None) -> tuple[dict[str, Post], str | None]:
    """Retourne (publications par réseau, avertissement éventuel)."""
    networks = [n for n in (networks or list(NETWORKS)) if n in NETWORKS]
    spec_lines = "\n".join(
        f'- "{n}": max {NETWORKS[n]["max_chars"]} caractères, {NETWORKS[n]["hashtags"]} hashtags, '
        f'style {NETWORKS[n]["style"]}' for n in networks
    )
    system = (
        "Tu es un community manager créatif francophone. "
        f"Domaine : {config.NICHE}. Ton : {config.TONE}. "
        "Tu écris en français naturel, sans clichés ni promesses exagérées."
    )
    prompt = (
        f"Idée de publication : {idea}\n\n"
        f"Écris une publication par réseau :\n{spec_lines}\n\n"
        'Réponds uniquement en JSON : {"<reseau>": {"texte": "...", "hashtags": ["..."], '
        '"titre": "... (YouTube seulement)"}}'
    )
    try:
        data = json.loads(llm.ask(prompt, system))
        posts = {n: _normalize(n, data[n]) for n in networks if isinstance(data.get(n), dict)}
        missing = [n for n in networks if n not in posts]
        for n in missing:
            posts[n] = _fallback(idea, n)
        warning = f"Brouillon simple pour : {', '.join(missing)}" if missing else None
        return posts, warning
    except (llm.LLMUnavailable, json.JSONDecodeError, TypeError):
        warning = ("Aucun modèle IA disponible (Ollama éteint ?). Brouillons simples générés : "
                   "à retoucher avant publication.")
        return {n: _fallback(idea, n) for n in networks}, warning
