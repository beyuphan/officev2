import os
from pathlib import Path

import pymupdf
import pytest

from localflow import extras
from localflow.modules.pdf.ops import find_soffice
from test_api import AUTH, client, make_pdf  # noqa: F401
from test_files import post, post_job


def text_pdf(path: Path, pages: list[str]):
    doc = pymupdf.open()
    for t in pages:
        doc.new_page().insert_text((72, 100), t, fontsize=14)
    doc.set_metadata({"title": "Secret project Atlas", "author": "Jane Doe"})
    doc.save(str(path))
    doc.close()


def test_compress_shrinks_image_heavy_pdf(client, tmp_path):
    # a large noisy image makes the PDF big
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 1600, 1200), False)
    pix.set_rect(pix.irect, (120, 80, 200))
    for x in range(0, 1600, 3):
        pix.set_rect(pymupdf.IRect(x, 0, x + 1, 1200), ((x * 7) % 255, (x * 13) % 255, (x * 29) % 255))
    src, out = tmp_path / "big.pdf", tmp_path / "small.pdf"
    doc = pymupdf.open()
    doc.new_page().insert_image(pymupdf.Rect(0, 0, 400, 300), pixmap=pix)
    doc[0].insert_text((50, 350), "keep this text")
    doc.save(str(src))
    doc.close()
    job = post_job(client, "/pdf/compress", {"input": str(src), "output": str(out), "dpi": 72, "quality": 40})
    assert job["state"] == "done", job
    assert job["result"]["after_bytes"] < job["result"]["before_bytes"]
    with pymupdf.open(out) as d:
        assert "keep this text" in d[0].get_text()


def test_organize_reorder_and_rotate(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["one", "two", "three", "four"])
    job = post_job(
        client, "/pdf/organize",
        {"input": str(src), "output": str(out), "order": "3,1,1,4", "rotate": 90, "rotate_pages": "1"},
    )
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert [p.get_text().strip() for p in d] == ["three", "one", "one", "four"]
        assert [p.rotation for p in d] == [90, 0, 0, 0]
    bad = post_job(client, "/pdf/organize", {"input": str(src), "output": str(tmp_path / "x.pdf"), "order": "9"})
    assert bad["state"] == "failed"


def test_redact_removes_text_for_real(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "r.pdf"
    text_pdf(src, ["Client: Alice Smith, card 4111", "Alice Smith signed"])
    job = post_job(client, "/pdf/redact", {"input": str(src), "output": str(out), "terms": ["Alice Smith"]})
    assert job["state"] == "done", job
    assert job["result"]["redactions"] == 2
    with pymupdf.open(out) as d:
        full = "".join(p.get_text() for p in d)
        assert "Alice" not in full and "Smith" not in full
        assert "card 4111" in full  # untouched text stays
        assert not d.metadata.get("title")  # metadata scrubbed too
    # the original is untouched
    with pymupdf.open(src) as d:
        assert "Alice Smith" in d[0].get_text()


def test_clean_metadata(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "c.pdf"
    text_pdf(src, ["hello"])
    job = post_job(client, "/pdf/clean-metadata", {"input": str(src), "output": str(out)})
    assert job["state"] == "done", job
    assert {"title", "author"} <= set(job["result"]["removed_fields"])
    with pymupdf.open(out) as d:
        assert not d.metadata.get("title") and not d.metadata.get("author")
        assert "hello" in d[0].get_text()


def test_pdf_to_docx(client, tmp_path):
    if not extras.is_installed("word"):
        pytest.skip("needs the PDF to Word add-on")
    from docx import Document

    src, out = tmp_path / "s.pdf", tmp_path / "s.docx"
    text_pdf(src, ["Quarterly summary paragraph"])
    job = post_job(client, "/pdf/to-docx", {"input": str(src), "output": str(out)})
    assert job["state"] == "done", job
    assert "Quarterly summary" in "\n".join(p.text for p in Document(str(out)).paragraphs)


@pytest.mark.skipif(find_soffice() is None, reason="LibreOffice not installed")
def test_office_to_pdf(client, tmp_path):
    from docx import Document

    src, out = tmp_path / "memo.docx", tmp_path / "memo.pdf"
    d = Document()
    d.add_paragraph("Merhaba dünya: çalışma ışığı")
    d.save(str(src))
    job = post_job(client, "/pdf/from-office", {"input": str(src), "output": str(out)})
    assert job["state"] == "done", job
    with pymupdf.open(out) as pdf:
        assert "Merhaba" in pdf[0].get_text()
        assert "ışığı" in pdf[0].get_text()


def test_office_rejects_unsupported_type(client, tmp_path):
    f = tmp_path / "x.exe"
    f.write_bytes(b"MZ")
    r = post(client, "/pdf/from-office", {"input": str(f), "output": str(tmp_path / "o.pdf")})
    assert r.status_code == 422


def test_ocr_image_endpoint_reads_screen_text(client):
    import base64

    from localflow.modules.pdf.ops import _unicode_font

    doc = pymupdf.open()
    page = doc.new_page(width=420, height=90)
    tw = pymupdf.TextWriter(page.rect)
    tw.append((20, 55), "Fatura toplamı 1.250 TL", font=_unicode_font(), fontsize=24)
    tw.write_text(page)
    png = page.get_pixmap(dpi=150).tobytes("png")
    b64 = base64.b64encode(png).decode()
    res = post(client, "/ai/ocr-image", {"image_base64": b64}, 200).json()
    assert "Fatura" in res["text"] and "1.250" in res["text"]
    assert post(client, "/ai/ocr-image", {"image_base64": "!!!notbase64!!!"}).status_code == 422
    assert post(client, "/ai/ocr-image", {"image_base64": base64.b64encode(b"not an image").decode()}).status_code == 422
