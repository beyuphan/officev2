"""Photo editing engine.

An edit is a list of operations (dicts) applied in order. Geometry is expressed in normalized
coordinates (0..1 of the image *at that step*) and lengths in pixels of the original image, so the
same list renders identically on a small preview and on the full-resolution file: every pixel
length is multiplied by `scale`, the preview-to-original ratio.
"""
from __future__ import annotations

import math
import os
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from ... import jobctl, models
from ...fonts import font_path
from ..files.ops import unique_path
from ..media.ops import IMAGE_EXTS, collect

MAX_OPS = 200
PREVIEW_CACHE = 4


# ---------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------


def _num(op: dict, key: str, default: float, lo: float | None = None, hi: float | None = None) -> float:
    raw = op.get(key, default)
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"'{key}' must be a number")
    if math.isnan(v) or math.isinf(v):
        raise ValueError(f"'{key}' must be a finite number")
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def parse_color(value: Any, opacity: float = 1.0) -> tuple[int, int, int, int]:
    """'#rgb', '#rrggbb', '#rrggbbaa' or [r,g,b(,a)] -> (r,g,b,a); `opacity` multiplies alpha."""
    if isinstance(value, (list, tuple)) and len(value) in (3, 4):
        parts = [int(max(0, min(255, v))) for v in value]
        if len(parts) == 3:
            parts.append(255)
    elif isinstance(value, str) and value.startswith("#") and len(value) in (4, 7, 9):
        h = value[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        try:
            parts = [int(h[i : i + 2], 16) for i in range(0, len(h), 2)]
        except ValueError:
            raise ValueError(f"invalid color '{value}'")
        if len(parts) == 3:
            parts.append(255)
    else:
        raise ValueError(f"invalid color '{value}'")
    r, g, b, a = parts
    return r, g, b, int(round(a * max(0.0, min(1.0, opacity))))


def _split(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    arr = np.asarray(img.convert("RGBA"), dtype=np.float32)
    return arr[..., :3].copy(), arr[..., 3].copy()


def _join(rgb: np.ndarray, alpha: np.ndarray) -> Image.Image:
    out = np.dstack([np.clip(rgb, 0, 255), np.clip(alpha, 0, 255)]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def _luma(x: np.ndarray) -> np.ndarray:
    return 0.299 * x[..., 0] + 0.587 * x[..., 1] + 0.114 * x[..., 2]


def _rgb_op(img: Image.Image, fn: Callable[[Image.Image], Image.Image]) -> Image.Image:
    """Run a PIL function on the RGB part and keep the original alpha."""
    rgba = img.convert("RGBA")
    out = fn(rgba.convert("RGB")).convert("RGBA")
    out.putalpha(rgba.getchannel("A"))
    return out


def _mask(area: dict | None, size: tuple[int, int], feather: float = 0.0, invert: bool = False) -> Image.Image | None:
    """Selection mask: white inside the region. None means the whole image."""
    if not area:
        return None
    w, h = size
    shape = area.get("shape", "rect")
    x0, y0 = float(area["x"]) * w, float(area["y"]) * h
    x1, y1 = x0 + float(area["w"]) * w, y0 + float(area["h"]) * h
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)
    if shape == "ellipse":
        d.ellipse((x0, y0, x1, y1), fill=255)
    elif shape == "rect":
        d.rectangle((x0, y0, x1, y1), fill=255)
    else:
        raise ValueError(f"unknown area shape '{shape}'")
    if feather > 0.5:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return ImageOps.invert(mask) if invert else mask


def _composite(base: Image.Image, changed: Image.Image, mask: Image.Image | None) -> Image.Image:
    return changed if mask is None else Image.composite(changed, base, mask)


# ---------------------------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------------------------


def _crop_box(op: dict, size: tuple[int, int]) -> tuple[int, int, int, int]:
    w, h = size
    x, y = _num(op, "x", 0, 0, 1), _num(op, "y", 0, 0, 1)
    cw, ch = _num(op, "w", 1, 0, 1), _num(op, "h", 1, 0, 1)
    x0, y0 = int(round(x * w)), int(round(y * h))
    x1, y1 = min(w, int(round((x + cw) * w))), min(h, int(round((y + ch) * h)))
    if x1 - x0 < 1 or y1 - y0 < 1:
        raise ValueError("the crop area is empty")
    return x0, y0, x1, y1


def _rotate_size(size: tuple[int, int], deg: float) -> tuple[int, int]:
    """Output size of Image.rotate(-deg, expand=True), computed the way Pillow does it."""
    w, h = size
    if deg % 90 == 0:
        return (h, w) if int(deg) % 180 else (w, h)
    a = math.radians(deg)  # Pillow negates the (already negated) angle
    cos, sin = round(math.cos(a), 15), round(math.sin(a), 15)
    cx, cy = w / 2, h / 2
    tx = lambda x, y: (cos * x + sin * y, -sin * x + cos * y)  # noqa: E731
    ox, oy = tx(-cx, -cy)
    xs, ys = [], []
    for x, y in ((0, 0), (w, 0), (w, h), (0, h)):
        px, py = tx(x, y)
        xs.append(px + ox + cx)
        ys.append(py + oy + cy)
    return math.ceil(max(xs)) - math.floor(min(xs)), math.ceil(max(ys)) - math.floor(min(ys))


def _inscribed(w: int, h: int, rad: float) -> tuple[int, int]:
    """Largest centered rectangle with the original aspect ratio that fits inside the rotated image."""
    c, sn = abs(math.cos(rad)), abs(math.sin(rad))
    k = min(1.0 / (c + (h / w) * sn), 1.0 / ((w / h) * sn + c))
    return max(1, int(w * k)), max(1, int(h * k))


def _op_rotate(img: Image.Image, op: dict, scale: float) -> Image.Image:
    deg = _num(op, "degrees", 0, -360, 360)
    if deg % 360 == 0:
        return img
    if deg % 90 == 0:  # lossless; positive = clockwise
        return img.transpose({90: Image.ROTATE_270, 180: Image.ROTATE_180, 270: Image.ROTATE_90}[int(deg) % 360])
    return img.rotate(-deg, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0))


def _op_straighten(img: Image.Image, op: dict, scale: float) -> Image.Image:
    """Level a tilted horizon and crop away the empty corners."""
    deg = _num(op, "degrees", 0, -45, 45)
    if abs(deg) < 0.01:
        return img
    w, h = img.size
    rotated = img.rotate(-deg, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0))
    cw, ch = _inscribed(w, h, math.radians(abs(deg)))
    rw, rh = rotated.size
    x0, y0 = (rw - cw) // 2, (rh - ch) // 2
    return rotated.crop((x0, y0, x0 + cw, y0 + ch))


