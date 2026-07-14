"""
Edge case tests for Elium container.
Tests boundary conditions, malformed inputs, and error handling.
"""
import pytest

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumFormatError, EliumSecurityError, EliumVersionError
from elium.crypto.primitives import generate_ed25519_keypair


class TestEdgeCases:
    """Tests for boundary conditions and unusual inputs."""

    def test_empty_payload(self):
        """Encoding and decoding an empty payload should work."""
        password = "test_password"
        encoded = EliumContainer.encode(
            payload=b"",
            password=password,
            cascade=False
        )
        payload, manifest, header = EliumContainer.decode(encoded, password)
        assert payload == b""
        assert header["version"] == 3

    def test_large_payload(self):
        """Encoding a larger payload should work."""
        password = "test_password"
        payload = b"X" * 10000
        encoded = EliumContainer.encode(
            payload=payload,
            password=password,
            cascade=False
        )
        dec_payload, _, _ = EliumContainer.decode(encoded, password)
        assert dec_payload == payload

    def test_unicode_password(self):
        """Non-ASCII passwords should work correctly."""
        password = "مرحبا_世界_🔐"
        payload = b"secret"
        encoded = EliumContainer.encode(payload=payload, password=password, cascade=False)
        dec_payload, _, _ = EliumContainer.decode(encoded, password)
        assert dec_payload == payload

    def test_unicode_manifest_metadata(self):
        """Non-ASCII manifest data should roundtrip correctly."""
        password = "test"
        meta = {"title": "Données françaises avec accénts", "author": "Éloi"}
        encoded = EliumContainer.encode(
            payload=b"data",
            password=password,
            manifest_meta=meta,
            cascade=False
        )
        _, manifest, _ = EliumContainer.decode(encoded, password)
        assert manifest["title"] == meta["title"]
        assert manifest["author"] == meta["author"]

    def test_no_compression(self):
        """Encoding without compression should roundtrip."""
        password = "test"
        payload = b"uncompressed data"
        encoded = EliumContainer.encode(
            payload=payload,
            password=password,
            compress=False,
            cascade=False
        )
        dec_payload, _, header = EliumContainer.decode(encoded, password)
        assert dec_payload == payload
        assert header["flags"]["compressed"] is False

    def test_cascade_with_signature(self):
        """Cascade + signature should work together."""
        password = "test"
        payload = b"signed and cascaded"
        priv, pub = generate_ed25519_keypair()
        encoded = EliumContainer.encode(
            payload=payload,
            password=password,
            cascade=True,
            signing_key=priv
        )
        dec_payload, _, header = EliumContainer.decode(
            encoded, password, verify_public_key=pub
        )
        assert dec_payload == payload
        assert header["flags"]["signed"] is True
        assert header["crypto"]["cascade"] == "chacha20-poly1305"


class TestMalformedInputs:
    """Tests for corrupted or malformed container data."""

    def test_too_short_blob(self):
        """A blob that is too short should raise EliumFormatError."""
        with pytest.raises(EliumFormatError, match="too short"):
            EliumContainer.decode(b"ELIUM\x03" + b"\x00" * 10, "test")

    def test_wrong_magic_bytes(self):
        """Wrong magic bytes should raise EliumFormatError."""
        blob = b"WRONG\x03" + b"\x00" * 100
        with pytest.raises(EliumFormatError, match="Invalid Magic"):
            EliumContainer.decode(blob, "test")

    def test_corrupted_header_json(self):
        """Corrupted header JSON should raise EliumFormatError."""
        import struct
        header = b"{invalid json"
        blob = b"ELIUM\x03"
        blob += struct.pack(">I", len(header))
        blob += header
        blob += b"\x00" * 100  # padding
        with pytest.raises(EliumFormatError, match="corrupted"):
            EliumContainer.decode(blob, "test")

    def test_wrong_version(self):
        """A container with wrong version should raise EliumVersionError."""
        import json
        import struct
        header = json.dumps({"version": 99}).encode("utf-8")
        blob = b"ELIUM\x03"
        blob += struct.pack(">I", len(header))
        blob += header
        blob += b"\x00" * 100
        with pytest.raises(EliumVersionError, match="99"):
            EliumContainer.decode(blob, "test")

    def test_empty_password_raises(self):
        """An empty password should raise ValueError."""
        with pytest.raises(ValueError, match="Password is required"):
            EliumContainer.encode(payload=b"data", password="")

    def test_keyfile_required_but_missing(self):
        """A container needing a keyfile should error without one."""
        password = "test"
        keyfile = b"my secret keyfile content"
        encoded = EliumContainer.encode(
            payload=b"data",
            password=password,
            keyfile=keyfile,
            cascade=False
        )
        with pytest.raises(EliumSecurityError, match="keyfile"):
            EliumContainer.decode(encoded, password)  # no keyfile provided

    def test_signature_without_verification_key_does_not_raise(self):
        """A signed file decoded without a public key should decode but set signature_valid to None."""
        password = "test"
        priv, _ = generate_ed25519_keypair()
        encoded = EliumContainer.encode(
            payload=b"data", password=password, signing_key=priv, cascade=False
        )
        dec_payload, manifest, header = EliumContainer.decode(encoded, password)
        assert dec_payload == b"data"
        assert header.get("signature_valid") is None

    def test_signature_wrong_key_raises(self):
        """Verifying with the wrong key should raise EliumSecurityError."""
        password = "test"
        priv1, _ = generate_ed25519_keypair()
        _, pub2 = generate_ed25519_keypair()
        encoded = EliumContainer.encode(
            payload=b"data", password=password, signing_key=priv1, cascade=False
        )
        with pytest.raises(EliumSecurityError, match="Invalid Ed25519 signature"):
            EliumContainer.decode(encoded, password, verify_public_key=pub2)


class TestKeyfile:
    """Tests for keyfile functionality."""

    def test_keyfile_roundtrip(self):
        """Encoding with keyfile should decode with same keyfile."""
        password = "test"
        keyfile = b"my secret keyfile content 12345"
        payload = b"protected data"
        encoded = EliumContainer.encode(
            payload=payload, password=password,
            keyfile=keyfile, cascade=False
        )
        dec_payload, _, header = EliumContainer.decode(
            encoded, password, keyfile=keyfile
        )
        assert dec_payload == payload
        assert header["flags"]["keyfile_required"] is True

    def test_wrong_keyfile_fails(self):
        """A wrong keyfile should fail HMAC verification."""
        password = "test"
        keyfile = b"correct keyfile"
        encoded = EliumContainer.encode(
            payload=b"data", password=password,
            keyfile=keyfile, cascade=False
        )
        with pytest.raises(EliumSecurityError, match="HMAC"):
            EliumContainer.decode(encoded, password, keyfile=b"wrong keyfile")
