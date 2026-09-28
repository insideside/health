#!/bin/bash
# Двойной клик в Finder — запуск Тренера. Остановить: закрыть окно Терминала.
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "Нужен uv: brew install uv"; read; exit 1; }
if ! curl -s -o /dev/null http://127.0.0.1:11434/api/tags; then
  command -v ollama >/dev/null && brew services start ollama >/dev/null 2>&1
fi
uv run run.py
