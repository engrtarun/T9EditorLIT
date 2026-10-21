@echo off
REM Root entry point for T9EditorLIT deployment.
REM Automatically routes to Sarkari High-Speed Deploy Engine.
REM Pass switches through or double-click for interactive dossier:
REM   Deploy-T9EditorLIT.bat -Check
REM   Deploy-T9EditorLIT.bat -Doctor
REM   Deploy-T9EditorLIT.bat -Status
REM   Deploy-T9EditorLIT.bat -Rollback
REM   Deploy-T9EditorLIT.bat -Fast
setlocal
call "%~dp0Sarkari-Deploy.bat" %*
exit /b %ERRORLEVEL%
