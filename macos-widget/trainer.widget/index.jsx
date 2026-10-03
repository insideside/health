// Тренер — десктоп-виджет для Übersicht (https://tracesof.net/uebersicht/).
// Шапка: индикатор + название + переключатель тем + тумблер вкл/выкл сервера.
// Индикатор свой, не «точка» других виджетов: кольцо дня — дуга терракоты показывает лучший процент
// чек-листа за сегодня (GET /api/widget/summary, только с этого Mac, без имён и личных данных),
// в центре «пульс» бьётся, пока сервер работает; сервер выключен — пустое серое кольцо.
// Тело: адрес для телефона, состояние локальной ИИ и кнопка «Открыть».
// Установка: bash macos-widget/install.sh (подставит путь к папке приложения)

import { run } from "uebersicht";

// ── общая раскладка виджетов: столбик с одинаковыми отступами ──
// Виджеты Übersicht живут в одном документе. Каждый помечает свой корень data-ins-stack="<порядок>",
// и любой из них раскладывает всех сверху вниз с равным зазором. Высота виджета меняется (трек,
// задача, выключен) — ResizeObserver сразу пересчитывает. Код одинаковый во всех виджетах
// (vk-music, cinema, photo-gallery, transkribator, trainer): меняете раскладку — меняйте везде.
const insStack = () => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const TOP = 40, LEFT = 40, GAP = 16;
  const layout = () => {
    const roots = [...document.querySelectorAll("[data-ins-stack]")]
      .sort((a, b) => Number(a.dataset.insStack) - Number(b.dataset.insStack));
    let y = TOP;
    for (const r of roots) {
      // обёртка виджета, которую Übersicht позиционирует абсолютно
      let box = r.parentElement;
      while (box && box !== document.body && getComputedStyle(box).position === "static") box = box.parentElement;
      if (!box || box === document.body) continue;
      box.style.top = y + "px";
      box.style.left = LEFT + "px";
      y += r.offsetHeight + GAP;
    }
  };
  if (!window.__insStack) window.__insStack = { ro: new ResizeObserver(() => layout()), seen: new WeakSet() };
  const st = window.__insStack;
  document.querySelectorAll("[data-ins-stack]").forEach((r) => {
    if (!st.seen.has(r)) { st.seen.add(r); st.ro.observe(r); }
  });
  requestAnimationFrame(layout);
};

// ── пути/порты (при необходимости поправьте) ──
const PROJ = "__PROJECT_DIR__"; // подставляет macos-widget/install.sh
const PY = PROJ + "/.venv/bin/python";
const LOG = PROJ + "/data/logs/server.out";
const HTTPS_PORT = 8790;
const HTTP_PORT = 8791;
const LOCAL = "http://127.0.0.1:" + HTTP_PORT;

export const refreshFrequency = 2000;

export const command = `
V=$(/usr/bin/curl -s --max-time 1 ${LOCAL}/api/version)
H=$(/usr/sbin/scutil --get LocalHostName 2>/dev/null)
if [ -n "$V" ]; then
  A=$(/usr/bin/curl -s --max-time 1 ${LOCAL}/api/ai/status)
  S=$(/usr/bin/curl -s --max-time 1 ${LOCAL}/api/widget/summary)
  case "$S" in \{*) ;; *) S=null ;; esac
  /usr/bin/printf '{"running":true,"host":"%s","ai":%s,"sum":%s}' "$H" "\${A:-null}" "\${S:-null}"
else
  /usr/bin/printf '{"running":false,"host":"%s"}' "$H"
fi
`;

// локальная ИИ (Ollama) нужна для расчётов — поднимаем её вместе с сервером, если спит
const startApp = () =>
  run(`/bin/mkdir -p "${PROJ}/data/logs" && cd "${PROJ}" && \
(/usr/bin/curl -s --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null || /opt/homebrew/bin/brew services start ollama >/dev/null 2>&1); \
/usr/bin/nohup "${PY}" run.py >> "${LOG}" 2>&1 &`);
// оба порта слушает один процесс; SIGTERM — сервер корректно завершится, задачи ИИ продолжатся при следующем запуске
const stopApp = () =>
  run(`/usr/sbin/lsof -ti tcp:${HTTP_PORT} -sTCP:LISTEN | /usr/bin/xargs kill 2>/dev/null`);
const openApp = () => run(`/usr/bin/open ${LOCAL}`);

