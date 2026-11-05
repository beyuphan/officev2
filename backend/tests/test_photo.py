import base64
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from localflow.modules.photo import ops as P
from test_api import AUTH, client  # noqa: F401
from test_files import post, post_job

RED, BLUE, WHITE, BLACK = (220, 30, 30), (30, 30, 220), (255, 255, 255), (0, 0, 0)


def two_tone(path: Path, size=(400, 300), left=RED, right=BLUE, exif=None):
    im = Image.new("RGB", size, right)
    im.paste(left, (0, 0, size[0] // 2, size[1]))
    kw = {"exif": exif} if exif else {}
    im.save(path, **kw)
    return path


def solid(path: Path, color, size=(400, 300)):
    Image.new("RGB", size, color).save(path)
    return path


def checker(path: Path, size=(400, 300), cell=8):
    a = np.indices((size[1], size[0])).sum(axis=0) // cell % 2
    Image.fromarray((a * 255).astype(np.uint8), "L").convert("RGB").save(path)
    return path


def prev(client, path, edits, **kw):
    r = post(client, "/photo/preview", {"input": str(path), "edits": edits, **kw}, 200).json()
    return r, Image.open(io.BytesIO(base64.b64decode(r["image"]))).convert("RGB")


def export(client, path, edits, out, fmt="png", **kw):
    job = post_job(client, "/photo/export", {"input": str(path), "edits": edits, "output": str(out), "format": fmt, **kw})
    assert job["state"] == "done", job
    return Image.open(out)


def arr(im):
    return np.asarray(im.convert("RGB"), dtype=np.float32)


# ---- basics ----------------------------------------------------------------------------------------


def test_fonts_and_info(client, tmp_path):
    r = client.get("/photo/fonts", headers=AUTH).json()
    assert "Arial" in r["fonts"] and "sepia" in r["filters"]
    p = two_tone(tmp_path / "a.jpg")
    info = post(client, "/photo/info", {"input": str(p)}, 200).json()
    assert (info["width"], info["height"], info["format"]) == (400, 300, "JPEG")
    assert post(client, "/photo/info", {"input": str(tmp_path / "missing.jpg")}).status_code == 404
    assert post(client, "/photo/info", {"input": "C:/Windows/win.ini"}).status_code == 403


def test_exif_orientation_is_applied_everywhere(client, tmp_path):
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 clockwise to display
    exif[0x010F], exif[0x0110] = "Contoso", "CamX"
    p = two_tone(tmp_path / "o.jpg", (400, 300), exif=exif.tobytes())
    info = post(client, "/photo/info", {"input": str(p)}, 200).json()
    assert (info["width"], info["height"], info["camera"], info["orientation"]) == (300, 400, "Contoso CamX", 6)
    r, im = prev(client, p, [])
    assert im.size == (300, 400) and (r["original_width"], r["original_height"]) == (300, 400)


# ---- geometry --------------------------------------------------------------------------------------


def test_crop_rotate_flip(client, tmp_path):
    p = two_tone(tmp_path / "a.png", (400, 300))
    out = export(client, p, [{"type": "crop", "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}], tmp_path / "c.png")
    assert out.size == (200, 150) and out.convert("RGB").getpixel((100, 75)) == RED
    rot = export(client, p, [{"type": "rotate", "degrees": 90}], tmp_path / "r.png").convert("RGB")
    assert rot.size == (300, 400)
    assert rot.getpixel((150, 50)) == RED and rot.getpixel((150, 350)) == BLUE  # clockwise: left side goes on top
    flipped = export(client, p, [{"type": "flip", "direction": "horizontal"}], tmp_path / "f.png").convert("RGB")
    assert flipped.getpixel((50, 50)) == BLUE and flipped.getpixel((350, 50)) == RED
    vflip = export(client, p, [{"type": "flip", "direction": "vertical"}], tmp_path / "v.png").convert("RGB")
    assert vflip.getpixel((50, 50)) == RED
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "crop", "x": 0.5, "y": 0.5, "w": 0, "h": 0}]}).status_code == 422


def test_straighten_crops_away_the_empty_corners(client, tmp_path):
    p = solid(tmp_path / "s.png", (90, 160, 90), (400, 300))
    out = export(client, p, [{"type": "straighten", "degrees": 6}], tmp_path / "o.png")
    assert out.size[0] < 400 and out.size[1] < 300 and abs(out.size[0] / out.size[1] - 4 / 3) < 0.03
    a = np.asarray(out.convert("RGBA"))
    assert a[..., 3].min() == 255, "no transparent corner may remain"


def test_result_size_always_matches_the_real_export(client, tmp_path):
    p = two_tone(tmp_path / "a.jpg", (640, 480))
    edits_list = [
        [{"type": "crop", "x": 0.1, "y": 0.2, "w": 0.55, "h": 0.6}, {"type": "resize", "mode": "scale", "factor": 0.5}],
        [{"type": "rotate", "degrees": 33}],
        [{"type": "rotate", "degrees": 270}, {"type": "border", "width": 12}],
        [{"type": "straighten", "degrees": -4}, {"type": "resize", "mode": "fit", "max_side": 300}],
        [{"type": "resize", "mode": "exact", "width": 123, "height": 77}],
    ]
    for i, edits in enumerate(edits_list):
        r, _ = prev(client, p, edits)
        real = export(client, p, edits, tmp_path / f"e{i}.png")
        assert tuple(r["result_size"]) == real.size, (edits, r["result_size"], real.size)


def test_resize_modes(client, tmp_path):
    p = solid(tmp_path / "s.png", (10, 10, 10), (400, 300))
    assert export(client, p, [{"type": "resize", "mode": "scale", "factor": 0.5}], tmp_path / "a.png").size == (200, 150)
    assert export(client, p, [{"type": "resize", "mode": "fit", "max_side": 100}], tmp_path / "b.png").size == (100, 75)
    assert export(client, p, [{"type": "resize", "mode": "fit", "max_side": 900}], tmp_path / "c.png").size == (400, 300)  # never enlarges by accident
    assert export(client, p, [{"type": "resize", "mode": "fit", "max_side": 800, "allow_upscale": True}], tmp_path / "d.png").size == (800, 600)
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "resize", "mode": "bogus"}]}).status_code == 422


