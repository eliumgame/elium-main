"""Sert web-studio/dist comme le lanceur de bureau (installer/elium_launcher.py).

Les en-têtes, dont la CSP, sont lus dans la SOURCE du lanceur (analyse ast,
sans l'importer : il tire des dépendances Windows). Les tests Playwright
« desktop » tournent donc exactement sous la politique livrée aux
utilisateurs. Usage : python3 desktop-server.py <port>
"""

import ast
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LAUNCHER = ROOT / "installer" / "elium_launcher.py"
DIST = ROOT / "web-studio" / "dist"


def launcher_csp() -> str:
    tree = ast.parse(LAUNCHER.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        target = getattr(node, "target", None) or (getattr(node, "targets", None) or [None])[0]
        if isinstance(target, ast.Name) and target.id == "CSP_DIRECTIVES":
            return "; ".join(ast.literal_eval(node.value))
    raise SystemExit("CSP_DIRECTIVES introuvable dans elium_launcher.py")


CSP = launcher_csp()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
    }

    def log_message(self, *args):
        pass

    def do_GET(self):
        # Same answer as the launcher when no updater is configured.
        if self.path.split("?", 1)[0] == "/__version__":
            body = b'{"installed": null, "base": null, "latest": null, "upToDate": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3102
    handler = functools.partial(Handler, directory=str(DIST))
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
