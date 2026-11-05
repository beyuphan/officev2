"""File automation primitives: rename plans, junk/temp scans, disk usage, duplicates, quarantine.

Nothing here deletes user data. Removal means "move into the quarantine folder", and every move is
logged by the caller so it can be undone.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from ... import jobctl

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------

PARTIAL_SUFFIXES = (".crdownload", ".part", ".partial", ".tmp", ".download", ".opdownload")


def unique_path(path: Path) -> Path:
    """`name.ext` -> `name (1).ext` if taken."""
    if not path.exists():
        return path
    n = 1
    while True:
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def dir_size(path: Path) -> int:
    total = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        else:
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def entry_size(path: Path) -> int:
    try:
        return dir_size(path) if path.is_dir() and not path.is_symlink() else path.stat().st_size
    except OSError:
        return 0


def is_protected(path: Path) -> bool:
    """Never allow acting on a drive root, the home folder itself, or its direct children like Documents."""
    p = path.resolve()
    home = Path.home().resolve()
    if p.parent == p or p == home or p.parent == home:
        return True
    return False


# ---------------------------------------------------------------------------------------------
# bulk rename
# ---------------------------------------------------------------------------------------------

_NUM = re.compile(r"\{n(?::0?(\d+))?\}")


def _apply_numbering(text: str, n: int) -> str:
    def repl(m: re.Match) -> str:
        width = int(m.group(1)) if m.group(1) else 0
        return str(n).zfill(width)

    return _NUM.sub(repl, text)


def rename_plan(
    folder: Path,
    pattern: str,
    replacement: str,
    use_regex: bool = False,
    ignore_case: bool = False,
    include_extension: bool = False,
    recursive: bool = False,
    start_at: int = 1,
) -> list[dict]:
    """Preview of renames. Replacement may use {n} / {n:03} counters and, with regex, \\1 groups."""
    if not pattern:
        raise ValueError("pattern is empty")
    flags = re.IGNORECASE if ignore_case else 0
    try:
        rx = re.compile(pattern if use_regex else re.escape(pattern), flags)
    except re.error as e:
        raise ValueError(f"invalid pattern: {e}")

    files: list[Path] = []
    if recursive:
        for root, _dirs, names in os.walk(folder):
            files.extend(Path(root) / n for n in sorted(names))
    else:
        files = sorted(p for p in folder.iterdir() if p.is_file())

    plan: list[dict] = []
    counter = start_at
    for f in files:
        name = f.name if include_extension else f.stem
        if not rx.search(name):
            continue
        new = rx.sub(lambda m: _apply_numbering(m.expand(replacement) if use_regex else replacement, counter), name)
        counter += 1
        new_name = new if include_extension else new + f.suffix
        plan.append({"source": str(f), "target": str(f.with_name(new_name)), "conflict": None})

    sources = {item["source"].lower() for item in plan}
    seen: dict[str, int] = {}
    for item in plan:
        key = item["target"].lower()
        seen[key] = seen.get(key, 0) + 1
    for item in plan:
        key = item["target"].lower()
        if item["target"] == item["source"]:
            item["conflict"] = "unchanged"
        elif not Path(item["target"]).name.strip(" ."):
            item["conflict"] = "empty name"
        elif seen[key] > 1:
            item["conflict"] = "duplicate target"
        elif Path(item["target"]).exists() and key not in sources:
            item["conflict"] = "target exists"
    return plan


def apply_renames(plan: list[dict], record) -> dict:
    """Apply non-conflicting items. `record(op, source, destination)` logs for undo."""
    done, skipped = [], []
    for item in plan:
        src, dst = Path(item["source"]), Path(item["target"])
        if item.get("conflict") or not src.exists() or dst.exists():
            skipped.append({"source": item["source"], "reason": item.get("conflict") or "changed on disk"})
            continue
        try:
            src.rename(dst)
        except OSError as e:
            skipped.append({"source": item["source"], "reason": str(e)})
            continue
        record("move", str(src), str(dst))
        done.append(str(dst))
    return {"renamed": len(done), "skipped": skipped}


# ---------------------------------------------------------------------------------------------
# quarantine
# ---------------------------------------------------------------------------------------------


def quarantine(paths: list[Path], root: Path, record) -> dict:
    """Move paths into root/<batch>/. Returns moved/failed lists. Logged for undo."""
    batch = root / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    moved, failed, freed = [], [], 0
    for i, p in enumerate(paths):
        jobctl.check()
        if is_protected(p):
            failed.append({"path": str(p), "reason": "protected location"})
            continue
        if not p.exists():
            failed.append({"path": str(p), "reason": "not found"})
            continue
        size = entry_size(p)
        dest = batch / f"{i:04d}_{p.name}"
        try:
            batch.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
        except OSError as e:
            failed.append({"path": str(p), "reason": str(e)})
            continue
        record("quarantine", str(p), str(dest))
        moved.append(str(p))
        freed += size
    return {"moved": len(moved), "freed_bytes": freed, "failed": failed, "batch": str(batch) if moved else None}


def list_quarantine(root: Path) -> list[dict]:
    if not root.is_dir():
        return []
    out = []
    for b in sorted(root.iterdir()):
        if b.is_dir():
            out.append({"batch": b.name, "size": dir_size(b), "created_at": b.stat().st_mtime})
    return out


def purge_quarantine(root: Path, older_than_days: float) -> dict:
    """Permanently remove quarantine batches older than N days. The only deletion officev2 performs."""
    cutoff = time.time() - older_than_days * 86400
    removed, freed = 0, 0
    for item in list_quarantine(root):
        if item["created_at"] <= cutoff:
            shutil.rmtree(root / item["batch"], ignore_errors=True)
            removed += 1
            freed += item["size"]
    return {"removed_batches": removed, "freed_bytes": freed}


# ---------------------------------------------------------------------------------------------
# scans (run as jobs)
# ---------------------------------------------------------------------------------------------


def scan_temp(roots: list[str], older_than_days: float = 1.0) -> dict:
    cutoff = time.time() - older_than_days * 86400
    items, total = [], 0
    for r in roots:
        root = Path(r)
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            jobctl.check()
            try:
                if entry.is_symlink() or entry.stat().st_mtime > cutoff:
                    continue
            except OSError:
                continue
            size = entry_size(entry)
            total += size
            items.append({"path": str(entry), "size": size, "is_dir": entry.is_dir()})
    items.sort(key=lambda i: i["size"], reverse=True)
    return {"items": items, "total_size": total}


JUNK_KINDS = {
    "node_modules": None,
    "__pycache__": None,
    ".pytest_cache": None,
    ".mypy_cache": None,
    ".ruff_cache": None,
    ".next": None,
    ".nuxt": None,
    ".gradle": None,
    ".parcel-cache": None,
    "target": "Cargo.toml",  # only when a Rust project sits next to it
    ".venv": "pyvenv.cfg",
    "venv": "pyvenv.cfg",
}
PRUNE = {".git", "AppData", "$RECYCLE.BIN", "System Volume Information"}


def scan_dev_junk(root: str) -> dict:
    items, total, n = [], 0, 0
    for current, dirs, _files in os.walk(root, topdown=True):
        n += 1
        if n % 200 == 0:
            jobctl.check()
            jobctl.report(n, 0, current)
        keep = []
        for d in dirs:
            full = Path(current) / d
            marker = JUNK_KINDS.get(d, "")
            if d in PRUNE:
                continue
            if marker == "":
                keep.append(d)
                continue
            if d == "target":
                ok = (Path(current) / marker).exists()
            elif marker:
                ok = (full / marker).exists()
            else:
                ok = True
            if ok:
                size = dir_size(full)
                total += size
                items.append({"path": str(full), "kind": d, "size": size})
            else:
                keep.append(d)
        dirs[:] = keep
    items.sort(key=lambda i: i["size"], reverse=True)
    return {"items": items, "total_size": total}


def usage_tree(path: str, depth: int = 2, top: int = 30) -> dict:
    """Size tree for a treemap. Children beyond `top` are merged into one '(other)' node."""
    counter = {"n": 0}

    def build(p: Path, level: int) -> dict:
        counter["n"] += 1
        if counter["n"] % 100 == 0:
            jobctl.check()
            jobctl.report(counter["n"], 0, str(p))
        node = {"name": p.name or str(p), "path": str(p), "size": 0, "is_dir": True, "children": []}
        kids = []
        try:
            with os.scandir(p) as it:
                entries = list(it)
        except OSError:
            return node
        files_size = 0
        for e in entries:
            try:
                if e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    kids.append(build(Path(e.path), level + 1) if level < depth else _leaf_dir(Path(e.path)))
                else:
                    sz = e.stat(follow_symlinks=False).st_size
                    files_size += sz
                    if level < depth:
                        kids.append({"name": e.name, "path": e.path, "size": sz, "is_dir": False, "children": []})
            except OSError:
                continue
        kids.sort(key=lambda k: k["size"], reverse=True)
        node["size"] = sum(k["size"] for k in kids) + (files_size if level >= depth else 0)
        if level < depth:
            # sizes of files are already counted through kids
            node["size"] = sum(k["size"] for k in kids)
        if len(kids) > top:
            rest = kids[top:]
            kids = kids[:top] + [
                {"name": "(other)", "path": str(p), "size": sum(k["size"] for k in rest), "is_dir": False, "children": []}
            ]
        node["children"] = kids if level < depth else []
        return node

    def _leaf_dir(p: Path) -> dict:
        return {"name": p.name, "path": str(p), "size": dir_size(p), "is_dir": True, "children": []}

    return build(Path(path), 0)


def _hash_file(path: Path, limit: int | None = None) -> str:
    h = hashlib.blake2b(digest_size=20)
    with open(path, "rb") as f:
        remaining = limit
        while True:
            chunk = f.read(1 << 20 if remaining is None else min(1 << 20, remaining))
            if not chunk:
                break
            h.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
                if remaining <= 0:
                    break
    return h.hexdigest()


def find_duplicates(roots: list[str], min_size: int = 1024) -> dict:
    by_size: dict[int, list[Path]] = {}
    scanned = 0
    for r in roots:
        for current, dirs, files in os.walk(r):
            dirs[:] = [d for d in dirs if d not in PRUNE and d not in JUNK_KINDS]
            for name in files:
                p = Path(current) / name
                try:
                    if p.is_symlink():
                        continue
                    size = p.stat().st_size
                except OSError:
                    continue
                if size >= min_size:
                    by_size.setdefault(size, []).append(p)
                scanned += 1
                if scanned % 500 == 0:
                    jobctl.check()
                    jobctl.report(scanned, 0, "scanning")
    groups = []
    candidates = [(s, ps) for s, ps in by_size.items() if len(ps) > 1]
    for i, (size, paths) in enumerate(candidates):
        jobctl.check()
        jobctl.report(i, len(candidates), "hashing")
        by_head: dict[str, list[Path]] = {}
        for p in paths:
            try:
                by_head.setdefault(_hash_file(p, 65536), []).append(p)
            except OSError:
                continue
        for same_head in by_head.values():
            if len(same_head) < 2:
                continue
            by_full: dict[str, list[Path]] = {}
            for p in same_head:
                try:
                    by_full.setdefault(_hash_file(p), []).append(p)
                except OSError:
                    continue
            for same in by_full.values():
                if len(same) > 1:
                    groups.append({"size": size, "files": sorted(str(p) for p in same)})
    groups.sort(key=lambda g: g["size"] * (len(g["files"]) - 1), reverse=True)
    wasted = sum(g["size"] * (len(g["files"]) - 1) for g in groups)
    return {"groups": groups, "wasted_bytes": wasted}
