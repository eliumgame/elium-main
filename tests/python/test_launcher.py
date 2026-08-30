"""
Tests du lanceur desktop (installer/elium_launcher.py) — en particulier la
protection anti-CSRF des routes d'état (/__update__/start, /__update__/restart,
/__rollback__/undo, /__rollback__) : sans elle, n'importe quelle page web ouverte
pendant qu'Elium tourne pourrait forcer un rollback/redémarrage via un simple
fetch() sur le port loopback prévisible (3000-3100).
"""
from __future__ import annotations

import sys
from pathlib import Path

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