def _resize_target(op: dict, size: tuple[int, int], scale: float) -> tuple[int, int]:
    w, h = size
    mode = op.get("mode", "scale")
    if mode == "scale":
        f = _num(op, "factor", 1.0, 0.01, 16)
        return max(1, round(w * f)), max(1, round(h * f))
    if mode == "fit":
        target = _num(op, "max_side", 2048, 16, 32000) * scale
        long_side = max(w, h)
        if target >= long_side and not op.get("allow_upscale"):
            return w, h
        f = target / long_side
        return max(1, round(w * f)), max(1, round(h * f))
    if mode == "exact":
        return max(1, round(_num(op, "width", w / scale, 1, 32000) * scale)), max(1, round(_num(op, "height", h / scale, 1, 32000) * scale))
    raise ValueError(f"unknown resize mode '{mode}'")


def _op_resize(img: Image.Image, op: dict, scale: float) -> Image.Image:
    target = _resize_target(op, img.size, scale)
    return img if target == img.size else img.resize(target, Image.LANCZOS)


def _border_px(op: dict, scale: float) -> int:
    return int(round(_num(op, "width", 20, 0, 2000) * scale))


def _op_border(img: Image.Image, op: dict, scale: float) -> Image.Image:
    b = _border_px(op, scale)
    if b == 0:
        return img
    color = parse_color(op.get("color", "#ffffff"), _num(op, "opacity", 1, 0, 1))
    out = Image.new("RGBA", (img.width + 2 * b, img.height + 2 * b), color)
    out.alpha_composite(img.convert("RGBA"), (b, b))
    return out


def output_size(size: tuple[int, int], ops: list[dict], scale: float = 1.0) -> tuple[int, int]:
    """Size of the result without rendering it (geometry operations only)."""
    w, h = size
    for op in ops:
        t = op.get("type")
        if t == "crop":
            x0, y0, x1, y1 = _crop_box(op, (w, h))
            w, h = x1 - x0, y1 - y0
        elif t == "rotate":
            deg = _num(op, "degrees", 0, -360, 360)
            if deg % 360:
                w, h = _rotate_size((w, h), deg)
        elif t == "straighten":
            deg = _num(op, "degrees", 0, -45, 45)
            if abs(deg) >= 0.01:
                w, h = _inscribed(w, h, math.radians(abs(deg)))
        elif t == "resize":
            w, h = _resize_target(op, (w, h), scale)
        elif t == "border":
            b = _border_px(op, scale)
            w, h = w + 2 * b, h + 2 * b
    return w, h


