"""Connecteurs vers les API officielles. Chaque réseau se configure par variables d'environnement.

ATTENTION : écrits d'après la documentation officielle mais non testés en conditions réelles
(il faut des comptes développeur validés). Les tests utilisent de fausses réponses HTTP.

Variables :
  X         : X_ACCESS_TOKEN (OAuth 2.0, portée tweet.write)
  Facebook  : FB_PAGE_ID, FB_PAGE_TOKEN
  Instagram : IG_USER_ID, IG_TOKEN, REELIO_PUBLIC_URL (adresse publique où se trouvent tes vidéos)
  YouTube   : YT_ACCESS_TOKEN (portée youtube.upload), REELIO_YT_PRIVACY (défaut : private)
  TikTok    : TIKTOK_ACCESS_TOKEN (portée video.publish), REELIO_TIKTOK_PRIVACY (défaut : SELF_ONLY)
"""
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

GRAPH = "https://graph.facebook.com/v21.0"


class NotConfigured(RuntimeError):
    """Le réseau n'est pas configuré (jeton manquant) : la publication est exportée à la place."""


class PublishError(RuntimeError):
    pass


REQUIRED = {
    "x": ["X_ACCESS_TOKEN"],
    "facebook": ["FB_PAGE_ID", "FB_PAGE_TOKEN"],
    "instagram": ["IG_USER_ID", "IG_TOKEN"],
    "youtube": ["YT_ACCESS_TOKEN"],
    "tiktok": ["TIKTOK_ACCESS_TOKEN"],
}


def configured(network: str) -> bool:
    return all(os.environ.get(v) for v in REQUIRED.get(network, ["_"]))


def _env(name: str) -> str:
    return os.environ[name]


def http(method: str, url: str, headers: dict | None = None, body: bytes | None = None,
         timeout: int = 300) -> dict:
    """Appel HTTP : retourne le JSON (ou {} si vide). Remplaçable dans les tests."""
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            data = json.loads(raw) if raw else {}
            data["_headers"] = dict(resp.headers)
            return data
    except urllib.error.HTTPError as e:
        raise PublishError(f"{method} {url.split('?')[0]} -> {e.code} {e.read()[:300]!r}") from e
    except (urllib.error.URLError, OSError) as e:
        raise PublishError(f"Réseau indisponible : {e}") from e


def _json(method, url, payload, headers=None) -> dict:
    return http(method, url, {"Content-Type": "application/json", **(headers or {})},
                json.dumps(payload).encode())


def _multipart(fields: dict, file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
                 f'filename="{path.name}"\r\nContent-Type: video/mp4\r\n\r\n'.encode())
    parts += [path.read_bytes(), f"\r\n--{boundary}--\r\n".encode()]
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _text(post: dict) -> str:
    return post["text"] + (f"\n\n{post['hashtags']}" if post["hashtags"] else "")


def _video(post: dict) -> Path | None:
    p = Path(post["reel_path"]) if post.get("reel_path") else None
    return p if p and p.exists() else None


# ── X ──────────────────────────────────────────────────────────────────────
def publish_x(post: dict) -> str:
    """Texte seul (l'envoi de vidéo sur X passe par une API média distincte, non gérée ici)."""
    r = _json("POST", "https://api.x.com/2/tweets", {"text": _text(post)},
              {"Authorization": f"Bearer {_env('X_ACCESS_TOKEN')}"})
    return r["data"]["id"]


# ── Facebook (Page) ───────────────────────────────────────────────────────
def publish_facebook(post: dict) -> str:
    page, token = _env("FB_PAGE_ID"), _env("FB_PAGE_TOKEN")
    video = _video(post)
    if video:
        body, ctype = _multipart({"description": _text(post), "access_token": token}, "source", video)
        return http("POST", f"https://graph-video.facebook.com/v21.0/{page}/videos",
                    {"Content-Type": ctype}, body)["id"]
    return _json("POST", f"{GRAPH}/{page}/feed", {"message": _text(post), "access_token": token})["id"]


