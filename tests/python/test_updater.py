"""
Tests de l'auto-update de l'application de bureau (installer/updater.py) et des
utilitaires de build (installer/build_common.py).

Autonomes : chaque test génère sa propre paire Ed25519 et remplace la clé publique
embarquée par monkeypatch — aucune dépendance à la clé locale (gitignorée, absente en CI).
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# installer/ n'est pas un package : on l'ajoute au chemin d'import.
_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import build_common  # noqa: E402
import updater  # noqa: E402

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _keypair() -> tuple[Ed25519PrivateKey, str]:
    priv = Ed25519PrivateKey.generate()
    pub_hex = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    ).hex()
    return priv, pub_hex


def _make_web_zip(path: Path, marker: str = "hello") -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("index.html", f"<html><body>{marker}</body></html>")
        zf.writestr("assets/app.js", "console.log('elium');")


def _sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _publish(tmp: Path, priv: Ed25519PrivateKey, version: str) -> Path:
    """Écrit web.zip + latest.json signé dans tmp, renvoie l'URL file:// du manifeste."""
    tmp.mkdir(parents=True, exist_ok=True)
    web_zip = tmp / "web.zip"
    _make_web_zip(web_zip)
    manifest = {
        "version": version,
        "pubDate": "2026-07-17T00:00:00+00:00",
        "codeHash": "deadbeef",  # != placeholder ; en dev BUILD_CODE_HASH=placeholder -> web-only
        "notes": "",
        "artifacts": {
            "web": {
                "name": "web.zip",
                "url": web_zip.as_uri(),
                "size": web_zip.stat().st_size,
                "sha256": _sha256(web_zip),
            }
        },
    }
    raw = json.dumps(manifest, indent=2).encode("utf-8")
    (tmp / "latest.json").write_bytes(raw)
    (tmp / "latest.json.sig").write_text(priv.sign(raw).hex(), encoding="utf-8")
    return tmp / "latest.json"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Environnement isolé : LOCALAPPDATA temporaire, version courante fixée."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("ELIUM_CURRENT_VERSION", "4.0.0")
    monkeypatch.delenv("ELIUM_NO_UPDATE", raising=False)
    # Force le placeholder pour que ces tests prennent le chemin WEB de façon
    # déterministe, même si le build a déjà stampé un vrai BUILD_CODE_HASH
    # (cas du CI de release, qui stampe avant de lancer pytest).
    monkeypatch.setattr(updater, "BUILD_CODE_HASH", updater._CODE_HASH_PLACEHOLDER)
    updater._pending_manifest = None
    updater._last_check_monotonic = 0.0
    # repart d'un statut propre
    updater._status.clear()
    updater._status.update({"state": "idle", "version": None, "kind": None, "progress": 0})
    return tmp_path


# --------------------------------------------------------------------------- #
# Comparaison de versions
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "remote,local,expected",
    [
        ("4.1.0", "4.0.0", True),
        ("v4.1.0", "4.0.0", True),
        ("4.0.0", "4.0.0", False),
        ("4.0.0", "4.1.0", False),
        ("4.0.1-rc", "4.0.0", True),     # préversion > version antérieure
        ("4.0.0", "4.0.0-rc", True),     # version finale > sa préversion
        ("4.0.0-rc", "4.0.0", False),
        ("4.10.0", "4.9.0", True),       # comparaison numérique, pas lexicale
    ],
)
def test_is_newer(remote, local, expected):
    assert updater.is_newer(remote, local) is expected


# --------------------------------------------------------------------------- #
# Signature du manifeste
# --------------------------------------------------------------------------- #