# ---------------------------------------------------------------------------------------------
# light and color
# ---------------------------------------------------------------------------------------------


def _op_adjust(img: Image.Image, op: dict, scale: float) -> Image.Image:
    rgb, alpha = _split(img)
    x = rgb / 255.0
    v = lambda k: _num(op, k, 0, -100, 100)  # noqa: E731
    if v("exposure"):
        x = x * (2.0 ** (v("exposure") / 60.0))
    if v("brightness"):
        x = x + v("brightness") / 200.0
    if v("contrast"):
        x = (x - 0.5) * (1.0 + v("contrast") / 100.0) + 0.5
    lum = np.clip(_luma(x), 0, 1)[..., None]
    if v("shadows"):
        x = x + (v("shadows") / 100.0) * 0.35 * (1 - lum) ** 2
    if v("highlights"):
        x = x + (v("highlights") / 100.0) * 0.35 * lum**2
    if v("warmth"):
        x[..., 0] += v("warmth") / 100.0 * 0.12
        x[..., 2] -= v("warmth") / 100.0 * 0.12
    if v("tint"):
        x[..., 1] -= v("tint") / 100.0 * 0.08
    x = np.clip(x, 0, 1)
    if v("hue"):
        hsv = cv2.cvtColor((x * 255).astype(np.uint8), cv2.COLOR_RGB2HSV)
        hsv[..., 0] = (hsv[..., 0].astype(np.int32) + int(v("hue") * 0.9)) % 180
        x = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB).astype(np.float32) / 255.0
    gray = np.clip(_luma(x), 0, 1)[..., None]
    if v("saturation"):
        x = gray + (x - gray) * (1.0 + v("saturation") / 100.0)
    if v("vibrance"):
        chroma = (x.max(axis=2) - x.min(axis=2))[..., None]
        x = gray + (x - gray) * (1.0 + (v("vibrance") / 100.0) * (1.0 - np.clip(chroma, 0, 1)))
    out = _join(np.clip(x, 0, 1) * 255.0, alpha)
    sharp = v("sharpness")
    if sharp > 0:
        out = _rgb_op(out, lambda im: im.filter(ImageFilter.UnsharpMask(radius=max(1.0, 2 * scale), percent=int(sharp * 2.5), threshold=2)))
    elif sharp < 0:
        out = _rgb_op(out, lambda im: im.filter(ImageFilter.GaussianBlur(abs(sharp) / 40.0 * max(1.0, scale))))
    return out


def _op_levels(img: Image.Image, op: dict, scale: float) -> Image.Image:
    black, white = _num(op, "black", 0, 0, 254), _num(op, "white", 255, 1, 255)
    gamma = _num(op, "gamma", 1.0, 0.1, 5.0)
    if white <= black:
        raise ValueError("levels: white must be above black")
    rgb, alpha = _split(img)
    x = np.clip((rgb - black) / (white - black), 0, 1) ** (1.0 / gamma)
    return _join(x * 255.0, alpha)


def _vignette_arr(shape: tuple[int, int], strength: float) -> np.ndarray:
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / math.sqrt(2)
    t = np.clip((d - 0.3) / 0.7, 0, 1)
    return 1.0 - strength * (t * t * (3 - 2 * t))  # smoothstep falloff


def _op_vignette(img: Image.Image, op: dict, scale: float) -> Image.Image:
    rgb, alpha = _split(img)
    return _join(rgb * _vignette_arr(rgb.shape[:2], _num(op, "strength", 0.5, 0, 1))[..., None], alpha)


def _op_grain(img: Image.Image, op: dict, scale: float) -> Image.Image:
    rgb, alpha = _split(img)
    noise = np.random.default_rng(1234).normal(0, _num(op, "amount", 0.3, 0, 1) * 28.0, rgb.shape[:2]).astype(np.float32)
    return _join(rgb + noise[..., None], alpha)


def _sepia(rgb: np.ndarray) -> np.ndarray:
    m = np.array([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]], dtype=np.float32)
    return rgb @ m.T


FILTERS = [
    "grayscale", "sepia", "noir", "vintage", "fade", "warm", "cool", "vivid", "dramatic",
    "invert", "posterize", "solarize", "emboss", "edges", "sketch", "sharpen", "soften",
]


