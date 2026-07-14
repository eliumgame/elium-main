import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from elium.core.exceptions import EliumSecurityError
from elium.crypto.primitives import (
    compute_hmac,
    decrypt_aead,
    decrypt_cascade,
    derive_master_key,
    derive_subkey,
    encrypt_aead,
    encrypt_cascade,
    generate_nonce,
    generate_salt,
    verify_hmac,
)


def test_key_derivation():
    password = "super_secure_password"
    salt = generate_salt()

    # Derivation should be deterministic for same password and salt
    master1 = derive_master_key(password, salt)
    master2 = derive_master_key(password, salt)
    assert master1 == master2

    # Different salt -> different key
    salt2 = generate_salt()
    master3 = derive_master_key(password, salt2)
    assert master1 != master3

    # Subkeys should be deterministic but different from master
    subkey = derive_subkey(master1, b"info")
    assert subkey != master1
    assert len(subkey) == 32

def test_aead_encryption():
    key = AESGCM.generate_key(bit_length=256)
    nonce = generate_nonce()
    aad = b"header data"
    plaintext = b"secret payload"

    ct = encrypt_aead(key, nonce, plaintext, aad)
    assert ct != plaintext

    pt = decrypt_aead(key, nonce, ct, aad)
    assert pt == plaintext

    # Tampering should fail
    tampered_ct = bytearray(ct)
    tampered_ct[0] ^= 1
    with pytest.raises(EliumSecurityError):
        decrypt_aead(key, nonce, bytes(tampered_ct), aad)

    # Wrong AAD should fail
    with pytest.raises(EliumSecurityError):
        decrypt_aead(key, nonce, ct, b"wrong header")

def test_cascade_encryption():
    key_cha = os.urandom(32)
    nonce_cha = generate_nonce()
    aad = b"header data"
    plaintext = b"already encrypted data"

    ct = encrypt_cascade(key_cha, nonce_cha, plaintext, aad)
    assert ct != plaintext

    pt = decrypt_cascade(key_cha, nonce_cha, ct, aad)
    assert pt == plaintext

def test_hmac_verification():
    key = os.urandom(32)
    data = b"message"

    mac = compute_hmac(key, data)
    assert len(mac) == 32

    # Should pass without exception
    verify_hmac(key, data, mac)

    # Tampered data
    with pytest.raises(EliumSecurityError):
        verify_hmac(key, b"messagf", mac)

    # Tampered mac
    tampered_mac = bytearray(mac)
    tampered_mac[0] ^= 1
    with pytest.raises(EliumSecurityError):
        verify_hmac(key, data, bytes(tampered_mac))
