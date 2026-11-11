"""Light features: redaction patterns, target sizes, tables, HTML/Markdown to PDF, curves, HSL, perspective, formats."""
import base64
import io
from pathlib import Path

import numpy as np
import pymupdf
import pytest
from PIL import Image

from localflow.modules.pdf import patterns as pat
from test_api import AUTH, client  # noqa: F401
from test_files import post, post_job
from test_photo import export, solid, two_tone


def text_pdf(path: Path, pages: list[str]):
    doc = pymupdf.open()
    for t in pages:
        doc.new_page().insert_text((72, 100), t, fontsize=12)
    doc.save(str(path))
    doc.close()


# ---------------------------------------------------------------- patterns


def test_pattern_validators():
    assert pat.find_all(pat.compile_matchers(["tckn"], None), "no 10000000146 and 12345678901 here") == {"10000000146"}
    assert pat.find_all(pat.compile_matchers(["card"], None), "4111 1111 1111 1111 and 1234 5678 9012 3456") == {"4111 1111 1111 1111"}
    assert pat.find_all(pat.compile_matchers(["iban"], None), "TR33 0006 1005 1978 6457 8413 26 / TR00 0000 0000 0000 0000 0000 00") == {"TR33 0006 1005 1978 6457 8413 26"}
    assert pat.find_all(pat.compile_matchers(["email"], None), "mail a.b+c@firma.com.tr now") == {"a.b+c@firma.com.tr"}
    assert "0532 123 45 67" in pat.find_all(pat.compile_matchers(["phone"], None), "ara 0532 123 45 67 hemen")
    assert pat.find_all(pat.compile_matchers([], r"PRJ-\d+"), "see PRJ-42 and PRJ-7") == {"PRJ-42", "PRJ-7"}
    with pytest.raises(ValueError):
        pat.compile_matchers(["nope"], None)


def test_redact_by_pattern(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "r.pdf"
    text_pdf(src, ["mail me at ada@example.com", "no secrets here"])
    job = post_job(client, "/pdf/redact", {"input": str(src), "output": str(out), "patterns": ["email"]})
    assert job["state"] == "done", job
    assert job["result"]["redactions"] == 1
    with pymupdf.open(out) as d:
        assert "ada@example.com" not in d[0].get_text()
        assert "no secrets here" in d[1].get_text()


def test_redact_rejects_bad_regex(client, tmp_path):
    src = tmp_path / "s.pdf"
    text_pdf(src, ["x"])
    post(client, "/pdf/redact", {"input": str(src), "output": str(tmp_path / "o.pdf"), "regex": "(["}, 422)


# ---------------------------------------------------------------- target sizes


def noisy_pdf(path: Path, pages: int = 4):
    rng = np.random.default_rng(1)
    doc = pymupdf.open()
    for _ in range(pages):
        buf = io.BytesIO()
        Image.fromarray(rng.integers(0, 255, (900, 900, 3), dtype=np.uint8)).save(buf, "PNG")
        doc.new_page().insert_image(pymupdf.Rect(0, 0, 400, 400), stream=buf.getvalue())
    doc.save(str(path))
    doc.close()


def test_compress_to_target_size(client, tmp_path):
    src, out = tmp_path / "big.pdf", tmp_path / "small.pdf"
    noisy_pdf(src)
    before = src.stat().st_size
    target_mb = before / 1024 / 1024 / 3
    job = post_job(client, "/pdf/compress-to-size", {"input": str(src), "output": str(out), "max_mb": target_mb})
    assert job["state"] == "done", job
    assert job["result"]["after_bytes"] < before
    assert job["result"]["reached"] is True
    assert out.stat().st_size <= target_mb * 1024 * 1024


def test_compress_to_size_rejects_already_small(client, tmp_path):
    src = tmp_path / "s.pdf"
    text_pdf(src, ["tiny"])
    job = post_job(client, "/pdf/compress-to-size", {"input": str(src), "output": str(tmp_path / "o.pdf"), "max_mb": 5})
    assert job["state"] == "failed"


def test_split_by_size(client, tmp_path):
    src = tmp_path / "big.pdf"
    noisy_pdf(src, 6)
    limit_mb = src.stat().st_size / 1024 / 1024 / 3
    out_dir = tmp_path / "parts"
    job = post_job(client, "/pdf/split-by-size", {"input": str(src), "out_dir": str(out_dir), "max_mb": limit_mb})
    assert job["state"] == "done", job
    parts = job["result"]["outputs"]
    assert len(parts) >= 2
    total = 0
    for p in parts:
        assert Path(p).stat().st_size <= limit_mb * 1024 * 1024
        with pymupdf.open(p) as d:
            total += d.page_count
    assert total == 6


# ---------------------------------------------------------------- conversions


def test_tables_to_csv(client, tmp_path):
    src = tmp_path / "t.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    rows = [["Ad", "Tutar"], ["Ali", "10"], ["Veli", "20"]]
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            x, y = 72 + c * 150, 100 + r * 30
            page.draw_rect(pymupdf.Rect(x, y, x + 150, y + 30), color=(0, 0, 0))
            page.insert_text((x + 6, y + 20), cell, fontsize=12)
    doc.save(str(src))
    doc.close()
    job = post_job(client, "/pdf/tables-to-csv", {"input": str(src), "out_dir": str(tmp_path / "csv")})
    assert job["state"] == "done", job
    text = Path(job["result"]["outputs"][0]).read_text(encoding="utf-8-sig")
    assert "Ad,Tutar" in text and "10" in text


def test_tables_to_csv_without_table_fails_clearly(client, tmp_path):
    src = tmp_path / "t.pdf"
    text_pdf(src, ["just a sentence"])
    job = post_job(client, "/pdf/tables-to-csv", {"input": str(src), "out_dir": str(tmp_path / "csv")})
    assert job["state"] == "failed"
    assert "no tables" in job["error"]


def test_pdf_to_html(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "s.html"
    text_pdf(src, ["Merhaba dünya"])
    job = post_job(client, "/pdf/to-html", {"input": str(src), "output": str(out)})
    assert job["state"] == "done", job
    assert "Merhaba" in out.read_text(encoding="utf-8")


def test_markdown_to_pdf_keeps_turkish_letters(client, tmp_path):
    md, out = tmp_path / "not.md", tmp_path / "not.pdf"
    md.write_text("# Başlık\n\nBu **kalın** bir paragraf: çğıöşü.\n\n- bir\n- iki\n", encoding="utf-8")
    job = post_job(client, "/pdf/from-web", {"input": str(md), "output": str(out)})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        t = d[0].get_text()
        assert "Başlık" in t and "çğıöşü" in t and "iki" in t


def test_html_to_pdf(client, tmp_path):
    h, out = tmp_path / "a.html", tmp_path / "a.pdf"
    h.write_text("<h1>Fatura</h1><p>Toplam: 42</p>", encoding="utf-8")
    job = post_job(client, "/pdf/from-web", {"input": str(h), "output": str(out), "paper": "letter"})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert "Toplam: 42" in d[0].get_text()
        assert round(d[0].rect.width) == 612


# ---------------------------------------------------------------- photo


def test_curves_brightens_midtones(client, tmp_path):
    src = solid(tmp_path / "g.png", (100, 100, 100))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "curves", "points": [[0, 0], [100, 160], [255, 255]]}], out)
    px = np.asarray(Image.open(out).convert("RGB"))[10, 10]
    assert all(abs(int(c) - 160) <= 2 for c in px), px


