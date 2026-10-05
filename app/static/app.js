// «Тренер»: оболочка приложения — навигация, маршруты, события, фоновые задачи.
// Экраны живут в views/*.js: каждый экспортирует routes, actions и по желанию changes,
// afterRender (после отрисовки) и background (раз в цикл опроса, пока приложение открыто).
import * as store from './store.js';
import * as C from './coach.js';
import { S, ExMap, esc, svg, ring, field, toast, openModal, closeModal, confirmAction, showTech, afterChange, isModalOpen, glyph, exCtx, profile as userProfile } from './ui.js';
import * as today from './views/today.js';
import * as calendar from './views/calendar.js';
import * as food from './views/food.js';
import * as workout from './views/workout.js';
import * as progress from './views/progress.js';
import * as profile from './views/profile.js';
import * as chat from './views/chat.js';
import * as together from './views/together.js';
import * as health from './views/health.js';
import * as about from './views/about.js';
import * as install from './views/install.js';
import * as connect from './views/connect.js';
import * as fit from './views/fit.js';
import * as supp from './views/supp.js';
import * as SPS from './supps.js';
import * as advice from './views/advice.js';
import * as report from './views/report.js';
import * as pcopy from './views/pcopy.js';

const BUILD = document.querySelector('meta[name=build]').content;
const $app = document.getElementById('app');
const VIEWS = [today, calendar, food, workout, chat, progress, profile, together, health, connect, about, install, fit, supp, advice, report, pcopy];

const NAV = [['today', 'Сегодня'], ['calendar', 'Календарь'], ['food', 'Питание'], ['workout', 'Спорт'],
  ['chat', 'Тренер'], ['progress', 'Прогресс'], ['profile', 'Профиль']];
// какой пункт меню подсвечивать для вложенных экранов
// цвет значка активного пункта — по смыслу раздела (accents.css)
const NAV_DOM = { today: 'coach', calendar: 'goal', food: 'food', workout: 'train', chat: 'coach', progress: 'goal' };
const NAV_OF = { feed: 'progress', advice: 'chat', install: 'profile', about: 'profile', together: 'progress', health: 'profile', connect: 'profile', day: 'today', program: 'workout', generator: 'workout', week: 'progress', body: 'progress', sleep: 'today' };

const routes = Object.assign({}, ...VIEWS.map(v => v.routes || {}));
const actions = Object.assign({}, ...VIEWS.map(v => v.actions || {}));
const changes = Object.assign({}, ...VIEWS.map(v => v.changes || {}));
// действия, которые стирают данные: сначала окно подтверждения (ui.confirmAction), и только потом сам обработчик.
// Экран описывает окно функцией `confirms[act] = el => ({ title, text, ok }) | null`; все кнопки удаления - здесь.
const confirms = Object.assign({}, ...VIEWS.map(v => v.confirms || {}));

// ── маршрут и перерисовка ──
function route() {
  const [view, arg] = (location.hash.slice(1) || 'today').split('/');
  return { view: routes[view] ? view : 'today', arg };
}

function isEditing() {
  const a = document.activeElement;
  return a && $app.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' ||
    (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
}
let renderPending = false;
// Нажатие на кнопку, пока в поле ввода курсор: поле теряет фокус уже при нажатии (mousedown/touchstart), и если
// отложенная перерисовка сработает до отпускания, кнопка под пальцем заменится новой - браузер не засчитает
// click, и кнопку приходится жать второй раз. Пока нажатие не закончилось, перерисовку держим.
let pressing = false, pressTimer = null;
const flushPending = () => { if (renderPending && !isEditing() && !pressing) { renderPending = false; render(); } };
const release = () => { pressing = S.pressing = false; flushPending(); };
const endPress = () => {
  clearTimeout(pressTimer);
  // click приходит после pointerup (на iOS - чуть позже): отпускаем после него или через запас по времени
  pressTimer = setTimeout(release, 350);
};
document.addEventListener('pointerdown', () => { pressing = S.pressing = true; clearTimeout(pressTimer); }, true);
document.addEventListener('pointerup', endPress, true);
document.addEventListener('pointercancel', endPress, true);
document.addEventListener('click', () => { if (!pressing) return; clearTimeout(pressTimer); pressTimer = setTimeout(release, 0); }, true);
function scheduleRender() {
  // невидимую страницу не рисуем (батарея) — нарисуем один раз, когда её откроют
  if (isEditing() || document.hidden || pressing) { renderPending = true; return; }
  render();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushPending(); });
document.addEventListener('focusout', () => setTimeout(flushPending, 0));

window.addEventListener('hashchange', () => {
  for (const k of Object.keys(S.forms)) delete S.forms[k];
  window.scrollTo(0, 0);
  render();
});

const BADGE = '\u0000badge\u0000';
let lastHtml = '', lastBadge = '', lastView = '';

