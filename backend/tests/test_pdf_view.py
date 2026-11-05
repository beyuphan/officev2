import base64
import io
from pathlib import Path

import pymupdf
import pytest
from PIL import Image, ImageChops

from test_api import AUTH, client  # noqa: F401
from test_files import post, post_job


def make_doc(path: Path, pages: list[str], rotate_first: int = 0):
    doc = pymupdf.open()
    for t in pages:
        doc.new_page(width=400, height=300).insert_text((60, 120), t, fontsize=20)
    if rotate_first:
        doc[0].set_rotation(rotate_first)
    doc.save(str(path))
    doc.close()


def png(b64: str) -> Image.Image:
    raw = base64.b64decode(b64)
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    return Image.open(io.BytesIO(raw)).convert("RGB")


# ---- info / render / thumbnails ---------------------------------------------------------------


def test_info_and_render(client, tmp_path):
    f = tmp_path / "d.pdf"
    make_doc(f, ["one", "two", "three"])
    info = post(client, "/pdf/info", {"input": str(f)}, 200).json()
    assert info["pages"] == 3 and info["needs_password"] is False and (info["width"], info["height"]) == (400, 300)

    r = post(client, "/pdf/render", {"input": str(f), "page": 2, "width": 800}, 200).json()
    assert (r["page"], r["total"], r["width"], r["height"]) == (2, 3, 800, 600)
    assert r["page_width"] == 400 and png(r["image"]).size == (800, 600)
    assert post(client, "/pdf/render", {"input": str(f), "page": 9}).status_code == 422
    tiny = post(client, "/pdf/render", {"input": str(f), "page": 1, "width": 72}, 200).json()  # used for list thumbnails
    assert png(tiny["image"]).size == (72, 54)
    assert post(client, "/pdf/render", {"input": str(f), "page": 1, "width": 10}).status_code == 422


def test_thumbnails_are_chunked(client, tmp_path):
    f = tmp_path / "d.pdf"
    make_doc(f, [f"p{i}" for i in range(7)])
    first = post(client, "/pdf/thumbnails", {"input": str(f), "start": 1, "count": 5, "width": 100}, 200).json()
    assert first["total"] == 7 and [i["page"] for i in first["items"]] == [1, 2, 3, 4, 5]
    assert png(first["items"][0]["image"]).size == (100, 75)
    rest = post(client, "/pdf/thumbnails", {"input": str(f), "start": 6, "count": 5}, 200).json()
    assert [i["page"] for i in rest["items"]] == [6, 7]


