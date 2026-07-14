"""Stable unique document id (docId, UUID) at the .elium package level."""
import io
import json
import uuid
import zipfile

from elium.format.package import read_elium, write_elium

_DOC = {"schema": "elium-doc/1", "doc": {"type": "doc", "content": []}}


def _manifest(blob: bytes) -> dict:
    return json.loads(zipfile.ZipFile(io.BytesIO(blob)).read("manifest.json"))


def test_docid_is_a_fresh_uuid_on_each_write():
    a = _manifest(write_elium(_DOC))
    b = _manifest(write_elium(_DOC))
    assert a["docId"] != b["docId"]  # no same-second collision (unlike createdAt)
    uuid.UUID(a["docId"])            # well-formed UUID
    uuid.UUID(b["docId"])


def test_docid_preserved_when_provided_and_round_trips():
    fixed = "11111111-2222-3333-4444-555555555555"
    blob = write_elium(_DOC, doc_id=fixed)
    assert _manifest(blob)["docId"] == fixed
    assert read_elium(blob)["manifest"]["docId"] == fixed
