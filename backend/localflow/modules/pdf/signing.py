"""Certificate-based digital signatures (PKCS#12 / .pfx / .p12). Needs the “Digital signatures” add-on (pyHanko)."""
from __future__ import annotations

from pathlib import Path

from ... import extras


def sign_pdf(
    input_path: str,
    output: str,
    p12_path: str,
    password: str,
    reason: str = "",
    location: str = "",
    visible: bool = False,
    page: int = 1,
    box: tuple[float, float, float, float] = (36, 36, 236, 96),
) -> dict:
    """Sign the document. The signature is invisible unless `visible`; then it is drawn inside `box` (points, from the bottom left)."""
    extras.require("signing")
    from pyhanko.sign import fields, signers
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

    try:
        signer = signers.SimpleSigner.load_pkcs12(pfx_file=p12_path, passphrase=password.encode("utf-8") if password else None)
    except Exception:
        raise ValueError("the certificate could not be opened: check the file and its password")
    if signer is None:
        raise ValueError("the certificate could not be opened: check the file and its password")
    with open(input_path, "rb") as f:
        writer = IncrementalPdfFileWriter(f, strict=False)
        name = "Signature1"
        existing = {fld for fld, _v, _ref in fields.enumerate_sig_fields(writer)}
        k = 1
        while name in existing:
            k += 1
            name = f"Signature{k}"
        sig_field = fields.SigFieldSpec(sig_field_name=name, on_page=max(0, page - 1), box=box) if visible else fields.SigFieldSpec(sig_field_name=name)
        meta = signers.PdfSignatureMetadata(field_name=name, reason=reason or None, location=location or None)
        if visible:
            from pyhanko.sign.fields import append_signature_field

            append_signature_field(writer, sig_field)
            from pyhanko import stamp

            pdf_signer = signers.PdfSigner(meta, signer=signer, stamp_style=stamp.TextStampStyle(stamp_text="Digitally signed by %(signer)s\n%(ts)s"))
        else:
            pdf_signer = signers.PdfSigner(meta, signer=signer, new_field_spec=sig_field)
        with open(output, "wb") as out:
            pdf_signer.sign_pdf(writer, output=out)
    return {"output": output, "field": name, "visible": visible}


def verify_signatures(path: str) -> dict:
    """Who signed, and was the document changed afterwards? (Trust in the certificate itself is not judged.)"""
    extras.require("signing")
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature

    out = []
    with open(path, "rb") as f:
        reader = PdfFileReader(f, strict=False)
        for emb in reader.embedded_signatures:
            try:
                status = validate_pdf_signature(emb)
                cert = emb.signer_cert
                out.append(
                    {
                        "field": emb.field_name,
                        "signer": cert.subject.human_friendly if cert else "",
                        "intact": bool(status.intact),
                        "valid": bool(status.valid),
                        "covers_whole_document": bool(status.coverage.name == "ENTIRE_FILE") if getattr(status, "coverage", None) else False,
                        "signed_at": str(status.signer_reported_dt or ""),
                    }
                )
            except Exception as e:
                out.append({"field": emb.field_name, "signer": "", "intact": False, "valid": False, "covers_whole_document": False, "signed_at": "", "error": str(e)})
    return {"signatures": out, "count": len(out), "file": Path(path).name}
