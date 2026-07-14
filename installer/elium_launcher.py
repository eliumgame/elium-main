"""
Elium Launcher — Point d'entrée principal de l'application installée.

Lance un serveur HTTP local servant le Web Studio pré-buildé, puis ouvre une
fenêtre application dédiée (Edge/Chrome en mode --app : pas de barre d'adresse,
pas d'onglets, profil séparé du navigateur personnel). À la fermeture de la
fenêtre, le serveur s'arrête proprement. Si aucun navigateur compatible n'est
trouvé, repli sur un onglet du navigateur par défaut.

Usage : Elium.exe [fichier.elium]
        Le fichier passé en argument (association Windows) est ouvert au
        démarrage via l'endpoint local /__open__.
"""

import http.server
import os
import socket
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from functools import partial
from pathlib import Path


def find_free_port(start: int = 3000, end: int = 3100) -> int:
    """Trouve un port libre dans la plage donnée."""
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"Aucun port libre trouvé entre {start} et {end}")


def get_web_dir() -> Path:
    """Retourne le chemin du dossier web-studio buildé."""
    # 1) Bundle PyInstaller onefile/onedir : le Web Studio est embarqué sous _MEIPASS/web
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        bundled = Path(meipass) / "web"
        if bundled.exists():
            return bundled

    # 2) Installé : le dossier web est à côté de l'exécutable
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).parent
    else:
        base = Path(__file__).resolve().parent.parent

    web_dir = base / "web"
    if not web_dir.exists():
        # 3) Dév : web-studio/dist
        web_dir = base / "web-studio" / "dist"
    if not web_dir.exists():
        print(f"ERREUR: Dossier web introuvable: {web_dir}")
        sys.exit(1)
    return web_dir


def find_app_browser() -> str | None:
    """Cherche un navigateur Chromium capable du mode --app (fenêtre dédiée)."""
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    local = os.environ.get("LocalAppData", "")
    candidates = [
        Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe" if local else None,
    ]
    for c in candidates:
        if c and c.is_file():
            return str(c)
    return None


def app_profile_dir() -> Path:
    """Profil navigateur dédié à Elium : n'altère pas le navigateur personnel."""
    base = Path(os.environ.get("LocalAppData") or Path.home()) / "Elium" / "WebProfile"
    base.mkdir(parents=True, exist_ok=True)
    return base


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serveur HTTP silencieux pour le Web Studio (+ fichier ouvert via Explorer)."""

    # (nom de fichier, contenu) du .elium passé en argument, servi sur /__open__.
    opened_file: "tuple[str, bytes] | None" = None

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format, *args):
        """Supprime les logs HTTP pour un fonctionnement silencieux."""
        pass

    def end_headers(self):
        # Headers de sécurité
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "style-src 'self' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com",
        )
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        clean = self.path.split("?", 1)[0]
        if clean == "/__open__":
            self._serve_opened_file()
            return
        # SPA fallback : sert index.html pour les routes non-fichier.
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.splitext(clean)[1]:
            self.path = "/index.html"
        super().do_GET()

    def _serve_opened_file(self):
        item = QuietHandler.opened_file
        if not item:
            self.send_error(404, "Aucun fichier en attente")
            return
        name, data = item
        self.send_response(200)
        self.send_header("Content-Type", "application/x-elium")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Elium-Name", urllib.parse.quote(name))
        self.end_headers()
        self.wfile.write(data)


def main():
    # En mode fenêtré (PyInstaller --noconsole), stdout/stderr valent None.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    web_dir = get_web_dir()
    port = find_free_port()
    url = f"http://127.0.0.1:{port}/"

    # Fichier .elium passé en argument (double-clic dans l'Explorateur).
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        opened = Path(sys.argv[1])
        QuietHandler.opened_file = (opened.name, opened.read_bytes())
        url += "?open=1"

    handler = partial(QuietHandler, directory=str(web_dir))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"Elium Web Studio démarré sur {url}")

    # ELIUM_NO_BROWSER=1 : mode serveur seul (tests, CI, usage avancé).
    headless = os.environ.get("ELIUM_NO_BROWSER") == "1"

    browser = None if headless else find_app_browser()
    if browser:
        # Fenêtre application dédiée ; le profil séparé garantit un processus
        # propre dont la fin signale la fermeture de la fenêtre.
        # S603 : le chemin vient d'une liste fixe de navigateurs connus.
        proc = subprocess.Popen([  # noqa: S603
            browser,
            f"--app={url}",
            f"--user-data-dir={app_profile_dir()}",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        try:
            proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
        server.shutdown()
        return

    # Repli : onglet du navigateur par défaut ; l'utilisateur arrête avec Ctrl+C.
    print("Appuyez sur Ctrl+C pour arrêter.\n")
    if not headless:
        webbrowser.open(url)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nArrêt du serveur Elium...")
        server.shutdown()


if __name__ == "__main__":
    main()
