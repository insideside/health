#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Тренер - установка на macOS и Linux
#  Запуск:  bash install.sh                  - обычная установка (с локальной ИИ)
#           bash install.sh --model qwen3:14b - другая модель (меньше памяти, слабее ответы)
#           bash install.sh --no-ai           - без локальной ИИ (всё основное работает и так)
#           bash install.sh --no-shortcut --no-widget
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

MODEL=""; AI=1; SHORTCUT=1; WIDGET=ask
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift ;;
    --no-ai) AI=0 ;;
    --no-shortcut) SHORTCUT=0 ;;
    --no-widget) WIDGET=no ;;
    -h|--help) sed -n '3,8p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1"; exit 2 ;;
  esac
  shift
done

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
warn() { printf "\033[33m! %s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m✗ %s\033[0m\n" "$1"; exit 1; }
ask()  { local a; read -r -p "$1 [Y/n] " a || a=n; [[ ! "$a" =~ ^[Nn] ]]; }

OS="$(uname -s)"; ARCH="$(uname -m)"
bold "Тренер - установка ($OS $ARCH)"
echo "Папка приложения: $ROOT"
if [[ "$OS" == "Darwin" ]]; then xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true; fi
command -v git >/dev/null 2>&1 && [[ -d "$ROOT/.git" ]] || warn "Приложение не из git clone - обновлять из приложения не получится (см. README, «Обновление»)."

# ── память компьютера → какая модель потянет ──
RAM_GB=0; VRAM_GB=0
if [[ "$OS" == "Darwin" ]]; then
  RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
else
  RAM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 ))
  if command -v nvidia-smi >/dev/null 2>&1; then
    VRAM_GB=$(( $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | sort -nr | head -1) / 1024 ))
  fi
fi
echo "Оперативная память: ${RAM_GB} ГБ${VRAM_GB:+, видеопамять NVIDIA: ${VRAM_GB} ГБ}"

# ── 1. uv ──
bold "1/5  Менеджер окружения uv"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  echo "Устанавливаю uv (https://docs.astral.sh/uv/)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh || fail "Не удалось установить uv. Проверьте интернет."
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "uv: $(uv --version)"

# ── 2. Python и библиотеки ──
bold "2/5  Python и библиотеки"
uv sync --frozen --no-dev || fail "Не удалось установить библиотеки."
PY="$ROOT/.venv/bin/python"

# ── 3. Локальная ИИ (Ollama) ──
bold "3/5  Локальная ИИ (Ollama)"
if [[ $AI == 1 ]]; then
  if [[ -z "$MODEL" ]]; then
    # qwen3:30b (MoE, ~19 ГБ): нужна память под модель + система. Меньше 32 ГБ ОЗУ (и нет видеокарты на 24 ГБ) -
    # предлагаем qwen3:14b (~9 ГБ): медленнее думает и чуть хуже по-русски, но работает.
    if (( RAM_GB >= 32 || VRAM_GB >= 20 )); then MODEL="qwen3:30b"
    elif (( RAM_GB >= 16 )); then
      warn "Для основной модели qwen3:30b нужно от 32 ГБ памяти, здесь ${RAM_GB} ГБ."
      if ask "Поставить облегчённую qwen3:14b (~9 ГБ)?"; then MODEL="qwen3:14b"; else AI=0; fi
    else
      warn "Памяти ${RAM_GB} ГБ - локальной ИИ не хватит. Приложение будет работать без неё (формулы, справочники, план)."
      AI=0
    fi
  fi
