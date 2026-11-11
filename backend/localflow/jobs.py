"""Job Manager: runs long tasks in a process pool, persists history to SQLite."""
from __future__ import annotations

import json
import multiprocessing
import time
import uuid
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from typing import Any, Callable

from . import jobctl
from .db import Database
from .history import History

QUEUED, RUNNING, DONE, FAILED, CANCELLED = "queued", "running", "done", "failed", "cancelled"
TERMINAL = (DONE, FAILED, CANCELLED)


@dataclass
class Job:
    id: str
    type: str
    state: str = QUEUED
    result: Any = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    created_files: list[str] = field(default_factory=list)
    _future: Future | None = field(default=None, repr=False)
    _manager: "JobManager | None" = field(default=None, repr=False)

    def refresh(self) -> None:
        f = self._future
        if f is None or self.state in TERMINAL:
            return
        if f.cancelled():
            self.state = CANCELLED
        elif f.done():
            exc = f.exception()
            if isinstance(exc, jobctl.Cancelled):
                self.state = CANCELLED
            elif isinstance(exc, BrokenProcessPool):
                self.state, self.error = FAILED, "The worker stopped unexpectedly (a file may be damaged). Try again."
                if self._manager is not None:
                    self._manager.reset_pool()
            elif exc is not None:
                self.state, self.error = FAILED, str(exc)
            else:
                self.state, self.result = DONE, f.result()
        elif f.running():
            self.state = RUNNING
        if self.state in TERMINAL and self._manager is not None:
            self._manager._finish(self)

    def to_dict(self) -> dict:
        self.refresh()
        progress = None
        if self._manager is not None and self.state not in TERMINAL:
            progress = self._manager.progress_of(self.id)
        return {
            "id": self.id,
            "type": self.type,
            "state": self.state,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "progress": progress,
        }


class JobManager:
    def __init__(self, db: Database, history: History, max_workers: int = 2):
        self._db = db
        self._history = history
        self._max_workers = max_workers
        self._pool = ProcessPoolExecutor(max_workers=max_workers)
        self._mp = multiprocessing.Manager()
        self._progress = self._mp.dict()
        self._cancel = self._mp.dict()
        self._jobs: dict[str, Job] = {}
        # Anything still queued/running belongs to a previous run that died.
        db.execute(
            "UPDATE jobs SET state='failed', error='interrupted by restart', finished_at=? "
            "WHERE state IN ('queued','running')",
            (time.time(),),
        )

    def reset_pool(self) -> None:
        old, self._pool = self._pool, ProcessPoolExecutor(max_workers=self._max_workers)
        old.shutdown(wait=False, cancel_futures=False)

    def progress_of(self, job_id: str) -> dict | None:
        p = self._progress.get(job_id)
        return dict(p) if p else None

    def submit(
        self,
        job_type: str,
        fn: Callable[..., Any],
        *args: Any,
        creates: list[str] | None = None,
        **kwargs: Any,
    ) -> Job:
        """`fn` must be a picklable, module-level function.

        `creates` lists files the job will produce; they are logged for undo on success.
        Inside `fn`, use `localflow.jobctl.report/check` for progress and cancellation.
        """
        job = Job(id=uuid.uuid4().hex, type=job_type, created_files=list(creates or []), _manager=self)
        self._db.execute(
            "INSERT INTO jobs(id, type, state, created_at) VALUES (?,?,?,?)",
            (job.id, job.type, job.state, job.created_at),
        )
        try:
            job._future = self._pool.submit(jobctl.run, fn, args, kwargs, job.id, self._progress, self._cancel)
        except BrokenProcessPool:  # an earlier job crashed a worker: start fresh instead of failing every job from now on
            self.reset_pool()
            job._future = self._pool.submit(jobctl.run, fn, args, kwargs, job.id, self._progress, self._cancel)
        self._jobs[job.id] = job
        return job

    def _finish(self, job: Job) -> None:
        self._db.execute(
            "UPDATE jobs SET state=?, result=?, error=?, finished_at=? WHERE id=?",
            (job.state, json.dumps(job.result) if job.result is not None else None, job.error, time.time(), job.id),
        )
        if job.state == DONE:
            created = list(job.created_files)
            if isinstance(job.result, dict):  # jobs whose outputs are only known after they ran
                created += [str(p) for p in job.result.get("created", [])]
            for path in created:
                self._history.record("create", None, path, job.id)
        self._progress.pop(job.id, None)
        self._cancel.pop(job.id, None)
        self._jobs.pop(job.id, None)

    def get(self, job_id: str) -> dict | None:
        live = self._jobs.get(job_id)
        if live is not None:
            d = live.to_dict()
            if live.state not in TERMINAL:
                return d
        rows = self._db.query("SELECT * FROM jobs WHERE id=?", (job_id,))
        return self._row(rows[0]) if rows else None

    def list(self, limit: int = 100) -> list[dict]:
        for job in list(self._jobs.values()):
            job.refresh()  # persists any that have just finished
        rows = self._db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))
        out = []
        for r in rows:
            d = self._row(r)
            live = self._jobs.get(d["id"])
            d["progress"] = self.progress_of(d["id"]) if live is not None else None
            out.append(d)
        return out

    @staticmethod
    def _row(r) -> dict:
        return {
            "id": r["id"],
            "type": r["type"],
            "state": r["state"],
            "result": json.loads(r["result"]) if r["result"] else None,
            "error": r["error"],
            "created_at": r["created_at"],
            "progress": None,
        }

    def cancel(self, job_id: str) -> bool:
        """Queued jobs are dropped; running jobs stop at their next cancellation check."""
        job = self._jobs.get(job_id)
        if job is None or job._future is None or job.state in TERMINAL:
            return False
        if job._future.cancel():
            job.refresh()
            return True
        self._cancel[job_id] = True
        return True

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
        try:
            self._mp.shutdown()
        except Exception:
            pass
