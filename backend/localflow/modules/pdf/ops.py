"""Pure PDF operations. Module-level functions so the process pool can pickle them."""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf

from ... import jobctl


def parse_page_ranges(spec: str, page_count: int) -> list[int]:
    """'1-3,5,8-' -> zero-based page indices. Pages are 1-based in the spec."""
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, _, end_s = part.partition("-")
            start = int(start_s) if start_s else 1
            end = int(end_s) if end_s else page_count
        else:
            start = end = int(part)
        if start < 1 or end > page_count or start > end:
            raise ValueError(f"invalid page range '{part}' for {page_count}-page document")
        pages.extend(range(start - 1, end))
    if not pages:
        raise ValueError("no pages selected")
    return pages


def merge_pdfs(inputs: list[str], output: str) -> dict:
    out = pymupdf.open()
    try:
        for p in inputs:
            with pymupdf.open(p) as src:
                out.insert_pdf(src)
        out.save(output)
        return {"output": output, "pages": out.page_count}
    finally:
        out.close()


def split_pdf(input_path: str, pages_spec: str, output: str) -> dict:
    with pymupdf.open(input_path) as src:
        indices = parse_page_ranges(pages_spec, src.page_count)
        out = pymupdf.open()
        try:
            for i in indices:
                out.insert_pdf(src, from_page=i, to_page=i)
            out.save(output)
            return {"output": output, "pages": out.page_count}
        finally:
            out.close()


def encrypt_pdf(input_path: str, output: str, user_password: str, owner_password: str | None = None) -> dict:
    """AES-256 encryption. Opening the file requires `user_password`."""
    if not user_password:
        raise ValueError("a password is required")
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is already password protected; unlock it first")
        doc.save(
            output,
            encryption=pymupdf.PDF_ENCRYPT_AES_256,
            user_pw=user_password,
            owner_pw=owner_password or user_password,
            garbage=3,
            deflate=True,
        )
        return {"output": output, "pages": doc.page_count}


def unlock_pdf(input_path: str, output: str, password: str = "") -> dict:
    """Write an unencrypted copy. Requires the password (user or owner) when one is set."""
    with pymupdf.open(input_path) as doc:
        if doc.is_encrypted and not doc.authenticate(password):
            raise ValueError("incorrect password")
        doc.save(output, encryption=pymupdf.PDF_ENCRYPT_NONE, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}


def _select_pages(doc: "pymupdf.Document", pages_spec: str | None) -> list[int]:
    return parse_page_ranges(pages_spec, doc.page_count) if pages_spec else list(range(doc.page_count))


def _stamp_text(page, text, opacity, angle, font_size, color, font) -> None:
    rect = page.rect
    width = font.text_length(text, fontsize=font_size)
    center = pymupdf.Point(rect.width / 2, rect.height / 2)
    origin = pymupdf.Point(center.x - width / 2, center.y + font_size * 0.3)
    tw = pymupdf.TextWriter(rect, opacity=opacity, color=color)
    tw.append(origin, text, font=font, fontsize=font_size)
    tw.write_text(page, morph=(center, pymupdf.Matrix(angle)))


def _stamp_image(page, image_path, x, y, width, from_bottom_right=True) -> None:
    pix = pymupdf.Pixmap(image_path)
    height = width * pix.height / pix.width
    r = page.rect
    x0, y0 = (r.width - x - width, r.height - y - height) if from_bottom_right else (x, y)
    page.insert_image(pymupdf.Rect(x0, y0, x0 + width, y0 + height), filename=image_path, overlay=True)


def watermark_text(
    input_path: str,
    output: str,
    text: str,
    pages_spec: str | None = None,
    opacity: float = 0.25,
    angle: float = 45.0,
    font_size: float = 64.0,
    color: tuple[float, float, float] = (0.6, 0.0, 0.0),
) -> dict:
    """Stamp centered text across the selected pages."""
    if not text.strip():
        raise ValueError("watermark text is empty")
    font = _unicode_font()
    with pymupdf.open(input_path) as doc:
        for i in _select_pages(doc, pages_spec):
            _stamp_text(doc[i], text, opacity, angle, font_size, color, font)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}


