"""Voix off (synthèse vocale locale) et musique d'ambiance générée par ffmpeg."""
import os
import platform
import shutil
import subprocess
from pathlib import Path


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def available_voice() -> str | None:
    """Nom du moteur de voix disponible sur ce PC, ou None."""
    if shutil.which("piper") and os.environ.get("REELIO_PIPER_MODEL"):
        return "piper"
    if shutil.which("espeak-ng"):
        return "espeak-ng"
    if platform.system() == "Windows" and shutil.which("powershell"):
        return "sapi"
    if platform.system() == "Darwin" and shutil.which("say"):
        return "say"
    return None


def speak(text: str, out_wav: Path) -> Path | None:
    """Synthétise `text` en français dans `out_wav`. Retourne None si aucune voix n'est installée."""
    engine = available_voice()
    out_wav = Path(out_wav)
    if engine is None or not text.strip():
        return None
    if engine == "piper":
        subprocess.run(["piper", "--model", os.environ["REELIO_PIPER_MODEL"], "--output_file", str(out_wav)],
                       input=text, text=True, check=True, capture_output=True)
    elif engine == "espeak-ng":
        subprocess.run(["espeak-ng", "-v", "fr", "-s", "150", "-w", str(out_wav), text], check=True)
    elif engine == "sapi":
        script = ("Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
                  "try{$s.SelectVoice('Microsoft Hortense Desktop')}catch{};"
                  f"$s.SetOutputToWaveFile('{out_wav}');$s.Speak($env:REELIO_TEXT);$s.Dispose()")
        subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True,
                       env={**os.environ, "REELIO_TEXT": text})
    else:  # macOS
        aiff = out_wav.with_suffix(".aiff")
        subprocess.run(["say", "-v", "Thomas", "-o", str(aiff), text], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff), str(out_wav)], check=True)
    return out_wav


def make_music(seconds: float, out_path: Path) -> Path:
    """Nappe d'ambiance douce (accord de La mineur) générée localement : aucun droit d'auteur."""
    out_path = Path(out_path)
    freqs = [220.0, 261.63, 329.63]  # La, Do, Mi
    inputs: list[str] = []
    for f in freqs:
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={f}:sample_rate=44100:duration={seconds:.2f}"]
    fade = min(1.5, seconds / 3)
    flt = (f"amix=inputs={len(freqs)}:normalize=0,volume=0.12,"
           f"afade=t=in:d={fade:.2f},afade=t=out:st={max(seconds - fade, 0):.2f}:d={fade:.2f}")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", flt,
                    "-ac", "2", str(out_path)], check=True)
    return out_path
