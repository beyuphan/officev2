from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...fonts import available_fonts
from ...security import resolve_allowed_path
from . import ops

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
        if e.get("type") == "overlay" and e.get("path"):
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
    format: Literal["jpeg", "png", "webp", "tiff", "bmp", "pdf"] = "jpeg"
    quality: int = Field(default=92, ge=1, le=100)
    strip_metadata: bool = False
    background: str = "#ffffff"


class BatchRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    out_dir: str
    edits: list[Op] = Field(default=[], max_length=ops.MAX_OPS)
    format: Literal["jpeg", "png", "webp", "tiff", "bmp"] = "jpeg"
    quality: int = Field(default=90, ge=1, le=100)
    strip_metadata: bool = False
    background: str = "#ffffff"


@router.get("/fonts")
def fonts():
    return {"fonts": available_fonts(), "filters": ops.FILTERS}


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
