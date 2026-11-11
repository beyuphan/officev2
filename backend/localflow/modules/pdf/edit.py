"""PDF editor: content added on top of pages, plus page-level tools.

Edit coordinates are in the page as it is *displayed* (points, origin top-left, after the page's own
rotation), the same space the preview uses. They are converted to PDF space here, so the result is
correct on rotated pages too.
"""
from __future__ import annotations

import io
import json
import math
import re
import time
from pathlib import Path
from typing import Any

import pymupdf
from PIL import Image, ImageOps

from ... import jobctl
from ...fonts import font_path
from .ops import _open_for_view, _render, _select_pages, parse_page_ranges
from .textwrite import put_line

PAGE_SIZES = {"A3": (842, 1191), "A4": (595, 842), "A5": (420, 595), "Letter": (612, 792), "Legal": (612, 1008)}


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------


def _rgb(value: Any, default: str = "#000000") -> tuple[float, float, float]:
    v = value or default
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return tuple(max(0.0, min(1.0, float(c) / 255.0 if max(v[:3]) > 1 else float(c))) for c in v[:3])  # type: ignore[return-value]
    if not (isinstance(v, str) and re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)):
        raise ValueError(f"invalid color '{v}'")
    h = v[1:]
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def _f(op: dict, key: str, default: float | None = None, lo: float | None = None, hi: float | None = None) -> float:
    raw = op.get(key, default)
    if raw is None:
        raise ValueError(f"'{key}' is required")
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"'{key}' must be a number")
    if math.isnan(v) or math.isinf(v):
        raise ValueError(f"'{key}' must be a finite number")
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _rect_op(op: dict) -> pymupdf.Rect:
    r = pymupdf.Rect(_f(op, "x0"), _f(op, "y0"), _f(op, "x1"), _f(op, "y1")).normalize()
    if r.width < 1 or r.height < 1:
        raise ValueError("the area is too small")
    return r


def _to_pdf(page: "pymupdf.Page", r: pymupdf.Rect) -> pymupdf.Rect:
    return (pymupdf.Rect(r) * page.derotation_matrix).normalize()


def _to_pdf_pt(page: "pymupdf.Page", x: float, y: float) -> pymupdf.Point:
    return pymupdf.Point(x, y) * page.derotation_matrix


def _shown(page: "pymupdf.Page", r: pymupdf.Rect) -> list[float]:
    v = (pymupdf.Rect(r) * page.rotation_matrix).normalize()
    return [v.x0, v.y0, v.x1, v.y1]


def _page_of(doc: "pymupdf.Document", op: dict) -> "pymupdf.Page":
    n = int(_f(op, "page", 1, 1))
    if not 1 <= n <= doc.page_count:
        raise ValueError(f"page {n} does not exist (the document has {doc.page_count})")
    return doc[n - 1]


def _font(op: dict) -> tuple["pymupdf.Font", float, float, str | None]:
    path = font_path(str(op.get("font", "Arial")), bool(op.get("bold")), bool(op.get("italic")))
    font = pymupdf.Font(fontfile=path) if path else pymupdf.Font("helv")
    return font, font.ascender, font.descender, path


def _wrap(text: str, font: "pymupdf.Font", size: float, width: float | None) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        if not width:
            lines.append(para)
            continue
        cur = ""
        for word in para.split(" "):
            trial = f"{cur} {word}".strip() if cur else word
            if cur and font.text_length(trial, size) > width:
                lines.append(cur)
                cur = word
            else:
                cur = trial
        lines.append(cur)
    return lines


# ---------------------------------------------------------------------------------------------
# edit operations
# ---------------------------------------------------------------------------------------------


