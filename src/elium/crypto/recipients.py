"""
Multi-recipient encryption — encrypt one payload so several recipients can each
decrypt it with their OWN private key, without any shared password.

Construction (hybrid public-key encryption, ECDH-ES):
  - a random 32-byte Content Encryption Key (CEK) encrypts the payload once
    (AES-256-GCM);
  - for each recipient, an EPHEMERAL P-256 keypair is generated; ECDH with the
    recipient's P-256 public key yields a shared secret; HKDF-SHA256 derives a
    wrapping key that AES-256-GCM-wraps the CEK.
So the body is encrypted once; only the small CEK is wrapped per recipient.

P-256 (secp256r1) is used because it is natively available on both sides with no
extra dependency: Python `cryptography` and the browser/Node Web Crypto API.
Byte-compatible mirror of web-studio/src/crypto/recipients.ts.

Recipient keys are raw uncompressed points (0x04 || X || Y, 65 bytes, hex).
"""
from __future__ import annotations

import json
import os
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from elium.core.exceptions import EliumSecurityError
from elium.crypto.primitives import derive_subkey

RECIPIENTS_SCHEMA = "elium-recipients/1"
_AAD = RECIPIENTS_SCHEMA.encode("utf-8")
_HKDF_INFO = b"elium-recipients/1/wrap"
# Subkeys derived from the (wrapped) CEK material when `cascade=True` — mirror
# of EliumContainer's k_aes/k_cha derivation (container.py), so secure_max
# gets the same two-layer AEAD whether the body is protected by a password or
# by recipient keys.
_HKDF_INFO_AES = b"elium-recipients/1/cek-aes"
_HKDF_INFO_CHA = b"elium-recipients/1/cek-cha"
_CURVE = ec.SECP256R1()


# --- key helpers ------------------------------------------------------------

def generate_recipient_keypair() -> tuple[str, str]:
    """Return (private_hex, public_hex) for a new P-256 recipient key.

    private_hex = the private scalar (32 bytes). public_hex = uncompressed point.
    """
    priv = ec.generate_private_key(_CURVE)
    priv_int = priv.private_numbers().private_value
    priv_bytes = priv_int.to_bytes(32, "big")
    pub_bytes = priv.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return priv_bytes.hex(), pub_bytes.hex()


def public_from_private(private_hex: str) -> str:
    priv = _load_private(private_hex)
    pub = priv.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return pub.hex()


def recipient_fingerprint(public_hex: str) -> str:
    import hashlib
    return hashlib.sha256(bytes.fromhex(public_hex)).hexdigest()


def _load_private(private_hex: str) -> ec.EllipticCurvePrivateKey:
    value = int.from_bytes(bytes.fromhex(private_hex), "big")
    return ec.derive_private_key(value, _CURVE)


def _load_public(public_hex: str) -> ec.EllipticCurvePublicKey:
    return ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, bytes.fromhex(public_hex))


def _wrap_key(shared: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_HKDF_INFO).derive(shared)


# --- encrypt / decrypt ------------------------------------------------------