def test_curves_single_channel_and_validation(client, tmp_path):
    src = solid(tmp_path / "g.png", (100, 100, 100))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "curves", "channel": "r", "points": [[0, 0], [100, 200], [255, 255]]}], out)
    r, g, b = np.asarray(Image.open(out).convert("RGB"))[5, 5]
    assert r > 190 and g == 100 and b == 100
    r = post(client, "/photo/preview", {"input": str(src), "edits": [{"type": "curves", "points": [[1, 1]]}]}, 422)
    assert "curves" in r.text


def test_hsl_shifts_only_the_chosen_colour(client, tmp_path):
    src = two_tone(tmp_path / "t.png", left=(220, 30, 30), right=(30, 30, 220))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "hsl", "bands": {"red": {"sat": -100}}}], out)
    arr = np.asarray(Image.open(out).convert("RGB")).astype(int)
    left, right = arr[150, 50], arr[150, 350]
    assert max(left) - min(left) < 40  # red lost its colour
    assert right[2] - right[0] > 150  # blue is untouched


def test_hsl_unknown_colour(client, tmp_path):
    src = solid(tmp_path / "g.png", (10, 10, 10))
    post(client, "/photo/preview", {"input": str(src), "edits": [{"type": "hsl", "bands": {"pink": {"hue": 5}}}]}, 422)


def test_perspective_straightens_a_leaning_card(client, tmp_path):
    # white card drawn as a skewed quadrilateral on black
    im = Image.new("RGB", (400, 300), (0, 0, 0))
    from PIL import ImageDraw

    ImageDraw.Draw(im).polygon([(100, 60), (320, 40), (340, 250), (80, 240)], fill=(255, 255, 255))
    src = tmp_path / "card.png"
    im.save(src)
    out = tmp_path / "o.png"
    quad = [[100 / 400, 60 / 300], [320 / 400, 40 / 300], [340 / 400, 250 / 300], [80 / 400, 240 / 300]]
    export(client, src, [{"type": "perspective", "points": quad}], out)
    arr = np.asarray(Image.open(out).convert("L"))
    assert (arr > 200).mean() > 0.97  # the card now fills the frame


def test_perspective_needs_four_points(client, tmp_path):
    src = solid(tmp_path / "g.png", (10, 10, 10))
    post(client, "/photo/preview", {"input": str(src), "edits": [{"type": "perspective", "points": [[0, 0], [1, 1]]}]}, 422)


@pytest.mark.parametrize("fmt", ["avif", "gif", "ico"])
def test_new_export_formats(client, tmp_path, fmt):
    src = solid(tmp_path / "g.png", (200, 80, 80), size=(300, 200))
    out = tmp_path / f"o.{fmt}"
    export(client, src, [], out, fmt=fmt)
    with Image.open(out) as im:
        assert im.size == ((256, 256) if fmt == "ico" else (300, 200))


def test_avif_opens_in_editor(client, tmp_path):
    src = tmp_path / "a.avif"
    Image.new("RGB", (120, 80), (10, 200, 30)).save(src, "AVIF")
    info = post(client, "/photo/info", {"input": str(src)}, 200).json()
    assert (info["width"], info["height"]) == (120, 80)


def test_heic_opens_when_support_is_installed(client, tmp_path):
    pillow_heif = pytest.importorskip("pillow_heif")
    src = tmp_path / "phone.heic"
    pillow_heif.from_pillow(Image.new("RGB", (64, 48), (200, 10, 10))).save(str(src))
    info = post(client, "/photo/info", {"input": str(src)}, 200).json()
    assert (info["width"], info["height"]) == (64, 48)


def test_search_finds_patterns_for_review(client, tmp_path):
    src = tmp_path / "s.pdf"
    text_pdf(src, ["write to ada@example.com or bob@example.org", "nothing"])
    r = post(client, "/pdf/search", {"input": str(src), "patterns": ["email"]}, 200).json()
    assert r["total"] == 2
    assert {h["term"] for h in r["pages"][0]["hits"]} == {"ada@example.com", "bob@example.org"}
    post(client, "/pdf/search", {"input": str(src)}, 422)  # nothing to look for