def _op_text(doc, op) -> list[float]:
    page = _page_of(doc, op)
    text = str(op.get("text", ""))
    if not text.strip():
        raise ValueError("the text is empty")
    if len(text) > 5000:
        raise ValueError("the text is too long")
    size = _f(op, "size", 14, 2, 400)
    font, asc, desc, fontfile = _font(op)
    width = _f(op, "width", 0, 0, 5000) or None
    lines = _wrap(text, font, size, width)
    line_h = (asc - desc) * size
    widths = [font.text_length(line, size) for line in lines]
    box_w, box_h = max(widths + [1.0]), line_h * len(lines)
    x, y = _f(op, "x", 0), _f(op, "y", 0)
    theta = _f(op, "rotate", 0, -360, 360)  # degrees clockwise, around the top-left corner
    ct, st = math.cos(math.radians(theta)), math.sin(math.radians(theta))
    local_to_shown = lambda dx, dy: (x + dx * ct - dy * st, y + dx * st + dy * ct)  # noqa: E731
    color, opacity = _rgb(op.get("color")), _f(op, "opacity", 1, 0, 1)
    align = op.get("align", "left")
    pad = _f(op, "padding", 4 if (op.get("background") or op.get("border")) else 0, 0, 100)

    if op.get("background") or op.get("border"):  # a label / stamp frame behind the text
        corners = [local_to_shown(*c) for c in ((-pad, -pad), (box_w + pad, -pad), (box_w + pad, box_h + pad), (-pad, box_h + pad))]
        poly = [pymupdf.Point(px, py) * page.derotation_matrix for px, py in corners]
        shape = page.new_shape()
        shape.draw_polyline(poly + [poly[0]])
        shape.finish(
            color=_rgb(op["border"]) if op.get("border") else None,
            fill=_rgb(op["background"]) if op.get("background") else None,
            width=_f(op, "border_width", 1.5, 0, 50),
            fill_opacity=opacity,
            stroke_opacity=opacity,
            closePath=True,
        )
        shape.commit()

    comp = page.rotation  # glyphs must stay upright on rotated pages
    for i, line in enumerate(lines):
        if not line:
            continue
        off = {"left": 0.0, "center": (box_w - widths[i]) / 2, "right": box_w - widths[i]}.get(align, 0.0)
        origin = _to_pdf_pt(page, *local_to_shown(off, i * line_h + asc * size))
        put_line(page, origin, line, font, fontfile, size, color, opacity, comp - theta)

    corners = [local_to_shown(*c) for c in ((0, 0), (box_w, 0), (box_w, box_h), (0, box_h))]
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    return [min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad]


def _op_image(doc, op) -> list[float]:
    page = _page_of(doc, op)
    path = op.get("path")
    if not path or not Path(path).is_file():
        raise ValueError("choose an image to place")
    with Image.open(path) as src:
        img = ImageOps.exif_transpose(src).convert("RGBA")
    x0, y0 = _f(op, "x0"), _f(op, "y0")
    w = _f(op, "w", 150, 4, 5000)
    h = _f(op, "h", w * img.height / img.width, 4, 5000)
    opacity = _f(op, "opacity", 1, 0, 1)
    if opacity < 1:
        img.putalpha(img.getchannel("A").point(lambda a: int(a * opacity)))
    theta = _f(op, "rotate", 0, -360, 360)
    cx, cy = x0 + w / 2, y0 + h / 2
    if theta:
        img = img.rotate(-theta, resample=Image.BICUBIC, expand=True)
        rad = math.radians(theta)
        w, h = abs(w * math.cos(rad)) + abs(h * math.sin(rad)), abs(w * math.sin(rad)) + abs(h * math.cos(rad))
    shown = pymupdf.Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    if page.rotation:
        img = img.rotate(page.rotation, expand=True)  # counter-rotate so it shows upright
    buf = io.BytesIO()
    img.save(buf, "PNG")
    page.insert_image(_to_pdf(page, shown), stream=buf.getvalue(), overlay=True, keep_proportion=False)
    return [shown.x0, shown.y0, shown.x1, shown.y1]


_MARKUP = {"highlight": "add_highlight_annot", "underline": "add_underline_annot", "strike": "add_strikeout_annot", "squiggly": "add_squiggly_annot"}
_DEFAULT_MARKUP_COLOR = {"highlight": "#ffe600", "underline": "#1a7f37", "strike": "#d4472b", "squiggly": "#d4472b"}


def _op_markup(doc, op) -> list[float]:
    page = _page_of(doc, op)
    kind = op["type"]
    area = _to_pdf(page, _rect_op(op))
    words = [pymupdf.Rect(w[:4]) for w in page.get_text("words") if pymupdf.Rect(w[:4]).intersects(area)]
    # words only count when most of them sit inside the dragged area
    words = [w for w in words if (w & area).get_area() >= 0.4 * w.get_area()]
    quads = [w.quad for w in words] or [area.quad]  # scanned page: mark the area itself
    annot = getattr(page, _MARKUP[kind])(quads=quads)
    annot.set_colors(stroke=_rgb(op.get("color"), _DEFAULT_MARKUP_COLOR[kind]))
    annot.set_opacity(_f(op, "opacity", 0.5 if kind == "highlight" else 1.0, 0.05, 1))
    annot.update()
    covered = pymupdf.Rect(quads[0].rect)
    for q in quads[1:]:
        covered |= q.rect
    return _shown(page, covered)


