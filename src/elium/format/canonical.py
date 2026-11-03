"""
Canonical serialization & hashing — byte-for-byte compatible with the
TypeScript `canonical.ts` (sorted keys, compact separators, UTF-8, SHA-256).
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from decimal import Decimal
from typing import Any

ZERO_HASH = "0" * 64


def legacy_python_json(value: Any) -> str:
    """Read-only compatibility for evidence emitted before ECMAScript number formatting."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_json(value: Any) -> str:
    """Deterministic JSON: keys sorted recursively, no insignificant whitespace.

    `allow_nan=False` rejects NaN/Infinity (default json.dumps would emit the
    non-standard tokens `NaN`/`Infinity`, invalid JSON and divergent from the TS
    `canonicalJSON`, which throws on non-finite numbers) → parité + pas de hash
    de sceau/journal silencieusement corrompu."""
    def encode(item: Any) -> str:
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("Non-finite number in canonical JSON")
            if item == 0:
                return "0"
            magnitude = abs(item)
            shortest = repr(item)
            if 1e-6 <= magnitude < 1e21:
                return format(Decimal(shortest), "f").removesuffix(".0")
            coefficient, exponent = shortest.lower().split("e") if "e" in shortest.lower() else (shortest, "0")
            return f"{coefficient.removesuffix('.0')}e{int(exponent):+d}" if int(exponent) >= 0 else f"{coefficient.removesuffix('.0')}e{int(exponent)}"
        if isinstance(item, dict):
            return "{" + ",".join(
                json.dumps(k, ensure_ascii=False) + ":" + encode(v)
                for k, v in sorted(item.items())
            ) + "}"
        if isinstance(item, (list, tuple)):
            return "[" + ",".join(encode(v) for v in item) + "]"
        return json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    return encode(value)


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hash_canonical(value: Any) -> str:
    return sha256_hex(canonical_json(value))


def now_iso() -> str:
    """ISO-8601 UTC, second precision (matches the TS nowIso())."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
