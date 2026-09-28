@echo off
rem Trainer installer for Windows 10/11. Double-click to install.
rem Options go to scripts\install.ps1: -Model qwen3:14b, -NoAi, -NoShortcut
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set RC=%ERRORLEVEL%
pause
exit /b %RC%
