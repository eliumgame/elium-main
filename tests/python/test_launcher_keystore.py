"""Routes /__keystore__/wrap|unwrap du lanceur (couche optionnelle Windows DPAPI)."""
from __future__ import annotations

import functools
import http.client
import http.server
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "installer"))
import elium_launcher  # noqa: E402


@pytest.fixture()
def server(tmp_path):
    handler = functools.partial(elium_launcher.QuietHandler, directory=str(tmp_path))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def _post(port: int, path: str, body: bytes, token: str | None = elium_launcher._SESSION_TOKEN):
    headers = {"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/octet-stream"}
    if token is not None:
        headers["X-Elium-Token"] = token
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


@pytest.mark.parametrize("op", ["wrap", "unwrap"])
def test_keystore_requires_the_session_token(server, op):
    status, _ = _post(server, f"/__keystore__/{op}", b"x", token=None)
    assert status == 403
    status, _ = _post(server, f"/__keystore__/{op}", b"x", token="faux")
    assert status == 403


@pytest.mark.skipif(sys.platform == "win32", reason="501 attendu hors Windows uniquement")
def test_keystore_is_501_off_windows(server):
    assert elium_launcher.keystore_available() is False
    status, _ = _post(server, "/__keystore__/wrap", b"secret")
    assert status == 501


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI : Windows uniquement")
def test_dpapi_roundtrip_over_http(server):
    secret = bytes(range(32))
    status, blob = _post(server, "/__keystore__/wrap", secret)
    assert status == 200
    assert blob != secret and secret not in blob  # chiffré, pas en clair
    status, back = _post(server, "/__keystore__/unwrap", blob)
    assert status == 200
    assert back == secret


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI : Windows uniquement")
def test_dpapi_rejects_garbage_and_oversize(server):
    status, _ = _post(server, "/__keystore__/unwrap", b"pas un blob DPAPI")
    assert status == 422
    status, _ = _post(server, "/__keystore__/wrap", b"x" * (elium_launcher._KEYSTORE_MAX + 1))
    assert status == 400
    status, _ = _post(server, "/__keystore__/wrap", b"")
    assert status == 400