# ---------------------------------------------------------------- second round of photo ops


def test_curves_channels_in_one_op(client, tmp_path):
    src = solid(tmp_path / "g.png", (100, 100, 100))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "curves", "channels": {"r": [[0, 0], [100, 200], [255, 255]], "b": [[0, 0], [100, 40], [255, 255]]}}], out)
    r, g, b = np.asarray(Image.open(out).convert("RGB"))[5, 5]
    assert r > 190 and g == 100 and b < 60


def test_inner_rounded_keeps_the_border_colour_in_the_corners(client, tmp_path):
    src = solid(tmp_path / "g.png", (0, 0, 0), size=(200, 200))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "inner_rounded", "radius": 60}, {"type": "border", "width": 20, "color": "#ff0000"}], out)
    arr = np.asarray(Image.open(out).convert("RGBA"))
    assert tuple(arr[22, 22][:3]) == (255, 0, 0) and arr[22, 22][3] == 255  # photo corner shows the frame colour
    assert tuple(arr[100, 100][:3]) == (0, 0, 0)
    assert arr[0, 0][3] == 255  # the outer frame stays square


def test_outer_rounded_is_independent(client, tmp_path):
    src = solid(tmp_path / "g.png", (0, 0, 0), size=(200, 200))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "border", "width": 20, "color": "#ff0000"}, {"type": "rounded", "radius": 50}], out)
    arr = np.asarray(Image.open(out).convert("RGBA"))
    assert arr[0, 0][3] == 0  # outer corner is cut
    assert tuple(arr[25, 25][:3]) == (0, 0, 0)  # the photo itself keeps its square corner


def test_negative_vignette_lightens_edges(client, tmp_path):
    src = solid(tmp_path / "g.png", (100, 100, 100))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "vignette", "strength": -0.8}], out)
    a = np.asarray(Image.open(out).convert("RGB")).astype(int)
    assert a[0, 0].mean() > a[150, 200].mean()


def test_denoise_reduces_noise(client, tmp_path):
    rng = np.random.default_rng(2)
    noisy = np.clip(128 + rng.normal(0, 25, (120, 160, 3)), 0, 255).astype(np.uint8)
    src = tmp_path / "n.png"
    Image.fromarray(noisy).save(src)
    out = tmp_path / "o.png"
    export(client, src, [{"type": "denoise", "strength": 20}], out)
    assert np.asarray(Image.open(out).convert("RGB")).std() < noisy.std() * 0.6


def test_grade_tints_shadows(client, tmp_path):
    src = solid(tmp_path / "d.png", (20, 20, 20))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "grade", "shadows": "#0000ff", "amount": 1}], out)
    r, g, b = np.asarray(Image.open(out).convert("RGB"))[5, 5].astype(int)
    assert b > r + 15


def test_lut_applies_a_cube_file(client, tmp_path):
    # a 2-point LUT that swaps red and blue
    lines = ["LUT_3D_SIZE 2"]
    for b in (0, 1):
        for g in (0, 1):
            for r in (0, 1):
                lines.append(f"{b} {g} {r}")
    cube = tmp_path / "swap.cube"
    cube.write_text("\n".join(lines), encoding="utf-8")
    src = solid(tmp_path / "r.png", (255, 0, 0))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "lut", "path": str(cube)}], out)
    assert tuple(np.asarray(Image.open(out).convert("RGB"))[5, 5]) == (0, 0, 255)
    bad = tmp_path / "bad.cube"
    bad.write_text("nope", encoding="utf-8")
    post(client, "/photo/preview", {"input": str(src), "edits": [{"type": "lut", "path": str(bad)}]}, 422)


def test_lens_changes_a_distorted_grid(client, tmp_path):
    src = tmp_path / "grid.png"
    Image.fromarray((np.indices((200, 200)).sum(axis=0) // 10 % 2 * 255).astype(np.uint8)).convert("RGB").save(src)
    out = tmp_path / "o.png"
    export(client, src, [{"type": "lens", "amount": 60}], out)
    assert not np.array_equal(np.asarray(Image.open(src).convert("L")), np.asarray(Image.open(out).convert("L")))


def test_page_numbers_saved_together_with_edits(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["one", "two", "three"])
    body = {
        "input": str(src), "output": str(out),
        "ops": [{"type": "text", "page": 1, "x": 72, "y": 200, "text": "Added", "size": 14}],
        "numbers": {"items": [{"position": "bottom-center", "text": "Page {n} of {total}"}]},
    }
    job = post_job(client, "/pdf/edit", body)
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert "Added" in d[0].get_text()
        assert [("Page %d of 3" % (i + 1)) in p.get_text() for i, p in enumerate(d)] == [True, True, True]


def test_page_numbers_alone_need_no_edits(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["one", "two"])
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "numbers": {"items": [{"position": "top-right", "text": "{n}"}], "start_at": 5}})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert "5" in d[0].get_text() and "6" in d[1].get_text()


def test_saving_without_items_still_writes_a_copy(client, tmp_path):
    """Page changes alone (a working copy with pages removed or moved) are saved the same way."""
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["one", "two"])
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out)})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert d.page_count == 2


# ---------------------------------------------------------------- more PDF tools


