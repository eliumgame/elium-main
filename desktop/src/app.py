"""
Elium Desktop Application — Secure Dashboard (PySide6).

Main entry point for the desktop GUI application.
Uses a modular structure with separated tab builders and action handlers.
"""

import http.server
import os
import socketserver
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QIcon, QPalette
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QGroupBox,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError
from elium.crypto.primitives import (
    generate_ed25519_keypair,
    get_public_key_fingerprint,
    load_private_key,
    load_public_key,
)


def get_resource_path(relative_path: str) -> Path:
    """Return an absolute resource path in development and PyInstaller builds."""
    try:
        base_path = Path(sys._MEIPASS)  # type: ignore[attr-defined]
    except Exception:
        base_path = Path(__file__).resolve().parent.parent.parent
    return base_path / relative_path

# --- Stylesheet ---
STYLESHEET = """
QMainWindow {
    background-color: #0d1117;
}
QTabWidget::pane {
    border: 1px solid #30363d;
    border-radius: 8px;
    background-color: #161b22;
}
QTabBar::tab {
    background: #21262d;
    color: #c9d1d9;
    padding: 10px 20px;
    border: 1px solid #30363d;
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    margin-right: 2px;
    font-weight: bold;
}
QTabBar::tab:selected {
    background: #161b22;
    color: #58a6ff;
    border-bottom: 2px solid #58a6ff;
}
QTabBar::tab:hover {
    background: #1c2128;
}
QLabel {
    color: #c9d1d9;
    font-size: 13px;
}
QLineEdit {
    background-color: #21262d;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    padding: 8px 12px;
    font-size: 13px;
}
QLineEdit:focus {
    border-color: #58a6ff;
}
QPushButton {
    background-color: #238636;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 10px 20px;
    font-size: 13px;
    font-weight: bold;
}
QPushButton:hover {
    background-color: #2ea043;
}
QPushButton:pressed {
    background-color: #1a7f37;
}
QPushButton:disabled {
    background-color: #21262d;
    color: #484f58;
}
QGroupBox {
    border: 1px solid #30363d;
    border-radius: 8px;
    margin-top: 16px;
    padding: 16px;
    padding-top: 28px;
    color: #c9d1d9;
    font-weight: bold;
}
QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    padding: 4px 12px;
    color: #58a6ff;
}
"""


