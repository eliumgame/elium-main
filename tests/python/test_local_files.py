"""Stockage en fichiers locaux : module installer/local_files.py + routes /__files__/ du lanceur."""
from __future__ import annotations

import functools
import http.client
import http.server
import io
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "installer"))
import elium_launcher  # noqa: E402
import local_files  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = local_files.LocalFiles(tmp_path / "Elium")
    s.ensure_root()
    return s


@pytest.mark.parametrize(
    "bad",
    [
        "", "a", "Documents", "Documents/", "../x.elium", "Documents/../x.elium", "Documents/a/b.elium",
        "Autre/x.elium", "Documents/x.exe", "Documents/x.elium:stream", "Documents/CON.elium",
        "Documents/nul.json", "Documents/a?b.elium", "Documents/a\b.elium", "Documents/x.elium.",
        "Documents/ x.elium", "C:/x.elium", "/Documents/x.elium", "Documents/" + "a" * 250 + ".elium",
        "Documents/x\x00.elium",
    ],
)
def test_logical_paths_are_refused(store, bad):
    with pytest.raises(local_files.PathRefused):
        store.resolve(bad)


def test_roundtrip_list_and_atomic_write(store):
    store.write("Documents/Mon doc [abc].elium", b"\x00data")
    store.write("PDF/f [1].pdf", b"%PDF")
    assert store.read("Documents/Mon doc [abc].elium") == b"\x00data"
    assert [e["p"] for e in store.list()] == ["Documents/Mon doc [abc].elium", "PDF/f [1].pdf"]
    store.write("Documents/Mon doc [abc].elium", b"v2")  # remplacement
    assert store.read("Documents/Mon doc [abc].elium") == b"v2"
    assert not [p for p in (store.root / "Documents").iterdir() if p.name.endswith(".tmp")]


def test_truncated_body_keeps_previous_file(store):
    store.write("Documents/a.elium", b"bon")
    with pytest.raises(OSError):
        store.write_stream("Documents/a.elium", io.BytesIO(b"xx"), 10)
    assert store.read("Documents/a.elium") == b"bon"
    assert [p.name for p in (store.root / "Documents").iterdir()] == ["a.elium"]


def test_remove_moves_to_trash_and_purges(store):
    store.write("Documents/a.elium", b"x")
    assert store.remove("Documents/a.elium") is True
    assert store.remove("Documents/a.elium") is False
    assert store.list() == []
    trashed = list((store.root / ".corbeille").iterdir())
    assert len(trashed) == 1 and trashed[0].read_bytes() == b"x"
    assert store.purge_trash() == 0
    assert store.purge_trash(now=time.time() + 31 * 24 * 3600) == 1


@pytest.mark.skipif(os.name == "nt", reason="symlink : droits admin requis sous Windows")
def test_symlink_escape_is_refused(store, tmp_path):
    outside = tmp_path / "dehors"
    outside.mkdir()
    (outside / "secret.elium").write_bytes(b"s")
    (store.root / "Documents").symlink_to(outside, target_is_directory=True)
    with pytest.raises(local_files.PathRefused):
        store.read("Documents/secret.elium")


# --- routes HTTP ---------------------------------------------------------------


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(elium_launcher, "_files_store", local_files.LocalFiles(tmp_path / "Elium"))
    elium_launcher._files_store.ensure_root()
    handler = functools.partial(elium_launcher.QuietHandler, directory=str(tmp_path))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def _call(port, method, path, body=None, token=elium_launcher._SESSION_TOKEN, origin="same", host=None):
    headers = {}
    if token is not None:
        headers["X-Elium-Token"] = token
    if origin == "same":
        headers["Origin"] = f"http://127.0.0.1:{port}"
    elif origin:
        headers["Origin"] = origin
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.putrequest(method, path, skip_host=host is not None)
    if host is not None:
        conn.putheader("Host", host)
    for k, v in headers.items():
        conn.putheader(k, v)
    if body is not None:
        conn.putheader("Content-Length", str(len(body)))
    conn.endheaders(body)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r.status, data


def test_http_roundtrip(server):
    st, _ = _call(server, "POST", "/__files__/write?p=Documents/a%20%5Bid%5D.elium", b"hello")
    assert st == 200
    st, data = _call(server, "GET", "/__files__/read?p=Documents/a%20%5Bid%5D.elium")
    assert (st, data) == (200, b"hello")
    st, data = _call(server, "GET", "/__files__/list")
    assert st == 200 and json.loads(data)["files"][0]["p"] == "Documents/a [id].elium"
    st, data = _call(server, "GET", "/__files__/info")
    assert st == 200 and json.loads(data)["enabled"] is True
    st, data = _call(server, "POST", "/__files__/remove?p=Documents/a%20%5Bid%5D.elium", b"")
    assert st == 200 and json.loads(data)["removed"] is True


@pytest.mark.parametrize("route", ["info", "list", "read?p=Documents/a.elium"])
def test_get_requires_token(server, route):
    assert _call(server, "GET", f"/__files__/{route}", token=None)[0] == 403
    assert _call(server, "GET", f"/__files__/{route}", token="faux")[0] == 403


def test_foreign_origin_and_rebinding_host_are_refused(server):
    ok = "/__files__/list"
    assert _call(server, "GET", ok, origin="http://evil.example")[0] == 403
    assert _call(server, "GET", ok, origin=None, host="evil.example:80")[0] == 403
    assert _call(server, "POST", "/__files__/write?p=Documents/a.elium", b"x", token=None)[0] == 403


@pytest.mark.parametrize(
    "p",
    ["../x.elium", "Documents/..%2Fx.elium", "Documents/x.exe", "C:%2Fx.elium", "Documents/CON.elium"],
)
def test_http_traversal_is_400(server, p):
    assert _call(server, "POST", f"/__files__/write?p={p}", b"x")[0] == 400
    assert _call(server, "GET", f"/__files__/read?p={p}")[0] == 400


def test_missing_file_is_404(server):
    assert _call(server, "GET", "/__files__/read?p=Documents/absent.elium")[0] == 404


def test_hard_remove_leaves_nothing_in_trash(store):
    store.write("Documents/a.elium", b"clair")
    assert store.remove("Documents/a.elium", hard=True) is True
    assert not (store.root / ".corbeille").exists() and store.list() == []
