"""Vault storage and session state."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from . import crypto
from ..files.ops import unique_path

IDLE_LOCK_SECONDS = 300
MIN_PASSWORD = 8


class VaultError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class VaultService:
    def __init__(self, root: Path):
        self.root = root
        self._dk: bytearray | None = None
        self._last_use = 0.0
        self._lock = threading.RLock()

    # ---- paths ----------------------------------------------------------------------------
    @property
    def _meta_path(self) -> Path:
        return self.root / "vault.json"

    @property
    def _index_path(self) -> Path:
        return self.root / "index.enc"

    @property
    def _blobs(self) -> Path:
        return self.root / "blobs"

    def exists(self) -> bool:
        return self._meta_path.is_file()

    def _meta(self) -> dict:
        return json.loads(self._meta_path.read_text(encoding="utf-8"))

    # ---- session -------------------------------------------------------------------------------
    def _expire(self) -> None:
        if self._dk is not None and time.time() - self._last_use > IDLE_LOCK_SECONDS:
            self.lock()

    def status(self) -> dict:
        with self._lock:
            self._expire()
            return {"exists": self.exists(), "unlocked": self._dk is not None, "idle_lock_seconds": IDLE_LOCK_SECONDS}

    def lock(self) -> None:
        with self._lock:
            if self._dk is not None:
                for i in range(len(self._dk)):  # best-effort wipe
                    self._dk[i] = 0
            self._dk = None

    def _key(self) -> bytes:
        with self._lock:
            self._expire()
            if self._dk is None:
                raise VaultError("the vault is locked", 423)
            self._last_use = time.time()
            return bytes(self._dk)

    # ---- lifecycle ------------------------------------------------------------------------------
    def create(self, password: str) -> str:
        """Create the vault and return the recovery key (shown to the user exactly once)."""
        if self.exists():
            raise VaultError("a vault already exists", 409)
        if len(password) < MIN_PASSWORD:
            raise VaultError(f"the password must have at least {MIN_PASSWORD} characters", 422)
        dk = os.urandom(32)
        salt = os.urandom(16)
        params = dict(crypto.KDF_DEFAULT)
        recovery = crypto.new_recovery_key()
        meta = {
            "version": 1,
            "kdf": {"salt": salt.hex(), **params},
            "wrapped_pw": crypto.wrap(crypto.derive_password_key(password, salt, params), dk, b"lf-pw"),
            "wrapped_rk": crypto.wrap(crypto.derive_recovery_key(recovery), dk, b"lf-rk"),
        }
        self.root.mkdir(parents=True, exist_ok=True)
        self._blobs.mkdir(exist_ok=True)
        self._atomic_write(self._meta_path, json.dumps(meta).encode())
        self._dk = bytearray(dk)
        self._last_use = time.time()
        self._save_index([])
        return recovery

    def unlock(self, password: str | None = None, recovery_key: str | None = None) -> None:
        if not self.exists():
            raise VaultError("no vault has been created yet", 404)
        meta = self._meta()
        try:
            if recovery_key:
                dk = crypto.unwrap(crypto.derive_recovery_key(recovery_key), meta["wrapped_rk"], b"lf-rk")
            elif password is not None:
                kdf = meta["kdf"]
                kek = crypto.derive_password_key(password, bytes.fromhex(kdf["salt"]), kdf)
                dk = crypto.unwrap(kek, meta["wrapped_pw"], b"lf-pw")
            else:
                raise VaultError("a password or recovery key is required", 422)
        except (crypto.VaultCryptoError, ValueError):
            time.sleep(1.0)  # slow down guessing on top of Argon2
            raise VaultError("wrong password or recovery key", 401)
        with self._lock:
            self._dk = bytearray(dk)
            self._last_use = time.time()

    def change_password(self, old: str, new: str) -> None:
        if len(new) < MIN_PASSWORD:
            raise VaultError(f"the password must have at least {MIN_PASSWORD} characters", 422)
        self.unlock(password=old)
        meta = self._meta()
        salt = os.urandom(16)
        params = dict(crypto.KDF_DEFAULT)
        meta["kdf"] = {"salt": salt.hex(), **params}
        meta["wrapped_pw"] = crypto.wrap(crypto.derive_password_key(new, salt, params), self._key(), b"lf-pw")
        self._atomic_write(self._meta_path, json.dumps(meta).encode())

    # ---- items --------------------------------------------------------------------------------------
    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def _load_index(self) -> list[dict]:
        dk = self._key()
        try:
            return json.loads(crypto.open_sealed(dk, self._index_path.read_bytes(), b"lf-index"))
        except crypto.VaultCryptoError as e:
            raise VaultError(str(e), 500)

    def _save_index(self, items: list[dict]) -> None:
        self._atomic_write(self._index_path, crypto.seal(self._key(), json.dumps(items).encode(), b"lf-index"))

    def items(self) -> list[dict]:
        with self._lock:
            return self._load_index()

    def add(self, paths: list[Path], delete_original: bool = False) -> dict:
        added, failed = [], []
        with self._lock:
            dk = self._key()
            index = self._load_index()
            for p in paths:
                if not p.is_file():
                    failed.append({"path": str(p), "reason": "not a file"})
                    continue
                fid = uuid.uuid4().hex
                blob = self._blobs / f"{fid}.enc"
                try:
                    with open(p, "rb") as src, open(blob, "wb") as dst:
                        size = crypto.encrypt_stream(dk, src, dst, fid.encode())
                    # verify before anything is removed from the original location
                    with open(blob, "rb") as chk:
                        crypto.decrypt_stream(dk, chk, _Null(), fid.encode())
                except Exception as e:
                    blob.unlink(missing_ok=True)
                    failed.append({"path": str(p), "reason": str(e)})
                    continue
                index.append({"id": fid, "name": p.name, "size": size, "added_at": time.time()})
                added.append(p.name)
                if delete_original:
                    from send2trash import send2trash

                    send2trash(str(p))  # Recycle Bin, so the user can still recover it
            self._save_index(index)
        return {"added": added, "failed": failed}

    def export(self, item_id: str, out_dir: Path) -> Path:
        with self._lock:
            dk = self._key()
            item = next((i for i in self._load_index() if i["id"] == item_id), None)
            if item is None:
                raise VaultError("item not found", 404)
            dest = unique_path(out_dir / item["name"])
            try:
                with open(self._blobs / f"{item_id}.enc", "rb") as src, open(dest, "wb") as dst:
                    crypto.decrypt_stream(dk, src, dst, item_id.encode())
            except crypto.VaultCryptoError as e:
                dest.unlink(missing_ok=True)
                raise VaultError(str(e), 500)
            return dest

    def remove(self, item_id: str) -> None:
        with self._lock:
            index = self._load_index()
            if not any(i["id"] == item_id for i in index):
                raise VaultError("item not found", 404)
            self._save_index([i for i in index if i["id"] != item_id])
            (self._blobs / f"{item_id}.enc").unlink(missing_ok=True)


class _Null:
    def write(self, _data: bytes) -> None:
        pass
