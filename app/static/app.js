// «Тренер»: оболочка приложения — навигация, маршруты, события, фоновые задачи.
// Экраны живут в views/*.js: каждый экспортирует routes, actions и по желанию changes,
// afterRender (после отрисовки) и background (раз в цикл опроса, пока приложение открыто).
import * as store from './store.js';
import * as C from './coach.js';
import { S, esc, svg, ring, field, toast, openModal, closeModal, showTech, afterChange, isModalOpen, glyph, exCtx, profile as userProfile } from './ui.js';
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
import * as advice from './views/advice.js';

const BUILD = document.querySelector('meta[name=build]').content;
const $app = document.getElementById('app');
const VIEWS = [today, calendar, food, workout, chat, progress, profile, together, health, connect, about, install, fit, supp, advice];

const NAV = [['today', 'Сегодня'], ['calendar', 'Календарь'], ['food', 'Питание'], ['workout', 'Спорт'],
  ['chat', 'Тренер'], ['progress', 'Прогресс'], ['profile', 'Профиль']];
// какой пункт меню подсвечивать для вложенных экранов
// цвет значка активного пункта — по смыслу раздела (accents.css)
const NAV_DOM = { today: 'coach', calendar: 'goal', food: 'food', workout: 'train', chat: 'coach', progress: 'goal' };
const NAV_OF = { advice: 'chat', install: 'profile', about: 'profile', together: 'progress', health: 'profile', connect: 'profile', day: 'today', program: 'workout', generator: 'workout', week: 'progress', body: 'progress', sleep: 'today' };

const routes = Object.assign({}, ...VIEWS.map(v => v.routes || {}));
const actions = Object.assign({}, ...VIEWS.map(v => v.actions || {}));
const changes = Object.assign({}, ...VIEWS.map(v => v.changes || {}));

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
function scheduleRender() {
  // невидимую страницу не рисуем (батарея) — нарисуем один раз, когда её откроют
  if (isEditing() || document.hidden) { renderPending = true; return; }
  render();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && renderPending && !isEditing()) { renderPending = false; render(); }
});
document.addEventListener('focusout', () => setTimeout(() => {
  if (renderPending && !isEditing()) { renderPending = false; render(); }
}, 0));

window.addEventListener('hashchange', () => {
  for (const k of Object.keys(S.forms)) delete S.forms[k];
  window.scrollTo(0, 0);
  render();
});

function render() {
  if (!store.me()) return renderAuth();
  const { view, arg } = route();
  const navKey = NAV_OF[view] || view;
  let body;
  try { body = routes[view](arg); } catch (e) { console.error(e); body = `<div class="notice">Ошибка отрисовки: ${esc(e.message)}</div>`; }
  const y = window.scrollY;
  const dot = k => (k === 'chat' && unreadChat() ? '<span class="dot"></span>' : '');
  $app.innerHTML = `
    <header class="masthead">
      <a class="wordmark" href="#today"><b>Тренер<i>.</i></b></a>
      <div class="mast-actions">${syncBadge()}
        <div class="theme-switch" role="group" aria-label="Тема"><button data-theme-set="auto" title="Как в системе">Авто</button><button data-theme-set="dark" aria-label="Тёмная тема" title="Тёмная тема">${glyph('night')}</button><button data-theme-set="light" aria-label="Светлая тема" title="Светлая тема">${glyph('sun')}</button></div>
      </div>
    </header>
    <div class="layout">
      <aside class="nav">${NAV.map(([k, l]) => `<a href="#${k}" class="${navKey === k ? 'on' : ''}" ${NAV_DOM[k] ? `data-dom="${NAV_DOM[k]}"` : ''}>${svg(k)}${l}${dot(k)}</a>`).join('')}
        ${asideCards()}</aside>
      <main><div class="wrap"><div class="sheet">${body}</div></div></main>
    </div>
    <nav class="tabbar">${NAV.map(([k, l]) => `<a href="#${k}" class="${navKey === k ? 'on' : ''}" ${NAV_DOM[k] ? `data-dom="${NAV_DOM[k]}"` : ''}>${svg(k)}${dot(k)}<span>${l}</span></a>`).join('')}</nav>`;
  window.scrollTo(0, y);
  for (const v of VIEWS) if (v.routes?.[view] && v.afterRender) v.afterRender(arg);
}
S.render = scheduleRender;

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
  const upd = updateReady ? '<button class="sync update" data-act="app-update" title="Есть новая версия приложения - обновить сейчас">обновление</button>' : '';
  return `${sleep}${upd}<button class="sync ${cls}" data-act="sync-panel" title="Синхронизация и обновление">${text}</button>`;
}

// ── синхронизация, обновление, конфликты ──
const KIND_NAME = { profile: 'Профиль', goal: 'Цели', target: 'Нормы', item: 'Пункт чек-листа', log: 'Отметка чек-листа',
  food: 'Запись о еде', body: 'Вес и замеры', workout: 'Тренировка', program: 'Программа', sleep: 'Сон', state: 'Самочувствие',
  daytype: 'Тип дня', activity: 'Активность', injury: 'Травма', routine: 'Разминка', favfood: 'Избранное блюдо', chat: 'Сообщение', drink: 'Чашка чая или кофе', supp: 'Приём добавки',
  dsum: 'Итог дня', wsum: 'Итог недели', ach: 'Достижение', coach: 'Разбор тренера' };
