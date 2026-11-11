"""Light conversions that need nothing beyond PyMuPDF: tables to CSV, PDF to HTML, HTML / Markdown to PDF,
compressing to a target size and splitting by size."""
from __future__ import annotations

import csv
import html
import re
import tempfile
import time
from pathlib import Path

import pymupdf

from ... import jobctl
from .ops import _select_pages, compress_pdf


def _open(path: str) -> "pymupdf.Document":
    doc = pymupdf.open(path)
    if doc.needs_pass:
        doc.close()
        raise ValueError("the document is password protected; unlock it first")
    return doc


def _free_path(path: Path) -> Path:
    if not path.exists():
        return path
    return path.with_name(f"{path.stem}_{int(time.time())}{path.suffix}")


# ---------------------------------------------------------------------------------------------
# tables and HTML out of a PDF
# ---------------------------------------------------------------------------------------------


def pdf_tables_to_csv(input_path: str, out_dir: str, pages_spec: str | None = None) -> dict:
    """Every table PyMuPDF finds becomes a CSV file (UTF-8 with BOM, so Excel shows Turkish letters right)."""
    stem = Path(input_path).stem
    created: list[str] = []
    with _open(input_path) as doc:
        pages = _select_pages(doc, pages_spec)
        for k, i in enumerate(pages):
            jobctl.check()
            jobctl.report(k, len(pages), f"page {i + 1}")
            found = doc[i].find_tables()
            for t, table in enumerate(found.tables, start=1):
                rows = [["" if c is None else str(c).replace("\n", " ").strip() for c in row] for row in table.extract()]
                keep = [c for c in range(max((len(r) for r in rows), default=0)) if any(c < len(r) and r[c] for r in rows)]
                rows = [[r[c] if c < len(r) else "" for c in keep] for r in rows]  # ruled lines often add empty columns
                if not keep:
                    continue
                Path(out_dir).mkdir(parents=True, exist_ok=True)
                dest = _free_path(Path(out_dir) / f"{stem}_p{i + 1}_t{t}.csv")
                with open(dest, "w", newline="", encoding="utf-8-sig") as f:
                    csv.writer(f).writerows(rows)
                created.append(str(dest))
    if not created:
        raise ValueError("no tables were found (scanned pages need text recognition first)")
    return {"outputs": created, "created": created, "count": len(created)}


def pdf_to_html(input_path: str, output: str, pages_spec: str | None = None) -> dict:
    with _open(input_path) as doc:
        pages = _select_pages(doc, pages_spec)
        parts = []
        for k, i in enumerate(pages):
            jobctl.check()
            jobctl.report(k, len(pages), f"page {i + 1}")
            parts.append(doc[i].get_text("xhtml"))
        title = html.escape((doc.metadata or {}).get("title") or Path(input_path).stem)
    body = "\n<hr>\n".join(parts)
    Path(output).write_text(
        f'<!doctype html>\n<html><head><meta charset="utf-8"><title>{title}</title></head><body>\n{body}\n</body></html>',
        encoding="utf-8",
    )
    return {"output": output, "pages": len(pages)}


# ---------------------------------------------------------------------------------------------
# HTML / Markdown into a PDF
# ---------------------------------------------------------------------------------------------

_CSS = """
body { font-family: sans-serif; font-size: 11pt; line-height: 1.4; }
h1 { font-size: 22pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; }
code, pre { font-family: monospace; font-size: 9.5pt; background-color: #f2f2f2; }
pre { padding: 6pt; } blockquote { margin-left: 12pt; color: #555555; }
table { border-collapse: collapse; } td, th { border: 1px solid #999999; padding: 3pt; }
img { max-width: 100%; }
"""


