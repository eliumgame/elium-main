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
