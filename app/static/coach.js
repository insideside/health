// Метрики и мотивация. Всё считается на клиенте, без сервера и без ИИ.
//
// v1: чек-лист, серии, опыт, уровни, достижения, реплики тренера.
// v2: сон, самочувствие, типы дня, оценка дня и недели, плавный старт, недельный объём движения,
//     пищевые привычки и окно питания, инициативные сообщения тренера (ruleMessages), читмил,
//     сглаженный вес, плато, цикл.
// v3: обращение по имени с падежами и родом (names.js), правила «вчера → сегодня» и «что ещё успеть вечером»,
//     честные пометки о локальных расчётах (sourceNote), отношение тренера к дню (attitude), дневной сон.
//
// Функции вызываются на каждой перерисовке, поэтому тяжёлое кэшируется «на такт»: кэш живёт, пока
// идёт синхронный код, и сбрасывается в ближайшей микрозадаче (после любого await данные уже свежие).
import * as store from './store.js';
import * as N from './names.js';
import * as FD from './foods.js';
// цели-показатели (goals.lines) — модуль импортирует нас в ответ; цикл безопасен, пока обращения только внутри функций
import * as G from './goals.js';

// ── расширения ──
// plan.js добавляет реплики (кардио) и правила чата (сигнал «упражнение не заходит») через extend —
// без обратного импорта plan.js сюда. Хранилище создаётся лениво: порядок загрузки модулей не важен.
function extras() { return extras.v || (extras.v = { lines: [], rules: [] }); }
export function extend(kind, fn) { extras()[kind]?.push(fn); }
function runExtras(kind, ...args) {
  const out = [];
  for (const fn of extras()[kind] || []) { try { out.push(...(fn(...args) || [])); } catch (e) { console.warn('[coach.extend]', e); } }
  return out;
}

// ── кэш на такт ──
let TICK = null;
function tick() {
  if (!TICK) { TICK = new Map(); queueMicrotask(() => { TICK = null; }); }
  return TICK;
}
function memo(key, fn) {
  const t = tick();
  if (t.has(key)) return t.get(key);
  const v = fn();
  t.set(key, v);
  return v;
}
// записи вида kind пользователя uid, разложенные по датам
function index(kind, uid) {
  return memo(`i|${kind}|${uid}`, () => {
    const m = new Map();
    for (const r of store.list(kind, uid)) {
      if (!r.date) continue;
      let a = m.get(r.date);
      if (!a) m.set(r.date, a = []);
      a.push(r);
    }
    return m;
  });
}
function recsOn(kind, date, uid = store.uid()) { return index(kind, uid).get(date) || []; }