def _op_shape(doc, op) -> list[float]:
    page = _page_of(doc, op)
    kind = op["type"]
    stroke, width, opacity = _rgb(op.get("color"), "#d4472b"), _f(op, "width", 2, 0, 60), _f(op, "opacity", 1, 0.05, 1)
    fill = _rgb(op["fill"]) if op.get("fill") else None
    if kind in ("rect", "ellipse"):
        r = _rect_op(op)
        annot = page.add_rect_annot(_to_pdf(page, r)) if kind == "rect" else page.add_circle_annot(_to_pdf(page, r))
        annot.set_colors(stroke=stroke, fill=fill)
        shown = [r.x0, r.y0, r.x1, r.y1]
    elif kind in ("line", "arrow"):
        a, b = _to_pdf_pt(page, _f(op, "x0"), _f(op, "y0")), _to_pdf_pt(page, _f(op, "x1"), _f(op, "y1"))
        annot = page.add_line_annot(a, b)
        annot.set_colors(stroke=stroke)
        if kind == "arrow":
            annot.set_line_ends(pymupdf.PDF_ANNOT_LE_NONE, pymupdf.PDF_ANNOT_LE_CLOSED_ARROW)
        xs, ys = sorted([_f(op, "x0"), _f(op, "x1")]), sorted([_f(op, "y0"), _f(op, "y1")])
        shown = [xs[0], ys[0], xs[1], ys[1]]
    else:  # freehand
        strokes = op.get("strokes")
        if not strokes or not all(len(s) >= 2 for s in strokes):
            raise ValueError("draw a line first")
        pts = []
        for line_pts in strokes:
            conv = [_to_pdf_pt(page, float(x), float(y)) for x, y in line_pts]
            pts.append([(q.x, q.y) for q in conv])
        annot = page.add_ink_annot(pts)
        annot.set_colors(stroke=stroke)
        flat = [p for s in strokes for p in s]
        shown = [min(p[0] for p in flat), min(p[1] for p in flat), max(p[0] for p in flat), max(p[1] for p in flat)]
    annot.set_border(width=width)
    annot.set_opacity(opacity)
    annot.update()
    return shown


def _op_note(doc, op) -> list[float]:
    page = _page_of(doc, op)
    text = str(op.get("text", "")).strip()
    if not text:
        raise ValueError("the note is empty")
    x, y = _f(op, "x"), _f(op, "y")
    annot = page.add_text_annot(_to_pdf_pt(page, x, y), text, icon="Note")
    annot.set_colors(stroke=_rgb(op.get("color"), "#ffcc00"))
    annot.update()
    return [x, y, x + 20, y + 20]


def _op_link(doc, op) -> list[float]:
    page = _page_of(doc, op)
    r = _rect_op(op)
    if op.get("uri"):
        uri = str(op["uri"])
        if not re.match(r"^(https?://|mailto:)", uri):
            raise ValueError("a link must start with http://, https:// or mailto:")
        link = {"kind": pymupdf.LINK_URI, "from": _to_pdf(page, r), "uri": uri}
    elif op.get("target_page"):
        n = int(_f(op, "target_page", 1, 1))
        if n > doc.page_count:
            raise ValueError(f"page {n} does not exist")
        link = {"kind": pymupdf.LINK_GOTO, "from": _to_pdf(page, r), "page": n - 1, "to": pymupdf.Point(0, 0)}
    else:
        raise ValueError("enter a web address or a page number")
    page.insert_link(link)
    return [r.x0, r.y0, r.x1, r.y1]


def _op_field(doc, op) -> list[float]:
    """A fill-in form field: text box, check box, drop-down list."""
    page = _page_of(doc, op)
    r = _rect_op(op)
    kind = str(op.get("kind", "text"))
    types = {"text": pymupdf.PDF_WIDGET_TYPE_TEXT, "checkbox": pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "combobox": pymupdf.PDF_WIDGET_TYPE_COMBOBOX}
    if kind not in types:
        raise ValueError("a field is a text box, a check box or a drop-down list")
    existing = {w.field_name for pg in doc for w in (pg.widgets() or [])}
    name = str(op.get("name") or "").strip() or f"field_{page.number + 1}_{len(existing) + 1}"
    if name in existing:
        raise ValueError(f"a field named '{name}' already exists")
    w = pymupdf.Widget()
    w.rect = _to_pdf(page, r)
    w.field_type = types[kind]
    w.field_name = name
    w.border_color = (0.2, 0.2, 0.2)
    w.fill_color = (0.93, 0.96, 1.0)
    if kind == "text":
        w.text_fontsize = min(14.0, max(6.0, r.height * 0.6))
        w.field_value = str(op.get("value", ""))
    elif kind == "combobox":
        choices = [str(c).strip() for c in (op.get("choices") or []) if str(c).strip()]
        if not choices:
            raise ValueError("give the drop-down list at least one choice")
        w.choice_values = choices
        w.field_value = choices[0]
        w.text_fontsize = min(12.0, max(6.0, r.height * 0.6))
    page.add_widget(w)
    return [r.x0, r.y0, r.x1, r.y1]


