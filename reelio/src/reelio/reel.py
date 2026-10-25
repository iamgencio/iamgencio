"""Génération de reels verticaux (1080x1920) : diapositives animées montées avec ffmpeg."""
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import audio

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


def _gradient(w: int = W, h: int = H) -> Image.Image:
    """Dégradé signature violet -> rose en diagonale."""
    small = Image.new("RGB", (2, 2))
    small.putpixel((0, 0), VIOLET)
    small.putpixel((1, 0), tuple((a + b) // 2 for a, b in zip(VIOLET, PINK)))
    small.putpixel((0, 1), tuple((a + b) // 2 for a, b in zip(VIOLET, PINK)))
    small.putpixel((1, 1), PINK)
    return small.resize((w, h), Image.BILINEAR)


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


def make_reel(lines: list, out_path: Path, seconds_per_slide: float = 3.0,
              handle: str = "Reelio", voice: bool = False, music: bool = False) -> Path:
    """Crée un reel MP4. `lines` : phrases (str) ou scènes {"texte", "voix"}.

    Avec `voice`, chaque scène est lue à voix haute et sa durée s'adapte à la lecture.
    Avec `music`, une nappe d'ambiance est ajoutée en fond.
    """
    scenes = [{"texte": l, "voix": l} if isinstance(l, str) else l for l in lines]
    scenes = [s for s in scenes if s.get("texte", "").strip()]
    if not scenes:
        raise ValueError("Il faut au moins une phrase pour créer un reel.")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg est introuvable : installez-le (https://ffmpeg.org) et relancez.")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        durations, voices = [], []
        for i, sc in enumerate(scenes):
            render_slide(sc["texte"], i, len(scenes), handle).save(tmp / f"s{i:03d}.png")
            wav = audio.speak(sc.get("voix", ""), tmp / f"v{i:03d}.wav") if voice else None
            voices.append(wav)
            durations.append(max(seconds_per_slide, audio.duration(wav) + 0.6) if wav else seconds_per_slide)

        listing = []
        for i, d in enumerate(durations):
            listing += [f"file 's{i:03d}.png'", f"duration {d:.3f}"]
        listing.append(f"file 's{len(scenes) - 1:03d}.png'")  # dernière image répétée (exigence ffmpeg)
        (tmp / "slides.txt").write_text("\n".join(listing))
        total = sum(durations)

        # piste audio : voix (calées sur chaque scène) + musique, sinon silence
        track = tmp / "audio.wav"
        parts = []
        for i, d in enumerate(durations):
            seg = tmp / f"p{i:03d}.wav"
            if voices[i]:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(voices[i]), "-af",
                                f"apad=whole_dur={d:.3f},aresample=44100,aformat=channel_layouts=stereo",
                                str(seg)], check=True)
            else:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                                f"anullsrc=r=44100:cl=stereo", "-t", f"{d:.3f}", str(seg)], check=True)
            parts.append(f"file '{seg.name}'")
        (tmp / "audio.txt").write_text("\n".join(parts))
        speech = tmp / "speech.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(tmp / "audio.txt"), "-c", "copy", str(speech)], check=True)
        if music:
            bed = audio.make_music(total, tmp / "music.wav")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(speech), "-i", str(bed),
                            "-filter_complex", "[0][1]amix=inputs=2:duration=first:normalize=0",
                            str(track)], check=True)
        else:
            track = speech

        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(tmp / "slides.txt"), "-i", str(track),
                        "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-c:a", "aac",
                        "-t", f"{total:.3f}", "-movflags", "+faststart", str(out_path)], check=True)
    return out_path


def script_from_idea(idea: str) -> list[str]:
    """Découpe simple d'une idée en diapositives (le modèle IA pourra faire mieux plus tard)."""
    parts = [p.strip() for p in idea.replace("\n", ". ").split(".") if p.strip()]
    return parts[:6] or [idea]
