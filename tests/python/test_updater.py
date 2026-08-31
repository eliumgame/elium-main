"""
Tests de l'auto-update de l'application de bureau (installer/updater.py) et des
utilitaires de build (installer/build_common.py).

Autonomes : chaque test génère sa propre paire Ed25519 et remplace la clé publique
embarquée par monkeypatch — aucune dépendance à la clé locale (gitignorée, absente en CI).
"""
from __future__ import annotations

import hashlib
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
# Retry réseau borné dans _http_get (échecs TRANSITOIRES uniquement)
#
# `_http_get` sait maintenant retenter, avec backoff, un échec réseau
# transitoire (timeout, connexion refusée/réinitialisée...) d'UNE requête
# donnée — jamais une réponse HTTP d'erreur (HTTPError) ni une réponse trop
# volumineuse, et jamais un échec de vérification de signature (qui se
# produit après coup, sur les octets déjà reçus, et reste un rejet immédiat
# et définitif). On monkeypatch `_urlopen_read` (la tentative unique, sans
# retry) plutôt que `urllib.request.urlopen` pour compter précisément les
# tentatives sans dépendre des détails d'implémentation d'urllib.
# --------------------------------------------------------------------------- #

def test_http_get_retries_transient_error_then_succeeds(env, monkeypatch):
    monkeypatch.setattr(updater, "_HTTP_RETRY_BACKOFF_BASE", 0)
    calls = {"n": 0}

    def flaky(url, max_bytes):
        calls["n"] += 1
        if calls["n"] < 3:
            raise TimeoutError("connexion expirée")
        return b"payload"

    monkeypatch.setattr(updater, "_urlopen_read", flaky)

    assert updater._http_get("https://example.invalid/x", 1024) == b"payload"
    assert calls["n"] == 3   # 2 échecs transitoires absorbés + 1 succès


def test_http_get_gives_up_after_max_attempts(env, monkeypatch):
    monkeypatch.setattr(updater, "_HTTP_RETRY_BACKOFF_BASE", 0)
    calls = {"n": 0}

    def always_fails(url, max_bytes):
        calls["n"] += 1
        raise ConnectionResetError("connexion réinitialisée")

    monkeypatch.setattr(updater, "_urlopen_read", always_fails)

    with pytest.raises(ConnectionResetError):
        updater._http_get("https://example.invalid/x", 1024)

    # Plafonné à _HTTP_MAX_ATTEMPTS, jamais de retry illimité.
    assert calls["n"] == updater._HTTP_MAX_ATTEMPTS


def test_http_get_does_not_retry_http_error(env, monkeypatch):
    """Une réponse HTTP d'erreur (ex. 404) est une réponse applicative reçue
    avec succès, pas un incident réseau : échec immédiat, aucune reprise."""
    import urllib.error

    calls = {"n": 0}

    def not_found(url, max_bytes):
        calls["n"] += 1
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    monkeypatch.setattr(updater, "_urlopen_read", not_found)

    with pytest.raises(urllib.error.HTTPError):
        updater._http_get("https://example.invalid/x", 1024)

    assert calls["n"] == 1


def test_http_get_does_not_retry_oversized_response(env, monkeypatch):
    """Une réponse trop volumineuse est un rejet définitif (donnée invalide),
    pas un incident réseau -> pas de reprise non plus."""
    calls = {"n": 0}

    def too_big(url, max_bytes):
        calls["n"] += 1
        return b"x" * (max_bytes + 10)

    monkeypatch.setattr(updater, "_urlopen_read", too_big)

    with pytest.raises(ValueError):
        updater._http_get("https://example.invalid/x", 16)

    assert calls["n"] == 1


# --------------------------------------------------------------------------- #
# Même retry réseau borné, mais pour le téléchargement d'ARTEFACT (_download_verified)
#
# `_download_verified` (exe/msi/zip — le téléchargement le plus long et le plus
# exposé) urlopen() directement, sans passer par `_http_get`/`_urlopen_read` :
# il a donc besoin de SA PROPRE couverture, avec la même logique (retry borné +
# backoff sur un incident réseau transitoire, jamais sur une réponse trop
# volumineuse). On monkeypatch `urllib.request.urlopen` (la seule primitive que
# `_download_verified` appelle) plutôt que `_urlopen_read`, qui n'entre pas en jeu ici.
# --------------------------------------------------------------------------- #

class _FakeUrlopenResponse:
    """Contexte minimal imitant l'objet renvoyé par urllib.request.urlopen."""

    def __init__(self, payload: bytes):
        self._chunks = [payload, b""]  # un seul chunk puis fin de flux
        self._i = 0

    def read(self, _n: int) -> bytes:
        chunk = self._chunks[self._i]
        self._i = min(self._i + 1, len(self._chunks) - 1)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_download_verified_retries_transient_error_then_succeeds(env, monkeypatch, tmp_path):
    monkeypatch.setattr(updater, "_HTTP_RETRY_BACKOFF_BASE", 0)
    payload = b"contenu de l'artefact"
    sha = hashlib.sha256(payload).hexdigest()
    calls = {"n": 0}

    def flaky_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] < 3:
            raise TimeoutError("connexion expirée")
        return _FakeUrlopenResponse(payload)

    monkeypatch.setattr(updater.urllib.request, "urlopen", flaky_urlopen)
    dest = tmp_path / "artifact.bin"
    art = {"url": "https://example.invalid/a.bin", "sha256": sha, "size": len(payload)}

    assert updater._download_verified(art, dest) is True
    assert calls["n"] == 3  # 2 échecs transitoires absorbés + 1 succès
    assert dest.read_bytes() == payload


