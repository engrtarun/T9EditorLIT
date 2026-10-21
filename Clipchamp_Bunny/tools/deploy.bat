@echo off
REM T9 Editor LIT - the one door from source to the installed app + daemon.
REM Routes to Sarkari High-Speed Deploy Engine.
setlocal
set "HERE=%~dp0"
set "ROOT=%HERE%..\..\"
if exist "%ROOT%Sarkari-Deploy.bat" (
    call "%ROOT%Sarkari-Deploy.bat" %*
    exit /b %ERRORLEVEL%
)

set "PS1=%HERE%deploy.ps1"
where pwsh >nul 2>&1
if errorlevel 1 (
    echo [x] PowerShell 7 [pwsh] is required.
    pause
    exit /b 1
)

pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
