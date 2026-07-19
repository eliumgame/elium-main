"""Security-guard coverage: v3 KDF bounds, v4 package keyfile, CLI path-traversal."""

from __future__ import annotations

import json
import struct
from unittest.mock import patch

import pytest

from elium.cli.main import main
from elium.core.container import MAGIC_V3, VERSION, EliumContainer
from elium.core.exceptions import EliumError, EliumSecurityError
from elium.crypto.primitives import HMAC_SIZE
from elium.format.document import create_document_model
from elium.format.package import read_elium, write_elium


def _forged_blob(t: int, m: int, p: int) -> bytes:
    """Minimal v3 blob whose header reaches the KDF-bounds check (fires before MAC)."""
    header = {
        "version": VERSION,
        "flags": {},
        "kdf": {"alg": "argon2id", "t": t, "m": m, "p": p, "salt": "00" * 16},
        "crypto": {"nonce_aes": "00" * 12},
    }
    hb = json.dumps(header).encode("utf-8")
    return MAGIC_V3 + struct.pack(">I", len(hb)) + hb + b"\x00" * (8 + HMAC_SIZE + 32)


@pytest.mark.parametrize("t,m,p", [
    (0, 262144, 4),    # t below floor
    (100, 262144, 4),  # t above ceiling
    (3, 4096, 4),      # m below floor
    (3, 999999, 4),    # m above ceiling
    (3, 262144, 0),    # p below floor
    (3, 262144, 99),   # p above ceiling
])
def test_v3_kdf_bounds_rejected(t, m, p):
    with pytest.raises(EliumSecurityError):
        EliumContainer.decode(_forged_blob(t, m, p), password="pw")


def test_v4_package_keyfile_roundtrip_and_wrong_keyfile():
    doc = create_document_model()
    keyfile = b"a-real-keyfile-secret"
    blob = write_elium(doc, profile="encrypted", title="T", password="pw", keyfile=keyfile)

    ok = read_elium(blob, password="pw", keyfile=keyfile)
    assert ok["manifest"]["protection"]["encrypted"] is True
    assert ok["manifest"]["protection"]["keyfileRequired"] is True

    with pytest.raises(EliumError):
        read_elium(blob, password="pw", keyfile=b"wrong-keyfile")
    # Missing keyfile entirely also fails.
    with pytest.raises(EliumError):
        read_elium(blob, password="pw")


@pytest.mark.parametrize("bad_name", ["..", "."])
def test_cli_open_rejects_dotdot_names(tmp_path, capsys, bad_name):
    # `.` / `..` are refused outright on every platform.
    blob = EliumContainer.encode(b"payload", "pw", manifest_meta={"files": [{"name": bad_name, "size": 7}]})
    container = tmp_path / "mal.elium"
    container.write_bytes(blob)
    out_dir = tmp_path / "out"

    with patch("sys.argv", ["elium", "open", str(container), "--password", "pw", "--output", str(out_dir)]):
        with pytest.raises(SystemExit) as exc:
            main()
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert ("Unsafe filename" in err) or ("outside the target directory" in err)


@pytest.mark.parametrize("bad_name", [
    "../evil.txt", "../../evil.txt", "/etc/evil.txt", "\\\\srv\\share\\evil.txt", "sub/../../evil.txt",
])
def test_cli_open_never_escapes_output_dir(tmp_path, bad_name):
    # Whatever the manifest claims, extraction must stay inside --output: the guard
    # raises (Unix-absolute / commonpath) or basename neutralises the traversal.
    blob = EliumContainer.encode(b"payload", "pw", manifest_meta={"files": [{"name": bad_name, "size": 7}]})
    container = tmp_path / "mal.elium"
    container.write_bytes(blob)
    out_dir = tmp_path / "out"

    with patch("sys.argv", ["elium", "open", str(container), "--password", "pw", "--output", str(out_dir)]):
        try:
            main()
        except SystemExit:
            pass  # guard fired — also acceptable
    # Nothing may land directly under tmp_path except the container and the output dir.
    assert {p.name for p in tmp_path.iterdir()} <= {"mal.elium", "out"}
