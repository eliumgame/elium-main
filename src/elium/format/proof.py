"""
Cryptographic signature proof (Python mirror of sign/proof.ts).

Interoperable with the web implementation: the signed message and content hash
use the same canonical JSON, so a proof created on one side verifies on the other.
"""

from __future__ import annotations

import hashlib
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from elium.format.canonical import canonical_json, now_iso, sha256_hex

_TS_NOTE = "Horodatage local non qualifié (pas d'autorité de temps)."


def compute_content_hash(model: dict) -> str:
    return sha256_hex(canonical_json(model))


def _to_be_signed(signature_id: str, signed_hash: str, signer: dict, signed_at: str) -> str:
    return canonical_json(
        {"v": 1, "signatureId": signature_id, "signedContentHash": signed_hash, "signer": signer, "signedAt": signed_at}
    )


def generate_identity() -> dict[str, str]:
    priv = Ed25519PrivateKey.generate()
    priv_raw = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return {
        "privateKeyHex": priv_raw.hex(),
        "publicKeyHex": pub_raw.hex(),
        "fingerprint": hashlib.sha256(pub_raw).hexdigest(),
    }


def create_proof(signature_id: str, model: dict, signer: dict, private_key_hex: str) -> dict[str, Any]:
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_key_hex))
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    public_key_hex = pub_raw.hex()
    signed_hash = compute_content_hash(model)
    signed_at = now_iso()
    message = _to_be_signed(signature_id, signed_hash, signer, signed_at)
    signature = priv.sign(message.encode("utf-8"))
    return {
        "alg": "ed25519",
        "publicKeyHex": public_key_hex,
        "fingerprint": hashlib.sha256(pub_raw).hexdigest(),
        "contentHashAlg": "sha-256",
        "signedContentHash": signed_hash,
        "signatureHex": signature.hex(),
        "signedAt": signed_at,
        "timestamp": {"type": "local", "at": signed_at, "note": _TS_NOTE},
    }


def verify_proof(signature: dict, model: dict, trusted_key_hex: str | None = None) -> str:
    """Returns: valid | modified | invalid | unknown_key | visual_only."""
    proof = signature.get("proof")
    if not proof:
        return "visual_only"

    message = _to_be_signed(
        signature["id"], proof["signedContentHash"], signature.get("signer", {}), proof["signedAt"]
    ).encode("utf-8")
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(proof["publicKeyHex"]))
        pub.verify(bytes.fromhex(proof["signatureHex"]), message)
    except (InvalidSignature, ValueError):
        return "invalid"

    if trusted_key_hex and trusted_key_hex.strip().lower() != proof["publicKeyHex"].lower():
        return "unknown_key"

    return "valid" if compute_content_hash(model) == proof["signedContentHash"] else "modified"
