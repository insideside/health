#!/usr/bin/env bash
# Запуск Тренера на Linux (и macOS из терминала). Остановить: Ctrl+C.
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "Нужен uv: https://docs.astral.sh/uv/ (curl -LsSf https://astral.sh/uv/install.sh | sh)"; exit 1; }
# локальная ИИ: если Ollama установлена, но не запущена — поднимаем её
if command -v ollama >/dev/null && ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:11434/api/tags; then
  (ollama serve >/dev/null 2>&1 &)
  sleep 2
fi
exec uv run run.py
