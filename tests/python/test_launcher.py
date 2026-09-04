"""
Tests du lanceur desktop (installer/elium_launcher.py) — en particulier la
protection anti-CSRF des routes d'état (/__update__/start, /__update__/restart,
/__rollback__/undo, /__rollback__) : sans elle, n'importe quelle page web ouverte
pendant qu'Elium tourne pourrait forcer un rollback/redémarrage via un simple
fetch() sur le port loopback prévisible (3000-3100).
"""
from __future__ import annotations

import json
import socket
import sys
from pathlib import Path

import pytest

# installer/ n'est pas un package : on l'ajoute au chemin d'import (même pattern
# que tests/python/test_updater.py).
_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import elium_launcher  # noqa: E402

_PORT = 3007
_GOOD = elium_launcher._SESSION_TOKEN
_ORIGIN = f"http://127.0.0.1:{_PORT}"
_HOST = f"127.0.0.1:{_PORT}"


# --------------------------------------------------------------------------- #
# _is_authorized_state_request
# --------------------------------------------------------------------------- #

def test_authorized_with_matching_token_and_origin():
    assert elium_launcher._is_authorized_state_request(_GOOD, _ORIGIN, None, _PORT) is True


def test_authorized_with_matching_token_and_host_when_no_origin():
    """Certains clients n'envoient pas Origin : Host reste vérifié en repli."""
    assert elium_launcher._is_authorized_state_request(_GOOD, None, _HOST, _PORT) is True


def test_rejects_wrong_token():
    assert elium_launcher._is_authorized_state_request("wrong-token", _ORIGIN, None, _PORT) is False


def test_rejects_missing_token():
    assert elium_launcher._is_authorized_state_request(None, _ORIGIN, None, _PORT) is False
    assert elium_launcher._is_authorized_state_request("", _ORIGIN, None, _PORT) is False


def test_rejects_correct_token_but_foreign_origin():
    """C'est exactement le scénario de l'attaque : une page tierce (évil.example)
    qui aurait — hypothétiquement — récupéré le jeton, mais dont l'Origin ne
    correspond jamais à celle du serveur loopback."""
    assert elium_launcher._is_authorized_state_request(_GOOD, "https://evil.example", None, _PORT) is False


def test_rejects_correct_token_but_mismatched_host_without_origin():
    assert elium_launcher._is_authorized_state_request(_GOOD, None, "evil.example", _PORT) is False


def test_rejects_correct_token_but_wrong_port():
    """Un autre port loopback (autre instance, ou un attaquant qui devine un port
    voisin dans la plage 3000-3100) ne doit jamais passer, même à jeton correct
    (jeton != celui de cette session dans ce cas de toute façon, mais on vérifie
    aussi qu'Origin/Host doivent viser CE port précis)."""
    assert elium_launcher._is_authorized_state_request(_GOOD, _ORIGIN, None, _PORT + 1) is False
    assert elium_launcher._is_authorized_state_request(_GOOD, None, _HOST, _PORT + 1) is False


def test_token_is_random_and_nontrivial():
    """Le jeton de session doit être suffisamment long/aléatoire pour ne pas être
    devinable (secrets.token_urlsafe(32) -> 43 caractères base64 urlsafe)."""
    assert isinstance(_GOOD, str)
    assert len(_GOOD) >= 32


# --------------------------------------------------------------------------- #
# _token_meta_tag : injection du jeton (jamais un script inline — CSP stricte)
# --------------------------------------------------------------------------- #

def test_token_meta_tag_carries_the_session_token():
    tag = elium_launcher._token_meta_tag()
    assert isinstance(tag, bytes)
    assert tag.startswith(b'<meta name="elium-token" content="')
    assert tag.endswith(b'">')
    assert _GOOD.encode("ascii") in tag


def test_token_meta_tag_is_not_a_script():
    """Rappel du constat corrigé : la CSP sert `script-src 'self'` (pas de
    'unsafe-inline'), donc le jeton ne peut PAS être injecté via un <script>
    inline — seule une balise <meta> (donnée, jamais exécutée) le peut."""
    tag = elium_launcher._token_meta_tag()
    assert b"<script" not in tag


def test_serve_index_with_banner_injects_meta_before_update_assets(tmp_path):
    index = tmp_path / "index.html"
    index.write_text("<html><body><div id=\"root\"></div></body></html>", encoding="utf-8")

    class _FakeWfile:
        def __init__(self):
            self.written = b""

        def write(self, data: bytes) -> None:
            self.written += data

    class _FakeHandler:
        command = "GET"

        def __init__(self):
            self.wfile = _FakeWfile()
            self.headers_sent = []

        def send_response(self, code):
            self.status = code

        def send_header(self, k, v):
            self.headers_sent.append((k, v))

        def end_headers(self):
            pass

        def _serve_bytes(self, data, content_type):
            self.status = 200
            self.headers_sent.append(("Content-Type", content_type))
            self.wfile.write(data)

    handler = _FakeHandler()
    elium_launcher.QuietHandler._serve_index_with_banner(handler, str(index))

    body = handler.wfile.written
    assert _GOOD.encode("ascii") in body
    assert b'<meta name="elium-token"' in body
    assert b"/__elium_update.js" in body
    # La balise <meta> doit précéder le script (l'ordre garantit que le DOM la
    # contient déjà quand le script (defer) s'exécute, même si ce n'est en
    # réalité pas nécessaire ici puisque tout le HTML est parsé avant un script
    # `defer`).
    assert body.index(b"elium-token") < body.index(b"__elium_update.js")