def watermark_image(
    input_path: str,
    output: str,
    image_path: str,
    pages_spec: str | None = None,
    x: float = 36.0,
    y: float = 36.0,
    width: float = 120.0,
    from_bottom_right: bool = True,
) -> dict:
    """Place a logo/signature image. x,y are offsets in points from the chosen corner."""
    with pymupdf.open(input_path) as doc:
        for i in _select_pages(doc, pages_spec):
            _stamp_image(doc[i], image_path, x, y, width, from_bottom_right)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}


def _unicode_font() -> "pymupdf.Font":
    """A font that covers Turkish and other Latin-extended glyphs; Helvetica as last resort."""
    for candidate in (
        r"C:\Windows\Fonts\arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(candidate).is_file():
            return pymupdf.Font(fontfile=candidate)
    return pymupdf.Font("helv")


# A recognized text line: (x0, y0, x1, y1, text) in pixel coordinates of the rendered page.
Line = tuple[float, float, float, float, str]


def _windows_ocr_available() -> bool:
    if sys.platform != "win32":
        return False
    try:
        from winrt.windows.media.ocr import OcrEngine

        return len(OcrEngine.available_recognizer_languages) > 0
    except Exception:
        return False


def _make_windows_recognizer():
    """Windows.Media.Ocr: uses the user's installed OCR languages (e.g. Turkish)."""
    import asyncio

    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        engine = OcrEngine.try_create_from_language(OcrEngine.available_recognizer_languages[0])

    async def run(png: bytes) -> list[Line]:
        stream = InMemoryRandomAccessStream()
        writer = DataWriter(stream)
        writer.write_bytes(bytearray(png))
        await writer.store_async()
        await writer.flush_async()
        writer.detach_stream()
        stream.seek(0)
        decoder = await BitmapDecoder.create_async(stream)
        bitmap = await decoder.get_software_bitmap_async()
        result = await engine.recognize_async(bitmap)
        lines: list[Line] = []
        for line in result.lines:
            rects = [w.bounding_rect for w in line.words]
            if not rects:
                continue
            x0 = min(r.x for r in rects)
            y0 = min(r.y for r in rects)
            x1 = max(r.x + r.width for r in rects)
            y1 = max(r.y + r.height for r in rects)
            lines.append((x0, y0, x1, y1, line.text))
        return lines

    return lambda pix: asyncio.run(run(pix.tobytes("png")))


def _make_rapid_recognizer(min_score: float):
    """Bundled ONNX engine. Works offline everywhere, but drops Turkish diacritics."""
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()

    def recognize(pix) -> list[Line]:
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
        result, _ = engine(img)
        lines: list[Line] = []
        for box, text, score in result or []:
            if float(score) < min_score:
                continue
            xs = [pt[0] for pt in box]
            ys = [pt[1] for pt in box]
            lines.append((min(xs), min(ys), max(xs), max(ys), text))
        return lines

    return recognize


def ocr_image_text(png: bytes, engine: str = "auto", min_score: float = 0.5) -> dict:
    """Recognize text in one image (used by screen text capture). Returns lines in reading order."""
    pix = pymupdf.Pixmap(png)
    if pix.alpha or pix.colorspace != pymupdf.csRGB:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    if engine == "auto":
        engine = "windows" if _windows_ocr_available() else "rapidocr"
    if engine == "windows":
        if not _windows_ocr_available():
            raise ValueError("Windows OCR is not available (no OCR language pack installed)")
        recognize = _make_windows_recognizer()
    elif engine == "rapidocr":
        recognize = _make_rapid_recognizer(min_score)
    else:
        raise ValueError(f"unknown OCR engine '{engine}'")
    lines = sorted(recognize(pix), key=lambda l: (round(l[1] / max(pix.height / 60, 1)), l[0]))
    return {"text": "\n".join(l[4] for l in lines if l[4].strip()), "engine": engine}


def ocr_pdf(
    input_path: str,
    output: str,
    pages_spec: str | None = None,
    engine: str = "auto",
    dpi: int = 200,
    min_score: float = 0.5,
) -> dict:
    """Add an invisible, selectable text layer to scanned pages (original look is unchanged).

    engine: "auto" prefers Windows OCR (installed language packs, e.g. Turkish) and falls back
    to the bundled RapidOCR; "windows" / "rapidocr" force one.
    """
    if engine == "auto":
        engine = "windows" if _windows_ocr_available() else "rapidocr"
    if engine == "windows":
        if not _windows_ocr_available():
            raise ValueError("Windows OCR is not available (no OCR language pack installed)")
        recognize = _make_windows_recognizer()
    elif engine == "rapidocr":
        recognize = _make_rapid_recognizer(min_score)
    else:
        raise ValueError(f"unknown OCR engine '{engine}'")

    font = _unicode_font()
    scale = 72.0 / dpi
    words = 0
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        selected = _select_pages(doc, pages_spec)
        for n, i in enumerate(selected):
            jobctl.check()
            jobctl.report(n, len(selected), f"page {i + 1}")
            page = doc[i]
            pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False)
            for px0, py0, px1, py1, text in recognize(pix):
                if not text.strip():
                    continue
                x0, x1, y0, y1 = px0 * scale, px1 * scale, py0 * scale, py1 * scale
                height = max(y1 - y0, 1.0)
                size = height * 0.85
                natural = font.text_length(text, fontsize=size)
                sx = (x1 - x0) / natural if natural > 0 else 1.0
                origin = pymupdf.Point(x0, y1 - height * 0.2)
                tw = pymupdf.TextWriter(page.rect)
                tw.append(origin, text, font=font, fontsize=size)
                # stretch each line horizontally to the detected box so selection lines up
                tw.write_text(page, morph=(origin, pymupdf.Matrix(sx, 1)), render_mode=3)
                words += len(text.split())
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count, "words": words, "engine": engine}