# ── Instagram (Reels) ─────────────────────────────────────────────────────
def publish_instagram(post: dict, poll_seconds: float = 5, max_polls: int = 60) -> str:
    video = _video(post)
    if not video:
        raise PublishError("Instagram : un reel vidéo est nécessaire (générez-le avec --reel).")
    base = os.environ.get("REELIO_PUBLIC_URL", "").rstrip("/")
    if not base:
        raise NotConfigured("Instagram exige une vidéo accessible par une adresse publique : "
                            "définissez REELIO_PUBLIC_URL (là où vous hébergez le fichier).")
    user, token = _env("IG_USER_ID"), _env("IG_TOKEN")
    created = _json("POST", f"{GRAPH}/{user}/media", {
        "media_type": "REELS", "video_url": f"{base}/{video.name}",
        "caption": _text(post), "access_token": token})
    cid = created["id"]
    for _ in range(max_polls):
        status = http("GET", f"{GRAPH}/{cid}?fields=status_code&access_token={token}")
        if status.get("status_code") == "FINISHED":
            break
        if status.get("status_code") == "ERROR":
            raise PublishError("Instagram a refusé la vidéo.")
        time.sleep(poll_seconds)
    else:
        raise PublishError("Instagram : traitement de la vidéo trop long.")
    return _json("POST", f"{GRAPH}/{user}/media_publish", {"creation_id": cid, "access_token": token})["id"]


# ── YouTube ───────────────────────────────────────────────────────────────
def publish_youtube(post: dict) -> str:
    video = _video(post)
    if not video:
        raise PublishError("YouTube : une vidéo est nécessaire (générez-la avec --reel).")
    auth = {"Authorization": f"Bearer {_env('YT_ACCESS_TOKEN')}"}
    meta = {"snippet": {"title": (post["title"] or post["text"])[:100],
                        "description": _text(post) + "\n\n#Shorts", "categoryId": "22"},
            "status": {"privacyStatus": os.environ.get("REELIO_YT_PRIVACY", "private"),
                       "selfDeclaredMadeForKids": False}}
    init = http("POST", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
                {**auth, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4"},
                json.dumps(meta).encode())
    location = {k.lower(): v for k, v in init["_headers"].items()}["location"]
    return http("PUT", location, {**auth, "Content-Type": "video/mp4"}, video.read_bytes())["id"]


# ── TikTok ────────────────────────────────────────────────────────────────
def publish_tiktok(post: dict) -> str:
    video = _video(post)
    if not video:
        raise PublishError("TikTok : une vidéo est nécessaire (générez-la avec --reel).")
    auth = {"Authorization": f"Bearer {_env('TIKTOK_ACCESS_TOKEN')}"}
    size = video.stat().st_size
    init = _json("POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", {
        "post_info": {"title": _text(post)[:2200],
                      "privacy_level": os.environ.get("REELIO_TIKTOK_PRIVACY", "SELF_ONLY")},
        "source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": size,
                        "total_chunk_count": 1}}, auth)
    data = init.get("data") or {}
    http("PUT", data["upload_url"], {"Content-Type": "video/mp4",
         "Content-Range": f"bytes 0-{size - 1}/{size}"}, video.read_bytes())
    return data["publish_id"]


PUBLISHERS = {"x": publish_x, "facebook": publish_facebook, "instagram": publish_instagram,
              "youtube": publish_youtube, "tiktok": publish_tiktok}


def publish(post: dict) -> str:
    net = post["network"]
    if net not in PUBLISHERS:
        raise PublishError(f"Réseau inconnu : {net}")
    if not configured(net):
        raise NotConfigured(f"{net} : jeton d'accès manquant ({', '.join(REQUIRED[net])}).")
    return PUBLISHERS[net](post)
