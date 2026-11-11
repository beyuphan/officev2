from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...security import resolve_allowed_path
from . import ops

router = APIRouter(prefix="/media", tags=["media"])


def _inputs(raw: list[str], request: Request) -> list[str]:
    out = []
    for r in raw:
        p = resolve_allowed_path(r, request.app.state.settings)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"not found: {r}")
        out.append(str(p))
    return out


def _out_dir(raw: str, request: Request) -> str:
    return str(resolve_allowed_path(raw, request.app.state.settings))


def _data_dir(request: Request) -> str:
    return str(request.app.state.settings.data_dir)


class ImagesRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    out_dir: str
    format: Literal["webp", "jpeg", "png", "avif", "ico", "same"] = "webp"
    quality: int = Field(default=80, ge=1, le=100)
    max_side: int = Field(default=0, ge=0, le=20000)
    strip_metadata: bool = True


@router.post("/images", status_code=202)
def images(body: ImagesRequest, request: Request):
    return request.app.state.jobs.submit(
        "media.images", ops.convert_images, _inputs(body.inputs, request), _out_dir(body.out_dir, request),
        body.format, body.quality, body.max_side, body.strip_metadata,
    ).to_dict()


class VideoRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    out_dir: str
    format: Literal["mp4", "webm"] = "mp4"
    crf: int = Field(default=28, ge=15, le=40)
    max_height: int = Field(default=0, ge=0, le=4320)


@router.post("/video", status_code=202)
def video(body: VideoRequest, request: Request):
    return request.app.state.jobs.submit(
        "media.video", ops.convert_videos, _inputs(body.inputs, request), _out_dir(body.out_dir, request),
        body.format, body.crf, body.max_height,
    ).to_dict()


class RemoveBgRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    out_dir: str
    model: Literal["u2netp", "u2net"] = "u2netp"


@router.post("/remove-background", status_code=202)
def remove_background(body: RemoveBgRequest, request: Request):
    return request.app.state.jobs.submit(
        "media.remove_background", ops.remove_backgrounds, _inputs(body.inputs, request),
        _out_dir(body.out_dir, request), _data_dir(request), body.model,
    ).to_dict()


class UpscaleRequest(BaseModel):
    inputs: list[str] = Field(min_length=1)
    out_dir: str
    scale: Literal[2, 3, 4] = 4
    method: Literal["basic", "ai"] = "basic"


@router.post("/upscale", status_code=202)
def upscale(body: UpscaleRequest, request: Request):
    return request.app.state.jobs.submit(
        "media.upscale", ops.upscale_images, _inputs(body.inputs, request), _out_dir(body.out_dir, request),
        _data_dir(request), body.scale, body.method,
    ).to_dict()
