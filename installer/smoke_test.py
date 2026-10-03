"""
Test de fumée de l'application construite (Elium.exe) — lancé par le CI AVANT toute publication.

Un `pytest` vert prouve le code Python, pas l'exécutable gelé : un exe PyInstaller peut
démarrer en dev et planter une fois gelé (module oublié, ressource non embarquée, CSP qui
bloque WebAssembly...). Ce script lance le VRAI binaire en mode serveur seul
(`ELIUM_NO_BROWSER=1`, aucune fenêtre, aucune mise à jour, profil isolé) puis vérifie :

  1. `/__version__` répond et annonce la version attendue (le stamp du build est bon) ;
  2. la page d'accueil est servie (200, HTML) avec la CSP stricte attendue
     (default-src 'self', script-src sans unsafe-inline/unsafe-eval, aucune origine réseau)
     et `X-Content-Type-Options: nosniff` ;
  3. cette page ET ses feuilles de style locales ne référencent AUCUNE URL externe
     (l'application doit rester 100 % hors ligne) ;
  4. le contrôle Host anti DNS-rebinding refuse un Host étranger sur les routes /__* ;
  5. les scripts de la carte de mise à jour sont servis.

Usage :
    python installer/smoke_test.py installer/staging/Elium.exe --version 4.9.1
Sortie : 0 si tout est conforme, 1 sinon (les écarts sont listés).
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SMOKE_PORT = 3999

# Attributs pouvant déclencher un chargement réseau.
_ATTR_RE = re.compile(r"""\b(?:src|href|action|poster|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.I)
_CSS_URL_RE = re.compile(r"""url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)""", re.I)
_CSS_IMPORT_RE = re.compile(r"""@import\s+(?:url\()?\s*["']?([^"')\s;]+)""", re.I)

# Valeurs qui ne sortent jamais vers le réseau.
_LOCAL_PREFIXES = ("/", "./", "../", "#", "data:", "blob:", "about:", "mailto:", "javascript:")
# Espaces de noms XML (balises <svg xmlns="…">) : des identifiants, jamais des requêtes.
_NAMESPACE_HOSTS = ("www.w3.org",)


def _is_external(url: str) -> bool:
    u = url.strip()
    if not u or u.startswith(_LOCAL_PREFIXES) and not u.startswith("//"):
        return False
    if u.startswith("//") or re.match(r"^[a-z][a-z0-9+.-]*://", u, re.I):
        host = re.sub(r"^[a-z][a-z0-9+.-]*:", "", u, flags=re.I).lstrip("/").split("/", 1)[0].split(":", 1)[0].lower()
        if host in ("127.0.0.1", "localhost"):
            return False
        return host not in _NAMESPACE_HOSTS
    return False


def find_external_urls(text: str) -> list[str]:
    """URLs externes référencées par un document HTML ou une feuille de style (chargements réseau)."""
    found: list[str] = []
    for m in _ATTR_RE.finditer(text):
        val = next(g for g in m.groups() if g is not None)
        if "srcset" in m.group(0).lower():
            candidates = [c.strip().split(" ")[0] for c in val.split(",")]
        else:
            candidates = [val]
        found += [c for c in candidates if _is_external(c)]
    for m in _CSS_URL_RE.finditer(text):
        val = next((g for g in m.groups() if g is not None), "")
        if _is_external(val):
            found.append(val)
    for m in _CSS_IMPORT_RE.finditer(text):
        if _is_external(m.group(1)):
            found.append(m.group(1))
    return sorted(set(found))


def csp_problems(csp: str | None) -> list[str]:
    """Écarts d'une politique de sécurité du contenu par rapport à la politique attendue."""
    if not csp:
        return ["en-tête Content-Security-Policy absent"]
    directives: dict[str, list[str]] = {}
    for part in csp.split(";"):
        tokens = part.split()
        if tokens:
            directives[tokens[0]] = tokens[1:]
    problems: list[str] = []
    if directives.get("default-src") != ["'self'"]:
        problems.append(f"default-src devrait valoir 'self' (reçu : {directives.get('default-src')})")
    script = directives.get("script-src", [])
    for bad in ("'unsafe-inline'", "'unsafe-eval'", "*", "data:"):
        if bad in script:
            problems.append(f"script-src contient {bad}")
    if any(not t.startswith("'") for t in script):  # tout jeton non entre apostrophes = une origine/schéma
        problems.append(f"script-src autorise autre chose que 'self' / 'wasm-unsafe-eval' ({script})")
    if directives.get("object-src") != ["'none'"]:
        problems.append("object-src devrait valoir 'none'")
    for name, tokens in directives.items():
        if any(t.startswith(("http:", "https:")) or t == "*" for t in tokens):
            problems.append(f"{name} autorise une origine réseau ({tokens})")
    return problems