def test_download_verified_gives_up_after_max_attempts(env, monkeypatch, tmp_path):
    monkeypatch.setattr(updater, "_HTTP_RETRY_BACKOFF_BASE", 0)
    calls = {"n": 0}

    def always_fails(req, timeout=None):
        calls["n"] += 1
        raise ConnectionResetError("connexion réinitialisée")

    monkeypatch.setattr(updater.urllib.request, "urlopen", always_fails)
    dest = tmp_path / "artifact.bin"
    art = {"url": "https://example.invalid/a.bin", "sha256": "00" * 32, "size": 10}

    # Contrairement à `_http_get`, `_download_verified` ne lève jamais : un échec
    # définitif se traduit par False (design existant, cf. son appelant apply_web_update).
    assert updater._download_verified(art, dest) is False
    assert calls["n"] == updater._HTTP_MAX_ATTEMPTS
    assert not dest.exists()
    assert not dest.with_suffix(dest.suffix + ".part").exists()  # fichier .part nettoyé


def test_download_verified_does_not_retry_oversized_artifact(env, monkeypatch, tmp_path):
    """Un artefact plus gros que ce que le manifeste annonce est un rejet définitif
    (donnée invalide), jamais un incident réseau -> aucune reprise."""
    monkeypatch.setattr(updater, "_MAX_ARTIFACT_BYTES", 16)  # borne réduite : pas besoin d'un vrai gros fichier
    calls = {"n": 0}

    def too_big(req, timeout=None):
        calls["n"] += 1
        return _FakeUrlopenResponse(b"x" * 64)

    monkeypatch.setattr(updater.urllib.request, "urlopen", too_big)
    dest = tmp_path / "artifact.bin"
    art = {"url": "https://example.invalid/a.bin", "sha256": "00" * 32, "size": 10}

    assert updater._download_verified(art, dest) is False
    assert calls["n"] == 1


def test_invalid_signature_never_triggers_retry(env, monkeypatch):
    """Piège explicite de la consigne : un échec de vérification de signature
    doit rester un rejet immédiat et définitif, jamais retenté — à l'opposé
    d'un échec réseau transitoire. Preuve par comptage : lors d'une résolution
    complète (fetch_manifest) avec une signature corrompue, chaque URL n'est
    interrogée qu'UNE seule fois (aucune boucle de retry déclenchée)."""
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    release = env / "release"
    manifest_path = _publish(release, priv, "4.1.0")
    (release / "latest.json.sig").write_text("00" * 64, encoding="utf-8")  # corrompue
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    real_http_get = updater._http_get
    calls: list[str] = []

    def counting(url, max_bytes):
        calls.append(url)
        return real_http_get(url, max_bytes)

    monkeypatch.setattr(updater, "_http_get", counting)

    assert updater.fetch_manifest() is None
    # latest.json + latest.json.sig : une requête chacun, jamais plus.
    assert len(calls) == 2


# --------------------------------------------------------------------------- #
# Résolution atomique de la release "latest" (fetch_manifest, chemin par défaut)
#
# Avant correctif : fetch_manifest suivait `releases/latest/download/<fichier>`
# DEUX fois de suite (manifeste, puis signature) — deux résolutions indépendantes
# de l'alias "latest". Une nouvelle release publiée entre les deux (ou un CDN pas
# encore convergé) pouvait faire correspondre le manifeste d'une release à la
# signature d'une AUTRE, rejetée à raison mais de façon intermittente et sans
# rapport avec une vraie tentative de falsification — le schéma observé dans
# `update.log` en usage réel. Le correctif résout la release en UN SEUL appel API
# (`/releases/latest`) puis télécharge le manifeste et sa signature depuis les
# URLs de CETTE MÊME release. Ces tests prouvent que ce chemin ne retombe jamais
# sur l'alias, et gère proprement une release dont les assets manqueraient.
# --------------------------------------------------------------------------- #

