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
import json
import os
import socket
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from functools import partial
from pathlib import Path

# Module d'auto-update (embarqué à côté du lanceur, cf. installer/elium.spec).
# Import tolérant : si absent/cassé, l'app tourne normalement, sans màj.
try:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import updater  # type: ignore
except Exception:  # pragma: no cover - défensif
    updater = None  # type: ignore


# Carte de mise à jour : une seule carte discrète, un seul bouton, une barre animée.
# Servie en fichiers EXTERNES (/__elium_update.css + .js) pour respecter la CSP stricte
# (style-src 'self' + script-src 'self') — pas de styles/scripts inline.
UPDATE_CSS = """
#elium-upd {
  position: fixed; right: 24px; bottom: 24px;
  z-index: var(--el-z-toast, 2147483000);
  width: 366px; max-width: calc(100vw - 40px);
  background: var(--el-surface, #ffffff);
  color: var(--el-text, #0f172a);
  border: 1px solid var(--el-border, #e2e8f0);
  border-radius: var(--el-radius-xl, 16px);
  box-shadow: var(--el-elev-5, 0 20px 48px rgba(15,23,42,.18));
  font-family: var(--el-font, "Inter", system-ui, "Segoe UI", Roboto, sans-serif);
  padding: 18px 18px 16px; display: none; overflow: hidden;
}
#elium-upd.show { display: block; animation: elium-upd-in .3s var(--el-ease-spring, cubic-bezier(.34,1.56,.64,1)); }
#elium-upd::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: linear-gradient(90deg, var(--el-blue-400, #60a5fa), var(--el-blue-700, #1d4ed8));
}
#elium-upd.ready::before { background: linear-gradient(90deg, var(--el-green-400, #4ade80), var(--el-green-600, #16a34a)); }
#elium-upd.err::before { background: linear-gradient(90deg, var(--el-amber-500, #f59e0b), var(--el-red-600, #dc2626)); }
.elium-upd-head { display: flex; align-items: center; gap: 12px; }
.elium-upd-badge {
  width: 42px; height: 42px; flex: none; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; font-size: 21px;
  background: var(--el-primary-50, #eff6ff); color: var(--el-primary, #1d4ed8);
}
#elium-upd.ready .elium-upd-badge { background: var(--el-seal-bg, #f0fdf4); color: var(--el-seal, #16a34a); }
#elium-upd.err .elium-upd-badge { background: var(--el-warning-bg, #fffbeb); color: var(--el-warning, #b45309); }
.elium-upd-txt { flex: 1; min-width: 0; }
.elium-upd-title { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
.elium-upd-sub { color: var(--el-text-soft, #475569); font-size: 12.5px; margin-top: 3px; line-height: 1.4; }
.elium-upd-track {
  height: 8px; border-radius: 999px; overflow: hidden; margin-top: 16px;
  background: var(--el-surface-3, #f1f5f9);
}
.elium-upd-bar {
  height: 100%; width: 0%; border-radius: 999px;
  background: linear-gradient(90deg, var(--el-blue-400, #60a5fa), var(--el-blue-700, #1d4ed8));
  transition: width .3s ease;
}
.elium-upd-bar.indet { width: 35%; animation: elium-upd-slide 1.1s ease-in-out infinite; }
@keyframes elium-upd-slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
.elium-upd-btn {
  margin-top: 16px; width: 100%; border: 0; cursor: pointer;
  background: var(--el-primary-btn, #1d4ed8); color: var(--el-primary-contrast, #fff);
  border-radius: var(--el-radius-md, 8px); padding: 11px 14px;
  font-weight: 700; font-size: 14px; font-family: inherit;
  box-shadow: var(--el-elev-1, 0 1px 2px rgba(15,23,42,.06));
  transition: background .14s ease, transform .14s ease;
}
.elium-upd-btn:hover { background: var(--el-primary-hover, #1e40af); }
.elium-upd-btn:active { transform: translateY(1px); }
.elium-upd-btn:disabled { opacity: .6; cursor: default; }
#elium-upd.ready .elium-upd-btn { background: var(--el-seal, #16a34a); }
.elium-upd-later {
  margin-top: 8px; width: 100%; background: none; border: 0;
  color: var(--el-text-muted, #586675); font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.elium-upd-later:hover { color: var(--el-text-soft, #475569); text-decoration: underline; }
.elium-upd-spin {
  width: 22px; height: 22px; flex: none;
  border: 2.5px solid var(--el-surface-3, #f1f5f9);
  border-top-color: var(--el-primary, #1d4ed8); border-radius: 50%;
  animation: elium-upd-rot .7s linear infinite;
}
@keyframes elium-upd-rot { to { transform: rotate(360deg); } }
@keyframes elium-upd-in { from { opacity: 0; transform: translateY(16px) scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  #elium-upd.show { animation: none; }
  .elium-upd-bar, .elium-upd-bar.indet { animation: none; transition: none; }
  .elium-upd-spin { animation-duration: 2s; }
}
"""