// ── даты ──
export function ymd(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
export function today() { return ymd(); }
export function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }
export function weekday(s) { return (parse(s).getDay() + 6) % 7; }          // 0 = пн
export function mondayOf(s = today()) { return addDays(s, -weekday(s)); }
function isoWeek(s) {
  const d = parse(s); const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const first = new Date(d.getFullYear(), 0, 4);
  return d.getFullYear() * 100 + 1 + Math.round(((d - first) / 864e5 - 3 + ((first.getDay() + 6) % 7)) / 7);
}
export function toMin(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const hmOf = m0 => { const m = Math.round(m0); return `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const dec = (x, n = 1) => String(Math.round(x * 10 ** n) / 10 ** n).replace('.', ',');
function plural(n, one, few, many) {
  if (!Number.isInteger(Number(n))) return few;          // дробное: «1½ стакана», «0,5 стакана»
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
}

function prof(uid = store.uid()) { return store.get(`profile:${uid}`)?.data || {}; }
function goalOf(uid = store.uid()) { return store.get(`goal:${uid}`)?.data || {}; }

// ── нормы, пункты, значения ──
export function target(uid = store.uid()) {
  return memo(`target|${uid}`, () => {
    const rows = store.list('target', uid);
    rows.sort((a, b) => (a.data.valid_from || '').localeCompare(b.data.valid_from || '') || a.updated_at - b.updated_at);
    return rows.length ? rows[rows.length - 1].data : null;
  });
}

export function items(uid = store.uid()) {
  return memo(`items|${uid}`, () =>
    store.list('item', uid, r => r.data.active !== false).sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0)));
}

export function workout(date, uid = store.uid()) { return store.get(`wo:${uid}:${date}`); }
// тренировка, которая на этот день реально стоит (перенесённая на другой день — не считается)
function activeWorkout(date, uid) {
  const w = workout(date, uid);
  return w && w.data.variant !== 'moved' ? w : null;
}
export function logId(date, itemId, uid = store.uid()) { return `log:${uid}:${date}:${itemId}`; }
export function logVal(date, itemId, uid = store.uid()) { return store.get(logId(date, itemId, uid))?.data.v; }

// цель-показатель из «Целей» (например «Вода: до 6 стаканов») - выбор человека, он важнее расчётной нормы
export function goalTo(metric, uid = store.uid()) {
  const g = (store.get(`goal:${uid}`)?.data?.goals || []).find(x => x.type === 'metric' && x.metric === metric);
  return Number(g?.to) > 0 ? Number(g.to) : null;
}
export function itemTarget(item, date, uid = store.uid()) {
  const t = target(uid);
  const d = item.data;
  if (d.target_from === 'water') {
    const own = goalTo('water_avg', uid);
    if (own) return Math.round(own);
    if (t) return activeWorkout(date, uid) ? t.water_glasses_gym || t.water_glasses : t.water_glasses;
  }
  if (d.target_from === 'steps') {
    const own = t?.steps_manual || goalTo('steps_avg', uid);
    if (own) return Math.round(own);
    if (t) return t.steps;
  }
  return d.target || 1;
}

// Приёмы пищи дня блоками: завтрак, обед, ужин - по одному; каждый перекус - свой блок (записи перекуса ближе
// SNACK_GAP_MIN друг к другу - один перекус). Блоки по времени. Протеин из добавок (calc supp) - не приём пищи:
// all: true - вместе с ним (для экрана «Питание»). → [{ meal, n (номер перекуса), time, entries }]
export const SNACK_GAP_MIN = 45;
const MEAL_DEFAULT_MIN = { breakfast: 8 * 60, lunch: 13 * 60, snack: 16 * 60, dinner: 19 * 60 };
const recTime = r => toMin(r.data.time) ?? (r.data.created ? new Date(r.data.created).getHours() * 60 + new Date(r.data.created).getMinutes() : null);
export function mealBlocks(date, uid = store.uid(), { all = false } = {}) {
  const recs = recsOn('food', date, uid).filter(r => all ? !(r.data.calc === 'drink' && milkMode(uid) === 'hidden') : !['supp', 'drink'].includes(r.data.calc));
  const main = new Map(), snacks = [];
  for (const r of recs) {
    const m = r.data.meal || 'snack';
    if (m === 'snack') snacks.push(r);
    else { if (!main.has(m)) main.set(m, []); main.get(m).push(r); }
  }
  const t = r => recTime(r) ?? MEAL_DEFAULT_MIN[r.data.meal || 'snack'];
  const blocks = [...main].map(([meal, entries]) => ({ meal, entries, time: Math.min(...entries.map(t)) }));
  let cur = null;
  for (const r of snacks.sort((a, b) => t(a) - t(b))) {
    if (cur && t(r) - cur.last <= SNACK_GAP_MIN) { cur.entries.push(r); cur.last = t(r); continue; }
    cur = { meal: 'snack', entries: [r], time: t(r), last: t(r) };
    blocks.push(cur);
  }
  blocks.sort((a, b) => a.time - b.time);
  let n = 0;
  for (const b of blocks) { if (b.meal === 'snack') b.n = ++n; b.entries.sort((x, y) => t(x) - t(y)); delete b.last; }
  return blocks;
}
export function meals(date, uid = store.uid()) { return mealBlocks(date, uid).length; }
// цель по приёмам: основные (по умолчанию 3) + каждый записанный перекус - «завтрак и перекус» = 2 из 4
export function mealsTarget(date, base = 3, uid = store.uid()) { return base + mealBlocks(date, uid).filter(b => b.meal === 'snack').length; }

export function workoutProgress(w) {
  if (!w) return 0;
  if (w.data.done) return 1;
  let total = 0, done = 0;
  for (const ex of w.data.exercises || []) {
    total += Number(ex.sets) || 0;
    done += (ex.log || []).filter(s => s && s.done).length;
  }
  return total ? Math.min(1, done / total) : 0;
}

// → {applies, frac, value, target}
// Чай и кофе: пункты чек-листа для учёта (track: true, в процент дня не входят). Каждая чашка - отдельная
// запись drink {kind: coffee|tea, time: 'ЧЧ:ММ'}: время правится, два устройства не спорят за один счётчик.
export const CUPS = { coffee: { title: 'Кофе', unit: 'чаш.' }, tea: { title: 'Чай', unit: 'чаш.' } };
export const CUP_LATE_MIN = 14 * 60;
export const cupItemId = (kind, uid = store.uid()) => `${kind}_${uid}`;
export function cupList(date, kind, uid = store.uid()) {
  return store.byDate('drink', date, uid).filter(r => !kind || r.data.kind === kind)
    .sort((a, b) => (a.data.time || '').localeCompare(b.data.time || '') || (a.data.created || 0) - (b.data.created || 0));
}
// → { coffee, tea (null - не отслеживается), late - чашек после 14:00, last, lastCoffee, tracked }
// размер чашки: 1 или ½ (amount: 0.5); старые записи без поля - целая
export const cupAmount = r => (Number(r?.data?.amount) > 0 ? Number(r.data.amount) : 1);
export const cupNum = v => String(Math.round(v * 10) / 10).replace('.', ',');
// стаканы воды: можно по полстакана (log v = 1.5) → «1½», «½»
export const glassNum = v => {
  const n = Math.round((Number(v) || 0) * 2) / 2, w = Math.floor(n);
  return n % 1 ? `${w || ''}½` : String(n);
};
export function cups(date, uid = store.uid()) {
  const out = { coffee: null, tea: null, late: 0, last: null, lastCoffee: null };
  const recs = cupList(date, null, uid);
  for (const kind of Object.keys(CUPS)) {
    const it = store.get(cupItemId(kind, uid));
    const mine = recs.filter(r => r.data.kind === kind);
    if ((!it || it.data.active === false) && !mine.length) continue;
    out[kind] = mine.reduce((a, r) => a + cupAmount(r), 0);
  }
  for (const r of recs) {
    const t = r.data.time;
    if (!t) continue;
    if ((toMin(t) ?? 0) >= CUP_LATE_MIN) out.late += cupAmount(r);
    if (!out.last || t > out.last) out.last = t;
    if (r.data.kind === 'coffee' && (!out.lastCoffee || t > out.lastCoffee)) out.lastCoffee = t;
  }
  out.tracked = out.coffee != null || out.tea != null;
  return out;
}

// ── курение и алкоголь: цель «бросить курить» / «меньше алкоголя» в profile-целях (goalOf().habits) включает
// счётчик в чек-листе «Сегодня»; без цели - в интерфейсе этого нет вовсе. Каждый случай - отдельная запись
// (smoke/alcohol) со временем и подтипом, как чашка кофе; сам счёт - track-пункт, в процент дня не входит. ──
export const SMOKE_TYPES = [['cigarette', 'Сигареты'], ['vape', 'Вейп / HQD'], ['iqos', 'Системы нагревания (IQOS и похожие)'], ['hookah', 'Кальян'], ['other', 'Другое']];
export const smokeLabel = type => SMOKE_TYPES.find(([k]) => k === type)?.[1] || 'Курение';
export const smokingOn = (uid = store.uid()) => (goalOf(uid).habits || []).includes('quit_smoking');
// что курит человек (выбрано в профиле) - если ничего не выбрано, предлагаем весь список
export function smokeTypesOf(uid = store.uid()) {
  const sel = goalOf(uid).smoking_types || [];
  return sel.length ? SMOKE_TYPES.filter(([k]) => sel.includes(k)) : SMOKE_TYPES;
}
export function smokeList(date, uid = store.uid()) {
  return store.byDate('smoke', date, uid).sort((a, b) => (a.data.time || '').localeCompare(b.data.time || '') || (a.data.created || 0) - (b.data.created || 0));
}
export const ALCOHOL_TYPES = [['beer', 'Пиво', '0,33 л, ~5%'], ['wine', 'Вино', '150 мл, ~12%'], ['spirits', 'Крепкое', '50 мл, ~40%'], ['other', 'Другое', '']];
export const alcoholLabel = type => ALCOHOL_TYPES.find(([k]) => k === type)?.[1] || 'Алкоголь';
export const alcoholOn = (uid = store.uid()) => (goalOf(uid).habits || []).includes('less_alcohol');
export function alcoholList(date, uid = store.uid()) {
  return store.byDate('alcohol', date, uid).sort((a, b) => (a.data.time || '').localeCompare(b.data.time || '') || (a.data.created || 0) - (b.data.created || 0));
}
// дней без единой записи - от последнего случая (включительно) до сегодня; записей никогда не было - null
// (тогда хвалить пока не за что численно, просто «пока всё чисто»)
function freeDays(kind, uid) {
  const dates = [...index(kind, uid).keys()].sort();
  if (!dates.length) return null;
  return daysBetween(dates[dates.length - 1], today());
}
export const smokeFreeDays = (uid = store.uid()) => freeDays('smoke', uid);
export const alcoholFreeDays = (uid = store.uid()) => freeDays('alcohol', uid);

// ── группы (item 15): агрегированная веха «кто что делал» - без подробностей (какие именно упражнения,
// что съедено), только тип, короткая подпись и минуты/метрика. Только если есть хоть одна группа и человек
// не выключил «Делиться активностью в группе» в профиле (по умолчанию - включено). ──
export function shareHighlights(uid = store.uid()) { return prof(uid).share_activity !== false; }
// веха для ленты «Вместе»: тип, подпись, минуты - без подробностей. Пишется, если есть с кем делиться (партнёр или
// группа) и не выключено «делиться активностями»
// id - постоянный (без дублей), src - запись-источник: пропал источник или снята отметка - веха уходит (syncHighlights)
export async function shareHighlight(type, label, minutes = null, date = today(), id = null, src = null) {
  if ((!store.partners().length && !store.groups().length) || !shareHighlights()) return;
  if (id && store.get(id)) return;
  await store.put('highlight', id || store.newId(), { type, label, minutes, date, created: Date.now(), ...(src ? { src } : {}) }, date);
}
export async function unshareHighlight(id) { if (id && store.get(id)) await store.remove(id); }
// сверка своих вех за последние дни: комплекс не закрыт, тренировка не завершена, активность удалена - веху убрать
// (отметки сняли на другом устройстве, в чате, при подстройке плана - везде, а не только кнопками здесь)
export async function syncHighlights(days = 7, uid = store.uid()) {
  const from = addDays(today(), -(days - 1));
  for (const r of store.list('highlight', uid, x => x.date >= from && x.data.src)) {
    const s = store.get(r.data.src);
    const alive = s && (['complex', 'workout', 'gym'].includes(r.data.type) ? !!s.data.done : true);
    if (!alive) await store.remove(r.id);
  }
}
// автор скрывает свою карточку из ленты: веху - удаляет; достижение и хороший день - скрывает (сами они остаются
// в статистике), список скрытого - публичная запись highlight:{uid}:hidden, её видят и другие
const hiddenId = uid => `highlight:${uid}:hidden`;
const hiddenKeys = uid => new Set(store.get(hiddenId(uid))?.data.keys || []);
export async function hideFeedItem(x) {
  if (x.kind === 'hl') return store.remove(x.key);
  const uid = store.uid(), keys = [...hiddenKeys(uid), x.key].slice(-500);
  await store.put('highlight', hiddenId(uid), { keys }, null);
}
// Лента «Вместе»: события каждого (и свои) за последние days дней, от новых к старым - только то, что человек
// публикует сам: вехи (highlight), достижения (ach, без веса и замеров - их сервер другим не отдаёт) и успешные дни
// (итог дня от 80 % чек-листа или оценка «хорошо»). who - id человека или null (все).
export function feed(days = 14, who = null) {
  const me = store.uid(), from = addDays(today(), -(days - 1));
  const people = [{ id: me, name: 'Вы', me: true }, ...store.partners()].filter(p => !who || p.id === who);
  const out = [];
  for (const p of people) {
    const hid = hiddenKeys(p.id);
    for (const r of store.list('highlight', p.id, x => x.date >= from && x.data.type)) {
      out.push({ kind: 'hl', key: r.id, who: p, date: r.date, at: r.data.created || r.updated_at, type: r.data.type, label: r.data.label, minutes: r.data.minutes });
    }
    for (const r of store.list('ach', p.id, x => (x.data.earned || x.date) >= from)) {
      if (hid.has(r.id)) continue;
      const d = r.data.earned || r.date;
      out.push({ kind: 'ach', key: r.id, who: p, date: d, at: r.updated_at, title: r.data.title || r.data.code, couple: !!r.data.couple });
    }
    for (const r of store.list('dsum', p.id, x => x.date >= from)) {
      const pct = Number(r.data.pct) || 0;
      if ((pct < 80 && r.data.grade !== 'good') || hid.has(`day:${r.date}`)) continue;
      out.push({ kind: 'day', key: `day:${r.date}`, who: p, date: r.date, at: parse(r.date).getTime() + 86399e3, pct, grade: r.data.grade });
    }
  }
  return out.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : (b.at || 0) - (a.at || 0)));
}
// сегодняшние (или за N последних дней) вехи всех, с кем есть общая группа - для ленты на «Вместе»
export function groupHighlights(days = 1, uid = store.uid()) {
  const mates = new Set();
  for (const g of store.groups()) for (const m of g.members || []) if (m.id !== uid) mates.add(m.id);
  const from = addDays(today(), -(days - 1));
  const out = [];
  for (const mid of mates) {
    const name = store.groups().flatMap(g => g.members || []).find(m => m.id === mid)?.name || 'Участник';
    for (let d = from; d <= today(); d = addDays(d, 1)) {
      for (const r of store.byDate('highlight', d, mid)) out.push({ ...r.data, name, uid: mid });
    }
  }
  return out.sort((a, b) => (b.created || 0) - (a.created || 0));
}

// ── молоко в кофе: считаем в БЖУ дня (drink.milk → связанная запись food, как протеин у добавок) ──
// фиксированный список - точные названия из справочника, без нечёткого поиска
export const MILK_TYPES = [
  ['3.2', 'Молоко 3,2%', '3,2%'], ['2.5', 'Молоко 2,5%', '2,5%'], ['1.5', 'Молоко 1,5%', '1,5%'],
  ['1', 'Молоко 1%', '1%'], ['0.5', 'Молоко 0,5%', 'обезжиренное'], ['lf', 'Молоко безлактозное 1,5%', 'безлактозное'],
  ['oat', 'Молоко овсяное', 'овсяное'], ['almond', 'Молоко миндальное', 'миндальное'], ['soy', 'Молоко соевое', 'соевое'],
];
const milkFoodName = type => MILK_TYPES.find(([k]) => k === type)?.[1] || null;
export const milkLabel = type => MILK_TYPES.find(([k]) => k === type)?.[2] || '';
const mealAt = time => { const m = toMin(time) ?? 12 * 60; return m < 11 * 60 ? 'breakfast' : m < 16 * 60 ? 'lunch' : m < 21 * 60 ? 'dinner' : 'snack'; };
// профиль: молоко показывать отдельной строкой в приёме пищи ('meal') или только в итогах дня ('hidden')
export const milkMode = (uid = store.uid()) => prof(uid).milk_mode === 'hidden' ? 'hidden' : 'meal';
// приём пищи для молока: выбранный у чашки, иначе - по её времени
export const milkMeal = (milk, time) => milk?.meal || mealAt(time);
function milkFor(milk, time) {
  const name = milk?.type && Number(milk.ml) > 0 ? milkFoodName(milk.type) : null;
  const f = name && FD.findByName(name);
  if (!f) return null;
  const it = FD.itemFor(f, milk.ml);
  return { meal: milkMeal(milk, time), text: `молоко к кофе, ${milkLabel(milk.type)}, ${Math.round(milk.ml)} мл`, items: [it],
    totals: { kcal: it.kcal, p: it.p, f: it.f, c: it.c }, status: 'calculated', calc: 'drink', time };
}
// молоко в кофе за день: сколько чашек, мл и БЖУ (для строки «Молоко в кофе» при режиме «только в итогах»)
export function milkDay(date, uid = store.uid()) {
  const recs = recsOn('food', date, uid).filter(r => r.data.calc === 'drink');
  const t = { n: recs.length, ml: 0, kcal: 0, p: 0, f: 0, c: 0 };
  for (const r of recs) {
    t.ml += Number(r.data.items?.[0]?.grams) || 0;
    for (const k of ['kcal', 'p', 'f', 'c']) t[k] += Number(r.data.totals?.[k]) || 0;
  }
  return t;
}
// поставить/снять молоко у чашки кофе: молока нет или ml=0 → связанная запись еды убирается
export async function setCupMilk(id, milk) {
  const r = store.get(id);
  if (!r) return;
  const f = milkFor(milk, r.data.time);
  if (f && r.data.food_id && store.get(r.data.food_id)) {
    await store.put('food', r.data.food_id, { ...store.get(r.data.food_id).data, ...f }, r.date);
    await store.patch(id, { milk });
  } else if (f) {
    const fid = store.newId();
    await store.put('food', fid, { ...f, drink_id: id, created: Date.now(), entered_at: Date.now() }, r.date);
    await store.patch(id, { milk, food_id: fid });
  } else {
    if (r.data.food_id && store.get(r.data.food_id)) await store.remove(r.data.food_id);
    await store.patch(id, { milk: null, food_id: null });
  }
}

export function progress(item, date, uid = store.uid()) {
  const d = item.data;
  if (d.weekdays && d.weekdays.length && !d.weekdays.includes(weekday(date))) return { applies: false };
  if (d.type === 'workout') {
    const w = activeWorkout(date, uid);
    if (!w) return { applies: false };
    const dt = dayType(date, uid);
    // в день болезни или отдыха тренировка не требуется: засчитывается, только если сделана
    if ((dt === 'sick' || dt === 'rest') && workoutProgress(w) < 1) return { applies: false };
    return { applies: true, frac: workoutProgress(w), value: w };
  }
  if (d.type === 'routine') {
    // утренняя разминка — один пункт: прогресс по отмеченным упражнениям комплекса дня
    const r = store.get(`routine:${uid}:${date}:${d.module || 'morning'}`);
    const ex = r?.data.exercises || [];
    const n = ex.filter(x => x.done).length;
    return { applies: true, frac: ex.length ? n / ex.length : 0, value: n, target: ex.length, rec: r };
  }
  if (d.type === 'food') {
    const n = meals(date, uid), t = mealsTarget(date, d.target || 3, uid);
    return { applies: true, frac: Math.min(1, n / t), value: n, target: t };
  }
  const v = logVal(date, item.id, uid);
  if (d.type === 'bool') return { applies: true, frac: v ? 1 : 0, value: !!v };
  const t = itemTarget(item, date, uid);
  const n = Number(v) || 0;
  return { applies: true, frac: t ? Math.min(1, n / t) : 0, value: n, target: t };
}

// ── план недели: комплексы из профиля (шея, осанка) и активности (велосипед, бассейн…) ──
// У задачи «n раз в неделю» есть удобные дни: выбранные в профиле, иначе дни без тренировок (длинные занятия - выходные).
// План считается заново на каждую дату: сделанное раньше в эту неделю вычитается, остаток раскладывается
// на эту дату…воскресенье - сначала на удобные дни, пропущенное переносится на свободные.
// Для прошедшей даты - план, каким он был в тот день (отметки те же), поэтому процент дня не «переписывается».
export const PLAN_MODULES = ['neck', 'posture'];
export const WALK_TYPES = new Set(['walking', 'walk_fast']);        // ходьба засчитывается шагами
const LONG_ACTIVITY_MIN = 90;
const HOME_ZONE_MODULE = { abs: 'abs', sides: 'abs', arms: 'arms', shoulders: 'arms', legs: 'legs', glutes: 'legs', back: 'back', chest: 'back' };
const HOME_MIN = { abs: 10, arms: 15, legs: 15, back: 15, workout: 20 };
const ZONE_WORD = { abs: 'пресс', sides: 'бока', arms: 'руки', shoulders: 'плечи', legs: 'ноги', glutes: 'ягодицы', back: 'спина', chest: 'грудь' };
function spreadDays(days, n) {
  if (n >= days.length) return [...days];
  return Array.from({ length: n }, (_, i) => days[Math.floor((i + 0.5) * days.length / n)]);
}
const activityTimes = a => Math.min(7, Math.max(1, Number(a.per_week) || a.weekdays?.length || 1));
// удобные дни активности: выбранные в профиле, длинные - выходные, остальные - pick(n)
function activityIdeal(a, pick) {
  const wds = [...new Set((a.weekdays || []).map(Number))].sort(), n = activityTimes(a);
  return wds.length ? wds : (Number(a.minutes) || 0) >= LONG_ACTIVITY_MIN && n <= 2 ? [5, 6].slice(0, n) : pick(n);
}
export function planTasks(uid = store.uid()) {
  return memo(`pt|${uid}`, () => {
    const p = prof(uid), gym = new Set(p.weekdays || []);      // дни тренировок программы
    const all = [0, 1, 2, 3, 4, 5, 6], free = all.filter(d => !gym.has(d));
    const pick = n => spreadDays(free.length >= n ? free : all, n);
    const hasSteps = items(uid).some(i => i.data.target_from === 'steps');
    const out = [];
    for (const k of PLAN_MODULES) {
      const m = p.modules?.[k];
      if (!m?.enabled) continue;
      const n = Math.min(7, Math.max(1, Number(m.per_week) || 3));
      out.push({ key: `mod:${k}`, kind: 'module', module: k, n, minutes: Number(m.minutes) || null, ideal: pick(n) });
    }
    // домашние комплексы под цели: акценты из норм (руки ×1,4…) → комплекс на эту зону в дни без зала;
    // если тренировок по программе меньше, чем в нормах, - добор короткими тренировками. Выключается в профиле.
    if (p.modules?.home_plan?.enabled !== false) {
      const zones = target(uid)?.intensity?.emphasis?.zones || {}, mult = {};
      for (const [z, v] of Object.entries(zones)) {
        const k = HOME_ZONE_MODULE[z];
        if (k && Number(v) >= 1.1) mult[k] = Math.max(mult[k] || 0, Number(v));
      }
      const why = k => 'под цель: ' + Object.entries(zones).filter(([z, v]) => HOME_ZONE_MODULE[z] === k && Number(v) >= 1.1)
        .map(([z, v]) => `${ZONE_WORD[z] || z} ×${String(v).replace('.', ',')}`).join(', ');
      // не в дни длинных активностей (велосипед на полдня + силовая дома - перебор), если хватает других дней
      const busy = new Set((p.activities || []).filter(a => a.type && Number(a.minutes) >= 60 && !(WALK_TYPES.has(a.type) && hasSteps)).flatMap(a => activityIdeal(a, pick)));
      const calm = free.filter(d => !busy.has(d));
      const pickHome = n => (calm.length >= n ? spreadDays(calm, n) : pick(n));
      let room = Math.min(3, free.length);
      for (const [k, v] of Object.entries(mult).sort((x, y) => y[1] - x[1])) {
        const n = Math.min(room, v >= 1.3 ? 2 : 1);
        if (n <= 0) break;
        room -= n;
        out.push({ key: `home:${k}`, kind: 'module', module: k, n, minutes: HOME_MIN[k], ideal: pickHome(n), why: why(k) });
      }
      const hasProgram = store.list('program', uid).some(r => r.data.active !== false);
      const need = Number(target(uid)?.intensity?.weekly_sessions) || 0, have = hasProgram ? (p.weekdays || []).length : 0;
      const add = Math.min(room, Math.max(0, need - have));
      if (add > 0 && hasProgram) {
        out.push({ key: 'home:workout', kind: 'module', module: 'workout', n: add, minutes: HOME_MIN.workout, ideal: pickHome(add),
          why: `добор до нормы: ${need} ${need < 5 ? 'тренировки' : 'тренировок'} в неделю, по программе ${have}` });
      }
    }
    for (const a of p.activities || []) {
      if (!a.type || (WALK_TYPES.has(a.type) && hasSteps)) continue;
      const n = activityTimes(a), min = Number(a.minutes) || 0, ideal = activityIdeal(a, pick);
      out.push({ key: `act:${a.type}`, kind: 'activity', type: a.type, name: a.name || null, n, minutes: min || null, intensity: a.intensity || 'mid', ideal });
    }
    return out;
  });
}
// сделано ли в этот день: комплекс - отмечена хотя бы половина упражнений, активность - есть запись этого вида
export function planDone(task, date, uid = store.uid()) {
  if (task.kind === 'module') {
    const ex = store.get(`routine:${uid}:${date}:${task.module}`)?.data.exercises || [];
    return ex.length ? ex.filter(x => x.done).length / ex.length : 0;
  }
  return recsOn('activity', date, uid).some(r => r.data.type === task.type) ? 1 : 0;
}
function planDayOpen(date, uid) {
  const dt = dayType(date, uid);
  if (dt === 'sick' || dt === 'rest' || dt === 'special') return false;
  return prof(uid).schedule?.days?.[weekday(date)]?.slot !== 'none';
}
// → [{ ...задача, date, frac, due, moved, left }] на дату: запланированное на этот день и сделанное сверх плана
export function weekPlan(date = today(), uid = store.uid()) {
  return memo(`wp|${uid}|${date}`, () => {
    const t = today(), from = date > t ? t : date;
    const mon = mondayOf(date), sun = addDays(mon, 6);
    if (from < mon) return [];
    const out = [];
    for (const task of planTasks(uid)) {
      let doneBefore = 0;
      for (let d = mon; d < from; d = addDays(d, 1)) if (planDone(task, d, uid) >= 0.5) doneBefore++;
      const left = task.n - doneBefore;
      let chosen = [];
      if (left > 0) {
        const cands = [];
        for (let d = from; d <= sun; d = addDays(d, 1)) if (planDayOpen(d, uid)) cands.push(d);
        const idealAhead = cands.filter(d => task.ideal.includes(weekday(d)));
        chosen = idealAhead.slice(0, left);
        if (chosen.length < left) chosen.push(...spreadDays(cands.filter(d => !chosen.includes(d)), left - chosen.length));
      }
      const frac = date <= t ? planDone(task, date, uid) : 0;
      const due = chosen.includes(date);
      if (!due && frac <= 0) continue;
      out.push({ ...task, date, frac, due, moved: due && !task.ideal.includes(weekday(date)), left: Math.max(0, left) });
    }
    return out;
  });
}

export function dayScore(date, uid = store.uid()) {
  return memo(`ds|${uid}|${date}`, () => {
    let sum = 0, total = 0, done = 0, xp = 0, workoutState = 'none';
    for (const it of items(uid)) {
      if (it.data.track) continue;           // чай/кофе - учёт, а не задача: в процент дня не входят
      const p = progress(it, date, uid);
      if (!p.applies) continue;
      total++; sum += p.frac;
      if (p.frac >= 1) { done++; xp += it.data.type === 'workout' ? 50 : 10; }
      if (it.data.type === 'workout') workoutState = p.frac >= 1 ? 'done' : 'planned';
    }
    // план недели: шея, осанка, активности - как пункты чек-листа (сделанное сверх плана тоже засчитывается)
    for (const e of weekPlan(date, uid)) {
      if (!e.due && e.frac < 1) continue;
      total++; sum += Math.min(1, e.frac);
      if (e.frac >= 1) { done++; xp += 10; }
    }
    const pct = total ? Math.round(sum / total * 100) : 0;
    if (total && done === total) xp += 30;
    return { pct, done, total, xp, workout: workoutState };
  });
}

// для партнёра — только опубликованные сводки
export function pctOf(date, uid) {
  if (uid === store.uid()) return dayScore(date, uid).pct;
  return store.get(`ds:${uid}:${date}`)?.data.pct ?? 0;
}

// сводку дня публикуем партнёру и серверу (разбор недели); пишем только при изменении
export async function refreshDsum(date) {
  const uid = store.uid();
  if (!uid) return;
  const s = { ...dayScore(date, uid) };
  const g = dayGrade(date, uid);
  s.grade = g.grade;
  s.score = g.score;
  Object.assign(s, dsumCompete(date, uid));     // соревнование: шаги, активность, сон — только с согласия
  // порог серии на этот день (плавный старт меняет его) - публикуем вместе с pct, иначе партнёр видит серию
  // по чужому порогу 80 % вместо реального (плавный старт даёт меньше) и она «не совпадает» с тем, что вижу я сам
  s.min = streakMin(date, uid);
  const cur = store.get(`ds:${uid}:${date}`)?.data;
  if (cur?.cheer) s.cheer = cur.cheer;
  if (cur?.cheers) s.cheers = cur.cheers;
  if (cur?.thanks) s.thanks = cur.thanks;          // «спасибо» на фразы партнёров - видно отправителю
  if (cur && stableJson(cur) === stableJson(s)) return;
  if (!cur && s.pct === 0 && s.grade === 'none') return;
  await store.put('dsum', `ds:${uid}:${date}`, s, date);
  // сводка недели зависит от дня — обновим и её
  await refreshWsum(mondayOf(date));
}

// ── история: серии, опыт, уровни ──
export function firstDay(uid = store.uid()) {
  return memo(`first|${uid}`, () => {
    let min = null;
    for (const kind of ['log', 'dsum', 'food', 'body', 'sleep', 'state', 'activity']) {
      for (const d of index(kind, uid).keys()) if (!min || d < min) min = d;
    }
    return min;
  });
}

export const STREAK_MIN = 80;

// ── плавный старт ──
// 'smooth': объём 60 → 100 % и порог серии 50 → 80 % за 21 день от start_date; 'hard' — сразу 100 % и 80 %.
function rampFrac(date, uid) {
  const p = prof(uid);
  if (p.start_mode !== 'smooth' || !p.start_date) return 1;
  return clamp(daysBetween(p.start_date, date) / 21, 0, 1);
}
export function rampFactor(date = today(), uid = store.uid()) {
  return Math.round((0.6 + 0.4 * rampFrac(date, uid)) * 100) / 100;
}
export function streakMin(date = today(), uid = store.uid()) {
  return Math.round(50 + 30 * rampFrac(date, uid));
}

// Серия: дни ≥ порога (80 %, при плавном старте 50 → 80 %). Один «плохой» день в календарную неделю
// прощается (заморозка). Сегодняшний незаконченный день серию не ломает. Дни болезни и особые дни
// серию не рвут и не продлевают.
export function streaks(uid = store.uid()) {
  return memo(`streaks|${uid}`, () => {
    const start = firstDay(uid), end = today();
    if (!start) return { current: 0, best: 0, frozen: false };
    const mine = uid === store.uid();
    // порог: свой - считаем сами (профиль виден целиком), партнёра - берём тот, что он сам опубликовал с pct
    // за этот день (refreshDsum), иначе увидим его серию по чужому фиксированному порогу и она не совпадёт с его
    const minFor = d => mine ? streakMin(d, uid) : (store.get(`ds:${uid}:${d}`)?.data.min ?? STREAK_MIN);
    let run = 0, best = 0, frozenWeeks = new Set(), frozenNow = false;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const p = pctOf(d, uid);
      if (p >= minFor(d)) { run++; best = Math.max(best, run); continue; }
      if (d === end) break;
      { const t = dayType(d, uid); if (t === 'sick' || t === 'special') continue; }
      const w = isoWeek(d);
      if (!frozenWeeks.has(w)) { frozenWeeks.add(w); frozenNow = w === isoWeek(end); continue; }
      run = 0;
    }
    return { current: run, best, frozen: frozenNow };
  });
}

export function totalXp(uid = store.uid()) {
  return memo(`xp|${uid}`, () => {
    if (uid !== store.uid()) return store.list('dsum', uid).reduce((s, r) => s + (r.data.xp || 0), 0);
    const start = firstDay(uid);
    if (!start) return 0;
    let xp = 0;
    for (let d = start; d <= today(); d = addDays(d, 1)) xp += dayScore(d, uid).xp;
    return xp;
  });
}

const LEVELS = ['Новобранец', 'Любитель', 'Регулярный', 'Упорный', 'Закалённый', 'Атлет', 'Машина', 'Железный', 'Титан', 'Легенда'];
const LEVELS_F = ['Новобранец', 'Любитель', 'Регулярная', 'Упорная', 'Закалённая', 'Атлет', 'Машина', 'Железная', 'Титан', 'Легенда'];
// sex — пол того, чей уровень; по умолчанию текущий пользователь (прилагательные в званиях — по роду)
export function level(xp, sex = prof().sex) {
  let n = 1;
  while (100 * (n + 1) * n <= xp) n++;
  const from = 100 * n * (n - 1), to = 100 * (n + 1) * n;
  const L = sex === 'f' ? LEVELS_F : LEVELS;
  return { n, title: L[Math.min(n - 1, L.length - 1)], xp, from, to, frac: (xp - from) / (to - from) };
}

// ── вес ──
export function weights(uid = store.uid()) {
  return memo(`weights|${uid}`, () =>
    store.list('body', uid, r => r.data.weight).sort((a, b) => a.date.localeCompare(b.date))
      .map(r => ({ date: r.date, w: Number(r.data.weight) })));
}

// наклон (кг/неделя) по точкам за последние `days` дней, методом наименьших квадратов
export function weightTrend(days = 21, uid = store.uid()) {
  const from = addDays(today(), -days);
  const pts = weights(uid).filter(p => p.date >= from);
  if (pts.length < 3) return null;
  const xs = pts.map(p => (parse(p.date) - parse(from)) / 864e5), ys = pts.map(p => p.w);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  if (!den || xs[xs.length - 1] - xs[0] < 10) return null;
  return num / den * 7;
}

// Сглаженный вес: экспоненциальное среднее с периодом 7 дней, учитывает пропуски между взвешиваниями.
export function smoothedWeights(uid = store.uid()) {
  return memo(`sw|${uid}`, () => {
    const out = [];
    let trend = null, prev = null;
    for (const p of weights(uid)) {
      if (!(p.w > 0)) continue;
      if (trend === null) trend = p.w;
      else {
        const gap = Math.max(1, daysBetween(prev, p.date));
        const a = 1 - Math.pow(1 - 0.25, gap);
        trend += a * (p.w - trend);
      }
      prev = p.date;
      out.push({ date: p.date, w: p.w, trend: Math.round(trend * 100) / 100 });
    }
    return out;
  });
}

// куда должен идти вес: 'down' | 'up' | 'hold' | null
export function goalDir(uid = store.uid()) {
  const types = (goalOf(uid).goals || []).map(g => g.type);
  if (types.includes('lose_fat')) return 'down';
  if (types.includes('gain_weight') || types.includes('gain_muscle')) return 'up';
  if (types.includes('maintain')) return 'hold';
  // цели-показатели v3 (талия, руки, отжимания…): режим подсказывает goals.effects
  let gm = null;
  try { gm = G.effects?.(undefined, uid)?.mode || null; } catch { gm = null; }
  if (gm) return gm === 'cut' || gm === 'recomp' ? 'down' : gm === 'bulk' ? 'up' : 'hold';
  const m = target(uid)?.mode;
  return m === 'cut' || m === 'recomp' ? 'down' : m === 'bulk' ? 'up' : m === 'maintain' ? 'hold' : null;
}

const CIRC = ['neck', 'chest', 'waist', 'belly', 'hips', 'arm_l', 'arm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r'];
export function measures(uid = store.uid()) {
  return memo(`meas|${uid}`, () =>
    store.list('body', uid, r => CIRC.some(k => Number(r.data[k]) > 0)).sort((a, b) => a.date.localeCompare(b.date)));
}

// Плато: ≥ 3 недель без заметного сдвига в сторону цели — по тренду веса, по замерам и по рабочим весам.
export function plateau(uid = store.uid()) {
  return memo(`plateau|${uid}`, () => {
    const dir = goalDir(uid);
    const t = today();
    const res = { weight: false, measures: false, lifts: false };
    // вес: тренд сейчас против тренда 21+ день назад
    const sw = smoothedWeights(uid);
    if (dir && dir !== 'hold' && sw.length >= 4) {
      const last = sw[sw.length - 1];
      const old = [...sw].reverse().find(p => daysBetween(p.date, last.date) >= 21);
      if (old && daysBetween(last.date, t) <= 10 && daysBetween(old.date, last.date) <= 42) {
        const ch = last.trend - old.trend;
        res.weight = dir === 'down' ? ch > -0.3 : ch < 0.2;
      }
    }
    // замеры: талия/живот (похудение) или руки/бёдра (набор)
    const ms = measures(uid);
    if (dir && dir !== 'hold' && ms.length >= 2) {
      const last = ms[ms.length - 1];
      const old = [...ms].reverse().find(r => daysBetween(r.date, last.date) >= 21);
      if (old) {
        const val = (r, keys) => avg(keys.map(k => Number(r.data[k])).filter(x => x > 0));
        const keys = dir === 'down' ? ['waist', 'belly'] : ['arm_l', 'arm_r', 'chest', 'thigh_l', 'thigh_r'];
        const a = val(old, keys), b = val(last, keys);
        if (a !== null && b !== null) res.measures = dir === 'down' ? b - a > -0.5 : b - a < 0.3;
      }
    }
    // рабочие веса: лучший подход (вес × повторы) за последние 10 дней против 21–42 дней назад
    const best = new Map();   // id → {recent, old}
    for (const w of store.list('workout', uid)) {
      const age = daysBetween(w.date, t);
      if (age < 0 || age > 42) continue;
      const slot = age <= 10 ? 'recent' : age >= 21 ? 'old' : null;
      if (!slot) continue;
      for (const ex of w.data.exercises || []) {
        for (const s of ex.log || []) {
          if (!s || !s.done) continue;
          const v = (Number(s.weight) || 1) * (1 + (Number(s.reps) || 0) / 30);   // оценка по Эпли
          const b = best.get(ex.id) || {};
          b[slot] = Math.max(b[slot] || 0, v);
          best.set(ex.id, b);
        }
      }
    }
    const both = [...best.values()].filter(b => b.recent && b.old);
    if (both.length >= 2) res.lifts = both.every(b => b.recent <= b.old * 1.01);
    res.any = res.weight || res.measures || res.lifts;
    return res;
  });
}

// ── цикл ──
export function cycleInfo(date = today(), uid = store.uid()) {
  const c = prof(uid).cycle;
  if (!c || !c.enabled) return null;
  const len = clamp(Number(c.length) || 28, 20, 45), period = clamp(Number(c.period) || 5, 2, 10);
  // отмеченные дни менструации (из трекера через «Здоровье») точнее расчёта: берём последнее начало до этой даты
  const marked = store.list('period', uid, r => r.date <= date).map(r => r.date).sort();
  let start = c.last_start;
  if (marked.length) {
    let s0 = marked[marked.length - 1];
    for (let i = marked.length - 1; i > 0 && daysBetween(marked[i - 1], marked[i]) < 3; i--) s0 = marked[i - 1];
    start = s0;
  }
  if (!start) return null;
  const day = ((daysBetween(start, date) % len) + len) % len + 1;
  const ov = len - 14;
  const phase = day <= period ? 'menstrual' : day < ov - 1 ? 'follicular' : day <= ov + 1 ? 'ovulation' : 'luteal';
  return { day, phase, length: len };
}

// ── сон ──
export function sleep(date, uid = store.uid()) { return store.get(`sleep:${uid}:${date}`)?.data || null; }
// дневной сон дня (sleep.naps, отдельно от ночи): [{from, to, min}]; минуты за день
export function naps(date, uid = store.uid()) {
  return (sleep(date, uid)?.naps || []).map(n => ({ ...n, min: (toMin(n.to) ?? 0) - (toMin(n.from) ?? 0) }))
    .filter(n => n.min > 0 && n.min <= 300);
}
export const napMinutes = (date, uid = store.uid()) => naps(date, uid).reduce((a, n) => a + n.min, 0);
export function sleepTarget(uid = store.uid()) { return Number(target(uid)?.sleep_hours) || 7.75; }

const SLEEP_ANS = {
  fall: { fast: 12, moderate: 7, long: 0, max: 12 },
  continuity: { solid: 10, interrupted: 3, max: 10 },
  awakening: { self: 8, alarm: 4, max: 8 },
  rise: { fresh: 10, hard: 2, max: 10 },
};

// rec — запись sleep или её data → { hours, verdict, score, label, target }
// Подсказка к полям «лёг / встал»: когда лёг (вчера или сегодня) и не перепутано ли время.
export function sleepHint(rec, uid = store.uid()) {
  const d = rec && rec.data && !rec.bed ? rec.data : rec;
  const b = toMin(d?.bed), w = toMin(d?.wake);
  if (b === null || w === null) return null;
  const f = store.get(`profile:${uid}`)?.data?.sex === 'f';
  const lay = f ? 'Легла' : 'Лёг', got = f ? 'встала' : 'встал';
  const mins = ((w - b) % 1440 + 1440) % 1440;
  if (!mins) return { warn: true, text: 'Время отхода ко сну и подъёма совпадает - поправьте одно из них.' };
  if (mins > 16 * 60) return { warn: true, text: `Получается ${dec(mins / 60)} ч сна подряд - похоже, перепутаны «${lay.toLowerCase()}» и «${got}». В статистику не пойдёт, пока не поправите.` };
  const sn = snoozeOf(d, b, w, mins);
  if (d.alarm && sn === null) return { warn: true, text: `Первый будильник в ${d.alarm} не попадает между «${lay.toLowerCase()}» и «${got}» - поправьте время.` };
  if (sn) {
    const n = Math.max(1, Number(d.alarms) || 1);
    const tip = sn >= 45 || n >= 3 ? ' Дрёма между будильниками - рваный лёгкий сон: лучше один будильник на реальное время подъёма.' : '';
    return { warn: sn >= 45 || n >= 3, text: `${lay} в ${d.bed}, первый будильник в ${d.alarm}${n > 1 ? ` (всего ${n})` : ''}, ${got} в ${d.wake}: сон ${h2((mins - sn) / 60)} ч + ${sn} мин дрёмы, в зачёт ${h2((mins - sn / 2) / 60)} ч.${tip}` };
  }
  if (b > w) return { warn: false, text: `${lay} накануне в ${d.bed}, ${got} в ${d.wake} - ${dec(mins / 60)} ч.` };
  if (b < 6 * 60) return { warn: false, text: `${lay} после полуночи, в ${d.bed}, ${got} в ${d.wake} - ${dec(mins / 60)} ч.` };
  return { warn: false, text: `Дневной сон: ${d.bed} → ${d.wake}, ${dec(mins / 60)} ч.` };
}

export function sleepInfo(rec, uid = store.uid()) {
  const d = rec && rec.data && !rec.bed ? rec.data : rec;
  if (!d) return null;
  const b = toMin(d.bed), w = toMin(d.wake);
  if (b === null || w === null) return null;
  const mins = ((w - b) % 1440 + 1440) % 1440;
  if (!mins) return null;
  const hours = Math.round(mins / 60 * 100) / 100;
  // «лёг» позже «встал» по часам — значит, лёг накануне (21:30 → 07:00); это нормально.
  // Больше 16 часов подряд — почти наверняка перепутаны поля или опечатка: в статистику не берём.
  const crossed = b > w;
  if (hours > 16) return null;
  const tgt = sleepTarget(uid);
  // Дневной сон (лёг после 06:00 и проспал меньше 4 ч в пределах суток) — не ночь и не «недосып»:
  // оценка нейтральная (70), в статистику ночей и в оценку дня не идёт.
  if (!crossed && b >= 6 * 60 && hours < 4) {
    return { hours, verdict: 'nap', score: 70, label: 'дневной сон', target: tgt, crossed, nap: true };
  }
  // Несколько будильников: сон до первого засчитываем полностью, дрёму до подъёма - наполовину
  // (рваный лёгкий сон восстанавливает хуже), за лишние будильники и долгую дрёму - штраф к качеству.
  const sn = snoozeOf(d, b, w, mins), alarms = Math.max(1, Number(d.alarms) || 1);
  const eff = sn ? Math.round((mins - sn / 2) / 60 * 100) / 100 : hours;
  const shortAt = Math.max(7, tgt - 0.75), longAt = Math.max(9.5, tgt + 1.5);
  const verdict = eff < shortAt ? 'short' : eff > longAt ? 'long' : 'ok';
  // длительность: до 60 баллов; недосып штрафуем сильнее пересыпа
  const dev = eff - tgt;
  const dur = clamp(60 - Math.max(0, Math.abs(dev) - 0.5) * (dev < 0 ? 24 : 14), 0, 60);
  let got = 0, max = 0;
  for (const [k, sc] of Object.entries(SLEEP_ANS)) {
    if (d[k] in sc && d[k] !== 'max') { got += sc[d[k]]; max += sc.max; }
  }
  const penalty = sn ? Math.min(9, (alarms - 1) * 3) + clamp((sn - 20) / 10, 0, 10) : 0;
  const score = Math.round(clamp((max ? dur + got / max * 40 : dur / 60 * 100) - penalty, 0, 100));
  const label = { short: 'недосып', ok: 'норма', long: 'пересып' }[verdict];
  const out = { hours: eff, inBed: hours, verdict, score, label, target: tgt, crossed };
  if (sn) Object.assign(out, { snoozeMin: sn, alarms, alarm: d.alarm });
  return out;
}
const h2 = h => String(Math.round(h * 100) / 100).replace('.', ',');     // часы как в карточке сна: 9,25
// минуты между первым будильником и подъёмом (0 - встал по первому же будильнику);
// null, если будильник не указан или не внутри сна (до 4 ч)
function snoozeOf(d, b, w, mins) {
  const a = toMin(d.alarm);
  if (a === null) return null;
  const toAlarm = ((a - b) % 1440 + 1440) % 1440, s = mins - toAlarm;
  return toAlarm > 0 && s >= 0 && s <= 240 ? s : null;
}

// Статистика сна за `days` дней по `end` включительно.
export function sleepStats(days = 14, uid = store.uid(), end = today()) {
  return memo(`ss|${uid}|${days}|${end}`, () => {
    const nights = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(end, -i), r = sleep(d, uid), si = r && sleepInfo(r, uid);
      if (si && !si.nap) nights.push({ date: d, ...si, rec: r });
    }
    const byFactor = { fall: {}, continuity: {}, awakening: {}, rise: {} };
    for (const n of nights) for (const k of Object.keys(byFactor)) {
      const v = n.rec[k];
      if (v) byFactor[k][v] = (byFactor[k][v] || 0) + 1;
    }
    // отход ко сну — вокруг полуночи: 23:30 → −30, 01:10 → +70
    const beds = nights.map(n => { const m = toMin(n.rec.bed); return m >= 720 ? m - 1440 : m; });
    const wakes = nights.map(n => toMin(n.rec.wake));
    const mb = avg(beds), mw = avg(wakes);
    const sd = (a, m) => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : 0;
    let trend = null;
    if (nights.length >= 4) {
      const h = Math.floor(nights.length / 2);
      const a = avg(nights.slice(0, h).map(n => n.score)), b = avg(nights.slice(-h).map(n => n.score));
      trend = b - a >= 5 ? 'up' : a - b >= 5 ? 'down' : 'flat';
    }
    // связь со самочувствием: средний балл сна перед хорошими и плохими днями
    const good = [], bad = [];
    for (const n of nights) {
      const s = stateOf(n.date, uid);
      if (!s) continue;
      if (s.wellbeing === 'great' || s.wellbeing === 'good') good.push(n.score);
      else if (s.wellbeing === 'meh' || s.wellbeing === 'broken') bad.push(n.score);
    }
    const r1 = x => x === null ? null : Math.round(x * 10) / 10;
    return {
      count: nights.length,
      avgHours: r1(avg(nights.map(n => n.hours))),
      avgScore: nights.length ? Math.round(avg(nights.map(n => n.score))) : null,
      avgBed: mb === null ? null : hmOf(mb), avgWake: mw === null ? null : hmOf(mw),
      bedtimeSpreadMin: Math.round(sd(beds, mb)), wakeSpreadMin: Math.round(sd(wakes, mw)),
      shortNights: nights.filter(n => n.verdict === 'short').length,
      longNights: nights.filter(n => n.verdict === 'long').length,
      // дрёма после первого будильника: сколько ночей и сколько в среднем
      snoozeNights: nights.filter(n => n.snoozeMin).length,
      avgSnooze: nights.some(n => n.snoozeMin) ? Math.round(avg(nights.filter(n => n.snoozeMin).map(n => n.snoozeMin))) : null,
      byFactor, trend,
      withState: { good: good.length ? Math.round(avg(good)) : null, bad: bad.length ? Math.round(avg(bad)) : null },
      nights: nights.map(({ rec, ...n }) => n),
    };
  });
}

// ── самочувствие и тип дня ──
export function stateOf(date, uid = store.uid()) { return store.get(`state:${uid}:${date}`)?.data || null; }
export function dayType(date, uid = store.uid()) { return store.get(`daytype:${uid}:${date}`)?.data?.type || null; }
function stateScore(s) {
  if (!s || !s.wellbeing) return null;
  let x = { great: 100, good: 80, meh: 50, broken: 20 }[s.wellbeing] ?? 60;
  if (s.stress === 'high') x -= 10; else if (s.stress === 'mid') x -= 3;
  if (s.soreness === 'strong') x -= 5;
  if (s.sleepy === 'strong') x -= 5; else if (s.sleepy === 'some') x -= 2;
  return clamp(x, 0, 100);
}

// «внесено задним числом»: запись о дне сделана позже, чем через 12 ч после его конца
export function isBackdatedRec(rec) {
  const ts = rec?.data?.entered_at;
  if (!rec?.date || !ts) return false;
  const end = parse(rec.date); end.setDate(end.getDate() + 1);
  return ts - end.getTime() > 12 * 3600e3;
}

// ── питание: окно, привычки, оценка ──
const stem = list => new RegExp(`(?:^|[^а-яёa-z])(?:${list.join('|')})`, 'i');
const HABIT_RX = {
  sugar: stem(['сахар', 'торт', 'шоколад', 'конфет', 'пирожн', 'печенье', 'печенья', 'печенек', 'морожен', 'варень', 'мёд', 'мед(?![а-яё])', 'медов', 'сладк',
    'зефир', 'пастил', 'мармелад', 'халв', 'вафл', 'кекс', 'пончик', 'донат', 'сироп', 'газировк', 'кола(?![а-яё])', 'лимонад',
    'нутелл', 'джем', 'десерт', 'чизкейк', 'эклер', 'тирамису', 'сгущ', 'батончик', 'леденц', 'карамел', 'круассан']),
  flour: stem(['хлеб', 'булк', 'булочк', 'батон', 'пицц', 'макарон', 'спагетт', 'лапш', 'пельмен', 'вареник', 'блин', 'блинчик',
    'оладь', 'пирог', 'пирож', 'выпечк', 'лаваш', 'бутерброд', 'сэндвич', 'бургер', 'шаурм', 'багет', 'круассан', 'сушк', 'баранк',
    'печенье', 'печенья', 'вафл', 'чебурек', 'беляш', 'самс', 'тост', 'гренк', 'сухар', 'пончик', 'кекс', 'торт']),
  coffee: stem(['кофе', 'капучино', 'латте', 'эспрессо', 'американо', 'раф(?![а-яё])', 'флэт', 'мокко', 'макиато']),
  alcohol: stem(['пив', 'вин[оау](?![а-яё])', 'вина(?![а-яё])', 'водк', 'коньяк', 'виски', 'ром(?![а-яё])', 'джин(?![а-яё])', 'текил',
    'шампанск', 'игрист', 'коктейл', 'сидр', 'ликёр', 'ликер', 'настойк', 'глинтвейн', 'мартини', 'портвейн', 'сангри', 'аперол',
    'самогон', 'бренди', 'просекко', 'эль(?![а-яё])', 'наливк']),
  fastfood: stem(['бургер', 'гамбургер', 'чизбургер', 'шаурм', 'шаверм', 'фри(?![а-яё])', 'наггетс', 'хот-?дог', 'пицц', 'чипс',
    'роллтон', 'доширак', 'чебурек', 'беляш', 'кфс', 'макдон', 'бигмак', 'сухарики']),
};
const HABIT_GROUPS = { sugar: ['сладости'], flour: ['хлеб и выпечка', 'макароны'], fastfood: ['фастфуд'] };
// сколько «нарушений» допускается в день без замечания
const HABIT_FREE = { sugar: 0, flour: 1, coffee: 1, alcohol: 0, fastfood: 0 };
const HABIT_OF = { less_sugar: 'sugar', less_flour: 'flour', less_coffee: 'coffee', less_alcohol: 'alcohol', less_fastfood: 'fastfood', less_late_eating: 'late' };

// что из текста или позиции еды относится к привычкам → Set('sugar', 'flour', …)
export function foodFlags(name, group) {
  // «кофе без сахара» — не сладкое: фразы «без …» убираем
  const raw = String(name || '').toLowerCase().replace(/(?:^|[^а-яё])без\s+[а-яё]+/g, ' ');
  const s = raw.replace(/ё/g, 'е');
  const out = new Set();
  for (const [k, rx] of Object.entries(HABIT_RX)) if (rx.test(s) || rx.test(raw)) out.add(k);
  for (const [k, gs] of Object.entries(HABIT_GROUPS)) if (group && gs.includes(group)) out.add(k);
  return out;
}

export function inWindow(time, win) {
  const t = toMin(time);
  if (!win || !win.enabled || t === null) return true;
  const a = toMin(win.from), b = toMin(win.to);
  if (a === null || b === null) return true;
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

// Питание за день: суммы, окно, привычки. null — если записей нет.
export function foodDay(date, uid = store.uid()) {
  return memo(`fd|${uid}|${date}`, () => {
    const recs = recsOn('food', date, uid);
    if (!recs.length) return null;
    const win = prof(uid).eating_window;
    const tot = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
    const hits = { sugar: [], flour: [], coffee: [], alcohol: [], fastfood: [] };
    const outside = [], late = [];
    for (const r of recs) {
      const d = r.data;
      for (const k of Object.keys(tot)) tot[k] += Number(d.totals?.[k]) || 0;
      const parts = d.items?.length ? d.items.map(i => [i.name, i.group]) : [[d.text, null]];
      for (const [name, group] of parts) for (const f of foodFlags(name, group)) hits[f].push(name);
      if (d.time) {
        if (d.out_of_window === true || (d.out_of_window !== false && !inWindow(d.time, win))) outside.push(d.time);
        const lateAt = win?.enabled && toMin(win.to) !== null && toMin(win.to) > toMin(win.from) ? Math.max(toMin(win.to), 20 * 60) : 21 * 60;
        if (toMin(d.time) >= lateAt) late.push(d.time);
      }
    }
    Object.keys(tot).forEach(k => { tot[k] = Math.round(tot[k]); });
    return { ...tot, n: recs.length, meals: meals(date, uid), calculated: recs.some(r => r.data.totals), hits, outside, late };
  });
}

// нарушения пищевых привычек из целей → [{habit, what, count, time?}]
export function habitViolations(date, uid = store.uid()) {
  const fd = foodDay(date, uid);
  if (!fd) {
    // еду не записывали, но чашки кофе в чек-листе отмечены - цель «меньше кофе» всё равно проверяем
    const cc = cups(date, uid).coffee || 0;
    return (goalOf(uid).habits || []).includes('less_coffee') && cc > HABIT_FREE.coffee
      ? [{ habit: 'less_coffee', what: 'coffee', count: cc, items: [] }] : [];
  }
  const out = [];
  for (const h of goalOf(uid).habits || []) {
    const k = HABIT_OF[h];
    if (!k) continue;
    if (k === 'late') { if (fd.late.length) out.push({ habit: h, what: 'late', count: fd.late.length, time: fd.late[fd.late.length - 1] }); continue; }
    const n = k === 'coffee' ? Math.max(fd.hits[k].length, cups(date, uid).coffee || 0) : fd.hits[k].length;
    if (n > HABIT_FREE[k]) out.push({ habit: h, what: k, count: n, items: fd.hits[k] });
  }
  return out;
}

// оценка питания за день 0..100 или null
function foodScore(date, uid) {
  const fd = foodDay(date, uid);
  if (!fd) return null;
  const tg = target(uid);
  const parts = [];
  if (tg && tg.kcal && fd.calculated) {
    const r = fd.kcal / tg.kcal;
    // пока записано меньше двух приёмов, недобор калорий — это просто неполный дневник
    if (!(r < 1 && fd.meals < 2)) parts.push([0.5, clamp(100 - Math.max(0, Math.abs(r - 1) - 0.1) * 250, 0, 100)]);
    if (tg.p) parts.push([0.25, clamp(fd.p / tg.p / 0.9, 0, 1) * 100]);
  } else {
    parts.push([0.5, clamp(fd.meals / 3, 0, 1) * 100]);
  }
  const viol = habitViolations(date, uid).length + (fd.outside.length ? 1 : 0);
  parts.push([0.25, clamp(100 - viol * 30, 0, 100)]);
  const w = parts.reduce((s, [a]) => s + a, 0);
  return Math.round(parts.reduce((s, [a, v]) => s + a * v, 0) / w);
}

// ── движение: минуты ──
const IW = { low: 0.6, mid: 1, high: 1.4 };
const PASSIVE = new Set(['massage', 'sauna', 'breathing']);
export function isPassive(type) {
  if (PASSIVE.has(type)) return true;
  const a = (store.getMeta('activities', []) || []).find(x => x.id === type);
  return !!a && a.load === 'recovery' && (a.met?.mid ?? 2) < 2;
}
// длительность упражнения тренировки в секундах: подход «на повторы» ≈ 40 с с переходом (на сторону ≈ 70 с),
// «на время» — само время + 10 с; плюс отдых между подходами
export function exerciseSec(x) {
  const sets = Number(x.sets) || 1, rest = Number(x.rest_sec) || 0;
  const n = parseInt(String(x.reps), 10) || 30;
  // кардио-блок «15-20 мин» / «20 мин»: работа — минуты, а не секунды
  const mins = /мин/.test(String(x.reps)) ? (String(x.reps).match(/\d+/g) || []).slice(0, 2).map(Number) : null;
  const work = mins?.length ? mins.reduce((a, b) => a + b, 0) / mins.length * 60
    : x.unit === 'seconds' ? (x.per_side ? 2 * n : n) + 10 : (x.per_side ? 70 : 40);
  return sets * work + Math.max(0, sets - 1) * rest + 10;
}
// оценка длительности тренировки по составу (если planned_minutes не задано)
export function estimateMinutes(wd) {
  if (!wd) return 0;
  if (wd.planned_minutes) return Number(wd.planned_minutes);
  let sec = 0;
  for (const x of wd.exercises || []) sec += exerciseSec(x);
  sec += ((wd.warmup || []).length + (wd.cooldown || []).length) * 40;
  return Math.max(5, Math.round(sec / 60));
}
// минуты за день: тренировка (с учётом выполненной доли) + активности (с весом интенсивности)
export const ROUTINE_LOAD = new Set(['workout', 'abs', 'legs', 'arms', 'back', 'cardio']);
export function activityMinutes(date, uid = store.uid()) {
  return memo(`am|${uid}|${date}`, () => {
    const w = activeWorkout(date, uid);
    const planned = w ? estimateMinutes(w.data) : 0;
    const program = Math.round(planned * workoutProgress(w));
    let act = 0, raw = 0, recovery = 0;
    for (const r of recsOn('activity', date, uid)) {
      const m = Number(r.data.minutes) || 0;
      if (isPassive(r.data.type)) { recovery += m; continue; }     // массаж, сауна, дыхание — не движение
      raw += m; act += m * (IW[r.data.intensity] ?? 1);
    }
    // короткие комплексы «Сегодня»: силовые и кардио идут в объём по доле сделанного; растяжка, осанка, шея, разминка - нет
    for (const r of recsOn('routine', date, uid)) {
      if (!ROUTINE_LOAD.has(r.data.module)) continue;
      const ex = r.data.exercises || [];
      const m = (Number(r.data.minutes) || 0) * (ex.length ? ex.filter(x => x.done).length / ex.length : 0);
      raw += m; act += m;
    }
    return { planned, program, activity: Math.round(act), activityRaw: raw, recovery, total: Math.round(program + act) };
  });
}

// недельный объём движения на дату (неделя пн–вс) — основа plan.weeklyBalance
export function weekActivity(date = today(), uid = store.uid()) {
  return memo(`wa|${uid}|${date}`, () => {
    const mon = mondayOf(date), idx = weekday(date);
    const p = prof(uid);
    let plannedSessions = 0, doneSessions = 0, plannedMin = 0, dueMin = 0, doneMin = 0, activityMin = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const am = activityMinutes(d, uid);
      if (am.planned) {
        plannedSessions++; plannedMin += am.planned;
        if (i <= idx) dueMin += am.planned;
        if (workoutProgress(activeWorkout(d, uid)) >= 0.8) doneSessions++;
      }
      doneMin += am.program; activityMin += am.activity;
    }
    // плановые активности из профиля (велосипед, бассейн…)
    // ходьба идёт шагами (отдельно её не записывают); к этой дате «должно быть» столько, сколько стояло
    // в плане недели на прошедшие дни и сегодня (пропуски план переносит на следующие дни)
    const planDue = {};
    for (let i = 0; i <= idx; i++) for (const e of weekPlan(addDays(mon, i), uid)) if (e.due) planDue[e.key] = (planDue[e.key] || 0) + 1;
    const hasSteps = items(uid).some(i => i.data.target_from === 'steps');
    for (const a of p.activities || []) {
      if (isPassive(a.type) || (WALK_TYPES.has(a.type) && hasSteps)) continue;
      const m = (Number(a.minutes) || 0) * (IW[a.intensity] ?? 1);
      const n = Number(a.per_week) || (a.weekdays?.length || 0);
      plannedMin += m * n;
      dueMin += m * Math.min(n, planDue[`act:${a.type}`] || 0);
    }
    const weekly = Number(target(uid)?.intensity?.weekly_minutes) || 0;
    if (!plannedMin && weekly) { plannedMin = weekly; dueMin = weekly * (idx + 1) / 7; }
    const ramp = rampFactor(date, uid);
    plannedMin *= ramp; dueMin *= ramp;
    const got = doneMin + activityMin;
    return {
      monday: mon, daysLeft: 6 - idx,
      plannedSessions, doneSessions,
      plannedMin: Math.round(plannedMin), doneMin: Math.round(doneMin), activityMin: Math.round(activityMin),
      deficitMin: Math.max(0, Math.round(plannedMin - got)), behindMin: Math.max(0, Math.round(dueMin - got)),
    };
  });
}

// ── оценка дня ──
// → { score: 0..100 | null, grade: 'good'|'ok'|'bad'|'none', parts: {checklist, sleep, state, food, activity}, type }
const W = { checklist: 0.3, sleep: 0.2, state: 0.1, food: 0.2, activity: 0.2 };
export function gradeOf(score) { return score === null || score === undefined ? 'none' : score >= 70 ? 'good' : score >= 45 ? 'ok' : 'bad'; }
export function dayGrade(date, uid = store.uid()) {
  return memo(`dg|${uid}|${date}`, () => {
    if (uid !== store.uid()) {
      const ds = store.get(`ds:${uid}:${date}`)?.data;
      if (!ds) return { score: null, grade: 'none', parts: {} };
      if (ds.grade) return { score: ds.score ?? null, grade: ds.grade, parts: {} };
      const pct = ds.pct || 0;
      return { score: pct || null, grade: pct ? gradeOf(pct) : 'none', parts: {} };
    }
    const type = dayType(date, uid);
    const empty = { score: null, grade: 'none', parts: {}, type };
    if (date > today()) return empty;
    const noFood = type === 'cheat' || type === 'special' || type === 'sick';
    const noAct = type === 'special' || type === 'sick' || type === 'rest';
    const parts = {};
    const s = dayScore(date, uid);
    // чек-лист без тренировки в дни, когда тренировка не требуется
    let sum = 0, total = 0, marked = false;
    for (const it of items(uid)) {
      if (it.data.track) continue;
      const p = progress(it, date, uid);
      if (!p.applies) continue;
      if (it.data.type === 'workout' && noAct) continue;
      total++; sum += p.frac;
      if (p.frac > 0) marked = true;
    }
    if (total) parts.checklist = Math.round(sum / total * 100);
    const si = sleepInfo(sleep(date, uid), uid);
    if (si && !si.nap) parts.sleep = si.score;
    // дневной сон после короткой ночи (15-90 мин) немного восстанавливает - оценку сна чуть поднимаем
    const nm = napMinutes(date, uid);
    if (parts.sleep !== undefined && si.verdict === 'short' && nm >= 15) parts.sleep = Math.min(100, parts.sleep + Math.min(12, Math.round(Math.min(nm, 90) / 7)));
    const st = stateScore(stateOf(date, uid));
    if (st !== null) parts.state = st;
    if (!noFood) { const f = foodScore(date, uid); if (f !== null) parts.food = f; }
    if (!noAct) {
      const am = activityMinutes(date, uid);
      const planned = am.planned * rampFactor(date, uid);
      if (planned > 0) parts.activity = Math.round(clamp(am.total / planned, 0, 1) * 100);
      else if (am.activityRaw > 0) parts.activity = 100;
    }
    const other = ['sleep', 'state', 'food', 'activity'].some(k => k in parts) || recsOn('food', date, uid).length > 0;
    if (!marked && !other) return { ...empty, parts };
    let ws = 0, acc = 0;
    for (const [k, v] of Object.entries(parts)) { ws += W[k]; acc += W[k] * v; }
    const score = ws ? Math.round(acc / ws) : null;
    let grade = gradeOf(score);
    // болезнь и особый день плохими не бывают
    if (grade === 'bad' && (type === 'sick' || type === 'special')) grade = 'ok';
    return { score, grade, parts, type, pct: s.pct };
  });
}

// ── неделя ──
// значок оценки рисует интерфейс (ui.gradeGlyph по букве); поле emoji оставлено пустым для совместимости
const WEEK_GRADES = [[85, 'A', ''], [70, 'B', ''], [55, 'C', ''], [40, 'D', ''], [0, 'E', '']];
// день считается завершённым после 21:00 — до этого он «идёт»
const dayClosed = () => new Date().getHours() >= 21;

export function weekSummary(monday = mondayOf(), uid = store.uid()) {
  monday = mondayOf(monday);
  return memo(`wk|${uid}|${monday}`, () => {
    const t = today();
    const days = [];
    const food = [], sleepS = [], state = [];
    let waterDays = 0, waterKnown = 0, xp = 0, logged = 0, elapsed = 0;
    const water = items(uid).find(i => i.data.target_from === 'water');
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      if (d > t) { days.push({ date: d, grade: 'none', score: null }); continue; }
      const g = dayGrade(d, uid);
      days.push({ date: d, grade: g.grade, score: g.score, type: g.type || null, open: d === t && !dayClosed() });
      // незаконченный сегодняшний день видно в таблице, но в оценку недели он не входит
      if (d === t && !dayClosed()) continue;
      elapsed++;
      if (g.grade !== 'none') logged++;
      if (g.parts.food !== undefined) food.push(g.parts.food);
      if (g.parts.sleep !== undefined) sleepS.push(g.parts.sleep);
      if (g.parts.state !== undefined) state.push(g.parts.state);
      if (water) {
        const p = progress(water, d, uid);
        if (p.applies && (d < t || p.frac >= 1)) { waterKnown++; if (p.frac >= 1) waterDays++; }
      }
      xp += dayScore(d, uid).xp;
    }
    const lastDay = addDays(monday, 6) < t ? addDays(monday, 6) : t;
    const wa = weekActivity(lastDay, uid);
    const actDue = wa.plannedMin ? wa.plannedMin * (elapsed / 7) : 0;
    const parts = {
      activity: actDue ? Math.round(clamp((wa.doneMin + wa.activityMin) / actDue, 0, 1) * 100)
        : (wa.activityMin || wa.doneMin ? 100 : null),
      sleep: sleepS.length ? Math.round(avg(sleepS)) : null,
      food: food.length ? Math.round(avg(food)) : null,
      water: waterKnown ? Math.round(waterDays / waterKnown * 100) : null,
      state: state.length ? Math.round(avg(state)) : null,
      workouts: { planned: wa.plannedSessions, done: wa.doneSessions },
    };
    const PW = { activity: 0.3, food: 0.25, sleep: 0.2, water: 0.1, state: 0.15 };
    let ws = 0, acc = 0;
    for (const [k, w] of Object.entries(PW)) if (parts[k] !== null) { ws += w; acc += w * parts[k]; }
    if (!ws || !logged) return { monday, score: null, grade: null, emoji: '', parts, days, xp, logged, started: elapsed === 0 };
    // регулярность: дни без записей тянут неделю вниз
    const score = Math.round(acc / ws * (0.7 + 0.3 * logged / Math.max(1, elapsed)));
    const [, grade, emoji] = WEEK_GRADES.find(([min]) => score >= min);
    return { monday, score, grade, emoji, parts, days, xp, logged };
  });
}

export async function refreshWsum(monday = mondayOf()) {
  const uid = store.uid();
  if (!uid) return;
  monday = mondayOf(monday);
  const w = weekSummary(monday, uid);
  const cmp = wsumCompete(monday, uid);
  const id = `ws:${uid}:${monday}`;
  const cur = store.get(id)?.data;
  // без оценки недели пишем сводку только ради соревнования (или чтобы убрать его поля после выключения)
  if (w.score === null && !cmp.compete && !(cur && 'compete' in cur)) return;
  const data = { score: w.score, grade: w.grade, emoji: w.emoji, parts: w.parts, xp: w.xp, ...cmp };
  if (cur && stableJson(cur) === stableJson(data)) return;
  await store.put('wsum', id, data, monday);
}

// ── достижения ──
export const ACHIEVEMENTS = [
  { code: 'first_day', title: 'Первый шаг', text: 'Первый день на 80 % и выше' },
  { code: 'streak_7', title: 'Неделя', text: 'Серия 7 дней' },
  { code: 'streak_30', title: 'Месяц', text: 'Серия 30 дней' },
  { code: 'streak_100', title: 'Сотня', text: 'Серия 100 дней' },
  { code: 'perfect_week', title: 'Идеальная неделя', text: '7 дней подряд на 100 %' },
  { code: 'workouts_1', title: 'Первая тренировка', text: 'Завершена первая тренировка' },
  { code: 'workouts_10', title: 'Десятка', text: '10 тренировок' },
  { code: 'workouts_25', title: 'Четверть сотни', text: '25 тренировок' },
  { code: 'workouts_50', title: 'Полсотни', text: '50 тренировок' },
  { code: 'water_30', title: 'Водяной', text: '30 дней с нормой воды' },
  { code: 'steps_100k', title: '100 000 шагов', text: 'За 7 дней' },
  { code: 'food_7', title: 'Дневник', text: 'Питание записано 7 дней подряд' },
  { code: 'weight_1', title: 'Минус один', text: '−1 кг от старта' },
  { code: 'weight_3', title: 'Минус три', text: '−3 кг от старта' },
  { code: 'weight_5', title: 'Минус пять', text: '−5 кг от старта' },
  { code: 'level_5', title: 'Пятый уровень', text: 'Уровень 5' },
  { code: 'sleep_7', title: 'Режим сна', text: '7 ночей подряд по 7 часов и больше' },
  { code: 'state_7', title: 'Слушаю себя', text: 'Самочувствие отмечено 7 дней подряд' },
  { code: 'activity_5', title: 'Разносторонний', text: 'Пять разных видов активности' },
  { code: 'measure_first', title: 'Сантиметр', text: 'Первые замеры тела' },
  { code: 'measure_4w', title: 'Летопись', text: 'Замеры в четыре разные недели' },
  { code: 'week_a', title: 'Неделя на пятёрку', text: 'Оценка недели A' },
  { code: 'couple_week', title: 'Команда', text: 'Оба - 5 хороших дней за одну неделю' },
];

function earnedCodes(uid) {
  const out = new Set();
  const start = firstDay(uid);
  if (!start) return out;
  const its = items(uid);
  const water = its.find(i => i.data.target_from === 'water');
  const steps = its.find(i => i.data.target_from === 'steps');
  const foodItem = its.find(i => i.data.type === 'food');
  const partner = store.partners()[0];
  let perfectRun = 0, foodRun = 0, waterDays = 0, sleepRun = 0, stateRun = 0;
  const stepsByDay = [];
  const coupleWeeks = new Map();
  for (let d = start; d <= today(); d = addDays(d, 1)) {
    const s = dayScore(d, uid);
    if (s.pct >= STREAK_MIN) out.add('first_day');
    perfectRun = s.total && s.done === s.total ? perfectRun + 1 : 0;
    if (perfectRun >= 7) out.add('perfect_week');
    if (water && progress(water, d, uid).frac >= 1) waterDays++;
    foodRun = foodItem && progress(foodItem, d, uid).frac >= 1 ? foodRun + 1 : 0;
    if (foodRun >= 7) out.add('food_7');
    stepsByDay.push(steps ? Number(logVal(d, steps.id, uid)) || 0 : 0);
    if (stepsByDay.slice(-7).reduce((a, b) => a + b, 0) >= 100000) out.add('steps_100k');
    const si = sleepInfo(sleep(d, uid), uid);
    // дневной сон серию ночей не рвёт и не продлевает
    if (!si?.nap) sleepRun = si && si.hours >= 7 ? sleepRun + 1 : 0;
    if (sleepRun >= 7) out.add('sleep_7');
    stateRun = stateOf(d, uid) ? stateRun + 1 : 0;
    if (stateRun >= 7) out.add('state_7');
    if (partner && dayGrade(d, uid).grade === 'good' && dayGrade(d, partner.id).grade === 'good') {
      const w = isoWeek(d);
      coupleWeeks.set(w, (coupleWeeks.get(w) || 0) + 1);
      if (coupleWeeks.get(w) >= 5) out.add('couple_week');
    }
  }
  if (waterDays >= 30) out.add('water_30');
  const st = streaks(uid);
  [7, 30, 100].forEach(n => { if (st.best >= n) out.add('streak_' + n); });
  const wDone = store.list('workout', uid, r => r.data.done).length;
  [1, 10, 25, 50].forEach(n => { if (wDone >= n) out.add('workouts_' + n); });
  const ws = weights(uid);
  if (ws.length > 1) {
    const lost = ws[0].w - ws[ws.length - 1].w;
    [1, 3, 5].forEach(n => { if (lost >= n) out.add('weight_' + n); });
  }
  if (level(totalXp(uid)).n >= 5) out.add('level_5');
  if (new Set(store.list('activity', uid).map(r => r.data.type).filter(Boolean)).size >= 5) out.add('activity_5');
  const ms = measures(uid);
  if (ms.length) out.add('measure_first');
  if (new Set(ms.map(r => isoWeek(r.date))).size >= 4) out.add('measure_4w');
  for (let m = mondayOf(start); m < mondayOf(today()); m = addDays(m, 7)) {
    if (weekSummary(m, uid).grade === 'A') { out.add('week_a'); break; }
  }
  return out;
}

// выдать новые достижения; вернуть только что полученные
export async function awardAchievements() {
  const uid = store.uid();
  const fresh = [];
  for (const code of earnedCodes(uid)) {
    const id = `ach:${uid}:${code}`;
    if (store.get(id)) continue;
    const a = ACHIEVEMENTS.find(x => x.code === code);
    await store.put('ach', id, { code, title: a.title, earned: today() }, today());
    fresh.push(a);
  }
  return fresh;
}

// ── читмил ──
export function cheatAdvice(date = today()) {
  const uid = store.uid();
  if (dayType(date, uid) === 'cheat') return { allowed: true, reason: 'Читмил на сегодня уже отмечен. Наслаждайся, завтра - обычный режим.' };
  for (let i = 1; i <= 6; i++) {
    const d = addDays(date, -i);
    if (dayType(d, uid) === 'cheat') {
      const next = addDays(d, 7);
      return { allowed: false, reason: `Последний читмил был ${i} ${plural(i, 'день', 'дня', 'дней')} назад. Следующий - не раньше ${next.slice(8)}.${next.slice(5, 7)}.` };
    }
  }
  const grades = [];
  for (let i = 1; i <= 7; i++) { const g = dayGrade(addDays(date, -i), uid); if (g.grade !== 'none' && g.score !== null) grades.push(g.score); }
  if (grades.length < 4) return { allowed: false, reason: 'За неделю мало записей. Сначала несколько обычных дней в дневнике - потом поговорим о читмиле.' };
  const a = Math.round(avg(grades));
  if (a < 45) return { allowed: false, reason: `Неделя пока слабая (средняя оценка ${a} из 100). Сначала выровняем режим, читмил подождёт.` };
  const si = sleepInfo(sleep(date, uid), uid);
  if (si && (si.verdict === 'short' || si.score < 45)) return { allowed: false, reason: 'Сон сегодня слабый - на недосыпе тянет на сладкое вдвойне. Лучше перенести на другой день.' };
  if (stateOf(date, uid)?.wellbeing === 'broken') return { allowed: false, reason: 'Самочувствие сегодня «разбит» - не лучший день для читмила. Сначала восстановимся.' };
  return { allowed: true, reason: `Неделя хорошая (средняя оценка ${a}). Читмил можно: один свободный приём пищи, без «добивания» остального дня.` };
}

// ── реплики тренера ──
export const TONE_NAMES = { soft: 'Друг', coach: 'Тренер', sergeant: 'Сержант' };

const LINES = {
  setup: {
    soft: ['Давай познакомимся: заполни профиль и цель, и я посчитаю твои нормы.'],
    coach: ['Сначала профиль и цель. Без цифр тренировать нечего.'],
    sergeant: ['Боец без анкеты - не боец. Профиль, цель - бегом!'],
  },
  gap: {
    soft: ['Тебя не было {n} дн. Ничего страшного - главное, что ты снова здесь. Начнём с воды и зарядки?',
           '{n} дн. без отметок. Бывает. Сегодня просто сделай что сможешь - это уже шаг.'],
    coach: ['{n} дн. без отметок. Серия сгорела. Сегодня закрываем день полностью - без оправданий.',
            'Пропуск {n} дн. Прогресс любит регулярность. Возвращаемся в режим сегодня.'],
    sergeant: ['{n} дней тишины, боец. Я уж решил, что ты дезертировал{|а}. Живо на коврик!',
               'Где ты был{|а} {n} дн.? На диване в засаде? Отставить! Вода, зарядка, шаги - марш!'],
  },
  yesterday_perfect: {
    soft: ['Вчера - все 100 %. Ты большой молодец, так держать!', 'Вчерашний день закрыт идеально. Горжусь тобой.'],
    coach: ['Вчера 100 %. Хорошая работа. Повторяем.', 'Вчерашний день - эталон. Сегодня такой же.'],
    sergeant: ['Вчера 100 %. Неплохо для гражданск{ого|ой}. Не расслабляться!', 'Идеальный день вчера? Подозрительно. Докажи, что не случайность.'],
  },
  yesterday_bad: {
    soft: ['Вчера получилось только {pct} %. Не переживай - сегодня новый день.'],
    coach: ['Вчера {pct} %. Это мало. Сегодня набери хотя бы {min} %, чтобы день зачёлся в серию.', 'Вчерашние {pct} % - не твой уровень. Исправляемся.'],
    sergeant: ['Вчера {pct} %?! Это не тренировка, это санаторий. Сегодня отрабатываешь!', '{pct} % вчера. Моя бабушка делает больше, а у неё радикулит.'],
  },
  today_perfect: {
    soft: ['Сегодня всё выполнено! Можно гордиться собой и отдыхать.'],
    coach: ['День закрыт на 100 %. Отличная работа. Восстановление - тоже часть плана.'],
    sergeant: ['100 % за день. Так и быть - объявляю благодарность. Отбой!'],
  },
  evening_low: {
    soft: ['Уже вечер, а день выполнен на {pct} %. Ещё можно успеть пару пунктов - давай?'],
    coach: ['Вечер, а у тебя {pct} %. Время ещё есть - закрой хотя бы воду и шаги.'],
    sergeant: ['Солнце садится, а у тебя {pct} %. Чем ты весь день занимал{ся|ась}, боец? Доделывай!'],
  },
  workout_today: {
    soft: ['Сегодня тренировка «{title}». Ты справишься!'],
    coach: ['Сегодня по плану «{title}». Разминка обязательна.'],
    sergeant: ['Сегодня «{title}». Отговорки не принимаются.'],
  },
  workout_light: {
    soft: ['Сегодня «{title}», но по самочувствию лучше облегчённый вариант. Его можно выбрать на экране тренировки - это не слабость, а забота о себе.',
           '«{title}» сегодня можно сделать полегче: меньше подходов, спокойный темп. Недельный объём доберём потом.'],
    coach: ['«{title}» сегодня - в облегчённом варианте: примерно 60 % подходов, веса не повышаем. Объём доберём на неделе.',
            'Готовность сегодня ниже обычного. «{title}» делаем облегчённо, технику - идеально.'],
    sergeant: ['«{title}» делаем облегчённо. Это не поблажка, а тактика. Недостачу доберёшь до выходных.',
               'Сегодня облегчённый вариант «{title}». Облегчённый - не значит «лежачий». Вперёд!'],
  },
  workout_late: {
    soft: ['Тренировка «{title}» ещё не сделана. Даже короткая лучше, чем никакой.'],
    coach: ['«{title}» до сих пор не сделана. Пропуск тренировки - минус к результату.'],
    sergeant: ['«{title}» не сделана, а уже вечер. Штанга сама себя не поднимет!'],
  },
  workout_missed: {
    soft: ['Вчерашняя тренировка не состоялась. Ничего, главное - не пропустить следующую.'],
    coach: ['Вчера пропущена тренировка «{title}». Два пропуска подряд - уже привычка. Не допускаем.'],
    sergeant: ['Вчера ты прогулял{|а} «{title}». Записал в личное дело. Второго раза не будет.'],
  },
  streak_record: {
    soft: ['Серия {n} дн. - это твой рекорд! Потрясающе.'],
    coach: ['Серия {n} дн. - личный рекорд. Держим темп.'],
    sergeant: ['{n} дней подряд - рекорд. Кажется, из тебя что-то выйдет.'],
  },
  streak: {
    soft: ['Уже {n} дн. подряд. Ты молодец!'],
    coach: ['Серия {n} дн. Не прерывай.'],
    sergeant: ['{n} дней в строю. Сломаешь серию - начнёшь с нуля.'],
  },
  kcal_over: {
    soft: ['Вчера вышло на {over} ккал больше нормы. Ничего, сегодня чуть аккуратнее.',
           'Вчера получилось на {over} ккал больше нормы. Ничего не надо «отрабатывать» - просто сегодня без перекусов после ужина.'],
    coach: ['Вчера перебор на {over} ккал. Для цели это минус полдня прогресса.',
            'Вчера +{over} ккал к норме. Не голодаем в ответ: сегодня обычная норма, сладкое - в пользу фруктов.'],
    sergeant: ['Перебор {over} ккал вчера. Что это было - торт на спор?',
               '+{over} ккал вчера. Сегодня ни крошки сверх плана. Контроль у холодильника усилен.'],
  },
  protein_low: {
    soft: ['Белка вчера было {p} г из {t}. Добавь сегодня {idea} - и будет в самый раз.',
           'Белка вчера {p} г из {t}. Сегодня попробуй по {per} г в каждом приёме пищи - это проще, чем добирать вечером.'],
    coach: ['Белок вчера {p} из {t} г. Мышцы из воздуха не строятся. Сегодня по {per} г на приём: {idea}.',
            'Вчера белка {p}/{t} г. Сегодня белок - в каждой тарелке, по {per} г.'],
    sergeant: ['{p} г белка из {t}? Мышцы на макаронах не растут, боец! Сегодня в каждой тарелке {per} г белка.',
               'Белок вчера {p} из {t} г. Недостача. Сегодня {idea} - в каждый приём, проверю.'],
  },
  weight_good: {
    soft: ['Вес идёт в нужную сторону: {delta} кг в неделю. Всё получается!'],
    coach: ['Тренд веса {delta} кг/нед. Это правильный темп.'],
    sergeant: ['Вес {delta} кг в неделю. Работает. Не вздумай расслабиться.'],
  },
  weight_stall: {
    soft: ['Вес пару недель стоит на месте - так бывает. Может, пересчитаем нормы?'],
    coach: ['Вес стоит больше двух недель. Пересчитай нормы в профиле и проверь дневник питания.'],
    sergeant: ['Вес стоит как памятник. Либо дневник питания неполный, либо пора пересчитать нормы.'],
  },
  plateau: {
    soft: ['Три недели без заметных перемен. Это не провал - телу просто нужно что-то новое. Давай поменяем одно: калории, шаги или программу?',
           'Похоже на плато. Так бывает у всех. Предлагаю пересчитать нормы или добавить пару тысяч шагов в день - и посмотреть неделю.'],
    coach: ['Плато три недели. Меняем одну переменную: −100–150 ккал, +2000 шагов или новая программа. Не всё сразу.',
            'Прогресс встал. Пересчитай нормы в профиле или обнови программу - старый стимул больше не работает.'],
    sergeant: ['Три недели на месте. Стоять на месте - это не стратегия. Пересчитываем нормы или меняем программу - выбирай.',
               'Плато, боец. Организм привык к нагрузке. Меняем план - приказ.'],
  },
  plateau_lifts: {
    soft: ['Рабочие веса пару недель не растут. Может, взять лёгкую неделю, а потом попробовать другую схему повторов?'],
    coach: ['Рабочие веса три недели на месте. Пора сменить схему повторов или взять разгрузочную неделю.'],
    sergeant: ['Веса на штанге не меняются три недели. Либо разгрузка, либо новая схема. Топтаться на месте не будем.'],
  },
  partner_ahead: {
    soft: ['{partner} сегодня уже на {pct} %. Может, вместе догоните цели?'],
    coach: ['{partner} сегодня - {pct} %. Ты отстаёшь.'],
    sergeant: ['{partner} уже {pct} %, а ты? Позор на всю казарму!'],
  },
  partner_behind: {
    soft: ['Ты сегодня впереди! Подбодри {partner_acc} - вдвоём проще.'],
    coach: ['Ты сегодня впереди, у {partner_gen} меньше. Потяни за собой.'],
    sergeant: ['{partner} отстаёт. Бери {partner_acc} на буксир - в армии своих не бросают.'],
  },
  morning: {
    soft: ['Доброе утро! Начни день со стакана воды и зарядки.', 'Новый день - новые маленькие победы.'],
    coach: ['Утро. Вода, зарядка, план на день.', 'Начинаем: зарядка и первый стакан воды.'],
    sergeant: ['Подъём! Стакан воды - и на коврик.', 'Рота, подъём! Зарядка сама себя не сделает.'],
  },
  keep_going: {
    soft: ['Сегодня уже {pct} %. Продолжай в том же духе!'],
    coach: ['{pct} % дня. Доделываем.'],
    sergeant: ['{pct} %. Это ещё не победа. Вперёд!'],
  },
  // ── v2 ──
  pain_today: {
    soft: ['Болит: {what}. Сегодня бережно - упражнения на больное убрал, нагрузку снизил. Слушай тело, а если боль сильная - к врачу.'],
    coach: ['Болит: {what}. План на сегодня подстроен: больное не грузим, интенсивность ниже. Сильная или долгая боль - к врачу.'],
    sergeant: ['Болит: {what}. Приказ - беречь: больное не грузим, остальное по самочувствию. Сильная боль - сразу к врачу.'],
  },
  nap_good: {
    soft: ['Дневной сон {m} мин после короткой ночи - отличное решение, это правда восстанавливает.'],
    coach: ['Дневной сон {m} мин после недосыпа - правильно. Лучшая длина - 20-30 минут.'],
    sergeant: ['Тихий час {m} мин засчитан. Но ночью всё равно отбой вовремя.'],
  },
  nap_long: {
    soft: ['Дневной сон вышел длинным или поздним ({m} мин) - ночью может быть труднее уснуть. Лучше 20-30 минут и до 17:00.'],
    coach: ['{m} мин дневного сна - многовато или поздно. Держи дневной сон до 30 минут и до 17:00, иначе собьёшь ночь.'],
    sergeant: ['{m} мин днём? Так ночной сон и ломается. Днём - максимум полчаса и не позже пяти.'],
  },
  sleep_short: {
    soft: ['Ночью вышло всего {h} ч сна. Сегодня без подвигов: нагрузку полегче, а лечь - пораньше.',
           'Сон короткий, {h} ч. Береги себя сегодня: меньше нагрузки, больше воды, отбой до одиннадцати.'],
    coach: ['Сон {h} ч - это недосып. Тренировку сегодня облегчаем: меньше подходов, веса не повышаем.',
            '{h} ч сна мало для восстановления. Сегодня работаем вполсилы, вечером - отбой вовремя.'],
    sergeant: ['{h} ч сна? Режим проигрывает, боец. Сегодня нагрузка облегчённая, а отбой - строго по расписанию.',
               'Спал{|а} {h} ч. Геройствовать на недосыпе запрещаю: сегодня лёгкий вариант. А ночью - спать, а не в телефон.'],
  },
  sleep_poor: {
    soft: ['Ночь выдалась неспокойной. Сегодня не нагружай себя сильно - лёгкая тренировка тоже считается.'],
    coach: ['Часы сна есть, а качество слабое. Сегодня без рекордов: техника и умеренный темп.'],
    sergeant: ['Ночь прошла так себе, по отчёту видно. Сегодня облегчённый режим - но облегчённый не значит «никакой».'],
  },
  sleep_great: {
    soft: ['Выспал{ся|ась} как следует - {h} ч и бодрый подъём. Отличный день, чтобы сделать чуть больше обычного.',
           '{h} ч хорошего сна! Сегодня силы есть - можно добавить прогулку или лишний подход.'],
    coach: ['{h} ч хорошего сна - ресурс есть. Сегодня можно прибавить: вес, подход или лишние 15 минут ходьбы.',
            'Сон отличный. Такие дни не тратят впустую - работаем на полную.'],
    sergeant: ['{h} ч сна и бодрый подъём. Оправданий сегодня нет ни одного. Полный объём!',
               'Выспал{ся|ась}? Отлично. Значит, сегодня ни одного «устал» я не услышу.'],
  },
  state_broken: {
    soft: ['Сегодня ты разбит{|а} - это нормально, так бывает. Давай сделаем день восстановления: прогулка, растяжка, пораньше спать.',
           'Тяжёлый день. Не заставляй себя - лёгкая растяжка и вода, а тренировку можно перенести.'],
    coach: ['Самочувствие «разбит». Сегодня день восстановления: растяжка, прогулка, сон. Тренировку перенесём, объём недели сохраним.',
            'Организм просит паузу. Делаем восстановительный вариант вместо полной программы.'],
    sergeant: ['Разбит{|а}? Принято. Сегодня приказ - восстановление: растяжка, прогулка, отбой пораньше. Завтра спрошу по полной.',
               'Раненых в атаку не гоню. Сегодня восстановление, тренировку переносим - не отменяем.'],
  },
  cheat_day: {
    soft: ['Сегодня читмил - наслаждайся без чувства вины. Завтра спокойно вернёмся к режиму.'],
    coach: ['Читмил по плану - это нормально. Ешь с удовольствием, завтра - обычный режим.'],
    sergeant: ['Сегодня читмил, разрешаю. Один день, боец. Завтра в строй.'],
  },
  special_day: {
    soft: ['Сегодня особенный день - просто проживи его. Всё остальное подождёт до завтра.'],
    coach: ['Особый день - без оценок и упрёков. Если получится, больше ходи и пей воду.'],
    sergeant: ['Особый день - увольнительная. Отдыхай. Завтра - по уставу.'],
  },
  sick_day: {
    soft: ['Выздоравливай! Сегодня никаких тренировок - только отдых, вода и сон.'],
    coach: ['Болезнь - не время для нагрузки. Отдых, жидкость, сон. Вернёмся, когда станет лучше.'],
    sergeant: ['Больных в строй не ставлю. Лечись, пей воду, спи. Это тоже приказ.'],
  },
  too_many_cheat: {
    soft: ['За неделю уже {nd} с читмилом. Давай следующий отложим - иначе прогресс начнёт буксовать.'],
    coach: ['{nd} с читмилом за 7 дней - это уже не разгрузка, а привычка. Следующий - не раньше чем через неделю.'],
    sergeant: ['{nd} с читмилом за неделю? Это уже не читмил, а новый рацион. Отставить до следующей недели!'],
  },
  too_many_special: {
    soft: ['За месяц набралось {nd} особых. Бывает насыщенно, но пусть обычных дней будет больше.'],
    coach: ['Особых дней за месяц - {n}. Когда особенным становится каждый пятый день, режим размывается.'],
    sergeant: ['{n} «особых» дней за месяц. Что ни день - то праздник? Режим сам себя не соблюдёт.'],
  },
  backdated: {
    soft: ['Вижу, часть записей внесена задним числом. Ничего страшного, но в тот же день точнее - и мне проще подстроить план.'],
    coach: ['Записи задним числом портят картину: план подстраивается с опозданием. Вноси данные в тот же день.'],
    sergeant: ['Отчёты задним числом? В армии за такое - наряд. Вноси в тот же день, иначе я планирую вслепую.'],
  },
  out_of_window: {
    soft: ['Приём пищи в {time} - за пределами твоего окна. Не страшно, просто держим это в голове.'],
    coach: ['Еда в {time} - вне окна питания. Если это повторяется, давай сдвинем окно, чтобы оно было реальным.'],
    sergeant: ['{time} - окно питания закрыто, а на столе еда. Окно не для красоты придумано.'],
  },
  habit_sugar: {
    soft: ['Сегодня в дневнике сладкое, а в целях - меньше сахара. Один раз - не беда, главное, не каждый день.'],
    coach: ['В дневнике сладкое, а цель - меньше сахара. Следующий перекус - фрукт или творог.'],
    sergeant: ['Сахар в рационе при цели «меньше сахара». Кто кого дрессирует - ты конфеты или они тебя?'],
  },
  habit_flour: {
    soft: ['Сегодня много мучного, а в целях - меньше. Попробуй на ужин крупу или овощи вместо хлеба.'],
    coach: ['Мучное сверх плана. Замени хлеб и макароны на гречку, рис или овощи - сытость та же.'],
    sergeant: ['Хлеб, булки, макароны - целый склад мучного. Цель была другая. Исправляем с ужина.'],
  },
  habit_coffee: {
    soft: ['Уже не первая чашка кофе, а цель - пить меньше. Может, следующую заменить на чай или воду?'],
    coach: ['Кофе сверх лимита. После обеда - только вода и чай, иначе пострадает сон.'],
    sergeant: ['Опять кофе? Цель - меньше кофе, а не больше. Кружку - отставить, воду - взять.'],
  },
  coffee_late: {
    soft: ['Кофе в {time} - поздновато. Кофеин держится в крови 5-6 часов, заснуть может быть сложнее. Вечером лучше травяной чай.'],
    coach: ['Последний кофе в {time}. Кофеин работает ещё часов пять - сон будет поверхностнее. Завтра последняя чашка до 14:00.'],
    sergeant: ['Кофе в {time}? Потом «не спится». Кофе - до обеда, вечером вода или травяной чай.'],
  },
  habit_alcohol: {
    soft: ['В дневнике алкоголь. Не ругаю, но сон и восстановление сегодня будут хуже - выпей побольше воды.'],
    coach: ['Алкоголь при цели «меньше алкоголя». Это минус к сну и восстановлению. Завтра тренировка без рекордов.'],
    sergeant: ['Алкоголь в дневнике, а цель была - меньше. Сегодня вода в двойном объёме, и на этой неделе - последний раз.'],
  },
  habit_fastfood: {
    soft: ['Сегодня был фастфуд. Бывает! Пусть следующий приём будет попроще: белок и овощи.'],
    coach: ['Фастфуд в дневнике при цели его сократить. Следующий приём - белок и овощи, без соусов.'],
    sergeant: ['Фастфуд? При цели «меньше фастфуда»? Следующий приём - курица и овощи, без обсуждений.'],
  },
  habit_late: {
    soft: ['Поздний перекус в {time}. Постарайся заканчивать с едой пораньше - и сон будет крепче.'],
    coach: ['Еда в {time} - поздно. Последний приём - за 2–3 часа до сна.'],
    sergeant: ['Еда в {time}? Ночной дожор отставить. Кухня закрывается за три часа до отбоя.'],
  },
  balance_deficit: {
    soft: ['До нормы недели не хватает около {n} минут движения. Добери их до выходных - хоть прогулкой.'],
    coach: ['Недельный объём отстаёт на {n} мин. Добери до выходных: короткая тренировка или быстрая ходьба.'],
    sergeant: ['Недобор {n} минут за неделю. Добери до выходных - иначе неделя не засчитана.'],
  },
  deload: {
    soft: ['Пятая неделя программы - время для разгрузки. Веса полегче, подходов меньше: так мышцы успевают вырасти.'],
    coach: ['Эта неделя - разгрузочная: веса −30–40 %, подходов меньше. Это часть прогресса, а не откат.'],
    sergeant: ['Разгрузочная неделя, боец. Снижаем веса и объём - по плану, а не от лени.'],
  },
};

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

// ── имя и род ──
// Имя берём из профиля (или из аккаунта). Логин вида «ivan» — не имя: по нему не обращаемся.
function cleanName(raw) {
  const w = String(raw || '').trim().split(/\s+/)[0] || '';
  if (/^[А-ЯЁа-яё][а-яё-]+$/.test(w)) return w[0].toUpperCase() + w.slice(1);
  return /^[A-Z][a-z]+$/.test(w) ? w : '';
}
export function userName(uid = store.uid()) {
  return cleanName(prof(uid).name || (uid === store.uid() ? store.me()?.name : ''));
}
// склонение имени пользователя (или партнёра): { nom, gen, dat, acc, ins, prep, voc, sex }
export function nameForms(uid = store.uid()) {
  if (uid === store.uid()) return N.decl(userName(uid), prof(uid).sex);
  const pa = store.partners().find(x => x.id === uid);
  return N.decl(cleanName(pa?.name) || pa?.name || '', null);
}
// контекст шаблона: {name…}, {partner…}, {м|ж}, {pa:м|ж}
function nameCtx(vars = {}) {
  const pa = partner();
  const pn = pa ? cleanName(pa.name) || pa.name : undefined;
  const ctx = { name: userName(), sex: prof().sex, partner: pn, ...vars };
  // имя партнёра из аккаунта приводим к виду «Маша»; заглушку вроде «партнёр» не трогаем
  if (typeof ctx.partner === 'string' && store.partners().some(x => x.name === ctx.partner)) ctx.partner = cleanName(ctx.partner) || ctx.partner;
  return ctx;
}
// {м|ж} — окончание по полу из профиля; {name}, {name_dat}, {partner_acc}… — имя в нужном падеже
function pick(set, key, vars) {
  return N.fill(set[hash(key) % set.length], nameCtx(vars));
}
// Обращение по имени в части реплик: не в каждой, а примерно в двух днях из трёх и только в одной реплике списка.
// Друг зовёт по-домашнему («Маш»), тренер и сержант — полным именем, как оно записано в профиле.
function addressSome(list, key, tone) {
  const d = nameForms();
  if (!d.nom || !list.length) return list;
  if (list.some(l => Object.values(d).some(f => typeof f === 'string' && f.length > 1 && l.text.includes(f)))) return list;
  const h = hash(today() + key + d.nom);
  const r = h % 6, idx = r <= 2 ? 0 : r <= 4 ? 1 : -1;
  if (idx < 0 || !list[idx]) return list;
  const form = tone === 'soft' ? d.voc : d.nom;
  const mode = tone === 'sergeant' ? (h % 2 ? 'shout' : 'lead') : (h % 3 === 0 ? 'lead' : 'tail');
  const proper = store.partners().map(p => cleanName(p.name)).filter(Boolean);
  list[idx] = { ...list[idx], text: N.address(list[idx].text, form, mode, proper) };
  return list;
}
function say(event, tone, vars = {}) {
  const set = LINES[event][tone] || LINES[event].coach;
  return pick(set, today() + event, vars);
}

const MOOD = { setup: 'info', gap: 'scold', yesterday_perfect: 'praise', yesterday_bad: 'scold', today_perfect: 'praise',
  evening_low: 'scold', workout_today: 'info', workout_light: 'info', workout_late: 'scold', workout_missed: 'scold', streak_record: 'praise',
  streak: 'praise', kcal_over: 'scold', protein_low: 'scold', weight_good: 'praise', weight_stall: 'scold', plateau: 'info',
  plateau_lifts: 'info', partner_ahead: 'scold', partner_behind: 'praise', morning: 'info', keep_going: 'info',
  sleep_short: 'info', sleep_poor: 'info', sleep_great: 'praise', nap_good: 'praise', nap_long: 'info', pain_today: 'info', state_broken: 'info', cheat_day: 'info', special_day: 'info',
  sick_day: 'info', too_many_cheat: 'scold', too_many_special: 'scold', backdated: 'info', out_of_window: 'scold',
  habit_sugar: 'scold', habit_flour: 'scold', habit_coffee: 'scold', coffee_late: 'info', habit_alcohol: 'scold', habit_fastfood: 'scold', habit_late: 'scold',
  balance_deficit: 'info', deload: 'info' };

// Порядок важности: чем меньше, тем выше реплика.
const PRIORITY = { setup: 0, sick_day: 5, today_perfect: 10, pain_today: 11, state_broken: 12, cheat_day: 14, special_day: 14,
  sleep_short: 16, sleep_poor: 17, too_many_cheat: 20, too_many_special: 21, gap: 25, workout_light: 28, workout_missed: 30,
  workout_late: 32, workout_today: 33, nap_long: 34, sleep_great: 35, nap_good: 36, evening_low: 38, habit_sugar: 40, habit_flour: 40, habit_coffee: 40, coffee_late: 41,
  habit_alcohol: 40, habit_fastfood: 40, habit_late: 40, out_of_window: 42, balance_deficit: 44, deload: 45, backdated: 46,
  yesterday_perfect: 48, yesterday_bad: 49, streak_record: 50, streak: 55, kcal_over: 60, protein_low: 61, weight_good: 64,
  plateau: 65, plateau_lifts: 66, weight_stall: 67, partner_ahead: 70, partner_behind: 71, morning: 90, keep_going: 91 };

// ── честные пометки: что посчитано на устройстве и где сервер точнее ──
// Экраны показывают их мелким примечанием рядом с цифрами; тренер — под своей репликой.
export const SOURCE_NOTES = {
  stats: 'Рассчитано по статистике на этом устройстве - точнее с сервером.',
  coach: 'Советы посчитаны на этом устройстве по твоим записям - индивидуальнее с сервером и ИИ.',
  norms: 'Нормы - по формулам; индивидуальную поправку даёт сервер с ИИ.',
  norms_default: 'Нормы пока примерные, по умолчанию - точные посчитает сервер, когда будет связь.',
  sleep: 'Время отбоя - по твоим последним ночам на этом устройстве; точнее подскажет разбор с сервером.',
  goals: 'Темп - средний по статистике для похожих людей; индивидуальный прогноз - с сервером.',
  trend: 'Тренд посчитан на устройстве по твоим записям - разбор с ИИ на сервере точнее.',
  food: 'БЖУ по справочнику на устройстве - ориентировочно; с сервером точнее.',
  activity: 'Минуты и калории активности - оценка по средним нормам; с сервером точнее.',
  plan: 'План подобран на устройстве по правилам; с сервером ИИ подстроит его под тебя.',
  steps: 'Минуты ходьбы - из расчёта ~100 шагов в минуту; у тебя может быть иначе.',
};
export function sourceNote(kind = 'stats') { return SOURCE_NOTES[kind] || SOURCE_NOTES.stats; }

// ── «вчера → сегодня»: по каждому показателю конкретный шаг на сегодня ──
// {…} — подстановки; {м|ж} — род; имя вставляет addressSome() в часть реплик.
const MLINES = {
  y_water_low: {
    soft: ['Вчера воды вышло {y} из {t} {of}. Давай сегодня {half} до обеда - дальше пойдёт само.',
           'Воды вчера маловато: выпито {y} из {t} {of}. Поставь бутылку на видное место - рука сама потянется.',
           'Вчера {y} из {t} {of} воды. Сегодня попробуй стакан после каждого приёма пищи - уже будет заметно больше.'],
    coach: ['Вода вчера: выпито {y} из {t} {of}. План на сегодня - {half} до 13:00, остальное до 19:00.',
            'Вчера {y} из {t} {of} воды. Сегодня плюс {plus} к вчерашнему - реально, если начать прямо сейчас.',
            'Вчера {выпил|выпила} только {y} из {t} {of}. Стакан после пробуждения, стакан перед каждой едой - и к вечеру норма закрыта.'],
    sergeant: ['Вчера {y} из {t} {of} воды. Это не водный режим, это дегустация. Сегодня {half} до обеда - проверю.',
               'Воды вчера выпито {y} из {t} {of}. Обезвоженный боец - уставший боец. Первый стакан - прямо сейчас, остальные по часам.',
               'Выпито {y} из {t} {of} вчера? Сегодня плюс {plus}, без обсуждений. Кружку наполнить - выполнять!'],
  },
  y_water_up: {
    soft: ['Вчера воды было {y} из {t} - больше, чем позавчера. Видишь, привычка складывается!',
           'Вчера {y} {ygl} воды, заметно лучше позавчерашнего. Так приятно это видеть.'],
    coach: ['Вода вчера - {y} из {t}, лучше, чем позавчера. Закрепляем: сегодня так же.',
            'Вчера по воде прибавил{|а}: {y} из {t}. Держим этот уровень.'],
    sergeant: ['Вчера {y} {ygl} воды - лучше, чем позавчера. Смотри-ка, умеешь. Сегодня повторить.',
               'По воде вчера прогресс: {y} из {t}. Отметил. Сегодня - не меньше.'],
  },
  y_steps_low: {
    soft: ['Вчера {y} шагов. Сегодня давай доберём до {t} - это примерно {min} прогулки сверх вчерашнего, можно по частям.',
           'Шагов вчера {y}. Выйди на остановку раньше или пройдись после обеда - до {t} ближе, чем кажется.',
           'Вчера получилось {y} шагов. Сегодня две прогулки по {half_min} - и {t} наберутся.'],
    coach: ['Шаги вчера: {y}. Сегодня цель {t} - это ещё {min} ходьбы. Разбей на две прогулки по {half_min}.',
            'Вчера {y} шагов при норме {t}. Сегодня добираем: {min} быстрым шагом - и вопрос закрыт.',
            '{y} шагов вчера - мало. Сегодня {t}: пешком до магазина, лестница вместо лифта, звонки - на ходу.'],
    sergeant: ['Вчера {y} шагов. Это не марш, это дорога до холодильника. Сегодня {t} - то есть плюс {min} ходьбы. Исполнять!',
               '{y} шагов за сутки? Сегодня норма {t}. Плюс {min} строевым - и доложить.',
               'Вчера {y}. Позор для пехоты. Сегодня {t}, и лифт тебе больше не друг.'],
  },
  y_steps_up: {
    soft: ['Вчера {y} шагов - на {diff} больше, чем позавчера. Ноги тебе спасибо скажут!',
           'Вчера прошёл{|ла} {y} шагов, заметно больше позавчерашнего. Здорово!'],
    coach: ['Шаги вчера {y} - на {diff} больше, чем позавчера. Так и надо.',
            'Вчера {y} шагов, плюс {diff} к позавчера. Сегодня - тот же уровень.'],
    sergeant: ['{y} шагов вчера, плюс {diff} к позавчерашнему. Годится. Сегодня не сбавлять.',
               'Вчера {y} шагов. Вот это марш. Повторить!'],
  },
  y_workout_done: {
    soft: ['Вчера тренировка «{title}» сделана - ты молодец! Сегодня мышцам нужны белок и сон.',
           'Вчерашняя «{title}» позади - горжусь. Сегодня можно просто хорошо поесть и пройтись.'],
    coach: ['«{title}» вчера - выполнено. Сегодня восстановление: белок в каждом приёме пищи и сон не меньше 7 часов.',
            'Вчерашняя тренировка в зачёт. Мышцы растут между тренировками - не срезай сегодня сон и белок.'],
    sergeant: ['«{title}» вчера отработал{|а}. Засчитано. Сегодня ешь белок и спи - это тоже служба.',
               'Вчерашняя тренировка - в личное дело, с плюсом. Сегодня не расслабляться.'],
  },
  y_kcal_under: {
    soft: ['Вчера вышло всего {kcal} ккал из {t}. Это слишком мало - тело начнёт экономить силы. Сегодня нормальный обед обязательно.'],
    coach: ['Вчера {kcal} ккал при норме {t}. Жёсткий недобор бьёт по мышцам и заканчивается срывом вечером. Сегодня ешь по плану.',
            'Недоел{|а} вчера: {kcal} из {t} ккал. Голодовка - не дефицит. Сегодня три полноценных приёма.'],
    sergeant: ['{kcal} ккал вчера из {t}? На голодном пайке много не навоюешь. Сегодня есть по норме - приказ.'],
  },
  y_food_good: {
    soft: ['Вчера питание просто отличное: {kcal} ккал и {p} г белка. Так держать!'],
    coach: ['Питание вчера - в точку: {kcal} ккал, белок {p} г. Повторяем.'],
    sergeant: ['Вчера {kcal} ккал и {p} г белка - по уставу. Хвалю. Сегодня так же.'],
  },
  y_sweets: {
    soft: ['Вчера сладкое попадалось {n}: {what}. Сегодня попробуй одно из них заменить на фрукты или творог с ягодами.',
           'Вчера было немало сладкого ({what}). Не ругаю - просто сегодня пусть к чаю будет что-то попроще.'],
    coach: ['Сладкое вчера {n}: {what}. Сегодня - максимум одно, и после основного приёма пищи, а не вместо.',
            'Вчера {what}. Сахар тянет за собой голод к вечеру. Сегодня перекус - фрукт или орехи.'],
    sergeant: ['Вчера сладкое {n}: {what}. Кондитерская разведка засечена. Сегодня - ни одной конфеты до ужина.',
               '{What} - вчерашняя диверсия. Сегодня сладкое под запретом до вечера.'],
  },
  y_flour: {
    soft: ['Вчера было много мучного: {what}. Сегодня на гарнир попробуй крупу или овощи - сытость та же.'],
    coach: ['Мучное вчера {n}: {what}. Сегодня хлеб - один раз, остальное - крупы и овощи.'],
    sergeant: ['Вчера {what} - хлебозавод на выезде. Сегодня мучное - один раз, не больше.'],
  },
  y_fastfood: {
    soft: ['Вчера был фастфуд ({what}). Бывает! Сегодня пусть будет простая еда: белок, крупа, овощи.'],
    coach: ['Фастфуд вчера: {what}. Сегодня компенсируем качеством - белок и овощи в каждом приёме.'],
    sergeant: ['Вчера {what}. Фастфуд засчитан как самоволка. Сегодня - нормальная еда по плану.'],
  },
  y_late: {
    soft: ['Вчера последний раз ел{|а} в {time}. Сегодня попробуй закончить к {until} - сон будет спокойнее.'],
    coach: ['Вчера последний приём был в {time} - поздновато. Сегодня постарайся закончить есть до {until}.'],
    sergeant: ['Вчера в {time} ты был{|а} на кухне. Сегодня кухня закрыта с {until}. Караул выставлен.'],
  },
  sleep_tonight: {
    soft: ['Чтобы выспаться, сегодня ляг к {bed}: встаёшь ты около {wake}, а тебе нужно примерно {h}.',
           'Сегодня попробуй лечь в {bed} - так до подъёма в {wake} выйдет около {h} сна.'],
    coach: ['Отбой сегодня - {bed}. Подъём у тебя около {wake}, значит, выйдет {h} сна. Телефон убрать за полчаса.',
            'Сон - часть тренировки. Сегодня в {bed} в кровати, чтобы к {wake} набрать {h}.'],
    sergeant: ['Отбой в {bed}. Не «ещё одну серию», а {bed}. Подъём в {wake} никто не отменял.',
               'Приказ на вечер: в {bed} - в кровати, телефон - на тумбочку экраном вниз. Подъём в {wake}.'],
  },
  y_stress: {
    soft: ['Вчера был нервный день. Сегодня найди 15 минут пройтись без телефона - голова скажет спасибо.'],
    coach: ['Вчера стресс был высоким. Сегодня умеренная нагрузка и прогулка - это лучше, чем выжимать из себя рекорд.'],
    sergeant: ['Вчера стресс зашкаливал. Сегодня 15 минут прогулки и отбой вовремя. Нервы - тоже боевой ресурс.'],
  },
  y_state_up: {
    soft: ['Вчера было тяжело, а сегодня уже лучше - здорово! Только не бросайся сразу навёрстывать всё.'],
    coach: ['Самочувствие лучше, чем вчера. Хорошо, но к нагрузке возвращаемся постепенно.'],
    sergeant: ['Ожил{|а}? Вот и славно. В строй - но без геройства, по плану.'],
  },
  week_pace: {
    soft: ['На этой неделе движения пока меньше плана на {n}. Если добавлять по {per} в день, к воскресенью всё выровняется.'],
    coach: ['Неделя отстаёт на {n} движения. По {per} в день - и к воскресенью план закрыт без рывков.'],
    sergeant: ['Отставание по неделе - {n}. Ликвидируем по {per} в день. Начать сегодня.'],
  },
  y_better: {
    soft: ['Вчерашний день лучше позавчерашнего: {b} → {aw}, лучше всего - {what}. Видишь, получается!',
           'Вчера {aw}, позавчера - {b}. День за днём лучше - это и есть прогресс.'],
    coach: ['Позавчера {b}, вчера {aw}. Больше всего подтянул{|а} {what}. Сегодня - не ниже {a}.',
            'Вчера на {dw} лучше, чем позавчера. Держим планку: сегодня минимум {a}.'],
    sergeant: ['Вчера {a} против {b} позавчера. Растёшь, боец. Сегодня меньше {a} не принимаю.',
               'Плюс {dw} за сутки. Неплохо. Но до дембеля далеко - сегодня так же.'],
  },
  d_water_pace: {
    soft: ['Воды пока {have} из {t}, а день уже в разгаре. Выпей стакан сейчас - вторую половину будет проще.'],
    coach: ['К этому часу стоило выпить хотя бы {should}, а пока {have}. Догоняем: стакан сейчас, стакан через час.'],
    sergeant: ['Полдня прошло, а воды {have} из {t}. Отстаёшь от графика. Стакан - немедленно.'],
  },
  e_water: {
    soft: ['До нормы воды осталось {left}. По стакану в час - и к {by} всё будет.',
           'Ещё {left} воды - и день по воде закрыт. Налей прямо сейчас, пока читаешь.'],
    coach: ['Вода: {have} из {t}. Осталось {left} - распредели до {by}, не залпом перед сном.',
            'Ещё {left} воды. Стакан сейчас, остальное - до {by}.'],
    sergeant: ['Ещё {left} воды, боец. До {by} - выпить. Литр на ночь не заливаем - это не пожарные учения.',
               'Недостача по воде - {left}. Устранить до {by}.'],
  },
  e_water_much: {
    soft: ['Воды сегодня {have} из {t}. Всё за вечер уже не выпить - и не надо: {can} до {by}, остальное завтра с утра.'],
    coach: ['Вода: {have} из {t}. Норму за вечер не догнать без вреда для сна. {can} до {by} - и хватит; завтра начинаем с утра.'],
    sergeant: ['Воды {have} из {t} - провал по воде. Залпом не догоняем: {can} до {by}, а завтра с утра - по графику.'],
  },
  e_steps: {
    soft: ['До нормы шагов осталось {left} - это около {min} прогулки. Вечерняя прогулка - хороший способ закончить день.'],
    coach: ['До нормы {left} шагов, примерно {min} ходьбы. Прогулка после ужина закроет вопрос.'],
    sergeant: ['Недобор {left} шагов. После ужина - {min} ходьбы, и доложить.'],
  },
  e_protein: {
    soft: ['Белка сегодня пока {p} из {t} г. На ужин - что-нибудь белковое: {idea}.'],
    coach: ['Белок: {p} из {t} г. Ужин строим вокруг белка - {idea}, ещё около {left} г.'],
    sergeant: ['Белка {p} из {t} г. Ужин - белковый: {idea}. Недостачу в {left} г закрыть.'],
  },
  e_kitchen: {
    soft: ['Калории на сегодня уже набраны. Если проголодаешься - чай, кефир или овощи.'],
    coach: ['Норма калорий на сегодня выбрана. Дальше - только вода, чай или овощи.'],
    sergeant: ['Паёк на сегодня выдан полностью. Кухня закрыта. Караульн{ый|ая} - ты сам{|а}.'],
  },
};
const MMOOD = { y_water_low: 'scold', y_water_up: 'praise', y_steps_low: 'scold', y_steps_up: 'praise', y_workout_done: 'praise',
  y_kcal_under: 'scold', y_food_good: 'praise', y_sweets: 'scold', y_flour: 'scold', y_fastfood: 'scold', y_late: 'scold',
  sleep_tonight: 'info', y_stress: 'info', y_state_up: 'praise', week_pace: 'info', y_better: 'praise', d_water_pace: 'info',
  e_water: 'info', e_water_much: 'scold', e_steps: 'info', e_protein: 'info', e_kitchen: 'info' };

const PART_RU = { checklist: 'отметки чек-листа', sleep: 'сон', state: 'самочувствие', food: 'питание', activity: 'движение' };
const PROTEIN_IDEA = {
  vegetarian: 'творог, яйца, сыр или фасоль', vegan: 'тофу, чечевица, нут или фасоль', pescatarian: 'рыба, творог или яйца',
  lactose_free: 'курица, рыба, яйца или бобовые', halal: 'курица, говядина, рыба или яйца', default: 'курица, рыба, творог или яйца',
};
const nb = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');       // 8 000
const glW = n => `${n} ${plural(n, 'стакан', 'стакана', 'стаканов')}`;
const ofGl = n => (n % 10 === 1 && n % 100 !== 11 ? 'стакана' : 'стаканов');                 // «из 8 стаканов»
const minW = n => `${n} ${plural(n, 'минута', 'минуты', 'минут')}`;
const r5 = x => Math.max(5, Math.round(x / 5) * 5);
const timesW = n => (n === 1 ? 'один раз' : `${n} ${plural(n, 'раз', 'раза', 'раз')}`);
const listW = a => [...new Set(a.map(x => String(x || '').toLowerCase().trim()).filter(Boolean))].slice(0, 2).join(', ');

// 7,75 → «7 ч 45 мин», 8 → «8 ч»
const hoursW = h => { const m = Math.round(h * 60); return m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`; };

// значение пункта чек-листа за день, если его отмечали; null — «не знаем» (не путать с нулём)
function itemVal(it, d, uid) {
  if (!it) return null;
  const p = progress(it, d, uid);
  if (!p.applies) return null;
  const v = logVal(d, it.id, uid);
  if (v === undefined || v === null || v === '') return null;
  return { v: Number(v) || 0, t: p.target || 0 };
}

// когда ложиться, чтобы выспаться: обычный подъём − норма сна − ~15 минут на засыпание
export function bedtime(date = today(), uid = store.uid()) {
  const ss = sleepStats(7, uid, date);
  const w = toMin(ss.count >= 3 ? ss.avgWake : sleep(date, uid)?.wake || ss.avgWake);
  if (w === null) return null;
  const tgt = sleepTarget(uid);
  const b = Math.floor((w - tgt * 60 - 15) / 15) * 15;
  return { bed: hmOf(b), wake: hmOf(w), hours: tgt, bedMin: ((b % 1440) + 1440) % 1440, basis: ss.count };
}

// Кандидаты «вчера → сегодня» (утро и день) и «что ещё успеть» (вечер) с весом важности.
function motivation(uid, t, hour, nowD = new Date()) {
  const y = addDays(t, -1), y2 = addDays(t, -2);
  const dt = dayType(t, uid), yt = dayType(y, uid);
  const start = firstDay(uid);
  const tg = target(uid);
  const dir = goalDir(uid);
  const p = prof(uid), gl = goalOf(uid);
  const habits = new Set(gl.habits || []);
  const types = new Set((gl.goals || []).map(g => g.type));
  const muscle = types.has('gain_muscle') || dir === 'up';
  const lose = dir === 'down';
  const its = items(uid);
  const water = its.find(i => i.data.target_from === 'water');
  const steps = its.find(i => i.data.target_from === 'steps');
  const phase = hour < 12 ? 'morning' : hour < 17 ? 'day' : 'evening';
  const sick = dt === 'sick', special = dt === 'special', cheat = dt === 'cheat';
  const normNote = tg ? null : 'norms_default';
  const cand = [];
  const c = (event, w, vars = {}, note = null, when = 'y') => cand.push({ event, w, vars, note, when });
  const scold = !special;                                   // в особый день — только похвала
  const hadY = start && start <= y;

  if (phase !== 'evening' && hadY) {
    const yFood = !['cheat', 'special', 'sick'].includes(yt);
    // вода
    const wy = itemVal(water, y, uid), wy2 = itemVal(water, y2, uid);
    if (wy && wy.t >= 2 && yt !== 'special') {
      if (wy.v < wy.t * 0.75 && scold) {
        c('y_water_low', 0.5 + (1 - wy.v / wy.t), { y: glassNum(wy.v), t: wy.t, of: ofGl(wy.t), half: glW(Math.ceil(wy.t / 2)),
          plus: glW(Math.max(1, Math.min(3, wy.t - wy.v))) }, normNote);
      } else if (wy2 && wy.v >= wy.t * 0.75 && (wy.v >= wy2.v + 2 || (wy.v >= wy.t && wy2.v < wy.t))) {
        c('y_water_up', 0.55, { y: glassNum(wy.v), t: wy.t, ygl: plural(wy.v, 'стакан', 'стакана', 'стаканов') });
      }
    }
    // шаги
    const sy = itemVal(steps, y, uid), sy2 = itemVal(steps, y2, uid);
    if (sy && sy.t >= 1000 && !['special', 'sick'].includes(yt) && !sick) {
      if (sy.v < sy.t * 0.8 && scold) {
        const m = r5((sy.t - sy.v) / 100);
        c('y_steps_low', (0.5 + (1 - sy.v / sy.t)) * (lose ? 1.2 : 1), { y: nb(sy.v), t: nb(sy.t), min: minW(m), half_min: minW(r5(m / 2)) },
          normNote || 'steps');
      } else if (sy2 && sy.v >= sy.t * 0.8 && sy.v >= sy2.v + 1000) {
        c('y_steps_up', 0.55, { y: nb(sy.v), diff: nb(sy.v - sy2.v) });
      }
    }
    // тренировка вчера (пропуск разбирает workout_missed)
    const yw = activeWorkout(y, uid);
    if (yw && (yw.data.done || workoutProgress(yw) >= 0.8)) c('y_workout_done', muscle ? 0.75 : 0.6, { title: yw.data.title || 'тренировка' });
    // питание вчера
    const fd = yFood ? foodDay(y, uid) : null;
    if (fd && !sick) {
      const hv = habitViolations(y, uid);
      if (tg && tg.kcal && fd.calculated && fd.meals >= 2) {
        const r = fd.kcal / tg.kcal;
        if (r > 1.1 && scold) c('kcal_over', Math.min(1.2, (r - 1) * 3) * (lose ? 1.3 : 1), { over: nb(fd.kcal - tg.kcal) }, 'food');
        else if (r < 0.75 && fd.meals >= 3 && scold) c('y_kcal_under', 0.4 + (0.75 - r) * 3 * (muscle ? 1.3 : 1), { kcal: nb(fd.kcal), t: nb(tg.kcal) }, 'food');
        if (tg.p && fd.p < tg.p * 0.8 && scold) {
          c('protein_low', (0.4 + (1 - fd.p / tg.p)) * (muscle || types.has('lose_fat') ? 1.3 : 1),
            { p: Math.round(fd.p), t: tg.p, per: Math.round(tg.p / 4 / 5) * 5, idea: PROTEIN_IDEA[p.diet] || PROTEIN_IDEA.default }, 'food');
        }
        if (Math.abs(r - 1) <= 0.1 && (!tg.p || fd.p >= tg.p * 0.9) && !hv.length && fd.meals >= 3) {
          c('y_food_good', 0.6, { kcal: nb(fd.kcal), p: Math.round(fd.p) });
        }
      }
      if (scold) {
        const sw = fd.hits.sugar.length, fl = fd.hits.flour.length, ff = fd.hits.fastfood.length;
        if (sw >= (habits.has('less_sugar') ? 1 : 2)) {
          const what = listW(fd.hits.sugar);
          c('y_sweets', 0.45 + sw * 0.1 + (habits.has('less_sugar') ? 0.3 : 0), { n: timesW(sw), what, What: what[0]?.toUpperCase() + what.slice(1) });
        }
        if (fl >= (habits.has('less_flour') ? 2 : 3)) c('y_flour', 0.4 + fl * 0.08 + (habits.has('less_flour') ? 0.3 : 0), { n: timesW(fl), what: listW(fd.hits.flour) });
        if (ff >= (habits.has('less_fastfood') ? 1 : 2)) c('y_fastfood', 0.5 + (habits.has('less_fastfood') ? 0.3 : 0), { what: listW(fd.hits.fastfood) });
        if (fd.late.length) {
          const bt = bedtime(t, uid);
          const until = bt ? hmOf(Math.min(20 * 60, bt.bedMin < 12 * 60 ? bt.bedMin + 1440 - 180 : bt.bedMin - 180)) : '20:00';
          c('y_late', 0.4 + (habits.has('less_late_eating') ? 0.4 : 0), { time: fd.late[fd.late.length - 1], until });
        }
      }
    }
    // самочувствие
    const sy_ = stateOf(y, uid), st = stateOf(t, uid);
    if (sy_?.stress === 'high' && !sick) c('y_stress', 0.5);
    if ((sy_?.wellbeing === 'broken' || sy_?.wellbeing === 'meh') && (st?.wellbeing === 'good' || st?.wellbeing === 'great')) c('y_state_up', 0.6);
    // день в целом: вчера лучше позавчерашнего
    const g1 = dayGrade(y, uid), g2 = dayGrade(y2, uid);
    if (g1.score !== null && g2.score !== null && g1.score - g2.score >= 10 && g1.score >= 50) {
      let best = null, bd = 0;
      for (const k of Object.keys(g1.parts)) {
        const dlt = (g1.parts[k] ?? 0) - (g2.parts?.[k] ?? 0);
        if (k in (g2.parts || {}) && dlt > bd) { bd = dlt; best = k; }
      }
      const bw = n => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;
      c('y_better', 0.65, { a: g1.score, b: g2.score, aw: bw(g1.score), dw: bw(g1.score - g2.score), what: PART_RU[best] || 'общий результат' });
    }
    // недельный объём движения: пн–ср (с четверга напоминает balance_deficit)
    const wd = weekday(t);
    if (wd >= 1 && wd <= 2 && !sick && scold) {
      const wa = weekActivity(t, uid);
      if (wa.behindMin >= 20 && wa.deficitMin >= 20) {
        c('week_pace', 0.4 + Math.min(0.5, wa.behindMin / 120), { n: minW(r5(wa.behindMin)), per: minW(r5(wa.deficitMin / (wa.daysLeft + 1))) }, 'activity');
      }
    }
  }

  // сон: если ночь была короткой или неделя недосыпа — конкретное время отбоя
  if (!special) {
    const si = sleepInfo(sleep(t, uid), uid);
    const ss = sleepStats(7, uid, t);
    const short = (si && si.verdict === 'short') || (ss.count >= 3 && ss.avgHours < sleepTarget(uid) - 0.5);
    const bt = short && bedtime(t, uid);
    if (bt) c('sleep_tonight', phase === 'evening' ? 0.9 : 0.7, { bed: bt.bed, wake: bt.wake, h: hoursW(bt.hours) }, 'sleep', 'any');
  }

  // день: вода отстаёт от графика (к 13:00 — треть, к 16:00 — половина)
  if (phase === 'day' && !special) {
    const wt = water ? progress(water, t, uid) : null;
    if (wt?.applies && wt.target) {
      const should = Math.floor(wt.target * clamp((hour - 8) / 12, 0, 1));
      if (should - wt.value >= 2) c('d_water_pace', 0.6 + (should - wt.value) * 0.05, { have: wt.value, t: wt.target, should: glW(should) }, normNote, 't');
    }
  }

  // вечер: что ещё можно успеть сегодня
  if (phase === 'evening' && !special) {
    const bt = bedtime(t, uid);
    const bedMin = bt ? (bt.bedMin < 12 * 60 ? bt.bedMin + 1440 : bt.bedMin) : 23 * 60;
    const now = hour * 60 + nowD.getMinutes();
    const wt = water ? progress(water, t, uid) : null;
    if (wt?.applies && wt.target && wt.value < wt.target) {
      const left = wt.target - wt.value;
      const by = Math.max(now + 60, Math.min(now + left * 60, bedMin - 60));
      const byS = hmOf(Math.ceil(by / 30) * 30);
      // по стакану в час; если до сна столько не выпить — честно говорим, сколько разумно
      const can = Math.max(1, Math.floor((bedMin - 60 - now) / 60) + 1);
      if (left > can + 1) c('e_water_much', 0.5 + left / wt.target, { have: wt.value, t: wt.target, can: glW(can), by: byS }, normNote, 't');
      else c('e_water', 0.5 + left / wt.target, { left: glW(left), have: wt.value, t: wt.target, by: byS }, normNote, 't');
    }
    const sv = itemVal(steps, t, uid);
    if (sv && sv.t >= 1000 && sv.v > 0 && sv.v < sv.t && !sick && hour < 22) {
      const left = sv.t - sv.v;
      c('e_steps', 0.4 + left / sv.t, { left: nb(left), min: minW(r5(left / 100)) }, normNote || 'steps', 't');
    }
    const fd = !cheat && !sick ? foodDay(t, uid) : null;
    if (fd && tg && fd.calculated && fd.meals >= 2) {
      if (tg.p && fd.p < tg.p * 0.7 && hour < 21) {
        c('e_protein', 0.5 + (1 - fd.p / tg.p) * (muscle ? 1.3 : 1), { p: Math.round(fd.p), t: tg.p, left: Math.round((tg.p - fd.p) / 5) * 5,
          idea: PROTEIN_IDEA[p.diet] || PROTEIN_IDEA.default }, 'food', 't');
      }
      if (tg.kcal && fd.kcal >= tg.kcal * 0.98) c('e_kitchen', 0.6 + (lose ? 0.2 : 0), {}, 'food', 't');
    }
  }
  return cand.sort((a, b) => b.w - a.w);
}

// Отношение тренера к дню: чем доволен, чем нет — короткими фразами для экранов (календарь, итог дня).
// → { good: string[], bad: string[] }
export function attitude(date = addDays(today(), -1), uid = store.uid()) {
  return memo(`att|${uid}|${date}`, () => {
    const good = [], bad = [];
    if (uid !== store.uid() || date > today()) return { good, bad };
    const its = items(uid), tg = target(uid), dt = dayType(date, uid);
    const w = itemVal(its.find(i => i.data.target_from === 'water'), date, uid);
    if (w && w.t) (w.v >= w.t ? good : w.v < w.t * 0.75 ? bad : []).push(`вода ${glassNum(w.v)} из ${w.t}`);
    const s = itemVal(its.find(i => i.data.target_from === 'steps'), date, uid);
    if (s && s.t) (s.v >= s.t ? good : s.v < s.t * 0.8 ? bad : []).push(`шаги ${nb(s.v)} из ${nb(s.t)}`);
    const wo = activeWorkout(date, uid);
    if (wo && (wo.data.done || workoutProgress(wo) >= 0.8)) good.push('тренировка сделана');
    else if (wo && date < today() && !['sick', 'rest', 'special'].includes(dt) && workoutProgress(wo) < 0.5) bad.push('тренировка пропущена');
    const si = sleepInfo(sleep(date, uid), uid);
    if (si && !si.nap) (si.verdict === 'short' ? bad : si.score >= 70 ? good : []).push(`сон ${dec(si.hours)} ч`);
    const fd = ['cheat', 'special', 'sick'].includes(dt) ? null : foodDay(date, uid);
    if (fd && tg && fd.calculated && fd.meals >= 2) {
      if (tg.p) (fd.p >= tg.p * 0.9 ? good : fd.p < tg.p * 0.8 ? bad : []).push(`белок ${Math.round(fd.p)} из ${tg.p} г`);
      if (tg.kcal) {
        const r = fd.kcal / tg.kcal;
        if (r > 1.1) bad.push(`калории +${nb(fd.kcal - tg.kcal)}`);
        else if (r >= 0.9) good.push('калории в норме');
      }
    }
    for (const h of habitViolations(date, uid)) {
      bad.push({ sugar: 'сладкое', flour: 'мучное', coffee: 'лишний кофе', alcohol: 'алкоголь', fastfood: 'фастфуд', late: `еда в ${h.time}` }[h.what] || h.what);
    }
    return { good, bad };
  });
}
Object.assign(LINES, MLINES);
Object.assign(MOOD, MMOOD);

// Реплики на сегодня, по важности. [{event, mood, text, note?}]
// note — честная пометка, если совет посчитан по статистике на устройстве (см. sourceNote).
// now — для проверки разных часов дня (по умолчанию — сейчас)
export function lines(now = new Date()) {
  const uid = store.uid();
  const p = prof(uid);
  const tone = p.tone || 'coach';
  const out = [];
  const add = (event, vars, extra) => out.push({ event, mood: MOOD[event], text: say(event, tone, vars), ...extra });
  const t = ymd(now), y = addDays(t, -1), hour = now.getHours();

  if (!p.setup_done) { add('setup'); return out; }
  const start = firstDay(uid);
  const s = dayScore(t);
  const dt = dayType(t, uid), yt = dayType(y, uid);
  const easy = dt === 'cheat' || dt === 'special' || dt === 'sick';     // в такие дни без упрёков

  if (s.total && s.done === s.total) add('today_perfect');
  if (dt === 'sick') add('sick_day');
  else if (dt === 'special') add('special_day');
  else if (dt === 'cheat') add('cheat_day');

  // злоупотребление читмилами и особыми днями
  let cheats = 0, specials = 0;
  for (let i = 0; i < 30; i++) {
    const x = dayType(addDays(t, -i), uid);
    if (x === 'cheat' && i < 7) cheats++;
    if (x === 'special') specials++;
  }
  if (cheats > 1) add('too_many_cheat', { n: cheats, nd: `${cheats} ${plural(cheats, 'день', 'дня', 'дней')}` });
  if (specials > 3) add('too_many_special', { n: specials, nd: `${specials} ${plural(specials, 'день', 'дня', 'дней')}` });

  // сон и самочувствие → как нагружаться сегодня
  const st = stateOf(t, uid), si = sleepInfo(sleep(t, uid), uid);
  const broken = st?.wellbeing === 'broken';
  const lowSleep = si && (si.verdict === 'short' || si.score < 50);
  if (dt !== 'sick') {
    if (broken) add('state_broken');
    else if (si && si.verdict === 'short') add('sleep_short', { h: dec(si.hours) });
    else if (si && si.score < 50) add('sleep_poor');
    else if (si && si.verdict === 'ok' && si.score >= 85 && sleep(t, uid).rise !== 'hard' && st?.wellbeing !== 'meh') add('sleep_great', { h: dec(si.hours) });
  }
  // «что-то болит» (самочувствие / жалоба в чате) - план дня уже подстроен (plan.adaptToday)
  const pains = stateOf(t, uid)?.pains || [];
  if (pains.length && dt !== 'sick') add('pain_today', { what: pains.map(p => ({ head: 'голова', back: 'спина', knees: 'колени', stomach: 'живот' })[p] || p).join(', ') });
  // дневной сон: короткий после недосыпа - хорошо; длинный или поздний сбивает ночь
  const napM = napMinutes(t, uid), lateNap = naps(t, uid).some(n => (toMin(n.to) ?? 0) >= 17 * 60);
  if (napM > 90 || (napM && lateNap)) add('nap_long', { m: napM });
  else if (napM >= 10 && si?.verdict === 'short') add('nap_good', { m: napM });

  // пропуск: сколько дней подряд до сегодня нет ни одной отметки
  if (start && start < t) {
    let gap = 0;
    for (let d = y; d >= start && gap < 60; d = addDays(d, -1)) {
      if (['log', 'food', 'sleep', 'state', 'activity'].some(k => recsOn(k, d, uid).length)) break;
      gap++;
    }
    if (gap >= 2) add('gap', { n: gap });
    else if (start <= y) {
      const ys = dayScore(y);
      if (ys.total && ys.done === ys.total) add('yesterday_perfect');
      else if (ys.pct < 50 && !yt) add('yesterday_bad', { pct: ys.pct, min: streakMin(t, uid) });
    }
  }

  const yw = activeWorkout(y, uid);
  if (yw && start <= y && !yw.data.done && workoutProgress(yw) < 0.5 && !['sick', 'rest', 'special'].includes(yt)) {
    add('workout_missed', { title: yw.data.title });
  }
  const tw = activeWorkout(t, uid);
  if (tw && !tw.data.done && dt !== 'sick' && dt !== 'rest' && !broken) {
    if ((lowSleep || st?.wellbeing === 'meh' || st?.soreness === 'strong') && (tw.data.variant || 'full') === 'full' && workoutProgress(tw) === 0) {
      add('workout_light', { title: tw.data.title });
    } else if (dt !== 'special') {
      add(hour >= 19 ? 'workout_late' : 'workout_today', { title: tw.data.title });
    }
  }

  if (hour >= 19 && s.pct < 50 && !easy) add('evening_low', { pct: s.pct });

  // питание сегодня: привычки и окно (в читмил и особые дни — молчим)
  if (!easy) {
    const hv = habitViolations(t, uid);
    if (hv.length) add('habit_' + hv[0].what, { time: hv[0].time || '' });
    // кофе ближе к вечеру - про сон, без привязки к цели «меньше кофе»
    const cp = cups(t, uid);
    if (cp.lastCoffee && (toMin(cp.lastCoffee) ?? 0) >= 16 * 60 && !hv.some(h => h.what === 'coffee')) add('coffee_late', { time: cp.lastCoffee });
    const fd = foodDay(t, uid);
    if (fd?.outside.length && !hv.some(h => h.what === 'late')) add('out_of_window', { time: fd.outside[fd.outside.length - 1] });
  }

  // недельный объём: с четверга напоминаем добрать
  if (weekday(t) >= 3 && dt !== 'sick') {
    const wa = weekActivity(t, uid);
    const n = Math.round(Math.min(wa.deficitMin, wa.behindMin) / 5) * 5;
    if (n >= 15) add('balance_deficit', { n });
  }

  // разгрузочная неделя (5-я, 10-я… неделя программы)
  if (tw && tw.data.week && tw.data.week % 5 === 0 && tw.data.source !== 'generated') add('deload');

  // записи задним числом, сделанные за последние сутки
  const nowMs = now.getTime();
  let back = 0;
  for (const k of ['food', 'sleep', 'state', 'activity', 'body']) {
    for (let i = 1; i <= 14; i++) for (const r of recsOn(k, addDays(t, -i), uid)) {
      if (r.data.entered_at && nowMs - r.data.entered_at < 36 * 3600e3 && isBackdatedRec(r)) back++;
    }
  }
  if (back) add('backdated', { n: back });

  const stk = streaks(uid);
  if (stk.current >= 3 && stk.current === stk.best) add('streak_record', { n: stk.current });
  else if (stk.current >= 3) add('streak', { n: stk.current });

  // перебор калорий и недобор белка вчера — теперь в motivation() вместе с остальным «вчера → сегодня»
  const dir = goalDir(uid);
  const pl = plateau(uid);
  const trendNote = { note: sourceNote('trend') };
  if (pl.weight || pl.measures) add('plateau', {}, trendNote);
  else {
    const tr = weightTrend(21);
    if (tr !== null && dir) {
      if (dir === 'down' && tr <= -0.15 || dir === 'up' && tr >= 0.1) add('weight_good', { delta: tr.toFixed(2).replace('.', ',') }, trendNote);
      else if (Math.abs(tr) < 0.1 && dir !== 'hold') add('weight_stall', {}, trendNote);
    }
  }
  if (pl.lifts) add('plateau_lifts', {}, trendNote);

  // «ты отстаёшь / ты впереди» - только при соревновании со счётом у обоих: без него пара просто видит прогресс
  for (const pa of competeSettings(uid).score ? store.partners().filter(x => partnerCompete(x.id).score) : []) {
    const pp = pctOf(t, pa.id);
    if (pp >= s.pct + 20 && !easy) add('partner_ahead', { partner: pa.name, pct: pp });
    else if (s.pct >= pp + 30 && hour >= 15) add('partner_behind', { partner: pa.name });
  }

  // «вчера → сегодня» (утро), одно вчерашнее + темп дня (день), «что ещё успеть» (вечер) — 1–3 самых важных
  const heavy = out.some(l => ['sick_day', 'state_broken', 'sleep_short', 'gap', 'special_day'].includes(l.event));
  const cand = motivation(uid, t, hour, now);
  let chosen;
  if (hour < 12) chosen = cand.filter(x => x.when !== 't').slice(0, heavy ? 2 : 3);
  else if (hour < 17) chosen = [...cand.filter(x => x.when === 'y').slice(0, 1), ...cand.filter(x => x.when !== 'y').slice(0, 1)];
  else chosen = cand.slice(0, heavy ? 2 : 3);
  chosen.forEach((x, i) => add(x.event, x.vars, { pri: i === 0 ? 34 : 47 + i / 10, ...(x.note ? { note: sourceNote(x.note) } : {}) }));

  // цели-показатели (goals.js): одна реплика в день — достигнутая или отстающая важнее
  if (hour < 17 || !chosen.length) {
    let gls = [];
    try { gls = G.lines?.(uid) || []; } catch { gls = []; }
    const rank = l => (Number(l.priority) || 2) + (l.event === 'goal_done' || l.event === 'goal_behind' ? 0 : 1.5);
    const g = gls.slice().sort((a, b) => rank(a) - rank(b))[0];
    if (g?.text) out.push({ event: g.event, mood: g.mood || 'info', text: g.text, metric: g.metric, note: sourceNote('goals'),
      pri: g.event === 'goal_done' ? 36 : g.event === 'goal_behind' ? 50 : 58 });
  }

  if (dt !== 'sick') out.push(...runExtras('lines', now, uid));
  if (!out.length) add(s.pct > 0 ? 'keep_going' : 'morning', { pct: s.pct });
  const sorted = out.map((l, i) => [l, i])
    .sort((a, b) => (a[0].pri ?? PRIORITY[a[0].event] ?? 50) - (b[0].pri ?? PRIORITY[b[0].event] ?? 50) || a[1] - b[1])
    .map(([{ pri, ...l }]) => l);
  return addressSome(sorted, 'lines', tone);
}

// ── инициативные сообщения тренера (чат) ──
const RULES = {
  sleep: {
    soft: ['Как спалось? Отметь время отбоя и подъёма - подстрою нагрузку на сегодня.',
           'Утро уже в разгаре, а про сон я ничего не знаю. Пара нажатий - и будет понятно, какой сегодня день.',
           'Расскажешь про ночь? Во сколько отбой, во сколько подъём, как проснулось. Это займёт полминуты.'],
    coach: ['Нет данных о сне. Внеси время отбоя и подъёма - от этого зависит сегодняшняя нагрузка.',
            'Сон не записан. Без него я планирую день наугад.',
            'Жду отчёт о сне: отбой, подъём, как засыпалось. От него зависит вариант тренировки.'],
    sergeant: ['Уже одиннадцать, а доклада о сне нет. Время отбоя, время подъёма - доложить!',
               'Сон не записан. Спал{|а} или нёс{|ла} караул - я должен знать.',
               'Боец, где отчёт о ночи? Без него к нагрузке не допускаю.'],
  },
  food: {
    soft: ['Дневник питания пока пустой. Запиши завтрак, пока помнишь, - потом будет сложнее.',
           'Время к обеду, а в дневнике ни строчки. Что было утром?'],
    coach: ['Ни одной записи еды за полдня. Внеси завтрак и обед - к вечеру всё забудется.',
            'Дневник питания пуст. Без записей я не вижу ни калорий, ни белка.'],
    sergeant: ['Полдня прошло, а в журнале питания пусто. Питаемся солнечным светом? Записать!',
               'Журнал питания чист, как плац после уборки. Так не бывает. Заполнить!'],
  },
  food_evening: {
    soft: ['Вечер, а записей еды маловато. Допиши, что было за день, - так картина будет честной.'],
    coach: ['За день записано меньше двух приёмов пищи. Допиши обед и ужин - без этого калории не посчитать.'],
    sergeant: ['Вечер, а в журнале питания одна строчка. Остальное съедено нелегально? Дописать!'],
  },
  state: {
    soft: ['Как самочувствие сегодня? Отметь одним нажатием - это поможет подобрать нагрузку.',
           'Как ты сегодня? Бодро, так себе, болит что-нибудь? Отметь - я подстроюсь.'],
    coach: ['Отметь самочувствие: общее состояние, мышцы, стресс. Десять секунд - и план точнее.',
            'Нет отметки самочувствия. От неё зависит, полная сегодня тренировка или облегчённая.'],
    sergeant: ['Доклад о самочувствии не получен. Бодр{|а}, разбит{|а}, болит - отметить!',
               'Самочувствие не отмечено. Я не гадалка, боец. Доложить.'],
  },
  activity_unclear: {
    soft: ['Вижу активность «{name}» на {min} мин, но не знаю, насколько было тяжело. Отметь интенсивность - посчитаю калории точнее.'],
    coach: ['«{name}», {min} мин - а интенсивность? Лёгкая, средняя или высокая: без неё калории и нагрузка считаются приблизительно.'],
    sergeant: ['«{name}» {min} мин - и всё? Какая интенсивность? Прогулочная или на износ? Уточнить!'],
  },
  measure: {
    soft: ['С последних замеров прошло {n} дн. Сантиметр и пять минут - и увидим, что меняется, даже когда весы стоят.'],
    coach: ['Замерам уже {n} дн. Пора обновить: талия, бёдра, руки. Сантиметр честнее весов.'],
    sergeant: ['Замеры {n} дней назад. Сантиметровую ленту в руки - и доложить обстановку по периметру.'],
  },
  measure_first: {
    soft: ['Давай сделаем первые замеры: талия, бёдра, руки. Через месяц будет с чем сравнить - это очень мотивирует.'],
    coach: ['Замеров ещё нет. Сними их сегодня - это точка отсчёта. Вес врёт, сантиметры - нет.'],
    sergeant: ['Замеров нет. Без точки отсчёта прогресс не докажешь. Лента, зеркало, цифры - выполнять!'],
  },
  water: {
    soft: ['Не забудь про воду - пока не отмечено ни одного стакана.'],
    coach: ['Воды сегодня ноль. Стакан сейчас, потом по стакану каждый час.'],
    sergeant: ['Ни одного стакана воды? Обезвоженный боец - небоеспособный боец. Пить!'],
  },
  weight: {
    soft: ['Сегодня день взвешивания. Утром, натощак - и запиши цифру, без переживаний.'],
    coach: ['Взвешивание: утром, натощак, после туалета. Запиши - тренд важнее одной цифры.'],
    sergeant: ['Контрольное взвешивание. На весы - и доложить. Без комментариев про «вчера был ужин».'],
  },
  workout: {
    soft: ['Тренировка «{title}» ещё впереди. Найдётся полчаса? Я верю, что найдётся.'],
    coach: ['Напоминание: «{title}» ещё не сделана. Запланируй время прямо сейчас.'],
    sergeant: ['«{title}» ждёт. Время пошло, боец.'],
  },
};

// похвала, когда снятое замечание (RESOLVABLE в chat.js) отмечено выполненным - помимо галочки «сделано»,
// короткая реплика тренера в чате, тем же тоном; ключей меньше, чем в RULES - для workout уже есть woPraise() при
// завершении тренировки в другом месте, второй раз хвалить не нужно
const RESOLVED = {
  sleep: {
    soft: ['Отметил{|а} сон - спасибо, учту это в нагрузке.'],
    coach: ['Сон записан. Учитываю при выборе нагрузки на сегодня.'],
    sergeant: ['Сон в отчёте. Хорошо, что не забыл{|а}.'],
  },
  state: {
    soft: ['Спасибо, что рассказал{|а} про самочувствие - подстрою план под это.'],
    coach: ['Самочувствие отмечено. Так и планирую точнее.'],
    sergeant: ['Доклад принят. Самочувствие в системе.'],
  },
  food: {
    soft: ['Записал{|а} первый приём пищи - отлично, так и продолжай.'],
    coach: ['Питание пошло в дневник. Хорошо.'],
    sergeant: ['Есть первая запись в журнале питания. Принято.'],
  },
  food_evening: {
    soft: ['Дописал{|а} остальные приёмы пищи - день теперь виден целиком.'],
    coach: ['Дневник питания дополнен - вижу день полностью.'],
    sergeant: ['Журнал питания дозаполнен. Хорошо.'],
  },
  water: {
    soft: ['Первый стакан воды есть - дальше пойдёт легче.'],
    coach: ['Вода пошла в счёт. Продолжай в течение дня.'],
    sergeant: ['Вода в отчёте. Не останавливайся.'],
  },
  weight: {
    soft: ['Взвесил{|а}ся - спасибо, вижу цифру.'],
    coach: ['Вес записан. Учитываю тренд.'],
    sergeant: ['Взвешивание выполнено. Принято.'],
  },
  measure: {
    soft: ['Обновил{|а} замеры - так виден прогресс, даже если весы стоят на месте.'],
    coach: ['Замеры обновлены. Хорошо, что не только вес.'],
    sergeant: ['Замеры в отчёте. Обстановка ясна.'],
  },
  activity_unclear: {
    soft: ['Уточнил{|а} интенсивность - теперь калории посчитаются точнее.'],
    coach: ['Интенсивность указана. Считаю точнее.'],
    sergeant: ['Уточнено. Принято к учёту.'],
  },
};
// текст-похвала для только что закрытого замечания (или null, если для этого правила её нет) - тон из профиля
export function resolvedPraise(rule) {
  const set = RESOLVED[rule];
  if (!set) return null;
  const tone = prof().tone || 'coach';
  return pick(set[tone] || set.coach, today() + rule + 'resolved', {});
}

// → [{ rule, text, mood }] — что тренеру стоит написать сейчас. Чат хранит их как chat:{uid}:{date}:{rule},
// поэтому каждое правило срабатывает не чаще раза в день.
export function ruleMessages(now = new Date()) {
  const uid = store.uid();
  if (!uid) return [];
  const p = prof(uid);
  if (!p.setup_done) return [];
  const tone = p.tone || 'coach';
  const t = ymd(now), hm = now.getHours() * 60 + now.getMinutes();
  const out = [];
  const add = (rule, key = rule, vars = {}, mood = 'info') => {
    const set = RULES[key][tone] || RULES[key].coach;
    out.push({ rule, text: pick(set, t + rule, vars), mood });
  };
  const rem = {};
  for (const r of p.reminders || []) if (r && r.kind) rem[r.kind] = r;
  // время правила: из напоминаний профиля (выключенное напоминание выключает и правило), иначе по умолчанию
  const at = (kind, def) => { const r = rem[kind]; if (r) return r.enabled === false ? null : toMin(r.time) ?? def; return def; };
  const due = (kind, def) => { const m = at(kind, def); return m !== null && m !== undefined && hm >= m; };
  const dt = dayType(t, uid);

  if (due('sleep', 11 * 60) && !sleep(t, uid)) add('sleep');

  const foods = recsOn('food', t, uid);
  const win = p.eating_window;
  let foodAt = 14 * 60;
  if (win?.enabled && toMin(win.from) !== null && toMin(win.from) > 11 * 60) foodAt = Math.min(toMin(win.from) + 3 * 60, 22 * 60);
  if (dt !== 'sick') {
    if (!foods.length && due('food', foodAt)) add('food');
    else if (hm >= 20 * 60 && at('food', foodAt) !== null && meals(t, uid) < 2) add('food_evening');
  }

  if (due('state', 12 * 60) && !stateOf(t, uid)) add('state');

  for (const d of [t, addDays(t, -1)]) {
    const r = recsOn('activity', d, uid).find(x => Number(x.data.minutes) > 0 && !x.data.intensity);
    if (r) {
      const acts = store.getMeta('activities', []) || [];
      const name = acts.find(a => a.id === r.data.type)?.name || r.data.type || 'активность';
      add('activity_unclear', 'activity_unclear', { name, min: r.data.minutes });
      break;
    }
  }

  if (due('measure', 10 * 60)) {
    const ms = measures(uid);
    if (ms.length) {
      const n = daysBetween(ms[ms.length - 1].date, t);
      if (n > 30) add('measure', 'measure', { n });
    } else {
      const f = firstDay(uid);
      if (f && daysBetween(f, t) >= 7) add('measure', 'measure_first');
    }
  }

  if (rem.water?.enabled !== false && rem.water && due('water', null)) {
    const w = items(uid).find(i => i.data.target_from === 'water');
    if (w && !(Number(logVal(t, w.id, uid)) > 0)) add('water');
  }
  if (rem.weight && due('weight', null) && !store.get(`body:${uid}:${t}`)?.data?.weight) add('weight');
  if (rem.workout && due('workout', null) && dt !== 'sick' && dt !== 'rest') {
    const w = activeWorkout(t, uid);
    if (w && !w.data.done && workoutProgress(w) < 1) add('workout', 'workout', { title: w.data.title });
  }
  out.push(...runExtras('rules', now, uid));
  // по имени — примерно каждое третье сообщение и не больше одного за раз, чтобы не звучало как перекличка
  const d = nameForms(uid);
  if (d.nom) {
    const proper = store.partners().map(x => cleanName(x.name)).filter(Boolean);
    const m = out.find(x => hash(t + x.rule + d.nom) % 3 === 0);
    if (m) {
      const h = hash(t + m.rule + d.nom);
      m.text = N.address(m.text, tone === 'soft' ? d.voc : d.nom, tone === 'sergeant' ? 'shout' : h % 2 ? 'tail' : 'lead', proper);
    }
  }
  return out;
}

// ════════════════ соревнование пары ════════════════
// Партнёр видит только публичные dsum/wsum. Поля соревнования публикуются, только пока
// profile.compete.enabled, и только те, что перечислены в profile.compete.show. Питание и вес — никогда.
export const COMPETE_CATS = [
  { key: 'xp', label: 'Опыт', unit: 'XP' },
  { key: 'steps', label: 'Шаги', unit: '' },
  { key: 'workouts', label: 'Тренировки', unit: '' },
  { key: 'activity', label: 'Активность', unit: 'мин' },
  { key: 'sleep', label: 'Сон', unit: 'ч' },
  { key: 'grade', label: 'Оценка недели', unit: '' },
  { key: 'streak', label: 'Серия', unit: 'дн.' },
];
const CKEYS = COMPETE_CATS.map(c => c.key);

// JSON без учёта порядка ключей — чтобы не переписывать запись, пришедшую с сервера в другом порядке
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function competeSettings(uid = store.uid()) {
  const c = prof(uid).compete;
  const show = Array.isArray(c?.show) ? CKEYS.filter(k => c.show.includes(k)) : [...CKEYS];
  // enabled - делиться прогрессом; score - соревнование со счётом очков (отдельная галка, по умолчанию выкл.)
  return { enabled: !!c?.enabled, score: !!c?.enabled && c?.score === true, show, touched: !!c };
}

function stepsOn(date, uid) {
  const it = items(uid).find(i => i.data.target_from === 'steps');
  return it ? Number(logVal(date, it.id, uid)) || 0 : 0;
}

function dsumCompete(date, uid) {
  const cp = competeSettings(uid);
  if (!cp.enabled) return cp.touched ? { compete: false } : {};
  const sh = new Set(cp.show), out = { compete: true, share: cp.show, duel: cp.score };
  if (sh.has('steps')) { const v = stepsOn(date, uid); if (v) out.steps = v; }
  if (sh.has('activity')) { const m = activityMinutes(date, uid).total; if (m) out.activity_min = m; }
  if (sh.has('sleep')) { const si = sleepInfo(sleep(date, uid), uid); if (si && !si.nap) out.sleep_h = Math.round(si.hours * 10) / 10; }
  return out;
}

// итоги недели по своим данным (для себя и для публикации в wsum)
function ownWeek(monday, uid) {
  return memo(`ow|${uid}|${monday}`, () => {
    const t = today();
    let xp = 0, steps = 0, workouts = 0, activity = 0, elapsed = 0;
    const sl = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      if (d > t) break;
      elapsed++;
      const s = dayScore(d, uid);
      xp += s.xp;
      if (s.workout === 'done') workouts++;
      steps += stepsOn(d, uid);
      activity += activityMinutes(d, uid).total;
      const si = sleepInfo(sleep(d, uid), uid);
      if (si && !si.nap) sl.push(si.hours);
    }
    return { xp, steps, workouts, activity, sleep: sl.length ? Math.round(avg(sl) * 10) / 10 : null, sleepN: sl.length, elapsed };
  });
}