def compress_pdf(input_path: str, output: str, dpi: int = 120, quality: int = 70) -> dict:
    """Downsample/recompress images and drop unused objects. Text and vectors are untouched."""
    before = Path(input_path).stat().st_size
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        doc.rewrite_images(dpi_threshold=int(dpi * 1.25), dpi_target=dpi, quality=quality)
        doc.save(output, garbage=4, deflate=True, clean=True)
        pages = doc.page_count
    after = Path(output).stat().st_size
    return {"output": output, "pages": pages, "before_bytes": before, "after_bytes": after}


def organize_pdf(
    input_path: str,
    output: str,
    order: str | None = None,
    rotate: int = 0,
    rotate_pages: str | None = None,
    plan: list[dict] | None = None,
) -> dict:
    """Reorder / duplicate / drop pages and rotate them.

    Either `plan` (a list of {"page": 1-based source page, "rotate": 0/90/180/270} in the new order;
    each entry rotates on its own, even when the same source page appears twice) or the older
    `order` spec with one `rotate` for `rotate_pages`.
    """
    if rotate not in (0, 90, 180, 270):
        raise ValueError("rotation must be 0, 90, 180 or 270")
    with pymupdf.open(input_path) as src:
        if src.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        if plan is None:
            indices = parse_page_ranges(order, src.page_count) if order else list(range(src.page_count))
            # rotate_pages counts positions in the result (as the old API did), not source pages
            if not rotate:
                rotated: set[int] = set()
            elif rotate_pages:
                rotated = set(parse_page_ranges(rotate_pages, len(indices)))
            else:
                rotated = set(range(len(indices)))
            plan = [{"page": i + 1, "rotate": rotate if pos in rotated else 0} for pos, i in enumerate(indices)]
        if not plan:
            raise ValueError("the result would have no pages")
        out = pymupdf.open()
        try:
            for item in plan:
                p, rot = int(item["page"]), int(item.get("rotate", 0))
                if not 1 <= p <= src.page_count:
                    raise ValueError(f"invalid page {p} for {src.page_count}-page document")
                if rot not in (0, 90, 180, 270):
                    raise ValueError("rotation must be 0, 90, 180 or 270")
                out.insert_pdf(src, from_page=p - 1, to_page=p - 1)  # a fresh copy, so duplicates rotate independently
                if rot:
                    page = out[out.page_count - 1]
                    page.set_rotation((page.rotation + rot) % 360)
            out.save(output, garbage=3, deflate=True)
            return {"output": output, "pages": out.page_count}
        finally:
            out.close()


