"""Local API hardening: bearer token, Origin allow-list, path scoping."""
from __future__ import annotations

import hmac
from pathlib import Path

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .config import Settings


class OriginGuardMiddleware(BaseHTTPMiddleware):
    """Reject browser requests from origins that are not the officev2 UI.

    Requests without an Origin header (non-browser clients) pass here and are
    still subject to the token check.
    """

    def __init__(self, app, allowed_origins: tuple[str, ...]):
        super().__init__(app)
        self._allowed = set(allowed_origins)

    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in self._allowed:
            return JSONResponse({"detail": "origin not allowed"}, status_code=403)
        return await call_next(request)


def require_token(request: Request) -> None:
    settings: Settings = request.app.state.settings
    header = request.headers.get("authorization", "")
    scheme, _, supplied = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(supplied, settings.token):
        raise HTTPException(status_code=401, detail="invalid or missing token")


def resolve_allowed_path(raw: str, settings: Settings) -> Path:
    """Resolve a user-supplied path and ensure it lies inside an allowed root."""
    path = Path(raw).expanduser().resolve()
    for root in settings.allowed_roots:
        if path == root or root in path.parents:
            return path
    raise HTTPException(status_code=403, detail=f"path outside allowed locations: {raw}")
