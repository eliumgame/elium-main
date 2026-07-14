"""
Tests for the Elium CLI module.
Tests argument parsing and main function behavior.
"""
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives import serialization

from elium.cli.main import main
from elium.core.container import EliumContainer
from elium.crypto.primitives import generate_ed25519_keypair


class TestCLICreate:
    """Tests for the 'create' CLI command."""

    def test_create_basic(self, tmp_path):
        """Basic create command should produce a valid .elium file."""
        input_file = tmp_path / "test.txt"
        input_file.write_text("Hello, Elium CLI!")
        output_file = tmp_path / "test.elium"

        with patch("sys.argv", [
            "elium", "create",
            "--input", str(input_file),
            "--output", str(output_file),
            "--password", "test_password"
        ]):
            main()

        assert output_file.exists()
        assert output_file.stat().st_size > 0

        # Verify the output can be decoded
        blob = output_file.read_bytes()
        payload, manifest, header = EliumContainer.decode(blob, "test_password")
        assert payload == b"Hello, Elium CLI!"
        assert manifest["files"][0]["name"] == "test.txt"

    def test_create_with_sign(self, tmp_path):
        """Create with --sign should produce a signed container."""
        priv, pub = generate_ed25519_keypair()
        key_file = tmp_path / "key.pem"
        key_file.write_bytes(priv.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ))

        input_file = tmp_path / "doc.txt"
        input_file.write_bytes(b"Signed document")
        output_file = tmp_path / "doc.elium"

        with patch("sys.argv", [
            "elium", "create",
            "--input", str(input_file),
            "--output", str(output_file),
            "--password", "password123",
            "--sign", str(key_file)
        ]):
            main()

        blob = output_file.read_bytes()
        payload, _, header = EliumContainer.decode(
            blob, "password123", verify_public_key=pub
        )
        assert payload == b"Signed document"
        assert header["flags"]["signed"] is True

    def test_create_prompts_password(self, tmp_path):
        """Create without --password should prompt via getpass."""
        input_file = tmp_path / "test.txt"
        input_file.write_text("content")
        output_file = tmp_path / "test.elium"

        with patch("sys.argv", [
            "elium", "create",
            "--input", str(input_file),
            "--output", str(output_file),
        ]):
            with patch("elium.cli.main.getpass.getpass", return_value="prompted_pwd"):
                main()

        blob = output_file.read_bytes()
        payload, _, _ = EliumContainer.decode(blob, "prompted_pwd")
        assert payload == b"content"


class TestCLIOpen:
    """Tests for the 'open' CLI command."""

    def test_open_basic(self, tmp_path):
        """Open command should decrypt and extract a file."""
        # First create a container
        payload = b"Extract me!"
        encoded = EliumContainer.encode(
            payload=payload,
            password="pwd",
            manifest_meta={"files": [{"name": "output.txt", "size": len(payload)}]},
            cascade=False
        )
        container_file = tmp_path / "test.elium"
        container_file.write_bytes(encoded)

        output_dir = tmp_path / "extracted"

        with patch("sys.argv", [
            "elium", "open", str(container_file),
            "--password", "pwd",
            "--output", str(output_dir)
        ]):
            main()

        extracted = output_dir / "output.txt"
        assert extracted.exists()
        assert extracted.read_bytes() == payload

    def test_open_wrong_password(self, tmp_path):
        """Open with wrong password should exit with error."""
        encoded = EliumContainer.encode(payload=b"data", password="correct", cascade=False)
        container_file = tmp_path / "test.elium"
        container_file.write_bytes(encoded)

        with patch("sys.argv", [
            "elium", "open", str(container_file),
            "--password", "wrong"
        ]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 1
