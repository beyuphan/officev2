import io
import os
import time

import pytest

from localflow.modules.vault import crypto, service
from test_api import AUTH, client  # noqa: F401
from test_files import post

PW = "correct horse battery"


def api(client, method, path, body=None):
    return getattr(client, method)(path, headers=AUTH, **({"json": body} if body is not None else {}))


@pytest.fixture
def vault(client):
    r = api(client, "post", "/vault/create", {"password": PW})
    assert r.status_code == 201, r.text
    return r.json()["recovery_key"]


# ---- crypto primitives ----------------------------------------------------------------------------


def roundtrip(data: bytes, dk=b"k" * 32, fid=b"file1"):
    enc = io.BytesIO()
    crypto.encrypt_stream(dk, io.BytesIO(data), enc, fid)
    dec = io.BytesIO()
    crypto.decrypt_stream(dk, io.BytesIO(enc.getvalue()), dec, fid)
    return enc.getvalue(), dec.getvalue()


@pytest.mark.parametrize("size", [0, 1, crypto.CHUNK - 1, crypto.CHUNK, crypto.CHUNK + 1, 3 * crypto.CHUNK + 7])
def test_stream_roundtrip_at_chunk_boundaries(size):
    data = os.urandom(size)
    enc, dec = roundtrip(data)
    assert dec == data
    assert data[:32] not in enc or size < 32


def test_tamper_truncate_reorder_and_wrong_context_are_detected():
    dk = b"k" * 32
    data = os.urandom(3 * crypto.CHUNK)
    enc, _ = roundtrip(data, dk)

    flipped = bytearray(enc)
    flipped[100] ^= 1
    with pytest.raises(crypto.VaultCryptoError):
        crypto.decrypt_stream(dk, io.BytesIO(bytes(flipped)), io.BytesIO(), b"file1")

    # drop the last chunk: the previous chunk was not flagged "last", so this must fail
    cut = enc[: 8 + 2 * (crypto.CHUNK + crypto.TAG)]
    with pytest.raises(crypto.VaultCryptoError):
        crypto.decrypt_stream(dk, io.BytesIO(cut), io.BytesIO(), b"file1")

    # swap two chunks
    c = crypto.CHUNK + crypto.TAG
    body = enc[8:]
    swapped = enc[:8] + body[c : 2 * c] + body[:c] + body[2 * c :]
    with pytest.raises(crypto.VaultCryptoError):
        crypto.decrypt_stream(dk, io.BytesIO(swapped), io.BytesIO(), b"file1")

    # a blob moved under another file id must not decrypt
    with pytest.raises(crypto.VaultCryptoError):
        crypto.decrypt_stream(dk, io.BytesIO(enc), io.BytesIO(), b"other")


def test_recovery_key_format_and_derivation():
    rk = crypto.new_recovery_key()
    assert len(rk.replace("-", "")) == 32 and rk == rk.upper()
    assert crypto.derive_recovery_key(rk) == crypto.derive_recovery_key(rk.lower().replace("-", " "))


# ---- service / API ------------------------------------------------------------------------------------


def test_create_unlock_lock_flow(client, vault):
    assert api(client, "get", "/vault/status").json() == {"exists": True, "unlocked": True, "idle_lock_seconds": 300}
    assert api(client, "post", "/vault/create", {"password": PW}).status_code == 409
    api(client, "post", "/vault/lock")
    assert api(client, "get", "/vault/items").status_code == 423  # locked
    assert api(client, "post", "/vault/unlock", {"password": "wrong password"}).status_code == 401
    assert api(client, "post", "/vault/unlock", {"password": PW}).status_code == 200
    assert api(client, "get", "/vault/items").json() == []


def test_short_password_rejected(client):
    assert api(client, "post", "/vault/create", {"password": "short"}).status_code == 422
    assert api(client, "get", "/vault/status").json()["exists"] is False


