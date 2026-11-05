from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...security import resolve_allowed_path
from . import ops

router = APIRouter(prefix="/files", tags=["files"])


def _dir(raw: str, request: Request) -> Path:
    p = resolve_allowed_path(raw, request.app.state.settings)
    if not p.is_dir():
        raise HTTPException(status_code=404, detail=f"folder not found: {raw}")
    return p


def _recorder(request: Request):
    return request.app.state.history.record


# ---- bulk rename -----------------------------------------------------------------------------


class RenameRequest(BaseModel):
    folder: str
    pattern: str = Field(min_length=1)
    replacement: str = ""
    regex: bool = False
    ignore_case: bool = False
    include_extension: bool = False
    recursive: bool = False
    start_at: int = Field(default=1, ge=0)


@router.post("/rename/preview")
def rename_preview(body: RenameRequest, request: Request):
    folder = _dir(body.folder, request)
    try:
        return ops.rename_plan(
            folder, body.pattern, body.replacement, body.regex, body.ignore_case,
            body.include_extension, body.recursive, body.start_at,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/rename/apply")
def rename_apply(body: RenameRequest, request: Request):
    folder = _dir(body.folder, request)
    try:
        plan = ops.rename_plan(
            folder, body.pattern, body.replacement, body.regex, body.ignore_case,
            body.include_extension, body.recursive, body.start_at,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return ops.apply_renames(plan, _recorder(request))


# ---- scans (jobs) -------------------------------------------------------------------------------


def default_temp_roots() -> list[str]:
    roots = {tempfile.gettempdir()}
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.add(str(Path(local) / "Temp"))
    return sorted(roots)


class CleanScanRequest(BaseModel):
    older_than_days: float = Field(default=1.0, ge=0)


@router.post("/clean/scan", status_code=202)
def clean_scan(body: CleanScanRequest, request: Request):
    roots = [str(resolve_allowed_path(r, request.app.state.settings)) for r in default_temp_roots()]
    return request.app.state.jobs.submit("files.clean_scan", ops.scan_temp, roots, body.older_than_days).to_dict()


class JunkScanRequest(BaseModel):
    root: str


@router.post("/junk/scan", status_code=202)
def junk_scan(body: JunkScanRequest, request: Request):
    root = _dir(body.root, request)
    return request.app.state.jobs.submit("files.junk_scan", ops.scan_dev_junk, str(root)).to_dict()


class UsageRequest(BaseModel):
    path: str
    depth: int = Field(default=2, ge=1, le=4)
    top: int = Field(default=30, ge=5, le=200)


@router.post("/usage", status_code=202)
def usage(body: UsageRequest, request: Request):
    root = _dir(body.path, request)
    return request.app.state.jobs.submit("files.usage", ops.usage_tree, str(root), body.depth, body.top).to_dict()


class DuplicatesRequest(BaseModel):
    roots: list[str] = Field(min_length=1)
    min_size: int = Field(default=1024, ge=1)


@router.post("/duplicates", status_code=202)
def duplicates(body: DuplicatesRequest, request: Request):
    roots = [str(_dir(r, request)) for r in body.roots]
    return request.app.state.jobs.submit("files.duplicates", ops.find_duplicates, roots, body.min_size).to_dict()


# ---- quarantine (the only way officev2 "removes" files) ------------------------------------


class QuarantineRequest(BaseModel):
    paths: list[str] = Field(min_length=1)


@router.post("/quarantine")
def quarantine(body: QuarantineRequest, request: Request):
    paths = [resolve_allowed_path(p, request.app.state.settings) for p in body.paths]
    return ops.quarantine(paths, request.app.state.quarantine_dir, _recorder(request))


@router.get("/quarantine")
def quarantine_list(request: Request):
    return ops.list_quarantine(request.app.state.quarantine_dir)


class PurgeRequest(BaseModel):
    older_than_days: float = Field(ge=0)


@router.post("/quarantine/purge")
def quarantine_purge(body: PurgeRequest, request: Request):
    return ops.purge_quarantine(request.app.state.quarantine_dir, body.older_than_days)


# ---- rules (Downloads Autopilot) ---------------------------------------------------------------


class RuleBody(BaseModel):
    name: str = Field(min_length=1)
    enabled: bool = True
    folder: str
    extensions: list[str] = []
    name_regex: str = ""
    min_size: int = Field(default=0, ge=0)
    dest: str = Field(min_length=1)


def _validated_rule(body: RuleBody, request: Request) -> dict:
    data = body.model_dump()
    data["folder"] = str(_dir(body.folder, request))
    # destination may contain {ext}/{year}/{month}; validate the part before the first token
    fixed = body.dest.split("{")[0] or body.dest
    resolve_allowed_path(fixed, request.app.state.settings)
    if body.name_regex:
        import re

        try:
            re.compile(body.name_regex)
        except re.error as e:
            raise HTTPException(status_code=422, detail=f"invalid regex: {e}")
    return data


@router.get("/rules")
def rules_list(request: Request):
    return request.app.state.automation.list_rules()


@router.post("/rules", status_code=201)
def rules_create(body: RuleBody, request: Request):
    return request.app.state.automation.save_rule(_validated_rule(body, request))


@router.put("/rules/{rule_id}")
def rules_update(rule_id: int, body: RuleBody, request: Request):
    svc = request.app.state.automation
    if svc.get_rule(rule_id) is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return svc.save_rule(_validated_rule(body, request), rule_id)


@router.delete("/rules/{rule_id}")
def rules_delete(rule_id: int, request: Request):
    svc = request.app.state.automation
    if svc.get_rule(rule_id) is None:
        raise HTTPException(status_code=404, detail="rule not found")
    svc.delete_rule(rule_id)
    return {"deleted": rule_id}


@router.post("/rules/{rule_id}/run")
def rules_run(rule_id: int, request: Request):
    svc = request.app.state.automation
    rule = svc.get_rule(rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return svc.run_now(rule)