def _op_origimg(doc, op) -> list[float]:
    """A picture that was already in the PDF: moved or resized (x0..y1 is where it goes) or deleted (`deleted`)."""
    from .more import _pixmap_of

    page = _page_of(doc, op)
    xref = int(_f(op, "xref", 0))
    r = _rect_op(op)
    pix = None if op.get("deleted") else (op.get("_pix") or _pixmap_of(doc, xref))  # read it before it is taken out
    page.delete_image(xref)
    if pix is not None:
        page.insert_image(_to_pdf(page, r), pixmap=pix, overlay=True, keep_proportion=False)
    return [r.x0, r.y0, r.x1, r.y1]


def _plan_origimg(doc: "pymupdf.Document", ops: list[dict], wanted) -> list[tuple]:
    """`page.delete_image` blanks the picture everywhere it is used (a logo repeated on every page). Remember the
    pixels and the other places so they can be put back once the chosen ones are gone."""
    from .more import _pixmap_of

    mine = [op for op in ops if op.get("type") == "origimg" and wanted(op)]
    if not mine:
        return []
    pix_of: dict[int, "pymupdf.Pixmap"] = {}
    targets: dict[int, list[tuple[int, pymupdf.Rect]]] = {}
    for op in mine:
        xref = int(_f(op, "xref", 0))
        if xref not in pix_of:
            pix_of[xref] = _pixmap_of(doc, xref)
        page = _page_of(doc, op)
        # without the original position, every use of the picture on that page is meant
        src = pymupdf.Rect(_f(op, "ox0"), _f(op, "oy0"), _f(op, "ox1"), _f(op, "oy1")) if "ox0" in op else None
        targets.setdefault(xref, []).append((page.number, _to_pdf(page, src) if src else None))
        op["_pix"] = pix_of[xref]
    keep: list[tuple] = []
    for xref, aimed in targets.items():
        for pg in doc:
            if not any(i[0] == xref for i in pg.get_images(full=True)):
                continue
            for rect in pg.get_image_rects(xref):
                if any(n == pg.number and (t is None or (abs(rect.x0 - t.x0) < 2.5 and abs(rect.y0 - t.y0) < 2.5 and abs(rect.x1 - t.x1) < 2.5 and abs(rect.y1 - t.y1) < 2.5)) for n, t in aimed):
                    continue
                keep.append((pg.number, pymupdf.Rect(rect), pix_of[xref]))
    return keep


_DRAW = {"text": _op_text, "image": _op_image, "note": _op_note, "link": _op_link, "highlight": _op_markup, "underline": _op_markup,
         "strike": _op_markup, "squiggly": _op_markup, "rect": _op_shape, "ellipse": _op_shape, "line": _op_shape, "arrow": _op_shape, "ink": _op_shape, "field": _op_field, "origimg": _op_origimg}
_REMOVE = ("erase", "redact", "cover")  # these delete content, so they run first


def apply_edits(doc: "pymupdf.Document", ops: list[dict], only_page: int | None = None) -> dict[int, list[float]]:
    """Apply edits in place. Returns where each edit sits on its page (displayed points) by edit index."""
    if len(ops) > 2000:
        raise ValueError("too many edits")
    boxes: dict[int, list[float]] = {}

    def wanted(op: dict) -> bool:
        return only_page is None or int(op.get("page", 1)) == only_page

    ops = [dict(o) for o in ops]  # edits are annotated below; the caller's list stays as it was
    # taking text out of the page: only the text goes, so a picture or drawing behind it stays untouched
    cover_pages: set[int] = set()
    for i, op in enumerate(ops):
        if op.get("type") == "cover" and wanted(op):
            try:
                page = _page_of(doc, op)
                r = _rect_op(op)
                k = r.height * 0.18  # a little off the top and bottom so tightly set neighbouring lines are not eaten
                page.add_redact_annot(_to_pdf(page, pymupdf.Rect(r.x0 + 0.5, r.y0 + k, max(r.x0 + 1.5, r.x1 - 0.5), max(r.y0 + k + 1, r.y1 - k))), fill=False)
                cover_pages.add(page.number)
                boxes[i] = [r.x0, r.y0, r.x1, r.y1]
            except ValueError as e:
                raise ValueError(f"edit {i + 1} (cover): {e}")
    for n in cover_pages:
        doc[n].apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    restore = _plan_origimg(doc, ops, wanted)
    removed_pages: set[int] = set()
    for i, op in enumerate(ops):
        if op.get("type") in ("erase", "redact") and wanted(op):
            try:
                page = _page_of(doc, op)
                r = _rect_op(op)
                fill = (0, 0, 0) if op["type"] == "redact" else _rgb(op.get("color"), "#ffffff")
                page.add_redact_annot(_to_pdf(page, r), fill=fill)
                removed_pages.add(page.number)
                boxes[i] = [r.x0, r.y0, r.x1, r.y1]
            except ValueError as e:
                raise ValueError(f"edit {i + 1} ({op.get('type')}): {e}")
    for n in removed_pages:
        doc[n].apply_redactions()
    for i, op in enumerate(ops):
        t = op.get("type")
        if t in _REMOVE or not wanted(op):
            continue
        if t not in _DRAW:
            raise ValueError(f"edit {i + 1}: unknown edit '{t}'")
        try:
            boxes[i] = _DRAW[t](doc, op)
        except ValueError as e:
            raise ValueError(f"edit {i + 1} ({t}): {e}")
    for n, rect, pix in restore:  # the copies of a deleted picture that were not meant to go
        doc[n].insert_image(rect, pixmap=pix, overlay=True, keep_proportion=False)  # on top: behind would hide it under a full-page background
    return boxes


