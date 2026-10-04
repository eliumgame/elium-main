"""
Invariants statiques du pipeline de release / de déploiement (supply chain) : ce qui, cassé par une
retouche anodine, réintroduirait silencieusement un risque corrigé (action non épinglée, secret dans
un job qui exécute npm, MSI non bloquant, mot de passe par défaut, installation non verrouillée…).
PyYAML n'est pas une dépendance du projet : vérifications par texte/regex, volontairement simples.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WF = ROOT / ".github" / "workflows"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _jobs(text: str) -> dict[str, str]:
    """Découpe un workflow en {job: texte} (clés de jobs à 2 espaces d'indentation)."""
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([a-z][a-z0-9_-]*):\s*$", body, flags=re.M)
    return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}


def test_every_action_is_pinned_by_commit_sha():
    bad = []
    for wf in WF.glob("*.yml"):
        for n, line in enumerate(_read(wf).splitlines(), 1):
            m = re.search(r"\buses:\s*([^\s#]+)", line)
            if m and not m.group(1).startswith("./") and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
                bad.append(f"{wf.name}:{n} {m.group(1)}")
    assert not bad, f"actions non épinglées par SHA de commit : {bad}"


def test_pinned_actions_keep_their_tag_as_a_comment():
    for wf in WF.glob("*.yml"):
        for line in _read(wf).splitlines():
            if re.search(r"\buses:\s*\S+@[0-9a-f]{40}", line):
                assert re.search(r"#\s*v\d", line), f"{wf.name} : tag manquant en commentaire : {line.strip()}"


def test_workflows_declare_least_privilege_permissions():
    ci = _read(WF / "ci.yml")
    assert re.search(r"^permissions:\s*\n\s+contents: read", ci, re.M)
    rel = _read(WF / "release.yml")
    assert re.search(r"^permissions: \{\}", rel, re.M)           # rien par défaut : chaque job déclare le sien
    for name, text in _jobs(rel).items():
        assert "permissions:" in text, f"job {name} sans permissions explicites"


def test_signing_key_is_only_visible_to_the_publish_job_and_build_has_no_secret():
    jobs = _jobs(_read(WF / "release.yml"))
    for name in ("gate", "build", "images"):
        assert "UPDATE_SIGNING_KEY" not in jobs[name], f"{name} ne doit pas voir la clé de signature"
    assert "UPDATE_SIGNING_KEY" in jobs["publish"]
    # le job qui exécute npm ci / PyInstaller / WiX n'a que des droits de lecture
    assert re.search(r"permissions:\s*\n\s+contents: read", jobs["build"])
    assert "contents: write" not in jobs["build"]
    for forbidden in ("npm ci", "choco", "PyInstaller", "Invoke-WebRequest"):
        assert forbidden not in jobs["publish"], f"publish ne doit pas exécuter « {forbidden} »"
    # seule exception documentée côté build : le point d'accroche Authenticode, absent sans certificat
    secrets_in_build = set(re.findall(r"secrets\.([A-Z_]+)", jobs["build"]))
    assert secrets_in_build <= {"SIGN_CERT", "SIGN_CERT_PASSWORD"}


def test_smoke_test_msi_and_post_publication_checks_are_blocking():
    text = _read(WF / "release.yml")
    jobs = _jobs(text)
    assert "installer/smoke_test.py" in jobs["build"]
    assert "continue-on-error" not in text                     # le MSI n'est plus « best-effort »
    assert "Elium-User-" in jobs["build"] and "-dScope=$scope" in jobs["build"]
    assert "installer/verify_release.py" in jobs["publish"]
    assert "attest-build-provenance" in jobs["publish"] and "id-token: write" in jobs["publish"]
    assert "cyclonedx" in jobs["build"].lower()
    assert "--generate-notes" not in text and "--notes-file" in text   # une seule source de notes
    assert "SIGN_CERT" in jobs["build"] and "ignorée" in jobs["build"]  # crochet Authenticode optionnel


def test_workflow_dispatch_no_longer_bypasses_ci_and_supports_bump_and_prerelease():
    text = _read(WF / "release.yml")
    assert "--workflow \"Elium CI\"" in text and "--status success" in text
    assert "scripts/next_version.py" in text and "bump:" in text and "prerelease:" in text
    # la version de préversion n'est plus tronquée (4.7.0-rc1 -> 4.7.0)
    assert "[0-9A-Za-z.]+" in text and "--prerelease" in text


def test_wix_is_pinned_and_verified_not_installed_through_unpinned_choco():
    text = _read(WF / "release.yml")
    assert "choco install" not in text
    assert re.search(r"\$expected = '[0-9A-F]{64}'", text)


def test_python_installs_use_hash_locked_requirements():
    for name in ("ci.yml", "release.yml"):
        text = _read(WF / name)
        assert "pip install -e" not in text and "pip install .[dev]" not in text
        assert "--require-hashes" in text
    for lock in ("runtime", "dev", "build"):
        txt = _read(ROOT / "requirements" / f"{lock}.txt")
        pins = re.findall(r"^[A-Za-z0-9_.-]+==\S+", txt, re.M)
        assert pins
        # chaque paquet épinglé porte au moins un hash sha256
        blocks = re.split(r"^(?=[A-Za-z0-9_.-]+==)", txt, flags=re.M)[1:]
        assert all("--hash=sha256:" in b for b in blocks), lock
    assert "pyinstaller==6.21.0" in _read(ROOT / "requirements" / "build.in")


