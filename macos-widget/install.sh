#!/usr/bin/env bash
# Ставит виджет «Тренер» в Übersicht (https://tracesof.net/uebersicht/).
# Шаблон trainer.widget/index.jsx копируется с подстановкой пути к папке приложения.
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$HERE/.." && pwd)"
DEST="$HOME/Library/Application Support/Übersicht/widgets/trainer.widget"

if [[ ! -d /Applications/Übersicht.app && ! -d "$HOME/Applications/Übersicht.app" ]]; then
  echo "⚠️  Übersicht не найден. Установите его: brew install --cask ubersicht (или https://tracesof.net/uebersicht/)"
fi
if [[ ! -x "$PROJ/.venv/bin/python" ]]; then
  echo "Готовлю окружение Python (uv sync)…"
  (cd "$PROJ" && uv sync)
fi

rm -rf "$DEST"   # в т.ч. старый симлинк
mkdir -p "$DEST"
# экранируем для sed: путь может содержать пробелы, кириллицу, &, /
ESC=$(printf '%s' "$PROJ" | sed 's/[&/\]/\\&/g')
sed "s/__PROJECT_DIR__/$ESC/" "$HERE/trainer.widget/index.jsx" > "$DEST/index.jsx"
echo "✅ Виджет установлен: $DEST"
echo "   Übersicht подхватит его сам (или меню Übersicht → Refresh All)."
