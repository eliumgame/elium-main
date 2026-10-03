"""
Durcissement du lanceur (installer/elium_launcher.py), sur un VRAI serveur loopback :

  - contrôle de l'en-tête Host (anti DNS-rebinding) sur toutes les routes GET /__* ;
  - plafond de corps sur POST /__ports__/set ;
  - dépôt d'un paquet de mise à jour hors ligne (POST /__update__/bundle) ;
  - arguments `.eliumupdate` / `--apply-update` ;
  - carte de mise à jour : états check-failed / repli, canal, mise à jour depuis un fichier.
"""
from __future__ import annotations

import functools
import http.client
import http.server
import json
import sys
import threading
from pathlib import Path

import pytest

_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import elium_launcher  # noqa: E402
import updater  # noqa: E402


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("LocalAppData", str(tmp_path / "appdata"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("ELIUM_NO_UPDATE", "1")
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<html><body>ok</body></html>", encoding="utf-8")
    monkeypatch.setattr(elium_launcher, "_rate_limit_hits", [])
    monkeypatch.setattr(elium_launcher, "_RATE_LIMIT_MAX_CALLS", 1000)
    monkeypatch.setattr(elium_launcher, "get_web_dir", lambda: web)
    monkeypatch.setattr(elium_launcher, "_serving_dir", None)
    handler = functools.partial(elium_launcher.QuietHandler, directory=str(web))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()
    srv.server_close()


def _get(port: int, path: str, host: str | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.putrequest("GET", path, skip_host=True)
    conn.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
    conn.endheaders()
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


def _post(port: int, path: str, body: bytes = b"", headers: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"X-Elium-Token": elium_launcher._SESSION_TOKEN, "Origin": f"http://127.0.0.1:{port}",
         "Content-Length": str(len(body))}
    h.update(headers or {})
    conn.request("POST", path, body=body, headers=h)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


INTERNAL_ROUTES = ["/__update__", "/__version__", "/__releases__", "/__ports__", "/__open__",
                   "/__open_seq__", "/__elium_update.js", "/__elium_update.css"]


@pytest.mark.parametrize("route", INTERNAL_ROUTES)
def test_every_internal_get_route_rejects_a_foreign_host(server, route):
    status, _ = _get(server, route, host="evil.example")
    assert status == 403
    status, _ = _get(server, route, host=f"evil.example:{server}")
    assert status == 403


@pytest.mark.parametrize("route", ["/__update__", "/__version__", "/__ports__", "/__elium_update.js"])
def test_internal_get_routes_still_work_with_the_real_host(server, route):
    status, body = _get(server, route)
    assert status == 200 and body
    status, _ = _get(server, route, host=f"localhost:{server}")
    assert status == 200


def test_static_files_are_unaffected_by_the_host_check(server):
    status, body = _get(server, "/index.html", host="whatever.local")
    assert status == 200 and b"ok" in body


def test_set_port_refuses_an_oversized_body_without_reading_it(server):
    status, _ = _post(server, "/__ports__/set", body=b"{" + b" " * 5000 + b"}",
                      headers={"Content-Type": "application/json"})
    assert status == 413


def test_set_port_still_accepts_a_small_body(server):
    status, data = _post(server, "/__ports__/set", body=json.dumps({"port": None}).encode())
    assert status == 200 and json.loads(data)["ok"] is True


def test_bundle_upload_requires_the_session_token(server):
    conn = http.client.HTTPConnection("127.0.0.1", server, timeout=5)
    conn.request("POST", "/__update__/bundle", body=b"x", headers={"Content-Length": "1"})
    assert conn.getresponse().status == 403


def test_bundle_upload_rejects_bad_length(server, monkeypatch):
    status, _ = _post(server, "/__update__/bundle", body=b"")
    assert status == 400
    monkeypatch.setattr(elium_launcher, "_MAX_BUNDLE_UPLOAD", 10)
    status, _ = _post(server, "/__update__/bundle", body=b"x" * 11)
    assert status == 413


def test_bundle_upload_hands_the_file_to_the_updater(server, monkeypatch, tmp_path):
    seen = {}

    def fake_start(path):
        seen["bytes"] = Path(path).read_bytes()
        seen["name"] = Path(path).name
        return {"state": "downloading"}

    monkeypatch.setattr(updater, "start_bundle_update", fake_start)
    payload = b"PK-fake-bundle" * 1000
    status, data = _post(server, "/__update__/bundle", body=payload)
    assert status == 200 and json.loads(data)["state"] == "downloading"
    assert seen["bytes"] == payload and seen["name"].endswith(".eliumupdate")


def test_check_and_channel_routes(server, monkeypatch):
    monkeypatch.setattr(updater, "check_only", lambda: {"state": "up-to-date"})
    status, data = _post(server, "/__update__/check")
    assert status == 200 and json.loads(data)["state"] == "up-to-date"
    chosen = {}
    monkeypatch.setattr(updater, "set_channel", lambda name: chosen.setdefault("name", name) and {"state": "idle"})
    status, _ = _post(server, "/__update__/channel?name=beta")
    assert status == 200 and chosen["name"] == "beta"


def test_first_served_index_marks_boot_ok(server, monkeypatch):
    calls = []
    monkeypatch.setattr(updater, "mark_boot_ok", lambda: calls.append(1))
    monkeypatch.setattr(elium_launcher, "_boot_ok_marked", False)
    _get(server, "/")
    _get(server, "/")
    assert calls == [1]   # une seule fois par process


# --------------------------------------------------------------------------- #
# Arguments : paquet .eliumupdate
# --------------------------------------------------------------------------- #


def test_extract_update_bundle_arg(tmp_path):
    bundle = tmp_path / "Elium-update-4.9.1.eliumupdate"
    bundle.write_bytes(b"x")
    doc = tmp_path / "a.elium"
    doc.write_bytes(b"y")
    rest, found = elium_launcher._extract_update_bundle_arg([str(bundle), str(doc)])
    assert found == str(bundle) and rest == [str(doc)]
    rest, found = elium_launcher._extract_update_bundle_arg(["--apply-update", "x.bin", "other"])
    assert found == "x.bin" and rest == ["other"]
    rest, found = elium_launcher._extract_update_bundle_arg([str(doc)])
    assert found is None and rest == [str(doc)]
    # un .eliumupdate inexistant n'est pas pris pour un paquet (rien à appliquer)
    rest, found = elium_launcher._extract_update_bundle_arg([str(tmp_path / "ghost.eliumupdate")])
    assert found is None


# --------------------------------------------------------------------------- #
# Carte de mise à jour (JS/CSS servis)
# --------------------------------------------------------------------------- #


def test_update_card_handles_the_new_states():
    js = elium_launcher.UPDATE_JS
    assert "check-failed" in js and "st.fallback" in js
    assert "/__update__/channel" in js and "/__update__/bundle" in js and "/__update__/check" in js
    assert ".eliumupdate" in js
    # hors ligne : pas de carte intrusive pour une appli local-first
    assert "st.reason === 'offline'" in js
    # la carte reste sans script/style inline (CSP stricte) : aucun innerHTML
    assert "innerHTML" not in js
    assert ".elium-upd-foot" in elium_launcher.UPDATE_CSS


def test_rate_limited_response_is_actually_sent_despite_non_latin1_text(server, monkeypatch):
    """Régression : le message 429 contenait un tiret cadratin, non encodable en latin-1 (ligne de
    statut HTTP) -> UnicodeEncodeError côté serveur et aucune réponse n'était envoyée."""
    monkeypatch.setattr(elium_launcher, "_RATE_LIMIT_MAX_CALLS", 1)
    monkeypatch.setattr(elium_launcher, "_rate_limit_hits", [])
    assert _post(server, "/__ports__/set", body=b'{"port": null}')[0] == 200
    status, _ = _post(server, "/__ports__/set", body=b'{"port": null}')
    assert status == 429