# --------------------------------------------------------------------------- #
# Port du serveur local : configurable, visible, sélectionnable
# --------------------------------------------------------------------------- #

@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    """LocalAppData temporaire : chaque test lit/écrit sa propre config, jamais
    la vraie config utilisateur de la machine qui exécute les tests."""
    monkeypatch.setenv("LocalAppData", str(tmp_path))
    return tmp_path


def test_resolve_port_defaults_to_auto_pick_when_unconfigured(isolated_config):
    port, fallback_used = elium_launcher.resolve_port()
    lo, hi = elium_launcher.PORT_RANGE
    assert lo <= port < hi
    assert fallback_used is False


def test_configured_port_is_honored_when_free(isolated_config):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    elium_launcher._save_launcher_config({"port": free_port})
    port, fallback_used = elium_launcher.resolve_port()
    assert port == free_port
    assert fallback_used is False


def test_configured_port_busy_falls_back_without_losing_preference(isolated_config):
    # Occupe le port choisi PENDANT la résolution, pour simuler un vrai conflit.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen(1)
        busy_port = busy.getsockname()[1]
        elium_launcher._save_launcher_config({"port": busy_port})
        port, fallback_used = elium_launcher.resolve_port()
        assert port != busy_port
        assert fallback_used is True
    # La préférence elle-même n'est PAS effacée par un conflit ponctuel — un
    # prochain lancement, une fois le port libéré, doit à nouveau l'utiliser.
    assert elium_launcher._configured_port() == busy_port


def test_scan_ports_reports_free_and_busy(isolated_config):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
        lo, _hi = elium_launcher.PORT_RANGE
        busy.bind(("127.0.0.1", lo))
        busy.listen(1)
        results = elium_launcher.scan_ports(count=3)
        by_port = {r["port"]: r["free"] for r in results}
        assert by_port[lo] is False
        assert lo + 1 in by_port and lo + 2 in by_port


def test_scan_ports_always_includes_configured_port_even_outside_window(isolated_config):
    lo, _hi = elium_launcher.PORT_RANGE
    far_port = lo + 50
    elium_launcher._save_launcher_config({"port": far_port})
    results = elium_launcher.scan_ports(count=3)
    assert any(r["port"] == far_port for r in results)


def test_set_port_endpoint_rejects_out_of_range(isolated_config):
    handler = _make_set_port_handler({"port": 80})
    handler.do_error = None
    elium_launcher.QuietHandler._handle_set_port(handler)
    assert handler.error_code == 400


def test_set_port_endpoint_rejects_busy_port(isolated_config):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen(1)
        busy_port = busy.getsockname()[1]
        handler = _make_set_port_handler({"port": busy_port})
        elium_launcher.QuietHandler._handle_set_port(handler)
        body = json.loads(handler.wfile.written)
        assert body["ok"] is False
        assert elium_launcher._configured_port() is None  # jamais persisté


def test_set_port_endpoint_persists_a_free_port(isolated_config):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    handler = _make_set_port_handler({"port": free_port})
    elium_launcher.QuietHandler._handle_set_port(handler)
    body = json.loads(handler.wfile.written)
    assert body == {"ok": True, "port": free_port}
    assert elium_launcher._configured_port() == free_port


def test_set_port_endpoint_none_clears_preference(isolated_config):
    elium_launcher._save_launcher_config({"port": 3050})
    handler = _make_set_port_handler({"port": None})
    elium_launcher.QuietHandler._handle_set_port(handler)
    assert elium_launcher._configured_port() is None


def _make_set_port_handler(payload: dict):
    """Fabrique un faux handler HTTP suffisant pour exercer _handle_set_port
    (même patron que le faux handler de _serve_index_with_banner ci-dessus)."""
    body = json.dumps(payload).encode("utf-8")

    class _FakeRfile:
        def __init__(self, data: bytes):
            self._data = data

        def read(self, n):
            return self._data[:n]

    class _FakeWfile:
        def __init__(self):
            self.written = b""

        def write(self, data):
            self.written += data

    class _FakeHandler:
        def __init__(self):
            self.headers = {"Content-Length": str(len(body))}
            self.rfile = _FakeRfile(body)
            self.wfile = _FakeWfile()
            self.error_code = None

        def send_error(self, code, _message=""):
            self.error_code = code

        def send_response(self, code):
            self.status = code

        def send_header(self, k, v):
            pass

        def end_headers(self):
            pass

        def _serve_bytes(self, data, content_type):
            self.status = 200
            self.wfile.write(data)

    return _FakeHandler()


# --------------------------------------------------------------------------- #
# Limite de débit sur les routes d'état (défense en profondeur, en plus du jeton)
# --------------------------------------------------------------------------- #

def test_rate_limit_allows_burst_then_blocks(monkeypatch):
    monkeypatch.setattr(elium_launcher, "_rate_limit_hits", [])
    monkeypatch.setattr(elium_launcher, "_RATE_LIMIT_MAX_CALLS", 3)
    results = [elium_launcher._rate_limited() for _ in range(5)]
    assert results == [False, False, False, True, True]


def test_rate_limit_window_expires(monkeypatch):
    import time as _time

    monkeypatch.setattr(elium_launcher, "_rate_limit_hits", [])
    monkeypatch.setattr(elium_launcher, "_RATE_LIMIT_MAX_CALLS", 1)
    monkeypatch.setattr(elium_launcher, "_RATE_LIMIT_WINDOW_S", 0.05)
    assert elium_launcher._rate_limited() is False
    assert elium_launcher._rate_limited() is True
    _time.sleep(0.08)
    assert elium_launcher._rate_limited() is False
