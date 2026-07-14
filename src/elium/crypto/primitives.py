"""
Cryptographic primitives for Elium v3.
"""
from __future__ import annotations

import hashlib
import hmac
import os

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from elium.core.exceptions import EliumSecurityError

# Security constants
SALT_SIZE = 16
NONCE_SIZE = 12
KEY_SIZE = 32
HMAC_SIZE = 32
SIGNATURE_SIZE = 64

# Recommended Argon2id parameters
ARGON2_TIME = 3
ARGON2_MEMORY_KIB = 262144  # 256 MiB
ARGON2_PARALLELISM = 4

def generate_salt() -> bytes:
    return os.urandom(SALT_SIZE)

def generate_nonce() -> bytes:
    return os.urandom(NONCE_SIZE)

def derive_master_key(
    password: str,
    salt: bytes,
    keyfile: bytes | None = None,
    time_cost: int = ARGON2_TIME,
    memory_kib: int = ARGON2_MEMORY_KIB,
    parallelism: int = ARGON2_PARALLELISM
) -> bytes:
    """Derives a master key using Argon2id."""
    data = password.encode("utf-8")
    if keyfile is not None:
        data = data + b"|KF|" + hashlib.sha256(keyfile).digest()

    return hash_secret_raw(
        secret=data,
        salt=salt,
        time_cost=time_cost,
        memory_cost=memory_kib,
        parallelism=parallelism,
        hash_len=KEY_SIZE,
        type=Type.ID
    )

def derive_subkey(master: bytes, info: bytes) -> bytes:
    """Derives a subkey using HKDF-SHA256."""
    return HKDF(
        algorithm=hashes.SHA256(),
        length=KEY_SIZE,
        salt=None,
        info=info
    ).derive(master)

def generate_ed25519_keypair() -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    """Generates a new Ed25519 keypair for signing."""
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    return priv, pub

def load_private_key(data: bytes | str, password: str | None = None) -> Ed25519PrivateKey:
    if isinstance(data, str):
        data = data.encode("utf-8")
    pwd_bytes = password.encode("utf-8") if password else None
    return serialization.load_pem_private_key(data, password=pwd_bytes)

def load_public_key(data: bytes | str) -> Ed25519PublicKey:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return serialization.load_pem_public_key(data)

def get_public_key_fingerprint(public_key: Ed25519PublicKey) -> str:
    """Returns SHA256 fingerprint of the raw public key bytes."""
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )
    return hashlib.sha256(raw).hexdigest()

def encrypt_aead(key: bytes, nonce: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """Encrypts data using AES-256-GCM."""
    return AESGCM(key).encrypt(nonce, plaintext, aad)

def decrypt_aead(key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
    """Decrypts data using AES-256-GCM."""
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)
    except Exception as e:
        raise EliumSecurityError("AEAD decryption failed. Invalid key or corrupted data.") from e

def encrypt_cascade(key_cha: bytes, nonce_cha: bytes, ciphertext_aes: bytes, aad: bytes) -> bytes:
    """Adds a ChaCha20-Poly1305 encryption layer on top of AES-GCM ciphertext."""
    return ChaCha20Poly1305(key_cha).encrypt(nonce_cha, ciphertext_aes, aad)

def decrypt_cascade(key_cha: bytes, nonce_cha: bytes, ciphertext_cha: bytes, aad: bytes) -> bytes:
    """Removes the ChaCha20-Poly1305 encryption layer."""
    try:
        return ChaCha20Poly1305(key_cha).decrypt(nonce_cha, ciphertext_cha, aad)
    except Exception as e:
        raise EliumSecurityError("Cascade AEAD decryption failed. Invalid key or corrupted data.") from e

def compute_hmac(key: bytes, data: bytes) -> bytes:
    """Computes HMAC-SHA256."""
    return hmac.new(key, data, hashlib.sha256).digest()

def verify_hmac(key: bytes, data: bytes, expected_mac: bytes) -> None:
    """Verifies HMAC-SHA256 in constant time."""
    computed = compute_hmac(key, data)
    if not hmac.compare_digest(computed, expected_mac):
        raise EliumSecurityError(
            "HMAC verification failed. The file is corrupted or the password/keyfile is incorrect."
        )
