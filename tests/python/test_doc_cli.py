"""Tests for the v4 document CLI handlers (doc-create / doc-sign / doc-open / doc-verify)."""

from __future__ import annotations

import io
import json
import zipfile
from unittest.mock import patch

import pytest

from elium.cli.main import main
from elium.format.canonical import sha256_hex
from elium.format.document import create_document_model, text_to_doc
from elium.format.package import read_elium, write_elium
from elium.format.proof import generate_identity


def _substitute_resource(blob: bytes, res_id: str, new_bytes: bytes) -> bytes:
    """Rebuild a .elium archive with `resources/{res_id}` swapped for bytes that
    no longer hash to res_id — simulating post-write tampering/substitution."""
    zin = zipfile.ZipFile(io.BytesIO(blob))
    entries = {name: zin.read(name) for name in zin.namelist()}
    entries[f"resources/{res_id}"] = new_bytes
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return out.getvalue()


def run(*argv: str) -> None:
    with patch("sys.argv", ["elium", *argv]):
        main()


def _types(result: dict) -> list[str]:
    return [e["type"] for e in result["journal"]["events"]]


def test_doc_create_tracked_journal(tmp_path):
    src = tmp_path / "notes.txt"
    src.write_text("Bonjour\nLigne 2", encoding="utf-8")
    out = tmp_path / "doc.elium"
    run("doc-create", "--input", str(src), "--output", str(out), "--title", "Notes", "--profile", "tracked")

    result = read_elium(out.read_bytes())
    assert result["manifest"]["title"] == "Notes"
    assert _types(result) == ["document.created"]


def test_doc_create_locked_records_lock(tmp_path):
    src = tmp_path / "n.txt"
    src.write_text("x", encoding="utf-8")
    out = tmp_path / "d.elium"
    run("doc-create", "--input", str(src), "--output", str(out), "--profile", "locked")
    assert _types(read_elium(out.read_bytes())) == ["document.created", "protection.enabled", "document.locked"]


def test_doc_sign_adds_signature_and_journal_event(tmp_path):
    src = tmp_path / "c.txt"
    src.write_text("Contrat de test", encoding="utf-8")
    doc = tmp_path / "c.elium"
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "signed")

    ident = generate_identity()
    key = tmp_path / "key.hex"
    key.write_text(ident["privateKeyHex"], encoding="utf-8")
    run("doc-sign", str(doc), "--key", str(key), "--name", "Alice", "--role", "Gérante")

    result = read_elium(doc.read_bytes())
    assert len(result["signatures"]) == 1
    sig = result["signatures"][0]
    assert sig["signer"] == {"name": "Alice", "role": "Gérante"}
    assert sig["level"] == "advanced"
    # The re-signature is journalled both as the signature event and as the
    # save that persisted it (record_save), just like a Studio save.
    assert _types(result) == ["document.created", "signature.added", "document.modified"]
    # docId preserved across the re-write.
    assert read_elium(doc.read_bytes())["manifest"]["docId"] == result["manifest"]["docId"]


def test_doc_sign_preserves_embedded_resources(tmp_path):
    """P0: re-signing via the CLI must not silently drop embedded resources
    (images/fonts) — write_elium was previously called without resource_index/
    resources, wiping the archive's resources/ entries on every re-signature."""
    model = create_document_model(text_to_doc("Contrat avec logo"))
    img_bytes = b"\x89PNG-fake-bytes-for-test"
    res_id = sha256_hex(img_bytes)
    resource_index = [{"id": res_id, "name": "logo.png", "mime": "image/png", "size": len(img_bytes), "kind": "image"}]
    blob = write_elium(
        model, profile="signed", title="Avec logo",
        resource_index=resource_index, resources={res_id: img_bytes},
    )
    doc = tmp_path / "logo.elium"
    doc.write_bytes(blob)

    ident = generate_identity()
    key = tmp_path / "key.hex"
    key.write_text(ident["privateKeyHex"], encoding="utf-8")
    run("doc-sign", str(doc), "--key", str(key), "--name", "Alice")

    result = read_elium(doc.read_bytes())
    assert result["resourceIndex"] == resource_index
    assert result["resources"][res_id] == img_bytes
    assert result["integrity"]["resourcesTampered"] == []