class EliumApp(QMainWindow):
    """Main application window for Elium Desktop."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Elium Manager — Secure Dashboard")
        self.resize(750, 550)

        icon_path = get_resource_path("brand/elium.ico")
        if icon_path.exists():
            self.setWindowIcon(QIcon(str(icon_path)))

        self.current_signing_key: Optional[Ed25519PrivateKey] = None
        self.current_fingerprint: str = ""
        self.verify_public_key: Optional[Ed25519PublicKey] = None
        self._project_root = get_resource_path("")

        self.tabs = QTabWidget()
        self.setCentralWidget(self.tabs)

        self._build_open_tab()
        self._build_create_tab()
        self._build_keys_tab()
        self._build_tools_tab()

    # --- Tab Builders ---

    def _build_open_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout()

        self.lbl_info = QLabel("Sélectionnez un conteneur .elium pour l'ouvrir.")
        self.lbl_info.setWordWrap(True)
        layout.addWidget(self.lbl_info)

        self.txt_password = QLineEdit()
        self.txt_password.setPlaceholderText("Mot de passe")
        self.txt_password.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addWidget(self.txt_password)

        btn_open = QPushButton("🔓  Ouvrir le fichier .elium")
        btn_open.clicked.connect(self._action_open_file)
        btn_open.setMinimumHeight(44)
        layout.addWidget(btn_open)

        layout.addWidget(QLabel("")) # Spacer

        self.lbl_verify_key = QLabel("Clé de vérification : Aucune (Non vérifié)")
        self.lbl_verify_key.setStyleSheet("color: #8b949e;")
        layout.addWidget(self.lbl_verify_key)

        btn_load_pub = QPushButton("Importer une clé publique (.pem)")
        btn_load_pub.setStyleSheet("background-color: #21262d; border: 1px solid #30363d;")
        btn_load_pub.clicked.connect(self._action_load_public_key)
        layout.addWidget(btn_load_pub)

        layout.addStretch()
        tab.setLayout(layout)
        self.tabs.addTab(tab, "🔓 Ouvrir")

    def _build_create_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout()

        lbl = QLabel("Encapsulez et chiffrez un fichier en toute sécurité.")
        lbl.setWordWrap(True)
        layout.addWidget(lbl)

        self.txt_create_password = QLineEdit()
        self.txt_create_password.setPlaceholderText("Mot de passe (Obligatoire)")
        self.txt_create_password.setEchoMode(QLineEdit.EchoMode.Password)
        layout.addWidget(self.txt_create_password)

        self.lbl_signer_status = QLabel("Signature : Aucune clé chargée (Fichier non signé).")
        self.lbl_signer_status.setStyleSheet("color: #8b949e;")
        layout.addWidget(self.lbl_signer_status)

        self.chk_cascade = QCheckBox("Activer le chiffrement en cascade (ChaCha20-Poly1305)")
        self.chk_cascade.setStyleSheet("color: #c9d1d9; margin-top: 10px; margin-bottom: 10px;")
        layout.addWidget(self.chk_cascade)

        btn_create = QPushButton("🔒  Créer le conteneur .elium")
        btn_create.clicked.connect(self._action_create_file)
        btn_create.setMinimumHeight(44)
        layout.addWidget(btn_create)

        layout.addStretch()
        tab.setLayout(layout)
        self.tabs.addTab(tab, "🔒 Créer")

    def _build_keys_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout()

        # Generate
        group_gen = QGroupBox("Générer une nouvelle identité (Clé Ed25519)")
        l_gen = QVBoxLayout()
        btn_gen = QPushButton("Générer et Sauvegarder")
        btn_gen.clicked.connect(self._action_generate_key)
        l_gen.addWidget(btn_gen)
        group_gen.setLayout(l_gen)
        layout.addWidget(group_gen)

        # Load
        group_load = QGroupBox("Charger une identité existante")
        l_load = QVBoxLayout()
        btn_load = QPushButton("Charger une clé privée (.pem)")
        btn_load.clicked.connect(self._action_load_key)
        l_load.addWidget(btn_load)
        group_load.setLayout(l_load)
        layout.addWidget(group_load)

        # Status
        self.lbl_key_status = QLabel("Identité Actuelle : Aucune")
        self.lbl_key_status.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_key_status.setStyleSheet("font-weight: bold; margin-top: 20px; font-size: 14px;")
        layout.addWidget(self.lbl_key_status)

        layout.addStretch()
        tab.setLayout(layout)
        self.tabs.addTab(tab, "🔑 Clés")

    def _build_tools_tab(self) -> None:
        tab = QWidget()
        layout = QVBoxLayout()

        lbl = QLabel("Lancez les outils de l'écosystème Elium depuis ce tableau de bord.")
        lbl.setWordWrap(True)
        layout.addWidget(lbl)

        btn_web = QPushButton("🌐  Lancer Web Studio (React/Vite)")
        btn_web.clicked.connect(self._action_launch_web_studio)
        btn_web.setMinimumHeight(50)
        layout.addWidget(btn_web)

        btn_diag = QPushButton("🩺  Lancer le Diagnostic (Tests)")
        btn_diag.clicked.connect(self._action_launch_diagnostic)
        btn_diag.setMinimumHeight(50)
        layout.addWidget(btn_diag)

        layout.addStretch()
        tab.setLayout(layout)
        self.tabs.addTab(tab, "🛠️ Outils")

    # --- Actions ---

    def _action_open_file(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self, "Ouvrir .elium", "", "Elium Files (*.elium);;All Files (*)"
        )
        if not file_path:
            return

        password = self.txt_password.text()
        if not password:
            QMessageBox.warning(self, "Erreur", "Veuillez entrer le mot de passe.")
            return

        try:
            with open(file_path, "rb") as f:
                blob = f.read()

            payload, manifest, header = EliumContainer.decode(
                blob, password, verify_public_key=self.verify_public_key
            )

            files = manifest.get("files", [{}])
            file_name = files[0].get("name", "Inconnu") if files else "Inconnu"
            info_txt = f"Fichier: {file_name}"

            is_signed = header.get("flags", {}).get("signed")
            if is_signed:
                sig_valid = header.get("signature_valid")
                if sig_valid is True:
                    info_txt += "\n✅ Signature ED25519 : VALIDE."
                elif sig_valid is None:
                    info_txt += "\n⚠ Fichier signé — Aucune clé de confiance fournie (Non vérifié)."

            self.lbl_info.setText(f"✅ Déchiffrement réussi!\n{info_txt}")

            default_name = file_name if file_name != "Inconnu" else "fichier_dechiffre"
            save_path, _ = QFileDialog.getSaveFileName(
                self, "Enregistrer le fichier déchiffré", default_name
            )
            if save_path:
                with open(save_path, "wb") as f_out:
                    f_out.write(payload)
                QMessageBox.information(self, "Succès", "Fichier sauvegardé avec succès !")

        except EliumError as e:
            QMessageBox.critical(self, "Erreur de Sécurité", str(e))
        except Exception as e:
            QMessageBox.critical(self, "Erreur", str(e))

    def _action_create_file(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self, "Fichier à chiffrer", "", "All Files (*)"
        )
        if not file_path:
            return

        password = self.txt_create_password.text()
        if not password:
            QMessageBox.warning(self, "Erreur", "Veuillez entrer un mot de passe.")
            return

        try:
            with open(file_path, "rb") as f:
                payload = f.read()

            manifest = {
                "files": [{"name": os.path.basename(file_path), "size": len(payload)}]
            }

            encoded = EliumContainer.encode(
                payload=payload,
                password=password,
                manifest_meta=manifest,
                signing_key=self.current_signing_key,
                cascade=self.chk_cascade.isChecked()
            )

            save_path, _ = QFileDialog.getSaveFileName(
                self, "Enregistrer .elium", file_path + ".elium", "Elium Files (*.elium)"
            )
            if save_path:
                with open(save_path, "wb") as f_out:
                    f_out.write(encoded)
                QMessageBox.information(self, "Succès", "Conteneur créé avec succès !")

        except EliumError as e:
            QMessageBox.critical(self, "Erreur de Sécurité", str(e))
        except Exception as e:
            QMessageBox.critical(self, "Erreur", str(e))

    def _action_generate_key(self) -> None:
        try:
            priv, _pub = generate_ed25519_keypair()
            priv_bytes = priv.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            )
            save_path, _ = QFileDialog.getSaveFileName(
                self, "Sauvegarder la clé privée", "identite.pem", "PEM Files (*.pem)"
            )
            if save_path:
                with open(save_path, "wb") as f:
                    f.write(priv_bytes)
                QMessageBox.information(
                    self, "Succès",
                    "Clé générée et sauvegardée.\nChargez-la pour signer vos conteneurs."
                )
        except Exception as e:
            QMessageBox.critical(self, "Erreur", str(e))

    def _action_load_key(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self, "Charger clé privée", "", "PEM Files (*.pem);;All Files (*)"
        )
        if not file_path:
            return

        try:
            with open(file_path, "rb") as f:
                data = f.read()
            self.current_signing_key = load_private_key(data)
            self.current_fingerprint = get_public_key_fingerprint(
                self.current_signing_key.public_key()
            )

            short_fp = self.current_fingerprint[:8]
            self.lbl_key_status.setText(f"✅ Identité Chargée (Empreinte: {short_fp}...)")
            self.lbl_key_status.setStyleSheet(
                "color: #3fb950; font-weight: bold; margin-top: 20px; font-size: 14px;"
            )
            self.lbl_signer_status.setText(f"Signature activée : {short_fp}...")
            self.lbl_signer_status.setStyleSheet("color: #58a6ff;")
            QMessageBox.information(
                self, "Succès",
                "Clé chargée. Vos futurs conteneurs seront signés cryptographiquement."
            )
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Clé invalide: {e}")

    def _action_load_public_key(self) -> None:
        file_path, _ = QFileDialog.getOpenFileName(
            self, "Charger clé publique de confiance", "", "PEM Files (*.pem);;All Files (*)"
        )
        if not file_path:
            return

        try:
            with open(file_path, "rb") as f:
                data = f.read()
            self.verify_public_key = load_public_key(data)
            short_fp = get_public_key_fingerprint(self.verify_public_key)[:8]

            self.lbl_verify_key.setText(f"✅ Clé de confiance : {short_fp}...")
            self.lbl_verify_key.setStyleSheet("color: #3fb950;")
            QMessageBox.information(
                self, "Succès",
                "Clé publique chargée. Les fichiers signés par cet auteur seront vérifiés."
            )
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Clé invalide: {e}")

    def _action_launch_web_studio(self) -> None:
        try:
            web_studio_dist = get_resource_path("web-studio/dist")
            if not web_studio_dist.exists():
                QMessageBox.warning(
                    self,
                    "Erreur",
                    f"Répertoire statique introuvable: {web_studio_dist}.\n"
                    "Veuillez compiler le projet avec npm run build.",
                )
                return

            if getattr(self, "server_thread", None) is None:
                port = 3000

                class QuietHandler(http.server.SimpleHTTPRequestHandler):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, directory=str(web_studio_dist), **kwargs)
                    def log_message(self, format, *args):
                        pass
                    def end_headers(self):
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

                def run_server():
                    try:
                        # Bind to loopback only — never expose the local app on the LAN.
                        with socketserver.TCPServer(("127.0.0.1", port), QuietHandler) as httpd:
                            httpd.serve_forever()
                    except OSError:
                        pass  # Port probably already in use

                self.server_thread = threading.Thread(target=run_server, daemon=True)
                self.server_thread.start()

            webbrowser.open("http://localhost:3000")
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Impossible de lancer le Web Studio: {e}")

    def _action_launch_diagnostic(self) -> None:
        try:
            cmd_path = os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
            creation_flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            subprocess.Popen(  # noqa: S603 - commande locale fixe, arguments contrôlés par l’application
                [cmd_path, "/k", sys.executable, "-m", "pytest", "tests/python", "-v"],
                cwd=str(self._project_root),
                creationflags=creation_flags,
            )
        except Exception as e:
            QMessageBox.critical(self, "Erreur", f"Impossible de lancer les tests: {e}")


def main() -> None:
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    icon_path = get_resource_path("brand/elium.ico")
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))

    # Dark mode palette
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor("#0d1117"))
    palette.setColor(QPalette.ColorRole.WindowText, QColor("#c9d1d9"))
    palette.setColor(QPalette.ColorRole.Base, QColor("#161b22"))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor("#21262d"))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor("#161b22"))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor("#c9d1d9"))
    palette.setColor(QPalette.ColorRole.Text, QColor("#c9d1d9"))
    palette.setColor(QPalette.ColorRole.Button, QColor("#21262d"))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor("#c9d1d9"))
    palette.setColor(QPalette.ColorRole.Highlight, QColor("#1f6feb"))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)
    app.setStyleSheet(STYLESHEET)

    window = EliumApp()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
