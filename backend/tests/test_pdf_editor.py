import base64
import io
import json
from pathlib import Path

import numpy as np
import pymupdf
import pytest
from PIL import Image

from test_api import AUTH, client  # noqa: F401
from test_files import post, post_job


def doc(path: Path, pages=("one", "two", "three"), rotate=0, size=(400, 300)):
    d = pymupdf.open()
    for t in pages:
        p = d.new_page(width=size[0], height=size[1])
        p.insert_text((60, 120), t, fontsize=20)
        if rotate:
            p.set_rotation(rotate)
    d.save(str(path))
    d.close()
    return path


def preview(client, path, ops, page=1, width=400):
    r = post(client, "/pdf/edit/preview", {"input": str(path), "page": page, "ops": ops, "width": width}, 200).json()
    img = Image.open(io.BytesIO(base64.b64decode(r["image"]))).convert("RGB")
    return r, img


def ink_bbox(img, color=None, tol=60, thr=100):
    a = np.asarray(img, dtype=np.int32)
    if color is None:
        mask = a.sum(axis=2) < thr * 3
    else:
        mask = (np.abs(a - np.array(color)).sum(axis=2) < tol)
    ys, xs = np.where(mask)
    return None if len(xs) == 0 else (xs.min(), ys.min(), xs.max(), ys.max())


def save(client, src, ops, out, **kw):
    job = post_job(client, "/pdf/edit", {"input": str(src), "output": str(out), "ops": ops, **kw})
    assert job["state"] == "done", job["error"]
    return job


# ---- text ----------------------------------------------------------------------------------------


def test_text_lands_where_asked_in_the_saved_file(client, tmp_path):
    src, out = doc(tmp_path / "s.pdf"), tmp_path / "o.pdf"
    ops = [{"type": "text", "page": 2, "x": 100, "y": 200, "text": "Çalışma İşi ğüö", "size": 18, "color": "#cc0000"}]
    job = save(client, src, ops, out)
    assert job["result"]["edits"] == 1 and job["result"]["pages"] == 3
    with pymupdf.open(out) as d:
        assert "Çalışma İşi ğüö" in d[1].get_text()
        assert "Çalışma" not in d[0].get_text()  # only the chosen page
        word = d[1].search_for("Çalışma")[0]
        assert 95 < word.x0 < 110 and 195 < word.y0 < 215
    assert post(client, "/pdf/edit", {"input": str(src), "output": str(tmp_path / "x.pdf"), "ops": [{"type": "text", "page": 1, "x": 1, "y": 1, "text": " "}]}, 202).status_code == 202
    bad = post_job(client, "/pdf/edit", {"input": str(src), "output": str(tmp_path / "y.pdf"), "ops": [{"type": "text", "page": 9, "x": 1, "y": 1, "text": "x"}]})
    assert bad["state"] == "failed" and "page 9" in bad["error"]