def test_doc_sign_refuses_when_resource_tampered(tmp_path):
    """P0 regression: `read_elium` drops a hash-mismatched resource from
    `resources` but leaves its entry in `resourceIndex` — the evidence that it
    was tampered with. Because doc-sign forwards `result["resources"]`
    (filtered) and `result["resourceIndex"]` (unfiltered) straight to
    write_elium, re-signing used to rewrite the archive WITHOUT the tampered
    resource's bytes while still referencing it, erasing the tampering
    evidence on the very next read. doc-sign must now refuse instead."""
    model = create_document_model(text_to_doc("Contrat avec tampon"))
    img_bytes = b"original stamp bytes"
    res_id = sha256_hex(img_bytes)
    resource_index = [
        {"id": res_id, "name": "tampon.png", "mime": "image/png", "size": len(img_bytes), "kind": "image"}
    ]
    blob = write_elium(
        model, profile="signed", title="Avec tampon",
        resource_index=resource_index, resources={res_id: img_bytes},
    )
    tampered_blob = _substitute_resource(blob, res_id, b"substituted stamp bytes")
    doc = tmp_path / "tampered.elium"
    doc.write_bytes(tampered_blob)

    # Sanity: the tampering is indeed detected before any doc-sign attempt.
    before = read_elium(doc.read_bytes())
    assert before["integrity"]["resourcesTampered"] == [res_id]
    assert res_id not in before["resources"]

    ident = generate_identity()
    key = tmp_path / "key.hex"
    key.write_text(ident["privateKeyHex"], encoding="utf-8")
    with pytest.raises(SystemExit):
        run("doc-sign", str(doc), "--key", str(key), "--name", "Alice")

    # The file on disk must be untouched: no signature was added, and the
    # tampering evidence is still fully intact and detectable.
    after = read_elium(doc.read_bytes())
    assert after["integrity"]["resourcesTampered"] == [res_id]
    assert res_id not in after["resources"]
    assert after["resourceIndex"] == resource_index
    assert after["signatures"] == []


def test_doc_verify_and_open_warn_on_tampered_resource(tmp_path, capsys):
    """`resourcesTampered` must be surfaced in the plain console output of both
    doc-verify and doc-open, not just incidentally inside the optional JSON
    --report of doc-verify."""
    model = create_document_model(text_to_doc("Contrat avec tampon"))
    img_bytes = b"original stamp bytes 2"
    res_id = sha256_hex(img_bytes)
    resource_index = [
        {"id": res_id, "name": "tampon2.png", "mime": "image/png", "size": len(img_bytes), "kind": "image"}
    ]
    blob = write_elium(
        model, profile="standard", title="Avec tampon",
        resource_index=resource_index, resources={res_id: img_bytes},
    )
    tampered_blob = _substitute_resource(blob, res_id, b"substituted bytes")
    doc = tmp_path / "tampered2.elium"
    doc.write_bytes(tampered_blob)

    capsys.readouterr()
    run("doc-verify", str(doc))
    verify_out = capsys.readouterr().out
    assert "ALTÉRÉE" in verify_out
    assert res_id in verify_out

    run("doc-open", str(doc))
    open_out = capsys.readouterr().out
    assert "ALTÉRÉE" in open_out


def test_doc_verify_reports_valid_signature(tmp_path, capsys):
    src = tmp_path / "v.txt"
    src.write_text("À vérifier", encoding="utf-8")
    doc = tmp_path / "v.elium"
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "signed")

    ident = generate_identity()
    key = tmp_path / "k.hex"
    key.write_text(ident["privateKeyHex"], encoding="utf-8")
    run("doc-sign", str(doc), "--key", str(key), "--name", "Bob")

    capsys.readouterr()
    report = tmp_path / "report.json"
    run("doc-verify", str(doc), "--report", str(report))
    out = capsys.readouterr().out
    assert "VALIDE" in out  # journal + signature lines

    r = json.loads(report.read_text(encoding="utf-8"))
    assert r["journal"]["valid"] is True
    assert r["signatures"][0]["verdict"] == "valid"


def test_doc_sign_reseal_covers_enriched_journal(tmp_path):
    src = tmp_path / "s.txt"
    src.write_text("Scellé", encoding="utf-8")
    doc = tmp_path / "s.elium"
    ident = generate_identity()
    sealf = tmp_path / "seal.hex"
    sealf.write_text(ident["privateKeyHex"], encoding="utf-8")
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "tracked", "--seal-key", str(sealf))

    run("doc-sign", str(doc), "--key", str(sealf), "--name", "Carol", "--seal-key", str(sealf))
    result = read_elium(doc.read_bytes(), trusted_key_hex=ident["publicKeyHex"])
    assert result["seal"]["verdict"] == "valid"  # seal re-anchored over the new journal + signature
    assert _types(result) == ["document.created", "signature.added", "document.modified"]


def test_doc_open_text_prints_content(tmp_path, capsys):
    src = tmp_path / "o.txt"
    src.write_text("Contenu visible ici", encoding="utf-8")
    doc = tmp_path / "o.elium"
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "standard")

    capsys.readouterr()
    run("doc-open", str(doc), "--text")
    out = capsys.readouterr().out
    assert "Contenu visible ici" in out
    assert "Titre" in out


def test_doc_create_encrypted_roundtrip(tmp_path):
    src = tmp_path / "e.txt"
    src.write_text("Secret", encoding="utf-8")
    doc = tmp_path / "e.elium"
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "encrypted", "--password", "pw123")
    result = read_elium(doc.read_bytes(), password="pw123")
    assert result["manifest"]["protection"]["encrypted"] is True
