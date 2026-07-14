"""DoS hardening: the reader bounds memory by the ACTUAL decompressed bytes of
each entry, not the attacker-declared size in the ZIP central directory."""
import pytest

from elium.format import package
from elium.format.document import create_document_model, text_to_doc
from elium.format.package import EliumPackageError, read_elium, write_elium


def _doc():
    return create_document_model(text_to_doc("Contenu de test pour les bornes DoS."))


def test_oversized_entry_is_rejected(monkeypatch):
    """An entry whose real decompressed size exceeds the per-entry cap is refused.

    We shrink the cap (instead of allocating 128 MiB) so the normal content
    entry already exceeds it — this exercises the capped read path.
    """
    blob = write_elium(_doc(), profile="standard", title="Cap")
    # Sanity: it reads fine under the real (large) cap.
    assert read_elium(blob)["manifest"]["title"] == "Cap"

    monkeypatch.setattr(package, "MAX_ENTRY_BYTES", 8)  # 8 bytes: everything is "too big"
    with pytest.raises(EliumPackageError):
        read_elium(blob)


def test_total_budget_is_enforced(monkeypatch):
    """The cumulative read budget across entries is enforced."""
    blob = write_elium(_doc(), profile="tracked", title="Budget")
    monkeypatch.setattr(package, "MAX_ENTRY_BYTES", 10_000_000)  # generous per-entry
    monkeypatch.setattr(package, "MAX_TOTAL_BYTES", 4)           # but a tiny total budget
    with pytest.raises(EliumPackageError):
        read_elium(blob)
