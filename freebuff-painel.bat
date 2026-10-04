@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-freebuff-panel.ps1"
if errorlevel 1 pause
