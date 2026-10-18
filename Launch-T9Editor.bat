@echo off
title T9EditorLIT Launcher
cd /d "%~dp0"

echo ========================================================
echo       Starting T9EditorLIT Desktop Application
echo ========================================================
echo.

echo [1/2] Checking t9cloud AI daemon (port 8787)...
netstat -ano | findstr :8787 >nul 2>&1
if %errorlevel% neq 0 (
    echo Starting t9cloud background worker...
    start /b "" "go\bin\t9cloud.exe" -env .env
    timeout /t 1 /nobreak >nul
) else (
    echo t9cloud daemon is already active.
)

echo.
echo [2/2] Launching T9EditorLIT window...
if exist "src-tauri\target\release\t9-editor-lit.exe" (
    start "" "src-tauri\target\release\t9-editor-lit.exe"
) else (
    call npm run tauri dev
)

echo Done! Window will open shortly.
