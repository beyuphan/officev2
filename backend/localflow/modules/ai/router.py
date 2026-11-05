from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ... import models
from ...security import resolve_allowed_path
from . import llm
from .index import index_job
from .transcribe import AUDIO_VIDEO_EXTS, transcribe

router = APIRouter(tags=["ai"])


def _data_dir(request: Request) -> str:
    return str(request.app.state.settings.data_dir)


# ---- model manager ---------------------------------------------------------------------------------


@router.get("/models")
def list_models(request: Request):
    return models.list_models(request.app.state.settings.data_dir)


@router.post("/models/{model_id}/install", status_code=202)
def install_model(model_id: str, request: Request):
    if model_id not in models.REGISTRY:
        raise HTTPException(status_code=404, detail="unknown model")
    return request.app.state.jobs.submit("models.install", models.install, _data_dir(request), model_id).to_dict()


@router.delete("/models/{model_id}")
def remove_model(model_id: str, request: Request):
    if model_id not in models.REGISTRY:
        raise HTTPException(status_code=404, detail="unknown model")
    return {"removed": models.remove(request.app.state.settings.data_dir, model_id)}


# ---- speech to text ---------------------------------------------------------------------------------


class TranscribeRequest(BaseModel):
    input: str
    out_dir: str
    model: Literal["tiny", "base", "small"] = "small"
    language: str | None = Field(default=None, max_length=8)  # e.g. "tr"; empty = auto-detect
    formats: list[Literal["txt", "srt", "vtt"]] = ["txt", "srt"]


@router.post("/ai/transcribe", status_code=202)
def transcribe_endpoint(body: TranscribeRequest, request: Request):
    settings = request.app.state.settings
    src = resolve_allowed_path(body.input, settings)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    if src.suffix.lower() not in AUDIO_VIDEO_EXTS:
        raise HTTPException(status_code=422, detail=f"unsupported file type '{src.suffix}'")
    out_dir = resolve_allowed_path(body.out_dir, settings)
    return request.app.state.jobs.submit(
        "ai.transcribe", transcribe, str(src), str(out_dir), _data_dir(request), body.model,
        body.language or None, body.formats,
    ).to_dict()


# ---- document index, search and chat -----------------------------------------------------------------


class IndexRequest(BaseModel):
    paths: list[str] = Field(min_length=1)


@router.post("/ai/index", status_code=202)
def index_paths(body: IndexRequest, request: Request):
    paths = []
    for raw in body.paths:
        p = resolve_allowed_path(raw, request.app.state.settings)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"not found: {raw}")
        paths.append(str(p))
        if p.is_dir():
            request.app.state.index.add_source(str(p))
    return request.app.state.jobs.submit(
        "ai.index", index_job, str(request.app.state.index_path), _data_dir(request), paths
    ).to_dict()


@router.get("/ai/index")
def index_stats(request: Request):
    return request.app.state.index.stats()


class SourceBody(BaseModel):
    path: str


@router.post("/ai/index/forget")
def forget_source(body: SourceBody, request: Request):
    """Remove a folder from the index. Files on disk are not touched."""
    p = resolve_allowed_path(body.path, request.app.state.settings)
    return {"forgotten_documents": request.app.state.index.remove_source(str(p))}


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    k: int = Field(default=5, ge=1, le=30)
    per_document: bool = False  # semantic file search: one hit per file


def _require_embeddings(request: Request) -> None:
    if not models.is_installed(request.app.state.settings.data_dir, "embed-multilingual"):
        raise HTTPException(
            status_code=409,
            detail="The embedding model is not installed. Install 'embed-multilingual' from Models or run an index job once.",
        )


@router.post("/ai/search")
def search(body: SearchRequest, request: Request):
    _require_embeddings(request)
    return request.app.state.index.search(body.query, body.k, body.per_document)


class AskRequest(BaseModel):
    question: str = Field(min_length=1)
    k: int = Field(default=5, ge=1, le=15)
    model: str | None = None


@router.post("/ai/ask")
def ask(body: AskRequest, request: Request):
    _require_embeddings(request)
    sources = request.app.state.index.search(body.question, body.k)
    result = llm.answer(body.question, sources, body.model) if sources else {
        "answer": None,
        "note": "Nothing relevant was found. Index some folders first.",
    }
    return {**result, "sources": sources}


@router.get("/ai/llm")
def llm_status():
    return llm.status()


class OcrImageRequest(BaseModel):
    image_base64: str = Field(min_length=8, max_length=40_000_000)
    engine: Literal["auto", "windows", "rapidocr"] = "auto"


@router.post("/ai/ocr-image")
def ocr_image(body: OcrImageRequest):
    """Text from a screenshot region. The image is processed in memory and never written to disk."""
    import base64
    import binascii

    from ..pdf.ops import ocr_image_text

    try:
        png = base64.b64decode(body.image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="image_base64 is not valid base64")
    try:
        return ocr_image_text(png, body.engine)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"could not read the image: {e}")
