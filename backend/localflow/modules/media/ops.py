"""Image and video processing. Outputs always go to a separate folder; sources are never touched."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from ... import jobctl, models
from ..files.ops import unique_path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".avif", ".ico", ".heic", ".heif"}

try:  # phone photos (HEIC/HEIF); a small optional library, everything else works without it
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover - depends on the installation
    pass
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".flv"}


def collect(paths: list[str], exts: set[str], recursive: bool = True) -> list[Path]:
    """Expand files and folders into a flat, de-duplicated list of matching files."""
    out: list[Path] = []
    seen: set[Path] = set()
    for raw in paths:
        p = Path(raw)
        found = []
        if p.is_dir():
            it = p.rglob("*") if recursive else p.iterdir()
            found = sorted(f for f in it if f.is_file() and f.suffix.lower() in exts)
        elif p.is_file() and p.suffix.lower() in exts:
            found = [p]
        for f in found:
            if f not in seen:
                seen.add(f)
                out.append(f)
    return out


def _out_path(out_dir: Path, src: Path, ext: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    return unique_path(out_dir / f"{src.stem}{ext}")


# ---------------------------------------------------------------------------------------------
# images
# ---------------------------------------------------------------------------------------------

FORMATS = {"webp": (".webp", "WEBP"), "jpeg": (".jpg", "JPEG"), "png": (".png", "PNG"), "avif": (".avif", "AVIF"), "ico": (".ico", "ICO")}


def convert_images(
    inputs: list[str],
    out_dir: str,
    fmt: str = "webp",
    quality: int = 80,
    max_side: int = 0,
    strip_metadata: bool = True,
) -> dict:
    from PIL import Image, ImageOps

    files = collect(inputs, IMAGE_EXTS)
    if not files:
        raise ValueError("no images found")
    if fmt != "same" and fmt not in FORMATS:
        raise ValueError(f"unsupported format '{fmt}'")
    outputs, skipped, before, after = [], [], 0, 0
    for i, src in enumerate(files):
        jobctl.check()
        jobctl.report(i, len(files), src.name)
        try:
            with Image.open(src) as im:
                exif = None if strip_metadata else im.info.get("exif")
                im = ImageOps.exif_transpose(im)  # bake orientation in before metadata is dropped
                if max_side and max(im.size) > max_side:
                    im.thumbnail((max_side, max_side), Image.LANCZOS)
                if fmt == "same":
                    ext = src.suffix.lower()
                    pil_fmt = Image.registered_extensions().get(ext, "PNG")
                else:
                    ext, pil_fmt = FORMATS[fmt]
                if pil_fmt == "JPEG" and im.mode in ("RGBA", "LA", "P"):
                    bg = Image.new("RGB", im.size, (255, 255, 255))
                    rgba = im.convert("RGBA")
                    bg.paste(rgba, mask=rgba.split()[-1])
                    im = bg
                elif im.mode == "P" and pil_fmt != "PNG":
                    im = im.convert("RGB")
                dest = _out_path(Path(out_dir), src, ext)
                params: dict = {}
                if pil_fmt in ("JPEG", "WEBP", "AVIF"):
                    params["quality"] = quality
                if pil_fmt == "ICO" and max(im.size) > 256:
                    im.thumbnail((256, 256), Image.LANCZOS)  # the ICO format stops at 256 px
                if pil_fmt == "PNG":
                    params["optimize"] = True
                if exif:
                    params["exif"] = exif
                im.save(dest, pil_fmt, **params)
        except Exception as e:  # one bad file should not stop the batch
            skipped.append({"path": str(src), "reason": str(e)})
            continue
        before += src.stat().st_size
        after += dest.stat().st_size
        outputs.append(str(dest))
    return {"outputs": outputs, "created": outputs, "skipped": skipped, "saved_bytes": before - after, "count": len(outputs)}


# ---------------------------------------------------------------------------------------------
# video (ffmpeg)
# ---------------------------------------------------------------------------------------------


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ValueError(f"{name} was not found. Install ffmpeg and make sure it is on PATH.")
    return path


def _duration(src: Path) -> float:
    try:
        out = subprocess.run(
            [_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return float(out)
    except Exception:
        return 0.0


def convert_videos(inputs: list[str], out_dir: str, fmt: str = "mp4", crf: int = 28, max_height: int = 0) -> dict:
    ffmpeg = _tool("ffmpeg")
    files = collect(inputs, VIDEO_EXTS)
    if not files:
        raise ValueError("no videos found")
    if fmt not in ("mp4", "webm"):
        raise ValueError(f"unsupported format '{fmt}'")
    outputs, skipped, before, after = [], [], 0, 0
    for i, src in enumerate(files):
        dest = _out_path(Path(out_dir), src, f".{fmt}")
        total = _duration(src)
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(src)]
        if max_height:
            cmd += ["-vf", f"scale=-2:'min({max_height},ih)'"]
        if fmt == "mp4":
            cmd += ["-c:v", "libx264", "-crf", str(crf), "-preset", "medium", "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart"]
        else:
            cmd += ["-c:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0", "-c:a", "libopus"]
        cmd += ["-progress", "pipe:1", "-nostats", str(dest)]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                if jobctl.cancelled():
                    proc.kill()
                    proc.wait()
                    dest.unlink(missing_ok=True)
                    raise jobctl.Cancelled("cancelled")
                if line.startswith("out_time_us=") and total:
                    try:
                        t = int(line.split("=")[1]) / 1_000_000
                        jobctl.report(i + min(t / total, 1.0), len(files), src.name)
                    except ValueError:
                        pass
            err = proc.stderr.read()  # type: ignore[union-attr]
            proc.wait()
        finally:
            if proc.poll() is None:
                proc.kill()
        if proc.returncode != 0:
            dest.unlink(missing_ok=True)
            skipped.append({"path": str(src), "reason": (err or "ffmpeg failed").strip()[-300:]})
            continue
        before += src.stat().st_size
        after += dest.stat().st_size
        outputs.append(str(dest))
    return {"outputs": outputs, "created": outputs, "skipped": skipped, "saved_bytes": before - after, "count": len(outputs)}


# ---------------------------------------------------------------------------------------------
# background removal (rembg) and upscaling (Real-ESRGAN)
# ---------------------------------------------------------------------------------------------


def remove_backgrounds(inputs: list[str], out_dir: str, data_dir: str, model: str = "u2netp") -> dict:
    from PIL import Image
    from ... import extras

    extras.require("background")
    from rembg import new_session, remove

    files = collect(inputs, IMAGE_EXTS)
    if not files:
        raise ValueError("no images found")
    model_dir = models.ensure(data_dir, f"rembg-{model}")
    os.environ["U2NET_HOME"] = str(model_dir)
    session = new_session(model)
    outputs, skipped = [], []
    for i, src in enumerate(files):
        jobctl.check()
        jobctl.report(i, len(files), src.name)
        try:
            with Image.open(src) as im:
                result = remove(im.convert("RGBA"), session=session)
            dest = _out_path(Path(out_dir), src, ".png")
            result.save(dest, "PNG")
            outputs.append(str(dest))
        except Exception as e:
            skipped.append({"path": str(src), "reason": str(e)})
    return {"outputs": outputs, "created": outputs, "skipped": skipped, "count": len(outputs)}


def upscale_images(inputs: list[str], out_dir: str, data_dir: str, scale: int = 4, method: str = "basic") -> dict:
    files = collect(inputs, IMAGE_EXTS)
    if not files:
        raise ValueError("no images found")
    if scale not in (2, 3, 4):
        raise ValueError("scale must be 2, 3 or 4")
    if method == "basic":  # built in: smooth enlargement with a little sharpening, nothing to download
        from ..photo.layouts import basic_upscale

        outputs = []
        for i, src in enumerate(files):
            jobctl.check()
            jobctl.report(i, len(files), src.name)
            dest = _out_path(Path(out_dir), src, f"_x{scale}.png")
            basic_upscale(src, dest, scale)
            outputs.append(str(dest))
        return {"outputs": outputs, "created": outputs, "skipped": [], "count": len(outputs)}
    root = models.ensure(data_dir, "realesrgan")
    exe = next(root.rglob("realesrgan-ncnn-vulkan.exe"), None)
    if exe is None:
        raise ValueError("Real-ESRGAN executable not found in the installed package")
    outputs, skipped = [], []
    for i, src in enumerate(files):
        jobctl.check()
        jobctl.report(i, len(files), src.name)
        dest = _out_path(Path(out_dir), src, f"_x{scale}.png")
        cmd = [str(exe), "-i", str(src), "-o", str(dest), "-n", "realesrgan-x4plus", "-s", str(scale), "-f", "png"]
        proc = subprocess.Popen(cmd, cwd=str(exe.parent), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        while proc.poll() is None:
            if jobctl.cancelled():
                proc.kill()
                proc.wait()
                dest.unlink(missing_ok=True)
                raise jobctl.Cancelled("cancelled")
            try:
                proc.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                pass
        if proc.returncode != 0 or not dest.exists():
            dest.unlink(missing_ok=True)
            skipped.append({"path": str(src), "reason": (proc.stderr.read() or "upscaler failed").strip()[-300:]})
            continue
        outputs.append(str(dest))
    return {"outputs": outputs, "created": outputs, "skipped": skipped, "count": len(outputs)}
