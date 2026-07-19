"""Tests for the Python tracking-journal helpers (parity with document.ts)."""

from __future__ import annotations

from elium.format.document import (
    create_journal,
    record_modification,
    record_profile,
    record_save,
    record_signature_added,
    tracks_journal,
)
from elium.format.journal import empty_journal, verify_journal


def _types(journal):
    return [e["type"] for e in journal["events"]]


def test_tracks_journal_gate():
    assert tracks_journal("standard", empty_journal()) is False
    assert tracks_journal("tracked", empty_journal()) is True
    # A standard profile that already carries a journal still tracks.
    j = create_journal("tracked", "T")
    assert tracks_journal("standard", j) is True


def test_create_journal_per_profile():
    assert _types(create_journal("standard", "T")) == []
    assert _types(create_journal("tracked", "T")) == ["document.created"]
    assert _types(create_journal("signed", "T")) == ["document.created"]
    # Locked/final profiles record the locked state at creation.
    assert _types(create_journal("locked", "T")) == [
        "document.created", "protection.enabled", "document.locked",
    ]
    assert _types(create_journal("secure_max", "T")) == [
        "document.created", "protection.enabled", "document.locked",
    ]
    assert verify_journal(create_journal("locked", "T"))["valid"] is True


def test_record_modification_gate():
    assert _types(record_modification(empty_journal(), "standard")) == []
    j = record_modification(create_journal("tracked", "T"), "tracked")
    assert j["events"][-1]["type"] == "document.modified"


def test_record_save_flushes_pending_then_modified():
    j = create_journal("tracked", "T")
    base = len(j["events"])
    pending = [
        {"type": "document.opened", "at": "2026-07-19T09:00:00Z"},
        {"type": "export", "at": "2026-07-19T09:05:00Z", "data": {"format": "pdf"}},
        {"type": "signature.validated", "at": "2026-07-19T09:06:00Z", "data": {"id": "sig-1"}},
    ]
    j = record_save(j, "tracked", pending)
    assert _types(j)[base:] == ["document.opened", "export", "signature.validated", "document.modified"]
    export_ev = next(e for e in j["events"] if e["type"] == "export")
    assert export_ev["at"] == "2026-07-19T09:05:00Z"
    assert export_ev["data"] == {"format": "pdf"}
    assert verify_journal(j)["valid"] is True


def test_record_save_noop_without_tracking():
    j = empty_journal()
    assert record_save(j, "standard", [{"type": "export", "at": "x"}]) is j
    assert j["events"] == []


def test_record_signature_added_actor_and_data():
    j = create_journal("signed", "T")
    sig = {"id": "s1", "level": "advanced", "kind": "drawn",
           "signer": {"name": "Alice"}, "proof": {"fingerprint": "ab12"}}
    j = record_signature_added(j, "signed", sig)
    ev = j["events"][-1]
    assert ev["type"] == "signature.added"
    assert ev["actor"] == {"name": "Alice", "fingerprint": "ab12"}
    assert ev["data"] == {"id": "s1", "level": "advanced", "kind": "drawn"}
    assert verify_journal(j)["valid"] is True


def test_record_profile_locked():
    j = record_profile(create_journal("tracked", "T"), "locked")
    assert _types(j)[-2:] == ["protection.enabled", "document.locked"]