def test_text_options_wrap_align_background_rotation(client, tmp_path):
    src = doc(tmp_path / "s.pdf")
    base = {"type": "text", "page": 1, "x": 60, "y": 60, "size": 14, "color": "#000000"}
    r, _ = preview(client, src, [{**base, "text": "alpha beta gamma delta epsilon zeta eta theta", "width": 120}])
    x0, y0, x1, y1 = r["boxes"][0]["rect"]
    assert x1 - x0 <= 125 and y1 - y0 > 40, "long text wraps inside the given width"
    _, plain = preview(client, src, [{**base, "text": "Hi"}])
    _, boxed = preview(client, src, [{**base, "text": "Hi", "background": "#ffff00", "border": "#ff0000"}])
    assert ink_bbox(boxed, (255, 255, 0), 40) is not None and ink_bbox(plain, (255, 255, 0), 40) is None
    _, flat = preview(client, src, [{**base, "text": "Rotate me please", "size": 24}])
    _, tilt = preview(client, src, [{**base, "text": "Rotate me please", "size": 24, "rotate": 90}])
    bf, bt = ink_bbox(flat, thr=60), ink_bbox(tilt, thr=60)
    fw, fh = bf[2] - bf[0], bf[3] - bf[1]
    # the page's own "one" text is also dark; compare the added text by checking the dominant shape
    _, only = preview(client, doc(tmp_path / "e.pdf", ("",)), [{**base, "text": "Rotate me please", "size": 24}])
    _, onlyr = preview(client, doc(tmp_path / "e2.pdf", ("",)), [{**base, "text": "Rotate me please", "size": 24, "rotate": 90}])
    a, b = ink_bbox(only), ink_bbox(onlyr)
    assert (a[2] - a[0]) > (a[3] - a[1]) and (b[3] - b[1]) > (b[2] - b[0])
    r2, ghost = preview(client, doc(tmp_path / "e3.pdf", ("",)), [{**base, "text": "WWWWWWWW", "size": 30, "opacity": 0.3}])
    assert 120 < np.asarray(ghost).min() < 230  # translucent, not solid black


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_text_is_upright_and_in_place_on_rotated_pages(client, tmp_path, rot):
    src = doc(tmp_path / "r.pdf", ("",), rotate=rot)
    r, img = preview(client, src, [{"type": "text", "page": 1, "x": 80, "y": 50, "text": "Upright text", "size": 22}], width=None or 400)
    sx = img.width / r["page_width"]
    x0, y0, x1, y1 = ink_bbox(img)
    assert (x1 - x0) > (y1 - y0) * 2, f"text must read left-to-right on a page rotated {rot}"
    assert abs(x0 / sx - 80) < 12 and abs(y0 / sx - 50) < 14, "text starts where it was placed on the displayed page"
    bx0, by0, _bx1, _by1 = r["boxes"][0]["rect"]
    assert abs(bx0 - 80) < 1 and abs(by0 - 50) < 1


# ---- images / signatures ---------------------------------------------------------------------------


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_image_shows_upright_on_rotated_pages(client, tmp_path, rot):
    logo = tmp_path / "logo.png"
    im = Image.new("RGB", (60, 30), (0, 0, 220))
    im.paste((220, 0, 0), (0, 0, 30, 30))  # left half red, right half blue
    im.save(logo)
    src = doc(tmp_path / "r.pdf", ("",), rotate=rot)
    r, img = preview(client, src, [{"type": "image", "page": 1, "x0": 100, "y0": 100, "w": 120, "path": str(logo)}])
    s = img.width / r["page_width"]
    left, right = img.getpixel((int(115 * s), int(115 * s))), img.getpixel((int(205 * s), int(115 * s)))
    assert left[0] > 180 and left[2] < 80, f"left side of the image must stay on the left (rot {rot}): {left}"
    assert right[2] > 180 and right[0] < 80, f"right side must stay on the right (rot {rot}): {right}"
    half = preview(client, src, [{"type": "image", "page": 1, "x0": 100, "y0": 100, "w": 120, "path": str(logo), "opacity": 0.5}])[1].getpixel((int(115 * s), int(115 * s)))
    assert 90 < half[1] < 200  # halfway between white and red's green channel


def test_image_path_must_be_allowed(client, tmp_path):
    src = doc(tmp_path / "s.pdf")
    r = post(client, "/pdf/edit/preview", {"input": str(src), "page": 1, "ops": [{"type": "image", "page": 1, "x0": 1, "y0": 1, "path": "C:/Windows/win.ini"}]})
    assert r.status_code == 403
    r = post(client, "/pdf/edit/preview", {"input": str(src), "page": 1, "ops": [{"type": "image", "page": 1, "x0": 1, "y0": 1, "path": str(tmp_path / "missing.png")}]})
    assert r.status_code == 404


# ---- markup, shapes, notes, links ------------------------------------------------------------------


def annots(path, page=0):
    with pymupdf.open(path) as d:
        pg = d[page]  # keep the page alive while its annotations are read
        return [a.type[1] for a in pg.annots()]


