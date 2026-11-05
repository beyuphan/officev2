"""Writing text onto PDF pages so it stays searchable and copyable.

Many system fonts (Arial, Times New Roman, Calibri, Segoe UI, ...) draw several characters with one
shared glyph: the space and the non-breaking space, the hyphen and the soft hyphen, the semicolon and
the Greek question mark, the middle dot... When such a font is embedded, PDF readers extract the
*other* character, so "REF-0006" is found as "REF­0006" and a normal search misses it.

For every font file we measure once which characters come back wrong and write exactly those with the
matching built-in font (Helvetica, Times or Courier). Everything else keeps the chosen font.
"""
from __future__ import annotations

import pymupdf

# ASCII and Latin-1 punctuation, the characters that go wrong in practice
_PROBE = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~¡¢£¥§©«®°±µ·»¿"

_BAD: dict[str, frozenset[str]] = {}


def bad_chars(fontfile: str | None) -> frozenset[str]:
    """Characters this font file gets extracted as something else."""
    if not fontfile:
        return frozenset()  # built-in base-14 fonts are fine
    if fontfile not in _BAD:
        doc = pymupdf.open()
        try:
            page = doc.new_page(width=900, height=60)
            page.insert_font(fontname="probe", fontfile=fontfile)
            page.insert_text((5, 30), _PROBE, fontname="probe", fontsize=9)
            got = page.get_text().rstrip("\n")
            if len(got) != len(_PROBE):
                _BAD[fontfile] = frozenset(_PROBE)  # extraction reordered or dropped something: be safe
            else:
                _BAD[fontfile] = frozenset(c for c, g in zip(_PROBE, got) if c != g)
        except Exception:
            _BAD[fontfile] = frozenset()
        finally:
            doc.close()
    return _BAD[fontfile]


def _fallback_name(fontfile: str | None) -> str:
    name = (fontfile or "").lower().replace("\\", "/").rsplit("/", 1)[-1]
    if name.startswith(("times", "georgia")):
        return "tiro"
    if name.startswith(("cour", "consola")):
        return "cour"
    return "helv"


def put_line(
    page: "pymupdf.Page",
    origin: "pymupdf.Point",
    line: str,
    font: "pymupdf.Font",
    fontfile: str | None,
    size: float,
    color: tuple[float, float, float],
    opacity: float = 1.0,
    angle: float = 0.0,
) -> None:
    """Write one line with its baseline starting at `origin` (PDF space), rotated `angle` degrees counter-clockwise."""
    morph = (origin, pymupdf.Matrix(angle))
    bad = bad_chars(fontfile)
    if not bad or not any(c in bad for c in line):
        tw = pymupdf.TextWriter(page.rect, opacity=opacity, color=color)
        tw.append(origin, line, font=font, fontsize=size)
        tw.write_text(page, morph=morph)
        return

    # Emit the segments strictly left to right so extraction keeps them on one line.
    fallback = _fallback_name(fontfile)
    segments: list[tuple[str, str, float]] = []  # (kind, text, x)
    run, x, run_x = "", 0.0, 0.0
    for ch in line:
        if ch in bad:
            if run:
                segments.append(("run", run, run_x))
                run = ""
            segments.append(("special", ch, x))
        else:
            if not run:
                run_x = x
            run += ch
        x += font.text_length(ch, size)
    if run:
        segments.append(("run", run, run_x))

    for kind, text, sx in segments:
        pos = pymupdf.Point(origin.x + sx, origin.y)
        if kind == "run":
            tw = pymupdf.TextWriter(page.rect, opacity=opacity, color=color)
            tw.append(pos, text, font=font, fontsize=size)
            tw.write_text(page, morph=morph)
        elif text == " ":  # invisible, but a genuine U+0020 for search, selection and copy
            page.insert_text(pos, " ", fontname=fallback, fontsize=size, morph=morph)
        else:
            page.insert_text(pos, text, fontname=fallback, fontsize=size, color=color, fill_opacity=opacity, morph=morph)
