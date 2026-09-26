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


# --------------------------------------------------------------------------- #
# Content-Security-Policy servie par le lanceur (cible réelle de l'appli)
# --------------------------------------------------------------------------- #

def _csp_directives() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for part in elium_launcher.CONTENT_SECURITY_POLICY.split(";"):
        tokens = part.split()
        if tokens:
            assert tokens[0] not in out, f"directive dupliquée : {tokens[0]}"
            out[tokens[0]] = tokens[1:]
    return out


def test_csp_script_stays_strict():
    """Ni 'unsafe-inline' ni 'unsafe-eval' dans script-src : seul WebAssembly
    (Argon2id, décodeurs pdf.js) est autorisé à compiler du code."""
    d = _csp_directives()
    assert d["default-src"] == ["'self'"]
    assert d["script-src"] == ["'self'", "'wasm-unsafe-eval'"]
    assert "'unsafe-inline'" not in elium_launcher.CONTENT_SECURITY_POLICY
    assert "'unsafe-eval'" not in elium_launcher.CONTENT_SECURITY_POLICY


def test_csp_allows_local_data_schemes_only():
    """Miniatures / signatures (data:), impression (iframe blob:), OCR (worker
    blob:) — mais AUCUNE origine réseau supplémentaire."""
    d = _csp_directives()
    assert d["img-src"] == ["'self'", "data:", "blob:"]
    assert d["worker-src"] == ["'self'", "blob:"]
    assert d["connect-src"] == ["'self'", "data:", "blob:"]
    assert d["media-src"] == ["'self'", "data:", "blob:"]
    assert d["frame-src"] == ["'self'", "blob:"]
    assert d["object-src"] == ["'none'"]
    assert d["base-uri"] == ["'self'"]
    for name in ("img-src", "worker-src", "connect-src", "media-src", "frame-src"):
        assert not any(t.startswith("http") or t == "*" for t in d[name]), name


def test_csp_style_and_font_sources_unchanged():
    d = _csp_directives()
    assert d["style-src"] == ["'self'", "https://fonts.googleapis.com"]
    assert d["font-src"] == ["'self'", "https://fonts.gstatic.com"]


def test_every_response_carries_the_csp(monkeypatch):
    import http.server as _hs

    sent: list[tuple[str, str]] = []

    class _Probe(elium_launcher.QuietHandler):
        def __init__(self):  # pas de socket : on n'appelle que end_headers()
            pass

        def send_header(self, key, value):
            sent.append((key, value))

    # SimpleHTTPRequestHandler.end_headers() écrit le tampon de sortie : neutralisé.
    monkeypatch.setattr(_hs.SimpleHTTPRequestHandler, "end_headers", lambda self: None)
    _Probe().end_headers()
    assert ("Content-Security-Policy", elium_launcher.CONTENT_SECURITY_POLICY) in sent


def test_script_and_wasm_types_do_not_depend_on_the_windows_registry():
    # « nosniff » + un .js déclaré text/plain dans le registre = plus aucun
    # script chargé : les types des scripts, modules et wasm sont fixés.
    types = elium_launcher.QuietHandler.extensions_map
    assert types[".js"] == "text/javascript"
    assert types[".mjs"] == "text/javascript"
    assert types[".wasm"] == "application/wasm"


# --------------------------------------------------------------------------- #
# Relais d'horodatage RFC 3161 (/__tsa__)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "ftp://tsa.example/", "http://127.0.0.1:3000/", "http://10.0.0.8/tsr", "not a url"],
)
def test_tsa_relay_refuses_non_public_targets(url):
    assert elium_launcher._tsa_target_problem(url) is not None


def test_tsa_relay_accepts_a_public_https_server(monkeypatch):
    monkeypatch.setattr(
        elium_launcher.socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))],
    )
    assert elium_launcher._tsa_target_problem("https://freetsa.org/tsr") is None