UPDATE_JS = """
(function () {
  var card, badge, spin, title, sub, track, bar, btn, later, dismissed = false;
  function build() {
    card = document.createElement('div'); card.id = 'elium-upd';
    var head = document.createElement('div'); head.className = 'elium-upd-head';
    spin = document.createElement('div'); spin.className = 'elium-upd-spin'; spin.style.display = 'none';
    badge = document.createElement('div'); badge.className = 'elium-upd-badge'; badge.textContent = '\\u{1F504}';
    var txt = document.createElement('div'); txt.className = 'elium-upd-txt';
    title = document.createElement('div'); title.className = 'elium-upd-title';
    sub = document.createElement('div'); sub.className = 'elium-upd-sub';
    txt.appendChild(title); txt.appendChild(sub);
    head.appendChild(spin); head.appendChild(badge); head.appendChild(txt);
    track = document.createElement('div'); track.className = 'elium-upd-track'; track.style.display = 'none';
    bar = document.createElement('div'); bar.className = 'elium-upd-bar'; track.appendChild(bar);
    btn = document.createElement('button'); btn.className = 'elium-upd-btn'; btn.style.display = 'none';
    later = document.createElement('button'); later.className = 'elium-upd-later';
    later.textContent = 'Plus tard'; later.style.display = 'none';
    later.onclick = function () { dismissed = true; card.classList.remove('show'); };
    card.appendChild(head); card.appendChild(track); card.appendChild(btn); card.appendChild(later);
    document.body.appendChild(card);
  }
  function post(path) {
    return fetch(path, { method: 'POST' }).then(function (r) { return r.json(); }).catch(function () {});
  }
  function set(icon, t, s) { badge.textContent = icon; title.textContent = t; sub.textContent = s; }
  function render(st) {
    if (!card) { if (!document.body) return; build(); }
    var s = st.state;
    var showBtn = false, showTrack = false, showSpin = false, showLater = false;
    card.classList.remove('ready', 'err');
    if (s === 'available') {
      if (dismissed) { card.classList.remove('show'); return; }
      badge.style.display = ''; set('\\u{1F504}', 'Mise a jour disponible',
        'Version ' + (st.version || '') + ' \\u2014 installez-la en un clic');
      btn.textContent = 'Mettre a jour'; btn.disabled = false; showBtn = true; showLater = true;
      btn.onclick = function () { btn.disabled = true; post('/__update__/start'); };
    } else if (s === 'downloading') {
      badge.style.display = 'none'; showSpin = true; showTrack = true;
      var p = st.progress || 0;
      set('', 'Telechargement de la mise a jour...', p > 0 ? (p + ' %') : 'Preparation...');
      if (p > 0) { bar.classList.remove('indet'); bar.style.width = p + '%'; }
      else { bar.classList.add('indet'); }
    } else if (s === 'web-ready') {
      card.classList.add('ready'); badge.style.display = '';
      set('\\u2705', 'Mise a jour prete !', 'Rechargez pour utiliser la version ' + (st.version || ''));
      btn.textContent = 'Recharger maintenant'; btn.disabled = false; showBtn = true;
      btn.onclick = function () { location.reload(); };
    } else if (s === 'exe-ready') {
      card.classList.add('ready'); badge.style.display = '';
      set('\\u2705', 'Mise a jour prete !', 'Redemarrez Elium pour terminer');
      btn.textContent = 'Redemarrer Elium'; btn.disabled = false; showBtn = true;
      btn.onclick = function () { btn.disabled = true; set('\\u2705', 'Redemarrage...', ''); post('/__update__/restart'); };
    } else if (s === 'error') {
      card.classList.add('err'); badge.style.display = '';
      set('\\u26A0\\uFE0F', 'Echec de la mise a jour', 'Verifiez votre connexion, puis reessayez');
      btn.textContent = 'Reessayer'; btn.disabled = false; showBtn = true; showLater = true;
      btn.onclick = function () { btn.disabled = true; post('/__update__/start'); };
    }
    var visible = (s === 'available' || s === 'downloading' || s === 'web-ready' ||
                   s === 'exe-ready' || s === 'error');
    card.classList.toggle('show', visible);
    btn.style.display = showBtn ? '' : 'none';
    later.style.display = showLater ? '' : 'none';
    track.style.display = showTrack ? '' : 'none';
    spin.style.display = showSpin ? '' : 'none';
  }
  function poll() {
    fetch('/__update__').then(function (r) { return r.json(); }).then(render).catch(function () {});
  }
  setTimeout(poll, 1500);
  setInterval(poll, 2000);
})();
"""


