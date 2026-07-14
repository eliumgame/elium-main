"""Tests for the v4 documentary .elium format (Python side)."""

import io
import zipfile

import pytest

from elium.core.exceptions import EliumSecurityError
from elium.format.document import create_document_model, extract_text, text_to_doc
from elium.format.journal import append_event, empty_journal, verify_journal
from elium.format.package import EliumPasswordRequired, read_elium, write_elium
from elium.format.proof import create_proof, generate_identity, verify_proof


def make_model(text="Bonjour Elium"):
    return create_document_model(text_to_doc(text))


def test_standard_roundtrip():
    model = make_model()
    blob = write_elium(model, profile="standard", title="Test")
    assert blob[:2] == b"PK"  # ZIP signature

    result = read_elium(blob)
    assert result["manifest"]["profile"] == "standard"
    assert result["manifest"]["format"] == "elium"
    assert result["manifest"]["formatVersion"] == 4
    assert result["document"] == model
    assert result["integrity"]["contentIntact"] is True
    assert "Bonjour Elium" in extract_text(result["document"]["doc"])


def test_encrypted_requires_correct_password():
    model = make_model("information secrète")
    blob = write_elium(model, profile="encrypted", title="Secret", password="pw-correct")

    with pytest.raises(EliumPasswordRequired):
        read_elium(blob)

    with pytest.raises(EliumSecurityError):
        read_elium(blob, password="mauvais")

    result = read_elium(blob, password="pw-correct")
    assert result["document"] == model
    assert result["manifest"]["protection"]["encrypted"] is True


def test_locked_profile_flags():
    journal = append_event(empty_journal(), "document.created", data={"title": "Final"})
    blob = write_elium(make_model(), profile="locked", title="Final", journal=journal)
    result = read_elium(blob)
    assert result["manifest"]["protection"]["locked"] is True
    assert result["manifest"]["features"]["tracking"] is True


def test_content_tamper_detected():
    blob = write_elium(make_model(), profile="standard", title="T")
    # Rebuild the package with altered content but the ORIGINAL manifest (old hash).
    zin = zipfile.ZipFile(io.BytesIO(blob))
    entries = {name: zin.read(name) for name in zin.namelist()}
    entries["content/document.json"] = entries["content/document.json"].replace(b"Bonjour", b"Bonsoir")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)

    result = read_elium(out.getvalue())
    assert result["integrity"]["contentIntact"] is False


def test_journal_chain_and_tamper():
    j = empty_journal()
    j = append_event(j, "document.created", data={"title": "x"})
    j = append_event(j, "signature.added", actor={"name": "Alice"})
    assert verify_journal(j)["valid"] is True
    assert verify_journal(j)["count"] == 2

    j["events"][0]["data"] = {"title": "y"}  # tamper
    verdict = verify_journal(j)
    assert verdict["valid"] is False
    assert verdict["brokenAt"] == 0


def test_proof_lifecycle():
    model = make_model()
    ident = generate_identity()
    signer = {"name": "Alice", "role": "Directrice", "date": "2026-06-09"}
    proof = create_proof("sig_1", model, signer, ident["privateKeyHex"])
    sig = {"id": "sig_1", "signer": signer, "proof": proof}

    assert verify_proof(sig, model) == "valid"
    assert verify_proof(sig, model, trusted_key_hex=ident["publicKeyHex"]) == "valid"
    assert verify_proof(sig, model, trusted_key_hex="00" * 32) == "unknown_key"

    assert verify_proof(sig, make_model("contenu modifié")) == "modified"

    tampered = {**sig, "proof": {**proof, "signatureHex": "00" + proof["signatureHex"][2:]}}
    assert verify_proof(tampered, model) == "invalid"


def test_visual_only_signature_has_no_proof_verdict():
    sig = {"id": "s", "signer": {"name": "Bob"}, "proof": None}
    assert verify_proof(sig, make_model()) == "visual_only"
