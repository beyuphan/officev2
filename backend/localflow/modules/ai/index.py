"""Shared index service: document chunks + multilingual embeddings in a local sqlite-vec file.

Used by "chat with your documents" and by semantic file search. Nothing leaves the machine.
Only user-chosen folders are indexed.
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path

import sqlite_vec

from ... import jobctl, models

DIM = 384  # paraphrase-multilingual-MiniLM-L12-v2
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".log", ".json", ".yaml", ".yml", ".py", ".js", ".ts", ".html", ".rst"}
INDEXABLE = TEXT_EXTS | {".pdf", ".docx"}
CHUNK_CHARS = 900
OVERLAP = 120
MAX_FILE_BYTES = 50 * 1024 * 1024


def chunk_text(text: str, size: int = CHUNK_CHARS, overlap: int = OVERLAP) -> list[str]:
    text = " ".join(text.split())
    if not text:
        return []
    chunks, start = [], 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):  # prefer a sentence boundary, then a word boundary, in the second half
            sentence = text.rfind(". ", start + size // 2, end)
            if sentence != -1:
                end = sentence + 1
            else:
                word = text.rfind(" ", start + size // 2, end)
                if word != -1:
                    end = word
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return [c for c in chunks if c]


def extract(path: Path) -> list[tuple[int, str]]:
    """[(page, text)] for a file. Page is 1-based for PDFs, 0 otherwise."""
    ext = path.suffix.lower()
    if ext == ".pdf":
        import pymupdf

        with pymupdf.open(path) as doc:
            if doc.needs_pass:
                return []
            return [(i + 1, p.get_text()) for i, p in enumerate(doc)]
    if ext == ".docx":
        from docx import Document

        return [(0, "\n".join(p.text for p in Document(str(path)).paragraphs))]
    return [(0, path.read_text(encoding="utf-8", errors="replace"))]


class Embedder:
    """Lazy, process-local wrapper around fastembed."""

    def __init__(self, data_dir: str):
        self._data_dir = data_dir
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is None:
            from fastembed import TextEmbedding

            cache = models.ensure(self._data_dir, "embed-multilingual")
            self._model = TextEmbedding(model_name=models.MULTILINGUAL_EMBEDDER, cache_dir=str(cache))
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        with self._lock:
            return [list(map(float, v)) for v in self._load().embed(texts)]


class Index:
    def __init__(self, db_path: str | Path, data_dir: str, embedder: Embedder | None = None):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)
        self._conn.enable_load_extension(False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.RLock()
        self.embedder = embedder or Embedder(data_dir)
        with self._lock:
            self._conn.executescript(
                f"""
                CREATE TABLE IF NOT EXISTS docs(
                    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, mtime REAL NOT NULL,
                    size INTEGER NOT NULL, indexed_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS chunks(
                    id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                    page INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY);
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[{DIM}]);
                """
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- sources ---------------------------------------------------------------------------
    def sources(self) -> list[str]:
        with self._lock:
            return [r["path"] for r in self._conn.execute("SELECT path FROM sources ORDER BY path")]

    def add_source(self, path: str) -> None:
        with self._lock:
            self._conn.execute("INSERT OR IGNORE INTO sources(path) VALUES (?)", (path,))
            self._conn.commit()

    def remove_source(self, path: str) -> int:
        """Forget a folder and everything indexed under it."""
        with self._lock:
            docs = [r["id"] for r in self._conn.execute("SELECT id FROM docs WHERE path LIKE ?", (path.rstrip("\\/") + "%",))]
            for d in docs:
                self._delete_doc(d)
            self._conn.execute("DELETE FROM sources WHERE path=?", (path,))
            self._conn.commit()
            return len(docs)

    # ---- indexing --------------------------------------------------------------------------------
    def _delete_doc(self, doc_id: int) -> None:
        ids = [r["id"] for r in self._conn.execute("SELECT id FROM chunks WHERE doc_id=?", (doc_id,))]
        for cid in ids:
            self._conn.execute("DELETE FROM vec_chunks WHERE rowid=?", (cid,))
        self._conn.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
        self._conn.execute("DELETE FROM docs WHERE id=?", (doc_id,))

    def _index_file(self, path: Path) -> int:
        st = path.stat()
        with self._lock:
            row = self._conn.execute("SELECT id, mtime, size FROM docs WHERE path=?", (str(path),)).fetchone()
            if row and row["mtime"] == st.st_mtime and row["size"] == st.st_size:
                return 0  # unchanged
        pieces: list[tuple[int, int, str]] = []
        order = 0
        for page, text in extract(path):
            for c in chunk_text(text):
                pieces.append((page, order, c))
                order += 1
        vectors = self.embedder.embed([p[2] for p in pieces]) if pieces else []
        with self._lock:
            if row:
                self._delete_doc(row["id"])
            doc_id = self._conn.execute(
                "INSERT INTO docs(path, mtime, size, indexed_at) VALUES (?,?,?,?)",
                (str(path), st.st_mtime, st.st_size, time.time()),
            ).lastrowid
            for (page, ord_, text), vec in zip(pieces, vectors):
                cid = self._conn.execute(
                    "INSERT INTO chunks(doc_id, page, ord, text) VALUES (?,?,?,?)", (doc_id, page, ord_, text)
                ).lastrowid
                self._conn.execute(
                    "INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)", (cid, sqlite_vec.serialize_float32(vec))
                )
            self._conn.commit()
        return len(pieces)

    def index_paths(self, paths: list[str]) -> dict:
        files: list[Path] = []
        for raw in paths:
            p = Path(raw)
            if p.is_dir():
                for root, dirs, names in os.walk(p):
                    dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", "venv")]
                    files.extend(Path(root) / n for n in names if (Path(root) / n).suffix.lower() in INDEXABLE)
            elif p.is_file() and p.suffix.lower() in INDEXABLE:
                files.append(p)
        indexed = skipped = chunks = 0
        failed: list[dict] = []
        for i, f in enumerate(files):
            jobctl.check()
            jobctl.report(i, len(files), f.name)
            try:
                if f.stat().st_size > MAX_FILE_BYTES:
                    failed.append({"path": str(f), "reason": "file too large"})
                    continue
                n = self._index_file(f)
            except jobctl.Cancelled:
                raise
            except Exception as e:
                failed.append({"path": str(f), "reason": str(e)})
                continue
            if n:
                indexed += 1
                chunks += n
            else:
                skipped += 1
        removed = self._prune(paths)
        return {"files": len(files), "indexed": indexed, "unchanged": skipped, "chunks": chunks, "removed": removed, "failed": failed}

    def _prune(self, roots: list[str]) -> int:
        """Drop index entries whose file vanished, but only below the folders just scanned."""
        removed = 0
        with self._lock:
            for r in roots:
                prefix = r.rstrip("\\/")
                if not Path(r).is_dir():
                    continue
                for row in self._conn.execute("SELECT id, path FROM docs WHERE path LIKE ?", (prefix + "%",)).fetchall():
                    if not Path(row["path"]).exists():
                        self._delete_doc(row["id"])
                        removed += 1
            self._conn.commit()
        return removed

    # ---- querying -------------------------------------------------------------------------------------
    def stats(self) -> dict:
        with self._lock:
            return {
                "documents": self._conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0],
                "chunks": self._conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
                "sources": self.sources(),
            }

    def search(self, query: str, k: int = 5, per_document: bool = False) -> list[dict]:
        if not query.strip():
            return []
        qvec = self.embedder.embed([query])[0]
        with self._lock:
            hits = self._conn.execute(
                "SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                (sqlite_vec.serialize_float32(qvec), max(k * 4 if per_document else k, k)),
            ).fetchall()
            out, seen = [], set()
            for h in hits:
                row = self._conn.execute(
                    "SELECT c.text, c.page, d.path FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id=?",
                    (h["rowid"],),
                ).fetchone()
                if row is None or (per_document and row["path"] in seen):
                    continue
                seen.add(row["path"])
                out.append({"path": row["path"], "page": row["page"], "text": row["text"], "distance": h["distance"]})
                if len(out) >= k:
                    break
            return out


def index_job(db_path: str, data_dir: str, paths: list[str]) -> dict:
    """Pool job: index folders/files with a process-local connection and embedder."""
    idx = Index(db_path, data_dir)
    try:
        return idx.index_paths(paths)
    finally:
        idx.close()
