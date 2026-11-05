"""Job-side helpers: progress reporting and cooperative cancellation.

The functions below run inside pool worker processes. The shared dicts are
multiprocessing manager proxies handed over by the JobManager.
"""
from __future__ import annotations

from typing import Any, Callable

_ctx: tuple[str, Any, Any] | None = None


class Cancelled(Exception):
    """Raised inside a job when the user cancelled it."""


def run(fn: Callable[..., Any], args: tuple, kwargs: dict, job_id: str, progress: Any, cancel: Any) -> Any:
    global _ctx
    _ctx = (job_id, progress, cancel)
    try:
        return fn(*args, **kwargs)
    finally:
        _ctx = None


def report(done: float, total: float, message: str = "") -> None:
    if _ctx is not None:
        _ctx[1][_ctx[0]] = {"done": done, "total": total, "message": message}


def cancelled() -> bool:
    return _ctx is not None and bool(_ctx[2].get(_ctx[0]))


def check() -> None:
    if cancelled():
        raise Cancelled("cancelled")


def _selftest_sleep(seconds: float) -> dict:
    """Used by tests to exercise progress and cancellation."""
    import time

    end = time.time() + seconds
    i = 0
    while time.time() < end:
        check()
        report(i, 100, "tick")
        i += 1
        time.sleep(0.05)
    return {"slept": seconds}
