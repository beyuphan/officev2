import time

import pymupdf
import pytest
from fastapi.testclient import TestClient

from localflow.app import create_app
from localflow.config import DEFAULT_ORIGINS, Settings
from localflow.modules.pdf.ops import _unicode_font, parse_page_ranges

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        token=TOKEN,
        data_dir=tmp_path.resolve() / "_data",
        allowed_origins=DEFAULT_ORIGINS,
        allowed_roots=(tmp_path.resolve(),),
    )
    with TestClient(create_app(settings)) as c:
        yield c


def make_pdf(path, pages):
    doc = pymupdf.open()
    for i in range(pages):
        doc.new_page().insert_text((72, 72), f"page {i + 1}")
    doc.save(str(path))
    doc.close()


def wait_job(client, job_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.1)
    raise AssertionError("job timed out")


def test_requires_token(client):
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/health", headers=AUTH).status_code == 200


def test_foreign_origin_rejected(client):
    r = client.get("/health", headers={**AUTH, "Origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.get("/health", headers={**AUTH, "Origin": "tauri://localhost"})
    assert r.status_code == 200


def test_cors_preflight_for_ui_origin_only(client):
    ok = client.options(
        "/health",
        headers={
            "Origin": "http://tauri.localhost",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == "http://tauri.localhost"
    bad = client.options(
        "/health",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert bad.status_code in (400, 403)
    assert "access-control-allow-origin" not in bad.headers


def test_path_outside_allowed_roots_rejected(client, tmp_path):
    r = client.post(
        "/pdf/merge",
        headers=AUTH,
        json={"inputs": ["C:/Windows/a.pdf", "C:/Windows/b.pdf"], "output": str(tmp_path / "o.pdf")},
    )
    assert r.status_code == 403


def test_merge(client, tmp_path):
    a, b, out = tmp_path / "a.pdf", tmp_path / "b.pdf", tmp_path / "out.pdf"
    make_pdf(a, 2)
    make_pdf(b, 3)
    r = client.post("/pdf/merge", headers=AUTH, json={"inputs": [str(a), str(b)], "output": str(out)})
    assert r.status_code == 202
    job = wait_job(client, r.json()["id"])
    assert job["state"] == "done", job
    assert job["result"]["pages"] == 5
    with pymupdf.open(out) as doc:
        assert doc.page_count == 5


def test_split_and_no_overwrite(client, tmp_path):
    src, out = tmp_path / "src.pdf", tmp_path / "part.pdf"
    make_pdf(src, 5)
    body = {"input": str(src), "pages": "1-2,5", "output": str(out)}
    job = wait_job(client, client.post("/pdf/split", headers=AUTH, json=body).json()["id"])
    assert job["state"] == "done", job
    with pymupdf.open(out) as doc:
        assert doc.page_count == 3
    assert client.post("/pdf/split", headers=AUTH, json=body).status_code == 409


def test_split_bad_range_fails_job(client, tmp_path):
    src, out = tmp_path / "src.pdf", tmp_path / "part.pdf"
    make_pdf(src, 2)
    r = client.post("/pdf/split", headers=AUTH, json={"input": str(src), "pages": "9", "output": str(out)})
    job = wait_job(client, r.json()["id"])
    assert job["state"] == "failed"
    assert "invalid page range" in job["error"]


def test_job_history_and_undo(client, tmp_path):
    a, b, out = tmp_path / "a.pdf", tmp_path / "b.pdf", tmp_path / "out.pdf"
    make_pdf(a, 1)
    make_pdf(b, 1)
    job_id = client.post(
        "/pdf/merge", headers=AUTH, json={"inputs": [str(a), str(b)], "output": str(out)}
    ).json()["id"]
    assert wait_job(client, job_id)["state"] == "done"

    # persisted job history
    jobs = client.get("/jobs", headers=AUTH).json()
    assert jobs[0]["id"] == job_id and jobs[0]["state"] == "done"

    # undo log entry exists and undo moves the file to trash instead of deleting it
    hist = client.get("/history", headers=AUTH).json()
    assert len(hist) == 1 and hist[0]["op"] == "create" and hist[0]["destination"] == str(out)
    r = client.post(f"/history/{hist[0]['id']}/undo", headers=AUTH)
    assert r.status_code == 200
    assert not out.exists()
    assert (tmp_path / "_data" / "trash" / f"{hist[0]['id']}_out.pdf").exists()
    assert client.post(f"/history/{hist[0]['id']}/undo", headers=AUTH).status_code == 409


def test_settings_roundtrip(client):
    assert client.get("/settings", headers=AUTH).json() == {}
    client.put("/settings/theme", headers=AUTH, json={"value": {"mode": "dark"}})
    client.put("/settings/theme", headers=AUTH, json={"value": "light"})
    assert client.get("/settings", headers=AUTH).json() == {"theme": "light"}


def test_restart_marks_interrupted_jobs(tmp_path):
    from localflow.db import Database
    from localflow.history import History
    from localflow.jobs import JobManager

    db = Database(tmp_path / "x.db")
    db.execute("INSERT INTO jobs(id,type,state,created_at) VALUES ('j','t','running',1)")
    mgr = JobManager(db, History(db, tmp_path / "trash"))
    assert mgr.get("j")["state"] == "failed"
    mgr.shutdown()


def test_parse_page_ranges():
    assert parse_page_ranges("1-3,5", 5) == [0, 1, 2, 4]
    assert parse_page_ranges("4-", 5) == [3, 4]
    with pytest.raises(ValueError):
        parse_page_ranges("0", 5)


# ---- encryption / unlock / watermark / OCR -------------------------------------------------

def post_job(client, path, body):
    r = client.post(path, headers=AUTH, json=body)
    assert r.status_code == 202, r.text
    return wait_job(client, r.json()["id"], timeout=120)


def test_encrypt_then_unlock(client, tmp_path):
    src, enc, plain = tmp_path / "s.pdf", tmp_path / "enc.pdf", tmp_path / "plain.pdf"
    make_pdf(src, 2)
    job = post_job(client, "/pdf/encrypt", {"input": str(src), "output": str(enc), "password": "s3cret"})
    assert job["state"] == "done", job
    with pymupdf.open(enc) as d:
        assert d.needs_pass and d.authenticate("s3cret")

    bad = post_job(client, "/pdf/unlock", {"input": str(enc), "output": str(plain), "password": "nope"})
    assert bad["state"] == "failed" and "incorrect password" in bad["error"]
    assert "nope" not in str(bad)

    ok = post_job(client, "/pdf/unlock", {"input": str(enc), "output": str(plain), "password": "s3cret"})
    assert ok["state"] == "done", ok
    with pymupdf.open(plain) as d:
        assert not d.needs_pass and d.page_count == 2


def test_watermark_text_with_turkish_chars(client, tmp_path):
    src, out = tmp_path / "s.pdf", tmp_path / "wm.pdf"
    make_pdf(src, 3)
    job = post_job(
        client, "/pdf/watermark",
        {"input": str(src), "output": str(out), "kind": "text", "text": "GİZLİ ŞĞ", "pages": "1,3"},
    )
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert "GİZLİ" in d[0].get_text()
        assert "GİZLİ" not in d[1].get_text()
        assert "GİZLİ" in d[2].get_text()
        # rising to the right: direction vector has negative y component
        line = d[0].get_text("dict")["blocks"][-1]["lines"][0]
        assert line["dir"][1] < 0


def test_watermark_image(client, tmp_path):
    img, src, out = tmp_path / "logo.png", tmp_path / "s.pdf", tmp_path / "wm.pdf"
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 20), False)
    pix.set_rect(pix.irect, (200, 30, 30))
    pix.save(str(img))
    make_pdf(src, 1)
    job = post_job(client, "/pdf/watermark", {"input": str(src), "output": str(out), "kind": "image", "image": str(img)})
    assert job["state"] == "done", job
    with pymupdf.open(out) as d:
        assert len(d[0].get_images()) == 1


def test_watermark_validation(client, tmp_path):
    src = tmp_path / "s.pdf"
    make_pdf(src, 1)
    r = client.post("/pdf/watermark", headers=AUTH, json={"input": str(src), "output": str(tmp_path / "o.pdf"), "kind": "text"})
    assert r.status_code == 422


def _scanned_pdf(path, lines):
    """Image-only PDF: draw text with a Unicode font, rasterize, embed only the bitmap."""
    src = pymupdf.open()
    p = src.new_page(width=500, height=40 + 40 * len(lines))
    font = _unicode_font()
    tw = pymupdf.TextWriter(p.rect)
    for i, t in enumerate(lines):
        tw.append((30, 50 + i * 40), t, font=font, fontsize=24)
    tw.write_text(p)
    pix = p.get_pixmap(dpi=200)
    scan = pymupdf.open()
    sp = scan.new_page(width=p.rect.width, height=p.rect.height)
    sp.insert_image(sp.rect, pixmap=pix)
    scan.save(str(path))


@pytest.mark.parametrize("engine", ["rapidocr", "auto"])
def test_ocr_makes_scanned_pdf_searchable(client, tmp_path, engine):
    src, out = tmp_path / "scan.pdf", tmp_path / "ocr.pdf"
    _scanned_pdf(src, ["Invoice 2024 Total"])
    assert "Invoice" not in pymupdf.open(src)[0].get_text()

    job = post_job(client, "/pdf/ocr", {"input": str(src), "output": str(out), "engine": engine})
    assert job["state"] == "done", job
    assert job["result"]["words"] >= 3
    with pymupdf.open(out) as d:
        text = d[0].get_text()
        assert "Invoice" in text and "2024" in text
        assert len(d[0].get_images()) == 1  # original scan kept


def test_ocr_keeps_turkish_characters(client, tmp_path):
    from localflow.modules.pdf.ops import _windows_ocr_available

    if not _windows_ocr_available():
        pytest.skip("Windows OCR with a language pack is not available")
    src, out = tmp_path / "scan.pdf", tmp_path / "ocr.pdf"
    _scanned_pdf(src, ["Çalışma Öğrenci Şirket", "Güzel İstanbul ışığı"])
    job = post_job(client, "/pdf/ocr", {"input": str(src), "output": str(out), "engine": "windows"})
    assert job["state"] == "done", job
    assert job["result"]["engine"] == "windows"
    with pymupdf.open(out) as d:
        text = d[0].get_text()
        for word in ("Çalışma", "Öğrenci", "Şirket", "İstanbul"):
            assert word in text, text


def test_ocr_unknown_engine_rejected(client, tmp_path):
    src = tmp_path / "s.pdf"
    make_pdf(src, 1)
    r = client.post("/pdf/ocr", headers=AUTH, json={"input": str(src), "output": str(tmp_path / "o.pdf"), "engine": "x"})
    assert r.status_code == 422