def _apply_filter(img: Image.Image, name: str, scale: float) -> Image.Image:
    rgb, alpha = _split(img)
    if name == "grayscale":
        g = _luma(rgb)[..., None]
        return _join(np.repeat(g, 3, axis=2), alpha)
    if name == "sepia":
        return _join(_sepia(rgb), alpha)
    if name == "invert":
        return _join(255 - rgb, alpha)
    if name == "noir":
        g = _luma(rgb)[..., None]
        g = (g / 255.0 - 0.5) * 1.5 + 0.5
        g = g * _vignette_arr(rgb.shape[:2], 0.35)[..., None]
        return _join(np.repeat(np.clip(g, 0, 1), 3, axis=2) * 255.0, alpha)
    if name == "vintage":
        x = (_sepia(rgb) * 0.65 + rgb * 0.35) / 255.0
        x = x * 0.82 + 0.1
        x[..., 0] += 0.03
        x = x * _vignette_arr(rgb.shape[:2], 0.35)[..., None]
        return _join(np.clip(x, 0, 1) * 255.0, alpha)
    if name == "fade":
        x = rgb / 255.0
        g = _luma(x)[..., None]
        x = g + (x - g) * 0.75
        return _join((x * 0.86 + 0.09) * 255.0, alpha)
    if name in ("warm", "cool"):
        k = 1 if name == "warm" else -1
        out = rgb.copy()
        out[..., 0] += 18 * k
        out[..., 1] += 4 * k
        out[..., 2] -= 18 * k
        return _join(out, alpha)
    if name == "vivid":
        x = rgb / 255.0
        g = _luma(x)[..., None]
        x = (g + (x - g) * 1.4 - 0.5) * 1.1 + 0.5
        return _join(np.clip(x, 0, 1) * 255.0, alpha)
    if name == "dramatic":
        x = rgb / 255.0
        g = _luma(x)[..., None]
        x = (g + (x - g) * 0.8 - 0.5) * 1.35 + 0.5
        x = x * _vignette_arr(rgb.shape[:2], 0.4)[..., None]
        return _join(np.clip(x, 0, 1) * 255.0, alpha)
    if name == "posterize":
        return _rgb_op(img, lambda im: ImageOps.posterize(im, 3))
    if name == "solarize":
        return _rgb_op(img, lambda im: ImageOps.solarize(im, 128))
    if name == "emboss":
        return _rgb_op(img, lambda im: im.filter(ImageFilter.EMBOSS))
    if name == "edges":
        return _rgb_op(img, lambda im: im.filter(ImageFilter.FIND_EDGES))
    if name == "sketch":
        return _rgb_op(img, lambda im: ImageOps.invert(im.convert("L").filter(ImageFilter.FIND_EDGES)).point(lambda p: min(255, p * 1.15)).convert("RGB"))
    if name == "sharpen":
        return _rgb_op(img, lambda im: im.filter(ImageFilter.UnsharpMask(radius=max(1.0, 2 * scale), percent=180, threshold=2)))
    if name == "soften":
        return _rgb_op(img, lambda im: im.filter(ImageFilter.GaussianBlur(max(0.8, 1.4 * scale))))
    raise ValueError(f"unknown filter '{name}'")


def _op_filter(img: Image.Image, op: dict, scale: float) -> Image.Image:
    filtered = _apply_filter(img, str(op.get("name")), scale)
    k = _num(op, "intensity", 1.0, 0, 1)
    return filtered if k >= 0.999 else Image.blend(img.convert("RGBA"), filtered, k)


def _op_auto(img: Image.Image, op: dict, scale: float) -> Image.Image:
    mode = op.get("mode", "contrast")
    if mode == "contrast":
        return _rgb_op(img, lambda im: ImageOps.autocontrast(im, cutoff=1))
    if mode == "equalize":
        return _rgb_op(img, lambda im: ImageOps.equalize(im))
    if mode == "enhance":
        return _rgb_op(img, lambda im: ImageEnhance.Color(ImageOps.autocontrast(im, cutoff=1)).enhance(1.12))
    raise ValueError(f"unknown auto mode '{mode}'")


# ---------------------------------------------------------------------------------------------
# blur, pixelate, focus
# ---------------------------------------------------------------------------------------------


def _motion_blur(img: Image.Image, length: int, angle: float) -> Image.Image:
    k = max(3, length | 1)
    kernel = np.zeros((k, k), np.float32)
    c = k // 2
    dx, dy = math.cos(math.radians(angle)) * c, -math.sin(math.radians(angle)) * c
    cv2.line(kernel, (int(round(c - dx)), int(round(c - dy))), (int(round(c + dx)), int(round(c + dy))), 1.0, 1)
    kernel /= kernel.sum()
    arr = np.asarray(img.convert("RGBA"))
    return Image.fromarray(cv2.filter2D(arr, -1, kernel, borderType=cv2.BORDER_REFLECT), "RGBA")