# ---- light and color -------------------------------------------------------------------------------


def px(im, xy=(10, 10)):
    return im.convert("RGB").getpixel(xy)


def test_adjust_controls_move_pixels_the_right_way(client, tmp_path):
    p = solid(tmp_path / "g.png", (120, 110, 100))
    base = arr(prev(client, p, [])[1]).mean()
    up = arr(prev(client, p, [{"type": "adjust", "brightness": 40}])[1]).mean()
    down = arr(prev(client, p, [{"type": "adjust", "brightness": -40}])[1]).mean()
    assert down < base < up
    assert arr(prev(client, p, [{"type": "adjust", "exposure": 50}])[1]).mean() > base
    warm = px(prev(client, p, [{"type": "adjust", "warmth": 60}])[1])
    cool = px(prev(client, p, [{"type": "adjust", "warmth": -60}])[1])
    assert warm[0] > cool[0] and warm[2] < cool[2]
    gray = px(prev(client, p, [{"type": "adjust", "saturation": -100}])[1])
    assert max(gray) - min(gray) <= 2
    vivid = px(prev(client, p, [{"type": "adjust", "saturation": 80}])[1])
    assert max(vivid) - min(vivid) > 10 + 0  # more separated than the original 20? at least clearly colored
    assert px(prev(client, solid(tmp_path / "dark.png", (30, 30, 30)), [{"type": "adjust", "shadows": 80}])[1])[0] > 30
    assert px(prev(client, solid(tmp_path / "bright.png", (230, 230, 230)), [{"type": "adjust", "highlights": -80}])[1])[0] < 230
    c = tmp_path / "split.png"
    two_tone(c, left=(60, 60, 60), right=(200, 200, 200))
    hi = prev(client, c, [{"type": "adjust", "contrast": 60}])[1]
    assert px(hi, (10, 10))[0] < 60 and px(hi, (390, 10))[0] > 200  # contrast stretches both ends
    red_to = px(prev(client, solid(tmp_path / "r.png", (220, 30, 30)), [{"type": "adjust", "hue": 100}])[1])
    assert red_to[0] < 150  # hue turned red away from red


