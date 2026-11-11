"""More PDF tools: compare, pictures inside a PDF, text lookup for editing, attachments and page labels,
repair, print layouts (N-up, booklet), scan cleanup and batch processing."""
from __future__ import annotations

import base64
import difflib
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np
import pymupdf

from ... import jobctl
from .ops import (
    _open_for_view,
    _select_pages,
    clean_pdf_metadata,
    compress_pdf,
    encrypt_pdf,
    watermark_text,
)

# ---------------------------------------------------------------------------------------------
# compare two PDFs
# ---------------------------------------------------------------------------------------------


def _png_b64(pix: "pymupdf.Pixmap") -> str:
    return base64.b64encode(pix.tobytes("png")).decode("ascii")


def compare_pdfs(path_a: str, path_b: str, width: int = 700, max_pages: int = 60) -> dict:
    """Page by page: which lines were removed or added, and a picture of B with the differences in red."""
    with _open_for_view(path_a) as a, _open_for_view(path_b) as b:
        n = max(a.page_count, b.page_count)
        pages, changed = [], 0
        for i in range(min(n, max_pages)):
            jobctl.check()
            jobctl.report(i, min(n, max_pages), f"page {i + 1}")
            if i >= a.page_count or i >= b.page_count:
                pages.append({"page": i + 1, "status": "only_in_b" if i >= a.page_count else "only_in_a", "removed": [], "added": [], "image": None})
                changed += 1
                continue
            ta = [ln.strip() for ln in a[i].get_text().splitlines() if ln.strip()]
            tb = [ln.strip() for ln in b[i].get_text().splitlines() if ln.strip()]
            removed, added = [], []
            for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ta, tb, autojunk=False).get_opcodes():
                if tag in ("replace", "delete"):
                    removed += ta[i1:i2]
                if tag in ("replace", "insert"):
                    added += tb[j1:j2]
            scale = width / max(1.0, b[i].rect.width)
            pa = a[i].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            pb = b[i].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            img = None
            visual = 0.0
            if (pa.width, pa.height) == (pb.width, pb.height):
                xa = np.frombuffer(pa.samples, np.uint8).reshape(pa.height, pa.width, 3).astype(np.int16)
                xb = np.frombuffer(pb.samples, np.uint8).reshape(pb.height, pb.width, 3).astype(np.int16)
                mask = np.abs(xa - xb).sum(axis=2) > 60
                visual = float(mask.mean())
                if mask.any():
                    out = (xb * 0.35 + 255 * 0.65).astype(np.uint8)  # B, faded
                    out[mask] = (230, 40, 40)
                    pix = pymupdf.Pixmap(pymupdf.csRGB, pb.width, pb.height, out.tobytes(), False)
                    img = _png_b64(pix)
            else:
                visual = 1.0
            status = "changed" if (removed or added or visual > 0.0005) else "same"
            if status == "changed":
                changed += 1
            pages.append({"page": i + 1, "status": status, "removed": removed[:40], "added": added[:40], "image": img, "different": round(visual, 4)})
        return {"pages": pages, "changed": changed, "pages_a": a.page_count, "pages_b": b.page_count, "truncated": n > max_pages}


# ---------------------------------------------------------------------------------------------
# pictures inside a PDF
# ---------------------------------------------------------------------------------------------


