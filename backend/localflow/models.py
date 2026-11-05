"""Model Manager: registry of optional downloadable components and their install/remove logic.

Nothing is downloaded at install time of the app. Features call `ensure()` on first use, or the user
installs/removes models explicitly from the Models screen.
"""
from __future__ import annotations

import os
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

from . import jobctl

REALESRGAN_URL = (
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/"
    "realesrgan-ncnn-vulkan-20220424-windows.zip"
)
MULTILINGUAL_EMBEDDER = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

REGISTRY: dict[str, dict] = {
    "realesrgan": {
        "name": "Real-ESRGAN upscaler (ncnn, Vulkan GPU)",
        "kind": "upscale",
        "size_mb": 45,
        "platform": "win32",
        "executable": True,  # third-party binary: explicit install only
    },
    "rembg-u2netp": {"name": "Background remover (small, fast)", "kind": "background", "size_mb": 5},
    "rembg-u2net": {"name": "Background remover (accurate)", "kind": "background", "size_mb": 176},
    "whisper-tiny": {"name": "Whisper tiny (fastest, rough)", "kind": "speech", "size_mb": 75},
    "whisper-base": {"name": "Whisper base", "kind": "speech", "size_mb": 145},
    "whisper-small": {"name": "Whisper small (good balance)", "kind": "speech", "size_mb": 480},
    "embed-multilingual": {"name": "Text embeddings (multilingual, incl. Turkish)", "kind": "embedding", "size_mb": 220},
}


def models_root(data_dir: str | Path) -> Path:
    return Path(data_dir) / "models"


def model_dir(data_dir: str | Path, model_id: str) -> Path:
    return models_root(data_dir) / model_id


def is_installed(data_dir: str | Path, model_id: str) -> bool:
    return (model_dir(data_dir, model_id) / ".installed").is_file()


def _dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else 0


def list_models(data_dir: str | Path) -> list[dict]:
    out = []
    for mid, info in REGISTRY.items():
        installed = is_installed(data_dir, mid)
        out.append(
            {
                "id": mid,
                **info,
                "installed": installed,
                "disk_bytes": _dir_size(model_dir(data_dir, mid)) if installed else 0,
            }
        )
    return out


def download(url: str, dest: Path, label: str) -> None:
    """Stream a file to disk with progress and cancellation."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "officev2"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            jobctl.check()
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            jobctl.report(done, total, f"downloading {label}")


def install(data_dir: str, model_id: str) -> dict:
    """Job function: download and prepare a model. Idempotent."""
    if model_id not in REGISTRY:
        raise ValueError(f"unknown model '{model_id}'")
    if REGISTRY[model_id].get("platform") and REGISTRY[model_id]["platform"] != sys.platform:
        raise ValueError(f"{model_id} is only available on {REGISTRY[model_id]['platform']}")
    target = model_dir(data_dir, model_id)
    if is_installed(data_dir, model_id):
        return {"id": model_id, "installed": True}
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    try:
        if model_id == "realesrgan":
            zip_path = target / "download.zip"
            download(REALESRGAN_URL, zip_path, "Real-ESRGAN")
            with zipfile.ZipFile(zip_path) as z:
                if z.testzip() is not None:
                    raise ValueError("downloaded archive is corrupt")
                z.extractall(target)
            zip_path.unlink()
        elif model_id.startswith("rembg-"):
            os.environ["U2NET_HOME"] = str(target)
            jobctl.report(0, 1, "downloading background model")
            from rembg import new_session

            new_session(model_id.removeprefix("rembg-"))
        elif model_id.startswith("whisper-"):
            from huggingface_hub import snapshot_download

            jobctl.report(0, 1, "downloading speech model")
            snapshot_download(f"Systran/faster-whisper-{model_id.removeprefix('whisper-')}", local_dir=str(target))
        elif model_id == "embed-multilingual":
            from fastembed import TextEmbedding

            jobctl.report(0, 1, "downloading embedding model")
            TextEmbedding(model_name=MULTILINGUAL_EMBEDDER, cache_dir=str(target))
        (target / ".installed").write_text("ok")
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return {"id": model_id, "installed": True}


def ensure(data_dir: str, model_id: str) -> Path:
    """Return the model directory, installing data-only models on first use (inside a job).

    Components that contain an executable are never fetched implicitly: the user must install them
    explicitly from the Models screen.
    """
    if not is_installed(data_dir, model_id):
        if REGISTRY[model_id].get("executable"):
            raise ValueError(
                f"'{REGISTRY[model_id]['name']}' is not installed. Install it from the Models screen first."
            )
        install(data_dir, model_id)
    return model_dir(data_dir, model_id)


def remove(data_dir: str | Path, model_id: str) -> bool:
    if model_id not in REGISTRY:
        raise ValueError(f"unknown model '{model_id}'")
    target = model_dir(data_dir, model_id)
    existed = target.exists()
    shutil.rmtree(target, ignore_errors=True)
    return existed
