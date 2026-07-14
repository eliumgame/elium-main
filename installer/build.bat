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
"%VPY%" -m pip install -e "%ROOT%" pyinstaller
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

:: -------------------------------------------------------
:: Etape 4 : installeur Inno Setup (optionnel)
:: -------------------------------------------------------
set "ISCC="
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if exist "%LocalAppData%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LocalAppData%\Programs\Inno Setup 6\ISCC.exe"

if "!ISCC!"=="" (
    echo.
    echo =======================================================
    echo  APPLICATION AUTONOME PRETE
    echo =======================================================
    echo  Lancez :  %STAGING%\Elium.exe   ^(double-clic^)
    echo.
    echo  [INFO] Inno Setup n'est pas installe, donc l'INSTALLEUR
    echo         .exe n'a pas ete genere. L'exe ci-dessus fonctionne
    echo         deja tout seul (aucun Python/Node requis).
    echo         Pour un installeur Windows complet (menu Demarrer,
    echo         association .elium), installez Inno Setup 6 :
    echo            https://jrsoftware.org/isdl.php
    echo         puis relancez ce script.
    echo.
    pause
    exit /b 0
)

echo     [OK] Inno Setup : !ISCC!
echo [*] Compilation de l'installeur...
if not exist "%OUTPUT%" mkdir "%OUTPUT%"
"!ISCC!" "%~dp0elium_setup.iss"
if !errorlevel! neq 0 (
    echo [ERREUR] La compilation Inno Setup a echoue.
    pause
    exit /b 1
)

echo.
echo =======================================================
echo    BUILD TERMINE AVEC SUCCES !
echo =======================================================
echo    Installeur     : %OUTPUT%\Elium-4.0.0-Setup.exe
echo    Exe autonome   : %STAGING%\Elium.exe
echo.
pause