def test_tsa_relay_refuses_a_name_resolving_to_a_private_address(monkeypatch):
    monkeypatch.setattr(
        elium_launcher.socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("192.168.1.10", 443))],
    )
    assert elium_launcher._tsa_target_problem("https://tsa.intranet/") is not None


@pytest.mark.parametrize(
    "ip",
    [
        "100.64.0.1",  # CGNAT
        "198.18.0.1",  # benchmark
        "192.0.0.1",
        "224.0.0.1",
        "0.0.0.0",  # noqa: S104 (adresse testée, pas un bind)
        "fec0::1",  # site local
        "fe80::1%eth0",
        "fd00::1",
        "ff0e::1",  # multicast (même de portée globale)
        "::1",
        "::",
        "::7f00:1",  # IPv4-compatible
        "::ffff:127.0.0.1",
        "::ffff:a9fe:a9fe",  # IPv4-mapped 169.254.169.254
        "2002:7f00:1::1",  # 6to4 -> 127.0.0.1
        "64:ff9b::a00:1",  # NAT64 -> 10.0.0.1
        "2001:0:4136:e378::1",  # Teredo
        "2001:db8::1",
        "pas une ip",
    ],
)
def test_tsa_refuses_every_non_global_address(ip):
    assert elium_launcher._tsa_is_non_public(ip) is True


@pytest.mark.parametrize("ip", ["93.184.216.34", "2606:4700::1111", "::ffff:93.184.216.34", "64:ff9b::5db8:d822"])
def test_tsa_accepts_global_addresses(ip):
    assert elium_launcher._tsa_is_non_public(ip) is False


@pytest.mark.parametrize(
    "url", ["http://[fec0::1]/", "http://100.64.0.1/", "http://[::ffff:127.0.0.1]/", "http://u:p@93.184.216.34/"]
)
def test_tsa_relay_refuses_more_non_public_targets(url):
    assert elium_launcher._tsa_target_problem(url) is not None


@pytest.mark.parametrize("url", ["http://tsa.example:99999/", "http://tsa.example:abc/", "http://[::1/"])
def test_tsa_relay_invalid_url_is_a_problem_not_an_exception(url):
    assert elium_launcher._tsa_target_problem(url) is not None


def _local_http_server(handle):
    """Petit serveur HTTP loopback (stand-in d'un TSA ou d'un service interne)."""
    import http.server
    import threading

    class _H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_a):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            handle(self)

        do_GET = do_POST

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def _reply(h, code, body=b"", headers=()):
    h.send_response(code)
    for k, v in headers:
        h.send_header(k, v)
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def test_tsa_relay_does_not_follow_redirects(monkeypatch):
    hits = []
    internal, internal_port = _local_http_server(lambda h: (hits.append(h.path), _reply(h, 200, b"INTERNAL")))
    redirect, redirect_port = _local_http_server(
        lambda h: _reply(h, 302, headers=[("Location", f"http://127.0.0.1:{internal_port}/admin")])
    )
    # Le stand-in écoute sur loopback : on ne relâche la politique d'adresse que pour lui.
    monkeypatch.setattr(elium_launcher, "_tsa_is_non_public", lambda ip: ip != "127.0.0.1")
    try:
        with pytest.raises(ValueError, match="302"):
            elium_launcher._tsa_forward(f"http://127.0.0.1:{redirect_port}/tsr", b"\x30\x00")
        assert hits == []
    finally:
        internal.shutdown()
        redirect.shutdown()