def _inline(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<i>\1</i>", text)
    text = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", r'<img src="\2" alt="\1">', text)
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', text)
    return text


def markdown_to_html(md: str) -> str:
    """The everyday subset: headings, paragraphs, bold/italic/code, links, images, lists, quotes, code blocks, rules."""
    out: list[str] = []
    lines = md.replace("\r\n", "\n").split("\n")
    i, para, items, kind = 0, [], [], ""

    def flush_para():
        if para:
            out.append("<p>" + _inline(" ".join(para)) + "</p>")
            para.clear()

    def flush_list():
        nonlocal kind
        if items:
            out.append(f"<{kind}>" + "".join(f"<li>{_inline(x)}</li>" for x in items) + f"</{kind}>")
            items.clear()
            kind = ""

    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            flush_para(), flush_list()
            i += 1
            code = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            out.append("<pre>" + html.escape("\n".join(code)) + "</pre>")
        elif m := re.match(r"^(#{1,6})\s+(.*)$", line):
            flush_para(), flush_list()
            out.append(f"<h{len(m[1])}>{_inline(m[2].strip())}</h{len(m[1])}>")
        elif re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
            flush_para(), flush_list()
            out.append("<hr>")
        elif m := re.match(r"^\s*[-*+]\s+(.*)$", line):
            flush_para()
            if kind != "ul":
                flush_list()
                kind = "ul"
            items.append(m[1])
        elif m := re.match(r"^\s*\d+[.)]\s+(.*)$", line):
            flush_para()
            if kind != "ol":
                flush_list()
                kind = "ol"
            items.append(m[1])
        elif line.startswith(">"):
            flush_para(), flush_list()
            out.append("<blockquote>" + _inline(line.lstrip("> ").strip()) + "</blockquote>")
        elif not line.strip():
            flush_para(), flush_list()
        else:
            flush_list()
            para.append(line.strip())
        i += 1
    flush_para(), flush_list()
    return "\n".join(out)


def html_to_pdf(source: str, output: str, paper: str = "a4", margin: float = 50.0) -> dict:
    """`source` is a .html/.htm/.md/.markdown/.txt file. Images next to the file are included."""
    src = Path(source)
    text = src.read_text(encoding="utf-8", errors="replace")
    ext = src.suffix.lower()
    if ext in (".md", ".markdown"):
        body = markdown_to_html(text)
    elif ext == ".txt":
        body = "<pre>" + html.escape(text) + "</pre>"
    else:
        body = text
    story = pymupdf.Story(html=body, user_css=_CSS, archive=pymupdf.Archive(str(src.parent)))
    mediabox = pymupdf.paper_rect(paper)
    where = mediabox + (margin, margin, -margin, -margin)
    writer = pymupdf.DocumentWriter(output)
    pages, more = 0, 1
    while more:
        jobctl.check()
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
        pages += 1
        if pages > 2000:
            break
    writer.close()
    return {"output": output, "pages": pages}


# ---------------------------------------------------------------------------------------------
# target sizes
# ---------------------------------------------------------------------------------------------

# (image dpi, jpeg quality), gentlest first
_LADDER = [(200, 85), (150, 75), (120, 65), (96, 55), (72, 45), (60, 35), (48, 28)]


def compress_to_size(input_path: str, output: str, max_bytes: int) -> dict:
    """Compress as gently as possible, but small enough. Reports `reached: false` when even the strongest
    setting stays above the target (text-heavy files cannot shrink further without losing content)."""
    before = Path(input_path).stat().st_size
    if before <= max_bytes:
        raise ValueError("the file is already smaller than that")
    best: tuple[int, str] | None = None
    with tempfile.TemporaryDirectory() as tmp:
        for k, (dpi, quality) in enumerate(_LADDER):
            jobctl.check()
            jobctl.report(k, len(_LADDER), f"trying {dpi} dpi")
            trial = str(Path(tmp) / f"t{k}.pdf")
            compress_pdf(input_path, trial, dpi, quality)
            size = Path(trial).stat().st_size
            if best is None or size < best[0]:
                best = (size, trial)
            if size <= max_bytes:
                break
        assert best is not None
        Path(output).write_bytes(Path(best[1]).read_bytes())
    after = Path(output).stat().st_size
    return {"output": output, "before_bytes": before, "after_bytes": after, "reached": after <= max_bytes}


def split_by_size(input_path: str, out_dir: str, max_bytes: int) -> dict:
    """Cut the file into parts that each stay under `max_bytes` (a single page larger than that gets its own part)."""
    stem = Path(input_path).stem
    with _open(input_path) as src:
        n = src.page_count
        avg = max(1.0, Path(input_path).stat().st_size / max(1, n))
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        created: list[str] = []
        start = 0

        def build(a: int, b: int) -> bytes:
            part = pymupdf.open()
            part.insert_pdf(src, from_page=a, to_page=b)
            data = part.tobytes(garbage=3, deflate=True)
            part.close()
            return data

        while start < n:
            jobctl.check()
            jobctl.report(start, n, f"part {len(created) + 1}")
            # jump ahead by the average page size, then settle page by page
            end = min(n - 1, start + max(0, int(max_bytes / avg * 0.6)))
            while True:
                data = build(start, end)
                if len(data) <= max_bytes or end == start:
                    break
                end = max(start, end - max(1, (end - start) // 4))
            while end + 1 < n:
                more = build(start, end + 1)
                if len(more) > max_bytes:
                    break
                data, end = more, end + 1
            dest = _free_path(Path(out_dir) / f"{stem}_part{len(created) + 1:02d}.pdf")
            dest.write_bytes(data)
            created.append(str(dest))
            start = end + 1
    return {"outputs": created, "created": created, "count": len(created)}
