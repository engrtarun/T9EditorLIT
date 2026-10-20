@echo off
REM Deprecated alias. The installed (taskbar) app wins; source builds use -Dev.
REM Kept so an old shortcut does not silently start the repository executable.
call "%~dp0Launch-T9EditorLIT.bat" %*
exit /b %ERRORLEVEL%
