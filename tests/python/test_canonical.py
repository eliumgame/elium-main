"""Guard on non-finite numbers in canonical_json (parity with canonical.ts)."""

import calendar
import hashlib
import re
import time

import pytest

from elium.format.canonical import ZERO_HASH, canonical_json, hash_canonical, now_iso, sha256_hex


def test_rejects_non_finite_numbers():
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError):
            canonical_json({"x": bad})
    # Nested (deep object / array) is rejected too.
    with pytest.raises(ValueError):
        canonical_json({"a": {"b": [1, 2, float("nan")]}})


def test_serializes_finite_numbers_sorted_compact():
    assert canonical_json({"b": 2, "a": 1}) == '{"a":1,"b":2}'
    assert canonical_json({"x": 0.3, "y": -1, "z": 0}) == '{"x":0.3,"y":-1,"z":0}'


# --------------------------------------------------------------------------- #
# sha256_hex / hash_canonical / now_iso — previously exercised only incidentally
# by other test modules, never asserted directly.
# --------------------------------------------------------------------------- #

def test_sha256_hex_matches_hashlib_reference():
    for data in (b"", b"abc", "unicode café".encode()):
        assert sha256_hex(data) == hashlib.sha256(data).hexdigest()
    assert len(sha256_hex(b"x")) == 64


def test_sha256_hex_accepts_str_and_bytes_identically():
    # A str input must be encoded UTF-8 before hashing — same digest as the
    # pre-encoded bytes, not an accidental repr()/str() of the object.
    assert sha256_hex("héllo") == sha256_hex("héllo".encode())


def test_hash_canonical_is_sha256_of_canonical_json():
    value = {"b": 2, "a": 1}
    assert hash_canonical(value) == sha256_hex(canonical_json(value))
    # Key order in the input dict must not affect the hash (canonicalization).
    assert hash_canonical({"a": 1, "b": 2}) == hash_canonical({"b": 2, "a": 1})


def test_hash_canonical_rejects_non_finite_like_canonical_json():
    with pytest.raises(ValueError):
        hash_canonical({"x": float("nan")})


def test_zero_hash_is_64_zero_chars():
    assert ZERO_HASH == "0" * 64


def test_now_iso_format_and_freshness():
    value = now_iso()
    # ISO-8601 UTC, second precision, matching the TS nowIso(): YYYY-MM-DDTHH:MM:SSZ
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value)
    # Round-trips through strptime and is within a generous window of "now" (no
    # timezone drift / wrong clock source). timegm (not mktime) treats the
    # struct_time as UTC, matching what strptime produced from a "Z"-suffixed string.
    parsed = time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    assert abs(calendar.timegm(parsed) - calendar.timegm(time.gmtime())) < 5
def test_ecmascript_number_formatting():
    from elium.format.canonical import canonical_json

    assert canonical_json({"a": 5e-5, "b": 1e16, "c": 1.5e-7, "d": -0.0}) == (
        '{"a":0.00005,"b":10000000000000000,"c":1.5e-7,"d":0}'
    )


def test_legacy_python_float_evidence_remains_verifiable():
    from unittest.mock import patch

    from elium.format.canonical import legacy_python_json
    from elium.format.document import create_document_model, text_to_doc
    from elium.format.journal import append_event, empty_journal, verify_journal
    from elium.format.package import read_elium, write_elium
    from elium.format.proof import create_proof, generate_identity, verify_proof

    identity = generate_identity()
    model = create_document_model(text_to_doc("Legacy"))
    model["number"] = 5e-5
    placement = {"xPct": 1.5e-7}
    with (patch("elium.format.proof.canonical_json", legacy_python_json),
          patch("elium.format.seal.canonical_json", legacy_python_json),
          patch("elium.format.journal.canonical_json", legacy_python_json)):
        proof = create_proof("s", model, {}, identity["privateKeyHex"], placement)
        sig = {"id": "s", "kind": "typed", "signer": {}, "proof": proof, "placement": placement}
        journal = append_event(empty_journal(), "document.created", data={"number": 5e-5})
        blob = write_elium(model, title="Legacy", signatures=[sig], journal=journal,
                           seal_private_key_hex=identity["privateKeyHex"])
    loaded = read_elium(blob)
    assert loaded["seal"]["verdict"] == "valid"
    assert verify_journal(loaded["journal"])["valid"]
    assert verify_proof(sig, model) == "valid"
    assert verify_proof(sig, {**model, "number": 9e-5}) == "modified"
