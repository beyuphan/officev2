import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from test_api import AUTH, client, wait_job  # noqa: F401
from test_files import post, post_job


def make_image(path: Path, size=(400, 300), color=(200, 40, 40), mode="RGB", fmt=None):
    Image.new(mode, size, color).save(path, fmt)


def test_convert_images_resize_and_undo(client, tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    make_image(src / "a.png", (800, 600))
    make_image(src / "b.jpg", (300, 200))
    (src / "note.txt").write_text("not an image")
    (src / "broken.png").write_bytes(b"not really a png")
    out = tmp_path / "out"
    job = post_job(client, "/media/images", {"inputs": [str(src)], "out_dir": str(out), "format": "webp", "max_side": 400})
    assert job["state"] == "done", job
    res = job["result"]
    assert res["count"] == 2 and len(res["skipped"]) == 1 and res["skipped"][0]["path"].endswith("broken.png")
    with Image.open(out / "a.webp") as im:
        assert max(im.size) == 400
    with Image.open(out / "b.webp") as im:
        assert im.size == (300, 200)  # never upscaled
    assert (src / "a.png").exists()  # source untouched
    # outputs are logged for undo
    assert len([h for h in client.get("/history", headers=AUTH).json() if h["op"] == "create"]) == 2


def test_convert_images_strips_metadata_and_flattens_alpha(client, tmp_path):
    src, out = tmp_path / "in", tmp_path / "out"
    src.mkdir()
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    Image.new("RGB", (64, 64), (10, 20, 30)).save(src / "p.jpg", exif=exif)
    make_image(src / "t.png", (32, 32), (0, 0, 0, 0), mode="RGBA")
    job = post_job(client, "/media/images", {"inputs": [str(src)], "out_dir": str(out), "format": "jpeg"})
    assert job["state"] == "done", job
    with Image.open(out / "p.jpg") as im:
        assert 0x010F not in im.getexif()
    with Image.open(out / "t.jpg") as im:
        assert im.mode == "RGB" and im.getpixel((5, 5))[0] > 240  # transparent -> white


def test_media_rejects_missing_and_outside_paths(client, tmp_path):
    assert post(client, "/media/images", {"inputs": [str(tmp_path / "nope")], "out_dir": str(tmp_path)}).status_code == 404
    assert post(client, "/media/images", {"inputs": ["C:/Windows"], "out_dir": str(tmp_path)}).status_code == 403
    assert post(client, "/media/images", {"inputs": [str(tmp_path)], "out_dir": "C:/Windows/x"}).status_code == 403


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_convert_video(client, tmp_path):
    src, out = tmp_path / "in", tmp_path / "out"
    src.mkdir()
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", str(src / "clip.mp4")],
        check=True,
    )
    job = post_job(client, "/media/video", {"inputs": [str(src)], "out_dir": str(out), "crf": 35, "max_height": 120})
    assert job["state"] == "done", job
    assert job["result"]["count"] == 1
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0",
         str(out / "clip.mp4")], capture_output=True, text=True,
    ).stdout.strip()
    assert probe == "120"


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_video_failure_is_reported_not_crashing(client, tmp_path):
    src, out = tmp_path / "in", tmp_path / "out"
    src.mkdir()
    (src / "bad.mp4").write_bytes(b"this is not a video")
    job = post_job(client, "/media/video", {"inputs": [str(src)], "out_dir": str(out)})
    assert job["state"] == "done" and job["result"]["count"] == 0 and job["result"]["skipped"]
    assert not list(out.glob("*"))  # no partial file left behind


def test_models_registry_and_unknown(client):
    models = client.get("/models", headers=AUTH).json()
    ids = {m["id"] for m in models}
    assert {"realesrgan", "rembg-u2netp", "whisper-small", "embed-multilingual"} <= ids
    assert all(m["installed"] is False for m in models)
    assert client.post("/models/nope/install", headers=AUTH).status_code == 404
    assert client.delete("/models/nope", headers=AUTH).status_code == 404


@pytest.mark.network
def test_remove_background_downloads_model_on_first_use(client, tmp_path):
    src, out = tmp_path / "in", tmp_path / "out"
    src.mkdir()
    # white background with a red square subject
    im = Image.new("RGB", (320, 320), (255, 255, 255))
    im.paste((200, 30, 30), (90, 90, 230, 230))
    im.save(src / "subject.png")
    job = post_job(client, "/media/remove-background", {"inputs": [str(src)], "out_dir": str(out)})
    assert job["state"] == "done", job
    with Image.open(out / "subject.png") as res:
        assert res.mode == "RGBA"
        assert res.getpixel((5, 5))[3] < 30  # corner background removed
    listed = {m["id"]: m for m in client.get("/models", headers=AUTH).json()}
    assert listed["rembg-u2netp"]["installed"] and listed["rembg-u2netp"]["disk_bytes"] > 1_000_000
    assert client.delete("/models/rembg-u2netp", headers=AUTH).json() == {"removed": True}


def test_upscale_requires_explicit_install_of_the_binary(client, tmp_path):
    """Third-party executables are never downloaded implicitly."""
    src, out = tmp_path / "in", tmp_path / "out"
    src.mkdir()
    make_image(src / "small.png", (48, 32))
    job = post_job(client, "/media/upscale", {"inputs": [str(src)], "out_dir": str(out), "scale": 4})
    assert job["state"] == "failed" and "Install it from the Models screen" in job["error"]
    assert not (tmp_path / "_data" / "models" / "realesrgan").exists()