def current_web_dir() -> Path:
    """Dossier web à servir : overlay auto-update s'il est plus récent, sinon embarqué."""
    if updater is not None:
        try:
            overlay = updater.active_web_dir()
            if overlay:
                return Path(overlay)
        except Exception:
            pass
    return get_web_dir()


# Dossier web « épinglé » pour la session en cours : ne change qu'à une navigation
# (chargement d'index.html), pour ne pas mélanger anciens/nouveaux assets Vite.
_serving_dir: "Path | None" = None
_serving_lock = threading.Lock()


def _resolve_serving_dir(refresh: bool) -> Path:
    global _serving_dir
    with _serving_lock:
        if refresh or _serving_dir is None:
            _serving_dir = current_web_dir()
        return _serving_dir


# Redémarrage propre pour appliquer une màj exe : on ferme la fenêtre courante puis
# main() relance le nouvel exe. Ces globals relient le handler HTTP à la boucle main().
_browser_proc: "subprocess.Popen | None" = None
_fallback_event: "threading.Event | None" = None
_restart_requested = False


def _request_restart() -> bool:
    """Demande le redémarrage vers le lanceur mis à jour (bouton « Redémarrer »)."""
    global _restart_requested
    if updater is None:
        return False
    _restart_requested = True
    if _browser_proc is not None:
        try:
            _browser_proc.terminate()  # débloque proc.wait() dans main()
        except Exception:
            pass
    elif _fallback_event is not None:
        _fallback_event.set()
    return True


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
        if clean == "/__update__":
            self._serve_update_status()
            return
        if clean == "/__elium_update.js":
            self._serve_bytes(UPDATE_JS.encode("utf-8"), "application/javascript; charset=utf-8")
            return
        if clean == "/__elium_update.css":
            self._serve_bytes(UPDATE_CSS.encode("utf-8"), "text/css; charset=utf-8")
            return

        # Résout le dossier web à servir. Sur une navigation (index / route SPA), on
        # (re)fixe le dossier courant — un simple reload applique ainsi une màj web
        # sans mélanger d'anciens et de nouveaux assets (fichiers hashés par Vite).
        is_navigation = clean in ("/", "/index.html") or not os.path.splitext(clean)[1]
        self.directory = str(_resolve_serving_dir(refresh=is_navigation))

        # (Re)chargement de page -> ré-évalue l'état de màj (évite la carte « Recharger »
        # qui revient en boucle une fois la màj web appliquée).
        if is_navigation and updater is not None:
            try:
                updater.on_navigation()
            except Exception:
                pass

        # SPA fallback : sert index.html pour les routes non-fichier.
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.splitext(clean)[1]:
            self.path = "/index.html"
            path = self.translate_path(self.path)

        # Requête « / » : le chemin résolu est le dossier -> on vise son index.html.
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")

        # index.html : on injecte la carte de mise à jour (CSS + script externes, CSP-safe).
        if os.path.basename(path) == "index.html" and os.path.isfile(path):
            self._serve_index_with_banner(path)
            return
        super().do_GET()

    def do_POST(self):
        clean = self.path.split("?", 1)[0]
        if clean == "/__update__/start":
            status = {"state": "idle"}
            if updater is not None:
                try:
                    status = updater.start_update()
                except Exception:
                    pass
            self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__update__/restart":
            ok = _request_restart()
            self._serve_bytes(json.dumps({"ok": ok}).encode("utf-8"), "application/json; charset=utf-8")
            return
        self.send_error(404, "Endpoint inconnu")

    def _serve_index_with_banner(self, path: str) -> None:
        try:
            html = Path(path).read_bytes()
        except OSError:
            self.send_error(404, "index.html introuvable")
            return
        tag = (
            b'<link rel="stylesheet" href="/__elium_update.css">'
            b'<script src="/__elium_update.js" defer></script>'
        )
        if b"</body>" in html:
            html = html.replace(b"</body>", tag + b"</body>", 1)
        else:
            html = html + tag
        self._serve_bytes(html, "text/html; charset=utf-8")

    def _serve_bytes(self, data: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _serve_update_status(self) -> None:
        status = {"state": "idle", "version": None}
        if updater is not None:
            try:
                status = updater.get_status()
            except Exception:
                pass
        self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")

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

    # Handoff : si un lanceur plus récent a été téléchargé, on le relance et on quitte.
    if updater is not None:
        try:
            updater.run_pending_handoff()
        except SystemExit:
            raise
        except Exception:
            pass

    web_dir = current_web_dir()
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

    # Vérifie et applique une mise à jour en arrière-plan (jamais bloquant).
    if updater is not None:
        try:
            updater.start_background_check()
        except Exception:
            pass

    # ELIUM_NO_BROWSER=1 : mode serveur seul (tests, CI, usage avancé).
    headless = os.environ.get("ELIUM_NO_BROWSER") == "1"

    global _browser_proc, _fallback_event

    browser = None if headless else find_app_browser()
    if browser:
        # Fenêtre application dédiée ; le profil séparé garantit un processus
        # propre dont la fin signale la fermeture de la fenêtre.
        # S603 : le chemin vient d'une liste fixe de navigateurs connus.
        _browser_proc = subprocess.Popen([  # noqa: S603
            browser,
            f"--app={url}",
            f"--user-data-dir={app_profile_dir()}",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        try:
            _browser_proc.wait()
        except KeyboardInterrupt:
            _browser_proc.terminate()
        server.shutdown()
        _maybe_relaunch()
        return

    # Repli : onglet du navigateur par défaut ; l'utilisateur arrête avec Ctrl+C.
    print("Appuyez sur Ctrl+C pour arrêter.\n")
    if not headless:
        webbrowser.open(url)
    _fallback_event = threading.Event()
    try:
        _fallback_event.wait()
    except KeyboardInterrupt:
        print("\nArrêt du serveur Elium...")
    server.shutdown()
    _maybe_relaunch()


def _maybe_relaunch() -> None:
    """Après fermeture de la fenêtre : relance le nouvel exe si un redémarrage a été demandé."""
    if _restart_requested and updater is not None:
        try:
            updater.relaunch_pending_exe()
        except Exception:
            pass


if __name__ == "__main__":
    main()
