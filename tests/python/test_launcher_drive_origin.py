"""Drive depuis l'app Windows : origine du serveur déclarée → ajoutée à connect-src (et à rien d'autre)."""
from __future__ import annotations

import functools
import http.client
import http.server
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "installer"))
import elium_launcher  # noqa: E402


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://drive.example.com", "https://drive.example.com"),
        ("https://drive.example.com/", "https://drive.example.com"),
        ("https://drive.example.com:8443", "https://drive.example.com:8443"),
        ("http://127.0.0.1:8787", "http://127.0.0.1:8787"),
        ("http://localhost:3100", "http://localhost:3100"),
    ],
)
def test_valid_origins(raw, expected):
    assert elium_launcher.normalize_drive_origin(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None, "", 42, "http://drive.example.com", "ftp://x.example.com", "javascript:alert(1)",
        "https://drive.example.com/api", "https://drive.example.com/?q=1", "https://u:p@drive.example.com",
        "https://drive.example.com; script-src *", "https://a.example.com https://b.example.com",
        "https://drive.example.com'", "https://*.example.com", "https://exa mple.com", "//drive.example.com",
        "https://drive.example.com\r\nX: y", "data:text/html,x", "https://drive.example.com#frag",
    ],
)
def test_refused_origins(raw):
    assert elium_launcher.normalize_drive_origin(raw) is None


@pytest.fixture()
def config(tmp_path, monkeypatch):
    cfg = tmp_path / "launcher-config.json"
    monkeypatch.setattr(elium_launcher, "_config_path", lambda: cfg)
    return cfg


def test_csp_is_strict_by_default_and_opens_only_the_declared_origin(config):
    assert elium_launcher.content_security_policy() == elium_launcher.CONTENT_SECURITY_POLICY
    config.write_text(json.dumps({"drive_origin": "https://drive.example.com"}), encoding="utf-8")
    csp = elium_launcher.content_security_policy()
    assert "connect-src 'self' data: blob: https://drive.example.com wss://drive.example.com;" in csp + ";"
    # rien d'autre n'est élargi
    others = [d for d in csp.split("; ") if not d.startswith("connect-src")]
    base = [d for d in elium_launcher.CONTENT_SECURITY_POLICY.split("; ") if not d.startswith("connect-src")]
    assert others == base
    assert "'unsafe-inline'" not in csp and "'unsafe-eval'" not in csp


def test_a_tampered_config_never_injects_into_the_csp(config):
    config.write_text(json.dumps({"drive_origin": "https://x.example.com; script-src *"}), encoding="utf-8")
    assert elium_launcher.content_security_policy() == elium_launcher.CONTENT_SECURITY_POLICY


@pytest.fixture()
def server(tmp_path, config):
    handler = functools.partial(elium_launcher.QuietHandler, directory=str(tmp_path))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def _call(port, method, body=None, token=elium_launcher._SESSION_TOKEN, origin="same"):
    headers = {}
    if token is not None:
        headers["X-Elium-Token"] = token
    if origin == "same":
        headers["Origin"] = f"http://127.0.0.1:{port}"
    elif origin:
        headers["Origin"] = origin
    raw = json.dumps(body).encode() if body is not None else None
    if raw is not None:
        headers["Content-Length"] = str(len(raw))
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, "/__drive_origin__", body=raw, headers=headers)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r.status, r, data


def test_route_sets_clears_and_reflects_in_the_csp_header(server, config):
    st, _, data = _call(server, "POST", {"origin": "https://drive.example.com/"})
    assert st == 200 and json.loads(data)["origin"] == "https://drive.example.com"
    st, resp, data = _call(server, "GET", token=None)  # lecture : l'origine n'est pas un secret
    assert json.loads(data)["origin"] == "https://drive.example.com"
    assert "https://drive.example.com wss://drive.example.com" in resp.getheader("Content-Security-Policy")
    st, resp, _ = _call(server, "POST", {"origin": None})
    assert st == 200
    assert "drive.example.com" not in (_call(server, "GET", token=None)[1].getheader("Content-Security-Policy") or "")


def test_route_requires_token_and_own_origin_and_a_valid_value(server, config):
    assert _call(server, "POST", {"origin": "https://drive.example.com"}, token=None)[0] == 403
    assert _call(server, "POST", {"origin": "https://drive.example.com"}, token="faux")[0] == 403
    assert _call(server, "POST", {"origin": "https://drive.example.com"}, origin="http://evil.test")[0] == 403
    assert _call(server, "POST", {"origin": "https://a.example.com; script-src *"})[0] == 400
    assert _call(server, "POST", {"origin": "http://drive.example.com"})[0] == 400
    assert not config.exists() or "drive_origin" not in json.loads(config.read_text(encoding="utf-8"))