def preview_edits(path: str, page: int, ops: list[dict], width: int = 900, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        boxes = apply_edits(doc, ops, only_page=page)
        return {
            "page": page,
            "total": doc.page_count,
            **_render(doc[page - 1], width),
            "boxes": [{"index": i, "rect": r} for i, r in sorted(boxes.items())],
        }


def edit_pdf(input_path: str, output: str, ops: list[dict], flatten: bool = False, numbers: dict | None = None) -> dict:
    """Apply the placed items and, when `numbers` is given, page numbers / headers / footers in the same save."""
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        boxes = apply_edits(doc, ops) if ops else {}
        if numbers:
            _stamp_doc(doc, Path(input_path).stem, **numbers)
        if flatten:
            doc.bake(annots=True, widgets=False)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count, "edits": len(boxes)}


# ---------------------------------------------------------------------------------------------
# headers, footers, page numbers
# ---------------------------------------------------------------------------------------------

POSITIONS = ("top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right")


def _tokens(template: str, n: int, total: int, name: str) -> str:
    def num(m: re.Match) -> str:
        return str(n).zfill(int(m.group(1)) if m.group(1) else 0)

    out = re.sub(r"\{n(?::0?(\d+))?\}", num, template)
    return out.replace("{total}", str(total)).replace("{file}", name).replace("{date}", time.strftime("%Y-%m-%d"))


def _stamp_page(page, items: list[dict], n: int, total: int, name: str, size: float, margin: float, color, font, opacity: float, fontfile: str | None = None) -> None:
    r = page.rect
    asc = font.ascender
    for item in items:
        pos = item.get("position", "bottom-center")
        if pos not in POSITIONS:
            raise ValueError(f"unknown position '{pos}'")
        text = _tokens(str(item.get("text", "")), n, total, name)
        if not text.strip():
            continue
        w = font.text_length(text, size)
        x = {"left": margin, "center": (r.width - w) / 2, "right": r.width - margin - w}[pos.split("-")[1]]
        y = margin + asc * size if pos.startswith("top") else r.height - margin - (-font.descender) * size
        origin = _to_pdf_pt(page, x, y)
        put_line(page, origin, text, font, fontfile, size, color, opacity, page.rotation)


def stamp_pages(
    input_path: str,
    output: str,
    items: list[dict],
    pages_spec: str | None = None,
    size: float = 10,
    margin: float = 28,
    color: str = "#444444",
    font_name: str = "Arial",
    bold: bool = False,
    start_at: int = 1,
    opacity: float = 1.0,
) -> dict:
    """Page numbers, headers, footers and Bates-style labels. Tokens: {n} {n:04} {total} {file} {date}."""
    if not items:
        raise ValueError("add at least one header or footer text")
    name = Path(input_path).stem
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        chosen = _stamp_doc(doc, name, items, pages_spec, size, margin, color, font_name, bold, start_at, opacity)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count, "stamped": chosen}


def _stamp_doc(
    doc: "pymupdf.Document",
    name: str,
    items: list[dict],
    pages: str | None = None,
    size: float = 10,
    margin: float = 28,
    color: str = "#444444",
    font: str = "Arial",
    bold: bool = False,
    start_at: int = 1,
    opacity: float = 1.0,
) -> int:
    path = font_path(font, bold)
    fnt = pymupdf.Font(fontfile=path) if path else pymupdf.Font("helv")
    chosen = _select_pages(doc, pages)
    for i in chosen:
        _stamp_page(doc[i], items, start_at + i, doc.page_count + start_at - 1, name, size, margin, _rgb(color), fnt, opacity, path)
    return len(chosen)


