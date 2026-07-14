"""
Elium documentary format v4 (Python core).

Mirrors the TypeScript implementation in `web-studio/src/format` so a `.elium`
package written by one side can be read by the other. The format is a ZIP/OPC
package; encryption reuses the audited v3 container (`elium.core.container`).
"""

from elium.format.canonical import canonical_json, hash_canonical, now_iso, sha256_hex
from elium.format.journal import append_event, empty_journal, verify_journal
from elium.format.package import EliumPackageError, read_elium, write_elium
from elium.format.profiles import PROFILES

__all__ = [
    "canonical_json",
    "hash_canonical",
    "sha256_hex",
    "now_iso",
    "empty_journal",
    "append_event",
    "verify_journal",
    "read_elium",
    "write_elium",
    "EliumPackageError",
    "PROFILES",
]
