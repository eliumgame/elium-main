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

echo.
echo [OK] Web Studio lance. Ouvrez http://localhost:3000 dans votre navigateur.
echo (Pour le Drive Cloud collaboratif, voir le README : "Lancer la pile complete en local".)
echo.
pause