def preview_stamp(path: str, page: int, items: list[dict], password: str | None = None, width: int = 700, **kw: Any) -> dict:
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        fp = font_path(kw.get("font_name", "Arial"), bool(kw.get("bold")))
        font = pymupdf.Font(fontfile=fp) if fp else pymupdf.Font("helv")
        start_at = int(kw.get("start_at", 1))
        spec = kw.get("pages_spec")
        stamped = (page - 1) in _select_pages(doc, spec)
        if stamped:
            _stamp_page(doc[page - 1], items, start_at + page - 1, doc.page_count + start_at - 1, Path(path).stem,
                        float(kw.get("size", 10)), float(kw.get("margin", 28)), _rgb(kw.get("color", "#444444")), font, float(kw.get("opacity", 1)), fp)
        return {"page": page, "total": doc.page_count, "stamped": stamped, **_render(doc[page - 1], width)}


# ---------------------------------------------------------------------------------------------
# page geometry
# ---------------------------------------------------------------------------------------------


def _content_box(page: "pymupdf.Page") -> pymupdf.Rect | None:
    box = pymupdf.Rect()
    found = False
    for b in page.get_text("blocks"):
        r = pymupdf.Rect(b[:4])
        box |= r
        found = True
    for img in page.get_image_info():
        box |= pymupdf.Rect(img["bbox"])
        found = True
    for d in page.get_drawings():
        r = pymupdf.Rect(d["rect"])
        if r.width > 0.5 or r.height > 0.5:
            box |= r
            found = True
    return box if found and not box.is_empty else None


def crop_pages(
    input_path: str,
    output: str,
    pages_spec: str | None = None,
    left: float = 0,
    top: float = 0,
    right: float = 0,
    bottom: float = 0,
    auto: bool = False,
    padding: float = 12,
) -> dict:
    """Trim margins (points, as displayed). `auto` crops to the content plus `padding`."""
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        done = 0
        for i in _select_pages(doc, pages_spec):
            page = doc[i]
            shown = page.rect * page.rotation_matrix if False else pymupdf.Rect(0, 0, page.rect.width, page.rect.height)
            if auto:
                content = _content_box(page)
                if content is None:
                    continue
                c = (pymupdf.Rect(content) * page.rotation_matrix).normalize()
                new = pymupdf.Rect(c.x0 - padding, c.y0 - padding, c.x1 + padding, c.y1 + padding) & shown
            else:
                new = pymupdf.Rect(shown.x0 + left, shown.y0 + top, shown.x1 - right, shown.y1 - bottom)
            if new.width < 20 or new.height < 20:
                raise ValueError(f"page {i + 1}: the crop leaves almost nothing")
            page.set_cropbox(_to_pdf(page, new) & page.mediabox)
            done += 1
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count, "cropped": done}


def resize_pages(input_path: str, output: str, size: str | list[float] = "A4", margin: float = 0, landscape: bool | None = None) -> dict:
    """Fit every page onto a new paper size, keeping proportions (centered)."""
    if isinstance(size, str):
        if size not in PAGE_SIZES:
            raise ValueError(f"unknown paper size '{size}'")
        base = PAGE_SIZES[size]
    else:
        base = (float(size[0]), float(size[1]))
    with pymupdf.open(input_path) as src:
        if src.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        out = pymupdf.open()
        try:
            for i, page in enumerate(src):
                jobctl.check()
                w, h = base
                land = (page.rect.width > page.rect.height) if landscape is None else landscape
                if land != (w > h):
                    w, h = h, w
                new = out.new_page(width=w, height=h)
                inner = pymupdf.Rect(margin, margin, w - margin, h - margin)
                new.show_pdf_page(inner, src, i, keep_proportion=True)
            out.save(output, garbage=3, deflate=True)
            return {"output": output, "pages": out.page_count}
        finally:
            out.close()


def insert_pages(
    input_path: str,
    output: str,
    after: int = 0,
    source: str | None = None,
    source_pages: str | None = None,
    blank: int = 0,
    size: str = "same",
) -> dict:
    """Insert pages after page `after` (0 = at the start): pages of another PDF, or blank pages."""
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        if not 0 <= after <= doc.page_count:
            raise ValueError(f"'after' must be between 0 and {doc.page_count}")
        added = 0
        if source:
            with pymupdf.open(source) as other:
                if other.needs_pass:
                    raise ValueError("the other PDF is password protected")
                pages = _select_pages(other, source_pages)
                for k, p in enumerate(pages):
                    doc.insert_pdf(other, from_page=p, to_page=p, start_at=after + k)
                added += len(pages)
        for k in range(blank):
            ref = doc[min(max(after - 1, 0), doc.page_count - 1)].rect if doc.page_count else pymupdf.Rect(0, 0, 595, 842)
            w, h = (ref.width, ref.height) if size == "same" else PAGE_SIZES.get(size, (595, 842))
            doc.new_page(pno=after + added + k, width=w, height=h)
        added += blank
        if not added:
            raise ValueError("nothing to insert")
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count, "inserted": added}


