"""F-7: metadata encryption hides title / signers / journal actors on an
encrypted .elium opened without the password, while a correct password restores
them faithfully."""
import io
import json
import zipfile

import pytest

from elium.format.document import create_document_model, text_to_doc
from elium.format.journal import append_event, empty_journal
from elium.format.package import (
    ENTRY_JOURNAL,
    ENTRY_MANIFEST,
    ENTRY_SIGNATURES,
    EliumPasswordRequired,
    read_elium,
    write_elium,
)
from elium.format.proof import create_proof, generate_identity

PWD = "correct horse battery staple"  # noqa: S105 (test fixture)


def _sealed_secure_blob():
    author = generate_identity()
    doc = create_document_model(text_to_doc("Salaires confidentiels."))
    signer = {"name": "Jean Dupont", "role": "DRH"}
    sig = {"id": "s1", "kind": "drawn", "signer": signer,
           "proof": create_proof("s1", doc, signer, author["privateKeyHex"])}
    journal = append_event(empty_journal(), "signature.added", actor={"name": "Jean Dupont"})
    blob = write_elium(
        doc, profile="secure_max", title="Plan social 2026",
        signatures=[sig], journal=journal, password=PWD,
        seal_private_key_hex=author["privateKeyHex"], encrypt_metadata=True,
    )
    return blob, author


def test_clear_entries_leak_nothing():
    """No password = no title, no signer names, no journal actors on disk."""
    blob, _ = _sealed_secure_blob()
    z = zipfile.ZipFile(io.BytesIO(blob))
    man = json.loads(z.read(ENTRY_MANIFEST))
    sigs = json.loads(z.read(ENTRY_SIGNATURES))
    jour = json.loads(z.read(ENTRY_JOURNAL))

    assert man["title"] != "Plan social 2026"
    assert man["protection"]["metadataEncrypted"] is True
    assert sigs == []
    assert jour.get("events", []) == []
    # The whole serialized clear side must not contain the secret strings.
    blob_clear = json.dumps(man) + json.dumps(sigs) + json.dumps(jour)
    assert "Plan social 2026" not in blob_clear
    assert "Jean Dupont" not in blob_clear
    assert "DRH" not in blob_clear


def test_no_password_is_refused():
    blob, _ = _sealed_secure_blob()
    with pytest.raises(EliumPasswordRequired):
        read_elium(blob)


def test_password_restores_metadata_and_seal():
    blob, author = _sealed_secure_blob()
    r = read_elium(blob, password=PWD, trusted_key_hex=author["publicKeyHex"])
    assert r["manifest"]["title"] == "Plan social 2026"
    assert r["signatures"][0]["signer"]["name"] == "Jean Dupont"
    assert any(e.get("actor", {}).get("name") == "Jean Dupont" for e in r["journal"]["events"])
    assert r["seal"]["verdict"] == "valid"
    assert r["integrity"]["contentIntact"] is True
    # The document content itself round-trips.
    from elium.format.document import extract_text
    assert "Salaires confidentiels" in extract_text(r["document"]["doc"])


def test_wrong_password_still_rejected():
    blob, _ = _sealed_secure_blob()
    from elium.core.exceptions import EliumError
    with pytest.raises(EliumError):
        read_elium(blob, password="mauvais")  # noqa: S106


PARAPHEUR = {
    "parties": [{"id": "p1", "name": "Jean Dupont", "role": "DRH", "status": "pending"}],
    "requester": "Alice Martin",
}


def test_parapheur_personal_data_surfaces_in_clear_rgpd_notice():
    """P2: a Parapheur (signature circuit) traveling in the clear (no
    encrypt_metadata) carries personal data of its own (party names/roles,
    requester) — the RGPD notice must report it even with zero `signatures`."""
    doc = create_document_model(text_to_doc("Circuit en clair"))
    blob = write_elium(doc, profile="protected", title="Circuit", password=PWD, parapheur=PARAPHEUR)
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
    reported = man["rgpd"]["storedPersonalData"]
    assert "nom de partie du circuit de signature" in reported
    assert "rôle de partie du circuit de signature" in reported
    assert "nom du demandeur (circuit de signature)" in reported


def test_parapheur_personal_data_hidden_when_metadata_encrypted():
    """With encrypt_metadata, the Parapheur travels inside the encrypted
    envelope: the clear manifest must stay fully redacted (no personal data
    reported, no party name leaked on disk)."""
    doc = create_document_model(text_to_doc("Circuit chiffré"))
    blob = write_elium(
        doc, profile="secure_max", title="Circuit", password=PWD,
        parapheur=PARAPHEUR, encrypt_metadata=True,
    )
    z = zipfile.ZipFile(io.BytesIO(blob))
    man = json.loads(z.read(ENTRY_MANIFEST))
    assert man["rgpd"]["storedPersonalData"] == []
    assert "parapheur/circuit.json" not in z.namelist()
    assert "Jean Dupont" not in json.dumps(man)

    r = read_elium(blob, password=PWD)
    assert r["parapheur"] == PARAPHEUR


def test_non_secure_encrypted_file_unchanged():
    """Without encrypt_metadata, behaviour is the legacy one (title in clear)."""
    doc = create_document_model(text_to_doc("x"))
    blob = write_elium(doc, profile="encrypted", title="Visible", password=PWD)
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
    assert man["title"] == "Visible"
    assert "metadataEncrypted" not in man["protection"]
    assert read_elium(blob, password=PWD)["manifest"]["title"] == "Visible"
