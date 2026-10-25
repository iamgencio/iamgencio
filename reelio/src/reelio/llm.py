"""Accès au modèle de langage : Ollama en local, OpenRouter en secours."""
import json
import urllib.error
import urllib.request

from . import config


class LLMUnavailable(RuntimeError):
    pass


def _post(url: str, payload: dict, headers: dict | None = None, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def ask(prompt: str, system: str = "") -> str:
    """Interroge Ollama (hors ligne) puis OpenRouter si une clé est définie."""
    errors = []
    try:
        data = _post(
            f"{config.OLLAMA_URL}/api/generate",
            {"model": config.OLLAMA_MODEL, "prompt": prompt, "system": system,
             "stream": False, "format": "json"},
        )
        return data["response"]
    except (urllib.error.URLError, TimeoutError, KeyError, OSError) as e:
        errors.append(f"Ollama: {e}")

    if config.OPENROUTER_KEY:
        try:
            data = _post(
                "https://openrouter.ai/api/v1/chat/completions",
                {"model": config.OPENROUTER_MODEL,
                 "messages": [{"role": "system", "content": system},
                              {"role": "user", "content": prompt}],
                 "response_format": {"type": "json_object"}},
                headers={"Authorization": f"Bearer {config.OPENROUTER_KEY}"},
            )
            return data["choices"][0]["message"]["content"]
        except (urllib.error.URLError, TimeoutError, KeyError, OSError) as e:
            errors.append(f"OpenRouter: {e}")

    raise LLMUnavailable(" | ".join(errors))


def is_online(host: str = "https://openrouter.ai", timeout: float = 3.0) -> bool:
    try:
        urllib.request.urlopen(host, timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True  # le serveur répond : on est en ligne
    except (urllib.error.URLError, OSError, TimeoutError):
        return False