def list_images(path: str, page: int, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        p = doc[page - 1]
        out, seen = [], set()
        for img in p.get_images(full=True):
            xref = img[0]
            for r in p.get_image_rects(xref):
                v = (pymupdf.Rect(r) * p.rotation_matrix).normalize()
                if (xref, round(v.x0), round(v.y0)) in seen:
                    continue
                seen.add((xref, round(v.x0), round(v.y0)))
                out.append({"xref": xref, "rect": [v.x0, v.y0, v.x1, v.y1], "width": img[2], "height": img[3]})
        return {"page": page, "width": p.rect.width, "height": p.rect.height, "images": out}


def change_images(input_path: str, output: str, actions: list[dict]) -> dict:
    """actions: {"page": 1-based, "xref": int, "action": "delete" | "replace", "path": new image}."""
    if not actions:
        raise ValueError("nothing to change")
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        for a in actions:
            i = int(a["page"]) - 1
            if not 0 <= i < doc.page_count:
                raise ValueError(f"invalid page {a['page']}")
            page = doc[i]
            xref = int(a["xref"])
            if a.get("action") == "replace":
                if not a.get("path"):
                    raise ValueError("choose the new picture")
                page.replace_image(xref, filename=str(a["path"]))
            else:
                page.delete_image(xref)
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "changed": len(actions)}


# ---------------------------------------------------------------------------------------------
# find the original text under a click (to retype it)
# ---------------------------------------------------------------------------------------------


def text_at(path: str, page: int, x: float, y: float, password: str | None = None) -> dict:
    """The line of text under a point (displayed coordinates), with its look, or {"found": false}."""
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        p = doc[page - 1]
        pt = pymupdf.Point(x, y) * p.derotation_matrix
        for block in p.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                box = pymupdf.Rect(line["bbox"])
                if (box + (-2, -2, 2, 2)).contains(pt):
                    spans = [s for s in line["spans"] if s["text"].strip()]
                    if not spans:
                        continue
                    s0 = spans[0]
                    v = (box * p.rotation_matrix).normalize()
                    color = "#%06x" % (s0["color"] & 0xFFFFFF)
                    flags = s0["flags"]
                    return {
                        "found": True,
                        "text": "".join(s["text"] for s in line["spans"]),
                        "rect": [v.x0, v.y0, v.x1, v.y1],
                        "size": round(s0["size"], 1),
                        "color": color,
                        "font": s0["font"],
                        "bold": bool(flags & 16) or "bold" in s0["font"].lower(),
                        "italic": bool(flags & 2) or "italic" in s0["font"].lower() or "oblique" in s0["font"].lower(),
                    }
        return {"found": False}


# ---------------------------------------------------------------------------------------------
# attachments, page labels
# ---------------------------------------------------------------------------------------------


def list_attachments(path: str, password: str | None = None) -> dict:
    with _open_for_view(path, password) as doc:
        items = []
        for name in doc.embfile_names():
            info = doc.embfile_info(name)
            items.append({"name": name, "size": info.get("size", 0)})
        labels = doc.get_page_labels() if hasattr(doc, "get_page_labels") else []
        return {"attachments": items, "labels": labels, "pages": doc.page_count}


def set_attachments_and_labels(
    input_path: str, output: str, add: list[str] | None = None, remove: list[str] | None = None, labels: list[dict] | None = None
) -> dict:
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        for name in remove or []:
            if name in doc.embfile_names():
                doc.embfile_del(name)
        for f in add or []:
            p = Path(f)
            name, k = p.name, 1
            while name in doc.embfile_names():
                k += 1
                name = f"{p.stem}_{k}{p.suffix}"
            doc.embfile_add(name, p.read_bytes())
        if labels is not None:
            doc.set_page_labels(
                [
                    {"startpage": int(x["startpage"]) - 1, "prefix": str(x.get("prefix", "")), "style": str(x.get("style", "D")), "firstpagenum": int(x.get("firstpagenum", 1))}
                    for x in labels
                ]
            )
        doc.save(output, garbage=3, deflate=True)
        return {"output": output, "attachments": len(doc.embfile_names())}


# ---------------------------------------------------------------------------------------------
# permissions, repair
# ---------------------------------------------------------------------------------------------

PERMISSIONS = {
    "print": pymupdf.PDF_PERM_PRINT,
    "edit": pymupdf.PDF_PERM_MODIFY,
    "copy": pymupdf.PDF_PERM_COPY,
    "annotate": pymupdf.PDF_PERM_ANNOTATE,
}


