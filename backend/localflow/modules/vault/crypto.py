"""Vault cryptography.

- A random 256-bit data key (DK) encrypts everything.
- DK is stored twice, wrapped by a password-derived key (Argon2id) and by a recovery key.
- Files are encrypted in 1 MiB AES-256-GCM chunks; each chunk's AAD carries its index and a
  last-chunk flag, so reordering, dropping or truncating chunks is detected.
"""
from __future__ import annotations

import base64
import os
import struct
from typing import BinaryIO

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"LFV1"
CHUNK = 1 << 20
TAG = 16

KDF_DEFAULT = {"t": 3, "m": 64 * 1024, "p": 4}  # time cost, memory KiB, lanes


class VaultCryptoError(Exception):
    pass


def derive_password_key(password: str, salt: bytes, params: dict) -> bytes:
    return hash_secret_raw(
        password.encode("utf-8"), salt, time_cost=params["t"], memory_cost=params["m"],
        parallelism=params["p"], hash_len=32, type=Type.ID,
    )


def derive_recovery_key(recovery: str) -> bytes:
    raw = base64.b32decode(recovery.replace("-", "").replace(" ", "").upper() + "=" * (-len(recovery.replace("-", "").replace(" ", "")) % 8))
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"localflow-vault-recovery").derive(raw)


def new_recovery_key() -> str:
    raw = os.urandom(20)  # 160 bits
    text = base64.b32encode(raw).decode().rstrip("=")
    return "-".join(text[i : i + 4] for i in range(0, len(text), 4))


def wrap(kek: bytes, dk: bytes, label: bytes) -> dict:
    nonce = os.urandom(12)
    return {"nonce": nonce.hex(), "ct": AESGCM(kek).encrypt(nonce, dk, label).hex()}


def unwrap(kek: bytes, blob: dict, label: bytes) -> bytes:
    try:
        return AESGCM(kek).decrypt(bytes.fromhex(blob["nonce"]), bytes.fromhex(blob["ct"]), label)
    except InvalidTag:
        raise VaultCryptoError("wrong password or recovery key")


def seal(dk: bytes, data: bytes, label: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(dk).encrypt(nonce, data, label)


def open_sealed(dk: bytes, blob: bytes, label: bytes) -> bytes:
    try:
        return AESGCM(dk).decrypt(blob[:12], blob[12:], label)
    except InvalidTag:
        raise VaultCryptoError("data is corrupted or has been tampered with")


def _chunk_nonce(prefix: bytes, index: int) -> bytes:
    return prefix + struct.pack(">Q", index)


def _chunk_aad(file_id: bytes, index: int, last: bool) -> bytes:
    return file_id + struct.pack(">Q", index) + (b"\x01" if last else b"\x00")


def encrypt_stream(dk: bytes, src: BinaryIO, dst: BinaryIO, file_id: bytes) -> int:
    """Encrypt `src` into `dst`. Returns plaintext size."""
    aes = AESGCM(dk)
    prefix = os.urandom(4)
    dst.write(MAGIC + prefix)
    total, index = 0, 0
    block = src.read(CHUNK)
    while True:
        nxt = src.read(CHUNK)
        last = not nxt
        dst.write(aes.encrypt(_chunk_nonce(prefix, index), block, _chunk_aad(file_id, index, last)))
        total += len(block)
        if last:
            return total
        block, index = nxt, index + 1


def decrypt_stream(dk: bytes, src: BinaryIO, dst: BinaryIO, file_id: bytes) -> int:
    aes = AESGCM(dk)
    header = src.read(8)
    if header[:4] != MAGIC or len(header) != 8:
        raise VaultCryptoError("not a vault file")
    prefix = header[4:]
    total, index = 0, 0
    block = src.read(CHUNK + TAG)
    if not block:
        raise VaultCryptoError("vault file is empty or truncated")
    while True:
        nxt = src.read(CHUNK + TAG)
        last = not nxt
        try:
            plain = aes.decrypt(_chunk_nonce(prefix, index), block, _chunk_aad(file_id, index, last))
        except InvalidTag:
            raise VaultCryptoError("file is corrupted, truncated or has been tampered with")
        dst.write(plain)
        total += len(plain)
        if last:
            return total
        block, index = nxt, index + 1
