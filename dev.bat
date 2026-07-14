@echo off
setlocal EnableDelayedExpansion
title Elium v4 - Mode Developpement
color 0A

echo.
echo =======================================================
echo          ELIUM v4 - MODE DEVELOPPEMENT
echo =======================================================
echo.

:: Verification Venv
if not exist .venv (
    echo [!] L'environnement virtuel n'existe pas. Lancez Elium.wizard.bat d'abord.
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat

echo [*] Lancement du Web Studio (Frontend)...
if exist web-studio (
    start "Elium Web Studio (Vite)" cmd /k "cd web-studio && npm run dev"
) else (
    echo [!] Dossier web-studio introuvable.
)

echo [*] Lancement de l'app Desktop (Backend)...
if exist desktop\src\app.py (
    start "Elium Desktop (PySide6)" cmd /k "python desktop\src\app.py"
) else (
    echo [!] Application desktop introuvable.
)

echo.
echo [OK] Environnement de developpement lance dans des fenetres separees.
echo.
pause
