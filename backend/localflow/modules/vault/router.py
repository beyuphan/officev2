from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ...security import resolve_allowed_path
from .service import VaultError

router = APIRouter(prefix="/vault", tags=["vault"])


def _svc(request: Request):
    return request.app.state.vault


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except VaultError as e:
        raise HTTPException(status_code=e.status, detail=str(e))


class PasswordBody(BaseModel):
    password: str


class UnlockBody(BaseModel):
    password: str | None = None
    recovery_key: str | None = None


class ChangePasswordBody(BaseModel):
    old_password: str
    new_password: str


class AddBody(BaseModel):
    paths: list[str] = Field(min_length=1)
    delete_original: bool = False  # sends the original to the Recycle Bin after a verified copy


class ExportBody(BaseModel):
    out_dir: str


@router.get("/status")
def status(request: Request):
    return _svc(request).status()


@router.post("/create", status_code=201)
def create(body: PasswordBody, request: Request):
    recovery = _run(_svc(request).create, body.password)
    return {"recovery_key": recovery}


@router.post("/unlock")
def unlock(body: UnlockBody, request: Request):
    _run(_svc(request).unlock, body.password, body.recovery_key)
    return {"unlocked": True}


@router.post("/lock")
def lock(request: Request):
    _svc(request).lock()
    return {"unlocked": False}


@router.post("/change-password")
def change_password(body: ChangePasswordBody, request: Request):
    _run(_svc(request).change_password, body.old_password, body.new_password)
    return {"changed": True}


@router.get("/items")
def items(request: Request):
    return _run(_svc(request).items)


@router.post("/items")
def add(body: AddBody, request: Request):
    paths = [resolve_allowed_path(p, request.app.state.settings) for p in body.paths]
    return _run(_svc(request).add, paths, body.delete_original)


@router.post("/items/{item_id}/export")
def export(item_id: str, body: ExportBody, request: Request):
    out_dir = resolve_allowed_path(body.out_dir, request.app.state.settings)
    if not out_dir.is_dir():
        raise HTTPException(status_code=404, detail="output folder not found")
    dest = _run(_svc(request).export, item_id, out_dir)
    return {"output": str(dest)}


@router.delete("/items/{item_id}")
def remove(item_id: str, request: Request):
    _run(_svc(request).remove, item_id)
    return {"removed": item_id}