const FIELD_NAME = { v: 'значение', bed: 'лёг', wake: 'встал', weight: 'вес', text: 'текст', meal: 'приём пищи', time: 'время',
  wellbeing: 'самочувствие', soreness: 'мышцы', stress: 'стресс', sleepy: 'сонливость', note: 'заметка', type: 'тип', minutes: 'минуты',
  intensity: 'интенсивность', title: 'название', done: 'выполнено', reps: 'повторы', name: 'имя', height: 'рост' };

function fieldLabel(path) {
  const last = String(path).replace(/\[\d+\]/g, '').split('.').filter(Boolean).pop() || path;
  return FIELD_NAME[last] || last;
}
function valueLabel(v) {
  if (v === true) return 'да';
  if (v === false) return 'нет';
  if (v == null || v === '') return '-';
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

function conflictHtml(c) {
  const when = c.date ? ` · ${esc(new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(C.parse(c.date)))}` : '';
  return `<div class="raised card conflict-card">
    <div class="smallcaps muted">${esc(KIND_NAME[c.kind] || c.kind)}${when}</div>
    <table class="conflict-table"><thead><tr><th></th><th>это устройство</th><th>сервер</th></tr></thead><tbody>
      ${c.fields.slice(0, 6).map(f => `<tr><td>${esc(fieldLabel(f.path))}</td><td>${esc(valueLabel(f.local))}</td><td>${esc(valueLabel(f.server))}</td></tr>`).join('')}
    </tbody></table>
    <div class="actions conflict-actions">
      <button class="btn" data-act="conflict" data-id="${esc(c.id)}" data-choice="local">Это устройство</button>
      <button class="btn" data-act="conflict" data-id="${esc(c.id)}" data-choice="server">Сервер</button>
      <button class="btn" data-act="conflict" data-id="${esc(c.id)}" data-choice="merge">Объединить</button>
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
      ${cs.length ? `<div class="notice">Одни и те же данные изменили на разных устройствах по-разному. Выберите, что оставить. «Объединить» сложит всё, что можно сложить, а в спорных местах возьмёт более свежую правку и склеит тексты.</div>
        ${cs.map(conflictHtml).join('')}
        ${cs.length > 1 ? `<div class="actions"><span class="note">Для всех:</span>
          <button class="btn quiet" data-act="conflict-all" data-choice="local">Это устройство</button>
          <button class="btn quiet" data-act="conflict-all" data-choice="server">Сервер</button>
          <button class="btn quiet" data-act="conflict-all" data-choice="merge">Объединить</button></div>` : ''}`
        : '<p class="note">Конфликтов нет: изменения с разных устройств дополняют друг друга.</p>'}
      <div class="actions"><button class="btn quiet" data-act="cn-open">Адреса сервера${store.usingMirror() ? ' · сейчас запасной' : ''} <span class="arrow">→</span></button>
        <button class="btn quiet" data-act="app-update" ${store.state.online ? '' : 'disabled'}>Обновить приложение</button></div>
      <p class="note">${store.state.online ? '«Обновить приложение» загрузит свежую версию, если что-то выглядит странно; ваши данные не пропадут.' : 'Обновить приложение можно, когда сервер на связи: без него после перезагрузки оно бы не открылось.'}</p>
    <p class="note"><a class="link" href="#about" data-act="close-go">Что работает без сети, а что - только с сервером</a></p>
    </div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Закрыть</button>
      <button class="btn solid" data-act="sync-now" ${store.state.online ? '' : 'disabled'}>Синхронизировать</button></div>`);
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
  'app-update': () => store.state.online ? applyUpdate() : toast('Без связи с сервером обновить нельзя - приложение работает из кэша'),
  conflict: async el => {
    await store.resolveConflict(el.dataset.id, el.dataset.choice);
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
    render();
  },
});

// ── делегирование событий ──
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act] || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  e.preventDefault();
  Promise.resolve(actions[el.dataset.act](el, e)).catch(err => { console.error(err); toast(err.message || 'Ошибка'); });
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
  if (ex) S.exMap = new Map(ex.map(e => [e.id, e]));
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
    S.exMap = new Map(e1.exercises.map(e => [e.id, e]));
    S.activities = new Map(a1.activities.map(a => [a.id, a]));
    scheduleRender();
  } catch (e) { /* офлайн — останемся с кэшем */ }
}

const JOB_DONE = { food: 'БЖУ посчитаны', norms: 'Тренер прокомментировал нормы', weekly: 'Разбор недели готов',
  mealplan: 'План питания готов', recipe: 'Рецепт готов', analysis: 'Анализ готов', chat: 'Тренер ответил' };

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  // Свёрнутая вкладка продолжает работать, но реже: забирает готовые задачи ИИ, досылает отложенные
  // без сети запросы. Перерисовку и сообщения тренера оставляем на момент, когда приложение видно.
  const hidden = document.hidden;
  try {
    for (const v of VIEWS) if (v.background) await v.background({ hidden });
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
            toast(j.kind === 'program' ? `Программа готова: ${s.result?.workouts || 0} тренировок в календаре` : JOB_DONE[j.kind] || 'Готово', 4000);
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