function wsumCompete(monday, uid) {
  const cp = competeSettings(uid);
  if (!cp.enabled) return cp.touched ? { compete: false } : {};
  const w = ownWeek(monday, uid), sh = new Set(cp.show), out = { compete: true, share: cp.show, duel: cp.score };
  if (sh.has('steps')) out.steps_total = w.steps;
  if (sh.has('activity')) out.activity_min = w.activity;
  if (sh.has('workouts')) out.workouts_done = w.workouts;
  if (sh.has('sleep') && w.sleep !== null) { out.sleep_avg = w.sleep; out.sleep_n = w.sleepN; }
  if (sh.has('streak')) {
    // серию знаем только «на сейчас»: у прошлых недель остаётся значение, опубликованное в ту неделю
    const s = monday === mondayOf() ? streaks(uid).current : store.get(`ws:${uid}:${monday}`)?.data?.streak;
    if (s !== undefined && s !== null) out.streak = s;
  }
  return out;
}

// переопубликовать сводки за последние недели после включения/выключения соревнования или смены набора полей
export async function refreshCompete(weeks = 8) {
  const t = today(), from = addDays(mondayOf(t), -7 * weeks);
  for (let d = from; d <= t; d = addDays(d, 1)) await refreshDsum(d);
  for (let m = from; m <= t; m = addDays(m, 7)) await refreshWsum(m);
}

