"""Fixtures isolées du lot Chaîne : aucune clé ni donnée utilisateur réelle."""
import json
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import updater  # noqa: E402


@pytest.fixture
def signed_updates(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("ELIUM_NO_UPDATE", "1")
    monkeypatch.setattr(updater, "current_version", lambda: "4.0.0")
    monkeypatch.setattr(updater, "BUILD_CODE_HASH", "a" * 64)
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw,
    ).hex()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", public)
    monkeypatch.setattr(updater, "UPDATE_EXTRA_PUBLIC_KEYS", {})
    updater.reset_verification_cache()

    def sign(data):
        raw = json.dumps(data).encode("utf-8")
        return updater._parse_signed_manifest(raw, private.sign(raw).hex())

    yield sign
    updater.reset_verification_cache()
