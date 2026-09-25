"""Sert web-studio/dist SANS CSP (comparaison : un échec ici n'est pas dû à la CSP)."""
import http.server, socketserver, sys
from functools import partial
from pathlib import Path
port = int(sys.argv[1]) if len(sys.argv) > 1 else 3211
web = Path(r"C:\Users\ludov\Downloads\elium-main\elium-main\web-studio\dist")
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", port), partial(H, directory=str(web))) as httpd:
    httpd.serve_forever()