def test_compare_finds_changed_pages(client, tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    text_pdf(a, ["Total: 100", "same page"])
    text_pdf(b, ["Total: 250", "same page"])
    job = post_job(client, "/pdf/compare", {"a": str(a), "b": str(b)})
    assert job["state"] == "done", job
    pages = job["result"]["pages"]
    assert pages[0]["status"] == "changed" and "Total: 100" in pages[0]["removed"] and "Total: 250" in pages[0]["added"]
    assert pages[0]["image"]
    assert pages[1]["status"] == "same"


def pdf_with_picture(path: Path):
    buf = io.BytesIO()
    Image.new("RGB", (80, 60), (200, 30, 30)).save(buf, "PNG")
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_image(pymupdf.Rect(100, 100, 260, 220), stream=buf.getvalue())
    page.insert_text((72, 300), "caption", fontsize=12)
    doc.save(str(path))
    doc.close()


def test_pictures_listed_deleted_and_replaced(client, tmp_path):
    src = tmp_path / "p.pdf"
    pdf_with_picture(src)
    listed = post(client, "/pdf/images/list", {"input": str(src), "page": 1}, 200).json()
    assert len(listed["images"]) == 1
    xref = listed["images"][0]["xref"]
    out = tmp_path / "gone.pdf"
    job = post_job(client, "/pdf/images/apply", {"input": str(src), "output": str(out), "actions": [{"page": 1, "xref": xref, "action": "delete"}]})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert all(i["width"] <= 1 for i in d[0].get_image_info()) and "caption" in d[0].get_text()  # a 1-pixel blank is left in its place
    new = tmp_path / "blue.png"
    Image.new("RGB", (40, 30), (0, 0, 255)).save(new)
    out2 = tmp_path / "swapped.pdf"
    job = post_job(client, "/pdf/images/apply", {"input": str(src), "output": str(out2), "actions": [{"page": 1, "xref": xref, "action": "replace", "path": str(new)}]})
    assert job["state"] == "done", job
    with pymupdf.open(out2) as d:
        pix = d[0].get_pixmap(clip=pymupdf.Rect(120, 120, 240, 200))
        r, g, b = pix.pixel(10, 10)
        assert b > 200 and r < 60


def test_text_at_returns_the_line_and_its_look(client, tmp_path):
    src = tmp_path / "t.pdf"
    text_pdf(src, ["Hello world"])
    r = post(client, "/pdf/text-at", {"input": str(src), "page": 1, "x": 80, "y": 96}, 200).json()
    assert r["found"] and r["text"] == "Hello world" and abs(r["size"] - 12) < 0.5
    assert post(client, "/pdf/text-at", {"input": str(src), "page": 1, "x": 500, "y": 700}, 200).json() == {"found": False}


def test_form_fields_can_be_created_and_filled(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "f.pdf"
    text_pdf(src, ["Name:"])
    ops = [
        {"type": "field", "page": 1, "kind": "text", "name": "fullname", "x0": 120, "y0": 85, "x1": 300, "y1": 105},
        {"type": "field", "page": 1, "kind": "checkbox", "name": "agree", "x0": 120, "y0": 130, "x1": 135, "y1": 145},
        {"type": "field", "page": 1, "kind": "combobox", "name": "size", "choices": ["S", "M", "L"], "x0": 120, "y0": 160, "x1": 200, "y1": 180},
    ]
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "ops": ops})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert {w.field_name for w in d[0].widgets()} == {"fullname", "agree", "size"}
    dup = post_job(client, "/pdf/edit", {"input": str(out), "output": str(tmp_path / "d.pdf"), "ops": [ops[0]]})
    assert dup["state"] == "failed" and "already exists" in dup["error"]


def test_attachments_and_page_labels(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["a", "b", "c"])
    note = tmp_path / "note.txt"
    note.write_text("hello", encoding="utf-8")
    job = post_job(client, "/pdf/attachments/save", {"input": str(src), "output": str(out), "add": [str(note)], "labels": [{"startpage": 1, "style": "r"}, {"startpage": 3, "prefix": "A-", "style": "D"}]})
    assert job["state"] == "done", job
    info = post(client, "/pdf/attachments/list", {"input": str(out)}, 200).json()
    assert [a["name"] for a in info["attachments"]] == ["note.txt"]
    with pymupdf.open(out) as d:
        assert d[0].get_label() == "i" and d[2].get_label() == "A-1"
    out2 = tmp_path / "o2.pdf"
    post_job(client, "/pdf/attachments/save", {"input": str(out), "output": str(out2), "remove": ["note.txt"]})
    assert post(client, "/pdf/attachments/list", {"input": str(out2)}, 200).json()["attachments"] == []


def test_restrict_permissions(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["x"])
    job = post_job(client, "/pdf/restrict", {"input": str(src), "output": str(out), "owner_password": "boss", "allow": ["print"]})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert not d.needs_pass  # anyone can open it
        assert d.permissions & pymupdf.PDF_PERM_PRINT
        assert not d.permissions & pymupdf.PDF_PERM_COPY


