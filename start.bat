@echo off
rem Start Trainer on Windows. Close the window to stop.
chcp 65001 >nul
cd /d "%~dp0"
where uv >nul 2>nul || (echo Нужен uv: https://docs.astral.sh/uv/ & pause & exit /b 1)
rem Ollama for Windows starts by itself after install (tray icon)
uv run run.py
pause
