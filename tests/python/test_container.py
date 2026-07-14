
import pytest

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumSecurityError
from elium.crypto.primitives import generate_ed25519_keypair


def test_container_roundtrip():
    payload = b"Hello, Elium v3!"
    password = "SuperSecretPassword123"

    # Encode
    encoded = EliumContainer.encode(
        payload=payload,
        password=password,
        manifest_meta={"files": [{"name": "test.txt"}]},
        compress=True,
        cascade=False
    )

    assert encoded.startswith(b"ELIUM\x03")

    # Decode
    dec_payload, manifest, header = EliumContainer.decode(encoded, password)

    assert dec_payload == payload
    assert manifest["files"][0]["name"] == "test.txt"
    assert header["version"] == 3

def test_invalid_password():
    payload = b"Secret data"
    password = "CorrectHorseBatteryStaple"

    encoded = EliumContainer.encode(payload, password)

    with pytest.raises(EliumSecurityError):
        EliumContainer.decode(encoded, "WrongPassword")

def test_signature():
    payload = b"Signed data"
    password = "password"
    priv, pub = generate_ed25519_keypair()

    encoded = EliumContainer.encode(payload, password, signing_key=priv)

    dec_payload, manifest, header = EliumContainer.decode(
        encoded, password, verify_public_key=pub
    )
    assert dec_payload == payload
    assert header["flags"]["signed"] is True

def test_corruption_hmac():
    payload = b"Data to corrupt"
    password = "pwd"
    encoded = bytearray(EliumContainer.encode(payload, password))

    # Corrupt the HMAC (last bytes)
    encoded[-1] ^= 0x01

    with pytest.raises(EliumSecurityError, match="HMAC verification failed"):
        EliumContainer.decode(bytes(encoded), password)