def test_repair_reads_a_truncated_file(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    text_pdf(src, ["one", "two", "three"])
    data = src.read_bytes()
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(data[: int(len(data) * 0.85)] + b"\n%%EOF\n")
    job = post_job(client, "/pdf/repair", {"input": str(broken), "output": str(out)})
    assert job["state"] in ("done", "failed")  # recovery depends on how much was lost
    if job["state"] == "done":
        with pymupdf.open(out) as d:
            assert d.page_count >= 1
    job = post_job(client, "/pdf/repair", {"input": str(src), "output": str(tmp_path / "ok.pdf")})
    assert job["state"] == "done" and job["result"]["pages"] == 3


def test_impose_nup_and_booklet(client, tmp_path):
    src = tmp_path / "s.pdf"
    text_pdf(src, [f"page {i}" for i in range(1, 9)])
    out = tmp_path / "n.pdf"
    job = post_job(client, "/pdf/impose", {"input": str(src), "output": str(out), "mode": "nup", "per_sheet": 4, "paper": "A4"})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert d.page_count == 2
        assert "page 1" in d[0].get_text() and "page 5" in d[1].get_text()
    out2 = tmp_path / "b.pdf"
    job = post_job(client, "/pdf/impose", {"input": str(src), "output": str(out2), "mode": "booklet", "paper": "A4"})
    assert job["state"] == "done", job
    with pymupdf.open(out2) as d:
        assert d.page_count == 4
        first = d[0].get_text()
        assert "page 8" in first and "page 1" in first  # outer sheet carries the last and the first page


def test_clean_scan_straightens_and_whitens(client, tmp_path):
    import cv2

    img = np.full((1100, 800, 3), 200, np.uint8)  # grey scanner background
    paper = np.full((1000, 700, 3), 235, np.uint8)
    for y in range(120, 900, 60):
        cv2.putText(paper, "Lorem ipsum dolor sit amet", (40, y), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (20, 20, 20), 2)
    img[50:1050, 50:750] = paper
    m = cv2.getRotationMatrix2D((400, 550), 4, 1.0)
    img = cv2.warpAffine(img, m, (800, 1100), borderValue=(200, 200, 200))
    png = tmp_path / "scan.png"
    Image.fromarray(img).save(png)
    src = tmp_path / "scan.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, filename=str(png))
    doc.save(str(src))
    doc.close()
    out = tmp_path / "clean.pdf"
    job = post_job(client, "/pdf/clean-scan", {"input": str(src), "output": str(out), "mode": "bw"})
    assert job["state"] == "done", job
    assert job["result"]["straightened"] == 1
    with pymupdf.open(out) as d:
        pix = d[0].get_pixmap(dpi=50)
        arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        assert (arr[..., 0] > 200).mean() > 0.7  # a white page with dark text


def test_pdf_batch_applies_steps_to_many_files(client, tmp_path):
    ins = []
    for i in range(3):
        p = tmp_path / f"d{i}.pdf"
        text_pdf(p, [f"doc {i}"])
        ins.append(str(p))
    outd = tmp_path / "done"
    job = post_job(client, "/pdf/batch", {"inputs": ins, "out_dir": str(outd), "steps": [{"type": "watermark", "text": "COPY"}, {"type": "numbers", "text": "{n}"}, {"type": "clean_metadata"}]})
    assert job["state"] == "done", job
    assert job["result"]["count"] == 3
    for f in job["result"]["outputs"]:
        with pymupdf.open(f) as d:
            assert "COPY" in d[0].get_text() and (d.metadata.get("title") or "") == ""
    post(client, "/pdf/batch", {"inputs": ins, "out_dir": str(outd), "steps": [{"type": "encrypt"}]}, 422)


# ---------------------------------------------------------------- ready-made outputs


def test_social_sizes_listed_and_exported(client, tmp_path):
    sizes = client.get("/photo/social-sizes", headers=AUTH).json()["sizes"]
    assert {"id": "instagram_post", "label": "Instagram post (square)", "width": 1080, "height": 1080} in sizes
    src = two_tone(tmp_path / "t.png", size=(1600, 900))
    out_dir = tmp_path / "social"
    job = post_job(client, "/photo/social", {"input": str(src), "out_dir": str(out_dir), "presets": ["instagram_post", "youtube_thumbnail"]})
    assert job["state"] == "done", job
    got = {Path(p).name: Image.open(p).size for p in job["result"]["outputs"]}
    assert got == {"t_instagram_post.jpg": (1080, 1080), "t_youtube_thumbnail.jpg": (1280, 720)}
    job = post_job(client, "/photo/social", {"input": str(src), "out_dir": str(out_dir), "presets": ["instagram_story"], "mode": "fit", "background": "#000000", "format": "png"})
    im = Image.open(job["result"]["outputs"][0]).convert("RGB")
    assert im.size == (1080, 1920) and im.getpixel((540, 10)) == (0, 0, 0)  # letterbox bars


def test_passport_sheet_fills_the_paper(client, tmp_path):
    src = solid(tmp_path / "p.png", (180, 120, 90), size=(600, 800))
    out = tmp_path / "sheet.jpg"
    job = post_job(client, "/photo/passport", {"input": str(src), "output": str(out), "width_mm": 35, "height_mm": 45, "paper": "10x15"})
    assert job["state"] == "done", job
    r = job["result"]
    assert r["photos"] == r["columns"] * r["rows"] and r["photos"] >= 6
    im = Image.open(out)
    assert abs(im.width / im.height - 152 / 102) < 0.02 or abs(im.width / im.height - 102 / 152) < 0.02
    one = post_job(client, "/photo/passport", {"input": str(src), "output": str(tmp_path / "one.png"), "count": 2})
    assert one["result"]["photos"] == 2


def test_collage_and_animation(client, tmp_path):
    imgs = [str(solid(tmp_path / f"c{i}.png", c, size=(300, 200))) for i, c in enumerate([(200, 0, 0), (0, 200, 0), (0, 0, 200), (200, 200, 0)])]
    out = tmp_path / "collage.png"
    job = post_job(client, "/photo/collage", {"inputs": imgs, "output": str(out), "columns": 2, "gap": 10})
    assert job["state"] == "done", job
    im = Image.open(out).convert("RGB")
    assert im.size == (2 * 800 + 3 * 10, 2 * 800 + 3 * 10)
    assert im.getpixel((10 + 400, 10 + 400)) == (200, 0, 0) and im.getpixel((10 + 800 + 10 + 400, 10 + 400)) == (0, 200, 0)
    gif = tmp_path / "a.gif"
    job = post_job(client, "/photo/animation", {"inputs": imgs, "output": str(gif), "duration_ms": 200})
    assert job["state"] == "done", job
    with Image.open(gif) as g:
        assert g.n_frames == 4
    bad = post_job(client, "/photo/animation", {"inputs": imgs, "output": str(tmp_path / "a.bmp")})
    assert bad["state"] == "failed"


def test_exposure_merge_balances_dark_and_bright(client, tmp_path):
    rng = np.random.default_rng(3)
    scene = rng.integers(60, 200, (120, 160, 3), dtype=np.uint8)
    dark = tmp_path / "dark.png"
    bright = tmp_path / "bright.png"
    Image.fromarray((scene * 0.3).astype(np.uint8)).save(dark)
    Image.fromarray(np.clip(scene * 1.6, 0, 255).astype(np.uint8)).save(bright)
    out = tmp_path / "hdr.jpg"
    job = post_job(client, "/photo/merge-exposure", {"inputs": [str(dark), str(bright)], "output": str(out)})
    assert job["state"] == "done", job
    mean = np.asarray(Image.open(out).convert("L")).mean()
    assert 60 < mean < 200


def test_panorama_reports_unmatchable_photos(client, tmp_path):
    a = solid(tmp_path / "a.png", (10, 10, 10))
    b = solid(tmp_path / "b.png", (240, 240, 240))
    job = post_job(client, "/photo/panorama", {"inputs": [str(a), str(b)], "output": str(tmp_path / "p.jpg")})
    assert job["state"] == "failed" and "overlap" in job["error"]


def test_qr_code_is_drawn(client, tmp_path):
    pytest.importorskip("segno")
    src = solid(tmp_path / "w.png", (255, 255, 255), size=(400, 400))
    out = tmp_path / "o.png"
    export(client, src, [{"type": "qr", "text": "https://example.com", "x": 0.5, "y": 0.5, "w": 0.5}], out)
    arr = np.asarray(Image.open(out).convert("L"))
    assert arr[100:300, 100:300].min() == 0 and arr[0:50, 0:50].min() == 255
    post(client, "/photo/preview", {"input": str(src), "edits": [{"type": "qr", "text": ""}]}, 422)


def test_basic_upscale_needs_no_download(client, tmp_path):
    src = solid(tmp_path / "s.png", (50, 100, 150), size=(60, 40))
    job = post_job(client, "/media/upscale", {"inputs": [str(src)], "out_dir": str(tmp_path / "up"), "scale": 3})
    assert job["state"] == "done", job
    assert Image.open(job["result"]["outputs"][0]).size == (180, 120)


# ---------------------------------------------------------------- add-ons


def test_extras_are_listed_with_their_state(client):
    items = client.get("/extras", headers=AUTH).json()["extras"]
    assert {e["id"] for e in items} == {"background", "speech", "documents", "ocr", "signing", "word"}
    assert all({"name", "text", "size_mb", "installed"} <= set(e) for e in items)
    assert client.post("/extras/nope/install", headers=AUTH).status_code == 404


def test_missing_addon_gives_a_plain_message(client, tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALFLOW_HIDE_EXTRAS", "word")
    src = tmp_path / "s.pdf"
    text_pdf(src, ["x"])
    job = post_job(client, "/pdf/to-docx", {"input": str(src), "output": str(tmp_path / "o.docx")})
    assert job["state"] == "failed"
    assert "add-on" in job["error"] and "PDF to Word" in job["error"]


# ---------------------------------------------------------------- fonts and folders


def test_every_installed_font_is_offered_and_usable(client, tmp_path):
    fonts = client.get("/photo/fonts", headers=AUTH).json()["fonts"]
    assert "Arial" in fonts and len(fonts) >= 10  # the curated list first, then everything else installed
    src = tmp_path / "t.pdf"
    text_pdf(src, ["x"])
    other = next((f for f in fonts if f not in ("Arial", "Segoe UI", "Calibri", "Times New Roman", "Georgia", "Verdana", "Courier New", "Consolas", "Comic Sans MS", "Impact", "DejaVu Sans")), None)
    if other:
        job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(tmp_path / "o.pdf"), "ops": [{"type": "text", "page": 1, "x": 72, "y": 200, "text": "Çağrı", "size": 14, "font": other}]})
        assert job["state"] == "done", job


