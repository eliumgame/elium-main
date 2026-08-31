"""
Tests des scripts qui signent/versionnent réellement une release (installer/
gen_manifest.py, installer/stamp_version.py, installer/verify_release.py) —
jusqu'ici aucun n'avait de couverture automatisée alors que ce sont eux qui
produisent l'objet de confiance dont dépend tout l'auto-update.

Autonome : chaque test génère sa propre paire Ed25519 de test (jamais la vraie
clé de signature CI) — même approche que tests/python/test_updater.py.
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# installer/ n'est pas un package : on l'ajoute au chemin d'import (même pattern
# que tests/python/test_updater.py).
_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import gen_manifest  # noqa: E402
import stamp_version  # noqa: E402
import updater  # noqa: E402
import verify_release  # noqa: E402


def _keypair() -> tuple[str, str]:
    """(clé privée hex, clé publique hex) — une paire de TEST, jetable."""
    priv = Ed25519PrivateKey.generate()
    priv_hex = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    ).hex()
    pub_hex = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    ).hex()
    return priv_hex, pub_hex


def _make_web_zip(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("index.html", "<html><body>test</body></html>")


# --------------------------------------------------------------------------- #
# gen_manifest.py : round-trip de signature, vérifiée par le CLIENT réel
# (updater._verify_signature) — la même fonction qui protège un poste utilisateur.
# --------------------------------------------------------------------------- #

def test_gen_manifest_signature_round_trips_with_updater_verification(tmp_path, monkeypatch):
    priv_hex, pub_hex = _keypair()
    web_zip = tmp_path / "web.zip"
    _make_web_zip(web_zip)
    out_dir = tmp_path / "dist"

    argv = [
        "gen_manifest.py",
        "--version", "9.9.9",
        "--repo", "example/example",
        "--web", str(web_zip),
        "--out", str(out_dir),
        "--notes", "test",
        "--key", priv_hex,
    ]
    monkeypatch.setattr(sys, "argv", argv)
    assert gen_manifest.main() == 0

    raw = (out_dir / "latest.json").read_bytes()
    sig_hex = (out_dir / "latest.json.sig").read_text(encoding="utf-8").strip()
    manifest = json.loads(raw)
    assert manifest["version"] == "9.9.9"
    assert "web" in manifest["artifacts"]

    # C'est bien updater._verify_signature (le vérificateur client réel) qui
    # accepte cette signature avec la clé publique correspondante...
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    assert updater._verify_signature(raw, sig_hex) is True
    # ...et la rejette catégoriquement dès que le message ou la clé divergent
    # (contrôle négatif — sans lui, un test qui accepterait toujours passerait
    # même si gen_manifest ne signait plus rien du tout).
    assert updater._verify_signature(raw + b" ", sig_hex) is False
    _, other_pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", other_pub_hex)
    assert updater._verify_signature(raw, sig_hex) is False


def test_gen_manifest_sanity_checks_its_own_signature(tmp_path, monkeypatch):
    """gen_manifest.py vérifie déjà lui-même sa signature avant d'écrire les
    fichiers (garde-fou anti-régression intégré) : ce test prouve juste qu'un
    manifeste produit avec une clé de test passe effectivement ce garde-fou
    (main() renvoie 0, aucune AssertionError levée par priv.public_key().verify)."""
    priv_hex, _ = _keypair()
    web_zip = tmp_path / "web.zip"
    _make_web_zip(web_zip)
    out_dir = tmp_path / "dist"
    argv = [
        "gen_manifest.py",
        "--version", "1.2.3",
        "--web", str(web_zip),
        "--out", str(out_dir),
        "--key", priv_hex,
    ]
    monkeypatch.setattr(sys, "argv", argv)
    assert gen_manifest.main() == 0
    assert (out_dir / "latest.json").is_file()
    assert (out_dir / "latest.json.sig").is_file()


# --------------------------------------------------------------------------- #
# stamp_version.py : idempotence sur une copie temporaire des fichiers touchés
#
# Stamper deux fois la MÊME version doit produire des fichiers byte-identiques
# entre les deux passages — sinon une re-exécution accidentelle du CI (retry,
# re-run manuel) sur le même tag corromprait progressivement les fichiers
# stampés au lieu de les laisser inchangés.
# --------------------------------------------------------------------------- #

def _seed_stampable_repo(root: Path) -> None:
    (root / "src" / "elium").mkdir(parents=True, exist_ok=True)
    (root / "web-studio").mkdir(parents=True, exist_ok=True)
    (root / "installer").mkdir(parents=True, exist_ok=True)

    (root / "src" / "elium" / "__init__.py").write_text(
        '__version__ = "0.0.0"\n', encoding="utf-8"
    )
    (root / "web-studio" / "package.json").write_text(
        '{\n  "name": "web-studio",\n  "version": "0.0.0"\n}\n', encoding="utf-8"
    )
    # Les deux motifs que stamp_version cible dans le lockfile : la version de
    # premier niveau (2 espaces) ET celle de packages[""] (6 espaces).
    (root / "web-studio" / "package-lock.json").write_text(
        '{\n'
        '  "name": "web-studio",\n'
        '  "version": "0.0.0",\n'
        '  "lockfileVersion": 3,\n'
        '  "packages": {\n'
        '    "": {\n'
        '      "name": "web-studio",\n'
        '      "version": "0.0.0"\n'
        '    }\n'
        '  }\n'
        '}\n',
        encoding="utf-8",
    )
    (root / "installer" / "elium.wxs").write_text(
        '<?define Version = "0.0.0" ?>\n', encoding="utf-8"
    )
    (root / "installer" / "elium_setup.iss").write_text(
        '#define AppVersion "0.0.0"\n', encoding="utf-8"
    )
    (root / "installer" / "updater.py").write_text(
        'BUILD_CODE_HASH = "__BUILD_CODE_HASH__"\n', encoding="utf-8"
    )
    (root / "installer" / "elium_launcher.py").write_text(
        "# lanceur factice pour compute_code_hash\n", encoding="utf-8"
    )


def _snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_stamp_version_is_idempotent_on_a_copy(tmp_path, monkeypatch, capsys):
    root = tmp_path / "repo"
    _seed_stampable_repo(root)
    monkeypatch.setattr(stamp_version, "repo_root", lambda: root)

    monkeypatch.setattr(sys, "argv", ["stamp_version.py", "4.2.0"])
    assert stamp_version.main() == 0
    capsys.readouterr()  # ne pollue pas la sortie du test
    first_pass = _snapshot(root)

    # Vérifie que le stampage a bien eu lieu (pas un no-op qui rendrait le test
    # trivialement idempotent).
    assert '__version__ = "4.2.0"' in (root / "src" / "elium" / "__init__.py").read_text("utf-8")
    assert 'BUILD_CODE_HASH = "__BUILD_CODE_HASH__"' not in (
        root / "installer" / "updater.py"
    ).read_text("utf-8")

    assert stamp_version.main() == 0
    capsys.readouterr()
    second_pass = _snapshot(root)

    assert first_pass == second_pass


def test_stamp_version_normalizes_v_prefix_and_prerelease_core(tmp_path, monkeypatch, capsys):
    """`v4.1.0-rc1` -> version applicative complète `4.1.0-rc1`, mais le cœur
    numérique injecté dans le MSI/Inno (qui n'accepte que X.Y.Z) reste `4.1.0`."""
    root = tmp_path / "repo"
    _seed_stampable_repo(root)
    monkeypatch.setattr(stamp_version, "repo_root", lambda: root)
    monkeypatch.setattr(sys, "argv", ["stamp_version.py", "v4.1.0-rc1"])
    assert stamp_version.main() == 0
    capsys.readouterr()

    assert '__version__ = "4.1.0-rc1"' in (root / "src" / "elium" / "__init__.py").read_text("utf-8")
    assert '<?define Version = "4.1.0" ?>' in (root / "installer" / "elium.wxs").read_text("utf-8")
    assert '#define AppVersion "4.1.0"' in (root / "installer" / "elium_setup.iss").read_text("utf-8")


# --------------------------------------------------------------------------- #
# verify_release.py : health-check post-publication (manifeste + artefact)
# --------------------------------------------------------------------------- #

def test_verify_release_check_once_accepts_valid_release(tmp_path, monkeypatch):
    priv_hex, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)

    web_zip = tmp_path / "web.zip"
    _make_web_zip(web_zip)
    sha = hashlib.sha256(web_zip.read_bytes()).hexdigest()
    manifest = {
        "version": "5.0.0",
        "artifacts": {
            "web": {
                "name": "web.zip",
                "url": web_zip.as_uri(),
                "size": web_zip.stat().st_size,
                "sha256": sha,
            }
        },
    }
    raw = json.dumps(manifest).encode("utf-8")
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex))
    sig_hex = priv.sign(raw).hex()

    monkeypatch.setattr(updater, "_manifest_url_for", lambda v: "file:///unused")

    def fake_http_get(url, max_bytes):
        if url == "file:///unused":
            return raw
        if url == "file:///unused.sig":
            return sig_hex.encode("ascii")
        return web_zip.read_bytes()

    monkeypatch.setattr(updater, "_http_get", fake_http_get)

    ok, reason = verify_release._check_once("5.0.0")
    assert ok is True
    assert reason == ""


def test_verify_release_check_once_rejects_version_mismatch(tmp_path, monkeypatch):
    """Le manifeste signé annonce une version différente du tag publié inspecté
    -> échec explicite, jamais un succès silencieux sur la mauvaise release."""
    priv_hex, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest = {"version": "5.0.1", "artifacts": {}}
    raw = json.dumps(manifest).encode("utf-8")
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex))
    sig_hex = priv.sign(raw).hex()

    monkeypatch.setattr(updater, "_manifest_url_for", lambda v: "file:///unused")

    def fake_http_get(url, max_bytes):
        return raw if url == "file:///unused" else sig_hex.encode("ascii")

    monkeypatch.setattr(updater, "_http_get", fake_http_get)

    ok, reason = verify_release._check_once("5.0.0")
    assert ok is False
    assert "5.0.0" in reason or "5.0.1" in reason
