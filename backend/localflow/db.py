"""SQLite storage: settings, job history, undo log. One connection guarded by a lock."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable

# Each entry upgrades the schema by one version (PRAGMA user_version).
MIGRATIONS: list[str] = [
    """
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        state       TEXT NOT NULL,
        result      TEXT,
        error       TEXT,
        created_at  REAL NOT NULL,
        finished_at REAL
    );
    CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
    CREATE TABLE undo_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        op          TEXT NOT NULL,
        source      TEXT,
        destination TEXT,
        job_id      TEXT,
        created_at  REAL NOT NULL,
        reverted_at REAL
    );
    """,
    """
    CREATE TABLE rules (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        folder     TEXT NOT NULL,
        extensions TEXT NOT NULL DEFAULT '',
        name_regex TEXT NOT NULL DEFAULT '',
        min_size   INTEGER NOT NULL DEFAULT 0,
        dest       TEXT NOT NULL,
        created_at REAL NOT NULL
    );
    """,
]


class Database:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    def _migrate(self) -> None:
        with self._lock:
            version = self._conn.execute("PRAGMA user_version").fetchone()[0]
            for i in range(version, len(MIGRATIONS)):
                self._conn.executescript(MIGRATIONS[i])
                self._conn.execute(f"PRAGMA user_version = {i + 1}")
            self._conn.commit()

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        """Run a write statement; returns lastrowid."""
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur.lastrowid

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchall()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