def test_a_font_file_can_be_added_and_removed(client, tmp_path):
    from localflow import fonts as fontlib

    arial = fontlib.font_path("Arial")
    if not arial:
        pytest.skip("no system font to copy")
    mine = tmp_path / "MyFace.ttf"
    mine.write_bytes(Path(arial).read_bytes())
    r = post(client, "/photo/fonts/add", {"path": str(mine)}, 200).json()
    assert r["family"] in r["custom"]
    post(client, "/photo/fonts/add", {"path": str(tmp_path / "notafont.txt")}, 404)
    bad = tmp_path / "bad.ttf"
    bad.write_bytes(b"nope")
    post(client, "/photo/fonts/add", {"path": str(bad)}, 422)
    gone = client.delete("/photo/fonts/" + r["family"], headers=AUTH).json()
    assert gone["removed"] >= 1 and r["family"] not in gone["custom"]


def test_folder_files_can_skip_subfolders_and_filter(client, tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.pdf").write_bytes(b"x")
    (tmp_path / "docs" / "b.txt").write_bytes(b"x")
    (tmp_path / "docs" / "sub").mkdir()
    (tmp_path / "docs" / "sub" / "c.pdf").write_bytes(b"x")
    top = post(client, "/files/folder-files", {"folder": str(tmp_path / "docs"), "extensions": ["pdf"]}, 200).json()["files"]
    assert [Path(f).name for f in top] == ["a.pdf"]
    deep = post(client, "/files/folder-files", {"folder": str(tmp_path / "docs"), "extensions": ["pdf"], "recursive": True}, 200).json()["files"]
    assert sorted(Path(f).name for f in deep) == ["a.pdf", "c.pdf"]
    every = post(client, "/files/folder-files", {"folder": str(tmp_path / "docs"), "extensions": ["*"]}, 200).json()["files"]
    assert len(every) == 2


def test_text_between_selects_words_per_line(client, tmp_path):
    src = tmp_path / "t.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), "alpha beta gamma", fontsize=12)
    page.insert_text((72, 120), "delta epsilon zeta", fontsize=12)
    doc.save(str(src))
    doc.close()
    with pymupdf.open(src) as d:
        w = {x[4]: x for x in d[0].get_text("words")}
    # from the middle of "beta" to the middle of "delta": the end of line 1 and the start of line 2
    a = ((w["beta"][0] + w["beta"][2]) / 2, (w["beta"][1] + w["beta"][3]) / 2)
    b = ((w["delta"][0] + w["delta"][2]) / 2, (w["delta"][1] + w["delta"][3]) / 2)
    r = post(client, "/pdf/text-between", {"input": str(src), "page": 1, "ax": a[0], "ay": a[1], "bx": b[0], "by": b[1]}, 200).json()
    assert r["found"] and len(r["lines"]) == 2
    first, second = r["lines"]
    assert abs(first[0] - w["beta"][0]) < 1 and abs(first[2] - w["gamma"][2]) < 1
    assert abs(second[0] - w["delta"][0]) < 1 and abs(second[2] - w["delta"][2]) < 1
    one = post(client, "/pdf/text-between", {"input": str(src), "page": 1, "ax": a[0], "ay": a[1], "bx": a[0], "by": a[1]}, 200).json()
    assert len(one["lines"]) == 1 and abs(one["lines"][0][0] - w["beta"][0]) < 1
    blank = post(client, "/pdf/text-between", {"input": str(src), "page": 1, "ax": 500, "ay": 700, "bx": 520, "by": 720}, 200).json()
    assert blank["found"] is False


# ---------------------------------------------------------------- editing what is already in the PDF


def doc_with_content(path: Path):
    buf = io.BytesIO()
    Image.new("RGBA", (80, 60), (200, 30, 30, 255)).save(buf, "PNG")
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), "First paragraph", fontsize=14)
    page.insert_text((72, 118), "continues here", fontsize=14)
    page.insert_text((72, 400), "Footer note", fontsize=10)
    page.insert_image(pymupdf.Rect(300, 80, 460, 200), stream=buf.getvalue())
    doc.new_page().insert_text((72, 100), "Second page", fontsize=12)
    doc.save(str(path))
    doc.close()


