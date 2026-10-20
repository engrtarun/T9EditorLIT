@echo off
REM T9 Editor LIT launcher - the installed app wins.
REM The real logic lives in Launch-T9EditorLIT.ps1; this file only forwards.
setlocal
where pwsh >nul 2>&1
if errorlevel 1 (
    echo [x] PowerShell 7 ^(pwsh^) is required.
    echo     winget install Microsoft.PowerShell
    echo.
    pause
    exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch-T9EditorLIT.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
exit /b %CODE%
