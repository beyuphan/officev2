"""Runtime configuration, read from environment variables set by the Tauri shell."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ORIGINS = (
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",  # Vite dev server
)


def default_data_dir() -> Path:
    env = os.environ.get("LOCALFLOW_DATA_DIR")
    if env:
        return Path(env)
    base = os.environ.get("APPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "officev2"


def default_roots() -> tuple[Path, ...]:
    """The home folder plus every drive, so a file on another drive opens like one in Documents (D: drive). The API still needs the token."""
    roots = [Path.home().resolve()]
    if os.name == "nt":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:\\")
            try:
                if drive.exists():
                    roots.append(drive)
            except OSError:
                continue
    else:
        roots += [Path(p) for p in ("/mnt", "/media", "/Volumes") if Path(p).exists()]
    return tuple(dict.fromkeys(roots))


@dataclass(frozen=True)
class Settings:
    token: str
    data_dir: Path = field(default_factory=default_data_dir)
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS
    # Directories the API may read from / write to. Everything else is rejected.
    allowed_roots: tuple[Path, ...] = field(default_factory=lambda: default_roots())

    @staticmethod
    def from_env() -> "Settings":
        token = os.environ.get("LOCALFLOW_TOKEN") or os.environ.get("LOCALFLOW_DEV_TOKEN")
        if not token:
            raise RuntimeError(
                "LOCALFLOW_TOKEN is not set. The Tauri shell provides it; "
                "for development set LOCALFLOW_DEV_TOKEN."
            )
        roots_env = os.environ.get("LOCALFLOW_ALLOWED_ROOTS")
        roots = (
            tuple(Path(p).resolve() for p in roots_env.split(os.pathsep) if p)
            if roots_env
            else default_roots()
        )
        return Settings(token=token, allowed_roots=roots)