def redact_pdf(
    input_path: str,
    output: str,
    terms: list[str] | None = None,
    pages_spec: str | None = None,
    rects: list[dict] | None = None,
) -> dict:
    """Permanently remove text matching `terms` and/or the given areas (the content underneath is deleted).

    `rects` are {"page": 1-based, "x0", "y0", "x1", "y1"} in the coordinates of the page as it is displayed
    (points, origin top-left, after the page's own rotation): the same space the preview and search use.
    """
    terms = [t for t in (t.strip() for t in (terms or [])) if t]
    rects = rects or []
    if not terms and not rects:
        raise ValueError("nothing to redact")
    hits = 0
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        per_page: dict[int, list] = {}
        if terms:
            for i in _select_pages(doc, pages_spec):
                for term in terms:  # search_for already returns rectangles in page (unrotated) space
                    per_page.setdefault(i, []).extend(doc[i].search_for(term))
        for r in rects:
            i = int(r["page"]) - 1
            if not 0 <= i < doc.page_count:
                raise ValueError(f"invalid page {r['page']}")
            area = pymupdf.Rect(r["x0"], r["y0"], r["x1"], r["y1"]) * doc[i].derotation_matrix
            per_page.setdefault(i, []).append(area.normalize())
        for i, areas in per_page.items():
            page = doc[i]
            for area in areas:
                page.add_redact_annot(area, fill=(0, 0, 0))
            page.apply_redactions()
            hits += len(areas)
        doc.set_metadata({})  # titles and authors often repeat the redacted text
        doc.save(output, garbage=4, deflate=True, clean=True)
        return {"output": output, "pages": doc.page_count, "redactions": hits}


def clean_pdf_metadata(input_path: str, output: str) -> dict:
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        removed = [k for k, v in (doc.metadata or {}).items() if v and k not in ("format", "encryption")]
        doc.set_metadata({})
        doc.del_xml_metadata()
        doc.save(output, garbage=4, deflate=True)
        return {"output": output, "pages": doc.page_count, "removed_fields": removed}


def pdf_to_docx(input_path: str, output: str) -> dict:
    """Layout-preserving as far as pdf2docx can; complex layouts and scans will not be perfect."""
    from pdf2docx import Converter

    cv = Converter(input_path)
    try:
        cv.convert(output)
    finally:
        cv.close()
    with pymupdf.open(input_path) as doc:
        return {"output": output, "pages": doc.page_count}


def find_soffice() -> str | None:
    import shutil

    found = shutil.which("soffice")
    if found:
        return found
    for c in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/bin/soffice",
    ):
        if Path(c).is_file():
            return c
    return None


OFFICE_EXTS = {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".txt"}


def office_to_pdf(input_path: str, output: str) -> dict:
    import shutil
    import subprocess
    import tempfile

    soffice = find_soffice()
    if not soffice:
        raise ValueError("LibreOffice was not found. Install LibreOffice to convert Office files to PDF.")
    src = Path(input_path)
    if src.suffix.lower() not in OFFICE_EXTS:
        raise ValueError(f"unsupported file type '{src.suffix}'")
    with tempfile.TemporaryDirectory() as tmp:
        profile = Path(tmp, "profile").as_uri()  # private profile: never collides with a running LibreOffice
        outdir = Path(tmp, "out")
        proc = subprocess.run(
            [soffice, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "pdf", "--outdir", str(outdir), str(src)],
            capture_output=True, text=True, timeout=300,
        )
        produced = outdir / (src.stem + ".pdf")
        if proc.returncode != 0 or not produced.is_file():
            raise ValueError((proc.stderr or proc.stdout or "conversion failed").strip()[-300:])
        shutil.move(str(produced), output)
    with pymupdf.open(output) as doc:
        return {"output": output, "pages": doc.page_count}