def restrict_pdf(input_path: str, output: str, owner_password: str, allow: list[str]) -> dict:
    """Anyone can open the file, but only what is in `allow` (print, copy, edit, annotate) is permitted without the owner password."""
    if not owner_password:
        raise ValueError("choose an owner password; it is needed to lift the limits again")
    bad = [a for a in allow if a not in PERMISSIONS]
    if bad:
        raise ValueError(f"unknown permission '{bad[0]}'")
    perm = int(pymupdf.PDF_PERM_ACCESSIBILITY)
    for a in allow:
        perm |= int(PERMISSIONS[a])
    with pymupdf.open(input_path) as doc:
        if doc.needs_pass:
            raise ValueError("the document is already password protected; unlock it first")
        doc.save(output, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw=owner_password, user_pw="", permissions=perm, garbage=3, deflate=True)
        return {"output": output, "pages": doc.page_count}


def repair_pdf(input_path: str, output: str) -> dict:
    """Open a damaged file (MuPDF rebuilds what it can) and write it out cleanly."""
    try:
        doc = pymupdf.open(input_path)
    except Exception as e:
        raise ValueError(f"this file cannot be repaired: {e}")
    with doc:
        if doc.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        if doc.page_count == 0:
            raise ValueError("no pages could be recovered")
        repaired = bool(getattr(doc, "is_repaired", False))
        doc.save(output, garbage=4, deflate=True, clean=True)
        return {"output": output, "pages": doc.page_count, "was_damaged": repaired}


# ---------------------------------------------------------------------------------------------
# print layouts
# ---------------------------------------------------------------------------------------------

SHEETS = {"A4": (595, 842), "A3": (842, 1191), "Letter": (612, 792)}