# ---------------------------------------------------------------------------------------------
# splitting and extracting
# ---------------------------------------------------------------------------------------------


def split_pdf_parts(input_path: str, out_dir: str, every: int = 0, at: list[int] | None = None, by_bookmarks: bool = False, name: str | None = None) -> dict:
    """Cut a PDF into several files: every N pages, before given pages, or at top-level bookmarks."""
    stem = name or Path(input_path).stem
    with pymupdf.open(input_path) as src:
        if src.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        n = src.page_count
        if by_bookmarks:
            cuts = sorted({p - 1 for lvl, _t, p in src.get_toc() if lvl == 1 and 1 < p <= n})
            if not cuts:
                raise ValueError("this PDF has no top-level bookmarks to split at")
        elif at:
            cuts = sorted({p - 1 for p in at if 1 < p <= n})
        elif every > 0:
            cuts = list(range(every, n, every))
        else:
            raise ValueError("choose how to split")
        bounds = [0] + cuts + [n]
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        created = []
        for k in range(len(bounds) - 1):
            jobctl.check()
            jobctl.report(k, len(bounds) - 1, f"part {k + 1}")
            part = pymupdf.open()
            part.insert_pdf(src, from_page=bounds[k], to_page=bounds[k + 1] - 1)
            dest = Path(out_dir) / f"{stem}_part{k + 1:02d}.pdf"
            if dest.exists():
                dest = Path(out_dir) / f"{stem}_part{k + 1:02d}_{int(time.time())}.pdf"
            part.save(str(dest), garbage=3, deflate=True)
            part.close()
            created.append(str(dest))
        return {"outputs": created, "created": created, "count": len(created)}


def extract_images(input_path: str, out_dir: str, pages_spec: str | None = None, min_size: int = 64) -> dict:
    stem = Path(input_path).stem
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        seen: set[int] = set()
        created = []
        pages = _select_pages(doc, pages_spec)
        for k, i in enumerate(pages):
            jobctl.check()
            jobctl.report(k, len(pages), f"page {i + 1}")
            for j, info in enumerate(doc[i].get_images(full=True)):
                xref = info[0]
                if xref in seen:
                    continue
                seen.add(xref)
                data = doc.extract_image(xref)
                if not data or min(data["width"], data["height"]) < min_size:
                    continue
                dest = Path(out_dir) / f"{stem}_p{i + 1}_{j + 1}.{data['ext']}"
                dest.write_bytes(data["image"])
                created.append(str(dest))
        if not created:
            raise ValueError("no images found")
        return {"outputs": created, "created": created, "count": len(created)}


def pdf_to_images(input_path: str, out_dir: str, dpi: int = 150, fmt: str = "png", pages_spec: str | None = None, quality: int = 90) -> dict:
    if fmt not in ("png", "jpg"):
        raise ValueError("format must be png or jpg")
    stem = Path(input_path).stem
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        pages = _select_pages(doc, pages_spec)
        created = []
        for k, i in enumerate(pages):
            jobctl.check()
            jobctl.report(k, len(pages), f"page {i + 1}")
            pix = doc[i].get_pixmap(dpi=dpi, alpha=False)
            dest = Path(out_dir) / f"{stem}_page{i + 1:03d}.{fmt}"
            if fmt == "jpg":
                dest.write_bytes(pix.tobytes("jpg", jpg_quality=quality))
            else:
                pix.save(str(dest))
            created.append(str(dest))
        return {"outputs": created, "created": created, "count": len(created)}


def images_to_pdf(inputs: list[str], output: str, page_size: str = "fit", margin: float = 0, quality: int = 92) -> dict:
    if not inputs:
        raise ValueError("choose at least one image")
    doc = pymupdf.open()
    try:
        for k, path in enumerate(inputs):
            jobctl.check()
            jobctl.report(k, len(inputs), Path(path).name)
            with Image.open(path) as src:
                img = ImageOps.exif_transpose(src)
                img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=quality)
                w_px, h_px = img.size
            if page_size == "fit":
                w, h = w_px * 72 / 150, h_px * 72 / 150
            else:
                if page_size not in PAGE_SIZES:
                    raise ValueError(f"unknown paper size '{page_size}'")
                w, h = PAGE_SIZES[page_size]
                if (w_px > h_px) != (w > h):
                    w, h = h, w
            page = doc.new_page(width=w, height=h)
            page.insert_image(pymupdf.Rect(margin, margin, w - margin, h - margin), stream=buf.getvalue(), keep_proportion=True)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}
    finally:
        doc.close()


