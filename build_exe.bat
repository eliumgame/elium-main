@echo off
setlocal EnableDelayedExpansion
title Build Elium Executable
color 0B

echo.
echo =======================================================
echo          BUILD ELIUM - STANDALONE EXE
echo =======================================================
echo.

if not exist .venv (
    echo [ERREUR] Environnement virtuel introuvable. Executez Elium.wizard.bat d'abord.
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat

echo [*] Installation de PyInstaller...
pip install pyinstaller

echo [*] Build du Web Studio (Frontend)...
cd web-studio
call npm run build
cd ..

echo [*] Build du Desktop App (Backend) avec PyInstaller...
pyinstaller --noconfirm --windowed --add-data "web-studio/dist;web-studio/dist" --name Elium desktop\src\app.py

echo.
echo =======================================================
echo    BUILD TERMINE !
echo =======================================================
echo L'executable se trouve dans le dossier : dist\Elium\Elium.exe
pause
