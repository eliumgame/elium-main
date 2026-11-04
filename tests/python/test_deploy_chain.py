"""Deployment regressions in a disposable checkout; never load the operator's .env."""
import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None)


def shell(tmp_path, body):
    if not BASH or not Path(BASH).is_file():
        pytest.skip("bash unavailable")
    (tmp_path / "install.sh").write_bytes((ROOT / "install.sh").read_bytes())
    (tmp_path / ".env").write_text("ELIUM_API_IMAGE=registry/api@sha256:test\n", encoding="utf-8")
    return subprocess.run([BASH, "-c", 'source ./install.sh help >/dev/null\n' + body],  # noqa: S603
                          cwd=tmp_path, capture_output=True, text=True, timeout=15)


def test_manual_pinned_update_delegates_before_pulling_or_relabeling(tmp_path):
    result = shell(tmp_path, '''
detect_compose() { DC=stub; }
do_self_update() { echo signed-update; }
git() { echo forbidden-git-pull; return 1; }
set_env_var() { echo forbidden-version-write; return 1; }
do_update
''')
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "signed-update"


@pytest.mark.skipif(os.name == "nt", reason="Unix permission bits verified on Linux CI")
def test_backup_artifacts_are_private_even_under_public_parent_umask(tmp_path):
    result = shell(tmp_path, 'mkdir backups\nprintf private > backups/test.sql\nstat -c "%a" backups backups/test.sql')
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["700", "600"]


def test_release_feed_replaces_complete_json_atomically(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("release_feed", ROOT / "deploy/release-feed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / "release.json"
    module.write_out(str(target), '{"version":"1"}')
    replace = os.replace

    def checked_replace(source, destination):
        assert target.read_text(encoding="utf-8") == '{"version":"1"}'
        assert Path(source).read_text(encoding="utf-8") == '{"version":"2"}'
        replace(source, destination)

    monkeypatch.setattr(module.os, "replace", checked_replace)
    module.write_out(str(target), '{"version":"2"}')
    assert target.read_text(encoding="utf-8") == '{"version":"2"}'