def test_add_list_export_roundtrip_and_no_plaintext_on_disk(client, vault, tmp_path):
    secret = tmp_path / "id-card.txt"
    payload = (b"TOP-SECRET-MARKER-" + os.urandom(16)) * 200_000  # ~ 6 MB -> several chunks
    secret.write_bytes(payload)
    res = api(client, "post", "/vault/items", {"paths": [str(secret)]}).json()
    assert res["added"] == ["id-card.txt"] and res["failed"] == []
    items = api(client, "get", "/vault/items").json()
    assert items[0]["name"] == "id-card.txt" and items[0]["size"] == len(payload)
    assert secret.exists()  # original untouched by default

    vault_dir = tmp_path / "_data" / "vault"
    for f in vault_dir.rglob("*"):
        if f.is_file():
            blob = f.read_bytes()
            assert b"TOP-SECRET-MARKER" not in blob and b"id-card" not in blob  # content and names encrypted

    out = tmp_path / "out"
    out.mkdir()
    r = api(client, "post", f"/vault/items/{items[0]['id']}/export", {"out_dir": str(out)})
    assert r.status_code == 200
    assert (out / "id-card.txt").read_bytes() == payload

    assert api(client, "delete", f"/vault/items/{items[0]['id']}").status_code == 200
    assert api(client, "get", "/vault/items").json() == []
    assert list((vault_dir / "blobs").glob("*.enc")) == []


def test_tampered_blob_fails_export_and_leaves_no_partial_file(client, vault, tmp_path):
    f = tmp_path / "doc.bin"
    f.write_bytes(os.urandom(2 * crypto.CHUNK))
    api(client, "post", "/vault/items", {"paths": [str(f)]})
    item = api(client, "get", "/vault/items").json()[0]
    blob = tmp_path / "_data" / "vault" / "blobs" / f"{item['id']}.enc"
    raw = bytearray(blob.read_bytes())
    raw[5000] ^= 0xFF
    blob.write_bytes(bytes(raw))
    out = tmp_path / "out"
    out.mkdir()
    r = api(client, "post", f"/vault/items/{item['id']}/export", {"out_dir": str(out)})
    assert r.status_code == 500 and "tampered" in r.json()["detail"]
    assert list(out.iterdir()) == []


def test_recovery_key_unlocks_and_password_change(client, vault, tmp_path):
    api(client, "post", "/vault/lock")
    assert api(client, "post", "/vault/unlock", {"recovery_key": "AAAA-BBBB-CCCC"}).status_code == 401
    assert api(client, "post", "/vault/unlock", {"recovery_key": vault}).status_code == 200

    api(client, "post", "/vault/lock")
    r = api(client, "post", "/vault/change-password", {"old_password": PW, "new_password": "a brand new secret"})
    assert r.status_code == 200
    api(client, "post", "/vault/lock")
    assert api(client, "post", "/vault/unlock", {"password": PW}).status_code == 401
    assert api(client, "post", "/vault/unlock", {"password": "a brand new secret"}).status_code == 200
    # the recovery key still works after a password change
    api(client, "post", "/vault/lock")
    assert api(client, "post", "/vault/unlock", {"recovery_key": vault}).status_code == 200


def test_idle_timeout_locks(client, vault, monkeypatch):
    monkeypatch.setattr(service, "IDLE_LOCK_SECONDS", 0.1)
    time.sleep(0.3)
    assert api(client, "get", "/vault/status").json()["unlocked"] is False
    assert api(client, "get", "/vault/items").status_code == 423


def test_delete_original_goes_to_recycle_bin_after_verified_copy(client, vault, tmp_path, monkeypatch):
    trashed = []
    monkeypatch.setattr("send2trash.send2trash", lambda p: trashed.append(p))
    f = tmp_path / "x.txt"
    f.write_text("hello")
    api(client, "post", "/vault/items", {"paths": [str(f)], "delete_original": True})
    assert trashed == [str(f)]
    assert api(client, "get", "/vault/items").json()[0]["name"] == "x.txt"


def test_vault_paths_are_scoped(client, vault):
    assert api(client, "post", "/vault/items", {"paths": ["C:/Windows/win.ini"]}).status_code == 403
