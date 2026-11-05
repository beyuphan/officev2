from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...security import resolve_allowed_path
from . import ops

router = APIRouter(prefix="/pdf", tags=["pdf"])


class MergeRequest(BaseModel):
    inputs: list[str] = Field(min_length=2)
    output: str


class SplitRequest(BaseModel):
    input: str
    pages: str  # e.g. "1-3,5,8-"
    output: str


class EncryptRequest(BaseModel):
    input: str
    output: str
    password: str = Field(min_length=1)
    owner_password: str | None = None


class UnlockRequest(BaseModel):
    input: str
    output: str
    password: str = ""


class WatermarkRequest(BaseModel):
    input: str
    output: str
    kind: Literal["text", "image"]
    pages: str | None = None  # all pages when omitted
    # text
    text: str | None = None
    opacity: float = Field(default=0.25, ge=0.02, le=1.0)
    angle: float = Field(default=45.0, ge=-180, le=180)
    font_size: float = Field(default=64.0, ge=6, le=400)
    # image (logo / signature)
    image: str | None = None
    x: float = Field(default=36.0, ge=0)
    y: float = Field(default=36.0, ge=0)
    width: float = Field(default=120.0, gt=0, le=2000)


class OcrRequest(BaseModel):
    input: str
    output: str
    pages: str | None = None
    engine: Literal["auto", "windows", "rapidocr"] = "auto"


class CompressRequest(BaseModel):
    input: str
    output: str
    dpi: int = Field(default=120, ge=36, le=600)
    quality: int = Field(default=70, ge=10, le=100)


class PlanItem(BaseModel):
    page: int = Field(ge=1)
    rotate: Literal[0, 90, 180, 270] = 0


class OrganizeRequest(BaseModel):
    input: str
    output: str
    plan: list[PlanItem] | None = Field(default=None, min_length=1)  # new page order, one rotation each
    order: str | None = None  # older form: "3,1,2-4"
    rotate: Literal[0, 90, 180, 270] = 0
    rotate_pages: str | None = None


class Area(BaseModel):
    page: int = Field(ge=1)
    x0: float
    y0: float
    x1: float
    y1: float


class RedactRequest(BaseModel):
    input: str
    output: str
    terms: list[str] = []
    rects: list[Area] = []  # areas in displayed page coordinates (points), as shown by the preview
    pages: str | None = None


class ViewRequest(BaseModel):
    input: str
    password: str | None = None


class RenderRequest(ViewRequest):
    page: int = Field(default=1, ge=1)
    width: int = Field(default=700, ge=40, le=2400)


class ThumbsRequest(ViewRequest):
    start: int = Field(default=1, ge=1)
    count: int = Field(default=12, ge=1, le=60)
    width: int = Field(default=150, ge=40, le=600)


class SearchRequest(ViewRequest):
    terms: list[str] = Field(min_length=1)
    pages: str | None = None


class WatermarkPreviewRequest(ViewRequest):
    page: int = Field(default=1, ge=1)
    width: int = Field(default=700, ge=80, le=2400)
    kind: Literal["text", "image"]
    pages: str | None = None
    text: str | None = None
    opacity: float = Field(default=0.25, ge=0.02, le=1.0)
    angle: float = Field(default=45.0, ge=-180, le=180)
    font_size: float = Field(default=64.0, ge=6, le=400)
    image: str | None = None
    x: float = Field(default=36.0, ge=0)
    y: float = Field(default=36.0, ge=0)
    width_pt: float = Field(default=120.0, gt=0, le=2000)


class SimpleConvertRequest(BaseModel):
    input: str
    output: str


def _checked(raw: str, request: Request, must_exist: bool):
    path = resolve_allowed_path(raw, request.app.state.settings)
    if must_exist and not path.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {raw}")
    return path


def _checked_output(raw: str, request: Request):
    path = _checked(raw, request, must_exist=False)
    if path.exists():
        raise HTTPException(status_code=409, detail=f"output already exists: {raw}")
    if not path.parent.is_dir():
        raise HTTPException(status_code=400, detail="output directory does not exist")
    return path


@router.post("/merge", status_code=202)
def merge(body: MergeRequest, request: Request):
    inputs = [str(_checked(p, request, True)) for p in body.inputs]
    output = _checked_output(body.output, request)
    job = request.app.state.jobs.submit("pdf.merge", ops.merge_pdfs, inputs, str(output), creates=[str(output)])
    return job.to_dict()


