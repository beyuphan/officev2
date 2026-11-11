from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...security import resolve_allowed_path
from . import convert, more, ops, signing

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
    patterns: list[Literal["email", "tckn", "iban", "phone", "card"]] = []  # ready-made kinds of sensitive data
    regex: str | None = Field(default=None, max_length=300)  # your own pattern


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
    terms: list[str] = []
    pages: str | None = None
    patterns: list[Literal["email", "tckn", "iban", "phone", "card"]] = []
    regex: str | None = Field(default=None, max_length=300)


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
    if not any(t.strip() for t in body.terms) and not body.rects and not body.patterns and not body.regex:
        raise HTTPException(status_code=422, detail="list some text, pick what to look for or mark some areas to redact")
    if body.regex:
        try:
            re.compile(body.regex)
        except re.error as e:
            raise HTTPException(status_code=422, detail=f"the pattern is not valid: {e}")
    src = _checked(body.input, request, True)
    output = _checked_output(body.output, request)
    return request.app.state.jobs.submit(
        "pdf.redact", ops.redact_pdf, str(src), str(output), body.terms, body.pages,
        [r.model_dump() for r in body.rects], body.patterns, body.regex, creates=[str(output)],
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
    if body.regex:
        try:
            re.compile(body.regex)
        except re.error as e:
            raise HTTPException(status_code=422, detail=f"the pattern is not valid: {e}")
    return _viewer_call(ops.search_pdf, _view(request, body.input), body.terms, body.pages, body.password, body.patterns, body.regex)


@router.post("/preview-watermark")
def preview_watermark(body: WatermarkPreviewRequest, request: Request):
    image = str(_checked(body.image, request, True)) if body.kind == "image" and body.image else None
    return _viewer_call(
        ops.preview_watermark, _view(request, body.input), body.page, body.kind, body.pages, body.width,
        body.password, body.text, body.opacity, body.angle, body.font_size, image, body.x, body.y, body.width_pt,
    )


# ---------------------------------------------------------------------------------------------
# PDF editor and page tools
# ---------------------------------------------------------------------------------------------

from typing import Any  # noqa: E402

from . import edit  # noqa: E402

Op = dict[str, Any]


class EditOpsRequest(BaseModel):
    input: str
    output: str
    ops: list[Op] = Field(default=[], max_length=2000)
    flatten: bool = False
    numbers: "StampSettings | None" = None  # page numbers, headers and footers saved together with the edits


class EditPreviewRequest(ViewRequest):
    page: int = Field(default=1, ge=1)
    width: int = Field(default=900, ge=80, le=2400)
    ops: list[Op] = Field(default=[], max_length=2000)


class StampItem(BaseModel):
    position: Literal["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] = "bottom-center"
    text: str = Field(max_length=300)


class StampSettings(BaseModel):
    items: list[StampItem] = Field(min_length=1, max_length=6)
    pages: str | None = None
    size: float = Field(default=10, ge=4, le=72)
    margin: float = Field(default=28, ge=0, le=200)
    color: str = "#444444"
    font: str = "Arial"
    bold: bool = False
    start_at: int = Field(default=1, ge=0, le=1_000_000)
    opacity: float = Field(default=1.0, ge=0.05, le=1.0)


EditOpsRequest.model_rebuild()


class StampRequest(StampSettings):
    input: str
    output: str


class StampPreviewRequest(StampSettings):
    input: str
    page: int = Field(default=1, ge=1)
    width: int = Field(default=700, ge=80, le=2400)
    password: str | None = None


class CropRequest(BaseModel):
    input: str
    output: str
    pages: str | None = None
    left: float = Field(default=0, ge=0, le=2000)
    top: float = Field(default=0, ge=0, le=2000)
    right: float = Field(default=0, ge=0, le=2000)
    bottom: float = Field(default=0, ge=0, le=2000)
    auto: bool = False
    padding: float = Field(default=12, ge=0, le=300)


class ResizeRequest(BaseModel):
    input: str
    output: str
    size: Literal["A3", "A4", "A5", "Letter", "Legal"] = "A4"
    margin: float = Field(default=0, ge=0, le=200)
    landscape: bool | None = None


class InsertRequest(BaseModel):
    input: str
    output: str
    after: int = Field(default=0, ge=0)
    source: str | None = None
    source_pages: str | None = None
    blank: int = Field(default=0, ge=0, le=500)
    size: str = "same"


class SplitPartsRequest(BaseModel):
    input: str
    out_dir: str
    every: int = Field(default=0, ge=0, le=100000)
    at: list[int] = []
    by_bookmarks: bool = False
    name: str | None = Field(default=None, max_length=120)


class ExtractImagesRequest(BaseModel):
    input: str
    out_dir: str
    pages: str | None = None
    min_size: int = Field(default=64, ge=1, le=10000)


class ToImagesRequest(BaseModel):
    input: str
    out_dir: str
    dpi: int = Field(default=150, ge=36, le=600)
    format: Literal["png", "jpg"] = "png"
    pages: str | None = None


class FromImagesRequest(BaseModel):
    inputs: list[str] = Field(min_length=1, max_length=500)
    output: str
    page_size: Literal["fit", "A3", "A4", "A5", "Letter", "Legal"] = "fit"
    margin: float = Field(default=0, ge=0, le=200)


class ExtractTextRequest(BaseModel):
    input: str
    output: str
    format: Literal["txt", "md", "json"] = "txt"
    pages: str | None = None


class FlattenRequest(BaseModel):
    input: str
    output: str
    annotations: bool = True
    forms: bool = True
    remove_links: bool = False


class FillRequest(BaseModel):
    input: str
    output: str
    values: dict[str, Any] = Field(min_length=1)
    flatten: bool = False


class PropsSetRequest(BaseModel):
    input: str
    output: str
    metadata: dict[str, str] | None = None
    toc: list[list[Any]] | None = None


def _edit_ops(ops: list[Op], request: Request) -> list[Op]:
    out = []
    for o in ops:
        o = dict(o)
        if o.get("type") == "image" and o.get("path"):
            o["path"] = str(_checked(str(o["path"]), request, True))
        out.append(o)
    return out


def _job(request: Request, kind: str, fn, *args, creates: list[str] | None = None):
    return request.app.state.jobs.submit(kind, fn, *args, creates=creates or []).to_dict()


def _dir(raw: str, request: Request) -> str:
    return str(resolve_allowed_path(raw, request.app.state.settings))


@router.post("/edit/preview")
def edit_preview(body: EditPreviewRequest, request: Request):
    return _viewer_call(edit.preview_edits, _view(request, body.input), body.page, _edit_ops(body.ops, request), body.width, body.password)


@router.post("/edit", status_code=202)
def edit_save(body: EditOpsRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    numbers = None
    if body.numbers:
        n = body.numbers
        numbers = {"items": [i.model_dump() for i in n.items], "pages": n.pages, "size": n.size, "margin": n.margin, "color": n.color, "font": n.font, "bold": n.bold, "start_at": n.start_at, "opacity": n.opacity}
    return _job(request, "pdf.edit", edit.edit_pdf, str(src), str(out), _edit_ops(body.ops, request), body.flatten, numbers, creates=[str(out)])


@router.post("/stamp-preview")
def stamp_preview(body: StampPreviewRequest, request: Request):
    return _viewer_call(
        edit.preview_stamp, _view(request, body.input), body.page, [i.model_dump() for i in body.items], body.password, body.width,
        font_name=body.font, bold=body.bold, start_at=body.start_at, pages_spec=body.pages, size=body.size, margin=body.margin,
        color=body.color, opacity=body.opacity,
    )


@router.post("/stamp", status_code=202)
def stamp(body: StampRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(
        request, "pdf.stamp", edit.stamp_pages, str(src), str(out), [i.model_dump() for i in body.items], body.pages, body.size,
        body.margin, body.color, body.font, body.bold, body.start_at, body.opacity, creates=[str(out)],
    )


@router.post("/crop-pages", status_code=202)
def crop_pages(body: CropRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.crop", edit.crop_pages, str(src), str(out), body.pages, body.left, body.top, body.right, body.bottom, body.auto, body.padding, creates=[str(out)])


@router.post("/resize-pages", status_code=202)
def resize_pages(body: ResizeRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.resize", edit.resize_pages, str(src), str(out), body.size, body.margin, body.landscape, creates=[str(out)])


@router.post("/insert", status_code=202)
def insert(body: InsertRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    other = str(_checked(body.source, request, True)) if body.source else None
    return _job(request, "pdf.insert", edit.insert_pages, str(src), str(out), body.after, other, body.source_pages, body.blank, body.size, creates=[str(out)])


@router.post("/split-parts", status_code=202)
def split_parts(body: SplitPartsRequest, request: Request):
    src = _checked(body.input, request, True)
    return _job(request, "pdf.split_parts", edit.split_pdf_parts, str(src), _dir(body.out_dir, request), body.every, body.at, body.by_bookmarks, body.name)


@router.post("/extract-images", status_code=202)
def extract_images(body: ExtractImagesRequest, request: Request):
    src = _checked(body.input, request, True)
    return _job(request, "pdf.extract_images", edit.extract_images, str(src), _dir(body.out_dir, request), body.pages, body.min_size)


@router.post("/to-images", status_code=202)
def to_images(body: ToImagesRequest, request: Request):
    src = _checked(body.input, request, True)
    return _job(request, "pdf.to_images", edit.pdf_to_images, str(src), _dir(body.out_dir, request), body.dpi, body.format, body.pages)


@router.post("/from-images", status_code=202)
def from_images(body: FromImagesRequest, request: Request):
    inputs = [str(_checked(p, request, True)) for p in body.inputs]
    out = _checked_output(body.output, request)
    return _job(request, "pdf.from_images", edit.images_to_pdf, inputs, str(out), body.page_size, body.margin, creates=[str(out)])


@router.post("/extract-text", status_code=202)
def extract_text(body: ExtractTextRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.extract_text", edit.extract_text, str(src), str(out), body.format, body.pages, creates=[str(out)])


@router.post("/flatten", status_code=202)
def flatten(body: FlattenRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.flatten", edit.flatten_pdf, str(src), str(out), body.annotations, body.forms, body.remove_links, creates=[str(out)])


@router.post("/grayscale", status_code=202)
def grayscale(body: SimpleConvertRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.grayscale", edit.pdf_to_grayscale, str(src), str(out), creates=[str(out)])


@router.post("/forms/list")
def forms_list(body: ViewRequest, request: Request):
    return _viewer_call(edit.list_form_fields, _view(request, body.input), body.password)


@router.post("/forms/fill", status_code=202)
def forms_fill(body: FillRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.fill_form", edit.fill_form, str(src), str(out), body.values, body.flatten, creates=[str(out)])


@router.post("/props/get")
def props_get(body: ViewRequest, request: Request):
    return _viewer_call(edit.get_properties, _view(request, body.input), body.password)


@router.post("/props/set", status_code=202)
def props_set(body: PropsSetRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.set_props", edit.set_properties, str(src), str(out), body.metadata, body.toc, creates=[str(out)])


# ---- light conversions and target sizes -------------------------------------------------------


class TablesRequest(BaseModel):
    input: str
    out_dir: str
    pages: str | None = None


class HtmlOutRequest(BaseModel):
    input: str
    output: str
    pages: str | None = None


class WebToPdfRequest(BaseModel):
    input: str  # .html, .md or .txt file
    output: str
    paper: Literal["a4", "a5", "letter", "legal"] = "a4"


class TargetSizeRequest(BaseModel):
    input: str
    output: str
    max_mb: float = Field(gt=0.05, le=2000)


class SplitSizeRequest(BaseModel):
    input: str
    out_dir: str
    max_mb: float = Field(gt=0.05, le=2000)


@router.post("/tables-to-csv", status_code=202)
def tables_to_csv(body: TablesRequest, request: Request):
    src = _checked(body.input, request, True)
    return _job(request, "pdf.tables", convert.pdf_tables_to_csv, str(src), _dir(body.out_dir, request), body.pages)


@router.post("/to-html", status_code=202)
def to_html(body: HtmlOutRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.to_html", convert.pdf_to_html, str(src), str(out), body.pages, creates=[str(out)])


@router.post("/from-web", status_code=202)
def from_web(body: WebToPdfRequest, request: Request):
    src = _checked(body.input, request, True)
    if src.suffix.lower() not in (".html", ".htm", ".md", ".markdown", ".txt"):
        raise HTTPException(status_code=422, detail="choose an .html, .md or .txt file")
    out = _checked_output(body.output, request)
    return _job(request, "pdf.from_web", convert.html_to_pdf, str(src), str(out), body.paper, creates=[str(out)])


@router.post("/compress-to-size", status_code=202)
def compress_to_size(body: TargetSizeRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.compress", convert.compress_to_size, str(src), str(out), int(body.max_mb * 1024 * 1024), creates=[str(out)])


@router.post("/split-by-size", status_code=202)
def split_by_size(body: SplitSizeRequest, request: Request):
    src = _checked(body.input, request, True)
    return _job(request, "pdf.split_parts", convert.split_by_size, str(src), _dir(body.out_dir, request), int(body.max_mb * 1024 * 1024))


# ---- compare, pictures, text lookup, attachments, repair, layouts, scans, batch ----------------


class CompareRequest(BaseModel):
    a: str
    b: str


class ImagesListRequest(ViewRequest):
    page: int = Field(default=1, ge=1)


class ImageAction(BaseModel):
    page: int = Field(ge=1)
    xref: int
    action: Literal["delete", "replace"]
    path: str | None = None


class ImagesApplyRequest(BaseModel):
    input: str
    output: str
    actions: list[ImageAction] = Field(min_length=1, max_length=500)


class TextAtRequest(ViewRequest):
    page: int = Field(default=1, ge=1)
    x: float
    y: float


class LabelSpec(BaseModel):
    startpage: int = Field(ge=1)
    prefix: str = Field(default="", max_length=20)
    style: Literal["D", "r", "R", "a", "A", ""] = "D"
    firstpagenum: int = Field(default=1, ge=1)


class AttachRequest(BaseModel):
    input: str
    output: str
    add: list[str] = []
    remove: list[str] = []
    labels: list[LabelSpec] | None = None


class RestrictRequest(BaseModel):
    input: str
    output: str
    owner_password: str = Field(min_length=1)
    allow: list[Literal["print", "copy", "edit", "annotate"]] = []


class ImposeRequest(BaseModel):
    input: str
    output: str
    mode: Literal["nup", "booklet"] = "nup"
    per_sheet: int = Field(default=2, ge=2, le=16)
    paper: Literal["A4", "A3", "Letter"] = "A4"
    landscape: bool = True
    border: bool = False


class CleanScanRequest(BaseModel):
    input: str
    output: str
    deskew: bool = True
    crop: bool = True
    mode: Literal["contrast", "gray", "bw"] = "contrast"


class BatchStep(BaseModel):
    type: Literal["compress", "watermark", "numbers", "clean_metadata", "grayscale", "encrypt"]
    dpi: int | None = Field(default=None, ge=36, le=400)
    quality: int | None = Field(default=None, ge=10, le=100)
    text: str | None = Field(default=None, max_length=200)
    position: str | None = None
    password: str | None = None


class BatchRequest(BaseModel):
    inputs: list[str] = Field(min_length=1, max_length=2000)
    out_dir: str
    steps: list[BatchStep] = Field(min_length=1, max_length=8)


@router.post("/compare", status_code=202)
def compare(body: CompareRequest, request: Request):
    a = _checked(body.a, request, True)
    b = _checked(body.b, request, True)
    return _job(request, "pdf.compare", more.compare_pdfs, str(a), str(b))


@router.post("/images/list")
def images_list(body: ImagesListRequest, request: Request):
    return _viewer_call(more.list_images, _view(request, body.input), body.page, body.password)


@router.post("/images/apply", status_code=202)
def images_apply(body: ImagesApplyRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    actions = []
    for a in body.actions:
        d = a.model_dump()
        if d.get("path"):
            d["path"] = str(_checked(d["path"], request, True))
        actions.append(d)
    return _job(request, "pdf.images", more.change_images, str(src), str(out), actions, creates=[str(out)])


@router.post("/text-at")
def text_at(body: TextAtRequest, request: Request):
    return _viewer_call(more.text_at, _view(request, body.input), body.page, body.x, body.y, body.password)


@router.post("/attachments/list")
def attachments_list(body: ViewRequest, request: Request):
    return _viewer_call(more.list_attachments, _view(request, body.input), body.password)


@router.post("/attachments/save", status_code=202)
def attachments_save(body: AttachRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    add = [str(_checked(p, request, True)) for p in body.add]
    labels = [lab.model_dump() for lab in body.labels] if body.labels is not None else None
    return _job(request, "pdf.set_props", more.set_attachments_and_labels, str(src), str(out), add, body.remove, labels, creates=[str(out)])


@router.post("/restrict", status_code=202)
def restrict(body: RestrictRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.encrypt", more.restrict_pdf, str(src), str(out), body.owner_password, body.allow, creates=[str(out)])


@router.post("/repair", status_code=202)
def repair(body: SimpleConvertRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.repair", more.repair_pdf, str(src), str(out), creates=[str(out)])


@router.post("/impose", status_code=202)
def impose(body: ImposeRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.impose", more.impose_pdf, str(src), str(out), body.mode, body.per_sheet, body.paper, body.landscape, 18, 8, body.border, creates=[str(out)])


@router.post("/clean-scan", status_code=202)
def clean_scan(body: CleanScanRequest, request: Request):
    src = _checked(body.input, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.clean_scan", more.clean_scan_pages, str(src), str(out), body.deskew, body.crop, body.mode, creates=[str(out)])


@router.post("/batch", status_code=202)
def batch(body: BatchRequest, request: Request):
    inputs = [str(_checked(p, request, False)) for p in body.inputs]
    steps = [{k: v for k, v in s.model_dump().items() if v is not None} for s in body.steps]
    for s in steps:
        if s["type"] == "encrypt" and not s.get("password"):
            raise HTTPException(status_code=422, detail="choose a password for the encryption step")
    return _job(request, "pdf.batch", more.run_batch, inputs, _dir(body.out_dir, request), steps)


class SignRequest(BaseModel):
    input: str
    output: str
    certificate: str  # .pfx / .p12
    password: str = ""
    reason: str = Field(default="", max_length=200)
    location: str = Field(default="", max_length=200)
    visible: bool = False
    page: int = Field(default=1, ge=1)


@router.post("/sign", status_code=202)
def sign(body: SignRequest, request: Request):
    src = _checked(body.input, request, True)
    cert = _checked(body.certificate, request, True)
    out = _checked_output(body.output, request)
    return _job(request, "pdf.sign", signing.sign_pdf, str(src), str(out), str(cert), body.password, body.reason, body.location, body.visible, body.page, creates=[str(out)])


@router.post("/signatures")
def signatures(body: ViewRequest, request: Request):
    return _viewer_call(signing.verify_signatures, _view(request, body.input))


class TextBetweenRequest(ViewRequest):
    page: int = Field(default=1, ge=1)
    ax: float
    ay: float
    bx: float
    by: float


@router.post("/text-between")
def text_between(body: TextBetweenRequest, request: Request):
    return _viewer_call(more.text_between, _view(request, body.input), body.page, body.ax, body.ay, body.bx, body.by, body.password)


class ObjectsRequest(ViewRequest):
    page: int = Field(default=1, ge=1)


class OrigImageRequest(ViewRequest):
    xref: int


class PlanEntry(BaseModel):
    source: int = Field(default=0, ge=0)
    page: int = Field(default=1, ge=1)
    rotate: int = Field(default=0, ge=-360, le=360)
    blank: bool = False
    width: float = Field(default=595, gt=10, le=5000)
    height: float = Field(default=842, gt=10, le=5000)


class BuildRequest(BaseModel):
    sources: list[str] = Field(min_length=1, max_length=20)
    plan: list[PlanEntry] = Field(min_length=1, max_length=5000)


class AssemblePart(BaseModel):
    output: str
    plan: list[PlanEntry] = Field(min_length=1, max_length=5000)


class AssembleRequest(BaseModel):
    sources: list[str] = Field(min_length=1, max_length=40)
    parts: list[AssemblePart] = Field(min_length=1, max_length=200)


@router.post("/assemble", status_code=202)
def assemble(body: AssembleRequest, request: Request):
    """Merge, reorder, rotate, remove and split in one go: each part becomes its own file."""
    sources = [str(_checked(p, request, True)) for p in body.sources]
    outputs = [str(_checked_output(p.output, request)) for p in body.parts]
    if len(set(outputs)) != len(outputs):
        raise HTTPException(status_code=400, detail="two files would get the same name")
    if any(not 0 <= e.source < len(sources) for p in body.parts for e in p.plan if not e.blank):
        raise HTTPException(status_code=400, detail="a page refers to a file that is not in the list")
    parts = [{"output": o, "plan": [e.model_dump() for e in p.plan]} for o, p in zip(outputs, body.parts)]
    return _job(request, "pdf.assemble", more.assemble_pdfs, sources, parts, creates=outputs)


@router.post("/page-objects")
def page_objects(body: ObjectsRequest, request: Request):
    return _viewer_call(more.page_objects, _view(request, body.input), body.page, body.password)


@router.post("/original-image")
def original_image(body: OrigImageRequest, request: Request):
    return _viewer_call(more.original_image, _view(request, body.input), body.xref, 1400, body.password)


@router.post("/work/build")
def work_build(body: BuildRequest, request: Request):
    """Builds a working copy from pages of one or more PDFs. The originals are never touched; the copy lives in the app's data folder."""
    import uuid

    sources = [str(_checked(p, request, True)) for p in body.sources]
    work = request.app.state.settings.data_dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    dest = work / f"{uuid.uuid4().hex[:12]}.pdf"
    return _viewer_call(more.build_pdf, sources, [e.model_dump() for e in body.plan], str(dest))


class WorkEditRequest(BaseModel):
    input: str
    ops: list[Op] = Field(default=[], max_length=2000)
    flatten: bool = False
    numbers: StampSettings | None = None


@router.post("/work/edit")
def work_edit(body: WorkEditRequest, request: Request):
    """Applies the edits into a new working copy (used before splitting or extracting pages, so the edits are included)."""
    import uuid

    src = _checked(body.input, request, True)
    work = request.app.state.settings.data_dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    dest = work / f"{uuid.uuid4().hex[:12]}.pdf"
    numbers = None
    if body.numbers:
        n = body.numbers
        numbers = {"items": [i.model_dump() for i in n.items], "pages": n.pages, "size": n.size, "margin": n.margin, "color": n.color, "font": n.font, "bold": n.bold, "start_at": n.start_at, "opacity": n.opacity}
    r = _viewer_call(edit.edit_pdf, str(src), str(dest), _edit_ops(body.ops, request), body.flatten, numbers)
    return {"path": str(dest), **r}