// с кем сравниваем на «Вместе»: выбранный на этом устройстве (meta together_pid), иначе первый
export function partner() {
  const ps = store.partners(), pick = store.getMeta('together_pid', null);
  return ps.find(p => p.id === pick) || ps[0] || null;
}

// включено ли соревнование у партнёра: по самой свежей его публичной сводке с полем compete
export function partnerCompete(pid = partner()?.id) {
  return memo(`pc|${pid}`, () => {
    if (!pid) return { enabled: false, score: false, share: [], known: false };
    let best = null;
    for (const kind of ['dsum', 'wsum']) {
      for (const r of store.list(kind, pid)) if (r.data && 'compete' in r.data && (!best || r.updated_at > best.updated_at)) best = r;
    }
    if (!best) return { enabled: false, score: false, share: [], known: false };
    const share = Array.isArray(best.data.share) ? CKEYS.filter(k => best.data.share.includes(k)) : [...CKEYS];
    return { enabled: best.data.compete === true, score: best.data.compete === true && best.data.duel === true, share, known: true };
  });
}

// значения категорий за неделю; null — нет данных
function weekVals(monday, uid) {
  return memo(`wv|${uid}|${monday}`, () => {
    const cur = monday === mondayOf();
    if (uid === store.uid()) {
      const w = ownWeek(monday, uid);
      const ws = weekSummary(monday, uid);
      const streak = cur ? streaks(uid).current : store.get(`ws:${uid}:${monday}`)?.data?.streak ?? null;
      return { xp: w.xp, steps: w.steps, workouts: w.workouts, activity: w.activity, sleep: w.sleep, sleepN: w.sleepN,
        grade: ws.score ?? null, streak, elapsed: w.elapsed };
    }
    let xp = 0, steps = 0, workouts = 0, activity = 0, any = false;
    const sl = [];
    for (let i = 0; i < 7; i++) {
      const ds = store.get(`ds:${uid}:${addDays(monday, i)}`)?.data;
      if (!ds) continue;
      any = true;
      xp += ds.xp || 0; steps += ds.steps || 0; activity += ds.activity_min || 0;
      if (ds.workout === 'done') workouts++;
      if (ds.sleep_h) sl.push(ds.sleep_h);
    }
    const ws = store.get(`ws:${uid}:${monday}`)?.data;
    return {
      xp: any ? xp : ws?.xp ?? 0,
      steps: ws?.steps_total ?? steps,
      workouts: ws?.workouts_done ?? workouts,
      activity: ws?.activity_min ?? activity,
      sleep: ws?.sleep_avg ?? (sl.length ? Math.round(avg(sl) * 10) / 10 : null),
      sleepN: ws?.sleep_n ?? sl.length,
      grade: ws?.score ?? null,
      streak: ws?.streak ?? (cur ? streaks(uid).current : null),
    };
  });
}

