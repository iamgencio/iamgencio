<p align="center"><img src="brand/reelio-logo-dark.svg" alt="Reelio" width="420"></p>

<p align="center"><b>Une idée. Cinq réseaux.</b></p>

Reelio est un agent IA qui produit et publie du contenu social à partir d'une simple idée :

- textes de publication et hashtags adaptés à chaque réseau ;
- vidéos reels verticales ;
- publication ou programmation sur **Facebook, Instagram, X, YouTube et TikTok**.

> Statut : première version fonctionnelle (v0.1), conçue pour tourner **sur ton PC, même sans connexion**.

## Ce que fait la v0.1
- Génère un texte + des hashtags adaptés à chaque réseau (limites de caractères respectées, X compris).
- Crée un **reel vertical 1080×1920** (MP4) aux couleurs de Reelio.
- Garde tout en local (SQLite) : brouillons, modification, approbation.
- **Exporte** un paquet prêt à publier (texte + vidéo) par réseau. La publication automatique via les API officielles arrive ensuite.
- Interface web locale et ligne de commande, en français.

## Installation (Windows, macOS, Linux)
1. Installer [Python 3.10+](https://www.python.org/downloads/), [ffmpeg](https://ffmpeg.org/download.html) et [Ollama](https://ollama.com) (l'IA locale).
2. Télécharger un modèle : `ollama pull qwen2.5:7b` (une seule fois, avec internet).
3. Dans ce dossier : `pip install -e .`

## Utilisation
```
reelio serveur                      # interface web : http://127.0.0.1:8765
reelio generer "ton idée" --reel    # en ligne de commande
reelio liste
reelio exporter 3
```
Sans Ollama, Reelio produit des brouillons simples à retoucher. Avec une clé `OPENROUTER_API_KEY`, il peut utiliser un modèle en ligne (ex. DeepSeek) en secours.

Variables utiles : `REELIO_MODEL`, `REELIO_NICHE`, `REELIO_TONE`, `REELIO_DATA` (dossier de données, défaut `~/.reelio`).

## Tests
`PYTHONPATH=src python -m unittest discover -s tests`

## Feuille de route
1. [x] Nom, logo et identité visuelle
2. [x] Architecture locale (Python, Ollama, SQLite, ffmpeg)
3. [x] Textes et hashtags par réseau
4. [x] Reels vidéo (diapositives animées)
5. [x] Validation humaine avant export
6. [ ] Scénario de reel écrit par l'IA, voix off et musique
7. [ ] Connecteurs API officiels (Meta, X, YouTube, TikTok) et programmation
8. [ ] Génération d'images et de visuels de marque

Voir le [guide de marque](brand/BRAND.md).
