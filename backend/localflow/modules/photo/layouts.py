"""Ready-made outputs: social media sizes, passport photo sheets, collages, animated GIFs, panoramas, exposure merge."""
from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter, ImageOps

from ... import jobctl
from ..files.ops import unique_path
from .ops import _save, load_image, parse_color

SOCIAL = {
    "instagram_post": ("Instagram post (square)", 1080, 1080),
    "instagram_portrait": ("Instagram portrait 4:5", 1080, 1350),
    "instagram_story": ("Instagram or TikTok story 9:16", 1080, 1920),
    "facebook_cover": ("Facebook cover", 820, 312),
    "x_post": ("X (Twitter) post 16:9", 1600, 900),
    "x_header": ("X (Twitter) header", 1500, 500),
    "youtube_thumbnail": ("YouTube thumbnail", 1280, 720),
    "youtube_banner": ("YouTube channel banner", 2560, 1440),
    "linkedin_post": ("LinkedIn post", 1200, 627),
    "linkedin_cover": ("LinkedIn cover", 1584, 396),
    "whatsapp_profile": ("Profile picture (square)", 640, 640),
    "pinterest_pin": ("Pinterest pin 2:3", 1000, 1500),
}

PAPER_MM = {"10x15": (102.0, 152.0), "13x18": (127.0, 178.0), "A4": (210.0, 297.0), "A5": (148.0, 210.0)}
EXT = {"jpeg": ".jpg", "png": ".png", "webp": ".webp"}


def _cover(img: Image.Image, w: int, h: int, fx: float = 0.5, fy: float = 0.5) -> Image.Image:
    """Fill w x h completely, cutting what overflows (the focus point decides which part stays)."""
    scale = max(w / img.width, h / img.height)
    big = img.resize((max(w, round(img.width * scale)), max(h, round(img.height * scale))), Image.LANCZOS)
    x = round((big.width - w) * min(1, max(0, fx)))
    y = round((big.height - h) * min(1, max(0, fy)))
    return big.crop((x, y, x + w, y + h))