// сравнимое значение категории: сон — среднее, но не больше 9 ч и минимум 3 ночи (или все прошедшие дни)
function cmpVal(key, v, elapsed) {
  if (key === 'sleep') return v.sleep === null || v.sleepN < Math.min(3, Math.max(1, elapsed)) ? null : Math.min(9, v.sleep);
  return v[key] ?? null;
}

function jointGood(g1, g2, p1, p2) {
  if (g1 !== 'none' && g2 !== 'none') return g1 === 'good' && g2 === 'good';
  return p1 >= STREAK_MIN && p2 >= STREAK_MIN;
}

// дуэль недели → { state: 'no_partner'|'me_off'|'partner_off'|'ok', partner, monday, current, daysLeft, days, cats, score, shared }
export function duel(monday = mondayOf()) {
  monday = mondayOf(monday);
  return memo(`duel|${monday}`, () => {
    const p = partner(), uid = store.uid(), t = today();
    const me = competeSettings(uid), pc = partnerCompete(p?.id);
    const state = !p ? 'no_partner' : !me.enabled ? 'me_off' : !pc.enabled ? 'partner_off' : 'ok';
    const current = monday === mondayOf(t);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i), future = d > t;
      const mg = future ? { grade: 'none', score: null } : dayGrade(d, uid);
      const pg = future || !p ? { grade: 'none', score: null } : dayGrade(d, p.id);
      const pds = p ? store.get(`ds:${p.id}:${d}`)?.data : null;
      days.push({ date: d, future, today: d === t,
        me: { grade: mg.grade, score: mg.score, sleep: !!sleep(d, uid), pct: future ? 0 : dayScore(d, uid).pct },
        them: { grade: pg.grade, score: pg.score, sleep: !!pds?.sleep_h, pct: pds?.pct || 0 } });
    }
    // счёт очков - только если соревнование включили оба; иначе просто прогресс друг друга, без победителей
    const scoring = me.score && pc.score;
    const base = { state, partner: p, monday, current, daysLeft: current ? 6 - weekday(t) : 0, days, cats: [], score: { me: 0, them: 0 }, shared: [], scoring,
      myScore: me.score, theirScore: pc.score };
    if (state !== 'ok') return base;
    const shared = me.show.filter(k => pc.share.includes(k));
    const a = weekVals(monday, uid), b = weekVals(monday, p.id);
    const elapsed = current ? weekday(t) + 1 : 7;
    const score = { me: 0, them: 0 };
    const cats = COMPETE_CATS.filter(c => shared.includes(c.key)).map(c => {
      const x = cmpVal(c.key, a, elapsed), y = cmpVal(c.key, b, elapsed);
      let win = null;
      if (x !== null || y !== null) {
        const xv = x ?? 0, yv = y ?? 0;
        win = !xv && !yv ? null : xv === yv ? 'tie' : xv > yv ? 'me' : 'them';     // 0 и 0 — не игра
      }
      if (!scoring) win = null;
      if (win === 'me') score.me++;
      if (win === 'them') score.them++;
      return { ...c, me: c.key === 'sleep' ? a.sleep : a[c.key], them: c.key === 'sleep' ? b.sleep : b[c.key], win };
    });
    return { ...base, cats, score, shared, vals: { me: a, them: b } };
  });
}

