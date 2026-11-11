"""Jobs, undo history and settings endpoints."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import extras
from .history import UndoError

router = APIRouter()


@router.get("/jobs")
def list_jobs(request: Request):
    return request.app.state.jobs.list()


@router.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    job = request.app.state.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: Request):
    jobs = request.app.state.jobs
    if jobs.get(job_id) is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {"cancelled": jobs.cancel(job_id)}


@router.get("/history")
def list_history(request: Request):
    return request.app.state.history.list()


@router.post("/history/{entry_id}/undo")
def undo(entry_id: int, request: Request):
    try:
        return request.app.state.history.undo(entry_id)
    except UndoError as e:
        raise HTTPException(status_code=409, detail=str(e))


class SettingValue(BaseModel):
    value: Any


@router.get("/settings")
def get_settings(request: Request):
    rows = request.app.state.db.query("SELECT key, value FROM settings")
    return {r["key"]: json.loads(r["value"]) for r in rows}


@router.put("/settings/{key}")
def put_setting(key: str, body: SettingValue, request: Request):
    request.app.state.db.execute(
        "INSERT INTO settings(key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(body.value)),
    )
    return {key: body.value}


@router.get("/extras")
def list_extras():
    return {"extras": extras.listing()}


@router.post("/extras/{key}/install", status_code=202)
def install_extra(key: str, request: Request):
    if key not in extras.EXTRAS:
        raise HTTPException(status_code=404, detail="unknown add-on")
    return request.app.state.jobs.submit("extras.install", extras.install, key).to_dict()