def _pixelate(img: Image.Image, block: int) -> Image.Image:
    w, h = img.size
    b = max(2, block)
    small = img.resize((max(1, w // b), max(1, h // b)), Image.BOX)
    return small.resize((w, h), Image.NEAREST)


def _op_blur(img: Image.Image, op: dict, scale: float) -> Image.Image:
    kind = op.get("kind", "gaussian")
    radius = _num(op, "radius", 12, 0.5, 400) * scale
    base = img.convert("RGBA")
    if kind == "gaussian":
        changed = base.filter(ImageFilter.GaussianBlur(radius))
    elif kind == "box":
        changed = base.filter(ImageFilter.BoxBlur(radius))
    elif kind == "motion":
        changed = _motion_blur(base, int(radius * 2), _num(op, "angle", 0, -180, 180))
    elif kind in ("pixelate", "mosaic"):
        changed = _pixelate(base, int(radius))
    elif kind == "tiltshift":
        w, h = base.size
        band = _num(op, "band", 0.18, 0.02, 0.9)
        center = _num(op, "center", 0.5, 0, 1)
        y = (np.arange(h, dtype=np.float32) / max(h - 1, 1))
        ramp = np.clip((np.abs(y - center) - band) / max(band, 0.05), 0, 1)
        gradient = Image.fromarray((np.repeat(ramp[:, None], w, axis=1) * 255).astype(np.uint8), "L")
        return Image.composite(base.filter(ImageFilter.GaussianBlur(radius)), base, gradient)
    else:
        raise ValueError(f"unknown blur kind '{kind}'")
    mask = _mask(op.get("area"), base.size, _num(op, "feather", 0, 0, 400) * scale, bool(op.get("invert")))
    return _composite(base, changed, mask)


# ---------------------------------------------------------------------------------------------
# drawing: text, shapes, logos
# ---------------------------------------------------------------------------------------------


def _font(op: dict, size_px: float) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = font_path(str(op.get("font", "Arial")), bool(op.get("bold")), bool(op.get("italic")))
    try:
        return ImageFont.truetype(path, max(4, int(round(size_px)))) if path else ImageFont.load_default(max(4, int(size_px)))
    except OSError:
        return ImageFont.load_default(max(4, int(size_px)))


def _composite_tile(base: Image.Image, tile: Image.Image, left: int, top: int) -> Image.Image:
    """Alpha-composite `tile` onto `base` at (left, top); parts outside the image are clipped."""
    out = base.convert("RGBA")
    x0, y0 = max(left, 0), max(top, 0)
    x1, y1 = min(left + tile.width, base.width), min(top + tile.height, base.height)
    if x1 <= x0 or y1 <= y0:
        return out
    out.alpha_composite(tile.crop((x0 - left, y0 - top, x1 - left, y1 - top)), (x0, y0))
    return out


def _op_text(img: Image.Image, op: dict, scale: float) -> Image.Image:
    text = str(op.get("text", ""))
    if not text.strip():
        raise ValueError("text is empty")
    if len(text) > 2000:
        raise ValueError("text is too long")
    size = _num(op, "size", 48, 4, 2000) * scale
    opacity = _num(op, "opacity", 1, 0, 1)
    font = _font(op, size)
    fill = parse_color(op.get("color", "#ffffff"), opacity)
    stroke_w = int(round(_num(op, "stroke_width", 0, 0, 100) * scale))
    stroke_fill = parse_color(op.get("stroke_color", "#000000"), opacity)
    align = op.get("align", "center")
    d = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    box = d.multiline_textbbox((0, 0), text, font=font, align=align, stroke_width=stroke_w)
    pad = int(round(size * 0.25)) if op.get("background") else int(round(size * 0.1)) + stroke_w + 2
    tile = Image.new("RGBA", (box[2] - box[0] + 2 * pad, box[3] - box[1] + 2 * pad), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)
    if op.get("background"):
        td.rounded_rectangle((0, 0, tile.width - 1, tile.height - 1), radius=int(size * 0.2), fill=parse_color(op["background"], opacity))
    origin = (pad - box[0], pad - box[1])
    if op.get("shadow"):
        off = max(1, int(size * 0.06))
        td.multiline_text((origin[0] + off, origin[1] + off), text, font=font, fill=(0, 0, 0, int(150 * opacity)), align=align, stroke_width=stroke_w)
    td.multiline_text(origin, text, font=font, fill=fill, align=align, stroke_width=stroke_w, stroke_fill=stroke_fill)
    rot = _num(op, "rotation", 0, -360, 360)
    if rot:
        tile = tile.rotate(-rot, resample=Image.BICUBIC, expand=True)
    cx, cy = _num(op, "x", 0.5, -1, 2) * img.width, _num(op, "y", 0.5, -1, 2) * img.height
    return _composite_tile(img, tile, int(round(cx - tile.width / 2)), int(round(cy - tile.height / 2)))


def _supersampled(img: Image.Image, draw: Callable[[ImageDraw.ImageDraw, float], None]) -> Image.Image:
    f = 2 if img.width * img.height <= 6_000_000 else 1
    layer = Image.new("RGBA", (img.width * f, img.height * f), (0, 0, 0, 0))
    draw(ImageDraw.Draw(layer), float(f))
    if f > 1:
        layer = layer.resize(img.size, Image.LANCZOS)
    return Image.alpha_composite(img.convert("RGBA"), layer)


def _op_shape(img: Image.Image, op: dict, scale: float) -> Image.Image:
    kind = op.get("kind", "rect")
    opacity = _num(op, "opacity", 1, 0, 1)
    stroke = parse_color(op.get("color", "#ff3b30"), opacity)
    fill = parse_color(op["fill"], opacity) if op.get("fill") else None
    width = max(1, _num(op, "width", 6, 0, 300) * scale)
    W, H = img.size

    def pts(key: str) -> list[tuple[float, float]]:
        raw = op.get(key)
        if not isinstance(raw, list) or len(raw) < 2:
            raise ValueError(f"'{key}' needs at least two points")
        return [(float(p[0]) * W, float(p[1]) * H) for p in raw]

    def draw(d: ImageDraw.ImageDraw, f: float) -> None:
        w = max(1, int(round(width * f)))
        if kind in ("rect", "ellipse"):
            x0, y0 = _num(op, "x", 0.25, -1, 2) * W * f, _num(op, "y", 0.25, -1, 2) * H * f
            x1, y1 = x0 + _num(op, "w", 0.5, 0, 3) * W * f, y0 + _num(op, "h", 0.5, 0, 3) * H * f
            if kind == "ellipse":
                d.ellipse((x0, y0, x1, y1), fill=fill, outline=stroke if width > 0 else None, width=w)
            elif op.get("radius"):
                d.rounded_rectangle((x0, y0, x1, y1), radius=float(op["radius"]) * scale * f, fill=fill, outline=stroke if width > 0 else None, width=w)
            else:
                d.rectangle((x0, y0, x1, y1), fill=fill, outline=stroke if width > 0 else None, width=w)
        elif kind in ("line", "arrow"):
            (ax, ay), (bx, by) = [(x * f, y * f) for x, y in pts("points")[:2]]
            d.line((ax, ay, bx, by), fill=stroke, width=w)
            if kind == "arrow":
                ang = math.atan2(by - ay, bx - ax)
                head = max(w * 4.0, 14 * scale * f)
                for side in (-0.5, 0.5):
                    d.line((bx, by, bx - head * math.cos(ang + side), by - head * math.sin(ang + side)), fill=stroke, width=w)
        elif kind in ("path", "highlighter"):
            line = [(x * f, y * f) for x, y in pts("points")]
            col = parse_color(op.get("color", "#ffe600"), opacity if kind == "path" else min(opacity, 0.4)) if kind == "highlighter" else stroke
            d.line(line, fill=col, width=w, joint="curve")
            for x, y in (line[0], line[-1]):
                d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=col)
        else:
            raise ValueError(f"unknown shape '{kind}'")

    return _supersampled(img, draw)


def _op_overlay(img: Image.Image, op: dict, scale: float) -> Image.Image:
    path = op.get("path")
    if not path or not Path(path).is_file():
        raise ValueError("choose an image to place")
    with Image.open(path) as src:
        logo = ImageOps.exif_transpose(src).convert("RGBA")
    width = max(1, int(round(_num(op, "w", 0.25, 0.01, 3) * img.width)))
    logo = logo.resize((width, max(1, int(round(width * logo.height / logo.width)))), Image.LANCZOS)
    opacity = _num(op, "opacity", 1, 0, 1)
    if opacity < 1:
        logo.putalpha(logo.getchannel("A").point(lambda a: int(a * opacity)))
    rot = _num(op, "rotation", 0, -360, 360)
    if rot:
        logo = logo.rotate(-rot, resample=Image.BICUBIC, expand=True)
    cx, cy = _num(op, "x", 0.85, -1, 2) * img.width, _num(op, "y", 0.9, -1, 2) * img.height
    return _composite_tile(img, logo, int(round(cx - logo.width / 2)), int(round(cy - logo.height / 2)))


def _op_rounded(img: Image.Image, op: dict, scale: float) -> Image.Image:
    r = int(round(_num(op, "radius", 40, 0, 4000) * scale))
    r = min(r, min(img.size) // 2)
    if r == 0:
        return img
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=r, fill=255)
    out = img.convert("RGBA")
    out.putalpha(ImageChops.multiply(out.getchannel("A"), mask))
    return out


_BG_SESSION: dict[str, Any] = {}


def _op_remove_background(img: Image.Image, op: dict, scale: float, data_dir: str | None) -> Image.Image:
    if not data_dir or not models.is_installed(data_dir, "rembg-u2netp"):
        raise ValueError("Install 'Background remover (small, fast)' from Models first.")
    from rembg import new_session, remove

    os.environ["U2NET_HOME"] = str(models.model_dir(data_dir, "rembg-u2netp"))
    if "u2netp" not in _BG_SESSION:
        _BG_SESSION["u2netp"] = new_session("u2netp")
    return remove(img.convert("RGBA"), session=_BG_SESSION["u2netp"])


# ---------------------------------------------------------------------------------------------
# pipeline
# ---------------------------------------------------------------------------------------------

_SIMPLE: dict[str, Callable[[Image.Image, dict, float], Image.Image]] = {
    "crop": lambda im, op, s: im.crop(_crop_box(op, im.size)),
    "rotate": _op_rotate,
    "straighten": _op_straighten,
    "flip": lambda im, op, s: ImageOps.mirror(im) if op.get("direction", "horizontal") == "horizontal" else ImageOps.flip(im),
    "resize": _op_resize,
    "border": _op_border,
    "rounded": _op_rounded,
    "adjust": _op_adjust,
    "levels": _op_levels,
    "filter": _op_filter,
    "auto": _op_auto,
    "blur": _op_blur,
    "vignette": _op_vignette,
    "grain": _op_grain,
    "text": _op_text,
    "shape": _op_shape,
    "overlay": _op_overlay,
}


def apply_ops(img: Image.Image, ops: list[dict], scale: float = 1.0, data_dir: str | None = None) -> Image.Image:
    if len(ops) > MAX_OPS:
        raise ValueError(f"too many edits (limit {MAX_OPS})")
    out = img.convert("RGBA")
    for i, op in enumerate(ops):
        t = op.get("type")
        try:
            if t == "remove_background":
                out = _op_remove_background(out, op, scale, data_dir)
            elif t in _SIMPLE:
                out = _SIMPLE[t](out, op, scale)
            else:
                raise ValueError(f"unknown edit '{t}'")
        except ValueError as e:
            raise ValueError(f"edit {i + 1} ({t}): {e}")
    return out


def load_image(path: str) -> Image.Image:
    with Image.open(path) as im:
        im.load()
        return ImageOps.exif_transpose(im).convert("RGBA")


# ---------------------------------------------------------------------------------------------
# preview (cached, downscaled) and export (full resolution)
# ---------------------------------------------------------------------------------------------

_CACHE: "OrderedDict[tuple, tuple[Image.Image, tuple[int, int]]]" = OrderedDict()


def _base_for_preview(path: str, max_side: int) -> tuple[Image.Image, tuple[int, int]]:
    p = Path(path)
    key = (str(p), p.stat().st_mtime_ns, max_side)
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    full = load_image(path)
    size = full.size
    if max(size) > max_side:
        f = max_side / max(size)
        full = full.resize((max(1, round(size[0] * f)), max(1, round(size[1] * f))), Image.LANCZOS)
    _CACHE[key] = (full, size)
    while len(_CACHE) > PREVIEW_CACHE:
        _CACHE.popitem(last=False)
    return _CACHE[key]


def _encode(img: Image.Image) -> tuple[str, str]:
    import base64
    import io

    buf = io.BytesIO()
    has_alpha = img.getchannel("A").getextrema()[0] < 255
    if has_alpha:
        img.save(buf, "PNG")
        return base64.b64encode(buf.getvalue()).decode(), "image/png"
    img.convert("RGB").save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"


def photo_info(path: str) -> dict:
    with Image.open(path) as im:
        exif = im.getexif()
        info = {
            "width": im.width,
            "height": im.height,
            "format": im.format,
            "mode": im.mode,
            "megapixels": round(im.width * im.height / 1e6, 1),
            "camera": " ".join(str(exif.get(k, "")).strip() for k in (0x010F, 0x0110)).strip(),
            "taken": str(exif.get(0x9003) or exif.get(0x0132) or ""),
            "has_location": bool(exif.get_ifd(0x8825)),
            "orientation": int(exif.get(0x0112, 1)),
            "size_bytes": Path(path).stat().st_size,
        }
    if info["orientation"] in (5, 6, 7, 8):  # the editor shows the photo upright
        info["width"], info["height"] = info["height"], info["width"]
    return info


def render_preview(path: str, ops: list[dict], max_side: int = 1400, data_dir: str | None = None) -> dict:
    base, original = _base_for_preview(path, max_side)
    scale = base.width / original[0]
    out = apply_ops(base, ops, scale, data_dir)
    image, mime = _encode(out)
    return {
        "image": image,
        "mime": mime,
        "width": out.width,
        "height": out.height,
        "original_width": original[0],
        "original_height": original[1],
        "result_size": list(output_size(original, ops, 1.0)),
    }


def filter_thumbnails(path: str, ops: list[dict], data_dir: str | None = None, side: int = 150) -> dict:
    """Every filter applied to the current state, small, so the user can choose by eye."""
    base, original = _base_for_preview(path, 600)
    scale = base.width / original[0]
    current = apply_ops(base, ops, scale, data_dir)
    f = side / max(current.size)
    small = current.resize((max(1, round(current.width * f)), max(1, round(current.height * f))), Image.LANCZOS)
    out = {}
    for name in FILTERS:
        image, _ = _encode(_apply_filter(small, name, scale * f))
        out[name] = image
    return {"filters": out}


def _save(img: Image.Image, output: Path, fmt: str, quality: int, background: str, strip: bool, exif_src: str | None) -> None:
    fmt = fmt.lower()
    params: dict[str, Any] = {}
    if fmt in ("jpeg", "jpg", "webp", "tiff") and not strip and exif_src:
        with Image.open(exif_src) as src:
            exif = src.getexif()
            exif[0x0112] = 1  # the pixels are already upright
            params["exif"] = exif.tobytes()
    if fmt in ("jpeg", "jpg"):
        bg = Image.new("RGB", img.size, parse_color(background)[:3])
        bg.paste(img, mask=img.getchannel("A"))
        bg.save(output, "JPEG", quality=quality, optimize=True, **params)
    elif fmt == "png":
        img.save(output, "PNG", optimize=True)
    elif fmt == "webp":
        img.save(output, "WEBP", quality=quality, **params)
    elif fmt == "tiff":
        img.save(output, "TIFF", **params)
    elif fmt == "bmp":
        bg = Image.new("RGB", img.size, parse_color(background)[:3])
        bg.paste(img, mask=img.getchannel("A"))
        bg.save(output, "BMP")
    elif fmt == "pdf":
        bg = Image.new("RGB", img.size, parse_color(background)[:3])
        bg.paste(img, mask=img.getchannel("A"))
        bg.save(output, "PDF", resolution=150.0)
    else:
        raise ValueError(f"unsupported format '{fmt}'")


EXT = {"jpeg": ".jpg", "jpg": ".jpg", "png": ".png", "webp": ".webp", "tiff": ".tiff", "bmp": ".bmp", "pdf": ".pdf"}


def export_photo(
    path: str,
    ops: list[dict],
    output: str,
    fmt: str = "jpeg",
    quality: int = 92,
    strip_metadata: bool = False,
    background: str = "#ffffff",
    data_dir: str | None = None,
) -> dict:
    out = apply_ops(load_image(path), ops, 1.0, data_dir)
    dest = Path(output)
    _save(out, dest, fmt, quality, background, strip_metadata, path)
    return {"output": output, "width": out.width, "height": out.height, "bytes": dest.stat().st_size}


def batch_photos(
    inputs: list[str],
    out_dir: str,
    ops: list[dict],
    fmt: str = "jpeg",
    quality: int = 90,
    strip_metadata: bool = False,
    background: str = "#ffffff",
    data_dir: str | None = None,
) -> dict:
    files = collect(inputs, IMAGE_EXTS)
    if not files:
        raise ValueError("no images found")
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    outputs, skipped = [], []
    for i, src in enumerate(files):
        jobctl.check()
        jobctl.report(i, len(files), src.name)
        try:
            out = apply_ops(load_image(str(src)), ops, 1.0, data_dir)
            dest = unique_path(Path(out_dir) / f"{src.stem}{EXT[fmt.lower()]}")
            _save(out, dest, fmt, quality, background, strip_metadata, str(src))
            outputs.append(str(dest))
        except Exception as e:
            skipped.append({"path": str(src), "reason": str(e)})
    return {"outputs": outputs, "created": outputs, "skipped": skipped, "count": len(outputs)}