// Точечное обновление DOM: from приводится к to узел за узлом. Другой тег или id - узел заменяется целиком;
// текст и атрибуты - правятся на месте. style, который экран выставил сам (высота списка чата и т. п.), не стираем,
// если в новой разметке его нет. Поле в фокусе не трогаем (рисование и так ждёт, пока человек печатает).
function morph(from, to) {
  const a = [...from.childNodes], b = [...to.childNodes];
  for (let i = 0; i < b.length; i++) {
    const x = a[i], y = b[i];
    if (!x) { from.appendChild(y); continue; }
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName || (x.nodeType === 1 && x.id !== y.id)) { from.replaceChild(y, x); continue; }
    if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name) && at.name !== 'style') x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    if (x === document.activeElement) continue;
    if (x.tagName === 'INPUT') {
      if (x.type === 'checkbox' || x.type === 'radio') x.checked = y.checked;
      else if (x.value !== y.value) x.value = y.value;
      continue;
    }
    if (x.tagName === 'TEXTAREA') { if (x.value !== y.value) x.value = y.value; continue; }
    if (x.tagName === 'DETAILS') x.open = y.open;
    morph(x, y);
    if (x.tagName === 'SELECT' && x.value !== y.value) x.value = y.value;
  }
  for (let i = a.length - 1; i >= b.length; i--) from.removeChild(a[i]);
}
// после ввода и нажатий DOM мог разойтись с прошлым HTML (набранный текст, раскрытые блоки) - тогда перерисовываем всегда
let touched = false;
for (const ev of ['input', 'change', 'click', 'submit', 'toggle']) document.addEventListener(ev, () => { touched = true; }, true);
function render() {
  if (!store.me()) { lastHtml = ''; return renderAuth(); }
  const { view, arg } = route();
  const navKey = NAV_OF[view] || view;
  let body;
  try { body = routes[view](arg); } catch (e) { console.error(e); body = `<div class="notice">Ошибка отрисовки: ${esc(e.message)}</div>`; }
  const y = window.scrollY;
  const dot = k => ((k === 'chat' && unreadChat()) || (k === 'food' && food.choicesCount()) ? '<span class="dot"></span>' : '');
  const html = `
    <header class="masthead">
      <a class="wordmark" href="#today"><b>Тренер<i>.</i></b></a>
      <div class="mast-actions"><span class="sync-slot">${BADGE}</span>
        <div class="theme-switch" role="group" aria-label="Тема"><button data-theme-set="auto" title="Как в системе">Авто</button><button data-theme-set="dark" aria-label="Тёмная тема" title="Тёмная тема">${glyph('night')}</button><button data-theme-set="light" aria-label="Светлая тема" title="Светлая тема">${glyph('sun')}</button></div>
      </div>
    </header>
    <div class="layout">
      <aside class="nav">${NAV.map(([k, l]) => `<a href="#${k}" class="${navKey === k ? 'on' : ''}" ${NAV_DOM[k] ? `data-dom="${NAV_DOM[k]}"` : ''}>${svg(k)}${l}${dot(k)}</a>`).join('')}
        ${asideCards()}</aside>
      <main><div class="wrap"><div class="sheet">${body}</div></div></main>
    </div>
    <nav class="tabbar">${NAV.map(([k, l]) => `<a href="#${k}" class="${navKey === k ? 'on' : ''}" ${NAV_DOM[k] ? `data-dom="${NAV_DOM[k]}"` : ''}>${svg(k)}${dot(k)}<span>${l}</span></a>`).join('')}</nav>`;
  // Фон (опрос раз в 15 с, каждая синхронизация) просит перерисовку и тогда, когда ничего не поменялось. Полная
  // замена страницы сбрасывает прокрутку внутренних областей, выделение, наведение - выглядит как перезагрузка.
  // Ничего не изменилось - не трогаем; изменилась только метка синхронизации в шапке - меняем только её.
  // проблема сервера (копия не удалась, внешний источник не отвечает) - метка в шапке, подробности в «Как это работает»
  const alert = store.state.online ? about.serverAlerts() : '';
  const badge = (alert ? `<a class="sync conflict ops-alert" href="#about" title="${esc(alert)}">сервер: проблема</a>` : '') + syncBadge(),
    slot = $app.querySelector('.sync-slot');
  if (html === lastHtml && slot && !touched) {
    if (badge !== lastBadge) { slot.innerHTML = badge; lastBadge = badge; }
    return;
  }
  lastHtml = html; lastBadge = badge; touched = false;
  // первая отрисовка и смена экрана - целиком; дальше точечно: меняются только отличающиеся тексты, атрибуты и узлы
  // (часы в поле времени, «через 5 мин», цифры) - прокрутка областей, фокус, раскрытые блоки, наведение остаются
  if (lastView !== view + '|' + arg || !$app.querySelector('.layout')) $app.innerHTML = html.replace(BADGE, badge);
  else { const t = document.createElement('template'); t.innerHTML = html.replace(BADGE, badge); morph($app, t.content); }
  lastView = view + '|' + arg;
  window.scrollTo(0, y);
  mhLastY = window.scrollY;
  applyMasthead();
  for (const v of VIEWS) if (v.routes?.[view] && v.afterRender) v.afterRender(arg);
}
S.render = scheduleRender;

// ── шапка: уезжает при прокрутке вниз, сразу выезжает при прокрутке вверх (у верха страницы видна всегда) ──
let mhHidden = false, mhLastY = window.scrollY;
function applyMasthead() {
  const m = document.querySelector('.masthead');
  if (!m) return;
  m.classList.toggle('mh-hide', mhHidden);
  m.classList.toggle('mh-float', !mhHidden && window.scrollY > 4);
  // левое меню на широком экране прилипает под шапкой, пока она видна
  document.documentElement.style.setProperty('--mh-offset', mhHidden ? '0px' : `${m.offsetHeight}px`);
}
// Зум запрещён: iOS Safari игнорирует user-scalable=no в метатеге, поэтому щипок гасим сами
// (gesture* - только в Safari; в Chrome хватает метатега).
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// iOS (режим приложения): после закрытия клавиатуры панель вкладок с position: fixed «отклеивается» - висит выше
// низа экрана. Причина (iOS 26): window.innerHeight, visualViewport.height и 100dvh остаются уменьшенными до конца
// сеанса. Пока клавиатура открыта - панель прячем (она и так под клавиатурой); после закрытия, если высота окна
// меньше прежней для этой ширины, заставляем WebKit перемерить экран: body на мгновение display: none →
// синхронная перекладка → обратно (без отрисовки между ними; прокрутку возвращаем). Кнопка «Готово» прячет
// клавиатуру, не снимая фокус с поля, - такое замечаем по росту visualViewport и снимаем фокус сами.
const isTyping = () => !!document.activeElement?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select, [contenteditable="true"]');
const hasPicker = () => !!document.activeElement?.matches?.('select, input[type=time], input[type=date], input[type=datetime-local], input[type=month], input[type=week], input[type=color], input[type=file]');
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const fullH = new Map();          // ширина окна → наибольшая высота (поворот экрана меняет ширину)
const noteHeight = () => { const w = Math.round(window.innerWidth); fullH.set(w, Math.max(fullH.get(w) || 0, window.innerHeight)); };
noteHeight();
function healViewport() {
  if (isTyping()) return;
  document.documentElement.classList.remove('kb-open');
  const full = fullH.get(Math.round(window.innerWidth)) || 0;
  if (IOS && (full - window.innerHeight > 4 || (window.visualViewport?.offsetTop || 0) > 1)) {
    const y = window.scrollY, b = document.body;
    // прокрутка внутри (лента чата, окно) при display: none сбрасывается - запоминаем и возвращаем
    const inner = [...document.querySelectorAll('.chat-list, .modal-body, .modal')].map(el => [el, el.scrollTop]);
    b.style.display = 'none';
    void b.offsetHeight;                // синхронная перекладка - WebKit пересчитывает размеры окна
    b.style.display = '';
    window.scrollTo(0, y);
    for (const [el, t] of inner) el.scrollTop = t;
  }
  window.scrollBy(0, 1); window.scrollBy(0, -1);     // и закреплённые элементы - на место
  noteHeight();
}
let vvLast = window.visualViewport?.height || 0;
function syncKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const full = fullH.get(Math.round(window.innerWidth)) || window.innerHeight;
  const open = isTyping() && vv.height < full * 0.8;
  // «Готово» над клавиатурой: клавиатура закрылась (видимая часть выросла), а поле всё ещё в фокусе
  // Только у поля с клавиатурой: переход из текста в поле времени/даты или список тоже закрывает клавиатуру,
  // а их колесо выбора от blur() сразу схлопывается
  if (isTyping() && !hasPicker() && !open && vv.height - vvLast > 120) document.activeElement.blur();
  vvLast = vv.height;
  const root = document.documentElement, was = root.classList.contains('kb-open');
  if (open === was) { if (!open && !isTyping()) noteHeight(); return; }
  root.classList.toggle('kb-open', open);
  if (!open) setTimeout(healViewport, 140);
}
window.visualViewport?.addEventListener('resize', syncKeyboard);
window.addEventListener('resize', () => { if (!isTyping()) noteHeight(); });
document.addEventListener('focusin', () => setTimeout(syncKeyboard, 350));
document.addEventListener('focusout', () => { setTimeout(() => { syncKeyboard(); healViewport(); }, 140); setTimeout(healViewport, 600); });
// вернулись в приложение (из фона, из другого приложения) - тоже бывает «отклеено»
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(healViewport, 250); });
window.addEventListener('pageshow', () => setTimeout(healViewport, 250));
window.addEventListener('orientationchange', () => setTimeout(healViewport, 400));

