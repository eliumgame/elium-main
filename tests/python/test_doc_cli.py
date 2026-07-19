"""Tests for the v4 document CLI handlers (doc-create / doc-sign / doc-open / doc-verify)."""

from __future__ import annotations

import json
from unittest.mock import patch

from elium.cli.main import main
from elium.format.package import read_elium
from elium.format.proof import generate_identity


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
    assert _types(result) == ["document.created", "signature.added"]
    # docId preserved across the re-write.
    assert read_elium(doc.read_bytes())["manifest"]["docId"] == result["manifest"]["docId"]


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
    assert _types(result) == ["document.created", "signature.added"]


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
