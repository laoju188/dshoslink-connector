@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage-DshosLinkConnector.ps1" -Action status
echo.
pause