// ── темы ──
const THEMES = ["auto", "dark", "light", "transparent"];
const readTheme = () => {
  try { return localStorage.getItem("tnWidgetTheme") || "auto"; } catch (e) { return "auto"; }
};
const applyTheme = (t) => {
  try { localStorage.setItem("tnWidgetTheme", t); } catch (e) {}
  const el = document.getElementById("tn-widget-root");
  if (el) el.className = "tn-root theme-" + t;
};
const cycleTheme = () => {
  const cur = readTheme();
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
};

// кольцо дня: r = 7 в поле 18×18, длина окружности 2πr ≈ 43.98
const RING_R = 7, RING_C = 2 * Math.PI * RING_R;
const DayRing = ({ running, pct }) => {
  const known = running && typeof pct === "number";
  const frac = known ? Math.max(0, Math.min(1, pct / 100)) : 0;
  const tip = !running ? "Сервер выключен"
    : known ? "Сегодня: " + pct + " % чек-листа (лучший день среди аккаунтов)" : "Сервер работает · сегодня ещё нет отметок";
  return (
    <span className={"tn-ring " + (running ? "on" : "off") + (frac >= 1 ? " full" : "")} title={tip}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle className="tn-ring-track" cx="9" cy="9" r={RING_R} />
        {known && frac > 0 ? (
          <circle className="tn-ring-arc" cx="9" cy="9" r={RING_R}
            strokeDasharray={(RING_C * frac).toFixed(2) + " " + RING_C.toFixed(2)} transform="rotate(-90 9 9)" />
        ) : null}
        {running ? <circle className="tn-ring-pulse" cx="9" cy="9" r="2.2" /> : null}
      </svg>
    </span>
  );
};

const I_EXT = "M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3zM19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2z";

