import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization

from elium.crypto.primitives import (
    generate_ed25519_keypair,
    get_public_key_fingerprint,
    load_private_key,
)


def test_ed25519_generation_and_fingerprint():
    priv, pub = generate_ed25519_keypair()

    fp1 = get_public_key_fingerprint(pub)
    assert len(fp1) == 64  # SHA256 hex digest length

    # Another key should have a different fingerprint
    _, pub2 = generate_ed25519_keypair()
    fp2 = get_public_key_fingerprint(pub2)
    assert fp1 != fp2

def test_ed25519_signing_and_verification():
    priv, pub = generate_ed25519_keypair()
    message = b"Important document content"

    signature = priv.sign(message)
    assert len(signature) == 64

    # Should verify successfully
    pub.verify(signature, message)

    # Tampered message should fail
    with pytest.raises(InvalidSignature):
        pub.verify(signature, b"Tampered document content")

    # Tampered signature should fail
    tampered_sig = bytearray(signature)
    tampered_sig[0] ^= 1
    with pytest.raises(InvalidSignature):
        pub.verify(bytes(tampered_sig), message)

def test_key_serialization(tmp_path):
    priv, pub = generate_ed25519_keypair()

    # Save private key
    priv_bytes = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )

    priv_file = tmp_path / "private.pem"
    priv_file.write_bytes(priv_bytes)

    # Load private key
    loaded_priv = load_private_key(priv_file.read_bytes())

    # Ensure they produce the same signature
    msg = b"test"
    assert priv.sign(msg) == loaded_priv.sign(msg)
