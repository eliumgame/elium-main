"""Hardening regressions (audit CORE-04/06/07/10)."""
import io
import json
import struct
import zipfile

import pytest

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError, EliumFormatError
from elium.crypto.recipients import (
    MAX_RECIPIENTS,
    decrypt_as_recipient,
    encrypt_for_recipients,
    generate_recipient_keypair,
)
from elium.core.exceptions import EliumSecurityError
from elium.format.canonical import sha256_hex
from elium.format.document import create_document_model, text_to_doc
from elium.format.package import (
    ENTRY_MANIFEST,
    EliumPackageError,
    read_elium,
    write_elium,
)


def _repack(blob, replace=None, drop=()):
    replace = replace or {}
    zin = zipfile.ZipFile(io.BytesIO(blob))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            if it.filename in drop:
                continue
            data = replace.get(it.filename, zin.read(it.filename))
            zo.writestr(it.filename, data,
                        compress_type=zipfile.ZIP_STORED if it.filename == "mimetype" else zipfile.ZIP_DEFLATED)
    return out.getvalue()


def _doc():
    return create_document_model(text_to_doc("hello"))


@pytest.mark.parametrize("mutate", [
    lambda m: m.update(profile="nope"),
    lambda m: m["protection"].update(encrypted=True),
    lambda m: m["protection"].update(locked=True),
    lambda m: m["protection"].update(contentEntry="content/document.elium"),
    lambda m: m.pop("protection"),
])
def test_core04_incoherent_manifest_rejected(mutate):
    blob = write_elium(_doc(), profile="standard", title="t")
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
    mutate(man)
    with pytest.raises(EliumPackageError):
        read_elium(_repack(blob, {ENTRY_MANIFEST: json.dumps(man).encode()}))


def test_core04_coherent_files_all_profiles_still_open():
    for profile, kw in [("standard", {}), ("signed", {}), ("tracked", {}), ("locked", {}),
                        ("protected", {"password": "pw"}), ("encrypted", {"password": "pw"}),
                        ("secure_max", {"password": "pw"})]:
        blob = write_elium(_doc(), profile=profile, title="t", **kw)
        assert read_elium(blob, password=kw.get("password"))["manifest"]["profile"] == profile


def test_core06_missing_resource_flagged():
    data = b"image-bytes"
    rid = sha256_hex(data)
    blob = write_elium(_doc(), profile="standard", title="t",
                       resource_index=[{"id": rid, "name": "a.png"}], resources={rid: data})
    assert read_elium(blob)["integrity"]["resourcesTampered"] == []
    stripped = _repack(blob, drop=(f"resources/{rid}",))
    assert read_elium(stripped)["integrity"]["resourcesTampered"] == [rid]


def test_core07_recipient_cap():
    _, pub = generate_recipient_keypair()
    with pytest.raises(EliumSecurityError):
        encrypt_for_recipients(b"x", [pub] * (MAX_RECIPIENTS + 1))
    priv, pub = generate_recipient_keypair()
    blob = encrypt_for_recipients(b"x", [pub])
    env = json.loads(blob)
    env["recipients"] = env["recipients"] * (MAX_RECIPIENTS + 1)
    with pytest.raises(EliumSecurityError):
        decrypt_as_recipient(json.dumps(env).encode(), priv)
    assert decrypt_as_recipient(blob, priv) == b"x"


def test_core10_container_malformed_inputs_are_elium_errors():
    good = EliumContainer.encode(b"payload", "pw")
    # truncated at every interesting boundary: never a raw exception
    for cut in (7, 12, 40, 200, len(good) - 1):
        with pytest.raises(EliumError):
            EliumContainer.decode(good[:cut], "pw")
    # declared ciphertext length larger than file: rejected before Argon2
    hl = struct.unpack(">I", good[6:10])[0]
    pos = 10 + hl
    bad = good[:pos] + struct.pack(">Q", 10**12) + good[pos + 8:]
    with pytest.raises(EliumFormatError):
        EliumContainer.decode(bad, "pw")
    # garbage header JSON shapes
    for hdr in (b"[]", b'{"version":3,"kdf":"x","crypto":{},"flags":{}}',
                b'{"version":3,"kdf":{"alg":"argon2id","t":"3","m":1,"p":1},"crypto":{},"flags":{}}'):
        blob = good[:6] + struct.pack(">I", len(hdr)) + hdr + good[10 + hl:]
        with pytest.raises(EliumError):
            EliumContainer.decode(blob, "pw")
    assert EliumContainer.decode(good, "pw")[0] == b"payload"


def test_cli_doc_create_encrypt_metadata(tmp_path):
    from elium.cli.main import main
    src = tmp_path / "a.txt"
    src.write_text("secret body", encoding="utf-8")
    out = tmp_path / "a.elium"
    import sys
    argv = ["elium", "doc-create", "--input", str(src), "--output", str(out), "--title", "TopSecret",
            "--profile", "encrypted", "--password", "pw", "--encrypt-metadata"]
    old = sys.argv
    sys.argv = argv
    try:
        main()
    finally:
        sys.argv = old
    man = json.loads(zipfile.ZipFile(str(out)).read(ENTRY_MANIFEST))
    assert man["protection"].get("metadataEncrypted") is True
    assert "TopSecret" not in json.dumps(man)
    assert read_elium(out.read_bytes(), password="pw")["manifest"]["title"] == "TopSecret"
