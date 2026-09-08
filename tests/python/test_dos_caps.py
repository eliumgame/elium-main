"""DoS hardening: the reader bounds memory by the ACTUAL decompressed bytes of
each entry, not the attacker-declared size in the ZIP central directory."""
import pytest

from elium.format import package
from elium.format.document import create_document_model, text_to_doc
from elium.format.package import EliumPackageError, _json_depth_ok, _safe_json_loads, read_elium, write_elium


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


# --------------------------------------------------------------------------- #
# MAX_ZIP_ENTRIES : reject archives with a pathological entry count.
# --------------------------------------------------------------------------- #

def test_too_many_zip_entries_is_rejected(monkeypatch):
    """A standard .elium archive has 7 entries; shrinking the cap below that
    (rather than allocating 10 000+ real entries) exercises the guard cheaply."""
    blob = write_elium(_doc(), profile="standard", title="Entries")
    monkeypatch.setattr(package, "MAX_ZIP_ENTRIES", 6)  # 7 entries > cap of 6
    with pytest.raises(EliumPackageError):
        read_elium(blob)


def test_zip_entries_at_cap_boundary_succeeds(monkeypatch):
    """The cap is inclusive: an archive with EXACTLY MAX_ZIP_ENTRIES entries reads fine."""
    blob = write_elium(_doc(), profile="standard", title="Entries")
    monkeypatch.setattr(package, "MAX_ZIP_ENTRIES", 7)  # 7 entries == cap: must still pass
    assert read_elium(blob)["manifest"]["title"] == "Entries"


# --------------------------------------------------------------------------- #
# MAX_JSON_DEPTH : reject pathologically nested JSON before it reaches json.loads
# (avoids RecursionError / interpreter-level DoS on parse).
# --------------------------------------------------------------------------- #

def _nested_json_bytes(depth: int) -> bytes:
    return (b"[" * depth) + b"0" + (b"]" * depth)


def test_json_depth_ok_accepts_exactly_the_limit():
    assert _json_depth_ok(_nested_json_bytes(package.MAX_JSON_DEPTH), limit=package.MAX_JSON_DEPTH)


def test_json_depth_ok_rejects_one_level_over_the_limit():
    assert not _json_depth_ok(_nested_json_bytes(package.MAX_JSON_DEPTH + 1), limit=package.MAX_JSON_DEPTH)


def test_safe_json_loads_rejects_over_depth_cleanly():
    """The public entry point raises a typed EliumPackageError, never RecursionError."""
    with pytest.raises(EliumPackageError):
        _safe_json_loads(_nested_json_bytes(package.MAX_JSON_DEPTH + 1), "test")


def test_safe_json_loads_accepts_at_depth_limit():
    parsed = _safe_json_loads(_nested_json_bytes(package.MAX_JSON_DEPTH), "test")
    unwrapped = parsed
    while isinstance(unwrapped, list):
        unwrapped = unwrapped[0]
    assert unwrapped == 0
