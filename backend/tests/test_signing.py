import datetime
from pathlib import Path

import pymupdf
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from test_api import AUTH, client  # noqa: F401
from test_files import post, post_job

pytest.importorskip("pyhanko")


def make_p12(path: Path, password: str = "secret"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Signer"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "officev2 tests")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False, data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .sign(key, hashes.SHA256())
    )
    path.write_bytes(pkcs12.serialize_key_and_certificates(b"test", key, cert, None, serialization.BestAvailableEncryption(password.encode())))


def pdf(path: Path):
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 100), "Contract text", fontsize=12)
    doc.save(str(path))
    doc.close()


def test_sign_then_verify_then_detect_tampering(client, tmp_path):
    src, out, p12 = tmp_path / "c.pdf", tmp_path / "signed.pdf", tmp_path / "me.p12"
    pdf(src)
    make_p12(p12)
    job = post_job(client, "/pdf/sign", {"input": str(src), "output": str(out), "certificate": str(p12), "password": "secret", "reason": "I agree"})
    assert job["state"] == "done", job
    r = post(client, "/pdf/signatures", {"input": str(out)}, 200).json()
    assert r["count"] == 1 and r["signatures"][0]["intact"] and "Test Signer" in r["signatures"][0]["signer"]
    tampered = tmp_path / "t.pdf"
    data = bytearray(out.read_bytes())
    i = data.find(b"Contract text")
    if i > 0:
        data[i:i + 8] = b"Contrakt"
    else:  # content may be compressed: flip a byte inside the signed range instead
        data[200] ^= 0xFF
    tampered.write_bytes(bytes(data))
    t = post(client, "/pdf/signatures", {"input": str(tampered)}, 200).json()
    assert t["count"] == 0 or not t["signatures"][0]["intact"] or not t["signatures"][0]["valid"]


def test_visible_signature_and_wrong_password(client, tmp_path):
    src, p12 = tmp_path / "c.pdf", tmp_path / "me.p12"
    pdf(src)
    make_p12(p12)
    job = post_job(client, "/pdf/sign", {"input": str(src), "output": str(tmp_path / "v.pdf"), "certificate": str(p12), "password": "secret", "visible": True})
    assert job["state"] == "done", job
    bad = post_job(client, "/pdf/sign", {"input": str(src), "output": str(tmp_path / "b.pdf"), "certificate": str(p12), "password": "nope"})
    assert bad["state"] == "failed" and "certificate" in bad["error"]


def test_a_pdf_without_signatures(client, tmp_path):
    src = tmp_path / "c.pdf"
    pdf(src)
    assert post(client, "/pdf/signatures", {"input": str(src)}, 200).json()["count"] == 0
