"""System fonts the editors can use. Regular, bold, italic and bold-italic files per family."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

_WIN = Path(r"C:\Windows\Fonts")
_LINUX = Path("/usr/share/fonts/truetype/dejavu")
_MAC = Path("/Library/Fonts")

# family -> (regular, bold, italic, bold italic)
_FAMILIES: dict[str, tuple[str, str, str, str]] = {
    "Arial": ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"),
    "Segoe UI": ("segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"),
    "Calibri": ("calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"),
    "Times New Roman": ("times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"),
    "Georgia": ("georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"),
    "Verdana": ("verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf"),
    "Courier New": ("cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"),
    "Consolas": ("consola.ttf", "consolab.ttf", "consolai.ttf", "consolaz.ttf"),
    "Comic Sans MS": ("comic.ttf", "comicbd.ttf", "comici.ttf", "comicz.ttf"),
    "Impact": ("impact.ttf", "impact.ttf", "impact.ttf", "impact.ttf"),
}
_DEJAVU = ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf")


def _dirs() -> list[Path]:
    return [_WIN, _MAC, _LINUX] if sys.platform != "win32" else [_WIN]


def _find(filename: str) -> str | None:
    for d in _dirs():
        p = d / filename
        if p.is_file():
            return str(p)
    return None


def available_fonts() -> list[str]:
    names = [name for name, files in _FAMILIES.items() if _find(files[0])]
    if _find(_DEJAVU[0]):
        names.append("DejaVu Sans")
    have = {n.lower() for n in names}
    extra = sorted((_NAMES[k] for k in scan() if k not in have and not _NAMES[k].startswith("@")), key=str.lower)
    return names + extra


def font_path(family: str = "Arial", bold: bool = False, italic: bool = False) -> str | None:
    """Path of the closest matching font file, or None when the machine has none of ours."""
    idx = (1 if bold else 0) + (2 if italic else 0)
    mine = scan().get(family.lower())
    if mine:
        return mine.get(idx) or mine.get(0) or next(iter(mine.values()))
    files = _DEJAVU if family == "DejaVu Sans" else _FAMILIES.get(family)
    for candidates in ([files] if files else []) + [_FAMILIES["Arial"], _DEJAVU]:
        for i in (idx, 0):
            found = _find(candidates[i])
            if found:
                return found
    return None


# ---------------------------------------------------------------------------------------------
# every font installed on the machine, and the ones you add yourself
# ---------------------------------------------------------------------------------------------

_CUSTOM_DIR: Path | None = None
_SCAN: dict[str, dict[int, str]] | None = None  # lower-case family -> {style index: file}
_NAMES: dict[str, str] = {}  # lower-case family -> shown name
_EXTS = {".ttf", ".otf"}


def set_custom_dir(path: Path) -> None:
    global _CUSTOM_DIR, _SCAN
    _CUSTOM_DIR = path
    _SCAN = None


def _font_dirs() -> list[Path]:
    dirs = list(_dirs())
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            dirs.append(Path(local) / "Microsoft" / "Windows" / "Fonts")
    if _CUSTOM_DIR is not None:
        dirs.append(_CUSTOM_DIR)
    return dirs


def _style_index(style: str) -> int:
    st = style.lower()
    return (1 if "bold" in st or "black" in st or "heavy" in st else 0) + (2 if "italic" in st or "oblique" in st else 0)


def scan(force: bool = False) -> dict[str, dict[int, str]]:
    """Reads the family and style of every .ttf/.otf file once (cached until fonts are added)."""
    global _SCAN
    if _SCAN is not None and not force:
        return _SCAN
    from PIL import ImageFont

    found: dict[str, dict[int, str]] = {}
    for d in _font_dirs():
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.suffix.lower() not in _EXTS:
                continue
            try:
                family, style = ImageFont.truetype(str(f), 12).getname()
            except Exception:
                continue
            if not family:
                continue
            key = family.lower()
            _NAMES.setdefault(key, family)
            slot = found.setdefault(key, {})
            idx = _style_index(style or "")
            # a plain "Regular" wins over variants such as "Light" for the same slot
            if idx not in slot or (style or "").lower() in ("regular", "bold", "italic", "bold italic"):
                slot[idx] = str(f)
    _SCAN = found
    return found


def custom_fonts() -> list[str]:
    if _CUSTOM_DIR is None or not _CUSTOM_DIR.is_dir():
        return []
    from PIL import ImageFont

    names = set()
    for f in _CUSTOM_DIR.iterdir():
        if f.suffix.lower() in _EXTS:
            try:
                names.add(ImageFont.truetype(str(f), 12).getname()[0])
            except Exception:
                pass
    return sorted(names)


def add_font(source: str) -> str:
    """Copy a .ttf/.otf into the app's own fonts folder and return its family name."""
    if _CUSTOM_DIR is None:
        raise ValueError("fonts folder is not set up")
    src = Path(source)
    if src.suffix.lower() not in _EXTS or not src.is_file():
        raise ValueError("choose a .ttf or .otf font file")
    from PIL import ImageFont

    try:
        family = ImageFont.truetype(str(src), 12).getname()[0]
    except Exception:
        raise ValueError("this file is not a usable font")
    _CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
    dest = _CUSTOM_DIR / src.name
    if not dest.exists():
        shutil.copyfile(src, dest)
    scan(force=True)
    return family


def remove_custom_font(family: str) -> int:
    if _CUSTOM_DIR is None or not _CUSTOM_DIR.is_dir():
        return 0
    from PIL import ImageFont

    n = 0
    for f in list(_CUSTOM_DIR.iterdir()):
        if f.suffix.lower() in _EXTS:
            try:
                if ImageFont.truetype(str(f), 12).getname()[0] == family:
                    f.unlink()
                    n += 1
            except Exception:
                pass
    scan(force=True)
    return n
