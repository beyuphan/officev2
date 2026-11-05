"""Undo log. Files are never deleted: undoing a creation moves it to the trash folder."""
from __future__ import annotations

import shutil
import time
from pathlib import Path

from .db import Database


class UndoError(Exception):
    pass


class History:
    def __init__(self, db: Database, trash_dir: Path):
        self._db = db
        self._trash = trash_dir

    def record(self, op: str, source: str | None, destination: str | None, job_id: str | None = None) -> int:
        return self._db.execute(
            "INSERT INTO undo_log(op, source, destination, job_id, created_at) VALUES (?,?,?,?,?)",
            (op, source, destination, job_id, time.time()),
        )

    def list(self, limit: int = 200) -> list[dict]:
        rows = self._db.query("SELECT * FROM undo_log ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(r) for r in rows]

    def undo(self, entry_id: int) -> dict:
        rows = self._db.query("SELECT * FROM undo_log WHERE id=?", (entry_id,))
        if not rows:
            raise UndoError("entry not found")
        entry = dict(rows[0])
        if entry["reverted_at"] is not None:
            raise UndoError("already reverted")
        dest = Path(entry["destination"])
        if entry["op"] in ("move", "quarantine"):
            return self._undo_move(entry, dest)
        if entry["op"] != "create":
            raise UndoError(f"cannot undo operation '{entry['op']}'")
        if not dest.exists():
            raise UndoError("the file no longer exists")
        self._trash.mkdir(parents=True, exist_ok=True)
        target = self._trash / f"{entry_id}_{dest.name}"
        shutil.move(str(dest), str(target))
        self._db.execute("UPDATE undo_log SET reverted_at=? WHERE id=?", (time.time(), entry_id))
        return {"id": entry_id, "moved_to": str(target)}

    def _undo_move(self, entry: dict, moved: Path) -> dict:
        original = Path(entry["source"])
        if not moved.exists():
            raise UndoError("the moved file no longer exists")
        if original.exists():
            raise UndoError("the original location is occupied")
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(moved), str(original))
        self._db.execute("UPDATE undo_log SET reverted_at=? WHERE id=?", (time.time(), entry["id"]))
        return {"id": entry["id"], "restored_to": str(original)}