def test_signature_accept_and_reject(monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    msg = b'{"version":"4.1.0"}'
    sig = priv.sign(msg).hex()

    assert updater._verify_signature(msg, sig) is True
    assert updater._verify_signature(msg + b" ", sig) is False   # message altéré
    assert updater._verify_signature(msg, "00" * 64) is False    # mauvaise signature
    assert updater._verify_signature(msg, "zz") is False         # hex invalide


# --------------------------------------------------------------------------- #
# Flux web de bout en bout
# --------------------------------------------------------------------------- #

def test_web_update_end_to_end(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.1.0")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    status = updater.check_and_apply()

    assert status["state"] == "web-ready"
    assert status["version"] == "4.1.0"
    overlay = updater.active_web_dir()
    assert overlay is not None
    assert (Path(overlay) / "index.html").is_file()
    assert (Path(overlay) / "assets" / "app.js").is_file()
    assert Path(overlay).name == "4.1.0"


def test_invalid_signature_blocks_update(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    release = env / "release"
    manifest_path = _publish(release, priv, "4.1.0")
    # Corrompt la signature après publication.
    (release / "latest.json.sig").write_text("00" * 64, encoding="utf-8")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    status = updater.check_and_apply()

    assert status["state"] == "up-to-date"        # manifeste rejeté -> pas de màj
    assert updater.active_web_dir() is None


def test_corrupted_artifact_hash_blocks_update(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    release = env / "release"
    release.mkdir(parents=True, exist_ok=True)
    _make_web_zip(release / "web.zip")
    # Manifeste signé mais avec un sha256 volontairement faux.
    manifest = {
        "version": "4.1.0",
        "codeHash": "deadbeef",
        "artifacts": {
            "web": {
                "name": "web.zip",
                "url": (release / "web.zip").as_uri(),
                "size": (release / "web.zip").stat().st_size,
                "sha256": "00" * 32,
            }
        },
    }
    raw = json.dumps(manifest, indent=2).encode("utf-8")
    (release / "latest.json").write_bytes(raw)
    (release / "latest.json.sig").write_text(priv.sign(raw).hex(), encoding="utf-8")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", (release / "latest.json").as_uri())

    status = updater.check_and_apply()

    assert status["state"] == "error"             # sha256 mismatch -> artefact jeté
    assert updater.active_web_dir() is None


def test_no_reoffer_after_web_update_applied(env, monkeypatch):
    """Régression : la carte ne doit PAS revenir en boucle après une màj web appliquée."""
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.1.0")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    assert updater.check_only()["state"] == "available"
    assert updater.check_and_apply()["state"] == "web-ready"
    assert updater.active_web_dir() is not None            # overlay 4.1.0 appliqué

    # La version effective reflète l'overlay, donc plus rien de « plus récent ».
    assert updater.effective_version() == "4.1.0"
    assert updater.check_for_update() is None              # ne re-propose pas 4.1.0
    assert updater.check_only()["state"] == "up-to-date"


def test_on_navigation_clears_stale_ready(env, monkeypatch):
    """Un rechargement efface l'état « web-ready » périmé (pas de carte en boucle)."""
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.1.0")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())
    updater.check_and_apply()
    assert updater.get_status()["state"] == "web-ready"

    updater.on_navigation()   # simule le reload après clic « Recharger »
    assert updater.get_status()["state"] in ("idle", "up-to-date")


def test_no_update_when_not_newer(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.0.0")  # == version courante
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    status = updater.check_and_apply()

    assert status["state"] == "up-to-date"
    assert updater.active_web_dir() is None


def test_disabled_by_env(env, monkeypatch):
    monkeypatch.setenv("ELIUM_NO_UPDATE", "1")
    status = updater.check_and_apply()
    assert status["state"] == "disabled"


def test_handoff_noop_when_not_frozen(env):
    # Non gelé (pytest) -> run_pending_handoff ne doit rien faire ni lever.
    updater.run_pending_handoff()


# --------------------------------------------------------------------------- #
# codeHash (build_common)
# --------------------------------------------------------------------------- #

def test_code_hash_deterministic():
    assert build_common.compute_code_hash() == build_common.compute_code_hash()


def test_code_hash_normalizes_baked_value(tmp_path):
    """Injecter une valeur dans BUILD_CODE_HASH ne change pas les octets normalisés."""
    body = 'import os\nBUILD_CODE_HASH = "{}"\nprint(os.getcwd())\n'
    placeholder = tmp_path / "updater.py"
    placeholder.write_text(body.format("__BUILD_CODE_HASH__"), encoding="utf-8")
    baked = tmp_path / "sub" / "updater.py"
    baked.parent.mkdir()
    baked.write_text(body.format("a" * 64), encoding="utf-8")

    assert build_common._read_normalized(placeholder) == build_common._read_normalized(baked)
