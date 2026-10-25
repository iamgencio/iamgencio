"""Génération de reels verticaux (1080x1920) : diapositives animées montées avec ffmpeg."""
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
NIGHT, VIOLET, PINK, MINT, WHITE = "#0B0B12", (124, 92, 255), (255, 77, 141), "#2DFFB3", "#F5F5FA"

FONT_CANDIDATES = [
    "Inter-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for name in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def _gradient() -> Image.Image:
    """Dégradé signature violet -> rose en diagonale."""
    small = Image.new("RGB", (2, 2))
    small.putpixel((0, 0), VIOLET)
    small.putpixel((1, 0), tuple((a + b) // 2 for a, b in zip(VIOLET, PINK)))
    small.putpixel((0, 1), tuple((a + b) // 2 for a, b in zip(VIOLET, PINK)))
    small.putpixel((1, 1), PINK)
    return small.resize((W, H), Image.BILINEAR)


def render_slide(text: str, index: int, total: int, handle: str = "Reelio") -> Image.Image:
    img = _gradient()
    shade = Image.new("RGBA", (W, H), (11, 11, 18, 110))
    img = Image.alpha_composite(img.convert("RGBA"), shade)
    d = ImageDraw.Draw(img)

    size = 96 if len(text) < 60 else 76 if len(text) < 120 else 60
    font = _font(size)
    lines = textwrap.wrap(text, width=max(10, int(W * 0.82 / (size * 0.55))))
    line_h = int(size * 1.3)
    y = (H - line_h * len(lines)) // 2
    for line in lines:
        w = d.textlength(line, font=font)
        d.text(((W - w) / 2, y), line, font=font, fill=WHITE)
        y += line_h

    # barre de progression et signature
    seg = (W - 160) / total
    for i in range(total):
        x0 = 80 + i * seg
        d.rounded_rectangle([x0 + 4, 90, x0 + seg - 4, 100], radius=5,
                            fill=MINT if i <= index else (255, 255, 255, 70))
    sig = _font(40)
    d.text((80, H - 140), handle, font=sig, fill=WHITE)
    return img.convert("RGB")


def make_reel(lines: list[str], out_path: Path, seconds_per_slide: float = 3.0,
              handle: str = "Reelio") -> Path:
    """Crée un reel MP4 à partir de quelques phrases courtes."""
    lines = [l.strip() for l in lines if l.strip()]
    if not lines:
        raise ValueError("Il faut au moins une phrase pour créer un reel.")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg est introuvable : installez-le (https://ffmpeg.org) et relancez.")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for i, line in enumerate(lines):
            render_slide(line, i, len(lines), handle).save(Path(tmp) / f"s{i:03d}.png")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", f"1/{seconds_per_slide}",
               "-i", str(Path(tmp) / "s%03d.png"),
               "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
               "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-c:a", "aac",
               "-shortest", "-movflags", "+faststart", str(out_path)]
        subprocess.run(cmd, check=True)
    return out_path


def script_from_idea(idea: str) -> list[str]:
    """Découpe simple d'une idée en diapositives (le modèle IA pourra faire mieux plus tard)."""
    parts = [p.strip() for p in idea.replace("\n", ". ").split(".") if p.strip()]
    return parts[:6] or [idea]
