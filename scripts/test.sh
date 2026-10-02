#!/bin/sh
# Тесты: Python (свежая временная база, без сети) и сверка разбора еды сервер = устройство в headless Chrome.
# Сверка запускается, если указан TRAINER_DATA тестового сервера и он отвечает на BASE (по умолчанию http://localhost:8891):
#   TRAINER_DATA=/путь/к/тестовым/данным TRAINER_PORT=8890 uv run run.py   (в другом окне)
#   TRAINER_DATA=/путь/к/тестовым/данным scripts/test.sh
set -e
cd "$(dirname "$0")/.."
uv run pytest -q tests
for f in app/static/*.js app/static/views/*.js; do node --check "$f"; done
echo "JS: синтаксис в порядке"
BASE=${BASE:-http://localhost:8891}
if [ -n "$TRAINER_DATA" ] && curl -s -m 2 "$BASE/api/version" >/dev/null; then
  [ -d tests/node_modules ] || (cd tests && PUPPETEER_SKIP_DOWNLOAD=1 npm i --silent)
  node tests/parity.mjs
else
  echo "сверка с устройством пропущена: нет TRAINER_DATA или сервер на $BASE не отвечает"
fi
