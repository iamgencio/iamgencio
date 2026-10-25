"""Configuration : variables d'environnement et dossiers de travail."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("REELIO_DATA", Path.home() / ".reelio"))
DB_PATH = DATA_DIR / "reelio.db"
REELS_DIR = DATA_DIR / "reels"
EXPORT_DIR = DATA_DIR / "export"

OLLAMA_URL = os.environ.get("REELIO_OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("REELIO_MODEL", "qwen2.5:7b")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("REELIO_OPENROUTER_MODEL", "deepseek/deepseek-chat")

# Contexte de marque de l'utilisateur (modifiable par variable d'environnement)
NICHE = os.environ.get(
    "REELIO_NICHE",
    "community management, création de contenu, applications mobiles et création de sites web",
)
TONE = os.environ.get("REELIO_TONE", "chaleureux, créatif, professionnel et sobre")


def ensure_dirs() -> None:
    for d in (DATA_DIR, REELS_DIR, EXPORT_DIR):
        d.mkdir(parents=True, exist_ok=True)