def test_tsa_relay_connects_to_the_checked_address_without_resolving_again(monkeypatch):
    """Rebinding DNS : le nom n'est résolu qu'une fois, la connexion va à l'ip vérifiée
    avec l'en-tête Host d'origine."""
    seen = {}

    def tsa(h):
        seen["host"] = h.headers.get("Host")
        seen["path"] = h.path
        _reply(h, 200, b"\x30\x00")

    server, port = _local_http_server(tsa)
    calls = []

    real_getaddrinfo = socket.getaddrinfo

    def fake_getaddrinfo(host, p, *a, **k):
        calls.append(host)
        if host != "rebind.test":  # l'ip littérale passée à create_connection
            return real_getaddrinfo(host, p, *a, **k)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", p))]

    monkeypatch.setattr(elium_launcher.socket, "getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr(elium_launcher, "_tsa_is_non_public", lambda ip: ip != "127.0.0.1")
    try:
        problem, target = elium_launcher._tsa_resolve(f"http://rebind.test:{port}/tsr?x=1")
        assert problem is None and target is not None
        assert target[4] == "127.0.0.1"
        assert elium_launcher._tsa_send(target, b"\x30\x00") == b"\x30\x00"
        # Aucune seconde résolution DU NOM : seule l'ip vérifiée est passée au socket.
        assert calls.count("rebind.test") == 1
        assert set(calls) <= {"rebind.test", "127.0.0.1"}
        assert seen == {"host": f"rebind.test:{port}", "path": "/tsr?x=1"}
    finally:
        server.shutdown()


def test_tsa_relay_rebinding_to_loopback_is_refused(monkeypatch):
    answers = iter(["93.184.216.34", "127.0.0.1"])
    monkeypatch.setattr(
        elium_launcher.socket,
        "getaddrinfo",
        lambda host, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (next(answers), p))],
    )
    problem, target = elium_launcher._tsa_resolve("http://rebind.test/tsr")
    assert problem is None and target[4] == "93.184.216.34"
    # Même si le nom « rebinde » ensuite, _tsa_send ne résout pas : il vise 93.184.216.34.
    connected = []

    def fake_connect(addr, timeout=None):
        connected.append(addr)
        raise OSError("pas de réseau dans les tests")

    monkeypatch.setattr(elium_launcher.socket, "create_connection", fake_connect)
    with pytest.raises(OSError):
        elium_launcher._tsa_send(target, b"\x30\x00")
    assert connected == [("93.184.216.34", 80)]
    # Et une cible loopback est refusée avant toute connexion.
    with pytest.raises(ValueError):
        elium_launcher._tsa_send(("http", "x", 80, "/", "127.0.0.1"), b"\x30\x00")
    assert connected == [("93.184.216.34", 80)]


def test_tsa_relay_bounds_the_reply(monkeypatch):
    server, port = _local_http_server(lambda h: _reply(h, 200, b"\x30" * (200 * 1024)))
    monkeypatch.setattr(elium_launcher, "_tsa_is_non_public", lambda ip: ip != "127.0.0.1")
    try:
        with pytest.raises(ValueError, match="volumineuse"):
            elium_launcher._tsa_forward(f"http://127.0.0.1:{port}/", b"\x30\x00")
    finally:
        server.shutdown()


def test_tsa_relay_body_read_times_out_on_a_short_body(monkeypatch):
    """Content-Length > corps réel : le thread du handler ne doit pas rester bloqué."""
    import time

    monkeypatch.setattr(
        elium_launcher.socket,
        "getaddrinfo",
        lambda host, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", p))],
    )
    monkeypatch.setattr(elium_launcher, "_TSA_TIMEOUT_S", 0.3)
    sent = []
    monkeypatch.setattr(elium_launcher, "_tsa_send", lambda *a: sent.append(a) or b"")
    server_end, client_end = socket.socketpair()
    try:
        client_end.sendall(b"\x30\x03\x02")  # 3 octets sur les 100 annoncés

        class _Relay:
            headers = {"X-Elium-TSA-Url": "https://tsa.example/tsr", "Content-Length": "100"}
            connection = server_end
            rfile = server_end.makefile("rb")
            close_connection = False

            def send_error(self, code, _message=""):
                self.error_code = code

        relay = _Relay()
        start = time.monotonic()
        elium_launcher.QuietHandler._handle_tsa_relay(relay)
        assert time.monotonic() - start < 5
        assert relay.error_code == 400
        assert sent == []
    finally:
        server_end.close()
        client_end.close()
