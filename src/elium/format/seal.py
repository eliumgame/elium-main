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

A seal is NEVER a qualified electronic signature. See la Documentation (§7).
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


SEAL_MSG_VERSION = 2  # signed-message generation carried by new seals (seal["msgVersion"])


def _manifest_subset(
    manifest: dict, include_doc_id: bool, include_recipients: bool, strict: bool = False
) -> dict[str, Any]:
    """The integrity-critical fields the seal protects.

    Excludes volatile/derived fields (modifiedAt, generator, features, rgpd)
    and the `seal` object itself, so a normal re-save does not break the seal
    while any meaningful change to identity/protection/integrity does.

    `docId` and the recipient set (`protection.recipients`) are authenticated too
    when present AND requested — they were added at different times, so verify_seal
    falls back to the older forms (dropping the newest field first) to keep
    already-sealed files valid (mirror of seal.ts). A field absent from the
    manifest is never added, so files that never carried it stay byte-identical.
    """
    protection = manifest.get("protection", {})
    integrity = manifest.get("integrity", {})
    protection_subset: dict[str, Any] = {
        "encrypted": protection.get("encrypted"),
        "locked": protection.get("locked"),
        "keyfileRequired": protection.get("keyfileRequired"),
        "contentEntry": protection.get("contentEntry"),
    }
    # Binds the "who can read this" list of a sealed multi-recipient file, so a
    # displayed recipient fingerprint cannot be silently added or removed. Present
    # only on recipient files → non-recipient seals are unchanged.
    if include_recipients and protection.get("recipients"):
        protection_subset["recipients"] = protection["recipients"]
    subset: dict[str, Any] = {
        "format": manifest.get("format"),
        "formatVersion": manifest.get("formatVersion"),
        "profile": manifest.get("profile"),
        "title": manifest.get("title"),
        "language": manifest.get("language"),
        "createdAt": manifest.get("createdAt"),
        "protection": protection_subset,
        "integrity": {
            "algorithm": integrity.get("algorithm"),
            "contentHash": integrity.get("contentHash"),
        },
    }
    # Included only when set, so existing seals (no expiry/docId) stay byte-identical.
    if manifest.get("accessExpiresAt"):
        subset["accessExpiresAt"] = manifest["accessExpiresAt"]
    if include_doc_id and manifest.get("docId"):
        subset["docId"] = manifest["docId"]
    if strict:
        # Seal message v2 (CORE-03): `docId` and `protection.recipients` are ALWAYS
        # present in the signed subset (null / [] when absent). Their absence is
        # therefore itself signed: nobody can inject a docId or a recipient list
        # into a file that was sealed without one. The legacy multi-form fallback
        # (which accepted exactly that) is only used for seals WITHOUT msgVersion=2.
        subset["docId"] = manifest.get("docId") or None
        protection_subset["recipients"] = list(protection.get("recipients") or [])
    return subset


def seal_message(
    manifest: dict,
    signatures: list[dict],
    journal: dict,
    include_doc_id: bool = True,
    include_recipients: bool = True,
    strict: bool = False,
) -> str:
    """The exact canonical string that gets signed (identical in Python and TS).

    `strict=True` is the v2 form (new seals); `False` reproduces the legacy v1
    forms byte-for-byte so already-sealed files keep verifying."""
    return canonical_json(
        {
            "v": SEAL_MSG_VERSION if strict else 1,
            "manifest": _manifest_subset(manifest, include_doc_id, include_recipients, strict),
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
    message = seal_message(manifest, signatures, journal, strict=True).encode("utf-8")
    signature = priv.sign(message)
    return {
        "alg": "ed25519",
        "msgVersion": SEAL_MSG_VERSION,
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

    # Multi-mode: the sealed subset gained optional fields over time (docId, then
    # the recipient set). Accept a seal that matches the current full form OR an
    # older form, dropping the newest optional field first (mirror of seal.ts).
    # Safe: the signature is over exactly ONE form, so a file whose docId/recipient
    # set is tampered matches NONE and reads "broken"; the fallbacks only rescue
    # genuinely older seals. Fields absent from the manifest are not toggled.
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(seal["publicKeyHex"]))
        sig = bytes.fromhex(seal["signatureHex"])
    except (ValueError, KeyError):
        return SEAL_BROKEN

    # L'empreinte affichée DOIT être celle de la clé qui a réellement signé : sinon un
    # attaquant re-signe avec sa clé en gardant l'empreinte de la victime.
    if seal.get("fingerprint") != hashlib.sha256(bytes.fromhex(seal["publicKeyHex"])).hexdigest():
        return SEAL_BROKEN

    strict_seal = seal.get("msgVersion") == SEAL_MSG_VERSION

    def _matches(include_doc_id: bool, include_recipients: bool, strict: bool = False) -> bool:
        message = seal_message(
            manifest, signatures, journal, include_doc_id, include_recipients, strict
        ).encode("utf-8")
        try:
            pub.verify(sig, message)
            return True
        except InvalidSignature:
            return False

    recipient_forms = [True, False] if manifest.get("protection", {}).get("recipients") else [False]
    docid_forms = [True, False] if manifest.get("docId") else [False]
    if strict_seal:
        # v2 seal: exactly one form, no downgrade. Stripping `msgVersion` cannot help
        # an attacker either: a v2 signature never matches a legacy message.
        authentic = _matches(True, True, strict=True)
    else:
        authentic = any(_matches(d, r) for r in recipient_forms for d in docid_forms)
    if not authentic:
        return SEAL_BROKEN

    if trusted_key_hex and trusted_key_hex.strip().lower() != seal["publicKeyHex"].lower():
        return SEAL_UNKNOWN_KEY
    return SEAL_VALID
