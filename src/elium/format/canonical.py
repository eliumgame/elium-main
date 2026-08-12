"""
Canonical serialization & hashing — byte-for-byte compatible with the
TypeScript `canonical.ts` (sorted keys, compact separators, UTF-8, SHA-256).
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

ZERO_HASH = "0" * 64


def canonical_json(value: Any) -> str:
    """Deterministic JSON: keys sorted recursively, no insignificant whitespace.

    `allow_nan=False` rejects NaN/Infinity (default json.dumps would emit the
    non-standard tokens `NaN`/`Infinity`, invalid JSON and divergent from the TS
    `canonicalJSON`, which throws on non-finite numbers) → parité + pas de hash
    de sceau/journal silencieusement corrompu."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hash_canonical(value: Any) -> str:
    return sha256_hex(canonical_json(value))


def now_iso() -> str:
    """ISO-8601 UTC, second precision (matches the TS nowIso())."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
