// Общие помощники интерфейса: разметка, формы, модальное окно, уведомления, задачи ИИ.
// Экраны (views/*.js) импортируют отсюда; состояние, общее для экранов, — в объекте S.
import * as store from './store.js';
import * as C from './coach.js';
import * as PF from './prefs.js';

// Android: нет «Здоровья» iPhone и «Команд» - этих блоков там не показываем
export const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
export const S = {
  exMap: new Map(),       // id → упражнение из каталога
  activities: new Map(),  // id → вид активности из справочника
  supps: { items: new Map(), stoplist: [] },   // справочник витаминов и добавок
  forms: {},              // черновики форм: не теряются при перерисовке, сбрасываются при смене экрана
  jobState: new Map(),    // id задачи ИИ → {status, ahead, error}
  render: () => {},       // перерисовать текущий экран (подставляет app.js)
};

// ── текст и числа ──
// длинное тире «—» в интерфейсе не используем: ответы ИИ и данные с сервера приводим к «-»
export const esc = s => String(s ?? '').replace(/—/g, '-').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = n => (Math.round(Number(n) || 0)).toLocaleString('ru');
// граммы БЖУ: до десятых, с запятой (9,8), без хвостовых нулей
export const dec = n => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('ru');
export const fmt = (s, o) => new Intl.DateTimeFormat('ru', o).format(C.parse(s));
export const dayTitle = s => fmt(s, { weekday: 'long', day: 'numeric', month: 'long' });
export const shortDate = s => fmt(s, { day: 'numeric', month: 'short' });
export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};
export const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export const profile = (uid = store.uid()) => store.get(`profile:${uid}`)?.data || {};
// режим ИИ из профиля: включена (по умолчанию; комментарии тренера обновляются сами) или off - модель не вызывается вовсе
export const aiOff = () => profile().ai === 'off';
export const AI_OFF_NOTE = 'ИИ выключена в профиле';
// подсказка там, где без ИИ не обойтись: включить можно прямо отсюда (действие ai-enable в app.js)
export const aiOffHint = (what = 'Это умеет ИИ') => `<span class="note ai-hint">${esc(what)}, а она выключена в профиле. <button type="button" class="btn quiet" data-act="ai-enable">Включить ИИ</button></span>`;
export const AI_WAIT_NOTE = 'ИИ сейчас не запущена на сервере - запрос подождёт в очереди и выполнится сам';
export const goal = (uid = store.uid()) => store.get(`goal:${uid}`)?.data || {};

