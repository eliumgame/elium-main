# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec — Elium.exe (one-file, self-contained).

Bundles the Python runtime, the Elium core (crypto/format/cli) and the pre-built
Web Studio (web-studio/dist) into a SINGLE executable. Double-clicking it starts a
local server and opens the browser — no Python, Node or extra files required.

Build (deps must be importable in the build env — use a venv):
    pyinstaller installer/elium.spec --noconfirm
"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(SPEC)))
SRC = os.path.join(ROOT, "src")
INSTALLER = os.path.join(ROOT, "installer")
WEB = os.path.join(ROOT, "web-studio", "dist")
ICON = os.path.join(ROOT, "brand", "elium.ico")

if not os.path.isdir(WEB):
    raise SystemExit(f"web-studio/dist introuvable ({WEB}). Lancez d'abord `npm run build` dans web-studio/.")

a = Analysis(
    [os.path.join(ROOT, "installer", "elium_launcher.py")],
    pathex=[SRC, INSTALLER],  # INSTALLER pour que le module `updater` soit trouvé
    binaries=[],
    datas=[(WEB, "web")],  # embarque le Web Studio sous _MEIPASS/web
    hiddenimports=[
        "updater",  # module d'auto-update (installer/updater.py)
        "elium", "elium.core", "elium.core.container", "elium.core.exceptions",
        "elium.crypto", "elium.crypto.primitives",
        "elium.format", "elium.format.canonical", "elium.format.document",
        "elium.format.journal", "elium.format.package", "elium.format.profiles",
        "elium.format.proof", "elium.format.seal",
        "elium.cli", "elium.cli.main",
        "argon2", "argon2.low_level", "cryptography",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "PySide6", "PySide2", "PyQt5", "PyQt6", "matplotlib", "numpy"],
    noarchive=False,
)

pyz = PYZ(a.pure)

# One-file build: include binaries + datas directly in the EXE (no COLLECT).
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Elium",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    # Application fenêtrée : pas de console noire au lancement (le launcher
    # redirige stdout/stderr vers nul quand ils valent None).
    console=False,
    icon=ICON if os.path.exists(ICON) else None,
)