window.addEventListener('scroll', () => {
  const y = window.scrollY, dy = y - mhLastY;
  if (y < 40) mhHidden = false;
  else if (dy > 4) mhHidden = true;          // вниз - убираем
  else if (dy < -4) mhHidden = false;        // вверх - сразу показываем
  else return;
  mhLastY = y;
  applyMasthead();
}, { passive: true });

function unreadChat() {
  const seen = store.getMeta('chat_seen', 0);
  return store.list('chat').some(m => m.data.role === 'coach' && (m.data.created || m.updated_at) > seen);
}

function syncBadge() {
  const n = store.pendingCount(), k = store.conflicts().length;
  const cls = k ? 'conflict' : !store.state.online ? 'offline' : n || store.state.syncing ? 'pending' : '';
  const text = k ? `конфликты · ${k}` : !store.state.online ? `офлайн${n ? ` · ${n} ждут` : ''}`
    : store.state.syncing ? 'синхронизация…' : n ? `отправка · ${n}` : 'синхронизировано';
  // модель на сервере спит: запросы к ИИ ждут в очереди (у кого ИИ выключена в профиле - метка не нужна)
  const sleep = store.state.online && store.state.ai === false && userProfile().ai !== 'off'
    ? `<button class="sync ai-sleep" data-act="ai-sleep" title="ИИ на сервере не запущена">ИИ спит</button>` : '';
  const upd = updateReady ? '<button class="sync update" data-act="app-update-local" title="Есть новая версия приложения - обновить сейчас">обновление</button>' : '';
  return `${sleep}${upd}<button class="sync ${cls}" data-act="sync-panel" title="Синхронизация и обновление">${text}</button>`;
}

// ── синхронизация, обновление, конфликты ──
const KIND_NAME = { profile: 'Профиль', goal: 'Цели', target: 'Нормы', item: 'Пункт чек-листа', log: 'Отметка чек-листа',
  food: 'Запись о еде', body: 'Вес и замеры', workout: 'Тренировка', program: 'Программа', sleep: 'Сон', state: 'Самочувствие',
  daytype: 'Тип дня', activity: 'Активность', injury: 'Травма', routine: 'Разминка', favfood: 'Избранное блюдо', chat: 'Сообщение', drink: 'Чашка чая или кофе', supp: 'Приём добавки',
  dsum: 'Итог дня', wsum: 'Итог недели', ach: 'Достижение', coach: 'Разбор тренера', mtest: 'Тест', vitals: 'Пульс и HRV',
  period: 'Цикл', pairwarm: 'Общий комплекс', smoke: 'Отметка о курении', alcohol: 'Отметка об алкоголе', highlight: 'Веха для группы' };
const FIELD_NAME = { v: 'значение', bed: 'лёг', wake: 'встал', weight: 'вес', text: 'текст', meal: 'приём пищи', time: 'время',
  wellbeing: 'самочувствие', soreness: 'мышцы', stress: 'стресс', sleepy: 'сонливость', note: 'заметка', type: 'тип', minutes: 'минуты',
  intensity: 'интенсивность', title: 'название', done: 'выполнено', reps: 'повторы', name: 'имя', height: 'рост',
  id: 'упражнение', exercise_id: 'упражнение', sets: 'подходы', rest: 'отдых', alarm: 'первый будильник', alarms: 'будильников',
  awakening: 'пробуждение', fall: 'засыпание', continuity: 'сон', rise: 'подъём', grams: 'граммы', kcal: 'калории', p: 'белки',
  f: 'жиры', c: 'углеводы', items: 'продукты', exercises: 'упражнения', amount: 'количество', dose: 'доза', distance_km: 'расстояние',
  waist: 'талия', start: 'начало', end: 'конец', status: 'состояние', pinned: 'закреплённые', place: 'место', date: 'дата' };

// id упражнения → название из справочника на устройстве
const exName = id => (store.getMeta('exercises', null) || []).find(e => e.id === id)?.name || null;
// значение по пути вида exercises[2].done[1] внутри data записи
function atPath(data, path) {
  let v = data;
  for (const part of String(path).match(/[^.[\]]+/g) || []) { if (v == null) return undefined; v = v[part]; }
  return v;
}
const ownerName = o => o && typeof o === 'object' && !Array.isArray(o) ? (o.name || o.title || exName(o.exercise_id || o.id)) : null;

// «выполнено» у пятого упражнения разминки → «Махи ногами в сторону: выполнено, подход 2»
function fieldLabel(path, c) {
  const p = String(path);
  if (p === '(удаление)') return 'запись';
  const last = p.replace(/\[\d+\]/g, '').split('.').filter(Boolean).pop() || '';
  let label = (c?.kind === 'food' && p === 'text' ? 'что съедено' : null) || FIELD_NAME[last] || 'другие данные';
  const set = /\.done\[(\d+)\]$/.exec(p);
  if (set) label += `, подход ${Number(set[1]) + 1}`;
  // ближайший элемент списка с названием (упражнение, продукт) - в начало подписи
  const cuts = [...p.matchAll(/\[\d+\]/g)].map(m => m.index + m[0].length).reverse();
  for (const cut of cuts) {
    const pre = p.slice(0, cut);
    const nm = c ? ownerName(atPath(c.local.data, pre)) || ownerName(atPath(c.server.data, pre)) : null;
    if (nm && !(last === 'id' || last === 'exercise_id')) return `${nm}: ${label}`;
    if (nm) break;
  }
  return label;
}
function valueLabel(v, path = '') {
  if (v === true) return 'да';
  if (v === false) return 'нет';
  if (v == null || v === '') return 'пусто';
  if (/(^|\.)(id|exercise_id)$/.test(String(path)) && typeof v === 'string') return exName(v) || 'другое упражнение';
  if (Array.isArray(v)) {
    if (v.every(x => x === null || typeof x !== 'object')) return v.length ? v.map(x => x === true ? 'да' : x === false ? 'нет' : x ?? '-').join(', ') : 'пусто';
    const names = v.map(ownerName).filter(Boolean);
    return names.length ? names.join(', ').slice(0, 80) : `${v.length} шт.`;
  }
  if (typeof v === 'object') return ownerName(v) || 'другой вариант';
  const t = String(v);
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}
const fmtStamp = ms => ms ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms) : '';

