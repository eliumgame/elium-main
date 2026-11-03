"""Régressions : l'overlay modifié après vérification ne doit plus être servi."""
import functools
import http.client
import http.server
import threading

import elium_launcher
import pytest
import updater


@pytest.fixture
def overlay(signed_updates):
    root = updater._web_root() / "4.1.0"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_bytes(b"<html>trusted</html>")
    (root / "assets/app.js").write_bytes(b"trusted()")
    manifest = signed_updates({
        "version": "4.1.0", "codeHash": updater.BUILD_CODE_HASH,
        "artifacts": {"web": {"treeHash": updater.tree_hash_dir(root)}},
    })
    assert updater._store_signed_manifest(manifest, root)
    updater._set_pointer("4.1.0")
    assert updater.active_web_dir() == str(root)
    return root


def test_modified_asset_invalidates_cached_overlay(overlay):
    (overlay / "assets/app.js").write_bytes(b"modified_after_verification()")
    assert updater.active_web_dir() is None
    assert not updater.serving_web_dir_is_valid(overlay)


def test_modified_signature_invalidates_cached_overlay(overlay):
    _, signature = updater._sidecar_paths(overlay)
    signature.write_text("00", encoding="ascii")
    assert updater.active_web_dir() is None


def test_pinned_overlay_rejects_modified_asset_over_http(overlay, monkeypatch):
    monkeypatch.setattr(elium_launcher, "_serving_dir", overlay)
    handler = functools.partial(elium_launcher.QuietHandler, directory=str(overlay))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def request():
            conn = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                conn.request("GET", "/assets/app.js")
                response = conn.getresponse()
                return response.status, response.read()
            finally:
                conn.close()

        assert request() == (200, b"trusted()")
        (overlay / "assets/app.js").write_bytes(b"untrusted_after_first_request()")
        status, body = request()
        assert status == 503
        assert b"untrusted_after_first_request" not in body
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
