@echo off
title Nanami Cut Launcher
cd /d "%~dp0\Clipchamp_Bunny"

echo ========================================================
echo        Nanami Cut  -  Zero-RAM Transcript Cutter
echo ========================================================
echo.

where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo [x] FFmpeg not found on PATH. Install it and retry:
    echo     winget install Gyan.FFmpeg
    echo.
    pause
    exit /b 1
) else (
    echo [ok] FFmpeg found.
)

echo.
echo [1/2] Checking t9cloud AI daemon ^(port 7878^)....
netstat -ano | findstr :7878 >nul 2>&1
if %errorlevel% neq 0 (
    if exist "..\go\bin\t9cloud.exe" (
        echo       Starting t9cloud background worker...
        start /b "" "..\go\bin\t9cloud.exe" -env ..\.env
        ping 127.0.0.1 -n 2 >nul 2>&1
    ) else (
        echo [i] t9cloud not built - cloud features will be offline.
    )
) else (
    echo       t9cloud daemon already active.
)

echo.
echo [2/2] Launching Nanami Cut (Tauri dev build)...
taskkill /f /im nanami-cut.exe >nul 2>&1
call npm run app

echo.
echo Nanami Cut closed.
exit 0