# ---------------------------------------------------------------------------------------------
# Viewer helpers: what the preview panes show. Quick, so the API runs them synchronously.
# ---------------------------------------------------------------------------------------------


class NeedsPassword(ValueError):
    pass


def _open_for_view(path: str, password: str | None = None) -> "pymupdf.Document":
    doc = pymupdf.open(path)
    if doc.needs_pass and not (password and doc.authenticate(password)):
        doc.close()
        raise NeedsPassword("the document is password protected")
    return doc


def _render(page: "pymupdf.Page", width: int) -> dict:
    import base64

    zoom = width / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    return {
        "image": base64.b64encode(pix.tobytes("png")).decode(),
        "width": pix.width,
        "height": pix.height,
        "page_width": page.rect.width,
        "page_height": page.rect.height,
    }


def pdf_info(path: str, password: str | None = None) -> dict:
    try:
        with _open_for_view(path, password) as doc:
            first = doc[0].rect if doc.page_count else pymupdf.Rect(0, 0, 0, 0)
            return {
                "pages": doc.page_count,
                "needs_password": False,
                "title": (doc.metadata or {}).get("title") or "",
                "width": first.width,
                "height": first.height,
            }
    except NeedsPassword:
        return {"pages": 0, "needs_password": True, "title": "", "width": 0, "height": 0}


def render_page(path: str, page: int, width: int = 700, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        return {"page": page, "total": doc.page_count, **_render(doc[page - 1], width)}


def render_thumbnails(path: str, start: int = 1, count: int = 12, width: int = 150, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        first = max(1, start)
        last = min(doc.page_count, first + count - 1)
        items = [{"page": n, **_render(doc[n - 1], width)} for n in range(first, last + 1)]
        return {"total": doc.page_count, "items": items}


def search_pdf(path: str, terms: list[str], pages_spec: str | None = None, password: str | None = None) -> dict:
    """Where each term occurs, as rectangles in displayed page coordinates (points, after page rotation)."""
    terms = [t for t in (t.strip() for t in terms) if t]
    if not terms:
        raise ValueError("no search terms")
    with _open_for_view(path, password) as doc:
        pages, total = [], 0
        for i in _select_pages(doc, pages_spec):
            page = doc[i]
            hits = []
            for term in terms:
                for r in page.search_for(term):
                    v = pymupdf.Rect(r) * page.rotation_matrix
                    v.normalize()
                    hits.append({"term": term, "rect": [v.x0, v.y0, v.x1, v.y1]})
            if hits:
                hits.sort(key=lambda h: (h["rect"][1], h["rect"][0]))
                pages.append({"page": i + 1, "width": page.rect.width, "height": page.rect.height, "hits": hits})
                total += len(hits)
        return {"total": total, "pages": pages, "page_count": doc.page_count}


def preview_watermark(
    path: str,
    page: int,
    kind: str,
    pages_spec: str | None = None,
    width: int = 700,
    password: str | None = None,
    text: str | None = None,
    opacity: float = 0.25,
    angle: float = 45.0,
    font_size: float = 64.0,
    image_path: str | None = None,
    x: float = 36.0,
    y: float = 36.0,
    image_width: float = 120.0,
) -> dict:
    """The page as it will look after stamping; pages outside the selection come back unstamped."""
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        stamped = (page - 1) in _select_pages(doc, pages_spec)
        if stamped:
            if kind == "text":
                if not (text or "").strip():
                    raise ValueError("watermark text is empty")
                _stamp_text(doc[page - 1], text, opacity, angle, font_size, (0.6, 0.0, 0.0), _unicode_font())
            else:
                if not image_path:
                    raise ValueError("choose an image")
                _stamp_image(doc[page - 1], image_path, x, y, image_width)
        return {"page": page, "total": doc.page_count, "stamped": stamped, **_render(doc[page - 1], width)}


def ensure_not_exists(path: Path) -> None:
    if path.exists():
        raise FileExistsError(f"refusing to overwrite existing file: {path}")
