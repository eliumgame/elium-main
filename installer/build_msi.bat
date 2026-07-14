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
:: Etape 2 : compilation WiX (candle -> light)
:: -------------------------------------------------------
if not exist "%OUTPUT%" mkdir "%OUTPUT%"

echo [*] Compilation candle (x64)...
"!WIX_BIN!\candle.exe" -nologo -arch x64 -out "%HERE%build\elium.wixobj" "%HERE%elium.wxs"
if !errorlevel! neq 0 (
    echo [ERREUR] candle.exe a echoue.
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)

echo [*] Edition de liens light (UI francaise)...
:: NB : "%HERE%." evite que le \ final n'echappe le guillemet fermant.
"!WIX_BIN!\light.exe" -nologo -cultures:fr-FR ^
    -ext WixUIExtension -ext WixUtilExtension ^
    -b "%HERE%." ^
    -out "%OUTPUT%\Elium-4.0.0-Setup.msi" "%HERE%build\elium.wixobj"
if !errorlevel! neq 0 (
    echo [ERREUR] light.exe a echoue.
    if /i not "%~1"=="/nopause" pause
    exit /b 1
)

echo.
echo =======================================================
echo    MSI GENERE AVEC SUCCES !
echo =======================================================
echo    %OUTPUT%\Elium-4.0.0-Setup.msi
echo.
if /i not "%~1"=="/nopause" pause