fi
if [[ $AI == 1 ]]; then
  if ! command -v ollama >/dev/null 2>&1; then
    if [[ "$OS" == "Darwin" ]]; then
      if command -v brew >/dev/null 2>&1; then
        brew install ollama || fail "Не удалось установить Ollama через Homebrew."
      else
        fail "Установите Ollama: https://ollama.com/download (приложение для macOS), затем запустите установку ещё раз."
      fi
    else
      echo "Устанавливаю Ollama (нужен пароль администратора)…"
      curl -fsSL https://ollama.com/install.sh | sh || fail "Не удалось установить Ollama. См. https://ollama.com/download/linux"
    fi
  fi
  # запустить сервис, если не запущен
  if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:11434/api/tags; then
    if [[ "$OS" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then brew services start ollama >/dev/null 2>&1 || true
    elif command -v systemctl >/dev/null 2>&1; then sudo systemctl enable --now ollama >/dev/null 2>&1 || true; fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null --max-time 1 http://127.0.0.1:11434/api/tags && break; (ollama serve >/dev/null 2>&1 &) ; sleep 2; done
  fi
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:11434/api/tags || fail "Ollama не запускается. Запустите её вручную (ollama serve) и повторите установку."
  echo "Скачиваю модель $MODEL (qwen3:30b ~19 ГБ, qwen3:14b ~9 ГБ; прерванная загрузка продолжится с места)…"
  ollama pull "$MODEL" || fail "Не удалось скачать модель. Запустите установку ещё раз - загрузка продолжится."
  if [[ "$MODEL" != "qwen3:30b" ]]; then
    echo "TRAINER_MODEL=$MODEL" > "$ROOT/settings.env"
    echo "Модель записана в settings.env"
  else
    rm -f "$ROOT/settings.env"
  fi
else
  echo "Без локальной ИИ: чат, разбор недели, программы и рецепты будут недоступны; всё остальное работает."
  echo "Поставить ИИ позже: bash install.sh (или вручную, см. README)."
fi

# ── 4. Проверка ──
bold "4/5  Проверка"
"$PY" -c "import app.server" >/dev/null || fail "Приложение не запускается - см. сообщения выше."
echo "Ок"

# ── 5. Ярлык и виджет ──
bold "5/5  Ярлык"
chmod +x "$ROOT/start.command" "$ROOT/start.sh" 2>/dev/null || true
if [[ $SHORTCUT == 1 && "$OS" == "Darwin" ]]; then
  APP="$HOME/Applications/Тренер.app"
  rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  sips -s format icns "$ROOT/app/static/icon-512.png" --out "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 || true
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Тренер</string>
  <key>CFBundleDisplayName</key><string>Тренер</string>
  <key>CFBundleIdentifier</key><string>local.trainer</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
  cat > "$APP/Contents/MacOS/launcher" <<LAUNCH
#!/bin/bash
# сервер Тренера (значок в Dock, пока работает; «Завершить» - остановить). ИИ поднимаем, если спит.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
curl -s -o /dev/null --max-time 1 http://127.0.0.1:11434/api/tags || { command -v brew >/dev/null && brew services start ollama >/dev/null 2>&1; }
cd "$ROOT"
exec "$PY" "$ROOT/run.py"
LAUNCH
  chmod +x "$APP/Contents/MacOS/launcher"; touch "$APP"
  echo "Приложение: $APP (можно перетащить в Dock)"
elif [[ $SHORTCUT == 1 && "$OS" == "Linux" ]]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/trainer.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Тренер
Exec="$ROOT/start.sh"
Icon=$ROOT/app/static/icon-512.png
Terminal=true
Categories=Utility;
DESK
  echo "Ярлык добавлен в меню приложений"
fi

if [[ "$OS" == "Darwin" && $WIDGET != no && -d "/Applications/Übersicht.app" ]]; then
  if [[ $WIDGET == yes ]] || ask "Найден Übersicht. Поставить виджет «Тренер» на рабочий стол?"; then
    bash "$ROOT/macos-widget/install.sh"
  fi
fi

HOSTNAME_LOCAL="$( [[ "$OS" == "Darwin" ]] && scutil --get LocalHostName 2>/dev/null || hostname -s )"
bold "Готово!"
if [[ "$OS" == "Darwin" && $SHORTCUT == 1 ]]; then
  echo "Запуск: «Тренер» в Программах (Launchpad / Spotlight) или двойной клик по start.command"
else
  echo "Запуск: $ROOT/start.sh"
fi
echo "На этом компьютере:  http://localhost:8791"
echo "Телефоны и планшеты: https://${HOSTNAME_LOCAL}.local:8790 - сначала поставьте сертификат (README, «Телефон и планшет»)"