def impose_pdf(input_path: str, output: str, mode: str = "nup", per_sheet: int = 2, paper: str = "A4", landscape: bool = True, margin: float = 18, gap: float = 8, border: bool = False) -> dict:
    """nup: several pages on one sheet. booklet: pages reordered so the folded sheets read in order."""
    if paper not in SHEETS:
        raise ValueError("unknown paper size")
    w, h = SHEETS[paper]
    if landscape:
        w, h = h, w
    with pymupdf.open(input_path) as src:
        if src.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        n = src.page_count
        out = pymupdf.open()
        if mode == "booklet":
            total = ((n + 3) // 4) * 4
            order = []
            for k in range(total // 4):
                a, b, c, d = total - 2 * k, 2 * k + 1, 2 * k + 2, total - 2 * k - 1
                order += [(a, b), (c, d)]  # front of the sheet, then its back
            cols, rows = 2, 1
            sheets = [[p - 1 if p <= n else None for p in pair] for pair in order]
            w, h = max(w, h), min(w, h)
        else:
            grid = {2: (2, 1), 4: (2, 2), 6: (3, 2), 8: (4, 2), 9: (3, 3), 16: (4, 4)}
            if per_sheet not in grid:
                raise ValueError("choose 2, 4, 6, 8, 9 or 16 pages per sheet")
            cols, rows = grid[per_sheet]
            if rows > cols and landscape:
                cols, rows = rows, cols
            sheets = [[i if i < n else None for i in range(s, s + per_sheet)] for s in range(0, n, per_sheet)]
        cw = (w - 2 * margin - gap * (cols - 1)) / cols
        ch = (h - 2 * margin - gap * (rows - 1)) / rows
        for si, sheet in enumerate(sheets):
            jobctl.check()
            jobctl.report(si, len(sheets), f"sheet {si + 1}")
            page = out.new_page(width=w, height=h)
            for k, idx in enumerate(sheet):
                if idx is None:
                    continue
                r, c = divmod(k, cols)
                cell = pymupdf.Rect(margin + c * (cw + gap), margin + r * (ch + gap), margin + c * (cw + gap) + cw, margin + r * (ch + gap) + ch)
                page.show_pdf_page(cell, src, idx, keep_proportion=True)
                if border:
                    page.draw_rect(cell, color=(0.6, 0.6, 0.6), width=0.5)
        out.save(output, garbage=3, deflate=True)
        pages = out.page_count
        out.close()
        return {"output": output, "pages": pages, "sheets": len(sheets)}


# ---------------------------------------------------------------------------------------------
# scan cleanup
# ---------------------------------------------------------------------------------------------


def _deskew_angle(gray: np.ndarray) -> float:
    import cv2

    small = gray if max(gray.shape) <= 1200 else cv2.resize(gray, None, fx=1200 / max(gray.shape), fy=1200 / max(gray.shape))
    ink = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    coords = cv2.findNonZero(ink)
    if coords is None or len(coords) < 200:
        return 0.0
    angle = cv2.minAreaRect(coords)[-1]
    if angle > 45:
        angle -= 90
    elif angle < -45:
        angle += 90
    return float(angle) if abs(angle) <= 15 else 0.0


def clean_scan_pages(input_path: str, output: str, deskew: bool = True, crop: bool = True, mode: str = "contrast", dpi: int = 200) -> dict:
    """Straighten, trim the dark edges and clean up scanned pages. mode: contrast | gray | bw."""
    import cv2

    if mode not in ("contrast", "gray", "bw"):
        raise ValueError("unknown mode")
    with pymupdf.open(input_path) as src:
        if src.needs_pass:
            raise ValueError("the document is password protected; unlock it first")
        out = pymupdf.open()
        fixed = 0
        for i in range(src.page_count):
            jobctl.check()
            jobctl.report(i, src.page_count, f"page {i + 1}")
            pix = src[i].get_pixmap(dpi=dpi, alpha=False)
            img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            if deskew:
                a = _deskew_angle(gray)
                if abs(a) >= 0.2:
                    m = cv2.getRotationMatrix2D((pix.width / 2, pix.height / 2), a, 1.0)
                    img = cv2.warpAffine(img, m, (pix.width, pix.height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
                    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
                    fixed += 1
            if crop:
                mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
                pts = cv2.findNonZero(mask)
                if pts is not None:
                    x, y, w, h = cv2.boundingRect(pts)
                    pad = int(0.02 * max(pix.width, pix.height))
                    x0, y0 = max(0, x - pad), max(0, y - pad)
                    x1, y1 = min(pix.width, x + w + pad), min(pix.height, y + h + pad)
                    if (x1 - x0) > 0.3 * pix.width and (y1 - y0) > 0.3 * pix.height:
                        img, gray = img[y0:y1, x0:x1], gray[y0:y1, x0:x1]
            if mode == "bw":
                res = cv2.adaptiveThreshold(cv2.GaussianBlur(gray, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15)
                data = cv2.cvtColor(res, cv2.COLOR_GRAY2RGB)
            elif mode == "gray":
                bg = cv2.medianBlur(gray, 41)
                norm = cv2.divide(gray, bg, scale=255)
                data = cv2.cvtColor(norm, cv2.COLOR_GRAY2RGB)
            else:  # contrast: lift the paper to white, keep colour
                bg = cv2.medianBlur(gray, 41)
                scale = 255.0 / np.maximum(bg, 1).astype(np.float32)
                data = np.clip(img.astype(np.float32) * scale[..., None], 0, 255).astype(np.uint8)
            ok, enc = cv2.imencode(".png" if mode == "bw" else ".jpg", cv2.cvtColor(data, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
            h_pt = data.shape[0] * 72.0 / dpi
            w_pt = data.shape[1] * 72.0 / dpi
            page = out.new_page(width=w_pt, height=h_pt)
            page.insert_image(page.rect, stream=enc.tobytes())
        out.save(output, garbage=3, deflate=True)
        pages = out.page_count
        out.close()
        return {"output": output, "pages": pages, "straightened": fixed}


# ---------------------------------------------------------------------------------------------
# batch: the same steps on many PDFs
# ---------------------------------------------------------------------------------------------

STEPS = {"compress", "watermark", "numbers", "clean_metadata", "grayscale", "encrypt"}


def run_batch(inputs: list[str], out_dir: str, steps: list[dict]) -> dict:
    """steps, applied in order: {"type": "compress", "dpi": 120, "quality": 70} | {"type": "watermark", "text": "DRAFT"} |
    {"type": "numbers", "text": "{n} / {total}", "position": "bottom-center"} | {"type": "clean_metadata"} |
    {"type": "grayscale"} | {"type": "encrypt", "password": "..."}"""
    from . import edit

    if not steps:
        raise ValueError("choose at least one step")
    for s in steps:
        if s.get("type") not in STEPS:
            raise ValueError(f"unknown step '{s.get('type')}'")
    files: list[Path] = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            files += sorted(p.glob("*.pdf"))
        elif p.suffix.lower() == ".pdf" and p.is_file():
            files.append(p)
    if not files:
        raise ValueError("no PDF files found")
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    outputs, skipped = [], []
    for k, src in enumerate(files):
        jobctl.check()
        jobctl.report(k, len(files), src.name)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cur = str(src)
                for j, s in enumerate(steps):
                    nxt = str(Path(tmp) / f"s{j}.pdf")
                    t = s["type"]
                    if t == "compress":
                        compress_pdf(cur, nxt, int(s.get("dpi", 120)), int(s.get("quality", 70)))
                    elif t == "watermark":
                        watermark_text(cur, nxt, str(s.get("text") or "DRAFT"), None, float(s.get("opacity", 0.25)), float(s.get("angle", 45)), float(s.get("font_size", 64)))
                    elif t == "numbers":
                        edit.stamp_pages(cur, nxt, [{"position": s.get("position", "bottom-center"), "text": s.get("text", "{n} / {total}")}])
                    elif t == "clean_metadata":
                        clean_pdf_metadata(cur, nxt)
                    elif t == "grayscale":
                        edit.pdf_to_grayscale(cur, nxt)
                    elif t == "encrypt":
                        encrypt_pdf(cur, nxt, str(s.get("password", "")))
                    cur = nxt
                dest = Path(out_dir) / src.name
                if dest.exists():
                    dest = dest.with_name(f"{src.stem}_{int(time.time())}.pdf")
                dest.write_bytes(Path(cur).read_bytes())
                outputs.append(str(dest))
        except Exception as e:
            skipped.append({"path": str(src), "reason": str(e)})
    return {"outputs": outputs, "created": outputs, "skipped": skipped, "count": len(outputs)}


# ---------------------------------------------------------------------------------------------
# select text like a reader does (for highlight, underline, strike)
# ---------------------------------------------------------------------------------------------


def text_between(path: str, page: int, ax: float, ay: float, bx: float, by: float, password: str | None = None) -> dict:
    """The words between two points (displayed coordinates), as one box per line, in reading order."""
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        p = doc[page - 1]
        words = p.get_text("words", sort=False)
        if not words:
            return {"found": False, "lines": []}
        pa, pb = pymupdf.Point(ax, ay) * p.derotation_matrix, pymupdf.Point(bx, by) * p.derotation_matrix

        def nearest(pt: "pymupdf.Point") -> tuple[int, float]:
            best, dist = -1, 1e9
            for i, w in enumerate(words):
                r = pymupdf.Rect(w[:4])
                dx = max(r.x0 - pt.x, 0, pt.x - r.x1)
                dy = max(r.y0 - pt.y, 0, pt.y - r.y1)
                d = (dx * dx + dy * dy) ** 0.5
                if d < dist:
                    best, dist = i, d
            return best, dist

        ia, da = nearest(pa)
        ib, db = nearest(pb)
        reach = 14.0
        if da > reach and db > reach:
            return {"found": False, "lines": []}
        if da > reach:
            ia = ib
        if db > reach:
            ib = ia
        lo, hi = min(ia, ib), max(ia, ib)
        lines: dict[tuple[int, int], pymupdf.Rect] = {}
        for w in words[lo : hi + 1]:
            key = (w[5], w[6])
            r = pymupdf.Rect(w[:4])
            lines[key] = lines[key] | r if key in lines else r
        out = []
        for r in lines.values():
            v = (r * p.rotation_matrix).normalize()
            out.append([v.x0, v.y0, v.x1, v.y1])
        out.sort(key=lambda r: (round(r[1]), r[0]))
        return {"found": True, "lines": out}


# ---------------------------------------------------------------------------------------------
# the page's own content, so it can be moved and deleted like anything you added
# ---------------------------------------------------------------------------------------------


def page_objects(path: str, page: int, password: str | None = None) -> dict:
    """Text blocks and pictures of a page, with where they are (displayed coordinates)."""
    with _open_for_view(path, password) as doc:
        if not 1 <= page <= doc.page_count:
            raise ValueError(f"page {page} does not exist (the document has {doc.page_count})")
        p = doc[page - 1]
        texts = []
        for bi, b in enumerate(p.get_text("dict")["blocks"]):
            if b.get("type") != 0:
                continue
            lines, rects, weight = [], [], {}
            for ln in b["lines"]:
                t = "".join(s["text"] for s in ln["spans"])
                if not t.strip():
                    continue
                lines.append(t.rstrip())
                rects.append([round(c, 1) for c in (pymupdf.Rect(ln["bbox"]) * p.rotation_matrix).normalize()])
                for sp in ln["spans"]:
                    if sp["text"].strip():
                        key = (sp["font"], round(sp["size"], 1), sp["color"], sp["flags"])
                        weight[key] = weight.get(key, 0) + len(sp["text"].strip())
            if not lines:
                continue
            font, size, color, flags = max(weight, key=weight.get)  # the look most of the text has, not just the first word's
            v = (pymupdf.Rect(b["bbox"]) * p.rotation_matrix).normalize()
            texts.append(
                {
                    "id": bi,
                    "rect": [v.x0, v.y0, v.x1, v.y1],
                    "lines": rects,
                    "text": "\n".join(lines),
                    "size": round(size, 1),
                    "color": "#%06x" % (color & 0xFFFFFF),
                    "font": font,
                    "bold": bool(flags & 16) or "bold" in font.lower(),
                    "italic": bool(flags & 2) or "italic" in font.lower() or "oblique" in font.lower(),
                }
            )
            if len(texts) >= 400:
                break
        page_area = max(1.0, p.rect.width * p.rect.height)
        images, seen = [], set()
        for img in p.get_images(full=True):
            xref = img[0]
            for r in p.get_image_rects(xref):
                v = (pymupdf.Rect(r) * p.rotation_matrix).normalize()
                if v.width < 6 or v.height < 6 or (xref, round(v.x0), round(v.y0)) in seen:
                    continue
                seen.add((xref, round(v.x0), round(v.y0)))
                images.append(
                    {
                        "xref": xref,
                        "rect": [v.x0, v.y0, v.x1, v.y1],
                        "width": img[2],
                        "height": img[3],
                        "background": v.width * v.height >= 0.8 * page_area,  # a letterhead or a scan: never in the way of text
                    }
                )
        shapes = []
        try:
            for d in p.get_drawings():
                v = (pymupdf.Rect(d["rect"]) * p.rotation_matrix).normalize()
                if v.width < 6 and v.height < 6 or v.width * v.height >= 0.8 * page_area:
                    continue
                fill, stroke = d.get("fill"), d.get("color")
                shapes.append({"rect": [v.x0, v.y0, v.x1, v.y1], "fill": _hex(fill), "stroke": _hex(stroke)})
                if len(shapes) >= 200:
                    break
        except Exception:
            shapes = []
        return {"page": page, "width": p.rect.width, "height": p.rect.height, "texts": texts, "images": images, "shapes": shapes}


def _hex(c) -> str | None:
    if not c:
        return None
    r, g, b = (int(max(0, min(1, v)) * 255) for v in (list(c) + [0, 0, 0])[:3])
    return "#%02x%02x%02x" % (r, g, b)


def original_image(path: str, xref: int, max_side: int = 1400, password: str | None = None) -> dict:
    """One of the PDF's pictures as a PNG (with its transparency), so a moved picture can be drawn."""
    with _open_for_view(path, password) as doc:
        pix = _pixmap_of(doc, xref)
        if max(pix.width, pix.height) > max_side:
            k = max_side / max(pix.width, pix.height)
            pix = _shrink(pix, k)
        return {"image": _png_b64(pix), "width": pix.width, "height": pix.height}


def _shrink(pix: "pymupdf.Pixmap", k: float) -> "pymupdf.Pixmap":
    from PIL import Image
    import io

    mode = "RGBA" if pix.alpha else "RGB"
    im = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
    im = im.resize((max(1, int(pix.width * k)), max(1, int(pix.height * k))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return pymupdf.Pixmap(buf.getvalue())


def _pixmap_of(doc: "pymupdf.Document", xref: int) -> "pymupdf.Pixmap":
    try:
        info = doc.extract_image(xref)
        pix = pymupdf.Pixmap(doc, xref)
    except Exception:
        raise ValueError("this picture cannot be read")
    smask = info.get("smask") if info else 0
    if pix.colorspace is not None and pix.colorspace.n > 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    if smask:
        try:
            pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(doc, smask))
        except Exception:
            pass
    return pix


# ---------------------------------------------------------------------------------------------
# page tools: delete, move, rotate, duplicate, insert, add pages from another PDF
# ---------------------------------------------------------------------------------------------


def assemble_pdfs(sources: list[str], parts: list[dict]) -> dict:
    """One or several output files from pages of the sources. parts: [{"output": path, "plan": [...as build_pdf...]}]."""
    if not parts:
        raise ValueError("nothing to write")
    written = []
    for part in parts:
        build_pdf(sources, part["plan"], part["output"])
        written.append(part["output"])
    return {"outputs": written, "files": len(written)}


def build_pdf(sources: list[str], plan: list[dict], output: str) -> dict:
    """plan entries: {"source": index, "page": 1-based, "rotate": extra degrees} or {"blank": true, "width", "height"}."""
    if not plan:
        raise ValueError("a PDF needs at least one page")
    if len(plan) > 5000:
        raise ValueError("too many pages")
    docs = []
    try:
        for path in sources:
            d = pymupdf.open(path)
            if d.needs_pass:
                raise ValueError("the document is password protected; unlock it first")
            docs.append(d)
        out = pymupdf.open()
        i = 0
        while i < len(plan):
            e = plan[i]
            if e.get("blank"):
                out.new_page(width=float(e.get("width", 595)), height=float(e.get("height", 842)))
                i += 1
                continue
            s, p0, rot = int(e["source"]), int(e["page"]) - 1, int(e.get("rotate", 0)) % 360
            if not 0 <= s < len(docs) or not 0 <= p0 < docs[s].page_count:
                raise ValueError(f"page {p0 + 1} does not exist")
            j = i  # consecutive pages of one source in order are copied together
            while rot == 0 and j + 1 < len(plan) and not plan[j + 1].get("blank") and int(plan[j + 1]["source"]) == s and int(plan[j + 1]["page"]) - 1 == int(plan[j]["page"]) and int(plan[j + 1].get("rotate", 0)) % 360 == 0:
                j += 1
            out.insert_pdf(docs[s], from_page=p0, to_page=int(plan[j]["page"]) - 1)
            if rot:
                pg = out[out.page_count - 1]
                pg.set_rotation((pg.rotation + rot) % 360)
            i = j + 1
        out.save(output, garbage=3, deflate=True)
        pages = out.page_count
        out.close()
        return {"path": output, "pages": pages}
    finally:
        for d in docs:
            d.close()
