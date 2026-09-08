@echo off
setlocal EnableDelayedExpansion
title Build Elium Executable
color 0B

echo.
echo =======================================================
echo          BUILD ELIUM - STANDALONE EXE
echo =======================================================
echo.
echo Ce script construit desormais l'executable REELLEMENT distribue
echo (installer\elium_launcher.py via installer\elium.spec), et non plus
echo l'ancienne application desktop PySide6 (legacy, non maintenue).
echo Il delegue simplement au pipeline officiel : installer\build.bat.
echo.

call "%~dp0installer\build.bat"
