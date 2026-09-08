@echo off
setlocal EnableDelayedExpansion
title Elium v4 - Build (exe autonome + installeur)
color 0E

echo.
echo =======================================================
echo       ELIUM v4 - Construction
echo =======================================================
echo.

set "ROOT=%~dp0.."
set "STAGING=%~dp0staging"
set "OUTPUT=%~dp0output"
set "VENV=%ROOT%\.venv"

:: -------------------------------------------------------
:: Etape 0 : pre-requis (Python + Node)
:: -------------------------------------------------------
echo [*] Verification des outils...

where py >nul 2>&1
if !errorlevel! equ 0 ( set "PY=py" ) else ( set "PY=python" )

%PY% --version >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERREUR] Python n'est pas installe ou pas dans le PATH.
    echo          Telechargez-le sur https://www.python.org/downloads/
    pause
    exit /b 1
)

node --version >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERREUR] Node.js n'est pas installe ou pas dans le PATH.
    echo          Telechargez-le sur https://nodejs.org/
    pause
    exit /b 1
)

:: -------------------------------------------------------
:: Etape 1 : environnement Python isole (.venv) + dependances
::   (corrige l'echec frequent : PyInstaller lance sur un Python
::    sans cryptography/argon2/elium).
:: -------------------------------------------------------
if not exist "%VENV%\Scripts\python.exe" (
    echo [*] Creation de l'environnement Python isole (.venv)...
    %PY% -m venv "%VENV%"
    if !errorlevel! neq 0 (
        echo [ERREUR] Impossible de creer le venv.
        pause
        exit /b 1
    )
)
set "VPY=%VENV%\Scripts\python.exe"

echo [*] Installation des dependances (elium + PyInstaller)...
"%VPY%" -m pip install --upgrade pip >nul 2>&1
"%VPY%" -m pip install -e "%ROOT%" pyinstaller==6.21.0
if !errorlevel! neq 0 (
    echo [ERREUR] Echec de l'installation des dependances Python.
    pause
    exit /b 1
)
echo     [OK] Environnement Python pret.

:: -------------------------------------------------------
:: Etape 2 : build du Web Studio (genere web-studio/dist)
:: -------------------------------------------------------
echo [*] Build du Web Studio (npm)...
cd /d "%ROOT%\web-studio"
call npm install
call npm run build
if !errorlevel! neq 0 (
    echo [ERREUR] Le build du Web Studio a echoue.
    pause
    exit /b 1
)
echo     [OK] Web Studio build.

:: -------------------------------------------------------
:: Etape 3 : Elium.exe autonome (PyInstaller one-file)
::   embarque Python + crypto + interface : aucun pre-requis a l'execution.
:: -------------------------------------------------------
echo [*] Build de Elium.exe (one-file autonome)...
cd /d "%ROOT%"
if exist "%STAGING%" rmdir /S /Q "%STAGING%"
"%VPY%" -m PyInstaller installer\elium.spec --noconfirm --distpath "%STAGING%" --workpath "%~dp0build"
if !errorlevel! neq 0 (
    echo [ERREUR] PyInstaller a echoue.
    pause
    exit /b 1
)
echo     [OK] %STAGING%\Elium.exe

echo.
echo =======================================================
echo    BUILD TERMINE AVEC SUCCES !
echo =======================================================
echo    Exe autonome   : %STAGING%\Elium.exe
echo.
echo    Pour un installeur Windows complet (menu Demarrer,
echo    association .elium), lancez ensuite installer\build_msi.bat
echo    (necessite WiX Toolset - voir installer\README.md).
echo.
pause
