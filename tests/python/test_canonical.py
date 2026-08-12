"""Guard on non-finite numbers in canonical_json (parity with canonical.ts)."""

import pytest

from elium.format.canonical import canonical_json


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
