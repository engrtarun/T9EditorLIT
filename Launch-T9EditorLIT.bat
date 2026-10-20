@echo off
title T9 Editor LIT Launcher
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
set "APP=%ROOT%Clipchamp_Bunny"
cd /d "%APP%"

echo ========================================================
echo        T9 Editor LIT  -  Zero-RAM Transcript Cutter
echo ========================================================
echo.

REM ---------- 1/3  FFmpeg ----------
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo [x] FFmpeg not found on PATH.
    echo     winget install Gyan.FFmpeg
    echo.
    pause
    exit /b 1
)
echo [ok] FFmpeg found.

REM ---------- 2/3  t9cloud AI daemon ----------
echo.
echo [2/3] t9cloud AI daemon ^(Groq ^/ Gemini ^/ Telegram^) on port 7878...
netstat -ano | findstr "LISTENING" | findstr ":7878" >nul 2>&1
if %errorlevel% equ 0 (
    echo       [ok] already running.
) else (
    if exist "%ROOT%go\bin\t9cloud.exe" (
        echo       starting...
        start /b "" "%ROOT%go\bin\t9cloud.exe" -env "%ROOT%.env"
        ping 127.0.0.1 -n 3 >nul 2>&1
        netstat -ano | findstr "LISTENING" | findstr ":7878" >nul 2>&1
        if %errorlevel% equ 0 (
            echo       [ok] up.
        ) else (
            echo       [!] daemon did not bind ^(port busy or .env problem^) - cloud features stay offline.
        )
    ) else (
        echo       [!] go\bin\t9cloud.exe missing - cloud features stay offline.
    )
)

REM ---------- 3/3  launch ----------
echo.
echo [3/3] Launching T9 Editor LIT...
taskkill /f /im t9-editor-lit.exe >nul 2>&1
taskkill /f /im nanami-cut.exe >nul 2>&1

if exist "src-tauri\target\release\t9-editor-lit.exe" (
    echo       release build - starting.
    start "" "src-tauri\target\release\t9-editor-lit.exe"
) else if exist "src-tauri\target\release\nanami-cut.exe" (
    echo       release build - starting.
    start "" "src-tauri\target\release\nanami-cut.exe"
) else (
    echo       [!] No release build found.
    echo           First run compiles ~380 Rust crates and takes 10-15 MINUTES.
    echo           Building now - please wait, do not close this window.
    echo.
    call npm run app:build
    if exist "src-tauri\target\release\t9-editor-lit.exe" (
        start "" "src-tauri\target\release\t9-editor-lit.exe"
    ) else (
        call npm run app
    )
)

echo.
echo T9 Editor LIT closed.
endlocal
