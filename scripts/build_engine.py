"""Builds the engine folder that ships inside the installer:  frontend/src-tauri/engine-dist/

    python scripts/build_engine.py            (any Python 3.12+; it needs internet once)

engine-dist/
  python/   the official "embeddable" Python for Windows, with pip, uvicorn and the core packages installed
  app/      the engine's own code (backend/localflow, main.py)

The heavy optional add-ons are NOT here: the Add-ons screen installs them with pip into python/Lib/site-packages
later (the app is installed per user, so that folder is writable).
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

PY_VERSION = "3.12.4"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "src-tauri" / "engine-dist"
CACHE = ROOT / "scripts" / ".cache"


def fetch(url: str, name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / name
    if not dest.exists():
        print("downloading", url)
        urllib.request.urlretrieve(url, dest)
    return dest


def core_requirements() -> list[str]:
    lines = []
    for raw in (ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8").splitlines():
        if raw.strip().startswith("# dev"):
            break  # everything after this line is for development only
        if raw.strip() and not raw.strip().startswith("#"):
            lines.append(raw.strip())
    return lines


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "python").mkdir(parents=True)

    embed = fetch(f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip", f"python-{PY_VERSION}-embed-amd64.zip")
    with zipfile.ZipFile(embed) as z:
        z.extractall(OUT / "python")

    # the embeddable Python ignores PYTHONPATH and does not load site-packages unless its ._pth file says so
    pth = next((OUT / "python").glob("python3*._pth"))
    stem = pth.stem
    pth.write_text(f"{stem}.zip\n.\nLib\\site-packages\n..\\app\nimport site\n", encoding="utf-8")

    py = OUT / "python" / "python.exe"
    get_pip = fetch("https://bootstrap.pypa.io/get-pip.py", "get-pip.py")
    subprocess.run([str(py), str(get_pip), "--no-warn-script-location", "--disable-pip-version-check"], check=True)
    subprocess.run([str(py), "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", "--no-input", *core_requirements()], check=True)

    app = OUT / "app"
    shutil.copytree(ROOT / "backend" / "localflow", app / "localflow", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(ROOT / "backend" / "main.py", app / "main.py")

    # smaller: caches and tests inside the installed packages are not needed at run time
    for p in (OUT / "python").rglob("__pycache__"):
        shutil.rmtree(p, ignore_errors=True)
    for p in (OUT / "python" / "Lib" / "site-packages").glob("*/tests"):
        shutil.rmtree(p, ignore_errors=True)

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    (OUT / "VERSION").write_text(f"python {PY_VERSION}\n", encoding="utf-8")
    # a tracked placeholder lives here too, so the desktop shell can be built from a fresh clone before this script ever ran
    (OUT / "README.txt").write_text("Built by scripts/build_engine.py: Python and the core packages for the installer.\n", encoding="utf-8")
    print(f"engine folder ready: {OUT}  ({size:.0f} MB)")


if __name__ == "__main__":
    if sys.platform != "win32":
        sys.exit("the packaged engine is built for Windows")
    main()
