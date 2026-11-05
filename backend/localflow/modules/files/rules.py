"""Rule engine v1: `folder + conditions -> move to destination`. Powers Downloads Autopilot.

Rules are stored in SQLite. A watchdog observer reacts to new files; "run now" applies the same
logic to what is already in the folder. Every move is logged for undo.
"""
from __future__ import annotations

import re
import shutil
import threading
import time
from pathlib import Path

from ...db import Database
from ...history import History
from .ops import PARTIAL_SUFFIXES, unique_path

SETTLE_SECONDS = 2.0


def row_to_rule(r) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "enabled": bool(r["enabled"]),
        "folder": r["folder"],
        "extensions": [e for e in r["extensions"].split(",") if e],
        "name_regex": r["name_regex"],
        "min_size": r["min_size"],
        "dest": r["dest"],
    }


def matches(rule: dict, path: Path) -> bool:
    if path.name.lower().endswith(PARTIAL_SUFFIXES) or not path.is_file():
        return False
    exts = rule["extensions"]
    if exts and path.suffix.lower().lstrip(".") not in exts:
        return False
    if rule["name_regex"] and not re.search(rule["name_regex"], path.name, re.IGNORECASE):
        return False
    try:
        if path.stat().st_size < rule["min_size"]:
            return False
    except OSError:
        return False
    return True


def expand_dest(dest: str, path: Path) -> Path:
    t = time.localtime(path.stat().st_mtime)
    return Path(
        dest.replace("{ext}", path.suffix.lower().lstrip(".") or "other")
        .replace("{year}", f"{t.tm_year}")
        .replace("{month}", f"{t.tm_mon:02d}")
    )


def apply_rule_to_file(rule: dict, path: Path, history: History) -> Path | None:
    if not matches(rule, path):
        return None
    dest_dir = expand_dest(rule["dest"], path)
    if dest_dir.resolve() == path.parent.resolve():
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = unique_path(dest_dir / path.name)
    shutil.move(str(path), str(target))
    history.record("move", str(path), str(target))
    return target


class AutomationService:
    def __init__(self, db: Database, history: History):
        self._db = db
        self._history = history
        self._observer = None
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    # ---- rules persistence -------------------------------------------------------------
    def list_rules(self) -> list[dict]:
        return [row_to_rule(r) for r in self._db.query("SELECT * FROM rules ORDER BY id")]

    def get_rule(self, rule_id: int) -> dict | None:
        rows = self._db.query("SELECT * FROM rules WHERE id=?", (rule_id,))
        return row_to_rule(rows[0]) if rows else None

    def save_rule(self, data: dict, rule_id: int | None = None) -> dict:
        values = (
            data["name"],
            1 if data.get("enabled", True) else 0,
            data["folder"],
            ",".join(e.lower().lstrip(".") for e in data.get("extensions", [])),
            data.get("name_regex", ""),
            int(data.get("min_size", 0)),
            data["dest"],
        )
        if rule_id is None:
            rule_id = self._db.execute(
                "INSERT INTO rules(name, enabled, folder, extensions, name_regex, min_size, dest, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                values + (time.time(),),
            )
        else:
            self._db.execute(
                "UPDATE rules SET name=?, enabled=?, folder=?, extensions=?, name_regex=?, min_size=?, dest=? WHERE id=?",
                values + (rule_id,),
            )
        self.reload()
        return self.get_rule(rule_id)  # type: ignore[return-value]

    def delete_rule(self, rule_id: int) -> None:
        self._db.execute("DELETE FROM rules WHERE id=?", (rule_id,))
        self.reload()

    # ---- execution ---------------------------------------------------------------------
    def run_now(self, rule: dict) -> dict:
        folder = Path(rule["folder"])
        moved = []
        if folder.is_dir():
            for p in sorted(folder.iterdir()):
                try:
                    target = apply_rule_to_file(rule, p, self._history)
                except OSError:
                    continue
                if target:
                    moved.append(str(target))
        return {"moved": len(moved), "files": moved}

    def _process(self, path_str: str) -> None:
        with self._lock:
            self._timers.pop(path_str, None)
        path = Path(path_str)
        last = -1
        for _ in range(15):  # wait until the file stops growing (downloads)
            try:
                size = path.stat().st_size
            except OSError:
                return
            if size == last:
                break
            last = size
            time.sleep(1.0)
        for rule in self.list_rules():
            if rule["enabled"] and Path(rule["folder"]).resolve() == path.parent.resolve():
                try:
                    if apply_rule_to_file(rule, path, self._history):
                        return
                except OSError:
                    return

    def _schedule(self, path: str) -> None:
        with self._lock:
            old = self._timers.pop(path, None)
            if old:
                old.cancel()
            t = threading.Timer(SETTLE_SECONDS, self._process, args=(path,))
            t.daemon = True
            self._timers[path] = t
            t.start()

    def start(self) -> None:
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer

        service = self

        class Handler(FileSystemEventHandler):
            def on_created(self, event):
                if not event.is_directory:
                    service._schedule(event.src_path)

            def on_moved(self, event):
                if not event.is_directory:
                    service._schedule(event.dest_path)

        folders = {r["folder"] for r in self.list_rules() if r["enabled"] and Path(r["folder"]).is_dir()}
        if not folders:
            return
        self._observer = Observer()
        for f in folders:
            self._observer.schedule(Handler(), f, recursive=False)
        self._observer.start()

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=3)
            self._observer = None
        with self._lock:
            for t in self._timers.values():
                t.cancel()
            self._timers.clear()

    def reload(self) -> None:
        self.stop()
        self.start()