const DUEL_LINES = {
  none: {
    soft: ['Счёт пока 0:0 - неделя только начинается. Отметьте первый день и поехали вместе!'],
    coach: ['0:0. Неделя открыта. Кто первым закроет день - тот и повёл.'],
    sergeant: ['Счёт 0:0, бойцы. Тишина на плацу. Кто первым отметится - тот и командует парадом!'],
  },
  lead: {
    soft: ['Ты впереди, {a}:{b}! Здорово. Только не забудь подбодрить: {partner} тоже старается. {Left}.',
           'Счёт {a}:{b} в твою пользу. Так держать - а вечером позови вторую половину на прогулку. {Left}.'],
    coach: ['Ведёшь {a}:{b}. Хорошо, но неделя не закончена - {left}. Держим темп.',
            '{a}:{b} в твою пользу. Отрыв надо закрепить: {left}.'],
    sergeant: ['{a}:{b} в твою пользу, боец. Не расслабляться! {Left} - противник не спит.',
               'Ведёшь {a}:{b}. Неплохо. Но медали выдают в воскресенье, а не в среду. {Left}.'],
  },
  behind: {
    soft: ['{partner} пока впереди, {b}:{a}. Ничего страшного - {left}, всё можно наверстать.',
           'Счёт {a}:{b}, {partner} чуть впереди. Небольшая прогулка сегодня - и разрыв сократится. {Left}.'],
    coach: ['{partner} ведёт {b}:{a}. {Left} - отыгрываемся: шаги, сон, тренировка по плану.',
            'Отстаёшь {a}:{b}. Выбери одну категорию и забери её. {Left}.'],
    sergeant: ['{partner} ведёт {b}:{a}. Позорище, боец - {left}, ещё можно отыграться!',
               'Счёт {a}:{b}, и не в твою пользу. Отставить нытьё - {left}. Марш отыгрываться!'],
  },
  tie: {
    soft: ['Ничья, {a}:{b}. Вы отличная команда! {Left}.'],
    coach: ['Ничья {a}:{b}. Всё решит последняя прямая - {left}.'],
    sergeant: ['{a}:{b}, ничья. Две равные слабости - это не результат. {Left}, решайте!'],
  },
  won: {
    soft: ['Неделя за тобой, {a}:{b}. Поздравляю! {partner} тоже большой молодец.'],
    coach: ['Неделя выиграна {a}:{b}. Хорошая работа. Следующая начинается с нуля.'],
    sergeant: ['Победа {a}:{b}. Благодарность от командования. Новая неделя - новый бой.'],
  },
  lost: {
    soft: ['Неделю выиграл{pa:|а} {partner}, {b}:{a}. Не беда - следующая будет твоей.'],
    coach: ['Неделя проиграна {a}:{b}. Разбери, где отстал{|а}, и забирай следующую.'],
    sergeant: ['Проигрыш {a}:{b}. Стыд и позор, боец. Реванш на следующей неделе!'],
  },
  draw: {
    soft: ['Неделя вничью, {a}:{b}. Идеальная пара!'],
    coach: ['Неделя вничью, {a}:{b}. Следующая решит.'],
    sergeant: ['Ничья {a}:{b}. Ни рыба ни мясо. На следующей неделе жду победителя!'],
  },
};

