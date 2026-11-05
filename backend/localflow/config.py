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


@dataclass(frozen=True)
class Settings:
    token: str
    data_dir: Path = field(default_factory=default_data_dir)
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS
    # Directories the API may read from / write to. Everything else is rejected.
    allowed_roots: tuple[Path, ...] = field(default_factory=lambda: (Path.home(),))

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
            else (Path.home().resolve(),)
        )
        return Settings(token=token, allowed_roots=roots)
