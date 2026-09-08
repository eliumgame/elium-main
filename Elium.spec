# -*- mode: python ; coding: utf-8 -*-
#
# LEGACY — spec PyInstaller pour l'ancienne application desktop PySide6
# (desktop/src/app.py), non maintenue et non testee. Aucun script du depot
# n'appelle plus ce fichier (build_exe.bat delegue desormais au pipeline
# officiel installer\build.bat). Conserve uniquement pour qui voudrait
# reconstruire manuellement l'app legacy (`pyinstaller Elium.spec`).
# Le spec du pipeline reellement livre est installer/elium.spec.


a = Analysis(
    ['desktop\\src\\app.py'],
    pathex=[],
    binaries=[],
    datas=[('web-studio/dist', 'web-studio/dist'), ('brand/elium.ico', 'brand')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Elium',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='brand/elium.ico',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='Elium',
)