function leftPhrase(n) {
  if (n <= 0) return 'сегодня последний день';
  if (n === 1) return 'остался один день';
  return `до конца недели ${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

// реплика тренера о дуэли выбранным тоном
export function duelLine(d = duel()) {
  if (d.state !== 'ok' || !d.scoring) return '';
  const tone = prof().tone || 'coach';
  const { me: a, them: b } = d.score;
  const played = d.cats.some(c => c.win !== null);
  let ev;
  if (!played || (d.current && a === 0 && b === 0)) ev = d.current ? 'none' : 'draw';
  else if (d.current) ev = a > b ? 'lead' : a < b ? 'behind' : 'tie';
  else ev = a > b ? 'won' : a < b ? 'lost' : 'draw';
  const set = DUEL_LINES[ev][tone] || DUEL_LINES[ev].coach;
  const left = leftPhrase(d.daysLeft);
  return pick(set, d.monday + ev, { a, b, partner: d.partner?.name || 'партнёр', left, Left: left[0].toUpperCase() + left.slice(1) });
}

// короткая строка счёта для экрана «Сегодня»
export function duelScoreLine(d = duel()) {
  if (d.state !== 'ok') return '';
  if (!d.scoring) {
    const td = d.days.find(x => x.today);
    return td ? `Сегодня: ты ${td.me.pct} %, ${d.partner.name} ${td.them.pct} %` : '';
  }
  const { me: a, them: b } = d.score;
  if (!d.cats.some(c => c.win !== null)) return 'Счёт недели 0:0 - всё впереди';
  if (a > b) return `Счёт недели ${a}:${b} в твою пользу`;
  if (a < b) return `Счёт недели ${a}:${b} - ведёт ${d.partner.name}`;
  return `Счёт недели ${a}:${b} - ничья`;
}

// ── совместные задания недели (детерминированно по номеру недели) ──
const CHALLENGES = [
  { id: 'steps', need: 'steps', title: 'Вместе 120 000 шагов', target: 120000,
    calc: (a, b) => (a.steps || 0) + (b.steps || 0) },
  { id: 'workouts', need: 'workouts', title: 'Оба сделали по 3 тренировки', target: 6,
    calc: (a, b) => Math.min(3, a.workouts || 0) + Math.min(3, b.workouts || 0) },
  { id: 'good5', title: '5 дней оба на «хорошо»', target: 5,
    calc: (a, b, days) => days.filter(d => !d.future && d.me.grade === 'good' && d.them.grade === 'good').length },
  { id: 'sleep7', need: 'sleep', title: 'Никто не пропустил сон в журнале', target: 7,
    calc: (a, b, days) => days.filter(d => d.me.sleep && d.them.sleep).length },
  { id: 'activity', need: 'activity', title: 'Вместе 500 минут движения', target: 500,
    calc: (a, b) => (a.activity || 0) + (b.activity || 0) },
  { id: 'xp', need: 'xp', title: 'Вместе 1 200 XP', target: 1200,
    calc: (a, b) => (a.xp || 0) + (b.xp || 0) },
  { id: 'logged', title: 'Оба отмечались все 7 дней', target: 7,
    calc: (a, b, days) => days.filter(d => !d.future && d.me.grade !== 'none' && d.them.grade !== 'none').length },
];

export function challenges(monday = mondayOf()) {
  const d = duel(monday);
  if (d.state !== 'ok') return [];
  const wk = isoWeek(d.monday);
  const pool = CHALLENGES.filter(c => !c.need || d.shared.includes(c.need))
    .sort((x, y) => hash(`${wk}|${x.id}`) - hash(`${wk}|${y.id}`)).slice(0, 3);
  return pool.map(c => {
    const have = c.calc(d.vals.me, d.vals.them, d.days);
    return { id: c.id, title: c.title, have, target: c.target, frac: clamp(have / c.target, 0, 1), done: have >= c.target,
      code: `couple_${c.id}_${d.monday}` };
  });
}

// выдать совместные достижения за выполненные задания этой и прошлой недели (каждый пишет своё)
export async function awardCouple() {
  const uid = store.uid();
  if (!uid || duel().state !== 'ok') return [];
  const fresh = [];
  for (const m of [mondayOf(), addDays(mondayOf(), -7)]) {
    for (const c of challenges(m)) {
      if (!c.done) continue;
      const id = `ach:${uid}:${c.code}`;
      if (store.get(id)) continue;
      const title = `Вместе: ${c.title}`;
      await store.put('ach', id, { code: c.code, title, earned: today(), couple: true, monday: m }, today());
      fresh.push({ code: c.code, title });
    }
  }
  return fresh;
}

export function coupleAchievements(uid = store.uid()) {
  return store.list('ach', uid, r => r.data.couple || String(r.data.code || '').startsWith('couple_'))
    .sort((a, b) => (b.data.monday || b.date || '').localeCompare(a.data.monday || a.date || ''));
}

// итоги прошлых недель: кто сколько выиграл
export function duelHistory(n = 8) {
  const cur = mondayOf();
  const out = { me: 0, them: 0, draw: 0, weeks: [] };
  for (let i = 1; i <= n; i++) {
    const m = addDays(cur, -7 * i);
    const d = duel(m);
    if (d.state !== 'ok' || !d.cats.some(c => c.win !== null)) { out.weeks.push({ monday: m, result: null }); continue; }
    const r = d.score.me > d.score.them ? 'me' : d.score.me < d.score.them ? 'them' : 'draw';
    out[r]++;
    out.weeks.push({ monday: m, result: r, score: d.score });
  }
  return out;
}

// совместная серия: подряд дни, когда оба на «хорошо» (или оба ≥ 80 % чек-листа, если оценки нет)
export function jointStreak(pid = partner()?.id) {
  return memo(`js|${pid}`, () => {
    if (!pid) return { current: 0, best: 0 };
    const uid = store.uid(), t = today();
    let start = firstDay(uid);
    for (const r of store.list('dsum', pid)) if (r.date && (!start || r.date < start)) start = r.date;
    if (!start) return { current: 0, best: 0 };
    if (daysBetween(start, t) > 400) start = addDays(t, -400);
    let run = 0, best = 0;
    for (let d = start; d <= t; d = addDays(d, 1)) {
      const ok = jointGood(dayGrade(d, uid).grade, dayGrade(d, pid).grade, pctOf(d, uid), pctOf(d, pid));
      if (ok) { run++; best = Math.max(best, run); continue; }
      if (d === t) break;             // сегодняшний день ещё идёт
      run = 0;
    }
    return { current: run, best };
  });
}

// ── «Подбодрить»: последняя фраза лежит в своей dsum за сегодня (поле cheer) ──
export const CHEERS = {
  soft: ['Ты молодец, я горжусь тобой!', 'Давай вместе прогуляемся вечером?', 'Не сдавайся, у тебя всё получится', 'Обнимаю, держись!'],
  coach: ['Держи темп, осталось немного', 'Сегодня - твой день, закрывай на 100 %', 'Не сбавляй, догоняй!', 'Отличная работа, продолжай'],
  sergeant: ['Отставить лень! Марш на тренировку!', 'Шевелись, боец, я тебя обгоняю!', 'Ни шагу назад - только вперёд!', 'Вижу стараешься. Мало! Ещё!'],
};

export async function sendCheer(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const uid = store.uid();
  if (!text || !uid || !competeSettings(uid).enabled) return false;
  const d = today(), id = `ds:${uid}:${d}`;
  let base = store.get(id)?.data;
  if (!base) {
    base = { ...dayScore(d, uid) };
    const g = dayGrade(d, uid);
    base.grade = g.grade; base.score = g.score;
    Object.assign(base, dsumCompete(d, uid));
  }
  // cheer - последняя (для старых версий), cheers - все фразы дня: вторая за день не затирает первую
  const c = { text, at: Date.now() };
  await store.put('dsum', id, { ...base, cheer: c, cheers: [...(base.cheers || (base.cheer ? [base.cheer] : [])), c].slice(-10) }, d);
  return true;
}

// последняя фраза партнёра за 3 дня → { text, at } | null
export function partnerCheer(pid = partner()?.id) {
  if (!pid) return null;
  const from = addDays(today(), -3);
  let best = null;
  for (const r of store.list('dsum', pid, x => x.date >= from && x.data.cheer?.text)) {
    if (!best || r.data.cheer.at > best.at) best = r.data.cheer;
  }
  return best;
}
// «Спасибо» на фразу партнёра: отметка thanks[его id] = время фразы в своей публичной сводке дня - так она
// общая для всех своих устройств и видна отправителю (бейдж «спасибо» у его сообщения)
function thankedAt(pid, uid = store.uid()) {
  const from = addDays(today(), -4);
  let at = 0;
  for (const r of store.list('dsum', uid, x => x.date >= from)) at = Math.max(at, Number(r.data.thanks?.[pid]) || 0);
  return at;
}
// все фразы партнёра за 3 дня, от старых к новым
function partnerCheers(pid) {
  const from = addDays(today(), -3), seen = new Set(), out = [];
  for (const r of store.list('dsum', pid, x => x.date >= from && (x.data.cheers?.length || x.data.cheer?.text))) {
    for (const c of r.data.cheers || [r.data.cheer]) if (c?.text && !seen.has(c.at)) { seen.add(c.at); out.push(c); }
  }
  return out.sort((a, b) => a.at - b.at);
}
// непрочитанные (при включённом обмене прогрессом у себя): все после последнего «Спасибо» → последняя (+ list - все)
export function unseenCheer(pid = partner()?.id) {
  if (!competeSettings().enabled || !pid) return null;
  const seenAt = Math.max(store.getMeta(`cheer_seen:${pid}`, 0) || 0, thankedAt(pid));
  const list = partnerCheers(pid).filter(c => c.at > seenAt);
  return list.length ? { ...list[list.length - 1], list } : null;
}
// все непрочитанные фразы - от всех, с кем виден прогресс (людей может быть несколько)
export function unseenCheers() {
  return store.partners().map(p => ({ p, c: unseenCheer(p.id) })).filter(x => x.c);
}
export async function markCheerSeen(pid = partner()?.id) {
  const c = partnerCheer(pid);
  if (!c) return;
  await store.setMeta(`cheer_seen:${pid}`, c.at);
  const uid = store.uid(), d = today(), id = `ds:${uid}:${d}`;
  let base = store.get(id)?.data;
  if (!base) {
    base = { ...dayScore(d, uid) };
    const g = dayGrade(d, uid);
    base.grade = g.grade; base.score = g.score;
    Object.assign(base, dsumCompete(d, uid));
  }
  await store.put('dsum', id, { ...base, thanks: { ...(base.thanks || {}), [pid]: c.at } }, d);
}
// кто сказал «спасибо» на мою последнюю фразу → [имя, …]
export function cheerThanks(c = myCheer()) {
  if (!c) return [];
  const uid = store.uid();
  return store.partners().filter(p => thankedAt(uid, p.id) >= c.at).map(p => p.name);
}
// своя последняя фраза (чтобы показать «отправлено»)
export function myCheer() {
  const from = addDays(today(), -3);
  let best = null;
  for (const r of store.list('dsum', store.uid(), x => x.date >= from && x.data.cheer?.text)) {
    if (!best || r.data.cheer.at > best.at) best = r.data.cheer;
  }
  return best;
}
