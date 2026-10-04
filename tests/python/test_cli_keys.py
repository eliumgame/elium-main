"""`elium keys` : liste / génération / export / import / rotation, et dépréciation des clés en argument."""
import json
from unittest.mock import patch

import pytest

from elium.cli.main import main
from elium.crypto.keybundle import open_key_bundle, parse_key_bundle, verify_succession


@pytest.fixture()
def kdir(tmp_path, monkeypatch):
    d = tmp_path / "keys"
    monkeypatch.setenv("ELIUM_KEYS_DIR", str(d))
    monkeypatch.setenv("ELIUM_KEYRING_PASSWORD", "pw-trousseau")
    return d


def run(*argv):
    with patch("sys.argv", ["elium", *argv]):
        main()


def keyring(kdir):
    return json.loads((kdir / "keyring.json").read_text(encoding="utf-8"))


def test_generate_list_and_no_plaintext_private_key(kdir, capsys):
    run("keys", "generate", "identity", "--label", "Moi")
    run("keys", "generate", "recipient")
    data = keyring(kdir)
    assert [k["type"] for k in data["keys"]] == ["identity-ed25519", "recipient-p256"]
    raw = (kdir / "keyring.json").read_text(encoding="utf-8")
    assert "privateHex" not in raw and all(len(k["enc"]) > 100 for k in data["keys"])
    capsys.readouterr()
    run("keys", "list")
    out = capsys.readouterr().out
    assert data["keys"][0]["kid"] in out and "Moi" in out


def test_export_import_roundtrip_between_two_keyrings(kdir, tmp_path, monkeypatch):
    run("keys", "generate", "identity")
    run("keys", "generate", "recipient")
    out = tmp_path / "sauv.eliumkey"
    run("keys", "export", "--output", str(out))
    assert keyring(kdir)["keys"][0].get("backedUpAt")
    # Le fichier est un .eliumkey v2 lisible par le module partagé avec le Web.
    opened = open_key_bundle(parse_key_bundle(out.read_text(encoding="utf-8")), "pw-trousseau")
    assert len(opened["keys"]) == 2

    other = tmp_path / "other"
    monkeypatch.setenv("ELIUM_KEYS_DIR", str(other))
    run("keys", "import", str(out))
    kids = {k["kid"] for k in json.loads((other / "keyring.json").read_text(encoding="utf-8"))["keys"]}
    assert kids == {k["meta"]["kid"] for k in opened["keys"]}
    run("keys", "import", str(out))  # idempotent
    assert len(json.loads((other / "keyring.json").read_text(encoding="utf-8"))["keys"]) == 2


def test_rotate_identity_creates_verifiable_succession_and_retires_old(kdir):
    run("keys", "generate", "identity")
    old = keyring(kdir)["keys"][0]
    run("keys", "rotate", old["kid"])
    keys = keyring(kdir)["keys"]
    assert keys[0]["status"] == "retired" and keys[1]["status"] == "active"
    assert verify_succession(keys[1]["succession"])
    assert keys[1]["succession"]["oldPublicKeyHex"] == old["publicHex"]


def test_recipient_kid_opens_document_without_private_key_on_command_line(kdir, tmp_path, capsys):
    run("keys", "generate", "recipient")
    pub = keyring(kdir)["keys"][0]["publicHex"]
    src = tmp_path / "a.txt"
    src.write_text("Bonjour confidentiel", encoding="utf-8")
    doc = tmp_path / "a.elium"
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "encrypted", "--recipient", pub)
    capsys.readouterr()
    run("doc-open", str(doc), "--recipient-kid", keyring(kdir)["keys"][0]["kid"], "--text")
    cap = capsys.readouterr()
    assert "Bonjour confidentiel" in cap.out
    assert "déprécié" not in cap.err.lower()


def test_raw_private_key_argument_still_works_but_warns(kdir, tmp_path, capsys):
    from elium.crypto.recipients import generate_recipient_keypair

    priv, pub = generate_recipient_keypair()
    src = tmp_path / "a.txt"
    src.write_text("vieux flux", encoding="utf-8")
    doc = tmp_path / "a.elium"
    run("doc-create", "--input", str(src), "--output", str(doc), "--profile", "encrypted", "--recipient", pub)
    capsys.readouterr()
    run("doc-open", str(doc), "--recipient-key", priv, "--text")
    cap = capsys.readouterr()
    assert "vieux flux" in cap.out
    assert "DÉPRÉCIÉ".lower() in cap.err.lower() or "déprécié" in cap.err.lower()
    assert "--recipient-kid" in cap.err


def test_wrong_keyring_password_is_rejected(kdir, monkeypatch):
    run("keys", "generate", "identity")
    monkeypatch.setenv("ELIUM_KEYRING_PASSWORD", "faux")
    with pytest.raises(SystemExit):
        run("keys", "rotate", keyring(kdir)["keys"][0]["kid"])
