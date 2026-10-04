@echo off
setlocal EnableDelayedExpansion
title Elium v4 - Installeur MSI (WiX)
color 0E

echo.
echo =======================================================
echo       ELIUM v4 - Installeur Windows (.msi)
echo =======================================================
echo.

set "HERE=%~dp0"
set "ROOT=%HERE%.."
set "VENV=%ROOT%\.venv"
set "OUTPUT=%HERE%output"

:: -------------------------------------------------------
:: Etape 0 : localiser WiX Toolset (installe ou portable)
:: -------------------------------------------------------
set "WIX_BIN="
if exist "%ProgramFiles(x86)%\WiX Toolset v3.14\bin\candle.exe" set "WIX_BIN=%ProgramFiles(x86)%\WiX Toolset v3.14\bin"
if exist "%ProgramFiles(x86)%\WiX Toolset v3.11\bin\candle.exe" set "WIX_BIN=%ProgramFiles(x86)%\WiX Toolset v3.11\bin"
if exist "%LocalAppData%\WiX314\candle.exe" set "WIX_BIN=%LocalAppData%\WiX314"

if "!WIX_BIN!"=="" (
    echo [ERREUR] WiX Toolset introuvable.
    echo          Option 1 : installeur officiel https://wixtoolset.org/
    echo          Option 2 : binaires portables wix314-binaries.zip extraits
    echo                     dans %%LocalAppData%%\WiX314
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)
echo     [OK] WiX : !WIX_BIN!

:: -------------------------------------------------------
:: Etape 1 : pre-requis (exe autonome + assets)
:: -------------------------------------------------------
if not exist "%HERE%staging\Elium.exe" (
    echo [ERREUR] staging\Elium.exe manquant.
    echo          Lancez d'abord installer\build.bat ^(PyInstaller^).
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)

if not exist "%VENV%\Scripts\python.exe" (
    echo [ERREUR] venv Python manquant ^(%VENV%^). Lancez installer\build.bat.
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)

echo [*] Generation des ressources MSI (licence RTF + visuels)...
"%VENV%\Scripts\python.exe" "%HERE%make_msi_assets.py"
if !errorlevel! neq 0 (
    echo [ERREUR] Generation des ressources MSI echouee.
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)

:: -------------------------------------------------------
:: Etape 1bis : version applicative (source unique = __init__.py,
:: stampee par stamp_version.py) -> nom de fichier MSI dynamique.
:: -------------------------------------------------------
set "APPVER_FILE=%TEMP%\elium_appver_%RANDOM%.txt"
"%VENV%\Scripts\python.exe" "%HERE%print_version.py" > "%APPVER_FILE%"
set /p APPVER=<"%APPVER_FILE%"
del "%APPVER_FILE%" >nul 2>&1
if "!APPVER!"=="" (
    echo [ERREUR] Impossible de lire la version applicative depuis src\elium\__init__.py.
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)
echo     [OK] Version applicative : !APPVER!

:: -------------------------------------------------------
:: Etape 2 : compilation WiX (candle -> light)
:: -------------------------------------------------------
if not exist "%OUTPUT%" mkdir "%OUTPUT%"

if not exist "%HERE%build" mkdir "%HERE%build"

:: Deux produits issus de la meme source (variable Scope) :
::   perMachine -> Elium-X.Y.Z-Setup.msi  (tous les utilisateurs, Program Files, droits admin)
::   perUser    -> Elium-User-X.Y.Z.msi   (sans droits admin, %LOCALAPPDATA%\Programs\Elium)
:: NB : la version MSI est le coeur numerique X.Y.Z (stamp_version.py) ; le nom de fichier garde
:: la version complete (ex. 4.7.0-rc1).
call :build_one perMachine "%OUTPUT%\Elium-!APPVER!-Setup.msi"
if !errorlevel! neq 0 goto :fail
call :build_one perUser "%OUTPUT%\Elium-User-!APPVER!.msi"
if !errorlevel! neq 0 goto :fail

echo.
echo =======================================================
echo    MSI GENERES AVEC SUCCES !
echo =======================================================
echo    %OUTPUT%\Elium-!APPVER!-Setup.msi   (tous les utilisateurs)
echo    %OUTPUT%\Elium-User-!APPVER!.msi    (sans droits administrateur)
echo.
if /i not "%~1"=="/nopause" pause
exit /b 0

:fail
if /i not "%~1"=="/nopause" pause
exit /b 1

:build_one
echo [*] Compilation candle (x64, %~1)...
"!WIX_BIN!\candle.exe" -nologo -arch x64 -dScope=%~1 -ext WixUtilExtension -out "%HERE%build\elium-%~1.wixobj" "%HERE%elium.wxs"
if !errorlevel! neq 0 (
    echo [ERREUR] candle.exe a echoue ^(%~1^).
    exit /b 1
)
echo [*] Edition de liens light (UI francaise, %~1)...
:: NB : "%HERE%." evite que le \ final n'echappe le guillemet fermant.
"!WIX_BIN!\light.exe" -nologo -cultures:fr-FR ^
    -ext WixUIExtension -ext WixUtilExtension ^
    -b "%HERE%." ^
    -out %2 "%HERE%build\elium-%~1.wixobj"
if !errorlevel! neq 0 (
    echo [ERREUR] light.exe a echoue ^(%~1^).
    exit /b 1
)
exit /b 0