@router.post("/split", status_code=202)
def split(body: SplitRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    job = request.app.state.jobs.submit("pdf.split", ops.split_pdf, str(src), body.pages, str(output), creates=[str(output)])
    return job.to_dict()


@router.post("/encrypt", status_code=202)
def encrypt(body: EncryptRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.encrypt", ops.encrypt_pdf, str(src), str(output), body.password, body.owner_password,
        creates=[str(output)],
    ).to_dict()


@router.post("/unlock", status_code=202)
def unlock(body: UnlockRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.unlock", ops.unlock_pdf, str(src), str(output), body.password, creates=[str(output)]
    ).to_dict()


@router.post("/watermark", status_code=202)
def watermark(body: WatermarkRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    jobs = request.app.state.jobs
    if body.kind == "text":
        if not body.text or not body.text.strip():
            raise HTTPException(status_code=422, detail="text is required for a text watermark")
        job = jobs.submit(
            "pdf.watermark", ops.watermark_text, str(src), str(output), body.text, body.pages,
            body.opacity, body.angle, body.font_size, creates=[str(output)],
        )
    else:
        if not body.image:
            raise HTTPException(status_code=422, detail="image is required for an image watermark")
        image = _checked(body.image, request, True)
        job = jobs.submit(
            "pdf.watermark", ops.watermark_image, str(src), str(output), str(image), body.pages,
            body.x, body.y, body.width, creates=[str(output)],
        )
    return job.to_dict()


@router.post("/ocr", status_code=202)
def ocr(body: OcrRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.ocr", ops.ocr_pdf, str(src), str(output), body.pages, body.engine, creates=[str(output)]
    ).to_dict()


@router.post("/compress", status_code=202)
def compress(body: CompressRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.compress", ops.compress_pdf, str(src), str(output), body.dpi, body.quality, creates=[str(output)]
    ).to_dict()


@router.post("/organize", status_code=202)
def organize(body: OrganizeRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.organize", ops.organize_pdf, str(src), str(output), body.order, body.rotate, body.rotate_pages,
        [i.model_dump() for i in body.plan] if body.plan else None,
        creates=[str(output)],
    ).to_dict()


@router.post("/redact", status_code=202)
def redact(body: RedactRequest, request: Request):
    if not any(t.strip() for t in body.terms) and not body.rects:
        raise HTTPException(status_code=422, detail="list some text or mark some areas to redact")
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.redact", ops.redact_pdf, str(src), str(output), body.terms, body.pages,
        [r.model_dump() for r in body.rects], creates=[str(output)],
    ).to_dict()


@router.post("/clean-metadata", status_code=202)
def clean_metadata(body: SimpleConvertRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.clean_metadata", ops.clean_pdf_metadata, str(src), str(output), creates=[str(output)]
    ).to_dict()


@router.post("/to-docx", status_code=202)
def to_docx(body: SimpleConvertRequest, request: Request):
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.to_docx", ops.pdf_to_docx, str(src), str(output), creates=[str(output)]
    ).to_dict()


@router.post("/from-office", status_code=202)
def from_office(body: SimpleConvertRequest, request: Request):
    src = _checked(body.input, request, True)
    if src.suffix.lower() not in ops.OFFICE_EXTS:
        raise HTTPException(status_code=422, detail=f"unsupported file type '{src.suffix}'")
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.from_office", ops.office_to_pdf, str(src), str(output), creates=[str(output)]
    ).to_dict()


def _view(request: Request, raw: str):
    return str(_checked(raw, request, True))


def _viewer_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ops.NeedsPassword:
        raise HTTPException(status_code=423, detail="this PDF is password protected")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:  # unreadable or damaged file
        raise HTTPException(status_code=422, detail=f"could not read this PDF: {e}")


@router.post("/info")
def info(body: ViewRequest, request: Request):
    return _viewer_call(ops.pdf_info, _view(request, body.input), body.password)


@router.post("/render")
def render(body: RenderRequest, request: Request):
    return _viewer_call(ops.render_page, _view(request, body.input), body.page, body.width, body.password)


@router.post("/thumbnails")
def thumbnails(body: ThumbsRequest, request: Request):
    return _viewer_call(
        ops.render_thumbnails, _view(request, body.input), body.start, body.count, body.width, body.password
    )


@router.post("/search")
def search(body: SearchRequest, request: Request):
    return _viewer_call(ops.search_pdf, _view(request, body.input), body.terms, body.pages, body.password)


@router.post("/preview-watermark")
def preview_watermark(body: WatermarkPreviewRequest, request: Request):
    image = str(_checked(body.image, request, True)) if body.kind == "image" and body.image else None
    return _viewer_call(
        ops.preview_watermark, _view(request, body.input), body.page, body.kind, body.pages, body.width,
        body.password, body.text, body.opacity, body.angle, body.font_size, image, body.x, body.y, body.width_pt,
    )