def _contain(img: Image.Image, w: int, h: int, bg: str) -> Image.Image:
    scale = min(w / img.width, h / img.height)
    small = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), parse_color(bg))
    canvas.alpha_composite(small, ((w - small.width) // 2, (h - small.height) // 2))
    return canvas


def social_export(path: str, out_dir: str, presets: list[str], mode: str = "fill", fmt: str = "jpeg", quality: int = 90, background: str = "#ffffff", fx: float = 0.5, fy: float = 0.5) -> dict:
    if not presets:
        raise ValueError("choose at least one size")
    bad = [p for p in presets if p not in SOCIAL]
    if bad:
        raise ValueError(f"unknown size '{bad[0]}'")
    if fmt not in EXT:
        raise ValueError("unsupported format")
    src = load_image(path)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    made = []
    for k, key in enumerate(presets):
        jobctl.check()
        jobctl.report(k, len(presets), SOCIAL[key][0])
        _label, w, h = SOCIAL[key]
        out = _cover(src, w, h, fx, fy) if mode == "fill" else _contain(src, w, h, background)
        dest = unique_path(Path(out_dir) / f"{Path(path).stem}_{key}{EXT[fmt]}")
        _save(out, dest, fmt, quality, background, True, None)
        made.append(str(dest))
    return {"outputs": made, "created": made, "count": len(made)}


def passport_sheet(path: str, output: str, photo_mm: tuple[float, float] = (35.0, 45.0), paper: str = "10x15", dpi: int = 300, gap_mm: float = 2.0, fy: float = 0.4, background: str = "#ffffff", count: int = 0) -> dict:
    """One photo cropped to the size, repeated to fill a print sheet (cut marks between them)."""
    if paper not in PAPER_MM:
        raise ValueError("unknown paper")
    pw, ph = photo_mm
    if not (10 <= pw <= 100 and 10 <= ph <= 100):
        raise ValueError("photo size must be between 10 and 100 mm")
    mm = dpi / 25.4
    sw, sh = round(PAPER_MM[paper][0] * mm), round(PAPER_MM[paper][1] * mm)
    # landscape sheet when it fits more photos
    def fits(w, h):
        return max(0, int((w + gap_mm * mm) // ((pw + gap_mm) * mm))) * max(0, int((h + gap_mm * mm) // ((ph + gap_mm) * mm)))

    if fits(sh, sw) > fits(sw, sh):
        sw, sh = sh, sw
    cw, ch = round(pw * mm), round(ph * mm)
    gap = round(gap_mm * mm)
    cols = max(1, (sw + gap) // (cw + gap))
    rows = max(1, (sh + gap) // (ch + gap))
    if cols * rows == 0 or cw > sw or ch > sh:
        raise ValueError("the photo does not fit on this paper")
    n = cols * rows if count <= 0 else min(count, cols * rows)
    photo = _cover(load_image(path), cw, ch, 0.5, fy)
    sheet = Image.new("RGBA", (sw, sh), parse_color(background))
    x0 = (sw - (cols * cw + (cols - 1) * gap)) // 2
    y0 = (sh - (rows * ch + (rows - 1) * gap)) // 2
    for i in range(n):
        r, c = divmod(i, cols)
        sheet.alpha_composite(photo, (x0 + c * (cw + gap), y0 + r * (ch + gap)))
    dest = Path(output)
    sheet.convert("RGB").save(dest, "JPEG" if dest.suffix.lower() in (".jpg", ".jpeg") else "PNG", dpi=(dpi, dpi), quality=95)
    return {"output": output, "photos": n, "columns": cols, "rows": rows, "width": sw, "height": sh}


def collage(inputs: list[str], output: str, cols: int = 0, cell: tuple[int, int] = (800, 800), gap: int = 12, background: str = "#ffffff", fill: bool = True) -> dict:
    if len(inputs) < 2:
        raise ValueError("choose at least two pictures")
    if len(inputs) > 36:
        raise ValueError("a collage takes up to 36 pictures")
    n = len(inputs)
    cols = cols if cols > 0 else math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    cw, ch = cell
    sheet = Image.new("RGBA", (cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap), parse_color(background))
    for i, f in enumerate(inputs):
        jobctl.check()
        jobctl.report(i, n, Path(f).name)
        img = load_image(f)
        tile = _cover(img, cw, ch) if fill else _contain(img, cw, ch, background)
        r, c = divmod(i, cols)
        sheet.alpha_composite(tile, (gap + c * (cw + gap), gap + r * (ch + gap)))
    dest = Path(output)
    fmt = "JPEG" if dest.suffix.lower() in (".jpg", ".jpeg") else "PNG"
    (sheet.convert("RGB") if fmt == "JPEG" else sheet).save(dest, fmt, **({"quality": 92} if fmt == "JPEG" else {}))
    return {"output": output, "width": sheet.width, "height": sheet.height, "pictures": n}


def make_animation(inputs: list[str], output: str, duration_ms: int = 500, loop: int = 0, max_side: int = 800) -> dict:
    """An animated GIF or WebP (by the file extension) from several pictures."""
    if len(inputs) < 2:
        raise ValueError("choose at least two pictures")
    dest = Path(output)
    if dest.suffix.lower() not in (".gif", ".webp"):
        raise ValueError("save as .gif or .webp")
    frames = []
    first_size = None
    for i, f in enumerate(inputs):
        jobctl.check()
        jobctl.report(i, len(inputs), Path(f).name)
        im = load_image(f)
        if max(im.size) > max_side:
            s = max_side / max(im.size)
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        if first_size is None:
            first_size = im.size
        else:
            im = _contain(im, first_size[0], first_size[1], "#ffffff")
        frames.append(im.convert("RGB"))
    if dest.suffix.lower() == ".gif":
        pal = [f.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE) for f in frames]
        pal[0].save(dest, "GIF", save_all=True, append_images=pal[1:], duration=duration_ms, loop=loop, disposal=2)
    else:
        frames[0].save(dest, "WEBP", save_all=True, append_images=frames[1:], duration=duration_ms, loop=loop, quality=85)
    return {"output": output, "frames": len(frames), "width": first_size[0], "height": first_size[1]}


def panorama(inputs: list[str], output: str, max_side: int = 3000) -> dict:
    if len(inputs) < 2:
        raise ValueError("choose at least two overlapping photos")
    imgs = []
    for i, f in enumerate(inputs):
        jobctl.check()
        jobctl.report(i, len(inputs), Path(f).name)
        arr = np.asarray(load_image(f).convert("RGB"))
        s = min(1.0, max_side / max(arr.shape[:2]))
        if s < 1:
            arr = cv2.resize(arr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        imgs.append(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
    status, pano = stitcher.stitch(imgs)
    if status != cv2.Stitcher_OK or pano is None:
        raise ValueError("the photos could not be joined: they need to overlap by about a third and be taken from one spot")
    Image.fromarray(cv2.cvtColor(pano, cv2.COLOR_BGR2RGB)).save(output, quality=93)
    return {"output": output, "width": pano.shape[1], "height": pano.shape[0]}


def exposure_merge(inputs: list[str], output: str) -> dict:
    """Blend photos of the same scene taken at different exposures into one balanced picture (HDR look)."""
    if len(inputs) < 2:
        raise ValueError("choose at least two photos of the same scene")
    imgs = []
    size = None
    for f in inputs:
        arr = np.asarray(load_image(f).convert("RGB"))
        if size is None:
            size = (arr.shape[1], arr.shape[0])
        elif (arr.shape[1], arr.shape[0]) != size:
            arr = cv2.resize(arr, size, interpolation=cv2.INTER_AREA)
        imgs.append(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    try:
        imgs_aligned = imgs
        align = cv2.createAlignMTB()
        align.process(imgs, imgs_aligned)
    except Exception:
        imgs_aligned = imgs
    fused = cv2.createMergeMertens().process(imgs_aligned)
    out = np.clip(fused * 255, 0, 255).astype(np.uint8)
    Image.fromarray(cv2.cvtColor(out, cv2.COLOR_BGR2RGB)).save(output, quality=94)
    return {"output": output, "width": out.shape[1], "height": out.shape[0], "photos": len(inputs)}


def basic_upscale(src: Path, dest: Path, scale: int) -> None:
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im).convert("RGBA")
        big = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
        rgb = big.convert("RGB").filter(ImageFilter.UnsharpMask(radius=1.4, percent=90, threshold=2))
        rgb.putalpha(big.getchannel("A"))
        rgb.save(dest, "PNG")