def test_fetch_manifest_resolves_via_single_release_api_call(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    monkeypatch.delenv("ELIUM_UPDATE_MANIFEST_URL", raising=False)

    raw = json.dumps({"version": "9.9.9", "artifacts": {}}).encode("utf-8")
    sig_hex = priv.sign(raw).hex()
    pinned_manifest_url = f"https://github.com/{updater.REPO}/releases/download/v9.9.9/latest.json"
    pinned_sig_url = pinned_manifest_url + ".sig"

    release_payload = json.dumps(
        {
            "tag_name": "v9.9.9",
            "assets": [
                {"name": "latest.json", "browser_download_url": pinned_manifest_url},
                {"name": "latest.json.sig", "browser_download_url": pinned_sig_url},
                {"name": "Elium.exe", "browser_download_url": "https://example/Elium.exe"},
            ],
        }
    ).encode("utf-8")

    calls: list[str] = []

    def fake_http_get(url: str, max_bytes: int) -> bytes:
        calls.append(url)
        if url == updater._GITHUB_API_LATEST_RELEASE:
            return release_payload
        if url == pinned_manifest_url:
            return raw
        if url == pinned_sig_url:
            return sig_hex.encode("ascii")
        # L'alias "latest" ne doit JAMAIS être sollicité par le chemin par
        # défaut : le voir apparaître ici serait la régression exacte corrigée.
        raise AssertionError(f"URL alias inattendue : {url}")

    monkeypatch.setattr(updater, "_http_get", fake_http_get)

    manifest = updater.fetch_manifest()

    assert manifest == {"version": "9.9.9", "artifacts": {}}
    # Une seule résolution de la release, puis un fetch de chacun des deux
    # fichiers CIBLÉS sur cette release précise — jamais l'alias `/latest/`.
    assert calls == [updater._GITHUB_API_LATEST_RELEASE, pinned_manifest_url, pinned_sig_url]
    assert all("/releases/latest/download/" not in c for c in calls)


def test_fetch_manifest_missing_assets_in_release(env, monkeypatch):
    monkeypatch.delenv("ELIUM_UPDATE_MANIFEST_URL", raising=False)
    # La release existe mais ne porte pas (encore ?) les deux fichiers attendus.
    release_payload = json.dumps({"tag_name": "v9.9.9", "assets": []}).encode("utf-8")
    monkeypatch.setattr(updater, "_http_get", lambda url, max_bytes: release_payload)

    assert updater.fetch_manifest() is None


def test_fetch_manifest_override_env_bypasses_release_resolution(env, monkeypatch):
    """`ELIUM_UPDATE_MANIFEST_URL` (tests, ou une URL épinglée manuellement)
    continue de désigner directement une paire fixe, sans jamais appeler l'API
    de résolution — c'est déjà le chemin exercé par tous les autres tests de ce
    fichier ; celui-ci vérifie explicitement qu'il ne touche PAS à l'API."""
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.1.0")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    def fail_if_called():
        raise AssertionError("la résolution API ne doit pas être appelée quand l'URL est épinglée")

    monkeypatch.setattr(updater, "_resolve_latest_asset_urls", fail_if_called)

    manifest = updater.fetch_manifest()
    assert manifest is not None
    assert manifest["version"] == "4.1.0"


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
# Version installée + retour à une version antérieure (rollback)
# --------------------------------------------------------------------------- #

def test_version_info_reports_installed_and_update(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.1.0")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())

    # Avant toute vérification : version installée connue, statut « à jour » par défaut.
    pre = updater.version_info()
    assert pre["installed"] == "4.0.0" and pre["base"] == "4.0.0"

    # Après la vérification d'arrière-plan, la màj disponible est reflétée (non bloquant).
    assert updater.check_only()["state"] == "available"
    info = updater.version_info()
    assert info["installed"] == "4.0.0"
    assert info["latest"] == "4.1.0"
    assert info["upToDate"] is False


def test_undo_last_update_reverts_to_base(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    manifest_path = _publish(env / "release", priv, "4.1.0")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", manifest_path.as_uri())
    assert updater.check_and_apply()["state"] == "web-ready"
    assert updater.active_web_dir() is not None
    assert updater.effective_version() == "4.1.0"

    updater.undo_last_update()
    assert updater.active_web_dir() is None                 # overlay effacé
    assert updater.effective_version() == "4.0.0"           # retour à la base


def test_rollback_to_specific_web_version(env, monkeypatch):
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    # Base = 4.0.0 ; on revient à une version 4.0.5 servie par son URL par-version.
    manifest_405 = _publish(env / "rel-405", priv, "4.0.5")
    monkeypatch.setattr(updater, "_manifest_url_for", lambda v: manifest_405.as_uri())

    updater._run_rollback("4.0.5")   # worker synchrone (évite le timing du thread)
    st = updater.get_status()
    assert st["state"] == "web-ready"
    assert st["version"] == "4.0.5"
    assert updater.effective_version() == "4.0.5"           # 4.0.5 > base -> servie


def test_rollback_rejects_older_exe_version(env, monkeypatch):
    """Une cible au code différent PLUS ANCIENNE que l'exe courant exige un MSI."""
    priv, pub_hex = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub_hex)
    # Simule un exe « stampé » -> _needs_exe compare le codeHash.
    monkeypatch.setattr(updater, "BUILD_CODE_HASH", "f" * 64)
    manifest_395 = _publish(env / "rel-395", priv, "3.9.5")  # codeHash "deadbeef" != stamp
    monkeypatch.setattr(updater, "_manifest_url_for", lambda v: manifest_395.as_uri())

    updater._run_rollback("3.9.5")
    assert updater.get_status()["state"] == "error"          # pas de handoff vers un exe plus ancien


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
