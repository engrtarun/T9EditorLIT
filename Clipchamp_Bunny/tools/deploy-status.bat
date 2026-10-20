@echo off
REM Print the SQLite deploy ledger: active work, queue, recent outcomes.
setlocal
where pwsh >nul 2>&1
if errorlevel 1 (
    echo [x] PowerShell 7 ^(pwsh^) is required.
    exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Status %*
exit /b %ERRORLEVEL%
