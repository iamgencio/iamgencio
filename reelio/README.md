<p align="center"><img src="brand/reelio-logo-dark.svg" alt="Reelio" width="420"></p>

<p align="center"><b>Une idée. Cinq réseaux.</b></p>

Reelio est un agent IA qui produit et publie du contenu social à partir d'une simple idée :

- textes de publication et hashtags adaptés à chaque réseau ;
- vidéos reels verticales ;
- publication ou programmation sur **Facebook, Instagram, X, YouTube et TikTok**.

> Statut : première version fonctionnelle (v0.1), conçue pour tourner **sur ton PC, même sans connexion**.

## Ce que fait Reelio (v0.2)
- **Textes et hashtags** adaptés à chaque réseau, limites de caractères respectées (sur X, hashtags inclus).
- **Reels MP4 verticaux** (1080×1920) : scénario écrit par l'IA, **voix off** (synthèse vocale locale) et **musique d'ambiance** générée sans droit d'auteur. La durée de chaque scène s'adapte à la lecture.
- **Visuels de marque** : cartes carrées, portrait, miniatures YouTube et images X.
- **Publication** via les API officielles quand le réseau est configuré, sinon **export** d'un paquet prêt à publier.
- **Programmation** : l'agent publie à l'heure, et attend la connexion si tu es hors ligne.
- Tout est stocké en local (SQLite). Interface web locale et ligne de commande, en français.

## Installation (Windows, macOS, Linux)
1. Installer [Python 3.10+](https://www.python.org/downloads/), [ffmpeg](https://ffmpeg.org/download.html) et [Ollama](https://ollama.com) (l'IA locale).
2. Télécharger un modèle : `ollama pull qwen2.5:7b` (une seule fois, avec internet).
3. Dans ce dossier : `pip install -e .`
4. Voix off : sous Windows et macOS, la voix du système est utilisée. Sous Linux : `sudo apt install espeak-ng`. Option plus naturelle : [Piper](https://github.com/rhasspy/piper) avec `REELIO_PIPER_MODEL`.

## Utilisation
```
reelio serveur                                     # interface web : http://127.0.0.1:8765
reelio generer "ton idée" --reel --voix --musique  # textes + reel complet
reelio visuel "Titre" --sous-titre "…" --format miniature
reelio planifier 3 "2026-11-02 18:30"              # programmer la publication #3
reelio agent                                       # publie à l'heure (ou garde le serveur web ouvert)
reelio publier 3                                   # publier tout de suite
reelio liste / reelio exporter 3
```
Sans Ollama, Reelio produit des brouillons simples à retoucher. Avec `OPENROUTER_API_KEY`, il peut utiliser un modèle en ligne (ex. DeepSeek) en secours.

Variables utiles : `REELIO_MODEL`, `REELIO_NICHE`, `REELIO_TONE`, `REELIO_DATA` (défaut `~/.reelio`).

## Connecter les réseaux
Chaque réseau se configure par variables d'environnement (voir l'en-tête de `src/reelio/connectors.py`). Sans jeton, Reelio exporte au lieu de publier.

| Réseau | Variables | À savoir |
|---|---|---|
| X | `X_ACCESS_TOKEN` | texte seul (pas de vidéo pour l'instant) |
| Facebook | `FB_PAGE_ID`, `FB_PAGE_TOKEN` | Page uniquement, texte ou vidéo |
| Instagram | `IG_USER_ID`, `IG_TOKEN`, `REELIO_PUBLIC_URL` | la vidéo doit être accessible par une adresse publique |
| YouTube | `YT_ACCESS_TOKEN` | vidéos **privées** par défaut (`REELIO_YT_PRIVACY`) |
| TikTok | `TIKTOK_ACCESS_TOKEN` | vidéos **privées** (`SELF_ONLY`) tant que l'application n'est pas auditée par TikTok |

> **Non testé en réel** : les connecteurs suivent la documentation officielle et sont couverts par des tests avec de fausses réponses, mais n'ont pas été essayés sur de vrais comptes. Teste d'abord avec une Page ou un compte secondaire. Respecte les conditions d'utilisation de chaque plateforme (rythme humain, pas de spam).

## Tests
`PYTHONPATH=src python -m unittest discover -s tests`

## Feuille de route
1. [x] Nom, logo et identité visuelle
2. [x] Architecture locale (Python, Ollama, SQLite, ffmpeg)
3. [x] Textes et hashtags par réseau
4. [x] Reels : scénario IA, voix off, musique
5. [x] Visuels de marque
6. [x] Connecteurs API et programmation (à valider sur de vrais comptes)
7. [ ] Vidéo sur X, publication Instagram sans hébergement public
8. [ ] Images générées par IA locale, sous-titres animés
9. [ ] Application installable (.exe) et licence pour la commercialisation

Voir le [guide de marque](brand/BRAND.md).
