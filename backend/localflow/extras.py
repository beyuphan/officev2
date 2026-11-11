"""Optional add-ons: heavy Python packages that most people never need are installed on demand.

The core app stays small. A feature that needs an add-on says so in plain words and the Add-ons screen installs it
into the same Python environment the engine runs in.
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import subprocess
import sys

from . import jobctl

EXTRAS: dict[str, dict] = {
    "background": {
        "name": "Remove backgrounds",
        "text": "Cuts the subject out of a photo as a transparent picture.",
        "packages": ["rembg[cpu]"],
        "modules": ["rembg"],
        "size_mb": 250,
    },
    "speech": {
        "name": "Speech to text",
        "text": "Turns recordings into text and subtitles, on this computer.",
        "packages": ["faster-whisper"],
        "modules": ["faster_whisper"],
        "size_mb": 120,
    },
    "documents": {
        "name": "Ask your documents",
        "text": "Searches your files by meaning, not only by exact words.",
        "packages": ["fastembed", "sqlite-vec"],
        "modules": ["fastembed", "sqlite_vec"],
        "size_mb": 90,
    },
    "ocr": {
        "name": "Read scanned pages (extra engine)",
        "text": "A second text-recognition engine. Windows already has one built in; this one works without a language pack.",
        "packages": ["rapidocr-onnxruntime"],
        "modules": ["rapidocr_onnxruntime"],
        "size_mb": 60,
    },
    "signing": {
        "name": "Digital signatures",
        "text": "Signs a PDF with your own certificate (.pfx or .p12) and checks signatures on PDFs you receive.",
        "packages": ["pyhanko"],
        "modules": ["pyhanko"],
        "size_mb": 25,
    },
    "word": {
        "name": "PDF to Word",
        "text": "Converts a PDF into an editable Word document.",
        "packages": ["pdf2docx"],
        "modules": ["pdf2docx"],
        "size_mb": 30,
    },
}


class MissingExtra(ValueError):
    """A feature was used without its add-on. The message is meant for the person using the app."""


def is_installed(key: str) -> bool:
    if key in os.environ.get("LOCALFLOW_HIDE_EXTRAS", "").split(","):  # lets tests and support pretend an add-on is missing
        return False
    return all(importlib.util.find_spec(m) is not None for m in EXTRAS[key]["modules"])


def require(key: str) -> None:
    if not is_installed(key):
        raise MissingExtra(f"This needs the “{EXTRAS[key]['name']}” add-on (about {EXTRAS[key]['size_mb']} MB). Open Add-ons and install it first.")


def listing() -> list[dict]:
    return [{"id": k, "name": v["name"], "text": v["text"], "size_mb": v["size_mb"], "installed": is_installed(k)} for k, v in EXTRAS.items()]


def install(key: str) -> dict:
    """Run pip for the add-on's packages (job). Cancelling stops pip."""
    if key not in EXTRAS:
        raise ValueError("unknown add-on")
    if is_installed(key):
        return {"id": key, "installed": True}
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", *EXTRAS[key]["packages"]]
    jobctl.report(0, 1, f"installing {EXTRAS[key]['name']}")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        tail = (tail + [line.rstrip()])[-6:]
        if jobctl.cancelled():
            proc.kill()
            proc.wait()
            raise jobctl.Cancelled("cancelled")
        if line.startswith(("Collecting", "Downloading", "Installing")):
            jobctl.report(0, 1, line.strip()[:80])
    code = proc.wait()
    importlib.invalidate_caches()
    if code != 0 or not is_installed(key):
        raise ValueError("the installation failed: " + " ".join(tail)[-300:])
    return {"id": key, "installed": True}