// выбор по строкам: id записи → ['local' | 'server', …] по спорным полям; по умолчанию - более свежая правка
const conflictPicks = new Map();
function picksFor(c) {
  let p = conflictPicks.get(c.id);
  if (!p || p.length !== c.fields.length) { p = c.fields.map(() => c.newer); conflictPicks.set(c.id, p); }
  return p;
}

// что это за запись, чтобы было понятно, о чём спор: «Обед 13:10 · гречка с курицей», «Сон · ночь на 1 октября»
const MEAL_NAME = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' };
const clip = (t, n = 60) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function recordTitle(c) {
  const d = { ...(c.server.data || {}), ...(c.local.data || {}) }, kind = c.kind;
  const bits = [];
  if (kind === 'food') {
    bits.push([MEAL_NAME[d.meal] || 'Еда', d.time].filter(Boolean).join(' '));
    const text = d.text || (d.items || []).map(i => i.name).filter(Boolean).join(', ');
    if (text) bits.push(`«${clip(text)}»`);
  } else if (kind === 'sleep') bits.push('Сон, ночь на это число');
  else if (kind === 'activity') bits.push([today.activityName(d.type), d.minutes ? `${d.minutes} мин` : ''].filter(Boolean).join(', '));
  else if (kind === 'workout') bits.push(['Тренировка', d.title && `«${clip(d.title, 40)}»`].filter(Boolean).join(' '));
  else if (kind === 'supp') bits.push(['Добавка', d.name, d.time].filter(Boolean).join(' '));
  else if (kind === 'drink') bits.push(['Чашка', d.time].filter(Boolean).join(' '));
  else if (kind === 'log') {
    const item = store.get(String(c.id).split(':').pop());
    bits.push(item?.data?.title ? `Чек-лист: ${item.data.title}` : KIND_NAME.log);
  } else bits.push(KIND_NAME[kind] || 'Запись');
  if (c.date) bits.push(new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(C.parse(c.date)));
  return bits.filter(Boolean).join(' · ');
}

function conflictHtml(c) {
  const picks = picksFor(c);
  const side = (f, i, who) => {
    const on = picks[i] === who;
    return `<button class="conflict-opt${on ? ' on' : ''}" data-act="conflict-pick" data-id="${esc(c.id)}" data-i="${i}" data-choice="${who}" aria-pressed="${on}">
      <span class="smallcaps muted">${who === 'local' ? 'на этом устройстве' : 'с другого устройства'}</span><span class="conflict-val">${esc(valueLabel(who === 'local' ? f.local : f.server, f.path))}</span></button>`;
  };
  return `<div class="raised card conflict-card">
    <div class="conflict-title">${esc(recordTitle(c))}</div>
    <p class="note">Эту запись изменили и здесь (${esc(fmtStamp(c.local.updated_at))}), и на другом устройстве (${esc(fmtStamp(c.server.updated_at))}) - по-разному. Отмечено более свежее, в каждой строке можно выбрать иначе.</p>
    <div class="conflict-rows">
      ${c.fields.map((f, i) => `<div class="conflict-row"><div class="conflict-field">${esc(fieldLabel(f.path, c))}</div>${side(f, i, 'local')}${side(f, i, 'server')}</div>`).join('')}
    </div>
    <div class="actions conflict-actions">
      <button class="btn solid" data-act="conflict" data-id="${esc(c.id)}" data-choice="fields">Применить выбор</button>
      <button class="btn quiet" data-act="conflict" data-id="${esc(c.id)}" data-choice="merge" title="Сложить всё, что можно сложить; в спорном - более свежая правка, тексты склеить">Объединить сами</button>
    </div></div>`;
}

