@echo off
REM Read-only health check of the installed app, marker, stage and daemon.
setlocal
where pwsh >nul 2>&1
if errorlevel 1 (
    echo [x] PowerShell 7 ^(pwsh^) is required.
    exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Doctor
exit /b %ERRORLEVEL%