def test_highlight_underline_strike_cover_only_the_dragged_words(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "o.pdf"
    d = pymupdf.open()
    p = d.new_page(width=400, height=300)
    p.insert_text((60, 100), "alpha beta gamma", fontsize=20)
    d.save(str(src))
    word = pymupdf.open(src)[0].search_for("beta")[0]
    area = {"x0": word.x0 + 1, "y0": word.y0 + 1, "x1": word.x1 - 1, "y1": word.y1 - 1}
    ops = [{"type": "highlight", "page": 1, **area}, {"type": "underline", "page": 1, **area, "color": "#00aa00"}, {"type": "strike", "page": 1, **area}]
    save(client, src, ops, out)
    assert annots(out) == ["Highlight", "Underline", "StrikeOut"]
    with pymupdf.open(out) as dd:
        pg = dd[0]
        quad = list(pg.annots())[0].rect
        assert word.x0 - 10 < quad.x0 < word.x0 + 3 and quad.x1 < word.x1 + 10 and quad.x1 - quad.x0 < 70  # only "beta", not the whole line (about 165 wide)
    # on an area without text (a scan), the area itself is marked
    save(client, src, [{"type": "highlight", "page": 1, "x0": 10, "y0": 200, "x1": 150, "y1": 240}], tmp_path / "o2.pdf")
    assert annots(tmp_path / "o2.pdf") == ["Highlight"]


def test_shapes_become_real_annotations_and_render(client, tmp_path):
    src, out = doc(tmp_path / "s.pdf", ("",)), tmp_path / "o.pdf"
    ops = [
        {"type": "rect", "page": 1, "x0": 20, "y0": 20, "x1": 120, "y1": 80, "color": "#0000ff", "width": 4},
        {"type": "ellipse", "page": 1, "x0": 150, "y0": 20, "x1": 250, "y1": 80, "color": "#00aa00", "fill": "#ccffcc", "width": 3},
        {"type": "line", "page": 1, "x0": 20, "y0": 150, "x1": 200, "y1": 150, "color": "#ff0000", "width": 3},
        {"type": "arrow", "page": 1, "x0": 20, "y0": 200, "x1": 200, "y1": 200, "color": "#aa00aa", "width": 3},
        {"type": "ink", "page": 1, "strokes": [[[260, 150], [300, 200], [340, 150]]], "color": "#000000", "width": 3},
    ]
    save(client, src, ops, out)
    assert annots(out) == ["Square", "Circle", "Line", "Line", "Ink"]
    _, img = preview(client, src, ops)
    assert img.getpixel((70, 20))[2] > 150 and img.getpixel((70, 20))[0] < 100  # blue top edge of the rectangle
    assert ink_bbox(img, (255, 0, 0), 120) is not None  # the red line is visible
    assert img.getpixel((200, 50))[1] > 190 and img.getpixel((200, 50))[0] < 235  # filled ellipse interior is light green
    assert post(client, "/pdf/edit/preview", {"input": str(src), "page": 1, "ops": [{"type": "ink", "page": 1, "strokes": []}]}).status_code == 422


def test_notes_and_links(client, tmp_path):
    src, out = doc(tmp_path / "s.pdf"), tmp_path / "o.pdf"
    ops = [
        {"type": "note", "page": 1, "x": 300, "y": 40, "text": "Check this figure"},
        {"type": "link", "page": 1, "x0": 50, "y0": 100, "x1": 120, "y1": 130, "uri": "https://example.com"},
        {"type": "link", "page": 1, "x0": 50, "y0": 150, "x1": 120, "y1": 170, "target_page": 3},
    ]
    save(client, src, ops, out)
    with pymupdf.open(out) as d:
        pg = d[0]
        assert [a.info["content"] for a in pg.annots()] == ["Check this figure"]
        links = pg.get_links()
        assert [l["kind"] for l in links] == [pymupdf.LINK_URI, pymupdf.LINK_GOTO]
        assert links[0]["uri"] == "https://example.com" and links[1]["page"] == 2
    for bad in ({"type": "link", "page": 1, "x0": 1, "y0": 1, "x1": 50, "y1": 50, "uri": "javascript:alert(1)"},
                {"type": "link", "page": 1, "x0": 1, "y0": 1, "x1": 50, "y1": 50},
                {"type": "link", "page": 1, "x0": 1, "y0": 1, "x1": 50, "y1": 50, "target_page": 9},
                {"type": "note", "page": 1, "x": 1, "y": 1, "text": ""}):
        assert post(client, "/pdf/edit/preview", {"input": str(src), "page": 1, "ops": [bad]}).status_code == 422, bad


def test_erase_and_redact_delete_the_content_and_run_before_new_content(client, tmp_path):
    src, out = doc(tmp_path / "s.pdf", ("secret words",)), tmp_path / "o.pdf"
    w = pymupdf.open(src)[0].search_for("secret")[0]
    ops = [
        {"type": "text", "page": 1, "x": 60, "y": 200, "text": "replacement"},  # listed first, still survives
        {"type": "erase", "page": 1, "x0": w.x0 - 2, "y0": w.y0 - 2, "x1": w.x1 + 2, "y1": w.y1 + 2},
    ]
    save(client, src, ops, out)
    with pymupdf.open(out) as d:
        t = d[0].get_text()
        assert "secret" not in t and "words" in t and "replacement" in t
    _, img = preview(client, src, [{"type": "redact", "page": 1, "x0": w.x0, "y0": w.y0, "x1": w.x1, "y1": w.y1}])
    assert img.getpixel((int((w.x0 + w.x1) / 2), int((w.y0 + w.y1) / 2)))[0] < 30  # black box


def test_preview_reports_boxes_only_for_that_page_and_matches_op_indexes(client, tmp_path):
    src = doc(tmp_path / "s.pdf")
    ops = [
        {"type": "rect", "page": 1, "x0": 10, "y0": 10, "x1": 60, "y1": 40},
        {"type": "text", "page": 2, "x": 30, "y": 30, "text": "on two"},
        {"type": "rect", "page": 2, "x0": 100, "y0": 100, "x1": 180, "y1": 160},
    ]
    r1, _ = preview(client, src, ops, page=1)
    r2, _ = preview(client, src, ops, page=2)
    assert [b["index"] for b in r1["boxes"]] == [0] and [b["index"] for b in r2["boxes"]] == [1, 2]
    assert r2["boxes"][1]["rect"] == [100, 100, 180, 160]


def test_flatten_makes_annotations_permanent(client, tmp_path):
    src, edited, flat = doc(tmp_path / "s.pdf", ("",)), tmp_path / "e.pdf", tmp_path / "f.pdf"
    save(client, src, [{"type": "rect", "page": 1, "x0": 20, "y0": 20, "x1": 120, "y1": 80, "color": "#0000ff", "fill": "#0000ff"}], edited)
    assert annots(edited) == ["Square"]
    job = post_job(client, "/pdf/flatten", {"input": str(edited), "output": str(flat)})
    assert job["state"] == "done" and annots(flat) == []
    with pymupdf.open(flat) as d:
        pix = d[0].get_pixmap()
        assert pix.pixel(60, 50)[2] > 200  # still drawn on the page
    save(client, src, [{"type": "rect", "page": 1, "x0": 20, "y0": 20, "x1": 120, "y1": 80, "fill": "#0000ff"}], tmp_path / "e2.pdf", flatten=True)
    assert annots(tmp_path / "e2.pdf") == []


# ---- headers, footers, page numbers ----------------------------------------------------------------


def test_page_numbers_and_headers(client, tmp_path):
    src, out = doc(tmp_path / "doc.pdf", ("a", "b", "c", "d")), tmp_path / "o.pdf"
    job = post_job(client, "/pdf/stamp", {
        "input": str(src), "output": str(out), "start_at": 5,
        "items": [{"position": "bottom-right", "text": "Page {n} of {total}"}, {"position": "top-left", "text": "{file} · REF-{n:04}"}],
    })
    assert job["state"] == "done" and job["result"]["stamped"] == 4
    with pymupdf.open(out) as d:
        t = [p.get_text() for p in d]
        assert "Page 5 of 8" in t[0] and "Page 8 of 8" in t[3] and "doc · REF-0006" in t[1]
        br = d[0].search_for("Page 5 of 8")[0]
        assert br.x1 > 340 and br.y0 > 250  # bottom-right corner
    only = tmp_path / "o2.pdf"
    post_job(client, "/pdf/stamp", {"input": str(src), "output": str(only), "pages": "2-3", "items": [{"text": "{n}"}]})
    with pymupdf.open(only) as d:
        assert [("2" in p.get_text() or "3" in p.get_text()) for p in d] == [False, True, True, False]
    assert post(client, "/pdf/stamp", {"input": str(src), "output": str(tmp_path / "x.pdf"), "items": []}).status_code == 422


@pytest.mark.parametrize("rot", [90, 180])
def test_page_numbers_are_upright_and_in_the_corner_on_rotated_pages(client, tmp_path, rot):
    src = doc(tmp_path / "r.pdf", ("",), rotate=rot)
    items = [{"position": "bottom-right", "text": "99"}]
    r = post(client, "/pdf/stamp-preview", {"input": str(src), "page": 1, "items": items, "width": 400, "size": 20}, 200).json()
    img = Image.open(io.BytesIO(base64.b64decode(r["image"]))).convert("RGB")
    x0, y0, x1, y1 = ink_bbox(img)
    assert r["stamped"] is True
    assert x0 > img.width * 0.75 and y0 > img.height * 0.8, "bottom-right of the displayed page"
    assert (x1 - x0) >= (y1 - y0) * 0.9, "digits read upright"


def test_stamp_preview_respects_the_page_selection(client, tmp_path):
    src = doc(tmp_path / "s.pdf")
    a = post(client, "/pdf/stamp-preview", {"input": str(src), "page": 1, "pages": "2-3", "items": [{"text": "X"}]}, 200).json()
    b = post(client, "/pdf/stamp-preview", {"input": str(src), "page": 2, "pages": "2-3", "items": [{"text": "X"}]}, 200).json()
    assert a["stamped"] is False and b["stamped"] is True


# ---- page geometry -----------------------------------------------------------------------------------


def test_crop_manual_and_auto(client, tmp_path):
    src = doc(tmp_path / "s.pdf", ("hello",))
    manual = tmp_path / "m.pdf"
    post_job(client, "/pdf/crop-pages", {"input": str(src), "output": str(manual), "left": 20, "top": 10, "right": 80, "bottom": 40})
    with pymupdf.open(manual) as d:
        assert (round(d[0].rect.width), round(d[0].rect.height)) == (300, 250)
    auto = tmp_path / "a.pdf"
    job = post_job(client, "/pdf/crop-pages", {"input": str(src), "output": str(auto), "auto": True, "padding": 10})
    assert job["result"]["cropped"] == 1
    with pymupdf.open(auto) as d:
        assert d[0].rect.width < 150 and d[0].rect.height < 60
        assert "hello" in d[0].get_text()
    rot = doc(tmp_path / "r.pdf", ("x",), rotate=90)
    out = tmp_path / "r2.pdf"
    post_job(client, "/pdf/crop-pages", {"input": str(rot), "output": str(out), "right": 100})
    with pymupdf.open(out) as d:  # the displayed page is 300 wide, so cutting 100 from the right leaves 200
        assert (round(d[0].rect.width), round(d[0].rect.height)) == (200, 400)
    too = post_job(client, "/pdf/crop-pages", {"input": str(src), "output": str(tmp_path / "t.pdf"), "left": 300, "right": 90})
    assert too["state"] == "failed" and "almost nothing" in too["error"]


def test_resize_to_paper_sizes(client, tmp_path):
    src = doc(tmp_path / "s.pdf", ("a", "b"), size=(400, 300))
    out = tmp_path / "o.pdf"
    post_job(client, "/pdf/resize-pages", {"input": str(src), "output": str(out), "size": "A4", "margin": 20})
    with pymupdf.open(out) as d:
        assert [(round(p.rect.width), round(p.rect.height)) for p in d] == [(842, 595)] * 2  # landscape source -> landscape A4
        assert "a" in d[0].get_text()


def test_insert_blank_and_from_another_pdf(client, tmp_path):
    src, other = doc(tmp_path / "s.pdf", ("one", "two", "three")), doc(tmp_path / "x.pdf", ("X1", "X2", "X3"))
    out = tmp_path / "o.pdf"
    job = post_job(client, "/pdf/insert", {"input": str(src), "output": str(out), "after": 1, "source": str(other), "source_pages": "2-3", "blank": 1})
    assert job["state"] == "done" and job["result"]["inserted"] == 3
    with pymupdf.open(out) as d:
        assert [p.get_text().strip() for p in d] == ["one", "X2", "X3", "", "two", "three"]
    start = tmp_path / "o2.pdf"
    post_job(client, "/pdf/insert", {"input": str(src), "output": str(start), "after": 0, "blank": 2, "size": "A4"})
    with pymupdf.open(start) as d:
        assert d.page_count == 5 and (round(d[0].rect.width), round(d[0].rect.height)) == (595, 842) and "one" in d[2].get_text()
    bad = post_job(client, "/pdf/insert", {"input": str(src), "output": str(tmp_path / "b.pdf"), "after": 9, "blank": 1})
    assert bad["state"] == "failed"
    assert post_job(client, "/pdf/insert", {"input": str(src), "output": str(tmp_path / "n.pdf")})["state"] == "failed"


def test_split_into_parts(client, tmp_path):
    src = doc(tmp_path / "book.pdf", [f"p{i}" for i in range(1, 6)])
    d = pymupdf.open(src)
    d.set_toc([[1, "Intro", 1], [1, "Part two", 3], [2, "Sub", 4], [1, "End", 5]])
    d.saveIncr()
    d.close()
    out = tmp_path / "parts"
    job = post_job(client, "/pdf/split-parts", {"input": str(src), "out_dir": str(out), "every": 2})
    assert job["result"]["count"] == 3
    assert [pymupdf.open(f).page_count for f in sorted(job["result"]["outputs"])] == [2, 2, 1]
    by_bm = post_job(client, "/pdf/split-parts", {"input": str(src), "out_dir": str(tmp_path / "bm"), "by_bookmarks": True})
    assert [pymupdf.open(f).page_count for f in sorted(by_bm["result"]["outputs"])] == [2, 2, 1]
    at = post_job(client, "/pdf/split-parts", {"input": str(src), "out_dir": str(tmp_path / "at"), "at": [2, 5]})
    assert [pymupdf.open(f).page_count for f in sorted(at["result"]["outputs"])] == [1, 3, 1]
    assert post_job(client, "/pdf/split-parts", {"input": str(src), "out_dir": str(tmp_path / "n")})["state"] == "failed"
    assert len([h for h in client.get("/history", headers=AUTH).json() if h["op"] == "create"]) >= 9


# ---- extracting and converting ------------------------------------------------------------------------


def test_extract_images_skips_tiny_and_duplicates(client, tmp_path):
    big, tiny = tmp_path / "big.png", tmp_path / "tiny.png"
    Image.new("RGB", (200, 150), (10, 120, 200)).save(big)
    Image.new("RGB", (10, 10), (200, 0, 0)).save(tiny)
    src = tmp_path / "s.pdf"
    d = pymupdf.open()
    for _ in range(2):
        p = d.new_page(width=400, height=300)
        p.insert_image(pymupdf.Rect(20, 20, 220, 170), filename=str(big))  # same image on two pages
        p.insert_image(pymupdf.Rect(300, 20, 320, 40), filename=str(tiny))
    d.save(str(src))
    job = post_job(client, "/pdf/extract-images", {"input": str(src), "out_dir": str(tmp_path / "img")})
    assert job["result"]["count"] == 1
    assert Image.open(job["result"]["outputs"][0]).size == (200, 150)
    assert post_job(client, "/pdf/extract-images", {"input": str(src), "out_dir": str(tmp_path / "i2"), "min_size": 500})["state"] == "failed"


def test_pdf_to_images_and_back(client, tmp_path):
    src = doc(tmp_path / "s.pdf", ("a", "b"), size=(300, 200))
    png = post_job(client, "/pdf/to-images", {"input": str(src), "out_dir": str(tmp_path / "png"), "dpi": 144, "pages": "2"})
    assert png["result"]["count"] == 1 and Image.open(png["result"]["outputs"][0]).size == (600, 400)
    jpg = post_job(client, "/pdf/to-images", {"input": str(src), "out_dir": str(tmp_path / "jpg"), "format": "jpg"})
    assert sorted(Path(p).suffix for p in jpg["result"]["outputs"]) == [".jpg", ".jpg"]
    back = tmp_path / "back.pdf"
    job = post_job(client, "/pdf/from-images", {"inputs": jpg["result"]["outputs"], "output": str(back), "page_size": "A4"})
    assert job["state"] == "done" and job["result"]["pages"] == 2
    with pymupdf.open(back) as d:
        assert (round(d[0].rect.width), round(d[0].rect.height)) == (842, 595)  # landscape images get landscape pages
    fit = tmp_path / "fit.pdf"
    post_job(client, "/pdf/from-images", {"inputs": [str(tmp_path / "png" / "s_page002.png")], "output": str(fit)})
    with pymupdf.open(fit) as d:
        assert round(d[0].rect.width) == round(600 * 72 / 150)


def test_extract_text_formats(client, tmp_path):
    src = doc(tmp_path / "s.pdf", ("first page text", "second page text"))
    txt = post_job(client, "/pdf/extract-text", {"input": str(src), "output": str(tmp_path / "o.txt")})
    assert "first page text" in (tmp_path / "o.txt").read_text(encoding="utf-8") and txt["result"]["words"] == 6
    post_job(client, "/pdf/extract-text", {"input": str(src), "output": str(tmp_path / "o.md"), "format": "md", "pages": "2"})
    assert (tmp_path / "o.md").read_text(encoding="utf-8").startswith("## Page 2")
    post_job(client, "/pdf/extract-text", {"input": str(src), "output": str(tmp_path / "o.json"), "format": "json"})
    assert [p["page"] for p in json.loads((tmp_path / "o.json").read_text(encoding="utf-8"))] == [1, 2]
    scan = tmp_path / "scan.pdf"
    d = pymupdf.open()
    d.new_page()
    d.save(str(scan))
    assert post_job(client, "/pdf/extract-text", {"input": str(scan), "output": str(tmp_path / "e.txt")})["state"] == "failed"


def test_grayscale_converts_embedded_images(client, tmp_path):
    img = tmp_path / "c.png"
    Image.new("RGB", (120, 80), (200, 30, 30)).save(img)
    src, out = tmp_path / "s.pdf", tmp_path / "g.pdf"
    d = pymupdf.open()
    d.new_page(width=300, height=200).insert_image(pymupdf.Rect(10, 10, 130, 90), filename=str(img))
    d.save(str(src))
    assert post_job(client, "/pdf/grayscale", {"input": str(src), "output": str(out)})["state"] == "done"
    with pymupdf.open(out) as dd:
        pix = dd[0].get_pixmap()
        r, g, b = pix.pixel(60, 50)[:3]
        assert abs(r - g) < 6 and abs(g - b) < 6


# ---- forms, properties, bookmarks ---------------------------------------------------------------------


def make_form(path: Path):
    d = pymupdf.open()
    p = d.new_page(width=400, height=300)
    for i, (name, typ) in enumerate((("full_name", pymupdf.PDF_WIDGET_TYPE_TEXT), ("agree", pymupdf.PDF_WIDGET_TYPE_CHECKBOX), ("country", pymupdf.PDF_WIDGET_TYPE_COMBOBOX))):
        w = pymupdf.Widget()
        w.field_name, w.field_type = name, typ
        w.rect = pymupdf.Rect(60, 40 + i * 40, 260, 62 + i * 40)
        if typ == pymupdf.PDF_WIDGET_TYPE_COMBOBOX:
            w.choice_values = ["Turkey", "Germany", "France"]
        p.add_widget(w)
    d.save(str(path))
    d.close()
    return path


def test_form_fields_are_listed_and_filled(client, tmp_path):
    src, out = make_form(tmp_path / "f.pdf"), tmp_path / "o.pdf"
    fields = post(client, "/pdf/forms/list", {"input": str(src)}, 200).json()["fields"]
    assert {f["name"]: f["type"] for f in fields} == {"full_name": "Text", "agree": "CheckBox", "country": "ComboBox"}
    assert [c for f in fields if f["name"] == "country" for c in f["choices"]] == ["Turkey", "Germany", "France"]
    job = post_job(client, "/pdf/forms/fill", {"input": str(src), "output": str(out), "values": {"full_name": "Çağrı Yılmaz", "agree": True, "country": "Turkey"}})
    assert job["state"] == "done" and job["result"]["filled"] == 3
    with pymupdf.open(out) as d:
        got = {w.field_name: w.field_value for w in d[0].widgets()}
        assert got["full_name"] == "Çağrı Yılmaz" and got["country"] == "Turkey" and got["agree"] not in ("Off", False, "")
    flat = tmp_path / "flat.pdf"
    post_job(client, "/pdf/forms/fill", {"input": str(src), "output": str(flat), "values": {"full_name": "Flat"}, "flatten": True})
    with pymupdf.open(flat) as d:
        assert not list(d[0].widgets() or []) and "Flat" in d[0].get_text()
    bad = post_job(client, "/pdf/forms/fill", {"input": str(src), "output": str(tmp_path / "b.pdf"), "values": {"nope": "x"}})
    assert bad["state"] == "failed" and "unknown form fields: nope" in bad["error"]


def test_properties_and_bookmarks(client, tmp_path):
    src, out = doc(tmp_path / "s.pdf", ("a", "b", "c", "d")), tmp_path / "o.pdf"
    got = post(client, "/pdf/props/get", {"input": str(src)}, 200).json()
    assert got["toc"] == [] and got["pages"] == 4 and set(got["metadata"]) >= {"title", "author"}
    toc = [[1, "Intro", 1], [2, "Details", 2], [1, "Outro", 4]]
    job = post_job(client, "/pdf/props/set", {"input": str(src), "output": str(out), "metadata": {"title": "Çok Önemli", "author": "Ayşe", "keywords": "a, b"}, "toc": toc})
    assert job["state"] == "done"
    back = post(client, "/pdf/props/get", {"input": str(out)}, 200).json()
    assert back["toc"] == toc and back["metadata"]["title"] == "Çok Önemli" and back["metadata"]["author"] == "Ayşe"
    deeper = post_job(client, "/pdf/props/set", {"input": str(src), "output": str(tmp_path / "d.pdf"), "toc": [[3, "Jumps levels", 1]]})
    assert deeper["state"] == "done"
    assert post(client, "/pdf/props/get", {"input": str(tmp_path / "d.pdf")}, 200).json()["toc"] == [[1, "Jumps levels", 1]]  # repaired, not rejected
    bad = post_job(client, "/pdf/props/set", {"input": str(src), "output": str(tmp_path / "x.pdf"), "toc": [[1, "Gone", 99]]})
    assert bad["state"] == "failed" and "page 99" in bad["error"]