function syncPanel() {
  const cs = store.conflicts(), n = store.pendingCount();
  const last = store.state.lastSync ? new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(store.state.lastSync) : 'ещё не было';
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Данные</div><h2>Синхронизация</h2></div>
    <div class="modal-body">
      <p class="small">${store.state.online ? 'Сервер на связи.' : 'Сервер недоступен - правки сохраняются на этом устройстве и уйдут при подключении.'}
        Последний обмен: <span class="mono">${esc(last)}</span>. Ждут отправки: <span class="mono">${n}</span>.</p>
      ${store.state.error ? `<p class="err">${esc(store.state.error)}</p>` : ''}
      ${cs.length ? `<div class="notice">Одну и ту же запись изменили на двух устройствах по-разному. Разные записи (обед на компьютере и перекус на телефоне) не спорят - сохраняются обе, здесь только то, где значения расходятся. В каждой строке выберите, что оставить, и нажмите «Применить выбор».</div>
        ${cs.map(conflictHtml).join('')}
        ${cs.length > 1 ? `<div class="actions"><span class="note">Для всех:</span>
          <button class="btn quiet" data-act="conflict-all" data-choice="local">Как на этом устройстве</button>
          <button class="btn quiet" data-act="conflict-all" data-choice="server">Как на другом</button>
          <button class="btn quiet" data-act="conflict-all" data-choice="merge">Объединить</button></div>` : ''}`
        : '<p class="note">Конфликтов нет: изменения с разных устройств дополняют друг друга.</p>'}
      <div class="actions"><button class="btn quiet" data-act="cn-open">Адреса сервера${store.usingMirror() ? ' · сейчас запасной' : ''} <span class="arrow">→</span></button>
        <button class="btn quiet" data-act="app-update" ${store.state.online ? '' : 'disabled'}>Обновить приложение</button></div>
      <p class="note">${store.state.online ? '«Обновить приложение» проверит новую версию на GitHub (если сервер установлен оттуда) и загрузит свежую версию экрана; ваши данные не пропадут.' : 'Обновить приложение можно, когда сервер на связи: без него после перезагрузки оно бы не открылось.'}</p>
    <p class="note"><a class="link" href="#about" data-act="close-go">Что работает без сети, а что - только с сервером</a></p>
    </div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Закрыть</button>
      <button class="btn${cs.length ? '' : ' solid'}" data-act="sync-now" ${store.state.online ? '' : 'disabled'}>Синхронизировать</button></div>`);
}

// новый конфликт — показываем панель сами (один раз на набор)
let shownConflicts = '';
function watchConflicts() {
  const ids = store.conflicts().map(c => c.id).sort().join(',');
  if (ids && ids !== shownConflicts && !isModalOpen()) { shownConflicts = ids; syncPanel(); }
  if (!ids) shownConflicts = '';
}


function asideCards() {
  const lv = C.level(C.totalXp());
  const st = C.streaks();
  let html = `<div class="raised nav-card" data-dom="goal"><div class="smallcaps muted">Уровень ${lv.n} · ${esc(lv.title)}</div>
    <div class="groove" style="margin:8px 0 6px"><div class="fill" style="width:${Math.round(lv.frac * 100)}%"></div></div>
    <div class="note">Серия: ${st.current} дн.${st.best > st.current ? ` · рекорд ${st.best}` : ''}</div></div>`;
  for (const p of store.partners()) {
    const pct = C.pctOf(C.today(), p.id), ps = C.streaks(p.id);
    html += `<div class="raised nav-card partner">${ring(pct, 40, 4, 'sm')}<div class="ell"><div class="name ell">${esc(p.name)}</div>
      <div class="note">серия ${ps.current} дн.</div></div></div>`;
  }
  return html;
}

// ── вход ──
let authMode = 'login', authInfo = null;
async function renderAuth() {
  if (!authInfo) {
    try { authInfo = await store.api('/api/auth/state'); } catch (e) { authInfo = { offline: true }; }
    if (!authInfo.has_users && !authInfo.offline) authMode = 'register';
  }
  const reg = authMode === 'register';
  $app.innerHTML = `<div class="auth"><div class="sheet">
    <div class="kicker smallcaps">Тренер</div>
    <h1>${reg ? 'Новый аккаунт' : 'Вход'}</h1>
    ${authInfo.offline ? '<div class="notice">Сервер недоступен. Для первого входа нужно подключение к компьютеру с Тренером.</div>' : ''}
    ${authInfo.has_users && authInfo.can_register ? `<div class="tabs2" style="margin-top:14px">
      <button data-act="auth-mode" data-mode="login" class="${reg ? '' : 'on'}">Вход</button>
      <button data-act="auth-mode" data-mode="register" class="${reg ? 'on' : ''}">Регистрация</button></div>` : ''}
    <form id="auth-form">
      ${reg ? field('Имя', '<input class="control" name="name" autocomplete="name" required>') : ''}
      ${field('Логин', '<input class="control" name="login" autocapitalize="off" autocomplete="username" required>')}
      ${field('Пароль', `<input class="control" type="password" name="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>`)}
      <div class="err" id="auth-err"></div>
      <button class="btn solid" type="submit">${reg ? 'Создать' : 'Войти'} <span class="arrow">→</span></button>
    </form>
    ${authInfo.users?.length ? `<p class="note">Аккаунты: ${authInfo.users.map(esc).join(', ')}</p>` : ''}
  </div></div>`;
}

async function submitAuth(form) {
  const data = Object.fromEntries(new FormData(form));
  const err = document.getElementById('auth-err');
  try {
    await store.api(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', data);
    await refreshMe();
    await store.sync();
    await loadCatalogs();
    location.hash = authMode === 'register' ? '#profile' : '#today';
    render();
    startBackground();
  } catch (e) { err.textContent = e.message; }
}

async function refreshMe() {
  const me = await store.api('/api/me');
  await store.setMeta('me', me.user);
  await store.setMeta('partners', me.partners);
  await store.setMeta('is_admin', !!me.is_admin);
  try { await store.setMeta('groups', (await store.api('/api/groups/mine')).groups || []); } catch (e) { /* офлайн - оставим прошлые группы */ }
}

// ── общие действия ──
Object.assign(actions, {
  'auth-mode': el => { authMode = el.dataset.mode; renderAuth(); },
  close: () => closeModal(),
  'sync-panel': () => syncPanel(),
  'ai-sleep': () => openModal(`<div class="modal-head"><h2>ИИ спит</h2></div><div class="modal-body">
    <p>Локальная модель на сервере сейчас не запущена. Всё основное работает и без неё: нормы, справочник еды, план, анализ.</p>
    <p>Запросы к ИИ (чат, разбор недели, рецепты, комментарий к нормам) не теряются: они ждут в очереди и выполнятся сами,
      когда модель заработает. Ответы придут сюда же.</p>
    <p class="note">Запустить модель можно на компьютере-сервере (виджет или <span class="mono">ollama serve</span>).</p>
    </div><div class="modal-foot"><button class="btn solid" data-act="close">Понятно</button></div>`),
  'ai-enable': async () => {
    const r = store.get(`profile:${store.uid()}`);
    await store.put('profile', `profile:${store.uid()}`, { ...(r?.data || {}), ai: 'on' }, null);
    toast('ИИ включена');
    scheduleRender();
  },
  'close-go': el => { closeModal(); location.hash = el.getAttribute('href'); },
  'sync-now': async () => {
    await store.sync();
    toast(store.state.error ? store.state.error : store.conflicts().length ? 'Есть конфликты - выберите, что оставить' : 'Синхронизировано');
    if (isModalOpen() && document.querySelector('.modal h2')?.textContent === 'Синхронизация') syncPanel();
  },
  // без связи не сбрасываем кэш оболочки: после перезагрузки приложение не открылось бы вовсе
  'app-update': () => store.state.online ? updateApp() : toast('Без связи с сервером обновить нельзя - приложение работает из кэша'),
  'app-update-local': () => { closeModal(); applyUpdate(); },
  'app-update-git': () => updateFromGit(),
  'conflict-pick': el => {
    const c = store.conflicts().find(x => x.id === el.dataset.id);
    if (!c) return;
    picksFor(c)[Number(el.dataset.i)] = el.dataset.choice;
    const row = el.closest('.conflict-row');
    row?.querySelectorAll('.conflict-opt').forEach(b => { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  },
  conflict: async el => {
    const c = store.conflicts().find(x => x.id === el.dataset.id);
    await store.resolveConflict(el.dataset.id, el.dataset.choice, c ? picksFor(c) : undefined);
    conflictPicks.delete(el.dataset.id);
    store.conflicts().length ? syncPanel() : (closeModal(), toast('Готово: данные согласованы'));
  },
  'conflict-all': async el => { await store.resolveAll(el.dataset.choice); closeModal(); toast('Готово: данные согласованы'); },
  tech: el => showTech(el.dataset.exFromForm ? (S.forms.item?.ex || document.querySelector('[data-form=item][data-key=ex]')?.value) : el.dataset.ex, exCtx(el)),
  // «таблетки» из ui.chips: одиночный выбор или набор
  'chip-set': el => {
    const { form, key, val, multi } = el.dataset;
    const f = (S.forms[form] ||= {});
    const cast = x => (/^\d+$/.test(x) ? Number(x) : x);
    if (multi) {
      const cur = (f[key] || []).map(String);
      f[key] = (cur.includes(val) ? cur.filter(x => x !== val) : [...cur, val]).map(cast);
    } else {
      f[key] = cast(val);
    }
    // во всплывающем окне страница под ним перерисуется, а само окно - нет: подсветку переключаем на месте,
    // иначе кажется, что таблетка не нажимается
    const box = el.closest('#modal') && el.closest('.chips');
    if (box) {
      if (multi) { el.classList.toggle('on'); el.setAttribute('aria-pressed', el.classList.contains('on')); }
      else box.querySelectorAll('.chip[data-act="chip-set"]').forEach(b => { b.classList.toggle('on', b === el); b.setAttribute('aria-pressed', b === el); });
      return;
    }
    render();
  },
});

// ── делегирование событий ──
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act] || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  e.preventDefault();
  const run = () => Promise.resolve(actions[el.dataset.act](el, e)).catch(err => { console.error(err); toast(err.message || 'Ошибка'); });
  const spec = confirms[el.dataset.act]?.(el);
  if (spec) confirmAction(spec).then(ok => { if (ok) run(); });
  else run();
});

document.addEventListener('submit', e => {
  if (e.target.id === 'auth-form') { e.preventDefault(); submitAuth(e.target); return; }
  const act = e.target.dataset?.submit;
  if (act && actions[act]) {
    e.preventDefault();
    Promise.resolve(actions[act](e.target, e)).catch(err => { console.error(err); toast(err.message || 'Ошибка'); });
  }
});

function setFormValue(el) {
  const f = (S.forms[el.dataset.form] ||= {});
  f[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
}
document.addEventListener('input', e => { if (e.target.dataset?.form) setFormValue(e.target); });

// Тап по полю ввода выделяет всё его содержимое: чтобы заменить число или слово, не нужно стирать по символу.
// Только когда человек сам перешёл в поле (pointerdown на поле, которое ещё не в фокусе): программный фокус после
// перерисовки (поиск продукта, подходы) курсор в конец не двигает; повторный тап в поле ставит курсор как обычно.
// Многострочные поля (textarea), время/дата и флажки не затрагиваются. На iOS курсор ставится при отпускании пальца -
// выделение повторяем через 40 и 150 мс; в браузере компьютера отпускание мыши не должно снимать выделение.
const SELECT_ON_TAP = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]):not([type=color]):not([type=time]):not([type=date]):not([type=datetime-local]):not([type=hidden]):not([readonly]):not([data-no-select])';
let tapEl = null, tapAt = 0;
const selectAll = el => { try { el.select(); } catch (err) { try { el.setSelectionRange(0, String(el.value).length); } catch (e2) { /* number без выделения - ничего */ } } };
document.addEventListener('pointerdown', e => {
  const el = e.target.closest?.(SELECT_ON_TAP);
  if (el && document.activeElement !== el) { tapEl = el; tapAt = Date.now(); } else tapEl = null;
}, true);
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el !== tapEl || Date.now() - tapAt > 800) return;
  selectAll(el);
  for (const ms of [40, 150]) setTimeout(() => { if (document.activeElement === el && tapEl === el) selectAll(el); }, ms);
});
document.addEventListener('mouseup', e => { if (tapEl && e.target === tapEl) { e.preventDefault(); } }, true);
document.addEventListener('input', () => { tapEl = null; }, true);      // начали печатать - больше не выделяем

// ── автосохранение полей ──
// Поля с обработчиком изменений (время сна, шаги, подходы, граммы, замеры…) сохраняют не только по
// «change» (он приходит при уходе с поля, а на iPhone при сворачивании — не всегда), но и через 0,7 с
// после ввода. При сворачивании и закрытии всё отложенное сохраняется сразу. Повтор одного и того же
// значения не пишется (lastSaved).
const pendingSaves = new Map();   // элемент → таймер
const AUTOSAVE_TYPES = new Set(['number', 'time', 'date', 'text', 'search', 'tel', 'range', 'textarea']);
function runChange(el, e) {
  const fn = changes[el.dataset?.act];
  if (!fn) return;
  clearTimeout(pendingSaves.get(el)); pendingSaves.delete(el);
  if (el.dataset.lastSaved === el.value && e?.type !== 'change') return;
  el.dataset.lastSaved = el.value;
  Promise.resolve(fn(el, e)).catch(err => { console.error(err); toast(err.message || 'Ошибка'); });
}
document.addEventListener('input', e => {
  const el = e.target;
  if (!changes[el.dataset?.act] || el.dataset?.form) return;
  const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || '');
  if (!AUTOSAVE_TYPES.has(type)) return;
  if (type === 'time' && !/^\d{2}:\d{2}/.test(el.value)) return;      // время — только целиком
  clearTimeout(pendingSaves.get(el));
  pendingSaves.set(el, setTimeout(() => runChange(el, e), 700));
});
function flushSaves() {
  for (const el of [...pendingSaves.keys()]) runChange(el);
  const a = document.activeElement;
  if (a && changes[a.dataset?.act] && a.dataset.lastSaved !== a.value) runChange(a);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushSaves(); store.flushOnExit(); } });
window.addEventListener('pagehide', () => { flushSaves(); store.flushOnExit(); });

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset?.form) {
    setFormValue(el);
    // переключатели, от которых зависит вид формы, перерисовывают экран (data-rerender)
    if (el.dataset.rerender !== undefined) setTimeout(render, 0);
    return;
  }
  const fn = changes[el.dataset?.act];
  // выбор в списке уже сделан: снимаем фокус, иначе перерисовка ждала бы ухода со списка
  // (например, поля новой цели-показателя появлялись бы только после клика мимо)
  if (fn && el.tagName === 'SELECT') el.blur();
  if (fn) {
    if (el.dataset.lastSaved === el.value && !pendingSaves.has(el)) return;   // уже сохранено автосохранением
    runChange(el, e);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isModalOpen()) closeModal();
  // Enter в поле с data-enter нажимает кнопку этого действия рядом (в многострочном поле — Cmd/Ctrl+Enter)
  const t = e.target, act = t?.dataset?.enter;
  if (e.key === 'Enter' && act && (t.tagName !== 'TEXTAREA' || e.metaKey || e.ctrlKey)) {
    const btn = t.closest('.section, .inset, .sheet, .modal')?.querySelector(`[data-act="${act}"]`);
    if (btn && !btn.disabled) { e.preventDefault(); t.dispatchEvent(new Event('change', { bubbles: true })); btn.click(); }
  }
});
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ════════════════ фон ════════════════

async function loadCatalogs() {
  const ex = store.getMeta('exercises'), act = store.getMeta('activities');
  if (ex) S.exMap = new ExMap(ex.map(e => [e.id, e]));
  if (act) S.activities = new Map(act.map(a => [a.id, a]));
  const sp = store.getMeta('supplements');
  if (sp) S.supps = { items: new Map((sp.items || []).map(x => [x.id, x])), stoplist: sp.stoplist || [] };
  if (ex && sp?.items?.length && store.getMeta('catalog_build') === BUILD) return;
  try {
    const [e1, a1, s1] = await Promise.all([store.api('/api/exercises'), store.api('/api/activities').catch(() => ({ activities: [] })),
      store.api('/api/supplements').catch(() => null)]);
    await store.setMeta('exercises', e1.exercises);
    await store.setMeta('activities', a1.activities);
    if (s1) { await store.setMeta('supplements', s1); S.supps = { items: new Map((s1.items || []).map(x => [x.id, x])), stoplist: s1.stoplist || [] }; }
    await store.setMeta('catalog_build', BUILD);
    S.exMap = new ExMap(e1.exercises.map(e => [e.id, e]));
    S.activities = new Map(a1.activities.map(a => [a.id, a]));
    scheduleRender();
  } catch (e) { /* офлайн — останемся с кэшем */ }
}

const JOB_DONE = { food: 'БЖУ посчитаны', norms: 'Тренер прокомментировал нормы', weekly: 'Разбор недели готов',
  mealplan: 'План питания готов', recipe: 'Рецепт готов', analysis: 'Анализ готов', chat: 'Тренер ответил' };

// входящие фразы «Подбодрить»: всплывающее уведомление один раз на фразу (сама фраза - на «Сегодня» и во «Вместе»)
async function notifyCheers() {
  const fresh = [];
  for (const { p, c } of C.unseenCheers?.() || []) {
    if (c.at <= (store.getMeta(`cheer_toasted:${p.id}`, 0) || 0)) continue;
    await store.setMeta(`cheer_toasted:${p.id}`, c.at);
    fresh.push({ p, c, n: c.list?.length || 1 });
  }
  if (!fresh.length) return;
  // одно уведомление на всех: несколько всплывающих подряд перебивают друг друга
  if (fresh.length === 1) {
    const { p, c, n } = fresh[0];
    toast(n > 1 ? `${p.name} подбадривает (${n} ${n < 5 ? 'сообщения' : 'сообщений'}): «${c.text}»` : `${p.name} подбадривает: «${c.text}»`, 5000);
  } else toast(`Новые сообщения: ${fresh.map(({ p, n }) => (n > 1 ? `${p.name} (${n})` : p.name)).join(', ')} - на «Сегодня»`, 5000);
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  // Свёрнутая вкладка продолжает работать, но реже: забирает готовые задачи ИИ, досылает отложенные
  // без сети запросы. Перерисовку и сообщения тренера оставляем на момент, когда приложение видно.
  const hidden = document.hidden;
  try {
    for (const v of VIEWS) if (v.background) await v.background({ hidden });
    if (!hidden) await notifyCheers();
    let changed = false;
    for (const j of store.getMeta('jobs', [])) {
      try {
        const s = await store.api(`/api/ai/jobs/${j.id}`);
        const was = S.jobState.get(j.id);
        S.jobState.set(j.id, s);
        if (s.waiting && !was?.waiting && !j.told) {
          j.told = true;
          await store.setMeta('jobs', store.getMeta('jobs', []).map(x => (x.id === j.id ? { ...x, told: true } : x)));
          toast('ИИ на сервере сейчас не запущена - запрос подождёт и выполнится сам', 5000);
        }
        if (s.status === 'cancelled') {       // заменён более свежим (комментарий к нормам после нового пересчёта)
          await store.setMeta('jobs', store.getMeta('jobs', []).filter(x => x.id !== j.id));
          S.jobState.delete(j.id);
          continue;
        }
        if (s.status === 'done' || s.status === 'error') {
          await store.setMeta('jobs', store.getMeta('jobs', []).filter(x => x.id !== j.id));
          S.jobState.delete(j.id);
          changed = true;
          if (s.status === 'error') {
            toast(`ИИ: ${s.error}`, 6000);
            if (j.kind === 'food' && store.get(j.ref)) await store.patch(j.ref, { calc_error: s.error });
          } else {
            const done = j.kind === 'program' ? `Программа обновлена: ${s.result?.workouts || 0} тренировок в календаре` : JOB_DONE[j.kind] || 'Готово';
            toast(done, 4000);
            // тост живёт секунды, а в чате остаётся видно, что тренер закончил и что сделал - не только для
            // разбора недели/программы, туда и так заглянут за текстом, а чтобы не пропустить сам факт завершения
            // о программе пишет сам сервер (что сделал, где, по каким дням) - не дублируем
            if (['weekly', 'mealplan', 'analysis'].includes(j.kind)) chat.announce(done);
          }
        }
      } catch (e) {
        if (e.status === 404) { await store.setMeta('jobs', store.getMeta('jobs', []).filter(x => x.id !== j.id)); changed = true; }
      }
    }
    if (changed) { await store.sync(); afterChange(C.today()); }
    scheduleRender();
  } catch (e) { console.error(e); }
  const jobs = store.getMeta('jobs', []);
  // пока модель спит, задачи ждут часами - часто спрашивать незачем (готовые ответы придут и синхронизацией)
  const busy = jobs.some(j => !S.jobState.get(j.id)?.waiting), sleeping = jobs.length && !busy;
  pollTimer = setTimeout(poll, hidden ? 60000 : busy ? 3000 : sleeping ? 30000 : 15000);
}
window.addEventListener('trainer:poll', () => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 1500); });
// новые записи с сервера → фоновые пересчёты экранов сразу (через 0,3 с - пачка обменов подряд сливается в один)
window.addEventListener('trainer:remote', e => {
  clearTimeout(pollTimer); pollTimer = setTimeout(poll, 300);
  // свои данные поменялись не здесь (другое устройство, тренер отметил из чата) - итог дня и БЖУ добавок пересчитать
  const dates = (e.detail?.dates || []).filter(d => d <= C.today());
  if (dates.length) (async () => {
    try { await SPS.ensureFoods(dates); } catch (err) { console.warn(err); }
    for (const d of dates) { try { await C.refreshDsum(d); } catch (err) { console.warn(err); } }
  })();
});

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.action === 'reload' && !updateReady) { updateReady = true; scheduleRender(); } });
}

// ── обновление приложения: никогда не перезагружаем страницу посреди работы ──
// Новая версия на сервере → метка «Обновление» в шапке. Сама она ставится только в безопасный момент:
// при запуске или возврате в приложение, когда ничего не вводится и все правки уже на сервере.
let updateReady = false;
function safeToReload() {
  return !isEditing() && !pendingSaves.size && !store.pendingCount() && !store.getMeta('draft_profile') && !isModalOpen();
}
// «Обновить приложение»: если сервер установлен из git - сначала новые версии с GitHub (git pull на сервере и его
// перезапуск, как «Проверить обновления» в «Как это работает»), потом экран; иначе - только экран с этого сервера.
let gitBusy = false;
async function updateApp() {
  if (gitBusy) return;
  gitBusy = true;
  toast('Проверяю обновления…', 2500);
  let st = null;
  try { st = await store.api('/api/update/check?force=1'); } catch (e) { st = null; }   // старый сервер, нет связи
  gitBusy = false;
  if (!st?.available) return applyUpdate();                       // не из git - как раньше
  if (st.offline) { toast('GitHub недоступен - обновляю только экран с этого компьютера', 4000); return applyUpdate(); }
  if (!st.behind) { toast('С GitHub уже последняя версия', 2500); return applyUpdate(); }
  const n = st.behind, word = n === 1 ? 'изменение' : n < 5 ? 'изменения' : 'изменений';
  const when = d => (d ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(new Date(d)) : '');
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Обновление приложения</div><h2>Доступно ${n} ${word}</h2></div>
    <div class="modal-body">
      <ul class="small up-list">${st.commits.slice(0, 8).map(c => `<li>${esc(c.subject)} <span class="note">${esc(when(c.date))}</span></li>`).join('')}</ul>
      ${st.dirty?.length ? `<div class="notice">В папке приложения на компьютере изменены файлы (${esc(st.dirty.slice(0, 4).join(', '))}) - обновление их перезаписало бы. Сохраните их отдельно, тогда обновление станет доступно.</div>`
        : `<p class="note">Сервер скачает новую версию${st.dependencies_changed ? ' и библиотеки' : ''} и перезапустится - примерно минута. Данные не затрагиваются. Потом приложение перезагрузится само; телефоны и планшеты обновятся, когда будет удобно. Обновляет владелец или человек у самого компьютера.</p>`}
    </div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">${st.dirty?.length ? 'Закрыть' : 'Отмена'}</button>
      ${st.dirty?.length ? '' : '<button class="btn solid" data-act="app-update-git">Обновить</button>'}</div>`);
}
async function updateFromGit() {
  if (gitBusy) return;
  gitBusy = true;
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Обновление приложения</div><h2>Обновляю…</h2></div>
    <div class="modal-body"><p class="small"><span class="spinner"></span> <span id="upd-step">Скачиваю новую версию на компьютер…</span></p>
      <p class="note">Не закрывайте приложение - после перезапуска сервера оно перезагрузится само.</p></div>`);
  const step = t => { const el = document.getElementById('upd-step'); if (el) el.textContent = t; };
  try {
    flushSaves();
    try { await store.sync(); } catch (e) { /* правки останутся в очереди */ }
    const r = await store.api('/api/update/apply', {});
    if (!r.restarting) { gitBusy = false; closeModal(); toast(r.message || 'Уже последняя версия'); return applyUpdate(); }
    step('Сервер перезапускается…');
    // ждём, пока поднимется новая версия: сначала сервер должен пропасть (перезапуск через ~1,5 с), потом ответить
    // с новым коммитом; если «пропал» мы не заметили - не раньше чем через 20 с
    const want = r.to?.hash, t0 = Date.now();
    let down = false;
    while (Date.now() - t0 < 4 * 60e3) {
      await new Promise(res => setTimeout(res, 2500));
      try {
        const v = await store.api('/api/version');
        if ((down || Date.now() - t0 > 20e3) && (!want || v.commit?.hash === want)) { step('Готово - перезагружаю'); return applyUpdate(); }
      } catch (e) { down = true; }
    }
    gitBusy = false;
    closeModal();
    toast('Сервер долго не отвечает после обновления. Проверьте компьютер с Тренером и откройте приложение заново.', 8000);
  } catch (e) {
    gitBusy = false;
    closeModal();
    toast(e.status === 403 ? 'Обновить с GitHub может владелец (первый аккаунт) или человек у самого компьютера' : e.message || 'Не получилось обновить', 7000);
  }
}

async function applyUpdate() {
  flushSaves();
  try { if (store.state.online) await store.sync(); } catch (e) { /* правки останутся в очереди на устройстве */ }
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('app-')).map(n => caches.delete(n)));
  }
  const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  await Promise.all(regs.map(r => r.unregister()));
  await store.setMeta('catalog_build', null);
  location.reload();
}
async function checkVersion({ atStart = false } = {}) {
  try {
    const { version } = await store.api('/api/version');
    // на запасном адресе не сбрасываем кэш оболочки: свой адрес может быть мёртв, и после
    // перезагрузки приложение не открылось бы вовсе; обновимся, когда вернёмся к нему
    if (!version || version === BUILD || store.usingMirror()) return;
    if (atStart && safeToReload() && sessionStorage.getItem('reloaded_for') !== version) {
      sessionStorage.setItem('reloaded_for', version);
      return applyUpdate();
    }
    if (!updateReady) { updateReady = true; scheduleRender(); }
  } catch (e) { /* офлайн */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && updateReady && safeToReload()) applyUpdate();
});

let bgStarted = false;
function startBackground() {
  if (bgStarted) return;
  bgStarted = true;
  afterChange(C.today());
  poll();
  setTimeout(() => checkVersion({ atStart: true }), 4000);
  setInterval(() => { if (!document.hidden) checkVersion(); }, 60000);
  let lastDay = C.today();
  setInterval(() => { if (C.today() !== lastDay) { lastDay = C.today(); scheduleRender(); } }, 60000);
}

// ── тема в аккаунте: одна на всех устройствах ──
// Выбор пишется в профиль (profile.theme), приезжает синхронизацией и применяется через theme.js.
// Флаг applying не даёт применению с сервера тут же записаться обратно.
let applyingTheme = false;
function applyAccountTheme() {
  const t = store.get(`profile:${store.uid()}`)?.data?.theme;
  if (!t || !window.stTheme || window.stTheme.get() === t) return;
  applyingTheme = true;
  try { window.stTheme.set(t); } finally { applyingTheme = false; }
}
document.addEventListener('themechange', e => {
  if (applyingTheme || !store.me()) return;
  const id = `profile:${store.uid()}`, cur = store.get(id);
  if (cur && cur.data.theme !== e.detail) store.patch(id, { theme: e.detail });
});

async function boot() {
  await store.init();
  registerSW();
  store.on(scheduleRender);
  store.on(watchConflicts);
  store.on(applyAccountTheme);
  if (!store.me()) {
    try { await refreshMe(); } catch (e) { /* не вошли или офлайн */ }
  }
  if (!store.me()) return renderAuth();
  await loadCatalogs();
  render();
  await store.sync();
  loadCatalogs();
  refreshMe().catch(() => {});
  startBackground();
}

boot();