// ── иконки ──
const ICON = {
  today: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  food: '<path d="M7 3v7a2 2 0 0 0 2 2v9M5 3v5a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3M17 21V3c-2.2 1-3.2 3.5-3.2 7.5H17"/>',
  workout: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
  progress: '<path d="M5 19v-7M11 19V5M17 19v-10M3 19.5h18"/>',
  profile: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c1-3.8 4.2-5.6 7.5-5.6s6.5 1.8 7.5 5.6"/>',
  chat: '<path d="M4.5 5.5h15v10h-8l-4 3.5v-3.5h-3z"/>',
  sleep: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
};
export const svg = (name, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICON[name] || ''}</svg>`;
// Минималистичные значки вместо эмодзи: линия в цвет текста, как иконки меню. Эмодзи iOS рисует
// цветными картинками, и они выбиваются из «бумажного» стиля. Размер — 1em, по базовой линии текста.
const GLYPH = {
  // самочувствие: одно лицо, меняются глаза и рот
  great: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 10.2q1-1.2 2 0M13.5 10.2q1-1.2 2 0M8 13.6q4 4.2 8 0"/>',
  good: '<circle cx="12" cy="12" r="8.5"/><path d="M9.3 9.8v.6M14.7 9.8v.6M8.8 14.2q3.2 2.8 6.4 0"/>',
  meh: '<circle cx="12" cy="12" r="8.5"/><path d="M9.3 9.8v.6M14.7 9.8v.6M9 15h6"/>',
  broken: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 10.3l2-.9M15.7 10.3l-2-.9M8.9 16q3.1-2.6 6.2 0"/>',
  // оценка недели A…E
  flame: '<path d="M12 3.5c.6 3.2 4.8 5 4.8 9.6a4.8 4.8 0 0 1-9.6 0c0-2.3 1.2-3.5 2.2-4.6.3 1.6 1 2.4 2 2.7-.3-2.8-.4-5.4.6-7.7z"/>',
  rise: '<path d="M4 16.5l5-5 3.5 3.5L20 7.5M15 7.5h5v5"/>',
  steady: '<path d="M4 12h16M15.5 7.5L20 12l-4.5 4.5"/>',
  dip: '<path d="M4 8.5l5 5 3.5-3.5 7.5 7M15 17h5v-5"/>',
  moon: '<path d="M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z"/>',
  // прочее
  cup: '<path d="M5 9.5h11v4.5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14z"/><path d="M16 11h1.2a2.3 2.3 0 0 1 0 4.6H15.6M8.5 3.8c-.6.9.6 1.6 0 2.7M12 3.8c-.6.9.6 1.6 0 2.7"/>',
  heart: '<path d="M12 19.5s-7-4.3-7-9.2A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.3c0 4.9-7 9.2-7 9.2z"/>',
  star: '<path d="M12 4.2l2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 16l-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z"/>',
  check: '<path d="M6 12.5l4 4 8-9"/>',
  cross: '<path d="M7 7l10 10M17 7L7 17"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>',
  night: '<path d="M18 14.2A6.8 6.8 0 0 1 9.8 6a6.8 6.8 0 1 0 8.2 8.2z"/>',
  // погода: та же линия, что у остальных значков
  cloud: '<path d="M7.5 18.5h9.2a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10-.9A3.9 3.9 0 0 0 7.5 18.5z"/>',
  rain: '<path d="M7.5 14.5h9.2a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6-.8 3.7 3.7 0 0 0 0 8z"/><path d="M9 17.5l-.8 2M12.5 17.5l-.8 2M16 17.5l-.8 2"/>',
  snow: '<path d="M7.5 13.5h9.2a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6-.8 3.7 3.7 0 0 0 0 8z"/><path d="M8.5 17.2v.1M12 18.8v.1M15.5 17.2v.1M10.2 20.6v.1M13.8 20.6v.1"/>',
  wind: '<path d="M3.5 9.5h10.2a2.6 2.6 0 1 0-2.5-3.2M3.5 13h14.3a2.7 2.7 0 1 1-2.6 3.4M3.5 16.5h7"/>',
  fog: '<path d="M4 9h16M6 12.5h12M4 16h16M8 19.5h8"/>',
};
export function glyph(name, { fill = false, title = '', cls = '' } = {}) {
  const d = GLYPH[name];
  if (!d) return '';
  return `<svg class="glyph ${cls}" viewBox="0 0 24 24" width="1em" height="1em" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'}>${title ? `<title>${title}</title>` : ''}${d}</svg>`;
}
export const MOOD_GLYPH = { great: glyph('great', { title: 'отлично' }), good: glyph('good', { title: 'хорошо' }), meh: glyph('meh', { title: 'так себе' }), broken: glyph('broken', { title: 'разбит' }) };
export const GRADE_GLYPH = { A: 'flame', B: 'rise', C: 'steady', D: 'dip', E: 'moon' };
export const gradeGlyph = letter => (GRADE_GLYPH[letter] ? glyph(GRADE_GLYPH[letter], { cls: 'g-letter' }) : '');

export const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';

// ── уведомление ──
export function toast(msg, ms = 2800) {
  const t = document.getElementById('toast');
  t.textContent = String(msg ?? '').replace(/—/g, '-');
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ── кольцо прогресса ──
export function ring(pct, size = 64, stroke = 6, cls = '') {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<div class="ring ${cls} ${pct >= 100 ? 'full' : ''}" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}"><circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="fg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(100, pct) / 100)}"/></svg><b>${pct}%</b></div>`;
}

