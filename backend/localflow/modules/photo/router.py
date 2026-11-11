from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ... import fonts as fontlib
from ...fonts import available_fonts
from ...security import resolve_allowed_path
from . import layouts, ops

router = APIRouter(prefix="/photo", tags=["photo"])

Op = dict[str, Any]


def _path(raw: str, request: Request, must_exist: bool = True):
    p = resolve_allowed_path(raw, request.app.state.settings)
    if must_exist and not p.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {raw}")
    return p


def _clean_ops(edits: list[Op], request: Request) -> list[Op]:
    """Only path-bearing edits need checking: every file an edit points at must be in an allowed folder."""
    out = []
    for e in edits:
        e = dict(e)
        if e.get("type") in ("overlay", "lut") and e.get("path"):
            e["path"] = str(_path(str(e["path"]), request))
        out.append(e)
    return out


def _data_dir(request: Request) -> str:
    return str(request.app.state.settings.data_dir)


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"could not process this image: {e}")


class InfoRequest(BaseModel):
    input: str


class EditRequest(BaseModel):
    input: str
    edits: list[Op] = Field(default=[], max_length=ops.MAX_OPS)


class PreviewRequest(EditRequest):
    max_side: int = Field(default=1400, ge=200, le=3000)


class ExportRequest(EditRequest):
    output: str
    format: Literal["jpeg", "png", "webp", "tiff", "bmp", "pdf", "avif", "gif", "ico"] = "jpeg"
    quality: int = Field(default=92, ge=1, le=100)
    strip_metadata: bool = False
    background: str = "#ffffff"


class BatchRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    out_dir: str
    edits: list[Op] = Field(default=[], max_length=ops.MAX_OPS)
    format: Literal["jpeg", "png", "webp", "tiff", "bmp", "avif", "gif", "ico"] = "jpeg"
    quality: int = Field(default=90, ge=1, le=100)
    strip_metadata: bool = False
    background: str = "#ffffff"


@router.get("/fonts")
def fonts():
    return {"fonts": available_fonts(), "filters": ops.FILTERS, "custom": fontlib.custom_fonts()}


class FontAdd(BaseModel):
    path: str


@router.post("/fonts/add")
def add_font(body: FontAdd):
    # fonts live outside the user's folders (C:\Windows\Fonts); only a real .ttf/.otf is accepted and it is copied into the app's own folder
    src = Path(body.path)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        family = fontlib.add_font(str(src))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"family": family, "fonts": available_fonts(), "custom": fontlib.custom_fonts()}


@router.delete("/fonts/{family}")
def remove_font(family: str):
    return {"removed": fontlib.remove_custom_font(family), "fonts": available_fonts(), "custom": fontlib.custom_fonts()}


@router.post("/info")
def info(body: InfoRequest, request: Request):
    return _call(ops.photo_info, str(_path(body.input, request)))


@router.post("/preview")
def preview(body: PreviewRequest, request: Request):
    return _call(ops.render_preview, str(_path(body.input, request)), _clean_ops(body.edits, request), body.max_side, _data_dir(request))


@router.post("/filter-thumbs")
def filter_thumbs(body: EditRequest, request: Request):
    return _call(ops.filter_thumbnails, str(_path(body.input, request)), _clean_ops(body.edits, request), _data_dir(request))


@router.post("/export", status_code=202)
def export(body: ExportRequest, request: Request):
    src = _path(body.input, request)
    out = _path(body.output, request, must_exist=False)
    if out.exists():
        raise HTTPException(status_code=409, detail=f"output already exists: {body.output}")
    if not out.parent.is_dir():
        raise HTTPException(status_code=400, detail="output directory does not exist")
    return request.app.state.jobs.submit(
        "photo.export", ops.export_photo, str(src), _clean_ops(body.edits, request), str(out), body.format, body.quality,
        body.strip_metadata, body.background, _data_dir(request), creates=[str(out)],
    ).to_dict()


@router.post("/batch", status_code=202)
def batch(body: BatchRequest, request: Request):
    inputs = [str(_path(p, request, must_exist=False)) for p in body.inputs]
    out_dir = resolve_allowed_path(body.out_dir, request.app.state.settings)
    return request.app.state.jobs.submit(
        "photo.batch", ops.batch_photos, inputs, str(out_dir), _clean_ops(body.edits, request), body.format, body.quality,
        body.strip_metadata, body.background, _data_dir(request),
    ).to_dict()