def test_page_objects_list_text_blocks_and_pictures(client, tmp_path):
    src = tmp_path / "c.pdf"
    doc_with_content(src)
    r = post(client, "/pdf/page-objects", {"input": str(src), "page": 1}, 200).json()
    texts = {t["text"]: t for t in r["texts"]}
    assert "First paragraph\ncontinues here" in texts and "Footer note" in texts
    assert abs(texts["Footer note"]["size"] - 10) < 0.5
    assert len(r["images"]) == 1 and r["images"][0]["rect"][0] > 290
    img = post(client, "/pdf/original-image", {"input": str(src), "xref": r["images"][0]["xref"]}, 200).json()
    assert img["width"] == 80 and base64.b64decode(img["image"])[:4] == b"\x89PNG"


def test_a_picture_of_the_page_can_be_moved_resized_and_deleted(client, tmp_path):
    src, out = tmp_path / "c.pdf", tmp_path / "m.pdf"
    doc_with_content(src)
    im = post(client, "/pdf/page-objects", {"input": str(src), "page": 1}, 200).json()["images"][0]
    op = {"type": "origimg", "page": 1, "xref": im["xref"], "x0": 100, "y0": 300, "x1": 300, "y1": 360}
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "ops": [op]})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        info = d[0].get_image_info()
        assert any(abs(i["bbox"][0] - 100) < 2 and abs(i["bbox"][1] - 300) < 2 and i["width"] > 1 for i in info)
        old_place = [i for i in info if abs(i["bbox"][0] - 300) < 2 and abs(i["bbox"][1] - 80) < 2]
        assert all(i["width"] <= 1 for i in old_place)  # only a blank 1-pixel picture is left where it was
    gone = tmp_path / "g.pdf"
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(gone), "ops": [{**op, "deleted": True}]})
    assert job["state"] == "done", job
    with pymupdf.open(gone) as d:
        assert all(i["width"] <= 1 for i in d[0].get_image_info())


def test_page_text_can_be_moved_by_covering_and_rewriting(client, tmp_path):
    src, out = tmp_path / "c.pdf", tmp_path / "m.pdf"
    doc_with_content(src)
    t = next(x for x in post(client, "/pdf/page-objects", {"input": str(src), "page": 1}, 200).json()["texts"] if x["text"] == "Footer note")
    x0, y0, x1, y1 = t["rect"]
    ops = [
        {"type": "erase", "page": 1, "x0": x0 - 1, "y0": y0 - 1, "x1": x1 + 1, "y1": y1 + 1},
        {"type": "text", "page": 1, "x": x0 + 100, "y": y0 - 200, "text": t["text"], "size": t["size"], "font": "Arial", "color": t["color"]},
    ]
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "ops": ops})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        words = {w[4]: w for w in d[0].get_text("words")}
        assert words["Footer"][1] < 250  # now near the top
        assert d[0].get_text().count("Footer") == 1  # the old copy is really gone


