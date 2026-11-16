@echo off
rem Runs build-store.ps1 for this one process only; the system execution policy is not changed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-store.ps1" %*
if errorlevel 1 (echo. & echo   The package was not made - the lines above say why. & pause & exit /b 1)
echo.
pause
