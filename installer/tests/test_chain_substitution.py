"""Un manifeste authentique d'une autre version ne valide jamais un artefact."""
import hashlib

import pytest
import updater


def test_signed_other_version_overlay_is_rejected(signed_updates):
    root = updater._web_root() / "4.2.0"
    root.mkdir(parents=True)
    (root / "index.html").write_bytes(b"genuine older interface")
    manifest = signed_updates({
        "version": "4.1.0", "codeHash": updater.BUILD_CODE_HASH,
        "artifacts": {"web": {"treeHash": updater.tree_hash_dir(root)}},
    })
    assert updater._store_signed_manifest(manifest, root)
    updater._set_pointer("4.2.0")
    assert updater._load_signed_manifest(root) is not None  # signature valide
    assert updater.active_web_dir() is None


def test_signed_other_version_executable_is_rejected(signed_updates):
    exe = updater._bin_root() / "Elium-4.2.0.exe"
    exe.parent.mkdir(parents=True)
    payload = b"genuine older executable"
    exe.write_bytes(payload)
    manifest = signed_updates({
        "version": "4.1.0",
        "artifacts": {"exe": {"sha256": hashlib.sha256(payload).hexdigest()}},
    })
    assert updater._store_signed_manifest(manifest, exe.with_suffix(""))
    updater._save_json(updater._pending_file(), {"version": "4.2.0"})
    assert updater._load_signed_manifest(exe.with_suffix("")) is not None
    assert updater._verified_pending_exe() is None


@pytest.mark.parametrize("condition", ["missing", "unsigned", "quarantined"])
def test_pending_executable_requires_all_checks(signed_updates, condition):
    exe = updater._bin_root() / "Elium-4.2.0.exe"
    exe.parent.mkdir(parents=True)
    payload = b"executable"
    manifest = signed_updates({
        "version": "4.2.0",
        "artifacts": {"exe": {"sha256": hashlib.sha256(payload).hexdigest()}},
    })
    if condition != "missing":
        exe.write_bytes(payload)
    if condition != "unsigned":
        assert updater._store_signed_manifest(manifest, exe.with_suffix(""))
    if condition == "quarantined":
        updater._quarantine("4.2.0")
    updater._save_json(updater._pending_file(), {"version": "4.2.0"})
    assert updater._verified_pending_exe() is None
