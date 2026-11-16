@echo off
rem Runs build-installer.ps1 for this one process only; the system execution policy is not changed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1" %*
if errorlevel 1 (echo. & echo   The build did not finish - the lines above say why. & pause & exit /b 1)
echo.
pause