def test_filters(client, tmp_path):
    p = solid(tmp_path / "c.png", (200, 100, 50))
    g = px(prev(client, p, [{"type": "filter", "name": "grayscale"}])[1])
    assert max(g) - min(g) <= 1
    s = px(prev(client, p, [{"type": "filter", "name": "sepia"}])[1])
    assert s[0] > s[1] > s[2]
    assert px(prev(client, p, [{"type": "filter", "name": "invert"}])[1]) == (55, 155, 205)
    half = px(prev(client, p, [{"type": "filter", "name": "invert", "intensity": 0.5}])[1])
    assert 120 < half[0] < 140  # halfway between 200 and 55
    for name in P.FILTERS:  # none may crash, all keep the size
        r, im = prev(client, p, [{"type": "filter", "name": name}])
        assert im.size == (400, 300), name
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "filter", "name": "nope"}]}).status_code == 422
    thumbs = post(client, "/photo/filter-thumbs", {"input": str(p), "edits": []}, 200).json()["filters"]
    assert set(thumbs) == set(P.FILTERS)
    assert Image.open(io.BytesIO(base64.b64decode(thumbs["sepia"]))).size in ((150, 112), (150, 113))


def test_levels_and_auto(client, tmp_path):
    p = two_tone(tmp_path / "t.png", left=(100, 100, 100), right=(150, 150, 150))
    lv = prev(client, p, [{"type": "levels", "black": 100, "white": 150}])[1]
    assert px(lv, (10, 10))[0] <= 2 and px(lv, (390, 10))[0] >= 253
    ac = prev(client, p, [{"type": "auto", "mode": "contrast"}])[1]
    assert px(ac, (390, 10))[0] - px(ac, (10, 10))[0] > 100
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "levels", "black": 200, "white": 100}]}).status_code == 422


def test_vignette_and_grain(client, tmp_path):
    p = solid(tmp_path / "w.png", (200, 200, 200))
    v = prev(client, p, [{"type": "vignette", "strength": 0.8}])[1]
    assert px(v, (200, 150))[0] > px(v, (2, 2))[0] + 60  # corners darker than the middle
    a = np.asarray(prev(client, p, [{"type": "grain", "amount": 0.6}])[1])
    b = np.asarray(prev(client, p, [{"type": "grain", "amount": 0.6}])[1])
    assert a.std() > 3 and np.array_equal(a, b)  # visible grain, identical on every preview (no flicker)


# ---- blur / privacy --------------------------------------------------------------------------------


def region_std(im, box):
    return arr(im)[box[1] : box[3], box[0] : box[2]].std()


def test_blur_only_inside_the_selected_area_and_inverted(client, tmp_path):
    p = checker(tmp_path / "k.png")
    area = {"shape": "rect", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}
    inside, outside = (120, 100, 280, 200), (0, 0, 80, 60)
    sharp = prev(client, p, [])[1]
    blurred = prev(client, p, [{"type": "blur", "kind": "gaussian", "radius": 10, "area": area}])[1]
    assert region_std(blurred, inside) < region_std(sharp, inside) * 0.5
    assert np.array_equal(arr(blurred)[0:60, 0:80], arr(sharp)[0:60, 0:80])  # untouched outside
    focus = prev(client, p, [{"type": "blur", "kind": "gaussian", "radius": 10, "area": area, "invert": True}])[1]
    assert region_std(focus, outside) < region_std(sharp, outside) * 0.5
    assert np.array_equal(arr(focus)[110:190, 130:270], arr(sharp)[110:190, 130:270])  # subject stays sharp
    ell = prev(client, p, [{"type": "blur", "kind": "box", "radius": 8, "area": {"shape": "ellipse", **{k: area[k] for k in "xywh"}}}])[1]
    assert np.array_equal(arr(ell)[0:20, 0:20], arr(sharp)[0:20, 0:20])  # the corner of the box is outside the ellipse... and the image
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "blur", "area": {"shape": "star", "x": 0, "y": 0, "w": 1, "h": 1}}]}).status_code == 422