def encrypt_for_recipients(
    payload: bytes, recipient_public_hexes: list[str], *, cascade: bool = False
) -> bytes:
    """Encrypt `payload` for every recipient. Returns a self-describing JSON blob.

    `cascade=True` adds a ChaCha20-Poly1305 layer on top of the AES-256-GCM
    body encryption (same construction as EliumContainer's secure_max cascade,
    container.py), so secure_max gets the same protection level regardless of
    whether the body is protected by a password or by recipient keys.
    """
    if not recipient_public_hexes:
        raise EliumSecurityError("Aucun destinataire fourni.")

    # This is the material wrapped per-recipient below. Without cascade it IS
    # the AES-256-GCM key directly; with cascade it is expanded (HKDF) into
    # two independent subkeys, mirroring derive_subkey() in container.py.
    cek_material = os.urandom(32)
    content_nonce = os.urandom(12)
    cascade_nonce: bytes | None = None

    if cascade:
        k_aes = derive_subkey(cek_material, _HKDF_INFO_AES)
        k_cha = derive_subkey(cek_material, _HKDF_INFO_CHA)
        content_ct = AESGCM(k_aes).encrypt(content_nonce, payload, _AAD)
        cascade_nonce = os.urandom(12)
        content_ct = ChaCha20Poly1305(k_cha).encrypt(cascade_nonce, content_ct, _AAD)
    else:
        content_ct = AESGCM(cek_material).encrypt(content_nonce, payload, _AAD)

    recipients: list[dict[str, str]] = []
    for pub_hex in recipient_public_hexes:
        recipient_pub = _load_public(pub_hex)
        eph = ec.generate_private_key(_CURVE)
        shared = eph.exchange(ec.ECDH(), recipient_pub)
        wrap_key = _wrap_key(shared)
        wrap_nonce = os.urandom(12)
        wrapped = AESGCM(wrap_key).encrypt(wrap_nonce, cek_material, _AAD)
        epk = eph.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        recipients.append({
            "fpr": recipient_fingerprint(pub_hex),
            "epk": epk.hex(),
            "nonce": wrap_nonce.hex(),
            "wrap": wrapped.hex(),
        })

    envelope: dict[str, Any] = {
        "schema": RECIPIENTS_SCHEMA,
        "alg": "ecdh-es-p256+aes-256-gcm" + ("+chacha20-poly1305-cascade" if cascade else ""),
        "cascade": cascade,
        "contentNonce": content_nonce.hex(),
        "content": content_ct.hex(),
        "recipients": recipients,
    }
    if cascade_nonce is not None:
        envelope["cascadeNonce"] = cascade_nonce.hex()
    return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def list_recipient_fingerprints(blob: bytes) -> list[str]:
    env = json.loads(blob)
    return [r["fpr"] for r in env.get("recipients", [])]


def decrypt_as_recipient(blob: bytes, private_hex: str) -> bytes:
    """Decrypt the envelope using the recipient's P-256 private key."""
    try:
        env = json.loads(blob)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise EliumSecurityError("Enveloppe multi-destinataires illisible.") from e
    if env.get("schema") != RECIPIENTS_SCHEMA:
        raise EliumSecurityError("Ce n'est pas une enveloppe multi-destinataires Elium.")

    priv = _load_private(private_hex)
    my_fpr = recipient_fingerprint(public_from_private(private_hex))

    # Try the entry matching our fingerprint first, then fall back to trying all
    # (a sender might mislabel fingerprints; ECDH+AEAD still gates correctness).
    entries = env.get("recipients", [])
    ordered = sorted(entries, key=lambda r: r.get("fpr") != my_fpr)
    cascade = bool(env.get("cascade"))

    last_err: Exception | None = None
    for r in ordered:
        try:
            epk = _load_public(r["epk"])
            shared = priv.exchange(ec.ECDH(), epk)
            wrap_key = _wrap_key(shared)
            cek_material = AESGCM(wrap_key).decrypt(bytes.fromhex(r["nonce"]), bytes.fromhex(r["wrap"]), _AAD)
            content_nonce = bytes.fromhex(env["contentNonce"])
            content_ct = bytes.fromhex(env["content"])
            if cascade:
                k_aes = derive_subkey(cek_material, _HKDF_INFO_AES)
                k_cha = derive_subkey(cek_material, _HKDF_INFO_CHA)
                cascade_nonce = bytes.fromhex(env["cascadeNonce"])
                content_ct = ChaCha20Poly1305(k_cha).decrypt(cascade_nonce, content_ct, _AAD)
                return AESGCM(k_aes).decrypt(content_nonce, content_ct, _AAD)
            return AESGCM(cek_material).decrypt(content_nonce, content_ct, _AAD)
        except Exception as e:  # noqa: BLE001 — try the next recipient entry
            last_err = e
            continue
    raise EliumSecurityError("Aucune clé de destinataire ne permet de déchiffrer ce document.") from last_err