def test_ci_has_pip_audit_shellcheck_and_compose_validation():
    ci = _read(WF / "ci.yml")
    assert "scripts/pip_audit_gate.py" in ci
    assert "shellcheck" in ci and "bash -n install.sh" in ci
    assert "docker compose config" in ci


def test_dependabot_covers_every_ecosystem():
    d = _read(ROOT / ".github" / "dependabot.yml")
    for eco in ("npm", "pip", "github-actions", "docker"):
        assert f"package-ecosystem: {eco}" in d
    assert d.count("package-ecosystem: docker") >= 3


# --------------------------------------------------------------------------- #
# Déploiement serveur
# --------------------------------------------------------------------------- #

COMPOSE = _read(ROOT / "docker-compose.yml")
INSTALL_SH = _read(ROOT / "install.sh")


def test_compose_has_no_default_passwords():
    assert "POSTGRES_PASSWORD:-" not in COMPOSE
    assert "S3_SECRET_KEY:-" not in COMPOSE
    assert "CORS_ORIGINS:-" not in COMPOSE
    for var in ("POSTGRES_PASSWORD", "S3_SECRET_KEY", "CORS_ORIGINS", "REDIS_PASSWORD", "TOKEN_SECRET"):
        assert f"{var}:?" in COMPOSE, var
    assert "--requirepass" in COMPOSE


def test_compose_images_are_pinned_by_digest_and_web_runs_unprivileged():
    for image in ("postgres", "redis", "caddy"):
        assert re.search(rf"image: {image}:\S+@sha256:[0-9a-f]{{64}}", COMPOSE), image
    assert "ELIUM_API_IMAGE" in COMPOSE and "ELIUM_WEB_IMAGE" in COMPOSE
    web = COMPOSE.split("  web:\n", 1)[1].split("\n  caddy:", 1)[0]
    assert "read_only: true" in web and "cap_drop" in web
    assert "web:8080" in _read(ROOT / "deploy" / "Caddyfile")


@pytest.mark.parametrize("dockerfile", ["server/Dockerfile", "web-studio/Dockerfile"])
def test_dockerfiles_use_lockfile_and_digest_pinned_bases(dockerfile):
    text = _read(ROOT / dockerfile)
    assert "npm install" not in text and "npm ci" in text
    assert "package-lock.json" in text
    froms = re.findall(r"^FROM (\S+)", text, re.M)
    assert froms and all(re.search(r"@sha256:[0-9a-f]{64}$", f) for f in froms)
    if dockerfile.startswith("web"):
        assert "USER 1000" in text


def test_caddyfile_sets_security_headers_and_body_limits():
    c = _read(ROOT / "deploy" / "Caddyfile")
    for header in ("Strict-Transport-Security", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"):
        assert header in c
    assert "request_body" in c and "max_size" in c
    assert "'unsafe-inline'" not in c and "'unsafe-eval'" not in c


def test_preupdate_backup_is_mandatory_and_rollback_restores_the_database():
    assert "Sauvegarde DB préalable échouée (on continue)" not in INSTALL_SH
    assert "mise à jour ABANDONNÉE" in INSTALL_SH
    assert "db_schema_version" in INSTALL_SH and "restore_db_dump" in INSTALL_SH
    assert "--clean --if-exists" in INSTALL_SH
    # le rollback ne restaure la base QUE si la version de schéma a changé
    assert '"$schema_after" != "$schema_before"' in INSTALL_SH


def test_updater_systemd_unit_is_unprivileged_and_hardened():
    assert "User=${run_user}" in INSTALL_SH
    for opt in ("NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=full", "RestrictSUIDSGID=true"):
        assert opt in INSTALL_SH
    assert "useradd --system" in INSTALL_SH


def test_auto_update_uses_signed_image_digests_with_optional_cosign():
    assert "serverImage" in INSTALL_SH and "webImage" in INSTALL_SH
    assert "cosign verify" in INSTALL_SH and "--no-build" in INSTALL_SH


def test_offsite_backup_and_remote_restore_are_available():
    assert "BACKUP_RCLONE_REMOTE" in INSTALL_SH and "rclone copy" in INSTALL_SH


def test_gen_manifest_embeds_signed_image_digests_and_rejects_bad_refs(tmp_path, monkeypatch):
    import json
    import sys

    sys.path.insert(0, str(ROOT / "installer"))
    import gen_manifest
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = Ed25519PrivateKey.generate().private_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption()).hex()
    web = tmp_path / "web.zip"
    web.write_bytes(b"PK\x05\x06" + b"\0" * 18)
    digest = "sha256:" + "ab" * 32
    base = ["gen_manifest", "--version", "4.9.1", "--web", str(web), "--out", str(tmp_path), "--key", key]
    monkeypatch.setattr(sys, "argv", [*base, "--server-image", f"ghcr.io/o/r/server@{digest}",
                                      "--web-image", f"ghcr.io/o/r/web@{digest}"])
    assert gen_manifest.main() == 0
    m = json.loads((tmp_path / "latest.json").read_bytes())
    assert m["serverImage"].endswith(digest) and m["webImage"].endswith(digest)
    # lisible par le sed d'install.sh : un champ plat par ligne
    assert f'"serverImage": "ghcr.io/o/r/server@{digest}"' in (tmp_path / "latest.json").read_text(encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [*base, "--server-image", "docker.io/evil/server:latest"])
    with pytest.raises(SystemExit):
        gen_manifest.main()


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash absent")
def test_install_sh_parses():
    r = subprocess.run(["bash", "-n", str(ROOT / "install.sh")], capture_output=True, text=True)  # noqa: S603, S607
    assert r.returncode == 0, r.stderr