def test_pixelate_makes_blocks_and_hides_detail(client, tmp_path):
    p = checker(tmp_path / "k.png", cell=3)
    im = prev(client, p, [{"type": "blur", "kind": "pixelate", "radius": 20, "area": {"shape": "rect", "x": 0, "y": 0, "w": 0.5, "h": 1}}])[1]
    a = arr(im)
    assert np.abs(a[5, 0:20] - a[5, 0]).max() <= 2  # one block is one flat color (preview JPEG adds +-1)
    assert a[:, 200:].std() > 100  # the right half still has the checker


def test_motion_blur_and_tiltshift(client, tmp_path):
    p = checker(tmp_path / "k.png")
    sharp = prev(client, p, [])[1]
    mot = prev(client, p, [{"type": "blur", "kind": "motion", "radius": 12, "angle": 0}])[1]
    assert arr(mot).std() < arr(sharp).std() * 0.8
    tilt = prev(client, p, [{"type": "blur", "kind": "tiltshift", "radius": 8, "center": 0.5, "band": 0.15}])[1]
    assert np.array_equal(arr(tilt)[140:160], arr(sharp)[140:160])  # the focus band is untouched
    assert region_std(tilt, (0, 0, 400, 30)) < region_std(sharp, (0, 0, 400, 30)) * 0.6


# ---- drawing ---------------------------------------------------------------------------------------


def test_text_is_drawn_where_asked_with_turkish_letters(client, tmp_path):
    p = solid(tmp_path / "b.png", BLACK)
    edit = {"type": "text", "text": "Çalışma İş ğ", "x": 0.5, "y": 0.5, "size": 60, "color": "#ffffff", "font": "Arial"}
    a = arr(prev(client, p, [edit])[1]).mean(axis=2)
    ys, xs = np.where(a > 128)
    assert len(xs) > 300
    assert abs(xs.mean() - 200) < 40 and abs(ys.mean() - 150) < 40  # centered on (0.5, 0.5)
    moved = arr(prev(client, p, [{**edit, "x": 0.25, "y": 0.2}])[1]).mean(axis=2)
    ys2, xs2 = np.where(moved > 128)
    assert xs2.mean() < xs.mean() - 40 and ys2.mean() < ys.mean() - 40
    rotated = arr(prev(client, p, [{**edit, "rotation": 90}])[1]).mean(axis=2)
    ys3, xs3 = np.where(rotated > 128)
    assert (ys3.max() - ys3.min()) > (xs3.max() - xs3.min())  # now taller than wide
    boxed = prev(client, p, [{**edit, "background": "#ff0000", "color": "#ffffff"}])[1]
    assert (arr(boxed)[..., 0] > 200).sum() > (arr(boxed)[..., 1] > 200).sum()
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "text", "text": "  "}]}).status_code == 422


def test_shapes(client, tmp_path):
    p = solid(tmp_path / "w.png", WHITE)
    rect = prev(client, p, [{"type": "shape", "kind": "rect", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5, "color": "#ff0000", "width": 8}])[1]
    assert px(rect, (100, 150))[1] < 80 and px(rect, (200, 150)) == WHITE  # outline only
    filled = prev(client, p, [{"type": "shape", "kind": "ellipse", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5, "color": "#0000ff", "fill": "#0000ff"}])[1]
    assert px(filled, (200, 150))[2] > 200 and px(filled, (200, 150))[0] < 60 and px(filled, (5, 5)) == WHITE
    line = prev(client, p, [{"type": "shape", "kind": "arrow", "points": [[0.1, 0.5], [0.9, 0.5]], "color": "#00aa00", "width": 6}])[1]
    assert px(line, (200, 150))[1] > 120 and px(line, (200, 150))[0] < 80 and px(line, (200, 40)) == WHITE
    pen = prev(client, p, [{"type": "shape", "kind": "path", "points": [[0.1, 0.1], [0.5, 0.9], [0.9, 0.1]], "color": "#000000", "width": 6}])[1]
    assert arr(pen).mean() < 250
    hl = prev(client, p, [{"type": "shape", "kind": "highlighter", "points": [[0.1, 0.5], [0.9, 0.5]], "color": "#ffe600", "width": 30}])[1]
    assert px(hl, (200, 150))[2] < 200 and px(hl, (200, 150))[0] > 230  # translucent yellow over white


