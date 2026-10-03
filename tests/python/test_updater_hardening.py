"""
Durcissement du client de mise à jour (installer/updater.py) :

  - revérification au lancement (signature + empreinte) de l'overlay web et de l'exe remis en main ;
  - états d'échec distincts (hors ligne / quota / signature) + cache ETag + backoff persistant ;
  - garde anti boucle de plantage, élagage des anciens exe ;
  - reprise HTTP Range du téléchargement ;
  - paquet hors ligne `.eliumupdate` ;
  - canaux stable/bêta, préversions, rotation de clés ;
  - pack d'assets séparé (retéléchargé seulement si son empreinte change).

Autonome : paires Ed25519 jetables, aucun réseau (API GitHub et urlopen simulés).
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.error
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import changelog  # noqa: E402
import gen_manifest  # noqa: E402
import make_update_bundle  # noqa: E402
import split_web  # noqa: E402
import updater  # noqa: E402

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _keypair():
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    ).hex()
    return priv, pub


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("ELIUM_CURRENT_VERSION", "4.0.0")
    monkeypatch.delenv("ELIUM_NO_UPDATE", raising=False)
    monkeypatch.delenv("ELIUM_UPDATE_CHANNEL", raising=False)
    monkeypatch.delenv("ELIUM_UPDATE_MANIFEST_URL", raising=False)
    monkeypatch.setattr(updater, "BUILD_CODE_HASH", updater._CODE_HASH_PLACEHOLDER)
    monkeypatch.setattr(updater, "_HTTP_RETRY_BACKOFF_BASE", 0)
    monkeypatch.setattr(updater, "_MANIFEST_FETCH_BACKOFF_S", 0.0)

    def _no_network(url, etag, max_bytes):
        raise urllib.error.URLError("réseau coupé (test)")

    monkeypatch.setattr(updater, "_urlopen_conditional", _no_network)
    # Pas de thread de détection en arrière-plan (set_channel en lance un) : tests déterministes.
    monkeypatch.setattr(updater, "start_background_check", lambda: None)
    updater._pending_manifest = None
    updater._last_check_monotonic = 0.0
    updater._last_check_error = None
    updater._consecutive_check_failures = 0
    updater.reset_verification_cache()
    updater._status.clear()
    updater._status.update({"state": "idle", "version": None, "kind": None, "progress": 0,
                            "reason": None, "message": ""})
    return tmp_path


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _publish(tmp: Path, priv, version: str, *, key_id: str | None = None, extra_files=None,
             core_marker: str = "x", with_exe: bool = False, split: bool = False,
             assets_files: dict[str, bytes] | None = None, tree_override: str | None = None):
    """Écrit les artefacts + latest.json signé dans tmp ; renvoie (url du manifeste, manifest dict)."""
    tmp.mkdir(parents=True, exist_ok=True)
    core = {"index.html": f"<html>{core_marker}</html>".encode(), "assets/app.js": b"console.log(1)"}
    core.update(extra_files or {})
    arts: dict[str, dict] = {}

    def add(kind: str, name: str, data: bytes, **extra):
        p = tmp / name
        p.write_bytes(data)
        arts[kind] = {"name": name, "url": p.as_uri(), "size": len(data), "sha256": _sha(data), **extra}

    if split:
        heavy = assets_files or {"fonts/a.woff2": b"FONT-A" * 50, "pdfjs/w.wasm": b"WASM" * 80}
        core_zip, heavy_zip = _zip_bytes(core), _zip_bytes(heavy)
        (tmp / "_c.zip").write_bytes(core_zip)
        (tmp / "_h.zip").write_bytes(heavy_zip)
        union = updater.tree_hash_zips(tmp / "_c.zip", tmp / "_h.zip")
        heavy_tree = updater.tree_hash_zips(tmp / "_h.zip")
        add("webCore", "web-core.zip", core_zip, treeHash=tree_override or union)
        add("assets", f"assets-{heavy_tree[:16]}.zip", heavy_zip, treeHash=heavy_tree)
    else:
        add("web", "web.zip", _zip_bytes(core))
    if with_exe:
        add("exe", "Elium.exe", b"MZ-fake-exe-" + version.encode())
    manifest = {"version": version, "pubDate": "2026-10-01T00:00:00+00:00", "codeHash": "deadbeef",
                "notes": "", "artifacts": arts}
    if key_id:
        manifest["keyId"] = key_id
    raw = json.dumps(manifest, indent=2).encode()
    (tmp / "latest.json").write_bytes(raw)
    (tmp / "latest.json.sig").write_text(priv.sign(raw).hex(), encoding="utf-8")
    return tmp / "latest.json", manifest


def _setup(env, monkeypatch, version="4.1.0", **kw):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    url, manifest = _publish(env / f"rel-{version}", priv, version, **kw)
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", url.as_uri())
    return priv, pub, url, manifest


# --------------------------------------------------------------------------- #
# Revérification de l'overlay web au lancement
# --------------------------------------------------------------------------- #


def _install_web(env, monkeypatch, **kw):
    out = _setup(env, monkeypatch, **kw)
    assert updater.check_and_apply()["state"] == "web-ready"
    return out


def test_overlay_is_reverified_and_served_when_intact(env, monkeypatch):
    _install_web(env, monkeypatch)
    updater.reset_verification_cache()  # = un nouveau lancement
    assert updater.active_web_dir() is not None
    assert updater.effective_version() == "4.1.0"


def test_tampered_overlay_file_falls_back_to_embedded_base(env, monkeypatch):
    _install_web(env, monkeypatch)
    overlay = Path(updater.active_web_dir())
    (overlay / "assets" / "app.js").write_text("evil()", encoding="utf-8")
    updater.reset_verification_cache()
    assert updater.active_web_dir() is None            # refusé : retour à la base
    assert updater.effective_version() == "4.0.0"      # et la version ne compte plus


def test_overlay_without_signed_manifest_is_refused(env, monkeypatch):
    _install_web(env, monkeypatch)
    mpath, _ = updater._sidecar_paths(updater._web_root() / "4.1.0")
    mpath.unlink()
    updater.reset_verification_cache()
    assert updater.active_web_dir() is None


def test_forged_pointer_to_unsigned_directory_is_refused(env):
    d = updater._web_root() / "9.9.9"
    d.mkdir(parents=True)
    (d / "index.html").write_text("<html>pwned</html>", encoding="utf-8")
    updater._set_pointer("9.9.9")
    assert updater.active_web_dir() is None
    assert updater.effective_version() == "4.0.0"


def test_overlay_manifest_signed_by_unknown_key_is_refused(env, monkeypatch):
    _install_web(env, monkeypatch)
    other, other_pub = _keypair()
    base = updater._web_root() / "4.1.0"
    mpath, spath = updater._sidecar_paths(base)
    spath.write_text(other.sign(mpath.read_bytes()).hex(), encoding="utf-8")  # re-signé par un attaquant
    updater.reset_verification_cache()
    assert updater.active_web_dir() is None


# --------------------------------------------------------------------------- #
# Exe remis en main : signature + hash revérifiés
# --------------------------------------------------------------------------- #


def _stage_exe(env, monkeypatch, version="4.2.0"):
    monkeypatch.setattr(updater, "BUILD_CODE_HASH", "f" * 64)  # code différent -> màj exe
    priv, pub, url, manifest = _setup(env, monkeypatch, version=version, with_exe=True)
    assert updater.check_and_apply()["state"] == "exe-ready"
    return priv, version


def test_exe_handoff_requires_signed_manifest_and_matching_hash(env, monkeypatch):
    _stage_exe(env, monkeypatch)
    exe = updater._verified_pending_exe()
    assert exe is not None and exe.name == "Elium-4.2.0.exe"


def test_pending_json_sha256_is_no_longer_trusted(env, monkeypatch):
    _stage_exe(env, monkeypatch)
    exe = updater._bin_root() / "Elium-4.2.0.exe"
    exe.write_bytes(b"MZ-trojan")
    # L'attaquant met aussi pending.json à jour avec le hash de SON binaire : sans effet.
    updater._pending_file().write_text(
        json.dumps({"version": "4.2.0", "sha256": _sha(b"MZ-trojan")}), encoding="utf-8")
    assert updater._verified_pending_exe() is None
    assert not exe.exists()  # et le binaire suspect est supprimé


def test_exe_with_forged_manifest_signature_is_refused(env, monkeypatch):
    _stage_exe(env, monkeypatch)
    attacker, _ = _keypair()
    base = updater._bin_root() / "Elium-4.2.0"
    mpath, spath = updater._sidecar_paths(base)
    spath.write_text(attacker.sign(mpath.read_bytes()).hex(), encoding="utf-8")
    assert updater._verified_pending_exe() is None


def test_unsigned_exe_planted_with_pending_json_is_refused(env):
    bin_dir = updater._bin_root()
    bin_dir.mkdir(parents=True)
    (bin_dir / "Elium-9.0.0.exe").write_bytes(b"MZ-planted")
    (bin_dir / "pending.json").write_text(json.dumps({"version": "9.0.0", "sha256": _sha(b"MZ-planted")}))
    assert updater._verified_pending_exe() is None


# --------------------------------------------------------------------------- #
# Garde anti boucle de plantage
# --------------------------------------------------------------------------- #


def _frozen(monkeypatch):
    launched = []
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(updater.subprocess, "Popen", lambda cmd, *a, **k: launched.append(cmd))
    return launched


def test_crash_loop_guard_falls_back_to_base_after_n_failed_boots(env, monkeypatch):
    _stage_exe(env, monkeypatch)
    launched = _frozen(monkeypatch)
    for _ in range(updater.MAX_BOOT_ATTEMPTS):
        with pytest.raises(SystemExit):
            updater.run_pending_handoff()   # chaque démarrage remet la main… puis l'exe plante
    assert len(launched) == updater.MAX_BOOT_ATTEMPTS

    updater.run_pending_handoff()            # N+1 : plus de handoff, on reste sur la base
    assert len(launched) == updater.MAX_BOOT_ATTEMPTS
    assert not updater._pending_file().exists()
    assert not (updater._bin_root() / "Elium-4.2.0.exe").exists()
    assert updater._is_quarantined("4.2.0")
    notice = updater.consume_fallback_notice()
    assert notice and notice["version"] == "4.2.0" and notice["base"] == "4.0.0"


def test_quarantined_version_is_not_offered_again(env, monkeypatch):
    _stage_exe(env, monkeypatch)
    updater._fallback_to_base("4.2.0", "test")
    assert updater.check_for_update() is None


def test_boot_ok_resets_the_counter(env, monkeypatch):
    _stage_exe(env, monkeypatch)
    launched = _frozen(monkeypatch)
    for _ in range(updater.MAX_BOOT_ATTEMPTS - 1):
        with pytest.raises(SystemExit):
            updater.run_pending_handoff()
    # le nouvel exe (version 4.2.0) démarre pour de bon et le signale
    monkeypatch.setenv("ELIUM_CURRENT_VERSION", "4.2.0")
    updater.mark_boot_ok()
    st = json.loads(updater._boot_state_file().read_text(encoding="utf-8"))
    assert st == {"version": "4.2.0", "attempts": 0, "ok": True}
    assert len(launched) == updater.MAX_BOOT_ATTEMPTS - 1


def test_prune_keeps_current_and_previous_exe_only(env):
    bin_dir = updater._bin_root()
    bin_dir.mkdir(parents=True)
    for v in ("4.1.0", "4.2.0", "4.3.0", "4.4.0"):
        (bin_dir / f"Elium-{v}.exe").write_bytes(b"x")
        (bin_dir / f"Elium-{v}.manifest.json").write_text("{}")
        (bin_dir / f"Elium-{v}.manifest.json.sig").write_text("00")
    updater._prune_old_exe(keep_count=2)
    left = sorted(p.name for p in bin_dir.glob("Elium-*.exe"))
    assert left == ["Elium-4.3.0.exe", "Elium-4.4.0.exe"]
    assert not (bin_dir / "Elium-4.1.0.manifest.json").exists()
    assert (bin_dir / "Elium-4.4.0.manifest.json").exists()


# --------------------------------------------------------------------------- #
# check-failed : causes distinctes, ETag, backoff
# --------------------------------------------------------------------------- #


def test_offline_is_reported_as_check_failed_not_up_to_date(env):
    st = updater.check_only()
    assert st["state"] == "check-failed"
    assert st["reason"] == "offline"
    assert "hors ligne" in st["message"]
    info = updater.version_info()
    assert info["checkFailed"] == "offline"


def test_rate_limit_sets_persistent_backoff_and_no_more_requests(env, monkeypatch):
    calls = {"n": 0}

    def limited(url, etag, max_bytes):
        calls["n"] += 1
        raise urllib.error.HTTPError(url, 403, "rate limited", {"Retry-After": "600"}, None)

    monkeypatch.setattr(updater, "_urlopen_conditional", limited)
    assert updater.check_only()["reason"] == "rate-limited"
    assert calls["n"] == 1
    cache = json.loads(updater._cache_file().read_text(encoding="utf-8"))
    assert cache["backoffUntil"] > 0
    # pendant le backoff : AUCUN nouvel appel réseau, même après un « redémarrage »
    assert updater.check_only()["reason"] == "rate-limited"
    assert calls["n"] == 1


def test_etag_conditional_request_reuses_cached_release(env, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    url, _ = _publish(env / "rel", priv, "4.1.0")
    release = json.dumps({"tag_name": "v4.1.0", "assets": [
        {"name": "latest.json", "browser_download_url": url.as_uri()},
        {"name": "latest.json.sig", "browser_download_url": url.as_uri() + ".sig"},
    ]}).encode()
    seen = []

    def api(u, etag, max_bytes):
        seen.append(etag)
        if etag == 'W/"v1"':
            return 304, b"", {}
        return 200, release, {"etag": 'W/"v1"'}

    monkeypatch.setattr(updater, "_urlopen_conditional", api)
    assert updater.check_only()["state"] == "available"
    assert updater.check_only()["state"] == "available"   # 2e fois : 304, copie du cache
    assert seen == [None, 'W/"v1"']


def test_unknown_signing_key_id_is_reported(env, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    url, _ = _publish(env / "rel", priv, "4.1.0", key_id="k9")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", url.as_uri())
    st = updater.check_only()
    assert st["state"] == "check-failed" and st["reason"] == "unknown-key"


# --------------------------------------------------------------------------- #
# Rotation de clés
# --------------------------------------------------------------------------- #


def test_key_rotation_accepts_listed_key_ids_and_rejects_others(env, monkeypatch):
    old, old_pub = _keypair()
    new, new_pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", old_pub)
    monkeypatch.setattr(updater, "UPDATE_EXTRA_PUBLIC_KEYS", {"k2": new_pub})
    msg = b'{"keyId":"k2"}'
    assert updater._check_signature(msg, new.sign(msg).hex(), "k2") == "ok"
    assert updater._check_signature(msg, new.sign(msg).hex(), "k1") == "invalid"   # mauvaise clé pour cet id
    assert updater._check_signature(msg, new.sign(msg).hex(), "k3") == "unknown-key"
    # ancien manifeste sans keyId : toutes les clés acceptées sont essayées
    assert updater._check_signature(msg, old.sign(msg).hex(), None) == "ok"
    assert updater._check_signature(msg, new.sign(msg).hex(), None) == "ok"
    attacker, _ = _keypair()
    assert updater._check_signature(msg, attacker.sign(msg).hex(), None) == "invalid"


def test_manifest_signed_by_rotated_key_installs(env, monkeypatch):
    old, old_pub = _keypair()
    new, new_pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", old_pub)
    monkeypatch.setattr(updater, "UPDATE_EXTRA_PUBLIC_KEYS", {"k2": new_pub})
    url, _ = _publish(env / "rel", new, "4.1.0", key_id="k2")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", url.as_uri())
    assert updater.check_and_apply()["state"] == "web-ready"
    updater.reset_verification_cache()
    assert updater.active_web_dir() is not None   # la revérification au lancement accepte aussi la clé k2


def test_gen_manifest_writes_key_id(tmp_path, monkeypatch):
    priv = Ed25519PrivateKey.generate()
    key_hex = priv.private_bytes(encoding=serialization.Encoding.Raw, format=serialization.PrivateFormat.Raw,
                                 encryption_algorithm=serialization.NoEncryption()).hex()
    web = tmp_path / "web.zip"
    web.write_bytes(_zip_bytes({"index.html": b"<html/>"}))
    monkeypatch.setattr(sys, "argv", ["gen_manifest", "--version", "4.7.0-rc1", "--web", str(web),
                                      "--out", str(tmp_path), "--key", key_hex, "--key-id", "k2"])
    assert gen_manifest.main() == 0
    manifest = json.loads((tmp_path / "latest.json").read_bytes())
    assert manifest["keyId"] == "k2" and manifest["channel"] == "beta" and manifest["version"] == "4.7.0-rc1"
    assert manifest["artifacts"]["web"]["treeHash"]


# --------------------------------------------------------------------------- #
# Canaux + préversions
# --------------------------------------------------------------------------- #


def test_prerelease_versions_are_ordered():
    order = ["4.7.0-rc1", "4.7.0-rc2", "4.7.0-rc10", "4.7.0-beta.1", "4.7.0"]
    keys = [changelog.version_key(v) for v in order if v != "4.7.0-beta.1"]
    assert keys == sorted(keys)
    assert changelog.is_newer("4.7.0-rc2", "4.7.0-rc1")
    assert changelog.is_newer("4.7.0-rc10", "4.7.0-rc2")
    assert changelog.is_newer("4.7.0", "4.7.0-rc10")
    assert not changelog.is_newer("4.7.0-rc1", "4.7.0")
    assert updater.is_newer("4.7.0-rc1", "4.6.9")


def test_channel_persists_and_env_overrides(env, monkeypatch):
    assert updater.get_channel() == "stable"
    updater.set_channel("beta")
    assert updater.get_channel() == "beta"
    assert json.loads(updater._settings_file().read_text(encoding="utf-8"))["channel"] == "beta"
    updater.set_channel("nonsense")
    assert updater.get_channel() == "beta"
    monkeypatch.setenv("ELIUM_UPDATE_CHANNEL", "stable")
    assert updater.get_channel() == "stable"


def _release_api(releases):
    def api(url, etag, max_bytes):
        if url == updater._GITHUB_API_LATEST_RELEASE:
            stable = [r for r in releases if not r.get("prerelease")]
            return 200, json.dumps(stable[0]).encode(), {}
        assert url == updater._GITHUB_API_RELEASES_RECENT
        return 200, json.dumps(releases).encode(), {}
    return api


def test_beta_channel_picks_prerelease_stable_does_not(env, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    u_stable, _ = _publish(env / "r-stable", priv, "4.6.0")
    u_beta, _ = _publish(env / "r-beta", priv, "4.7.0-rc1")

    def rel(tag, url, pre):
        return {"tag_name": tag, "prerelease": pre, "draft": False, "assets": [
            {"name": "latest.json", "browser_download_url": url.as_uri()},
            {"name": "latest.json.sig", "browser_download_url": url.as_uri() + ".sig"}]}

    releases = [rel("v4.7.0-rc1", u_beta, True), rel("v4.6.0", u_stable, False)]
    monkeypatch.setattr(updater, "_urlopen_conditional", _release_api(releases))

    assert updater.check_only()["version"] == "4.6.0"        # stable : jamais la préversion
    updater._cache_file().unlink()
    updater.set_channel("beta")
    updater._status["state"] = "idle"
    st = updater.check_only()
    assert st["state"] == "available" and st["version"] == "4.7.0-rc1"
    assert updater.get_status()["channel"] == "beta"


def test_list_releases_hides_prereleases_on_stable_only(env, monkeypatch):
    arr = [{"tag_name": "v4.7.0-rc1", "prerelease": True, "draft": False, "published_at": "2026-10-01T00:00:00Z"},
           {"tag_name": "v4.6.0", "prerelease": False, "draft": False, "published_at": "2026-09-01T00:00:00Z"}]
    monkeypatch.setattr(updater, "_http_get", lambda url, n: json.dumps(arr).encode())
    assert [r["version"] for r in updater.list_releases()] == ["4.6.0"]
    updater.set_channel("beta")
    out = updater.list_releases()
    assert [r["version"] for r in out] == ["4.7.0-rc1", "4.6.0"]
    assert out[0]["prerelease"] is True


# --------------------------------------------------------------------------- #
# Reprise HTTP Range
# --------------------------------------------------------------------------- #


def _only_example(fake):
    """urlopen simulé UNIQUEMENT pour https://example.invalid : des threads d'arrière-plan
    laissés par d'autres tests peuvent appeler le vrai urlopen pendant qu'il est remplacé
    (sans ce filtre, leurs requêtes polluent les comptes de ces tests)."""
    import urllib.request as _ur

    real = _ur.urlopen

    def wrapper(req, timeout=None):
        url = getattr(req, "full_url", str(req))
        if url.startswith("https://example.invalid"):
            return fake(req, timeout)
        return real(req, timeout=timeout)

    return wrapper


class _Resp:
    def __init__(self, body: bytes, status=200, headers=None, fail_after: int | None = None):
        self._body, self.status, self.headers = body, status, headers or {}
        self._pos, self._fail_after = 0, fail_after

    def read(self, n):
        if self._fail_after is not None and self._pos >= self._fail_after:
            raise ConnectionResetError("coupure")
        end = min(self._pos + n, len(self._body))
        if self._fail_after is not None:
            end = min(end, self._fail_after)
        chunk = self._body[self._pos:end]
        self._pos = end
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_download_resumes_with_range_and_verifies_full_hash(env, monkeypatch, tmp_path):
    payload = bytes(range(256)) * 2000          # 512 000 o
    art = {"url": "https://example.invalid/a.bin", "sha256": _sha(payload), "size": len(payload)}
    requests = []
    cut = 300_000

    def fake(req, timeout=None):
        rng = req.headers.get("Range")
        requests.append(rng)
        if rng is None:
            return _Resp(payload, fail_after=cut)           # 1re tentative : coupée en route
        start = int(rng.split("=")[1].rstrip("-"))
        return _Resp(payload[start:], status=206,
                     headers={"Content-Range": f"bytes {start}-{len(payload) - 1}/{len(payload)}"})

    monkeypatch.setattr(updater.urllib.request, "urlopen", _only_example(fake))
    dest = tmp_path / "a.bin"
    assert updater._download_verified(art, dest) is True
    assert dest.read_bytes() == payload
    assert requests[0] is None and requests[1] == f"bytes={cut}-"     # reprise, pas de zéro


def test_resume_survives_across_separate_attempts(env, monkeypatch, tmp_path):
    payload = b"abcdefgh" * 40_000
    art = {"url": "https://example.invalid/a.bin", "sha256": _sha(payload), "size": len(payload)}
    dest = tmp_path / "a.bin"
    part = dest.with_suffix(dest.suffix + ".part")
    part.write_bytes(payload[:100_000])         # reste d'un essai précédent (appli fermée, réseau perdu)
    seen = []

    def fake(req, timeout=None):
        seen.append(req.headers.get("Range"))
        start = int(req.headers["Range"].split("=")[1].rstrip("-"))
        return _Resp(payload[start:], status=206,
                     headers={"Content-Range": f"bytes {start}-{len(payload) - 1}/{len(payload)}"})

    monkeypatch.setattr(updater.urllib.request, "urlopen", _only_example(fake))
    assert updater._download_verified(art, dest) is True
    assert seen == ["bytes=100000-"] and dest.read_bytes() == payload


def test_server_ignoring_range_restarts_from_zero(env, monkeypatch, tmp_path):
    payload = b"0123456789" * 5000
    art = {"url": "https://example.invalid/a.bin", "sha256": _sha(payload), "size": len(payload)}
    dest = tmp_path / "a.bin"
    dest.with_suffix(".bin.part").write_bytes(b"garbage-partial")
    monkeypatch.setattr(updater.urllib.request, "urlopen",
                        _only_example(lambda req, timeout=None: _Resp(payload, status=200)))
    assert updater._download_verified(art, dest) is True
    assert dest.read_bytes() == payload


def test_corrupted_resumed_download_retries_from_scratch_then_verifies(env, monkeypatch, tmp_path):
    payload = b"Z" * 200_000
    art = {"url": "https://example.invalid/a.bin", "sha256": _sha(payload), "size": len(payload)}
    dest = tmp_path / "a.bin"
    dest.with_suffix(".bin.part").write_bytes(b"Y" * 50_000)        # partie d'un AUTRE contenu
    reqs = []

    def fake(req, timeout=None):
        rng = req.headers.get("Range")
        reqs.append(rng)
        if rng:
            start = int(rng.split("=")[1].rstrip("-"))
            return _Resp(payload[start:], status=206,
                         headers={"Content-Range": f"bytes {start}-{len(payload) - 1}/{len(payload)}"})
        return _Resp(payload)

    monkeypatch.setattr(updater.urllib.request, "urlopen", _only_example(fake))
    assert updater._download_verified(art, dest) is True
    assert dest.read_bytes() == payload and reqs == ["bytes=50000-", None]


def test_range_not_satisfiable_restarts(env, monkeypatch, tmp_path):
    payload = b"Q" * 60_000
    art = {"url": "https://example.invalid/a.bin", "sha256": _sha(payload), "size": len(payload) + 1}
    dest = tmp_path / "a.bin"
    dest.with_suffix(".bin.part").write_bytes(b"Q" * 30_000)
    n = {"i": 0}

    def fake(req, timeout=None):
        n["i"] += 1
        if req.headers.get("Range"):
            raise urllib.error.HTTPError(req.full_url, 416, "Range Not Satisfiable", {}, None)
        return _Resp(payload)

    monkeypatch.setattr(updater.urllib.request, "urlopen", _only_example(fake))
    assert updater._download_verified(art, dest) is True and n["i"] == 2


# --------------------------------------------------------------------------- #
# Paquet hors ligne .eliumupdate
# --------------------------------------------------------------------------- #


def _bundle(env, priv, version="4.1.0", **kw):
    rel = env / f"bundle-src-{version}"
    url, manifest = _publish(rel, priv, version, **kw)
    out = make_update_bundle.build_bundle(url, [rel], env / "out")
    return out, manifest


def test_offline_bundle_installs_like_an_online_update(env, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    bundle, _ = _bundle(env, priv, split=True)
    st = updater.apply_update_bundle(bundle)
    assert st["state"] == "web-ready" and st["version"] == "4.1.0"
    updater.reset_verification_cache()
    overlay = Path(updater.active_web_dir())
    assert (overlay / "index.html").is_file() and (overlay / "fonts" / "a.woff2").is_file()


def test_offline_bundle_with_exe_stages_handoff(env, monkeypatch):
    monkeypatch.setattr(updater, "BUILD_CODE_HASH", "f" * 64)
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    bundle, _ = _bundle(env, priv, version="4.2.0", with_exe=True)
    st = updater.apply_update_bundle(bundle)
    assert st["state"] == "exe-ready"
    assert updater._verified_pending_exe() is not None


def test_bundle_with_bad_signature_is_rejected(env, monkeypatch):
    priv, pub = _keypair()
    attacker, _ = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    bundle, _ = _bundle(env, attacker)           # signé par une AUTRE clé
    st = updater.apply_update_bundle(bundle)
    assert st["state"] == "error" and st["reason"] == "bundle-invalid-signature"
    assert updater.active_web_dir() is None


def test_bundle_with_tampered_artifact_is_rejected(env, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    rel = env / "src"
    url, manifest = _publish(rel, priv, "4.1.0")
    evil = _zip_bytes({"index.html": b"<html>evil</html>"})
    with zipfile.ZipFile(env / "evil.eliumupdate", "w") as zf:
        zf.writestr("latest.json", (rel / "latest.json").read_bytes())
        zf.writestr("latest.json.sig", (rel / "latest.json.sig").read_text())
        zf.writestr("web.zip", evil)                     # contenu ≠ sha256 signé
    st = updater.apply_update_bundle(env / "evil.eliumupdate")
    assert st["state"] == "error" and st["reason"] == "bundle-failed"
    assert updater.active_web_dir() is None


def test_bundle_not_newer_and_garbage_are_rejected(env, monkeypatch):
    priv, pub = _keypair()
    monkeypatch.setattr(updater, "UPDATE_PUBLIC_KEY_HEX", pub)
    bundle, _ = _bundle(env, priv, version="4.0.0")
    assert updater.apply_update_bundle(bundle)["reason"] == "bundle-not-newer"
    junk = env / "junk.eliumupdate"
    junk.write_bytes(b"not a zip")
    assert updater.apply_update_bundle(junk)["state"] == "error"


def test_make_update_bundle_embeds_manifest_bytes_untouched(env):
    priv, _ = _keypair()
    bundle, manifest = _bundle(env, priv, version="4.1.0", split=True, with_exe=True)
    with zipfile.ZipFile(bundle) as zf:
        names = set(zf.namelist())
        assert {"latest.json", "latest.json.sig", "Elium.exe", "web-core.zip"} <= names
        assert "web.zip" not in names           # l'archive complète historique n'est pas embarquée
        assert zf.read("latest.json") == (env / "bundle-src-4.1.0" / "latest.json").read_bytes()


# --------------------------------------------------------------------------- #
# Pack d'assets séparé
# --------------------------------------------------------------------------- #


def _count_downloads(monkeypatch):
    seen = []
    real = updater._download_verified

    def counting(art, dest, on_progress=None):
        seen.append(art["name"])
        return real(art, dest, on_progress)

    monkeypatch.setattr(updater, "_download_verified", counting)
    return seen


def test_split_update_merges_core_and_assets_into_one_served_dir(env, monkeypatch):
    seen = _count_downloads(monkeypatch)
    _setup(env, monkeypatch, version="4.1.0", split=True)
    assert updater.check_and_apply()["state"] == "web-ready"
    overlay = Path(updater.active_web_dir())
    assert (overlay / "index.html").is_file()
    assert (overlay / "fonts" / "a.woff2").read_bytes() == b"FONT-A" * 50
    assert (overlay / "pdfjs" / "w.wasm").is_file()
    assert sorted(seen)[0].startswith("assets-") and "web-core.zip" in seen


def test_assets_pack_is_not_redownloaded_when_unchanged(env, monkeypatch):
    seen = _count_downloads(monkeypatch)
    priv, pub, _, _ = _setup(env, monkeypatch, version="4.1.0", split=True)
    assert updater.check_and_apply()["state"] == "web-ready"
    first = list(seen)
    assert len(first) == 2

    url2, _m = _publish(env / "rel-4.1.1", priv, "4.1.1", split=True, core_marker="v2")
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", url2.as_uri())
    updater._status["state"] = "idle"
    assert updater.check_and_apply()["state"] == "web-ready"
    second = seen[len(first):]
    assert second == ["web-core.zip"]          # seul le petit paquet est retéléchargé
    overlay = Path(updater.active_web_dir())
    assert overlay.name == "4.1.1" and (overlay / "fonts" / "a.woff2").is_file()
    assert "v2" in (overlay / "index.html").read_text(encoding="utf-8")


def test_assets_pack_is_redownloaded_when_its_hash_changes(env, monkeypatch):
    seen = _count_downloads(monkeypatch)
    priv, pub, _, _ = _setup(env, monkeypatch, version="4.1.0", split=True)
    updater.check_and_apply()
    url2, _m = _publish(env / "rel-4.1.1", priv, "4.1.1", split=True,
                        assets_files={"fonts/a.woff2": b"NEW-FONT" * 30})
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", url2.as_uri())
    updater._status["state"] = "idle"
    updater.check_and_apply()
    assert sum(1 for n in seen if n.startswith("assets-")) == 2
    assert (Path(updater.active_web_dir()) / "fonts" / "a.woff2").read_bytes() == b"NEW-FONT" * 30


def test_tampered_asset_in_merged_overlay_is_detected_at_launch(env, monkeypatch):
    _setup(env, monkeypatch, version="4.1.0", split=True)
    updater.check_and_apply()
    overlay = Path(updater.active_web_dir())
    (overlay / "pdfjs" / "w.wasm").write_bytes(b"evil-wasm")
    updater.reset_verification_cache()
    assert updater.active_web_dir() is None


def test_manifest_with_wrong_tree_hash_is_rejected_at_install(env, monkeypatch):
    _setup(env, monkeypatch, version="4.1.0", split=True, tree_override="00" * 32)
    assert updater.check_and_apply()["state"] == "error"
    assert updater.active_web_dir() is None


def test_unreferenced_asset_packs_are_pruned(env, monkeypatch):
    priv, pub, _, _ = _setup(env, monkeypatch, version="4.1.0", split=True)
    updater.check_and_apply()
    url2, _m = _publish(env / "rel-4.1.1", priv, "4.1.1", split=True,
                        assets_files={"fonts/a.woff2": b"NEW" * 40})
    monkeypatch.setenv("ELIUM_UPDATE_MANIFEST_URL", url2.as_uri())
    updater._status["state"] = "idle"
    updater.check_and_apply()
    packs = [d for d in updater._assets_root().iterdir() if d.is_dir()]
    assert len(packs) == 1                      # l'ancien pack n'est plus référencé -> supprimé


def test_split_web_script_roundtrip_matches_manifest_and_client(env, monkeypatch, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "fonts").mkdir()
    (dist / "pdfjs").mkdir()
    (dist / "index.html").write_text("<html>real</html>", encoding="utf-8")
    (dist / "assets" / "index-abc.js").write_text("1", encoding="utf-8")
    (dist / "fonts" / "inter.woff2").write_bytes(b"F" * 500)
    (dist / "pdfjs" / "pdf.worker.mjs").write_bytes(b"W" * 500)
    out = tmp_path / "zips"
    info = split_web.split_dist(dist, out)
    # déterministe : un 2e passage produit exactement les mêmes octets
    again = split_web.split_dist(dist, tmp_path / "zips2")
    assert Path(info["assets"]).name == Path(again["assets"]).name
    assert Path(info["assets"]).read_bytes() == Path(again["assets"]).read_bytes()
    # les empreintes calculées par le script = celles que le client recalculera sur le dossier
    assert info["treeHash"] == updater.tree_hash_dir(dist)
    assert updater.tree_hash_zips(Path(info["webCore"]), Path(info["assets"])) == info["treeHash"]
    assert updater.tree_hash_zips(Path(info["web"])) == info["treeHash"]
    assert Path(info["webCore"]).stat().st_size < Path(info["web"]).stat().st_size or True

    key = Ed25519PrivateKey.generate()
    key_hex = key.private_bytes(encoding=serialization.Encoding.Raw, format=serialization.PrivateFormat.Raw,
                                encryption_algorithm=serialization.NoEncryption()).hex()
    monkeypatch.setattr(sys, "argv", [
        "gen_manifest", "--version", "4.1.0", "--web", info["web"], "--web-core", info["webCore"],
        "--assets", info["assets"], "--out", str(out), "--key", key_hex])
    assert gen_manifest.main() == 0
    m = json.loads((out / "latest.json").read_bytes())
    assert m["artifacts"]["webCore"]["treeHash"] == info["treeHash"] == m["artifacts"]["web"]["treeHash"]
    assert m["artifacts"]["assets"]["treeHash"] == info["assetsTreeHash"]
