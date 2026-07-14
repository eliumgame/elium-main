"""Tests for the document seal — the cryptographic tamper-evidence anchor."""
import io
import json
import zipfile

import pytest

from elium.format.canonical import sha256_hex
from elium.format.document import create_document_model, text_to_doc
from elium.format.journal import append_event, empty_journal
from elium.format.package import (
    ENTRY_CONTENT_PLAIN,
    ENTRY_JOURNAL,
    ENTRY_MANIFEST,
    ENTRY_SIGNATURES,
    read_elium,
    write_elium,
)
from elium.format.proof import create_proof, generate_identity


def _repack(blob: bytes, replace: dict[str, bytes]) -> bytes:
    zin = zipfile.ZipFile(io.BytesIO(blob))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            data = replace.get(item.filename, zin.read(item.filename))
            ct = zipfile.ZIP_STORED if item.filename == "mimetype" else zipfile.ZIP_DEFLATED
            zo.writestr(item.filename, data, compress_type=ct)
    return out.getvalue()


@pytest.fixture
def sealed():
    author = generate_identity()
    doc = create_document_model(text_to_doc("Contrat: 10000 EUR."))
    signer = {"name": "Alice", "role": "CEO"}
    sig = {"id": "s1", "kind": "drawn", "signer": signer,
           "proof": create_proof("s1", doc, signer, author["privateKeyHex"])}
    journal = append_event(empty_journal(), "document.created", data={"t": "x"})
    journal = append_event(journal, "signature.added", actor={"name": "Alice"})
    blob = write_elium(doc, profile="locked", title="Contrat", signatures=[sig], journal=journal,
                       seal_private_key_hex=author["privateKeyHex"])
    return blob, author, doc


def test_seal_valid_and_trusted(sealed):
    blob, author, _ = sealed
    assert read_elium(blob)["seal"]["verdict"] == "valid"
    assert read_elium(blob, trusted_key_hex=author["publicKeyHex"])["seal"]["verdict"] == "valid"
    assert read_elium(blob, trusted_key_hex="00" * 32)["seal"]["verdict"] == "unknown_key"


def test_seal_detects_content_tamper_even_with_recomputed_hash(sealed):
    blob, _, _ = sealed
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
    forged = create_document_model(text_to_doc("Contrat: 1 EUR."))
    fc = json.dumps(forged, separators=(",", ":"), ensure_ascii=False).encode()
    man["integrity"]["contentHash"] = sha256_hex(fc)  # attacker recomputes the keyless hash
    tampered = _repack(blob, {ENTRY_CONTENT_PLAIN: fc,
                              ENTRY_MANIFEST: json.dumps(man, ensure_ascii=False).encode()})
    r = read_elium(tampered)
    assert r["integrity"]["contentIntact"] is True  # the legacy keyless check is fooled...
    assert r["seal"]["verdict"] == "broken"          # ...but the seal catches it.


def test_seal_detects_journal_rewrite(sealed):
    blob, _, _ = sealed
    fake = append_event(empty_journal(), "document.created", data={"t": "x"})
    tampered = _repack(blob, {ENTRY_JOURNAL: json.dumps(fake, ensure_ascii=False).encode()})
    assert read_elium(tampered)["seal"]["verdict"] == "broken"


def test_seal_detects_signature_strip(sealed):
    blob, _, _ = sealed
    tampered = _repack(blob, {ENTRY_SIGNATURES: b"[]"})
    assert read_elium(tampered)["seal"]["verdict"] == "broken"


def test_seal_detects_profile_badge_spoof(sealed):
    blob, _, _ = sealed
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
    man["profile"] = "secure_max"
    tampered = _repack(blob, {ENTRY_MANIFEST: json.dumps(man, ensure_ascii=False).encode()})
    assert read_elium(tampered)["seal"]["verdict"] == "broken"


def test_seal_survives_benign_resave(sealed):
    blob, _, _ = sealed
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
    man["modifiedAt"] = "2099-01-01T00:00:00Z"  # volatile field, not covered by the seal
    man["generator"] = "elium-py/9.9.9"
    resaved = _repack(blob, {ENTRY_MANIFEST: json.dumps(man, ensure_ascii=False).encode()})
    assert read_elium(resaved)["seal"]["verdict"] == "valid"


def test_unsealed_when_no_seal_key():
    doc = create_document_model(text_to_doc("Plain."))
    blob = write_elium(doc, profile="standard", title="Plain")
    assert read_elium(blob)["seal"]["verdict"] == "unsealed"


def test_seal_covers_access_expiry():
    """accessExpiresAt is part of the signed subset (mirror of seal.ts)."""
    from elium.format.seal import create_seal, verify_seal

    author = generate_identity()
    journal = empty_journal()
    manifest = {
        "format": "elium",
        "formatVersion": 4,
        "profile": "signed",
        "title": "Contrat",
        "language": "fr",
        "createdAt": "2026-01-01T00:00:00Z",
        "accessExpiresAt": "2026-12-31T23:59:59Z",
        "protection": {"encrypted": False, "locked": False, "keyfileRequired": False,
                       "contentEntry": "content/document.json"},
        "integrity": {"algorithm": "sha-256", "contentHash": "ab" * 32},
    }
    manifest["seal"] = create_seal(manifest, [], journal, author["privateKeyHex"])
    assert verify_seal(manifest, [], journal) == "valid"

    tampered = {**manifest, "accessExpiresAt": "2099-01-01T00:00:00Z"}
    assert verify_seal(tampered, [], journal) == "broken"

    without = {k: v for k, v in manifest.items() if k != "accessExpiresAt"}
    assert verify_seal(without, [], journal) == "broken"


def test_seal_without_expiry_is_stable():
    """A seal made without an expiry must not be affected by the new branch."""
    from elium.format.seal import create_seal, verify_seal

    author = generate_identity()
    journal = empty_journal()
    manifest = {
        "format": "elium", "formatVersion": 4, "profile": "signed", "title": "T",
        "language": "fr", "createdAt": "2026-01-01T00:00:00Z",
        "protection": {"encrypted": False, "locked": False, "keyfileRequired": False,
                       "contentEntry": "content/document.json"},
        "integrity": {"algorithm": "sha-256", "contentHash": "cd" * 32},
    }
    manifest["seal"] = create_seal(manifest, [], journal, author["privateKeyHex"])
    assert verify_seal(manifest, [], journal) == "valid"
    # Injecting an unsigned expiry breaks it.
    assert verify_seal({**manifest, "accessExpiresAt": "2027-01-01T00:00:00Z"}, [], journal) == "broken"
