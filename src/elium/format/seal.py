"""
Document seal — a single Ed25519 anchor that authenticates the integrity-
critical parts of a `.elium` file as a whole (Python mirror of seal.ts).

Why this exists
---------------
`manifest.json`, `signatures/signatures.json` and `tracking/journal.json` are
stored as clear-text ZIP entries. The per-content SHA-256 in the manifest is
NOT keyed, so an attacker who edits the content (or the journal, or the set of
signatures, or the profile badge) can simply recompute it: silent tampering.

The seal closes that gap. The author signs a canonical digest of:
    { manifest integrity subset, sha256(signatures), sha256(journal) }
Any later change to those parts makes the seal fail to verify — unless the
attacker re-signs with a *different* key, which changes the visible
fingerprint. This is the strongest tamper-evidence achievable without a PKI.

A seal is NEVER a qualified electronic signature. See DOCUMENTATION.md (§7).
"""

from __future__ import annotations

import hashlib
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from elium.format.canonical import canonical_json, now_iso, sha256_hex

# Verdicts (mirror seal.ts SealVerdict).
SEAL_UNSEALED = "unsealed"          # no seal present
SEAL_VALID = "valid"                # seal verifies; key trusted or no trust requested
SEAL_UNKNOWN_KEY = "unknown_key"    # seal verifies but signer key != trusted key
SEAL_BROKEN = "broken"              # seal does not verify: tampered or corrupt


def _manifest_subset(manifest: dict) -> dict[str, Any]:
    """The integrity-critical fields the seal protects.

    Excludes volatile/derived fields (modifiedAt, generator, features, rgpd)
    and the `seal` object itself, so a normal re-save does not break the seal
    while any meaningful change to identity/protection/integrity does.
    """
    protection = manifest.get("protection", {})
    integrity = manifest.get("integrity", {})
    subset: dict[str, Any] = {
        "format": manifest.get("format"),
        "formatVersion": manifest.get("formatVersion"),
        "profile": manifest.get("profile"),
        "title": manifest.get("title"),
        "language": manifest.get("language"),
        "createdAt": manifest.get("createdAt"),
        "protection": {
            "encrypted": protection.get("encrypted"),
            "locked": protection.get("locked"),
            "keyfileRequired": protection.get("keyfileRequired"),
            "contentEntry": protection.get("contentEntry"),
        },
        "integrity": {
            "algorithm": integrity.get("algorithm"),
            "contentHash": integrity.get("contentHash"),
        },
    }
    # Included only when set, so existing seals (no expiry) stay byte-identical.
    if manifest.get("accessExpiresAt"):
        subset["accessExpiresAt"] = manifest["accessExpiresAt"]
    return subset


def seal_message(manifest: dict, signatures: list[dict], journal: dict) -> str:
    """The exact canonical string that gets signed (identical in Python and TS)."""
    return canonical_json(
        {
            "v": 1,
            "manifest": _manifest_subset(manifest),
            "signaturesHash": sha256_hex(canonical_json(signatures)),
            "journalHash": sha256_hex(canonical_json(journal)),
        }
    )


def create_seal(manifest: dict, signatures: list[dict], journal: dict, private_key_hex: str) -> dict[str, Any]:
    """Produce the seal object to embed at manifest['seal']."""
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    message = seal_message(manifest, signatures, journal).encode("utf-8")
    signature = priv.sign(message)
    return {
        "alg": "ed25519",
        "publicKeyHex": pub_raw.hex(),
        "fingerprint": hashlib.sha256(pub_raw).hexdigest(),
        "sealedAt": now_iso(),
        "signatureHex": signature.hex(),
    }


def verify_seal(
    manifest: dict,
    signatures: list[dict],
    journal: dict,
    trusted_key_hex: str | None = None,
) -> str:
    """Returns one of: unsealed | valid | unknown_key | broken."""
    seal = manifest.get("seal")
    if not seal:
        return SEAL_UNSEALED

    message = seal_message(manifest, signatures, journal).encode("utf-8")
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(seal["publicKeyHex"]))
        pub.verify(bytes.fromhex(seal["signatureHex"]), message)
    except (InvalidSignature, ValueError, KeyError):
        return SEAL_BROKEN

    if trusted_key_hex and trusted_key_hex.strip().lower() != seal["publicKeyHex"].lower():
        return SEAL_UNKNOWN_KEY
    return SEAL_VALID
