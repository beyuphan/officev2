"""System fonts the editors can use. Regular, bold, italic and bold-italic files per family."""
from __future__ import annotations

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
    return names


def font_path(family: str = "Arial", bold: bool = False, italic: bool = False) -> str | None:
    """Path of the closest matching font file, or None when the machine has none of ours."""
    idx = (1 if bold else 0) + (2 if italic else 0)
    files = _DEJAVU if family == "DejaVu Sans" else _FAMILIES.get(family)
    for candidates in ([files] if files else []) + [_FAMILIES["Arial"], _DEJAVU]:
        for i in (idx, 0):
            found = _find(candidates[i])
            if found:
                return found
    return None
