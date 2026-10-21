@echo off
REM =========================================================================
REM T9 Editor LIT - Sarkari Deploy & Governance Ecosystem
REM =========================================================================
REM Double-click to open Sarkari Interactive Deep Dossier Form,
REM or pass switches:
REM   Sarkari-Deploy.bat -Check     (Fast TypeScript + Rust check in seconds)
REM   Sarkari-Deploy.bat -Fast      (Autonomous fast deploy without prompts)
REM   Sarkari-Deploy.bat -Doctor    (Health, executable, daemon & rollback check)
REM   Sarkari-Deploy.bat -Status    (Recent sarkari deployment records)
REM   Sarkari-Deploy.bat -Rollback  (Instant manual restore to previous stable build)
REM   Sarkari-Deploy.bat -Court     (Sarkari Adalat: Active challans & docket)
REM   Sarkari-Deploy.bat -Vakil     (Sarkari Vakil: File safai nama / defense plea)
REM   Sarkari-Deploy.bat -Database  (Sarkari Central Database & Audit Inspector)
REM   Sarkari-Deploy.bat -Feedback  (Sujhaav, Shikayat & Samiksha portal)
REM =========================================================================
setlocal
set "HERE=%~dp0"
set "SARKARI_PS1=%HERE%sarkari_deploy\sarkariDeploy.ps1"

where pwsh >nul 2>&1
if errorlevel 1 (
    echo [x] PowerShell 7 [pwsh] is required.
    echo     winget install Microsoft.PowerShell
    echo.
    pause
    exit /b 1
)

if not exist "%SARKARI_PS1%" (
    echo [x] sarkariDeploy.ps1 not found at: "%SARKARI_PS1%"
    pause
    exit /b 1
)

set "ARGS=%*"
if /i "%~1"=="-Db" set "ARGS=-Database %~2 %~3 %~4 %~5"

if "%~1"=="" (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SARKARI_PS1%" -Interactive
) else (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SARKARI_PS1%" %ARGS%
)

set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
    echo.
    echo [x] Sarkari Deploy exited with code %CODE%.
    echo.
    if "%~1"=="" pause
)
exit /b %CODE%