def _http(port: int, path: str, host: str | None = None, timeout: float = 5.0):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.putrequest("GET", path, skip_host=True)
        conn.putheader("Host", host or f"127.0.0.1:{port}")
        conn.endheaders()
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


def _wait_for_server(port: int, proc: subprocess.Popen, timeout: float) -> str | None:
    """Attend que /__version__ réponde. Renvoie None si OK, sinon la raison."""
    deadline = time.monotonic() + timeout
    last = "aucune réponse"
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return f"le processus s'est arrêté (code {proc.returncode}) avant de répondre"
        try:
            status, _, _ = _http(port, "/__version__", timeout=2)
            if status == 200:
                return None
            last = f"HTTP {status}"
        except OSError as exc:
            last = str(exc)
        time.sleep(0.5)
    return f"/__version__ n'a pas répondu dans les {timeout:.0f} s ({last})"


def run_smoke(cmd: list[str], expected_version: str, port: int = SMOKE_PORT, timeout: float = 90.0,
              extra_env: dict[str, str] | None = None) -> list[str]:
    """Lance `cmd` en mode serveur seul et renvoie la liste des écarts (vide = conforme)."""
    problems: list[str] = []
    with tempfile.TemporaryDirectory(prefix="elium-smoke-") as tmp:
        appdata = Path(tmp) / "appdata"
        (appdata / "Elium").mkdir(parents=True)
        # Port fixe : on ne dépend pas du balayage 3000-3100 (ports parfois occupés sur un runner).
        (appdata / "Elium" / "launcher-config.json").write_text(json.dumps({"port": port}), encoding="utf-8")
        env = dict(os.environ)
        env.update({
            "ELIUM_NO_BROWSER": "1", "ELIUM_NO_UPDATE": "1", "ELIUM_NO_HANDOFF": "1",
            "LOCALAPPDATA": str(appdata), "LocalAppData": str(appdata),
        })
        env.update(extra_env or {})
        proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603
        try:
            reason = _wait_for_server(port, proc, timeout)
            if reason:
                return [reason]

            status, _, body = _http(port, "/__version__")
            info = json.loads(body or b"{}")
            if info.get("installed") != expected_version:
                problems.append(f"version annoncée {info.get('installed')!r} != attendue {expected_version!r}")

            status, headers, html = _http(port, "/")
            if status != 200:
                problems.append(f"page d'accueil : HTTP {status}")
            elif b"<html" not in html.lower() and b"<!doctype" not in html.lower():
                problems.append("page d'accueil : pas de HTML")
            problems += [f"CSP : {p}" for p in csp_problems(headers.get("content-security-policy"))]
            if headers.get("x-content-type-options", "").lower() != "nosniff":
                problems.append("X-Content-Type-Options: nosniff absent")

            text = html.decode("utf-8", "replace")
            external = find_external_urls(text)
            # Feuilles de style locales liées par la page : mêmes exigences.
            for href in re.findall(r"""<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["']""", text, re.I):
                if href.startswith("/"):
                    s, _, css = _http(port, href)
                    if s == 200:
                        external += find_external_urls(css.decode("utf-8", "replace"))
            if external:
                problems.append(f"URLs externes référencées (l'app doit rester hors ligne) : {sorted(set(external))}")

            status, _, _ = _http(port, "/__version__", host="evil.example")
            if status != 403:
                problems.append(f"Host étranger accepté sur /__version__ (HTTP {status}, attendu 403)")
            status, _, _ = _http(port, "/__elium_update.js")
            if status != 200:
                problems.append(f"/__elium_update.js : HTTP {status}")
        except Exception as exc:  # noqa: BLE001 - tout écart est rapporté, jamais masqué
            problems.append(f"erreur pendant le test de fumée : {exc!r}")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Test de fumée d'Elium.exe (serveur seul).")
    parser.add_argument("exe", help="chemin de l'exécutable construit")
    parser.add_argument("--version", required=True, help="version attendue (X.Y.Z[-pre])")
    parser.add_argument("--port", type=int, default=SMOKE_PORT)
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args()

    exe = Path(args.exe)
    if not exe.is_file():
        print(f"[FAIL] exécutable introuvable : {exe}", file=sys.stderr)
        return 1
    problems = run_smoke([str(exe)], args.version.lstrip("vV"), args.port, args.timeout)
    if problems:
        for p in problems:
            print(f"[FAIL] {p}", file=sys.stderr)
        return 1
    print(f"[ok]   {exe.name} : version {args.version}, CSP stricte, aucune URL externe, Host vérifié")
    return 0


if __name__ == "__main__":
    sys.exit(main())