def test_viewer_handles_encrypted_and_broken_files(client, tmp_path):
    f, enc = tmp_path / "d.pdf", tmp_path / "enc.pdf"
    make_doc(f, ["secret"])
    with pymupdf.open(f) as d:
        d.save(str(enc), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
    assert post(client, "/pdf/info", {"input": str(enc)}, 200).json()["needs_password"] is True
    assert post(client, "/pdf/render", {"input": str(enc)}).status_code == 423
    ok = post(client, "/pdf/render", {"input": str(enc), "password": "pw"}, 200).json()
    assert ok["total"] == 1
    assert post(client, "/pdf/render", {"input": str(enc), "password": "nope"}).status_code == 423
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a pdf at all")
    assert post(client, "/pdf/info", {"input": str(bad)}).status_code == 422
    assert post(client, "/pdf/render", {"input": "C:/Windows/x.pdf"}).status_code == 403


# ---- search ------------------------------------------------------------------------------------


def test_search_reports_pages_and_rectangles_that_cover_the_text(client, tmp_path):
    f = tmp_path / "d.pdf"
    make_doc(f, ["alpha Secret beta", "nothing here", "Secret again"])
    res = post(client, "/pdf/search", {"input": str(f), "terms": ["secret"]}, 200).json()
    assert res["total"] == 2 and [p["page"] for p in res["pages"]] == [1, 3]
    x0, y0, x1, y1 = res["pages"][0]["hits"][0]["rect"]
    # the rectangle sits where the word was drawn (baseline y=120, x starts after "alpha ")
    assert 60 < x0 < 120 and 90 < y0 < 120 < y1 < 135 and x1 > x0
    only_3 = post(client, "/pdf/search", {"input": str(f), "terms": ["Secret"], "pages": "3"}, 200).json()
    assert [p["page"] for p in only_3["pages"]] == [3]
    assert post(client, "/pdf/search", {"input": str(f), "terms": []}).status_code == 422


@pytest.mark.parametrize("rotation", [90, 180, 270])
def test_search_rect_matches_what_the_rendered_page_shows(client, tmp_path, rotation):
    """On rotated pages the displayed coordinates differ from the stored ones: the box must land on the ink."""
    f = tmp_path / "r.pdf"
    make_doc(f, ["XXXX target XXXX"], rotate_first=rotation)
    hit = post(client, "/pdf/search", {"input": str(f), "terms": ["target"]}, 200).json()["pages"][0]
    rend = post(client, "/pdf/render", {"input": str(f), "page": 1, "width": int(hit["width"])}, 200).json()
    img = png(rend["image"]).convert("L")
    x0, y0, x1, y1 = (int(round(v)) for v in hit["hits"][0]["rect"])
    box = img.crop((x0, y0, x1, y1))
    dark_in_box = sum(1 for v in box.getdata() if v < 128)
    outside = img.copy()
    outside.paste(255, (max(x0 - 2, 0), max(y0 - 2, 0), x1 + 2, y1 + 2))
    assert dark_in_box > 30, "the hit rectangle does not contain the word"
    # the other text ("XXXX") is elsewhere: ink exists outside the box too
    assert sum(1 for v in outside.getdata() if v < 128) > 30


# ---- redact: by area and by term -----------------------------------------------------------------


def test_redact_by_area_removes_only_that_area(client, tmp_path):
    f, out = tmp_path / "d.pdf", tmp_path / "r.pdf"
    make_doc(f, ["keep this line"])
    with pymupdf.open(f) as d:
        d[0].insert_text((60, 200), "remove this line", fontsize=20)
        d.saveIncr()
    hit = post(client, "/pdf/search", {"input": str(f), "terms": ["remove this"]}, 200).json()["pages"][0]["hits"][0]["rect"]
    pad = 2
    rect = {"page": 1, "x0": hit[0] - pad, "y0": hit[1] - pad, "x1": hit[2] + pad, "y1": hit[3] + pad}
    job = post_job(client, "/pdf/redact", {"input": str(f), "output": str(out), "rects": [rect]})
    assert job["state"] == "done" and job["result"]["redactions"] == 1
    with pymupdf.open(out) as d:
        text = d[0].get_text()
        assert "keep this line" in text and "remove this" not in text


def test_redact_area_on_rotated_page(client, tmp_path):
    f, out = tmp_path / "d.pdf", tmp_path / "r.pdf"
    make_doc(f, ["aaa SECRET bbb"], rotate_first=90)
    hit = post(client, "/pdf/search", {"input": str(f), "terms": ["SECRET"]}, 200).json()["pages"][0]["hits"][0]["rect"]
    rect = {"page": 1, "x0": hit[0], "y0": hit[1], "x1": hit[2], "y1": hit[3]}
    job = post_job(client, "/pdf/redact", {"input": str(f), "output": str(out), "rects": [rect]})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert "SECRET" not in d[0].get_text()


def test_redact_needs_something_to_remove(client, tmp_path):
    f = tmp_path / "d.pdf"
    make_doc(f, ["x"])
    assert post(client, "/pdf/redact", {"input": str(f), "output": str(tmp_path / "o.pdf")}).status_code == 422


# ---- organize with a per-page plan ---------------------------------------------------------------


def test_organize_plan_rotates_each_page_independently_even_duplicates(client, tmp_path):
    f, out = tmp_path / "d.pdf", tmp_path / "o.pdf"
    make_doc(f, ["one", "two", "three"])
    plan = [{"page": 3, "rotate": 0}, {"page": 1, "rotate": 90}, {"page": 1, "rotate": 270}, {"page": 2, "rotate": 180}]
    job = post_job(client, "/pdf/organize", {"input": str(f), "output": str(out), "plan": plan})
    assert job["state"] == "done" and job["result"]["pages"] == 4
    with pymupdf.open(out) as d:
        assert [p.get_text().strip() for p in d] == ["three", "one", "one", "two"]
        assert [p.rotation for p in d] == [0, 90, 270, 180]
    bad = post_job(client, "/pdf/organize", {"input": str(f), "output": str(tmp_path / "x.pdf"), "plan": [{"page": 9}]})
    assert bad["state"] == "failed" and "invalid page 9" in bad["error"]
    assert post(client, "/pdf/organize", {"input": str(f), "output": str(tmp_path / "y.pdf"), "plan": []}).status_code == 422


# ---- watermark preview -----------------------------------------------------------------------------


def test_watermark_preview_matches_selection_and_changes_the_page(client, tmp_path):
    f = tmp_path / "d.pdf"
    make_doc(f, ["one", "two", "three"])
    base = {"input": str(f), "kind": "text", "text": "DRAFT", "opacity": 0.5, "width": 400}
    plain = png(post(client, "/pdf/render", {"input": str(f), "page": 1, "width": 400}, 200).json()["image"])
    stamped = post(client, "/pdf/preview-watermark", {**base, "page": 1, "pages": "1-2"}, 200).json()
    assert stamped["stamped"] is True
    assert ImageChops.difference(plain, png(stamped["image"])).getbbox() is not None  # something was drawn
    skipped = post(client, "/pdf/preview-watermark", {**base, "page": 3, "pages": "1-2"}, 200).json()
    plain3 = png(post(client, "/pdf/render", {"input": str(f), "page": 3, "width": 400}, 200).json()["image"])
    assert skipped["stamped"] is False and ImageChops.difference(plain3, png(skipped["image"])).getbbox() is None
    assert post(client, "/pdf/preview-watermark", {**base, "text": " ", "page": 1}).status_code == 422
    # the original file is not modified by previews
    with pymupdf.open(f) as d:
        assert "DRAFT" not in d[0].get_text()


def test_watermark_preview_image_kind(client, tmp_path):
    f, logo = tmp_path / "d.pdf", tmp_path / "logo.png"
    make_doc(f, ["one"])
    Image.new("RGB", (40, 20), (200, 30, 30)).save(logo)
    res = post(client, "/pdf/preview-watermark", {"input": str(f), "kind": "image", "image": str(logo), "page": 1, "width": 400}, 200).json()
    assert res["stamped"] is True
    img = png(res["image"])
    r, g, b = img.getpixel((img.width - 60, img.height - 40))  # inside the bottom-right logo
    assert r > 150 and g < 80