// ── формы ──
// Поле с data-form/data-key пишет значение в S.forms[form][key] (см. обработчики в app.js).
export function field(label, inner, cls = '') { return `<label class="field ${cls}"><span class="smallcaps">${label}</span>${inner}</label>`; }
export function fval(form, key, def = '') { const f = S.forms[form]; return f && key in f ? f[key] : def; }
export function input(form, key, def, attrs = '') {
  return `<input class="control" data-form="${form}" data-key="${key}" value="${esc(fval(form, key, def ?? ''))}" ${attrs}>`;
}
export function textarea(form, key, def, attrs = '') {
  return `<textarea class="control" data-form="${form}" data-key="${key}" ${attrs}>${esc(fval(form, key, def ?? ''))}</textarea>`;
}
export function select(form, key, def, options, attrs = '') {
  const v = String(fval(form, key, def ?? ''));
  return `<select class="control" data-form="${form}" data-key="${key}" ${attrs}>${options.map(([k, l]) =>
    `<option value="${esc(k)}" ${String(k) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
// переключатели-«таблетки»: одиночный выбор (multi=false) или набор (multi=true); клик - действие chip-set
export function chips(form, key, def, options, multi = false) {
  const cur = fval(form, key, def);
  const on = k => multi ? (cur || []).map(String).includes(String(k)) : String(cur) === String(k);
  return `<div class="chips">${options.map(([k, l]) => `<button type="button" class="chip ${on(k) ? 'on' : ''}"
    data-act="chip-set" data-form="${form}" data-key="${key}" data-val="${esc(k)}" data-multi="${multi ? 1 : ''}">${esc(l)}</button>`).join('')}</div>`;
}
export function ensureForm(name, init) {
  if (!S.forms[name]) S.forms[name] = typeof init === 'function' ? init() : { ...init };
  return S.forms[name];
}

// ── модальное окно ──
const $modal = () => document.getElementById('modal');
export function openModal(html) {
  const m = $modal();
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
}
export function closeModal() { const m = $modal(); m.hidden = true; m.innerHTML = ''; }
export function isModalOpen() { return !$modal().hidden; }

// ── упражнения ──
// Подробное описание: краткие шаги видны сразу, остальное - в раскрывающихся блоках.
export function techHtml(e, { open = false } = {}) {
  if (!e) return '<p class="empty">Нет описания</p>';
  const list = (title, arr, tag = 'ul') => arr?.length ? `<div class="smallcaps muted tech-h">${title}</div><${tag}>${arr.map(s => `<li>${esc(s)}</li>`).join('')}</${tag}>` : '';
  const d = e.details || {};
  const more = [
    d.setup ? `<div class="smallcaps muted tech-h">Подготовка</div><p>${esc(d.setup)}</p>` : '',
    list('Дыхание и темп', [d.breathing, d.tempo].filter(Boolean)),
    list('Что должно ощущаться', d.feel ? [d.feel] : []),
    list('Подсказки', d.cues),
    list('Частые ошибки', e.mistakes),
    list('Осторожно', d.safety),
    e.easier && S.exMap.get(e.easier) ? `<p class="note">Проще: ${esc(S.exMap.get(e.easier).name)}</p>` : '',
    e.harder && S.exMap.get(e.harder) ? `<p class="note">Сложнее: ${esc(S.exMap.get(e.harder).name)}</p>` : '',
  ].join('');
  return `${d.summary ? `<p class="small">${esc(d.summary)}</p>` : ''}
    <ol>${(e.technique || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    ${more ? `<details class="tech-more" ${open ? 'open' : ''}><summary>Подробнее о методике</summary>${more}</details>` : ''}`;
}
// контекст упражнения на экране (разминка, тренировка) — для «Заменить сейчас»; см. plan.ctxInfo
export function exCtx(el) {
  const d = el?.dataset || {};
  return d.ctx ? { kind: d.ctx, date: d.date, i: Number(d.i), ...(d.m ? { module: d.m } : {}) } : null;
}
export const ctxAttrs = ctx => (ctx ? `data-ctx="${esc(ctx.kind)}" data-date="${esc(ctx.date)}" data-i="${Number(ctx.i)}"${ctx.module ? ` data-m="${esc(ctx.module)}"` : ''}` : '');

export function showTech(id, ctx = null) {
  const e = S.exMap.get(id);
  if (!e) return toast('Описание не загружено');
  const exv = PF.exclusionOf(id), off = !!exv, liked = PF.isLiked(id);
  openModal(`<div class="modal-head"><div class="kicker smallcaps">${esc((e.muscles || []).join(', '))}</div><h2>${esc(e.name)}</h2></div>
    <div class="modal-body">${techHtml(e)}
      ${off ? `<p class="note">Вы отметили «не предлагать» - ${(exv.scope || 'all') === 'all' ? 'нигде: ни в разминках, ни в тренировках' : `только ${esc(PF.SCOPE_NAME[exv.scope])}; в остальных местах тренер его предлагает`}.</p>` : ''}</div>
    <div class="modal-foot fx-tech-acts">
      ${off ? `<button class="btn quiet" data-act="ex-unexcl" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Снова предлагать</button>`
        : `${ctx ? `<button class="btn quiet" data-act="ex-swap-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Заменить</button>` : ''}<button class="btn quiet" data-act="ex-excl-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Не предлагать</button>
          <button class="btn quiet fx-like ${liked ? 'on' : ''}" data-act="ex-like" data-ex="${esc(id)}" ${ctxAttrs(ctx)} aria-pressed="${liked}">${glyph('heart', { fill: liked })} ${liked ? 'любимое' : 'нравится'}</button>`}
      <button class="btn" data-act="close">Понятно</button></div>`);
}

// ── задачи ИИ ──
// Список - в meta (переживает перезагрузку), статус - в памяти. ref связывает задачу с объектом на экране.
export function jobFor(ref) {
  for (const j of store.getMeta('jobs', [])) if (j.ref === ref) return { ...j, ...(S.jobState.get(j.id) || {}) };
  return null;
}
export async function addJob(id, kind, ref) {
  const jobs = store.getMeta('jobs', []);
  jobs.push({ id, kind, ref, started: Date.now() });
  await store.setMeta('jobs', jobs);
  S.render();
  window.dispatchEvent(new Event('trainer:poll'));
}
export function jobNote(job, text) {
  if (job?.waiting) return `<div class="notice">${glyph('moon')} Ждёт, пока проснётся ИИ на сервере - выполнится само</div>`;
  return job ? `<div class="notice"><span class="spinner"></span> ${esc(text)}${job.ahead ? ` · в очереди ${job.ahead}` : ''}…</div>` : '';
}

export function dateNav(view, date) {
  return `<div class="datenav"><a class="btn quiet" href="#${view}/${C.addDays(date, -1)}" aria-label="Назад">←</a>
    ${date !== C.today() ? `<a class="btn" href="#${view}/${C.today()}">Сегодня</a>` : ''}
    <a class="btn quiet" href="#${view}/${C.addDays(date, 1)}" aria-label="Вперёд">→</a></div>`;
}

// «внесено задним числом»: запись о дне, сделанная больше чем через 12 часов после его конца
export function isBackdated(date, ts = Date.now()) {
  const end = C.parse(date); end.setDate(end.getDate() + 1);
  return ts - end.getTime() > 12 * 3600e3;
}

export const routeArg = () => (location.hash.slice(1).split('/')[1]) || C.today();

// после любой правки дня: сводка для партнёра и новые достижения
let achTimer = null;
export async function afterChange(date) {
  await C.refreshDsum(date);
  clearTimeout(achTimer);
  achTimer = setTimeout(async () => {
    const fresh = await C.awardAchievements();
    fresh.forEach((a, i) => setTimeout(() => toast(`Достижение: ${a.title}`, 3500), i * 3600));
  }, 600);
}
