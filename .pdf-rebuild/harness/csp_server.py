"""Sert web-studio/dist avec EXACTEMENT le handler (et donc la CSP) de l'appli
de bureau installée (installer/elium_launcher.py::QuietHandler)."""
import socketserver, sys
from functools import partial
from pathlib import Path
REPO = Path(r"C:\Users\ludov\Downloads\elium-main\elium-main")
sys.path.insert(0, str(REPO / "installer"))
import elium_launcher as L  # noqa: E402  (main() est gardé par __name__)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 3210
web = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "web-studio" / "dist"
L.current_web_dir = lambda: web  # le handler résout lui-même son dossier (overlay/embarqué)
handler = partial(L.QuietHandler, directory=str(web))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
    print(f"CSP server on http://127.0.0.1:{port} serving {web}", flush=True)
    httpd.serve_forever()