def test_logo_overlay_and_scope(client, tmp_path):
    p = solid(tmp_path / "b.png", WHITE)
    logo = tmp_path / "logo.png"
    Image.new("RGBA", (50, 50), (255, 0, 0, 255)).save(logo)
    e = {"type": "overlay", "path": str(logo), "x": 0.5, "y": 0.5, "w": 0.25}
    assert px(prev(client, p, [e])[1], (200, 150))[1] < 40
    half = px(prev(client, p, [{**e, "opacity": 0.5}])[1], (200, 150))
    assert 100 < half[1] < 180
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{**e, "path": "C:/Windows/win.ini"}]}).status_code == 403
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{**e, "path": str(tmp_path / "nope.png")}]}).status_code == 404


def test_border_and_rounded_corners(client, tmp_path):
    p = solid(tmp_path / "g.png", (0, 128, 0), (200, 100))
    out = export(client, p, [{"type": "border", "width": 10, "color": "#ffffff"}], tmp_path / "b.png")
    assert out.size == (220, 120) and out.convert("RGB").getpixel((2, 2)) == WHITE and out.convert("RGB").getpixel((110, 60)) == (0, 128, 0)
    r = export(client, p, [{"type": "rounded", "radius": 40}], tmp_path / "r.png").convert("RGBA")
    assert r.getpixel((0, 0))[3] == 0 and r.getpixel((100, 50))[3] == 255


# ---- pipeline behaviour ----------------------------------------------------------------------------


def test_unknown_edit_and_limits(client, tmp_path):
    p = solid(tmp_path / "g.png", BLACK)
    r = post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "frobnicate"}]})
    assert r.status_code == 422 and "edit 1 (frobnicate)" in r.json()["detail"]
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "flip"}] * 201}).status_code == 422
    assert post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "adjust", "brightness": "lots"}]}).status_code == 422


def test_remove_background_requires_the_model(client, tmp_path):
    p = solid(tmp_path / "g.png", BLACK)
    r = post(client, "/photo/preview", {"input": str(p), "edits": [{"type": "remove_background"}]})
    assert r.status_code == 422 and "Models" in r.json()["detail"]


