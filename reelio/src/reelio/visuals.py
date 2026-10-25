"""Visuels de marque (cartes pour publications et miniatures), générés localement."""
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw

from .reel import MINT, WHITE, _font, _gradient

FORMATS = {
    "carre": (1080, 1080),       # Facebook, Instagram
    "portrait": (1080, 1350),    # Instagram
    "miniature": (1280, 720),    # YouTube
    "x": (1600, 900),            # X
}


def make_card(title: str, out_path: Path, fmt: str = "carre", subtitle: str = "",
              handle: str = "Reelio") -> Path:
    if fmt not in FORMATS:
        raise ValueError(f"Format inconnu : {fmt} (choix : {', '.join(FORMATS)})")
    w, h = FORMATS[fmt]
    img = Image.alpha_composite(_gradient(w, h).convert("RGBA"), Image.new("RGBA", (w, h), (11, 11, 18, 100)))
    d = ImageDraw.Draw(img)
    size = int(w * (0.085 if len(title) < 50 else 0.065))
    font = _font(size)
    lines = textwrap.wrap(title, width=max(8, int(w * 0.82 / (size * 0.55))))
    block = len(lines) * int(size * 1.3) + (int(size * 0.9) if subtitle else 0)
    y = (h - block) // 2
    for line in lines:
        d.text(((w - d.textlength(line, font=font)) / 2, y), line, font=font, fill=WHITE)
        y += int(size * 1.3)
    if subtitle:
        f2 = _font(int(size * 0.45))
        d.text(((w - d.textlength(subtitle, font=f2)) / 2, y + int(size * 0.2)), subtitle, font=f2, fill=MINT)
    d.rounded_rectangle([80, 70, 200, 80], radius=5, fill=MINT)
    d.text((80, h - 110), handle, font=_font(36), fill=WHITE)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_path)
    return out_path