export const render = ({ output }) => {
  insStack();
  let data = {};
  try { data = JSON.parse(output); } catch (e) {}
  const running = !!data.running;
  const ai = data.ai || null;
  const sum = data.sum && typeof data.sum === "object" ? data.sum : null;
  const theme = readTheme();
  return (
    <div id="tn-widget-root" data-ins-stack="5" className={"tn-root theme-" + theme}>
      <div className="tn-header">
        <DayRing running={running} pct={sum ? sum.pct : null} />
        <span className="tn-name" title="Открыть тренера" onClick={() => (running ? openApp() : startApp())}>
          Тренер
        </span>
        <span className="tn-theme" title={"Тема: " + theme} onClick={cycleTheme} />
        <div className={"tn-toggle " + (running ? "on" : "off")}
          title={running ? "Выключить сервер" : "Включить сервер"}
          onClick={() => (running ? stopApp() : startApp())}>
          <span className="tn-knob" />
        </div>
      </div>

      {running ? (
        <div className="tn-info">
          <div className="tn-row" title={ai ? (ai.ok ? "Модель " + (ai.model || "") + " - чат, разбор недели, рецепты" : (ai.reason || "") + ". Приложение работает, запросы к ИИ подождут в очереди") : ""}>
            <span className="tn-label">Локальная ИИ</span>
            <span className={"tn-val " + (ai && ai.ok ? "" : "warn")}>
              {ai ? (ai.ok ? "работает" : "не запущена") : "проверяю…"}
            </span>
          </div>
        </div>
      ) : null}

      <div className="tn-body">
        {running ? (
          <button className="tn-open" title="Открыть тренера в браузере" onClick={() => openApp()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d={I_EXT} /></svg>
            <span>Открыть</span>
          </button>
        ) : (
          <div className="tn-off">Выключено — нажмите тумблер</div>
        )}
      </div>
    </div>
  );
};

export const className = `
  top: 520px; left: 40px;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;

  .tn-root {
    --bg: rgba(23, 26, 33, 0.92);
    --fg: #e6e8ee;
    --muted: rgba(230, 232, 238, 0.55);
    --accent: #d4705a;
    --warn: #e0a458;
    --border: rgba(255, 255, 255, 0.10);
    --btn: rgba(255, 255, 255, 0.10);
    --btn-hover: rgba(255, 255, 255, 0.16);

    width: 270px; box-sizing: border-box;
    padding: 14px 16px 16px; border-radius: 16px;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border);
    box-shadow: 0 8px 30px rgba(0,0,0,0.35);
    -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    user-select: none;
  }
  .tn-root.theme-light {
    --bg: rgba(250,250,252,0.95); --fg:#1c1c20; --muted: rgba(28,28,32,0.5); --accent: #b5533d; --warn: #a3651c;
    --border: rgba(0,0,0,0.08); --btn: rgba(0,0,0,0.06); --btn-hover: rgba(0,0,0,0.12);
  }
  .tn-root.theme-transparent {
    --bg: rgba(0,0,0,0.18); --fg:#fff; --muted: rgba(255,255,255,0.7);
    --border: rgba(255,255,255,0.18); --btn: rgba(255,255,255,0.14); --btn-hover: rgba(255,255,255,0.25);
    text-shadow: 0 1px 3px rgba(0,0,0,0.5); box-shadow: none;
  }
  @media (prefers-color-scheme: light) {
    .tn-root.theme-auto {
      --bg: rgba(250,250,252,0.95); --fg:#1c1c20; --muted: rgba(28,28,32,0.5); --accent: #b5533d; --warn: #a3651c;
      --border: rgba(0,0,0,0.08); --btn: rgba(0,0,0,0.06); --btn-hover: rgba(0,0,0,0.12);
    }
  }

  .tn-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }

  .tn-ring { width: 18px; height: 18px; flex: 0 0 auto; display: inline-flex; }
  .tn-ring svg { display: block; overflow: visible; }
  .tn-ring-track { fill: none; stroke: var(--muted); stroke-width: 2; opacity: 0.45; }
  .tn-ring.on .tn-ring-track { opacity: 0.3; }
  .tn-ring.off .tn-ring-track { stroke-dasharray: 2.2 2.2; }
  .tn-ring-arc { fill: none; stroke: var(--accent); stroke-width: 2.4; stroke-linecap: round; transition: stroke-dasharray 0.6s ease; }
  .tn-ring.full .tn-ring-arc { filter: drop-shadow(0 0 3px var(--accent)); }
  /* «пульс»: двойной удар, как на кардиограмме, раз в 1,6 с */
  .tn-ring-pulse { fill: var(--accent); transform-origin: 9px 9px; animation: tn-beat 1.6s ease-in-out infinite; }
  @keyframes tn-beat {
    0%, 40%, 100% { transform: scale(1); opacity: 0.85; }
    12% { transform: scale(1.45); opacity: 1; }
    24% { transform: scale(1.05); opacity: 0.9; }
    32% { transform: scale(1.3); opacity: 1; }
  }

  .tn-name { font-size: 13px; font-weight: 600; letter-spacing: 0.2px;
    flex: 1 1 auto; min-width: 0; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tn-name:hover { color: var(--accent); }

  .tn-theme { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; cursor: pointer;
    /* свой кружок: смысловые цвета приложения (тренировки, питание, движение, вода, сон) с бликом -
       терракота + чернила были у «Транскрибатора» */
    background: radial-gradient(circle at 32% 28%, rgba(255,255,255,0.75), rgba(255,255,255,0) 45%),
      conic-gradient(#ef7458, #f2b447, #6fd48f, #4cc6ea, #8f9dff, #ef7458);
    border: 1px solid var(--border); opacity: 0.85; }
  .tn-theme:hover { opacity: 1; transform: scale(1.1); }

  .tn-toggle { width: 40px; height: 24px; border-radius: 13px; flex: 0 0 auto;
    cursor: pointer; position: relative; background: var(--btn);
    border: 1px solid var(--border); transition: background 0.2s; }
  .tn-toggle.on { background: var(--accent); border-color: transparent; }
  .tn-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    transition: left 0.2s; }
  .tn-toggle.on .tn-knob { left: 19px; }

  .tn-info { margin-bottom: 12px; }
  .tn-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; line-height: 1.7; }
  .tn-label { color: var(--muted); flex: 0 0 auto; }
  .tn-val { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
  .tn-val.warn { color: var(--warn); }

  .tn-body { display: flex; }
  .tn-open {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 14px;
    border: none; cursor: pointer; color: var(--fg);
    background: var(--btn); border-radius: 10px;
    font-size: 13px; font-weight: 500;
    transition: background 0.15s, transform 0.1s;
  }
  .tn-open span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tn-open svg { flex: 0 0 auto; }
  .tn-open:hover { background: var(--btn-hover); }
  .tn-open:active { transform: scale(0.98); }
  .tn-off { flex: 1 1 auto; height: 40px; display: flex; align-items: center;
    justify-content: center; color: var(--muted); font-size: 12px; }
`;