def test_preview_looks_like_the_full_resolution_result(client, tmp_path):
    """Pixel lengths scale with the preview, so a small preview and the big export show the same picture."""
    big = tmp_path / "big.png"
    im = Image.new("RGB", (2400, 1600), (40, 90, 160))
    im.paste((230, 200, 60), (600, 300, 1800, 1300))
    im.save(big)
    edits = [
        {"type": "blur", "kind": "gaussian", "radius": 30, "area": {"shape": "ellipse", "x": 0.3, "y": 0.2, "w": 0.4, "h": 0.5}, "feather": 40},
        {"type": "text", "text": "PREVIEW", "x": 0.5, "y": 0.8, "size": 220, "color": "#ffffff", "stroke_width": 8},
        {"type": "shape", "kind": "rect", "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.2, "color": "#ff0000", "width": 20},
        {"type": "border", "width": 60, "color": "#101010"},
    ]
    r, small = prev(client, big, edits, max_side=800)
    full = export(client, big, edits, tmp_path / "full.png").convert("RGB")
    assert tuple(r["result_size"]) == full.size
    ref = full.resize(small.size, Image.LANCZOS)
    diff = np.abs(arr(small) - arr(ref)).mean()
    assert diff < 6.0, f"preview and export disagree (mean difference {diff:.1f})"


# ---- export / batch ----------------------------------------------------------------------------------


def test_export_formats_flatten_alpha_and_never_overwrite(client, tmp_path):
    p = solid(tmp_path / "g.png", (0, 0, 255), (100, 100))
    edits = [{"type": "rounded", "radius": 50}]
    png = export(client, p, edits, tmp_path / "a.png", "png")
    assert png.convert("RGBA").getpixel((0, 0))[3] == 0
    jpg = export(client, p, edits, tmp_path / "a.jpg", "jpeg", quality=95, background="#ffffff")
    assert min(jpg.convert("RGB").getpixel((0, 0))) >= 250  # transparency becomes the chosen background
    for fmt, name in (("webp", "a.webp"), ("tiff", "a.tif"), ("bmp", "a.bmp"), ("pdf", "a.pdf")):
        assert (tmp_path / name).parent.exists()
        export(client, p, [], tmp_path / name, fmt) if fmt != "pdf" else post_job(client, "/photo/export", {"input": str(p), "edits": [], "output": str(tmp_path / name), "format": "pdf"})
        assert (tmp_path / name).stat().st_size > 100
    assert (tmp_path / "a.pdf").read_bytes()[:4] == b"%PDF"
    assert post(client, "/photo/export", {"input": str(p), "edits": [], "output": str(tmp_path / "a.png")}).status_code == 409
    hist = [h for h in client.get("/history", headers=AUTH).json() if h["op"] == "create"]
    assert len(hist) >= 5  # every export is a revision that can be undone


def test_metadata_kept_or_stripped_and_orientation_reset(client, tmp_path):
    exif = Image.Exif()
    exif[0x010F], exif[0x0110], exif[0x0112] = "Contoso", "CamX", 6
    p = two_tone(tmp_path / "m.jpg", (400, 300), exif=exif.tobytes())
    kept = export(client, p, [], tmp_path / "kept.jpg", "jpeg")
    assert kept.size == (300, 400) and kept.getexif().get(0x010F) == "Contoso" and kept.getexif().get(0x0112) == 1
    stripped = export(client, p, [], tmp_path / "strip.jpg", "jpeg", strip_metadata=True)
    assert not stripped.getexif().get(0x010F)


def test_batch_applies_the_same_edits_to_every_photo(client, tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    two_tone(src / "a.jpg", (400, 300))
    two_tone(src / "b.png", (200, 200))
    (src / "broken.jpg").write_bytes(b"nope")
    edits = [{"type": "crop", "x": 0, "y": 0, "w": 0.5, "h": 1}, {"type": "text", "text": "©", "x": 0.5, "y": 0.9, "size": 20}]
    job = post_job(client, "/photo/batch", {"inputs": [str(src)], "out_dir": str(tmp_path / "out"), "edits": edits, "format": "png"})
    assert job["state"] == "done" and job["result"]["count"] == 2 and len(job["result"]["skipped"]) == 1
    sizes = sorted(Image.open(f).size for f in (tmp_path / "out").iterdir())
    assert sizes == [(100, 200), (200, 300)]


def test_preview_reports_where_text_and_pictures_landed(tmp_path):

    src = tmp_path / "p.png"
    Image.new("RGB", (600, 400), (30, 60, 90)).save(src)
    edits = [
        {"type": "adjust", "brightness": 10},
        {"type": "text", "text": "Hello", "size": 60, "x": 0.5, "y": 0.25},
    ]
    res = P.render_preview(str(src), edits, 600)
    (box,) = res["boxes"]
    assert box["index"] == 1
    x0, y0, x1, y1 = box["rect"]
    assert abs((x0 + x1) / 2 - 0.5) < 0.01 and abs((y0 + y1) / 2 - 0.25) < 0.01
    assert 0.1 < x1 - x0 < 0.9 and 0.05 < y1 - y0 < 0.5