# ---- ready-made outputs --------------------------------------------------------------------


class SocialRequest(BaseModel):
    input: str
    out_dir: str
    presets: list[str] = Field(min_length=1, max_length=12)
    mode: Literal["fill", "fit"] = "fill"
    format: Literal["jpeg", "png", "webp"] = "jpeg"
    quality: int = Field(default=90, ge=40, le=100)
    background: str = "#ffffff"
    focus_x: float = Field(default=0.5, ge=0, le=1)
    focus_y: float = Field(default=0.5, ge=0, le=1)


class PassportRequest(BaseModel):
    input: str
    output: str
    width_mm: float = Field(default=35, ge=10, le=100)
    height_mm: float = Field(default=45, ge=10, le=100)
    paper: Literal["10x15", "13x18", "A4", "A5"] = "10x15"
    count: int = Field(default=0, ge=0, le=100)
    focus_y: float = Field(default=0.4, ge=0, le=1)
    background: str = "#ffffff"


class CollageRequest(BaseModel):
    inputs: list[str] = Field(min_length=2, max_length=36)
    output: str
    columns: int = Field(default=0, ge=0, le=8)
    gap: int = Field(default=12, ge=0, le=200)
    background: str = "#ffffff"
    fill: bool = True


class AnimationRequest(BaseModel):
    inputs: list[str] = Field(min_length=2, max_length=100)
    output: str
    duration_ms: int = Field(default=500, ge=40, le=10000)
    max_side: int = Field(default=800, ge=64, le=2000)


class JoinRequest(BaseModel):
    inputs: list[str] = Field(min_length=2, max_length=30)
    output: str


@router.get("/social-sizes")
def social_sizes():
    return {"sizes": [{"id": k, "label": v[0], "width": v[1], "height": v[2]} for k, v in layouts.SOCIAL.items()]}


def _new_output(raw: str, request: Request):
    out = _path(raw, request, must_exist=False)
    if out.exists():
        raise HTTPException(status_code=409, detail=f"output already exists: {raw}")
    if not out.parent.is_dir():
        raise HTTPException(status_code=400, detail="output directory does not exist")
    return out


def _submit(request: Request, kind: str, fn, *args, creates=None):
    return request.app.state.jobs.submit(kind, fn, *args, creates=creates or []).to_dict()


@router.post("/social", status_code=202)
def social(body: SocialRequest, request: Request):
    src = _path(body.input, request)
    out_dir = resolve_allowed_path(body.out_dir, request.app.state.settings)
    return _submit(request, "photo.social", layouts.social_export, str(src), str(out_dir), body.presets, body.mode, body.format, body.quality, body.background, body.focus_x, body.focus_y)


@router.post("/passport", status_code=202)
def passport(body: PassportRequest, request: Request):
    src = _path(body.input, request)
    out = _new_output(body.output, request)
    return _submit(request, "photo.passport", layouts.passport_sheet, str(src), str(out), (body.width_mm, body.height_mm), body.paper, 300, 2.0, body.focus_y, body.background, body.count, creates=[str(out)])


@router.post("/collage", status_code=202)
def collage(body: CollageRequest, request: Request):
    inputs = [str(_path(p, request)) for p in body.inputs]
    out = _new_output(body.output, request)
    return _submit(request, "photo.collage", layouts.collage, inputs, str(out), body.columns, (800, 800), body.gap, body.background, body.fill, creates=[str(out)])


@router.post("/animation", status_code=202)
def animation(body: AnimationRequest, request: Request):
    inputs = [str(_path(p, request)) for p in body.inputs]
    out = _new_output(body.output, request)
    return _submit(request, "photo.animation", layouts.make_animation, inputs, str(out), body.duration_ms, 0, body.max_side, creates=[str(out)])


@router.post("/panorama", status_code=202)
def panorama(body: JoinRequest, request: Request):
    inputs = [str(_path(p, request)) for p in body.inputs]
    out = _new_output(body.output, request)
    return _submit(request, "photo.panorama", layouts.panorama, inputs, str(out), creates=[str(out)])


@router.post("/merge-exposure", status_code=202)
def merge_exposure(body: JoinRequest, request: Request):
    inputs = [str(_path(p, request)) for p in body.inputs]
    out = _new_output(body.output, request)
    return _submit(request, "photo.merge", layouts.exposure_merge, inputs, str(out), creates=[str(out)])
