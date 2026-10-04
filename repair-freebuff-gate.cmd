@echo off
chcp 65001 >nul
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-freebuff-gate.ps1" %*
exit /b %ERRORLEVEL%
