@echo off
setlocal EnableDelayedExpansion
title Installation et Lancement - Elium v4
color 0B

echo.
echo =======================================================
echo          ELIUM v4 - Installeur et Lanceur (.wizard)
echo =======================================================
echo.

:: 1. Verification de winget
where winget >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERREUR] winget n'est pas installe. Veuillez installer "App Installer" depuis le Microsoft Store.
    pause
    exit /b 1
)

:: 2. Node.js
echo [*] Verification de Node.js...
node -v >nul 2>&1
if !errorlevel! neq 0 (
    echo [-] Installation de Node.js...
    winget install OpenJS.NodeJS -e --silent --accept-package-agreements --accept-source-agreements
    set "PATH=%PATH%;C:\Program Files\nodejs"
)

:: 3. Python
echo [*] Verification de Python...
python --version >nul 2>&1
if !errorlevel! neq 0 (
    echo [-] Installation de Python...
    winget install Python.Python.3.11 -e --silent --accept-package-agreements --accept-source-agreements
    set "PATH=%PATH%;C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\Scripts\;C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\"
)

:: 4. Python Venv et dépendances
echo [*] Configuration de l'environnement Python...
if not exist .venv (
    python -m venv .venv
    call .venv\Scripts\activate.bat
    python -m pip install --upgrade pip >nul 2>&1
    echo [*] Installation des dependances Elium (Patientez)...
    python -m pip install -e .[dev,desktop]
) else (
    call .venv\Scripts\activate.bat
)

:: 5. Web Studio (npm install)
if exist web-studio (
    if not exist web-studio\node_modules (
        echo [*] Installation des dependances du Web Studio...
        cd web-studio
        call npm install
        cd ..
    )
)

echo.
echo =======================================================
echo    INSTALLATION TERMINEE. LANCEMENT D'ELIUM...
echo =======================================================
echo.

:: Lancer le Web Studio en arriere-plan
if exist web-studio (
    start "" /B cmd /c "cd /d %~dp0web-studio && npm run dev" >nul 2>&1
    echo Demarrage du serveur Web Studio...
    timeout /t 4 /nobreak >nul
    :: Ouvrir le navigateur
    start http://localhost:3000
)

:: Lancer l'application Desktop Python
if exist desktop\src\app.py (
    start "" /B pythonw desktop\src\app.py
)

echo.
echo [OK] Tout est lance !
echo Web Studio : http://localhost:3000
echo Application Desktop en cours d'execution...
echo Appuyez sur une touche pour fermer cette fenetre (les applications continueront de tourner en arriere-plan).
pause >nul