def extract_text(input_path: str, output: str, fmt: str = "txt", pages_spec: str | None = None) -> dict:
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        pages = _select_pages(doc, pages_spec)
        parts, words = [], 0
        for i in pages:
            text = doc[i].get_text("text", sort=True).strip()
            words += len(text.split())
            parts.append((i + 1, text))
        if fmt == "json":
            body = json.dumps([{"page": p, "text": t} for p, t in parts], ensure_ascii=False, indent=2)
        elif fmt == "md":
            body = "\n\n".join(f"## Page {p}\n\n{t}" for p, t in parts)
        elif fmt == "txt":
            body = "\n\n".join(t for _p, t in parts)
        else:
            raise ValueError("format must be txt, md or json")
        if not words:
            raise ValueError("these pages contain no text (scanned pages need Recognize text first)")
        Path(output).write_text(body + "\n", encoding="utf-8")
        return {"output": output, "pages": len(pages), "words": words}


def flatten_pdf(input_path: str, output: str, annotations: bool = True, forms: bool = True, remove_links: bool = False) -> dict:
    """Bake annotations and form fields into the page so they can no longer be edited."""
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        doc.bake(annots=annotations, widgets=forms)
        if remove_links:
            for page in doc:
                for link in page.get_links():
                    page.delete_link(link)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}


def pdf_to_grayscale(input_path: str, output: str) -> dict:
    """Convert the images inside the PDF to grayscale (text and vector colors are left as they are)."""
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        doc.rewrite_images(set_to_gray=True)
        doc.save(output, garbage=4, deflate=True)
        return {"output": output, "pages": doc.page_count}


# ---------------------------------------------------------------------------------------------
# forms
# ---------------------------------------------------------------------------------------------


def list_form_fields(path: str, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        fields = []
        for page in doc:
            for w in page.widgets() or []:
                fields.append(
                    {
                        "page": page.number + 1,
                        "name": w.field_name,
                        "type": w.field_type_string,
                        "value": w.field_value if w.field_value not in (None, "Off") else ("" if w.field_type_string != "CheckBox" else False),
                        "choices": list(w.choice_values or []),
                        "readonly": bool(w.field_flags & 1),
                        "rect": _shown(page, w.rect),
                    }
                )
        return {"fields": fields, "pages": doc.page_count}


def fill_form(input_path: str, output: str, values: dict[str, Any], flatten: bool = False) -> dict:
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        filled, unknown = 0, set(values)
        for page in doc:
            for w in page.widgets() or []:
                if w.field_name not in values:
                    continue
                unknown.discard(w.field_name)
                v = values[w.field_name]
                if w.field_type_string in ("CheckBox", "RadioButton"):
                    on = w.on_state()
                    w.field_value = on if (v is True or str(v).lower() in ("true", "yes", "1", str(on).lower())) else "Off"
                else:
                    w.field_value = "" if v is None else str(v)
                w.update()
                filled += 1
        if unknown:
            raise ValueError(f"unknown form fields: {', '.join(sorted(unknown))}")
        if flatten:
            doc.bake(annots=False, widgets=True)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count, "filled": filled}


# ---------------------------------------------------------------------------------------------
# document properties and bookmarks
# ---------------------------------------------------------------------------------------------

META_KEYS = ("title", "author", "subject", "keywords", "creator", "producer")


def get_properties(path: str, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        meta = {k: (doc.metadata or {}).get(k) or "" for k in META_KEYS}
        return {"metadata": meta, "toc": [[lvl, title, page] for lvl, title, page in doc.get_toc()], "pages": doc.page_count}


def set_properties(input_path: str, output: str, metadata: dict[str, str] | None = None, toc: list[list] | None = None) -> dict:
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        if metadata is not None:
            merged = dict(doc.metadata or {})
            for k in META_KEYS:
                if k in metadata:
                    merged[k] = str(metadata[k])
            doc.set_metadata(merged)
            doc.del_xml_metadata()
        if toc is not None:
            clean, prev = [], 0
            for item in toc:
                lvl, title, page = int(item[0]), str(item[1]).strip(), int(item[2])
                if not title:
                    raise ValueError("a bookmark has no title")
                if not 1 <= page <= doc.page_count:
                    raise ValueError(f"bookmark '{title}' points to page {page}, which does not exist")
                if lvl < 1 or lvl > prev + 1:
                    lvl = min(max(lvl, 1), prev + 1)  # levels may only go one deeper at a time
                clean.append([lvl, title, page])
                prev = lvl
            doc.set_toc(clean)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}
