@echo off
REM T9 Editor LIT - the one door from source to the installed app + daemon.
REM
REM Double-click this file for the form, or pass deploy.ps1 switches:
REM   deploy.bat -Status
REM   deploy.bat -Doctor
REM   deploy.bat -Agent opencode -Model opencode/deepseek-v4.1-flash-free ^
REM              -Task "fix export" -Why "export stays disabled" -EtaMinutes 25 -Scope both
setlocal
set "HERE=%~dp0"
set "PS1=%HERE%deploy.ps1"

where pwsh >nul 2>&1
if errorlevel 1 (
    echo [x] PowerShell 7 ^(pwsh^) is required.
    echo     winget install Microsoft.PowerShell
    echo.
    pause
    exit /b 1
)

if not exist "%PS1%" (
    echo [x] deploy.ps1 is missing next to this file.
    pause
    exit /b 1
)

if "%~1"=="" (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Interactive
) else (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
    echo.
    echo [x] Deploy exited with code %CODE%. The ledger has the reason:
    echo     "%HERE%deploy-status.bat"
    echo.
    if "%~1"=="" pause
)
exit /b %CODE%