def test_working_copy_with_pages_removed_moved_and_added(client, tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    text_pdf(a, ["one", "two", "three"])
    text_pdf(b, ["bee"])
    plan = [{"source": 0, "page": 3}, {"source": 0, "page": 1, "rotate": 90}, {"blank": True, "width": 300, "height": 400}, {"source": 1, "page": 1}]
    r = post(client, "/pdf/work/build", {"sources": [str(a), str(b)], "plan": plan}, 200).json()
    with pymupdf.open(r["path"]) as d:
        assert r["pages"] == 4 == d.page_count
        assert "three" in d[0].get_text() and "one" in d[1].get_text() and d[1].rotation == 90
        assert d[2].get_text().strip() == "" and round(d[2].rect.width) == 300
        assert "bee" in d[3].get_text()
    assert Path(r["path"]).parent.name == "work"
    post(client, "/pdf/work/build", {"sources": [str(a)], "plan": [{"source": 0, "page": 9}]}, 422)
    assert a.stat().st_size > 0 and pymupdf.open(a).page_count == 3  # the original is untouched


def test_edits_can_be_baked_then_split_with_a_nice_name(client, tmp_path):
    src = tmp_path / "book.pdf"
    text_pdf(src, ["one", "two", "three"])
    r = post(client, "/pdf/work/edit", {"input": str(src), "ops": [{"type": "text", "page": 2, "x": 72, "y": 200, "text": "Added note", "size": 14}]}, 200).json()
    out = tmp_path / "parts"
    job = post_job(client, "/pdf/split-parts", {"input": r["path"], "out_dir": str(out), "at": [2], "name": "book"})
    assert job["state"] == "done", job
    names = sorted(Path(p).name for p in job["result"]["outputs"])
    assert names == ["book_part01.pdf", "book_part02.pdf"]
    with pymupdf.open(job["result"]["outputs"][1]) as d:
        assert "Added note" in d[0].get_text()  # the edit travelled with its page


def _png(path, color, size=(120, 80)):
    from PIL import Image

    Image.new("RGB", size, color).save(path)


def test_rewriting_text_over_a_background_picture_keeps_the_picture(client, tmp_path):
    src, out, bg = tmp_path / "bg.pdf", tmp_path / "o.pdf", tmp_path / "bg.png"
    _png(bg, (200, 40, 40), (300, 300))
    with pymupdf.open() as d:
        p = d.new_page(width=400, height=400)
        p.insert_image(p.rect, filename=str(bg))
        p.insert_text((50, 100), "Hello world", fontsize=20, color=(1, 1, 1))
        p.insert_text((50, 124), "Second line", fontsize=20, color=(1, 1, 1))
        d.save(src)
    t = post(client, "/pdf/text-at", {"input": str(src), "page": 1, "x": 60, "y": 95}, 200).json()
    assert t["found"] and t["text"].startswith("Hello")
    x0, y0, x1, y1 = t["rect"]
    ops = [{"type": "cover", "page": 1, "x0": x0, "y0": y0, "x1": x1, "y1": y1}]
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "ops": ops})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        text = d[0].get_text()
        assert "Hello" not in text and "Second line" in text  # only that line went
        assert any(i["width"] > 1 for i in d[0].get_image_info())  # the background picture is still there
        pix = d[0].get_pixmap(clip=pymupdf.Rect(x0 + 2, y0 + 2, x1 - 2, y1 - 2))
        r, g, b = pix.pixel(pix.width // 2, pix.height // 2)[:3]
        assert r > 150 and g < 90 and b < 90  # red background where the text was, not a white patch


def test_deleting_a_repeated_logo_on_one_page_keeps_it_on_the_others(client, tmp_path):
    src, out, logo, bg = tmp_path / "l.pdf", tmp_path / "o.pdf", tmp_path / "logo.png", tmp_path / "bg.png"
    _png(logo, (20, 20, 200))
    _png(bg, (240, 240, 120), (300, 300))
    with pymupdf.open() as d:
        for _ in range(3):
            p = d.new_page(width=300, height=300)
            p.insert_image(p.rect, filename=str(bg))  # a full-page background, drawn first
            p.insert_image(pymupdf.Rect(20, 20, 140, 100), filename=str(logo))
        d.save(src)
    im = next(i for i in post(client, "/pdf/page-objects", {"input": str(src), "page": 2}, 200).json()["images"] if not i["background"])
    x0, y0, x1, y1 = im["rect"]
    op = {"type": "origimg", "page": 2, "xref": im["xref"], "x0": x0, "y0": y0, "x1": x1, "y1": y1, "ox0": x0, "oy0": y0, "ox1": x1, "oy1": y1, "deleted": True}
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "ops": [op]})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        def looks_like_logo(pg):  # what a person sees: blue where the logo is, not the yellow background
            pix = pg.get_pixmap(clip=pymupdf.Rect(40, 40, 120, 80))
            r, g, b = pix.pixel(pix.width // 2, pix.height // 2)[:3]
            return b > 150 and r < 100
        assert [looks_like_logo(pg) for pg in d] == [True, False, True]



def test_assemble_merges_reorders_and_splits_in_one_go(client, tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    text_pdf(a, ["one", "two", "three"])
    text_pdf(b, ["bee"])
    o1, o2 = tmp_path / "p1.pdf", tmp_path / "p2.pdf"
    parts = [
        {"output": str(o1), "plan": [{"source": 1, "page": 1}, {"source": 0, "page": 3, "rotate": 90}]},
        {"output": str(o2), "plan": [{"source": 0, "page": 1}, {"blank": True, "width": 200, "height": 300}]},
    ]
    job = post_job(client, "/pdf/assemble", {"sources": [str(a), str(b)], "parts": parts})
    assert job["state"] == "done", job
    with pymupdf.open(o1) as d:
        assert d.page_count == 2 and "bee" in d[0].get_text() and "three" in d[1].get_text() and d[1].rotation == 90
    with pymupdf.open(o2) as d:
        assert d.page_count == 2 and "one" in d[0].get_text()
    post(client, "/pdf/assemble", {"sources": [str(a)], "parts": [{"output": str(o1), "plan": [{"page": 1}]}]}, 409)
    post(client, "/pdf/assemble", {"sources": [str(a)], "parts": [{"output": str(tmp_path / "x.pdf"), "plan": [{"source": 4, "page": 1}]}]}, 400)
