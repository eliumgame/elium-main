"""
Tests du test de fumée (installer/smoke_test.py) : détecteurs purs (URLs externes, CSP) et un
passage de bout en bout sur le VRAI lanceur (processus Python, dossier web factice) — la même
logique que le CI applique ensuite à Elium.exe.
"""
from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest

_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import elium_launcher  # noqa: E402
import smoke_test  # noqa: E402


@pytest.mark.parametrize(
    "html",
    [
        '<script src="https://cdn.example.com/x.js"></script>',
        '<link rel="stylesheet" href="//fonts.googleapis.com/css?family=Inter">',
        "<img src='http://tracker.example/p.gif'>",
        '<iframe src="https://evil.example/"></iframe>',
        '<style>@import url("https://fonts.example/a.css");</style>',
        '<div style="background:url(https://x.example/a.png)"></div>',
        '<img srcset="/a.png 1x, https://cdn.example/b.png 2x">',
    ],
)
def test_external_urls_are_detected(html):
    assert smoke_test.find_external_urls(html), html


@pytest.mark.parametrize(
    "html",
    [
        '<script type="module" src="/assets/index-abc.js"></script>',
        '<link rel="stylesheet" href="./assets/a.css">',
        '<img src="data:image/png;base64,AAAA">',
        '<a href="#section">x</a>',
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        '<link rel="manifest" href="/manifest.webmanifest">',
        '<script src="http://127.0.0.1:3000/x.js"></script>',
    ],
)
def test_local_references_are_not_flagged(html):
    assert smoke_test.find_external_urls(html) == [], html


def test_the_launchers_own_csp_passes_the_smoke_checks():
    assert smoke_test.csp_problems(elium_launcher.CONTENT_SECURITY_POLICY) == []


@pytest.mark.parametrize(
    "csp",
    [
        None,
        "default-src *",
        "default-src 'self'; script-src 'self' 'unsafe-eval'; object-src 'none'",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'",
        "default-src 'self'; script-src 'self' https://cdn.example.com; object-src 'none'",
        "default-src 'self'; connect-src 'self' https://api.example.com; object-src 'none'",
        "default-src 'self'; script-src 'self'",  # object-src manquant
    ],
)
def test_weak_csp_is_reported(csp):
    assert smoke_test.csp_problems(csp)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _web_dir(tmp_path: Path, index: str) -> Path:
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text(index, encoding="utf-8")
    return web


def test_smoke_passes_on_the_real_launcher(tmp_path):
    web = _web_dir(tmp_path, "<!doctype html><html><body><p>Elium</p></body></html>")
    launcher = _INSTALLER / "elium_launcher.py"
    problems = smoke_test.run_smoke(
        [sys.executable, str(launcher)], "9.8.7", port=_free_port(), timeout=60,
        extra_env={"ELIUM_WEB_DIR": str(web), "ELIUM_CURRENT_VERSION": "9.8.7",
                   "PYTHONPATH": str(_INSTALLER.parent / "src")},
    )
    assert problems == []


def test_smoke_reports_wrong_version_and_external_url(tmp_path):
    web = _web_dir(tmp_path, '<!doctype html><html><body><script src="https://cdn.example/x.js"></script></body></html>')
    launcher = _INSTALLER / "elium_launcher.py"
    problems = smoke_test.run_smoke(
        [sys.executable, str(launcher)], "1.0.0", port=_free_port(), timeout=60,
        extra_env={"ELIUM_WEB_DIR": str(web), "ELIUM_CURRENT_VERSION": "9.8.7",
                   "PYTHONPATH": str(_INSTALLER.parent / "src")},
    )
    joined = " | ".join(problems)
    assert "version annoncée" in joined and "URLs externes" in joined


def test_smoke_reports_a_process_that_dies_at_startup(tmp_path):
    problems = smoke_test.run_smoke([sys.executable, "-c", "import sys; sys.exit(3)"], "1.0.0",
                                    port=_free_port(), timeout=20)
    assert problems and "s'est arrêté" in problems[0]
