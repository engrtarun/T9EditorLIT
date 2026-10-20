@echo off
REM Root entry point. The real gate is Clipchamp_Bunny\tools\deploy.ps1.
REM Double-click for the work-order form, or pass switches through:
REM   Deploy-T9EditorLIT.bat -Status
REM   Deploy-T9EditorLIT.bat -Doctor
setlocal
call "%~dp0Clipchamp_Bunny\tools\deploy.bat" %*
exit /b %ERRORLEVEL%
