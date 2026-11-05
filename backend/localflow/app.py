from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings
from .db import Database
from .history import History
from .jobs import JobManager
from .modules.ai.index import Index
from .modules.ai.router import router as ai_router
from .modules.files.router import router as files_router
from .modules.media.router import router as media_router
from .modules.files.rules import AutomationService
from .modules.pdf.router import router as pdf_router
from .modules.photo.router import router as photo_router
from .modules.vault.router import router as vault_router
from .modules.vault.service import VaultService
from .security import OriginGuardMiddleware, require_token
from .system_router import router as system_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(settings.data_dir / "localflow.db")
        history = History(db, settings.data_dir / "trash")
        app.state.db = db
        app.state.history = history
        app.state.jobs = JobManager(db, history)
        app.state.quarantine_dir = settings.data_dir / "quarantine"
        app.state.automation = AutomationService(db, history)
        app.state.automation.start()
        app.state.vault = VaultService(settings.data_dir / "vault")
        app.state.index_path = settings.data_dir / "index.db"
        app.state.index = Index(app.state.index_path, str(settings.data_dir))
        yield
        app.state.vault.lock()
        app.state.index.close()
        app.state.automation.stop()
        app.state.jobs.shutdown()
        db.close()

    app = FastAPI(
        title="officev2 Engine",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(require_token)],
    )
    app.state.settings = settings
    app.add_middleware(OriginGuardMiddleware, allowed_origins=settings.allowed_origins)
    # Added last so it is outermost: answers CORS preflights (which carry no token)
    # for the officev2 UI origins only.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["authorization", "content-type"],
    )

    @app.get("/health")
    def health():
        return {"status": "ok"}

    app.include_router(system_router)
    app.include_router(pdf_router)
    app.include_router(files_router)
    app.include_router(media_router)
    app.include_router(photo_router)
    app.include_router(ai_router)
    app.include_router(vault_router)
    return app
