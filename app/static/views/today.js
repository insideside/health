import * as store from '../store.js';
import * as PC from './pcopy.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import { S, ctxAttrs, plural, WD, esc, num, fmt, dayTitle, profile, CHECK, toast, ring, field, fval, input, textarea, openModal, closeModal, techHtml, dateNav, isBackdated, afterChange, glyph, MOOD_GLYPH, nowHM } from '../ui.js';
import { cheersBlock } from './together.js';
import * as FX from './fit.js';
import * as SPV from './supp.js';
import * as PF from '../prefs.js';

// Экран дня: тренер, сон, самочувствие, готовность, тип дня, модули, активности, чек-лист, партнёр.
// Функции coach.js / plan.js v2 вызываются через ?. — пока их нет, работают локальные запасные расчёты.
// Общие помощники (оценка дня, сон, активности) экспортируются в H — ими пользуются календарь, спорт и питание.

// ════════════════ общие помощники ════════════════

const warn = e => console.warn('[today]', e);
// вызвать функцию v2; если её нет, она вернула пусто или упала — запасной вариант
export function safe(fn, fb) {
  const alt = () => (typeof fb === 'function' ? fb() : fb);
  try { const v = fn(); return v ?? alt(); } catch (e) { warn(e); return alt(); }
}
const uidOr = uid => uid || store.uid();
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
const toMin = hm => { const [h, m] = String(hm || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
export const mondayOf = d => C.addDays(d, -((C.parse(d).getDay() + 6) % 7));
export const tone = () => profile().tone || 'coach';
const byTone = o => o[tone()] || o.coach;

export const SLEEP_Q = [
  ['fall', 'Засыпание', [['fast', 'сразу'], ['moderate', 'умеренно'], ['long', 'долго']]],
  ['continuity', 'Сон', [['solid', 'сплошной'], ['interrupted', 'прерывался']]],
  ['awakening', 'Пробуждение', [['self', 'сам'], ['alarm', 'по будильнику']]],
  ['rise', 'Подъём', [['fresh', 'бодро'], ['hard', 'тяжело']]],
];
export const STATE_Q = [
  ['wellbeing', 'Общее', [['great', 'отлично'], ['good', 'хорошо'], ['meh', 'так себе'], ['broken', 'разбит']]],
  ['soreness', 'Мышцы болят', [['none', 'нет'], ['light', 'слегка'], ['strong', 'сильно']]],
  ['stress', 'Стресс', [['low', 'спокойно'], ['mid', 'умеренный'], ['high', 'сильный']]],
  // для анализа: связь со сном, кофе, едой; отмечается за весь день (можно вечером)
  ['sleepy', 'Сонливость днём', [['none', 'нет'], ['some', 'временами'], ['strong', 'сильная']]],
];
// самочувствие — линейные значки вместо эмодзи (ui.MOOD_GLYPH)
export const STATE_EMOJI = MOOD_GLYPH;
// «что-то болит» сегодня: то же отмечает жалоба тренеру в чате; план дня подстраивается (plan.adaptToday)
export const PAINS = [['head', 'голова'], ['back', 'спина'], ['knees', 'колени'], ['stomach', 'живот']];
// отметить/снять боль и подстроить план дня → текст, что поменялось
export async function setPain(date, key, on) {
  const cur = stateRec(date)?.data.pains || [];
  const pains = on ? [...new Set([...cur, key])] : cur.filter(x => x !== key);
  await upsertDaily('state', 'state', date, { pains });
  if (!on || date !== C.today()) return '';
  const r = await P.adaptToday?.(date, { lighten: true }) || {};
  return [r.swapped ? `заменил ${r.swapped} ${plural(r.swapped, 'упражнение', 'упражнения', 'упражнений')}` : '', r.lightened ? 'облегчил тренировку' : ''].filter(Boolean).join(' и ');
}
export const DAY_TYPES = [['', 'обычный'], ['cheat', 'читмил'], ['special', 'особый день'], ['sick', 'болею'], ['rest', 'отдых']];
export const DAY_TYPE_NAME = Object.fromEntries(DAY_TYPES);
export const GRADE_NAME = { good: 'хороший день', ok: 'средний день', bad: 'слабый день', none: 'нет данных', live: 'день в процессе' };
// сегодняшний незаконченный день не клеймим «слабым» до вечера
export function shownGrade(date, g) {
  return date === C.today() && g.grade === 'bad' && new Date().getHours() < 21 ? { ...g, grade: 'live' } : g;
}
export const INTENSITY = [['low', 'лёгкая'], ['mid', 'средняя'], ['high', 'высокая']];
const VERDICT = { short: 'недосып', ok: 'норма', long: 'пересып' };

export const sleepRec = (date, uid) => store.get(`sleep:${uidOr(uid)}:${date}`);
export const stateRec = (date, uid) => store.get(`state:${uidOr(uid)}:${date}`);
export const dayTypeOf = (date, uid) => safe(() => C.dayType?.(date, uid), () => store.get(`daytype:${uidOr(uid)}:${date}`)?.data.type || null);
export const activitiesOf = (date, uid) => store.byDate('activity', date, uidOr(uid)).sort((a, b) => (a.data.entered_at || a.updated_at) - (b.data.entered_at || b.updated_at));

function sleepInfoLocal(d) {
  const b = toMin(d?.bed), w = toMin(d?.wake);
  if (b === null || w === null) return null;
  const hours = Math.round(((w - b + 1440) % 1440) / 6) / 10;
  const verdict = hours < 7 ? 'short' : hours > 9.5 ? 'long' : 'ok';
  let score = verdict === 'ok' ? 60 : verdict === 'long' ? 45 : Math.max(0, 60 - (7 - hours) * 20);
  score += { fast: 10, moderate: 5 }[d.fall] || 0;
  score += d.continuity === 'solid' ? 10 : 0;
  score += { self: 10, alarm: 4 }[d.awakening] || 0;
  score += d.rise === 'fresh' ? 10 : 0;
  return { hours, verdict, score: Math.round(Math.min(100, score)), label: VERDICT[verdict] };
}
// → { hours, verdict, score, label } | null
export function sleepInfo(rec) {
  if (!rec) return null;
  const d = rec.data || rec;
  if (!d.bed || !d.wake) return null;
  const arg = { ...d, data: d, id: rec.id, date: rec.date };
  const r = safe(() => C.sleepInfo?.(arg), () => sleepInfoLocal(d));
  if (r && !r.label) r.label = VERDICT[r.verdict] || '';
  return r;
}

// ── справочник активностей (запасной, пока нет /api/activities) ──
const MASSAGE_FIELDS = [
  { key: 'kind', label: 'Вид массажа', type: 'choice', options: [['wellness', 'оздоровительный'], ['therapeutic', 'лечебный'], ['sport', 'спортивный'], ['relax', 'расслабляющий'], ['lymph', 'лимфодренажный'], ['anticellulite', 'антицеллюлитный'], ['self', 'самомассаж'], ['device', 'массажёр']] },
  { key: 'zones', label: 'Зоны', type: 'multi', options: [['neck', 'шея'], ['shoulders', 'плечи'], ['back', 'спина'], ['lower_back', 'поясница'], ['arms', 'руки'], ['abs', 'живот'], ['glutes', 'ягодицы'], ['legs', 'ноги'], ['feet', 'стопы'], ['face', 'лицо'], ['full', 'всё тело']] },
  { key: 'by', label: 'Кто делал', type: 'choice', options: [['specialist', 'специалист'], ['partner', 'партнёр'], ['self', 'сам(а)'], ['device', 'массажёр']] },
  { key: 'pain', label: 'Болезненность', type: 'scale', options: [[0, 'нет'], [1, 'слегка'], [2, 'заметно'], [3, 'сильно']] },
  { key: 'before', label: 'Ощущения до', type: 'text' },
  { key: 'after', label: 'После', type: 'choice', options: [['better', 'лучше'], ['same', 'так же'], ['worse', 'хуже']] },
  { key: 'note', label: 'Заметки', type: 'text' },
];
const FALLBACK_ACTS = [
  ['walk_fast', 'Быстрая ходьба', [3, 4.3, 5], ['ходьба', 'прогулка']], ['running', 'Бег', [6, 8.3, 11], ['пробежка', 'джоггинг']],
  ['cycling', 'Велосипед', [4, 6.8, 10], ['вел', 'велик', 'велосипед']], ['swimming', 'Бассейн', [5, 7, 9.8], ['плавание', 'бассейн']],
  ['yoga', 'Йога', [2.5, 3, 4], ['растяжка']], ['pilates', 'Пилатес', [3, 3.8, 5], []], ['dance', 'Танцы', [4, 5.5, 7.8], ['танец']],
  ['aerial', 'Воздушная гимнастика', [4, 5.5, 7], ['полотна', 'кольцо', 'пилон']], ['snowboard', 'Сноуборд', [4.3, 5.3, 8], ['борд']],
  ['ski', 'Лыжи', [5, 7, 9], ['беговые лыжи', 'горные лыжи']], ['tennis', 'Теннис', [5, 7.3, 8], ['падел']],
  ['hiking', 'Поход', [5, 6, 7.8], ['хайкинг', 'горы']], ['gardening', 'Работа в саду', [3, 3.8, 5], ['дача', 'огород']],
  ['stretching', 'Растяжка', [2.3, 2.8, 3.5], ['стретчинг']],
].map(([id, name, m, aliases]) => ({ id, name, met: { low: m[0], mid: m[1], high: m[2] }, aliases }));
FALLBACK_ACTS.push({ id: 'massage', name: 'Массаж', met: { low: 1.3, mid: 1.5, high: 1.8 }, aliases: ['массаж', 'самомассаж', 'мфр'], load: 'recovery', fields: MASSAGE_FIELDS });

export function activityList() {
  const list = S.activities?.size ? [...S.activities.values()] : FALLBACK_ACTS;
  return list.map(a => (a.id === 'massage' && !a.fields?.length ? { ...a, fields: MASSAGE_FIELDS } : a));
}
// «Ваши» активности: как часто и как недавно отмечались за 90 дней + из профиля и любимое кардио
export function activityRank(uid = store.uid()) {
  const today = C.today(), since = C.addDays(today, -90), score = new Map();
  const bump = (id, v) => id && score.set(id, (score.get(id) || 0) + v);
  for (const r of store.list('activity', uid, r => r.date >= since && r.data.type)) bump(r.data.type, 1 + 10 / (C.daysBetween(r.date, today) + 5));
  const p = profile();
  for (const a of p.activities || []) bump(a.type, 3);
  for (const t of p.cardio?.likes || []) bump(t, 2);
  return score;
}
export const activityDef = type => activityList().find(a => a.id === type) || FALLBACK_ACTS.find(a => a.id === type) || null;
export const activityName = type => activityDef(type)?.name || type;

export function bodyWeight() {
  const w = safe(() => C.weights().slice(-1)[0]?.w, null);
  return Number(w || profile().weight) || 70;
}
export function activityKcal(type, minutes, intensity) {
  const w = bodyWeight();
  return Math.round(safe(() => P.activityKcal?.(type, minutes, intensity, w), () => {
    const met = activityDef(type)?.met?.[intensity] || 4;
    return met * w * (Number(minutes) || 0) / 60;
  }) || 0);
}
const optLabel = (f, v) => (f.options || []).find(([k]) => String(k) === String(v))?.[1] ?? v;
// подробности активности по полям справочника: [[подпись, значение]]
export function activityDetails(a) {
  const def = activityDef(a.type), det = a.details || {};
  const out = [];
  for (const f of def?.fields || []) {
    const v = det[f.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out.push([f.label, Array.isArray(v) ? v.map(x => optLabel(f, x)).join(', ') : f.type === 'text' ? v : optLabel(f, v)]);
  }
  return out;
}
export function activityLine(a) {
  const parts = [];
  if (a.start && a.end) parts.push(`<span class="mono">${esc(a.start)}–${esc(a.end)}</span>`);
  if (a.minutes) parts.push(`<span class="mono">${a.minutes} мин</span>`);
  if (a.distance_km) parts.push(`<span class="mono">${String(a.distance_km).replace('.', ',')} км</span>`);
  if (a.intensity) parts.push(`${INTENSITY.find(x => x[0] === a.intensity)?.[1] || ''}${a.intensity_from === 'hr' ? ' (по пульсу)' : ''}`);
  // пульс из «Здоровья»: средний и максимальный
  if (a.hr_avg) parts.push(`<span class="a-hr">${glyph('heart', { fill: true })} <span class="mono">${a.hr_avg}</span>${a.hr_max ? ` · макс <span class="mono">${a.hr_max}</span>` : ''}</span>`);
  if (a.kcal) parts.push(`<span class="mono">≈${num(a.kcal)} ккал</span>`);
  return parts.join(' · ');
}

// ── оценка дня ──
const STATE_SCORE = { great: 100, good: 80, meh: 50, broken: 25 };
function gradeFromScore(score) { return score >= 75 ? 'good' : score >= 45 ? 'ok' : 'bad'; }
function foodTotals(date, uid) {
  const t = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0, n: 0 };
  for (const r of store.byDate('food', date, uid)) {
    t.n++;
    const x = r.data.totals;
    if (x) for (const k of ['kcal', 'p', 'f', 'c', 'fiber']) t[k] += Number(x[k]) || 0;
  }
  return t;
}
export { foodTotals };
function gradeLocal(date, uid) {
  if (date > C.today()) return { score: 0, grade: 'none', parts: {} };
  if (uid !== store.uid()) {
    const ds = store.get(`ds:${uid}:${date}`)?.data;
    if (!ds) return { score: 0, grade: 'none', parts: {} };
    if (ds.grade) return { score: ds.score ?? ds.pct, grade: ds.grade, parts: {} };
    return ds.pct ? { score: ds.pct, grade: gradeFromScore(ds.pct), parts: {} } : { score: 0, grade: 'none', parts: {} };
  }
  const parts = {}, w = {};
  const s = C.dayScore(date, uid);
  if (s.total && (s.pct > 0 || date < C.today())) { parts.checklist = s.pct; w.checklist = 0.5; }
  const si = sleepInfo(sleepRec(date, uid));
  if (si) { parts.sleep = si.score; w.sleep = 0.2; }
  const st = stateRec(date, uid)?.data;
  if (st?.wellbeing) { parts.state = STATE_SCORE[st.wellbeing] ?? 60; w.state = 0.15; }
  const tg = C.target(uid), ft = foodTotals(date, uid);
  if (tg && ft.kcal > 0) {
    const dev = Math.abs(ft.kcal - tg.kcal) / tg.kcal;
    parts.food = Math.round(Math.max(0, 100 - dev * 200) * 0.7 + Math.min(100, ft.p / (tg.p || 1) * 100) * 0.3);
    w.food = 0.15;
  }
  const actMin = activitiesOf(date, uid).reduce((a, r) => a + (Number(r.data.minutes) || 0), 0);
  if (actMin) { parts.activity = Math.min(100, actMin / 30 * 100); w.activity = 0.1; }
  const tw = Object.values(w).reduce((a, b) => a + b, 0);
  if (!tw) return { score: 0, grade: 'none', parts };
  const score = Math.round(Object.keys(w).reduce((a, k) => a + parts[k] * w[k], 0) / tw);
  let grade = gradeFromScore(score);
  if (grade === 'bad' && ['sick', 'rest', 'special', 'cheat'].includes(dayTypeOf(date, uid))) grade = 'ok';
  return { score, grade, parts };
}
// → { score, grade: good|ok|bad|none, parts }
export function dayGrade(date, uid = store.uid()) {
  if (date > C.today()) return { score: 0, grade: 'none', parts: {} };
  const g = safe(() => C.dayGrade?.(date, uid), () => gradeLocal(date, uid));
  return g && g.grade ? g : gradeLocal(date, uid);
}

// ── готовность и вариант тренировки ──
function readinessLocal(date) {
  let score = 75;
  const reasons = [];
  const si = sleepInfo(sleepRec(date));
  if (si) {
    if (si.verdict === 'short') { score -= si.hours < 6 ? 25 : 15; reasons.push(`сон ${String(si.hours).replace('.', ',')} ч`); }
    if (si.score < 50) { score -= 10; reasons.push('сон неглубокий'); }
    if (si.score >= 80) score += 8;
  }
  const st = stateRec(date)?.data || {};
  score += { great: 12, good: 4, meh: -15, broken: -30 }[st.wellbeing] || 0;
  if (st.wellbeing === 'meh' || st.wellbeing === 'broken') reasons.push(`самочувствие «${STATE_Q[0][2].find(x => x[0] === st.wellbeing)[1]}»`);
  score += { light: -8, strong: -25 }[st.soreness] || 0;
  if (st.soreness === 'strong') reasons.push('мышцы сильно болят');
  score += { mid: -5, high: -15 }[st.stress] || 0;
  if (st.stress === 'high') reasons.push('высокий стресс');
  score = Math.max(0, Math.min(100, score));
  let level = score >= 80 ? 'high' : score >= 55 ? 'normal' : score >= 35 ? 'low' : 'rest';
  if (dayTypeOf(date) === 'sick') { level = 'rest'; reasons.unshift('день болезни'); }
  return { score, level, reasons };
}
export const readiness = date => safe(() => P.readiness?.(date), () => readinessLocal(date));
function variantLocal(date) {
  const r = readiness(date);
  if (dayTypeOf(date) === 'sick') return { variant: 'move', why: 'Болеешь - тренировку лучше перенести, а сегодня отдыхать.' };
  if (r.level === 'rest') return { variant: 'recovery', why: 'Организм просит передышки: лёгкая восстановительная сессия вместо полной.' };
  if (r.level === 'low') return { variant: 'light', why: 'Готовность снижена - сделай облегчённый вариант: меньше подходов, дольше отдых.' };
  return { variant: 'full', why: 'Готовность в норме - тренировка по плану.' };
}
export const workoutVariant = date => safe(() => P.workoutVariant?.(date), () => variantLocal(date));
export const READY_NAME = { high: 'высокая', normal: 'нормальная', low: 'сниженная', rest: 'нужен отдых' };
export const VARIANT_NAME = { full: 'полная', light: 'облегчённая', recovery: 'восстановление', move: 'перенос', moved: 'перенесена', deload: 'разгрузка' };

async function applyVariantLocal(date, variant) {
  const w = C.workout(date);
  if (!w) return;
  const d = structuredClone(w.data);
  const orig = d.orig_exercises || structuredClone(d.exercises);
  if (variant === 'move') {
    let to = null;
    for (let i = 1; i <= 3 && !to; i++) { const c = C.addDays(date, i); if (!C.workout(c)) to = c; }
    if (!to) { toast('Ближайшие три дня уже заняты - облегчи тренировку вместо переноса.'); return; }
    await store.put('workout', `wo:${store.uid()}:${to}`, { ...d, exercises: orig, orig_exercises: undefined, variant: 'full', moved_from: date }, to);
    await store.remove(w.id);
    toast(`Тренировка перенесена на ${fmt(to, { weekday: 'long', day: 'numeric' })}`);
    await afterChange(to);
    return;
  }
  d.orig_exercises = orig;
  if (variant === 'full') { d.exercises = orig; delete d.orig_exercises; }
  if (variant === 'light') d.exercises = orig.map((x, i) => ({ ...x, sets: Math.max(1, Math.round(x.sets * 0.67)), rest_sec: Math.round((x.rest_sec || 60) * 1.3), log: d.exercises[i]?.log }));
  if (variant === 'recovery') d.exercises = orig.slice(0, 3).map((x, i) => ({ ...x, sets: Math.max(1, Math.round(x.sets / 2)), note: 'Лёгкий вес, без отказа', log: d.exercises[i]?.log }));
  d.variant = variant;
  await store.put('workout', w.id, d, date);
}
export async function applyVariant(date, variant) {
  if (P.applyVariant) await P.applyVariant(date, variant);
  else await applyVariantLocal(date, variant);
  await afterChange(date);
  if (variant !== 'move') toast(variant === 'full' ? 'Вернули полную тренировку' : `Тренировка: ${VARIANT_NAME[variant]}`);
}

// баннер «как сегодня тренироваться»: готовность, предложенный вариант, кнопки
export function variantBlock(date, { compact = false } = {}) {
  const w = C.workout(date);
  const r = readiness(date);
  const hasInput = sleepRec(date) || stateRec(date);
  const badge = `<span class="a-ready ${r.level}"><span class="smallcaps">готовность</span> <b class="mono">${Math.round(r.score)}</b> · ${READY_NAME[r.level] || r.level}</span>`;
  if (!w || w.data.done) {
    if (compact || !hasInput) return '';
    return `<div class="a-readiness">${badge}${r.reasons?.length ? `<span class="note">${esc(r.reasons.join(', '))}</span>` : ''}</div>`;
  }
  const v = workoutVariant(date);
  const cur = w.data.variant || 'full';
  const btn = (k, l) => `<button class="btn ${cur === k ? 'on' : ''}" data-act="td-variant" data-v="${k}" data-date="${date}" ${cur === k ? 'aria-pressed="true"' : ''}>${l}</button>`;
  const suggest = v.variant && v.variant !== 'full' && cur === 'full';
  return `<div class="a-variant ${suggest ? 'suggest' : ''}">
    <div class="a-variant-head">${badge}${cur !== 'full' ? `<span class="chip">сейчас: ${VARIANT_NAME[cur] || cur}</span>` : ''}</div>
    ${hasInput || suggest ? `<p class="note">${esc(v.why || '')}${r.reasons?.length && !compact && !(v.why || '').includes(r.reasons[0]) ? ` <span class="muted">(${esc(r.reasons.join(', '))})</span>` : ''}</p>` : '<p class="note">Отметь сон и самочувствие - подстрою тренировку под состояние.</p>'}
    <div class="a-row-btns">${cur !== 'full' ? btn('full', 'Полная') : ''}${btn('light', 'Облегчить')}${btn('recovery', 'Восстановление')}<button class="btn quiet" data-act="td-variant" data-v="move" data-date="${date}">Перенести</button></div></div>`;
}

// выбор-«таблетки», которые сразу пишут запись (не через форму)
export function pick(act, cur, options, attrs = '', multi = false) {
  const on = k => multi ? (cur || []).map(String).includes(String(k)) : String(cur ?? '') === String(k);
  return `<div class="chips">${options.map(([k, l]) => `<button type="button" class="chip ${on(k) ? 'on' : ''}" aria-pressed="${on(k)}" data-act="${act}" data-v="${esc(k)}" ${attrs}>${esc(l)}</button>`).join('')}</div>`;
}
export const gradeDot = (g, extra = '') => `<span class="a-gdot g-${g || 'none'}" ${extra}></span>`;

// ════════════════ экран дня ════════════════

function viewDay(date) {
  const isToday = date === C.today();
  const prof = profile();
  const s = C.dayScore(date);
  const its = C.items();
  const groups = [['morning', 'Утро'], ['day', 'В течение дня']];
  const extra = [...new Set(its.map(i => i.data.group).filter(g => !groups.some(([k]) => k === g)))];
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  const g = shownGrade(date, dayGrade(date));
  const st = C.streaks();
  const streakMin = safe(() => C.streakMin?.(date), C.STREAK_MIN);
  // утренняя разминка — не строка-ссылка, а сама карточка прямо в блоке «Утро» (без дубля ниже)
  const rows = gr => its.filter(i => (i.data.group || 'day') === gr).map(i => i.data.type === 'routine'
    ? (date > C.today() ? `<p class="note a-tight">${esc(i.data.title)} соберётся в этот день.</p>` : moduleCard(i.data.module || 'morning', date))
    : itemRow(i, date)).join('') + (gr === 'day' ? planRows(date) : '');
  const future = date > C.today();
  return `
    <div class="head-row">
      <div><div class="kicker smallcaps">${isToday ? 'Сегодня · ' : ''}${esc(dayTitle(date))}</div>
        <h1>${isToday ? `${hello}${prof.name ? ', ' + esc(prof.name) : ''}` : esc(fmt(date, { day: 'numeric', month: 'long' }))}</h1></div>
      ${dateNav('day', date)}
    </div>
    ${backdatedNote(date)}
    ${isToday ? nextStep(prof) : ''}
    <div id="td-coach" data-date="${date}">${lastCoach = coachCard(date, g)}</div>
    ${isToday ? `<div class="t-cheers">${safe(() => cheersBlock(), '')}</div>` : ''}
    <div class="summary">${ring(s.pct, 72, 7, 'g-' + g.grade)}
      <div class="a-grow"><div class="stats"><span class="chip">${gradeDot(g.grade)}${g.grade === 'none' && isToday ? 'пока без отметок' : GRADE_NAME[g.grade]}${g.grade !== 'none' && g.score !== null ? ` · <span class="mono">${Math.round(g.score)}</span>` : ''}</span>
        <span class="chip">выполнено ${s.done} из ${s.total}</span>
        <span class="chip">серия ${st.current} дн.</span><span class="chip" data-dom="goal">+${s.xp} XP</span></div>
        <p class="note" style="margin:8px 0 0">${s.pct >= streakMin ? 'День засчитан в серию.' : `Для серии нужно ${streakMin} % чек-листа.`}
          <a class="link" href="#calendar/day/${date}">дневник дня</a></p></div>
    </div>
    ${future ? '' : macrosCard(date)}
    ${future ? '' : `<div class="a-two">${sleepCard(date)}${stateCard(date)}</div>`}
    ${future ? '' : variantBlock(date)}
    ${isToday ? outdoorRow(date) : ''}
    ${dayTypeCard(date)}
    ${[...groups, ...extra.map(x => [x, x])].map(([gr, title]) => {
      const r = rows(gr);
      return r ? `<div class="section"><div class="section-title"><span class="smallcaps">${esc(title)}</span></div><div class="checklist">${r}</div></div>` : '';
    }).join('')}
    ${!its.length ? '<p class="empty">Чек-лист пуст - добавьте пункты в профиле.</p>' : ''}
    ${modulesBlock(date)}
    ${future ? '' : safe(() => SPV.todayCard(date), '')}
    ${future ? '' : activitiesBlock(date)}
    ${partnersBlock(date)}`;
}

// БЖУ дня против норм: сколько съедено и сколько ещё добрать (подробно - на «Питании»)
function macrosCard(date) {
  const tg = C.target();
  if (!tg?.kcal) return '';
  const tot = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const e of store.byDate('food', date)) for (const k in tot) tot[k] += Number(e.data.totals?.[k]) || 0;
  const cheat = C.dayType(date) === 'cheat';
  const DOM = { kcal: 'food', p: 'prot', f: 'fat', c: 'carb' };
  const cell = (label, k, unit) => {
    const g = Number(tg[k]) || 0, v = tot[k], left = Math.round(g - v);
    const over = g && v > g * 1.05 && !cheat;
    return `<div class="macro" data-dom="${DOM[k]}"><div class="top"><span class="smallcaps muted">${label}</span><span class="mono">${num(v)} / ${num(g)}${unit}</span></div>
      <div class="groove ${over ? 'over' : ''}"><div class="fill" style="width:${g ? Math.min(100, v / g * 100) : 0}%"></div></div>
      <div class="note a-tight">${over ? `перебор ${num(-left)}${unit}` : left > 0 ? `осталось <span class="mono">${num(left)}</span>${unit}` : 'норма набрана'}</div></div>`;
  };
  return `<div class="section" data-dom="food"><div class="section-title"><span class="smallcaps">Питание</span>
      <a class="link note" href="#food/${date}">${cheat ? 'читмил - без подсчётов' : 'записать еду →'}</a></div>
    <div class="macros ${cheat ? 'a-muted' : ''}">${cell('Ккал', 'kcal', '')}${cell('Белки', 'p', ' г')}${cell('Жиры', 'f', ' г')}${cell('Углеводы', 'c', ' г')}</div></div>`;
}

// погода и кардио на сегодня + сигнал «упражнение не заходит» (views/fit.js)
function outdoorRow(date) {
  const sig = safe(() => FX.skipNotice(date), '');
  const w = safe(() => FX.weatherCard(date), ''), c = safe(() => FX.cardioCard(date), '');
  const row = w && c ? `<div class="a-two">${w}${c}</div>` : w || c ? `<div class="fx-one">${w || c}</div>` : '';
  return `${sig}${row}`;
}

// первые шаги нового пользователя: что сделать дальше — одной кнопкой, а не только словами тренера
function nextStep(prof) {
  if (!prof.setup_done) return `<div class="raised a-card a-next"><div class="smallcaps muted">Шаг 1 из 2</div>
    <p>Заполните профиль: пол, дату рождения, рост, вес и цели. По ним тренер посчитает нормы и составит план.</p>
    <div class="actions"><a class="btn" href="#profile">Заполнить профиль <span class="arrow">→</span></a></div></div>`;
  if (!store.list('target').length) return `<div class="raised a-card a-next"><div class="smallcaps muted">Шаг 2 из 2</div>
    <p>Профиль готов. Посчитаем нормы - калории, белок, воду, шаги и сон; без них чек-лист работает «на глаз».</p>
    <div class="actions"><button class="btn" data-act="norms">Посчитать нормы</button></div></div>`;
  return '';
}

function backdatedNote(date) {
  if (date >= C.today() || !isBackdated(date)) return '';
  return `<div class="notice a-backdated">${esc(byTone({
    soft: 'Это прошедший день. Дописать можно - но по свежей памяти выходит точнее, так что старайся отмечать в тот же день.',
    coach: 'Вносишь задним числом. Засчитаю, но точность страдает - отмечай в тот же день.',
    sergeant: 'Задним числом, боец? Приму. Но в следующий раз докладывать вовремя!',
  }))}</div>`;
}

// Карточка тренера обновляется сама, без перерисовки всего экрана: пока в поле ввода курсор, полная перерисовка
// ждёт (правка уже сохранена, а реплика старая), и часть реплик зависит от времени суток («вечером…»).
let lastCoach = '';
function refreshCoach() {
  const el = document.getElementById('td-coach');
  if (S.pressing) { setTimeout(refreshCoach, 400); return; }
  if (!el || document.hidden || el.contains(document.activeElement)) return;
  const date = el.dataset.date;
  const html = safe(() => coachCard(date, shownGrade(date, dayGrade(date))), null);
  if (html === null || html === lastCoach) return;
  lastCoach = html;
  el.innerHTML = html;
}
store.on(refreshCoach);
setInterval(refreshCoach, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCoach(); });

function coachCard(date, g) {
  const prof = profile();
  const who = C.TONE_NAMES[prof.tone || 'coach'];
  if (date === C.today()) {
    const ls = safe(() => C.lines(), []);
    if (!ls.length) return `<p class="note"><a class="link" href="#advice">Рекомендации тренера →</a></p>`;
    const [main, ...rest] = ls;
    // честная пометка: совет посчитан по статистике на устройстве (одна на карточку)
    const note = [main, ...rest.slice(0, 3)].find(l => l.note)?.note;
    // реплика может нести действие (например, «добавить комплекс в день») - кнопкой рядом с текстом
    const btn = l => (l.act ? ` <button class="btn quiet a-mini a-lact" data-act="${esc(l.act.act)}" ${Object.entries(l.act.data || {}).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}>${esc(l.act.label)}</button>` : '');
    return `<div class="coach inset ${main.mood || 'info'}"><div class="who smallcaps">${who}</div>
      <q>${esc(main.text)}</q>${btn(main)}${rest.length ? `<ul>${rest.slice(0, 3).map(l => `<li class="${l.mood || ''}">${esc(l.text)}${btn(l)}</li>`).join('')}</ul>` : ''}${note ? `<p class="note">${esc(note)}</p>` : ''}
      <p class="note a-tight"><a class="link" href="#advice">Все рекомендации тренера →</a></p></div>`;
  }
  if (date > C.today()) return `<div class="coach inset info"><div class="who smallcaps">${who}</div><q>${esc(byTone({
    soft: 'Этот день ещё впереди. Загляни сюда, когда он наступит.', coach: 'День ещё не наступил. План - на вкладке «Спорт».', sergeant: 'Будущее не отмечаем. Сначала переживи сегодня.' }))}</q></div>`;
  const txt = {
    good: { soft: 'Хороший был день - можно собой гордиться.', coach: 'Хороший день, так держать!', sergeant: 'Хороший день. Не зазнавайся.' },
    ok: { soft: 'Нормальный день: что-то получилось, что-то нет. Это тоже движение.', coach: 'Средний день. Есть что подтянуть.', sergeant: 'Середнячок. Мне нужны результаты, а не «нормально».' },
    bad: { soft: 'День вышел слабым. Бывает - главное, что следующий можно сделать лучше.', coach: 'Слабый день. Разберись, что помешало, и не повторяй.', sergeant: 'Провальный день. Записал в личное дело.' },
    none: { soft: 'За этот день почти ничего не отмечено.', coach: 'Данных за день нет - оценивать нечего.', sergeant: 'Пустой день. Где доклад, боец?' },
  }[g.grade] || {};
  return `<div class="coach inset ${g.grade === 'good' ? 'praise' : g.grade === 'bad' ? 'scold' : 'info'}"><div class="who smallcaps">${who} · итог дня</div><q>${esc(byTone(txt))}</q></div>`;
}

// ── сон ──
const fem = () => store.get(`profile:${store.uid()}`)?.data?.sex === 'f';
// часы и минуты отдельными полями (не <input type="time">, у которого нельзя сохранить одно окошко раньше
// другого - см. changes['td-sleep-time'])
function timeBox(label, k, val, date, aria) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(val || '');
  const a = `data-act="td-sleep-time" data-k="${k}" data-date="${date}"`;
  return `<label class="field"><span class="smallcaps">${label}</span><div class="a-hm">
    <input class="control mono" type="text" inputmode="numeric" maxlength="2" autocomplete="off" placeholder="чч" value="${m ? m[1] : ''}" ${a} data-part="h" aria-label="${esc(aria)}, часы">
    <span class="a-hm-sep">:</span>
    <input class="control mono" type="text" inputmode="numeric" maxlength="2" autocomplete="off" placeholder="мм" value="${m ? m[2] : ''}" ${a} data-part="m" aria-label="${esc(aria)}, минуты"></div></label>`;
}
// дневной сон: интервалы «с - до» (sleep.naps), отдельно от ночи; поля часы/минуты - как у ночного сна
function napBox(i, end, val, date, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(val || '');
  const a = `data-act="td-nap-time" data-i="${i}" data-end="${end}" data-date="${date}"`;
  return `<label class="a-napf"><span class="note">${label}</span><span class="a-hm">
    <input class="control mono" type="text" inputmode="numeric" maxlength="2" autocomplete="off" placeholder="чч" value="${m ? m[1] : ''}" ${a} data-part="h" aria-label="Дневной сон ${i + 1}, ${label}, часы">
    <span class="a-hm-sep">:</span>
    <input class="control mono" type="text" inputmode="numeric" maxlength="2" autocomplete="off" placeholder="мм" value="${m ? m[2] : ''}" ${a} data-part="m" aria-label="Дневной сон ${i + 1}, ${label}, минуты"></span></label>`;
}
function napsBlock(date) {
  if (date > C.today()) return '';
  const raw = sleepRec(date)?.data.naps || [];
  const mins = n => { const a = C.toMin(n.from), b = C.toMin(n.to); return a != null && b != null && b > a ? b - a : 0; };
  const total = raw.reduce((x, n) => x + mins(n), 0);
  return `<div class="a-naps"><div class="a-naps-h"><span class="smallcaps muted">Дневной сон</span>${total ? `<span class="note mono">${total} мин</span>` : ''}</div>
    ${raw.map((n, i) => `<div class="a-nap">${napBox(i, 'from', n.from, date, 'с')}${napBox(i, 'to', n.to, date, 'до')}
      <button class="btn quiet a-mini" data-act="td-nap-rm" data-i="${i}" data-date="${date}" aria-label="Убрать дневной сон ${i + 1}">${glyph('cross')}</button></div>`).join('')}
    <button class="btn quiet a-mini" data-act="td-nap-add" data-date="${date}">+ дневной сон</button>
    ${!raw.length ? `<p class="note a-tight">Если ${fem() ? 'спала' : 'спал'} днём - укажи время: тренер учтёт его в сне дня. Лучше всего 20-30 минут и до 17:00.</p>` : ''}</div>`;
}
function sleepCard(date) {
  const rec = sleepRec(date), d = rec?.data || {};
  const info = sleepInfo(rec);
  const complete = info && SLEEP_Q.every(([k]) => d[k]);
  const open = S.forms.td?.sleepOpen || !complete;
  const summary = info ? `<div class="a-sleep-res"><b class="mono">${String(info.hours).replace('.', ',')} ч</b>
      <span class="a-verdict v-${info.verdict}">${esc(info.label || VERDICT[info.verdict])}</span>
      <span class="note">качество <span class="mono">${Math.round(info.score)}</span>/100</span>
      ${info.snoozeMin ? `<span class="note">+ ${info.snoozeMin} мин дрёмы после будильника, в зачёт наполовину</span>` : ''}</div>` : '';
  const body = `<div class="a-times">
      ${timeBox(fem() ? 'Легла' : 'Лёг', 'bed', d.bed, date, `Во сколько ${fem() ? 'легла' : 'лёг'} спать`)}
      ${timeBox(fem() ? 'Встала' : 'Встал', 'wake', d.wake, date, `Во сколько ${fem() ? 'встала' : 'встал'}`)}</div>
    <div class="a-times a-alarm">
      ${timeBox('Первый будильник', 'alarm', d.alarm, date, 'Во сколько был первый будильник (если их было несколько)')}
      ${d.alarm ? `<div class="field"><span class="smallcaps">Будильников</span>${pick('td-sleep', String(d.alarms || ''), [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4+']], `data-k="alarms" data-date="${date}"`)}</div>`
        : '<p class="note a-tight">если будильников было несколько - время первого, чтобы тренер учёл дрёму</p>'}</div>
    ${(() => { const h = C.sleepHint?.(rec); return h ? `<p class="note a-tight ${h.warn ? 'warn' : ''}">${esc(h.text)}</p>` : ''; })()}
    ${SLEEP_Q.map(([k, label, opts]) => `<div class="a-q"><span class="smallcaps muted">${label}</span>${pick('td-sleep', d[k], opts, `data-k="${k}" data-date="${date}"`)}</div>`).join('')}`;
  return `<div class="raised a-card" id="sleep-card" data-dom="sleep">
    <div class="a-card-head"><span class="smallcaps">Как спалось?</span>
      ${complete ? `<button class="btn quiet a-mini" data-act="td-sleep-open" aria-expanded="${open}">${open ? 'Свернуть' : 'Изменить'}</button>` : ''}</div>
    ${summary}
    ${complete && !open ? `<p class="note a-tight">${esc(SLEEP_Q.map(([k, , o]) => o.find(x => x[0] === d[k])?.[1]).filter(Boolean).join(' · '))} · ${esc(d.bed)}–${esc(d.wake)}</p>` : body}
    ${napsBlock(date)}
  </div>`;
}

// ── самочувствие ──
function stateCard(date) {
  const d = stateRec(date)?.data || {};
  return `<div class="raised a-card" data-dom="mood">
    <div class="a-card-head"><span class="smallcaps">Самочувствие</span>${d.wellbeing ? `<span class="a-emoji" aria-hidden="true">${STATE_EMOJI[d.wellbeing]}</span>` : ''}</div>
    ${STATE_Q.map(([k, label, opts]) => `<div class="a-q"><span class="smallcaps muted">${label}</span>${pick('td-state', d[k], opts, `data-k="${k}" data-date="${date}"`)}</div>`).join('')}
    <div class="a-q"><span class="smallcaps muted">Что-то болит?</span><div class="chips">${PAINS.map(([k, l]) => {
      const on = (d.pains || []).includes(k);
      return `<button type="button" class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-act="td-pain" data-k="${k}" data-date="${date}">${l}</button>`;
    }).join('')}</div></div>
  </div>`;
}

// ── тип дня ──
function dayTypeCard(date) {
  const cur = dayTypeOf(date) || '';
  const pending = S.forms.td?.cheatAsk === date;
  let advice = '';
  if (pending || cur === 'cheat') {
    const a = safe(() => C.cheatAdvice?.(date), () => cheatAdviceLocal(date));
    if (pending) {
      advice = `<div class="notice">${esc(a.reason || 'Тренер против читмила сегодня.')}
        <div class="a-row-btns"><button class="btn" data-act="td-daytype" data-v="cheat" data-date="${date}" data-force="1">Всё равно читмил</button>
        <button class="btn quiet" data-act="td-cheat-cancel">Передумал${fem() ? "а" : ""}</button></div></div>`;
    } else {
      advice = `<p class="note">${esc(a.allowed ? (a.reason || 'Сегодня читмил - без подсчётов и без упрёков. Просто наслаждайся.') : `Тренер был против: ${a.reason || ''} Но решение твоё - сегодня без упрёков.`)}</p>`;
    }
  } else if (cur === 'sick') advice = '<p class="note">Выздоравливай. Тренировки сегодня не требуются, серия не сгорит.</p>';
  else if (cur === 'rest') advice = '<p class="note">День отдыха - восстановление тоже часть плана.</p>';
  else if (cur === 'special') advice = '<p class="note">Особый день: праздник, поездка или тяжёлый день. Тренер не ругает.</p>';
  return `<div class="section"><div class="section-title"><span class="smallcaps">Тип дня</span></div>
    ${pick('td-daytype', cur, DAY_TYPES, `data-date="${date}"`)}${advice}</div>`;
}
function cheatAdviceLocal(date) {
  const uid = store.uid();
  let cheats = 0;
  for (let i = 1; i <= 6; i++) if (store.get(`daytype:${uid}:${C.addDays(date, -i)}`)?.data.type === 'cheat') cheats++;
  if (cheats) return { allowed: false, reason: 'Читмил уже был на этой неделе - второй подряд тормозит прогресс.' };
  const y = dayGrade(C.addDays(date, -1));
  if (y.grade === 'bad') return { allowed: false, reason: 'Вчера день был слабым - читмил сегодня только закрепит откат.' };
  return { allowed: true, reason: 'Неделя идёт ровно - можно. Сегодня без подсчётов и без упрёков.' };
}

// ── модули: разминка, шея, осанка ──
// Все комплексы равноправны: выбираешь, сколько минут, - собирается под инвентарь из профиля.
// Утренняя разминка живёт в «Утро», здесь она - просто один из вариантов (ведёт туда).
const MODULES = {
  morning: { title: 'Утренняя разминка', mins: [5, 10, 15, 20], def: 10, tags: ['morning', 'warmup', 'mobility'] },
  workout: { title: 'Короткая тренировка', mins: [10, 15, 20, 30], def: 20, tags: ['strength', 'core'] },
  abs: { title: 'Пресс и кор', mins: [5, 10, 15], def: 10, tags: ['core'], zones: ['abs', 'sides'] },
  legs: { title: 'Ноги и ягодицы', mins: [10, 15, 20], def: 15, tags: ['strength'], zones: ['legs', 'glutes'] },
  arms: { title: 'Руки и плечи', mins: [10, 15, 20], def: 15, tags: ['strength'], zones: ['arms', 'shoulders'] },
  back: { title: 'Спина и грудь', mins: [10, 15, 20], def: 15, tags: ['strength', 'posture'], zones: ['back', 'chest'] },
  stretch: { title: 'Растяжка', mins: [5, 10, 15, 20], def: 10, tags: ['mobility', 'recovery'] },
  cardio: { title: 'Кардио дома', mins: [10, 15, 20], def: 15, tags: ['cardio'] },
  neck: { title: 'Шея и скулы', mins: [5, 10], def: 5, tags: ['neck', 'face'],
    note: 'Честно: упражнения укрепляют мышцы шеи и улучшают осанку, а жир под подбородком уходит только вместе с общим снижением жира.' },
  posture: { title: 'Осанка', mins: [5, 10, 15], def: 10, tags: ['posture', 'mobility'] },
};
// «Для бокса», «Для бега»…: комплекс в поддержку вида спорта (activities.json → support), модуль sport_<id>
function modDef(k) {
  if (MODULES[k]) return MODULES[k];
  const c = safe(() => P.sportModule?.(k), null);
  return c ? { title: c.title, mins: [10, 15, 20, 30], def: 15, tags: c.tags, zones: c.zones, note: c.why + (c.avoid ? ` ${c.avoid}` : ''), sport: true } : null;
}
const sportKeys = () => safe(() => (P.mySports?.() || []).map(a => `sport_${a.id}`), []);
const modKeys = () => [...Object.keys(MODULES), ...sportKeys()];
const modNote = k => (modDef(k)?.sport ? modDef(k).note : safe(() => P.MODULE_NOTES?.[k], MODULES[k]?.note || ''));
const routineId = (date, m) => `routine:${store.uid()}:${date}:${m}`;

function localPick(module, minutes, date, seed) {
  const m = modDef(module);
  const home = e => (e.place || []).includes('home') || (e.equipment || []).every(q => ['mat', 'chair'].includes(q));
  const fit = e => {
    if (m.zones && !(e.zones || []).some(z => m.zones.includes(z))) return false;
    if ((e.tags || []).some(t => m.tags.includes(t))) return true;
    if (module === 'morning') return e.morning || ['warmup', 'mobility'].includes(e.category);
    if (module === 'neck') return (e.muscles || []).some(x => /ше[яи]|подбород|лиц/i.test(x)) || /ше[яи]|подбород/i.test(e.name);
    if (module === 'posture') return (e.zones || []).some(z => ['back', 'shoulders', 'neck'].includes(z)) && (e.category === 'mobility' || (['pull_h', 'core_anti'].includes(e.pattern) && home(e)));
    return false;
  };
  const excl = safe(() => P.excludedFor?.(), new Set());
  const skip = PF.excludedIds(undefined, { place: 'home', module });
  let pool = [...S.exMap.values()].filter(e => fit(e) && home(e) && !skip.has(e.id) && !(e.contraindications || []).some(c => excl.has?.(c)));
  if (!pool.length) pool = [...S.exMap.values()].filter(e => e.morning);
  pool.sort((a, b) => hash(seed + a.id) - hash(seed + b.id));
  const n = Math.max(3, Math.min(pool.length, Math.round(minutes / 1.4)));
  return pool.slice(0, n).map(e => ({ id: e.id, amount: e.unit === 'seconds' ? `${minutes >= 15 ? 45 : 30} с` : `${minutes >= 15 ? 15 : 10} раз`, per_side: !!e.per_side }));
}

async function makeRoutine(module, minutes, date) {
  const m = modDef(module);
  if (!m) return;
  const prev = store.get(routineId(date, module))?.data;
  const seed = `${date}:${module}:${minutes}:${(prev?.seed_n || 0) + 1}`;
  let exercises = null;
  // и первая сборка, и пересборка - через генератор plan.js (лимит упражнений, исключения, закреплённые)
  if (P.makeRoutine) {
    try {
      const r = await P.makeRoutine(module, date, minutes, { rebuild: prev ? (prev.seed_n || 0) + 1 : 0 });
      if (r !== null && store.get(routineId(date, module))?.data.seed_n === (prev ? (prev.seed_n || 0) + 1 : 0)) return;
    } catch (e) { warn(e); }
  }
  if (P.pickExercises) exercises = safe(() => P.pickExercises({ tags: m.tags, minutes, place: 'home', date, seed }), null);
  if (!exercises?.length) exercises = localPick(module, minutes, date, seed);
  if (module === 'morning' && !prev) {
    const pins = pinnedOf().filter(id => S.exMap.has(id) && !PF.isExcluded(id, undefined, { place: 'home', module: 'morning' }) && !exercises.some(x => x.id === id));
    exercises = [...pins.map(id => { const e = S.exMap.get(id); return { id, amount: e.unit === 'seconds' ? '30 с' : '10 раз', per_side: !!e.per_side, pinned: true }; }), ...exercises];
  }
  if (!exercises.length) { toast('Каталог упражнений ещё не загружен'); return; }
  await store.put('routine', routineId(date, module), {
    module, minutes, title: `${m.title} · ${minutes} мин`, seed, seed_n: (prev?.seed_n || 0) + 1,
    exercises: exercises.map(x => ({ id: x.id, amount: x.amount, per_side: !!x.per_side, done: false })), done: false,
    entered_at: Date.now(),
  }, date);
}

const pinnedOf = () => profile().modules?.morning?.pinned || [];

async function setPinned(list) {
  const p = profile();
  await store.put('profile', `profile:${store.uid()}`, { ...p, modules: { ...(p.modules || {}), morning: { ...(p.modules?.morning || {}), enabled: true, pinned: list } } });
}

// Прежняя «Зарядка» (отдельные пункты-упражнения в чек-листе) → одна «Утренняя разминка»:
// упражнения становятся закреплёнными, пункт-разминка занимает их место. Ничего не теряется.
async function migrateMorning() {
  const its = C.items();
  if (its.some(i => i.data.type === 'routine')) return;
  const old = its.filter(i => i.data.group === 'morning' && i.data.exercise_id);
  const order = Math.min(0, ...its.map(i => i.data.order ?? 0)) - 1;
  await store.put('item', store.newId(), { title: 'Утренняя разминка', type: 'routine', module: 'morning', group: 'morning', order, active: true });
  if (old.length) {
    // отмеченные «не предлагать в разминке» не закрепляем - иначе они вернулись бы в разминку
    const keep = old.map(i => i.data.exercise_id).filter(id => !PF.isExcluded(id, undefined, { place: 'home', module: 'morning' }));
    await setPinned([...new Set([...pinnedOf(), ...keep])]);
    for (const i of old) await store.patch(i.id, { active: false, migrated: 'routine' });
  }
}

const MEAL_RU = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' };
// окно чашек дня: время каждой правится (сохраняется сразу), лишнюю можно удалить, новую - добавить с любым временем
function cupEditor(kind, date, focusNew = false) {
  const list = C.cupList(date, kind), c = C.CUPS[kind];
  const def = date === C.today() ? nowHM() : '';
  // кофе с молоком - молоко идёт в БЖУ дня отдельной записью (C.setCupMilk), как протеин у добавок
  const milkRow = r => kind !== 'coffee' ? '' : `<div class="a-cup-milk">
    <button type="button" class="chip ${r.data.milk ? 'on' : ''}" aria-pressed="${!!r.data.milk}" data-act="cup-milk-on" data-id="${r.id}" data-date="${date}">${r.data.milk ? 'с молоком' : '+ молоко'}</button>
    ${r.data.milk ? `<select class="control" data-act="cup-milk-type" data-id="${r.id}" data-date="${date}" aria-label="Какое молоко">
        ${C.MILK_TYPES.map(([k, , l]) => `<option value="${k}" ${r.data.milk.type === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <label class="a-cup-ml"><input class="control mono" type="number" inputmode="numeric" min="0" step="10" value="${r.data.milk.ml || 50}" data-act="cup-milk-ml" data-id="${r.id}" data-date="${date}" aria-label="Сколько молока, мл"> мл</label>
      ${C.milkMode() === 'meal' ? `<select class="control a-cup-meal" data-act="cup-milk-meal" data-id="${r.id}" data-date="${date}" aria-label="К какому приёму пищи отнести молоко">
        <option value="" ${r.data.milk.meal ? '' : 'selected'}>по времени: ${esc(MEAL_RU[C.milkMeal(null, r.data.time)] || '')}</option>
        ${Object.entries(MEAL_RU).map(([k, l]) => `<option value="${k}" ${r.data.milk.meal === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}` : ''}
  </div>`;
  openModal(`<div class="modal-head"><h2>${esc(c.title)} · ${esc(fmt(date, { day: 'numeric', month: 'long' }))}</h2></div><div class="modal-body">
    ${list.length ? `<div class="a-cups">${list.map((r, i) => `<div class="a-cup-line"><span class="smallcaps muted">${i + 1}</span>
      <input class="control" type="time" value="${esc(r.data.time || '')}" data-act="cup-time" data-id="${r.id}" data-date="${date}" aria-label="Время чашки ${i + 1}">
      <span class="chips a-cup-amt">${[[1, '1'], [0.5, '½']].map(([a, l]) => `<button type="button" class="chip ${C.cupAmount(r) === a ? 'on' : ''}" aria-pressed="${C.cupAmount(r) === a}" data-act="cup-amt" data-v="${a}" data-id="${r.id}" data-kind="${kind}" data-date="${date}" aria-label="${a === 1 ? 'Целая чашка' : 'Половина чашки'}">${l}</button>`).join('')}</span>
      <button class="btn quiet" data-act="cup-rm" data-id="${r.id}" data-kind="${kind}" data-date="${date}" aria-label="Удалить чашку ${i + 1}">${glyph('cross')}</button></div>${milkRow(r)}`).join('')}</div>`
      : '<p class="note">Пока ни одной чашки.</p>'}
    <div class="a-cup-line a-cup-new"><span class="smallcaps muted">+</span><input class="control" type="time" id="cup-new-time" value="${def}" aria-label="Время новой чашки">
      <button class="btn" data-act="cup-new" data-kind="${kind}" data-date="${date}">Добавить</button></div>
    <p class="note">После 14:00 кофеин заметнее мешает сну - тренер сравнит такие дни с ночами.${kind === 'coffee' ? (C.milkMode() === 'meal' ? ' Молоко в кофе считается в БЖУ дня и показывается в выбранном приёме пищи.' : ' Молоко в кофе считается в БЖУ дня, в приёмах пищи его нет (Профиль → Режим питания).') : ''}</p>
    </div><div class="modal-foot"><button class="btn solid" data-act="close">Готово</button></div>`);
  if (focusNew) document.getElementById('cup-new-time')?.focus();
}

// Чай и кофе - пункты-учёт под водой. Добавляются один раз (отметка в профиле), id постоянные:
// два устройства не создадут дублей, а удалённый человеком пункт не вернётся.
async function ensureCups() {
  const p = profile();
  if (p.cups_added) return;
  const its = C.items();
  const water = its.find(i => i.data.target_from === 'water');
  let order = (water?.data.order ?? its.length) + 0.1;
  for (const [kind, c] of Object.entries(C.CUPS)) {
    const id = C.cupItemId(kind);
    if (!store.get(id)) await store.put('item', id, { title: c.title, type: 'counter', group: 'day', target_from: kind, unit: c.unit, track: true, order, active: true }, null);
    order += 0.1;
  }
  const r = store.get(`profile:${store.uid()}`);
  if (r) await store.put('profile', r.id, { ...r.data, cups_added: true }, null);
}

// Курение/алкоголь - пункты-учёт только пока в профиле отмечена соответствующая цель («бросить курить» /
// «меньше алкоголя»). Сняли цель - пункт не удаляем (жалко историю отметок), просто гасим; поставили снова -
// включаем тот же обратно, а не создаём второй.
async function ensureHabitLogItems() {
  const its = C.items();
  for (const [kind, title, on] of [['smoke', 'Курение', C.smokingOn], ['alcohol', 'Алкоголь', C.alcoholOn]]) {
    const id = `${kind}_${store.uid()}`;
    const want = on(), cur = store.get(id);
    if (!cur) {
      if (!want) continue;
      const order = its.reduce((m, i) => Math.max(m, Number(i.data.order) || 0), 0) + 0.1;
      await store.put('item', id, { title, type: 'counter', group: 'day', target_from: kind, unit: 'случ.', track: true, order, active: true }, null);
    } else if (cur.data.active !== want) {
      await store.patch(id, { active: want });
    }
  }
}

// утренняя разминка на сегодня собирается сама, как только загружен каталог
async function ensureTodayRoutine() {
  if (profile().modules?.morning?.enabled === false || !S.exMap.size) return;
  if (!C.items().some(i => i.data.type === 'routine')) return;
  const date = C.today();
  if (store.get(routineId(date, 'morning'))) return;
  await makeRoutine('morning', Number(profile().modules?.morning?.minutes || MODULES.morning.def), date);
}

let bgBusy = false;
export async function background() {
  if (bgBusy || !store.me() || !store.get(`profile:${store.uid()}`)) return;
  bgBusy = true;
  // разминка не зависит от заполненного профиля: без перевода старые пункты-упражнения
  // остаются в чек-листе, и «Не предлагать» / «Заменить» на них не действуют
  try {
    // Сначала свежие данные с сервера: после сна устройства или в полночь другое устройство могло уже собрать
    // сегодняшнюю разминку - собрать свою параллельно значит получить две разные версии одной записи.
    if (store.state.online && Date.now() - (store.state.lastSync || 0) > 30000) { try { await store.sync(); } catch (e) { /* офлайн - соберём своё */ } }
    await migrateMorning();
    await ensureTodayRoutine();
    await P.pairSyncAll?.(C.today());
    // боль и травмы, отмеченные на другом устройстве или тренером в чате: противопоказанное сегодня - заменить
    if ((stateRec(C.today())?.data.pains || []).length || store.list('injury').some(r => !r.data.resolved)) await P.adaptToday?.(C.today());
    await C.syncHighlights?.();                      // вехи ленты без источника (сняли отметку, удалили) - убрать
    if (profile().setup_done) { await ensureCups(); await ensureHabitLogItems(); }
  } catch (e) { warn(e); } finally { bgBusy = false; }
}

function modulesBlock(date) {
  if (date > C.today()) return '';
  // утренняя разминка в «Утро» уже показана - здесь только ведём к ней
  const inMorning = C.items().some(i => i.data.type === 'routine' && (i.data.module || 'morning') === 'morning');
  const sel = S.forms.td?.mod_sel || null, hid = S.forms.td?.mod_hidden || [];
  // собранные комплексы открыты, пока их не свернули повторным нажатием на чип (сам комплекс и отметки остаются)
  const keys = modKeys();
  // собранный сегодня комплекс для спорта, которого уже нет в «моих», тоже показываем
  for (const r of store.byDate('routine', date)) if (String(r.data.module).startsWith('sport_') && !keys.includes(r.data.module)) keys.push(r.data.module);
  const made = keys.filter(k => modDef(k) && store.get(routineId(date, k)) && !(k === 'morning' && inMorning));
  const shown = [...made.filter(k => !hid.includes(k)), ...(sel && !made.includes(sel) && !hid.includes(sel) ? [sel] : [])];
  const chip = k => {
    const m = modDef(k), has = !!store.get(routineId(date, k)), on = shown.includes(k);
    return `<button type="button" class="chip a-modchip ${on ? 'on' : ''}" data-act="td-mod-sel" data-m="${k}" aria-pressed="${on}">${esc(m.title)}${has ? ` <span class="mono muted">${store.get(routineId(date, k)).data.minutes || ''} мин</span>` : ''}</button>`;
  };
  return `<div class="section" data-dom="train"><div class="section-title"><span class="smallcaps">Короткие комплексы</span><span class="note">по желанию · дома, под ваш инвентарь</span></div>
    <div class="chips a-modchips">${keys.filter(k => modDef(k)).map(chip).join('')}</div>
    ${shown.map(k => k === 'morning' && inMorning ? morningHint(date) : moduleCard(k, date)).join('')}</div>`;
}
// Тренер сам предлагает вставить комплекс в день - если сегодня ещё ничего такого нет.
// Одно предложение за раз: недобор недели → короткая тренировка (при низкой готовности - растяжка),
// далеко до нормы кардио → кардио дома, включённые в профиле осанка/шея недобраны за неделю → они.
export function suggestModule(now = new Date(), uid = store.uid()) {
  const date = C.today(), hour = now.getHours();
  if (hour < 7 || hour >= 21 || !S.exMap.size) return null;
  const dt = safe(() => C.dayType(date, uid), null);
  if (dt === 'sick' || dt === 'special') return null;
  const any = modKeys().some(k => k !== 'morning' && store.get(routineId(date, k)));
  if (any) return null;
  const w = C.workout(date, uid), hasWorkout = w && w.data.variant !== 'moved' && !['recovery'].includes(w.data.variant);
  const r = safe(() => P.readiness(date, uid), null);
  const low = r && (r.level === 'low' || r.level === 'rest');
  const wa = safe(() => C.weekActivity(date, uid), null);
  const round5 = n => Math.max(10, Math.min(30, Math.round(n / 5) * 5));
  const planned = safe(() => C.weekPlan(date, uid), []).some(e => e.key.startsWith('home:') && e.due);
  if (!hasWorkout && !planned && dt !== 'rest' && wa && wa.behindMin >= 15) {
    if (low) return { k: 'stretch', min: 10, why: `За неделю недобрано около ${wa.behindMin} мин, но готовность сегодня низкая. Лучше растяжка 10 минут, объём доберём, когда восстановишься.` };
    const min = round5(wa.behindMin / Math.max(1, wa.daysLeft + 1));
    return { k: 'workout', min, why: `За неделю недобрано около ${wa.behindMin} мин движения. Короткая тренировка на ${min} минут дома закроет часть.` };
  }
  const cw = safe(() => P.cardioWeek?.(date, uid), null), ct = safe(() => P.cardioTarget?.(uid), null);
  const actToday = store.byDate('activity', date, uid).length;
  if (!hasWorkout && !low && cw && ct && ct.minutes - cw.done >= 30 && !actToday && hour >= 12) {
    return { k: 'cardio', min: 15, why: `До недельной нормы кардио ${ct.minutes - cw.done} мин. Если на улицу не выходит - кардио дома на 15 минут.` };
  }
  // свой спорт: комплекс в поддержку раз в неделю - в день без тренировки и без самого спорта
  if (!hasWorkout && !low && hour >= 10) {
    for (const a of safe(() => P.mySports?.(uid) || [], [])) {
      const k = `sport_${a.id}`;
      if (store.byDate('activity', date, uid).some(r => r.data.type === a.id)) continue;
      const recent = [0, 1, 2, 3, 4, 5, 6].some(i => store.get(routineId(C.addDays(date, -i), k))?.data.exercises?.some(x => x.done));
      if (recent) continue;
      const d = modDef(k);
      if (d) return { k, min: 15, why: `${d.title}: ${d.note}` };
    }
  }
  // осанка и шея из профиля стоят в чек-листе по плану недели (C.weekPlan) - отдельно не предлагаем
  return null;
}
C.extend('lines', now => {
  const s = safe(() => suggestModule(now), null);
  if (!s) return [];
  return [{ event: 'module_suggest', mood: 'info', text: s.why, pri: 47,
    act: { act: 'td-mod-add', label: `Добавить: ${modDef(s.k).title.toLowerCase()}, ${s.min} мин`, data: { m: s.k, min: s.min, date: C.today() } } }];
});

function morningHint(date) {
  const has = store.get(routineId(date, 'morning'));
  return `<div class="raised a-card a-module"><div class="a-card-head"><b class="a-mtitle">Утренняя разминка</b></div>
    <p class="note a-tight">Она уже в блоке «Утро» выше${has ? '' : ' - соберётся под выбранное время'}.</p>
    <div class="a-row-btns"><button class="btn" data-act="td-goto-mod" data-m="morning" data-date="${date}">${has ? 'Открыть' : 'Собрать'} в «Утро»</button></div></div>`;
}

// раскрытые описания упражнений переживают перерисовку (синхронизация, отметка соседнего пункта)
const openTech = new Set();
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('a-tech') || !d.dataset.key) return;
  if (d.open) openTech.add(d.dataset.key); else openTech.delete(d.dataset.key);
}, true);

function moduleCard(k, date) {
  const m = modDef(k);
  if (!m) return '';
  const rec = store.get(routineId(date, k));
  const mods = profile().modules || {};
  if (!rec) {
    const cur = Number(S.forms.td?.['min_' + k] || mods[k]?.minutes || m.def);
    return `<div class="raised a-card a-module" id="mod-${k}" data-dom="train">
      <div class="a-card-head"><b class="a-mtitle">${m.title}</b></div>
      ${modNote(k) ? `<p class="note a-tight">${esc(modNote(k))}</p>` : ''}
      <div class="a-q"><span class="smallcaps muted">Минут</span>${pick('td-mod-min', cur, m.mins.map(n => [n, String(n)]), `data-m="${k}"`)}</div>
      <div class="a-row-btns"><button class="btn" data-act="td-mod-make" data-m="${k}" data-min="${cur}" data-date="${date}">Собрать на ${cur} мин</button></div></div>`;
  }
  const d = rec.data, exs = d.exercises || [];
  const done = exs.filter(x => x.done).length;
  const today = date === C.today(), started = done > 0;
  const pins = k === 'morning' ? pinnedOf() : [];
  // управление на виду: время и «пересобрать» сверху, «заменить» у каждого упражнения;
  // закрепить упражнение («каждый день») - внутри его описания, закреплённые помечены
  return `<div class="raised a-card a-module ${d.done ? 'is-done' : ''}" id="mod-${k}" data-dom="train">
    <div class="a-card-head"><b class="a-mtitle">${esc(m.title)}${d.minutes ? ` · ${d.minutes} мин` : ""}</b><span class="mono muted">${done}/${exs.length}</span></div>
    <div class="groove a-groove"><div class="fill" style="width:${exs.length ? done / exs.length * 100 : 0}%"></div></div>
    ${today ? `<div class="a-modbar"><span class="smallcaps muted">Время</span>
      ${m.mins.map(n => `<button class="chip ${n === d.minutes ? 'on' : ''}" aria-pressed="${n === d.minutes}" data-act="td-mod-make" data-m="${k}" data-min="${n}" data-date="${date}" aria-label="Пересобрать на ${n} минут">${n} мин</button>`).join('')}
      <button class="btn quiet a-mini" data-act="td-mod-redo" data-m="${k}" data-date="${date}" title="Другие упражнения на то же время${pins.length ? '; закреплённые останутся' : ''}">${glyph('rise')} Пересобрать</button></div>
      <div class="a-modbar"><span class="smallcaps muted">Инвентарь</span>
      ${P.GEAR.map(([g, l]) => `<button class="chip ${g === P.gearOf(k) ? 'on' : ''}" aria-pressed="${g === P.gearOf(k)}" data-act="td-mod-gear" data-m="${k}" data-g="${g}" data-date="${date}">${l}</button>`).join('')}</div>
      ${started ? '<p class="note a-tight">Пересборка начнёт комплекс заново - отметки сбросятся.</p>' : ''}
      ${pins.length && pins.length * 0.75 > (d.minutes || 10) * 0.7 ? `<div class="notice a-tight">Закреплено ${pins.length} ${pins.length < 5 ? 'упражнения' : 'упражнений'} - они есть в разминке всегда, и на ${d.minutes} мин тренеру почти не остаётся места.
        <div class="a-row-btns"><button class="btn quiet a-mini" data-act="td-unpin-all" data-date="${date}">Открепить все</button></div></div>` : ''}` : ''}
    ${modNote(k) ? `<p class="note a-tight">${esc(modNote(k))}</p>` : ''}
    ${safe(() => pairLine(k, d), '')}
    <div class="a-exlist">${exs.map((x, i) => {
      const e = S.exMap.get(x.id), pinned = pins.includes(x.id);
      const ctx = { kind: 'routine', module: k, date, i };
      return `<div class="a-ex ${x.done ? 'done' : ''}">
        <button class="tick ${x.done ? 'on' : ''}" data-act="td-rt-tick" data-m="${k}" data-i="${i}" data-date="${date}" aria-label="Отметить: ${esc(e?.name || x.id)}">${CHECK}</button>
        <details class="tech a-tech" data-key="${esc(`${date}|${k}|${i}|${x.id}`)}" ${openTech.has(`${date}|${k}|${i}|${x.id}`) ? 'open' : ''}><summary><span class="a-exname">${esc(e?.name || x.id)}</span> <span class="mono a-amount">${esc(x.amount || '')}${x.per_side ? ' на сторону' : ''}</span>${pinned ? ' <span class="chip a-pinned" title="Закреплено: будет в разминке каждый день">каждый день</span>' : ''}</summary>
          ${e ? techHtml(e, { key: `${date}|${k}|${i}|${x.id}|more` }) : '<p class="empty">Описание не загружено</p>'}
          ${k === 'morning' ? `<div class="a-pinrow"><button class="btn quiet a-mini ${pinned ? 'on' : ''}" data-act="td-pin" data-ex="${esc(x.id)}" aria-pressed="${pinned}">${pinned ? 'Не закреплять' : 'Делать каждый день'}</button>
            <span class="note">${pinned ? 'Сейчас это упражнение есть в разминке каждый день.' : 'Закреплённое упражнение будет в разминке каждый день, остальные тренер подбирает сам.'}</span></div>` : ''}
          ${today && !x.done ? FX.exActions(x.id, ctx) : ''}</details>
        ${today && !x.done ? `<button class="btn quiet a-mini a-swap" data-act="ex-swap-open" data-ex="${esc(x.id)}" ${ctxAttrs(ctx)} aria-label="Заменить: ${esc(e?.name || x.id)}">Заменить</button>` : '<span></span>'}</div>`;
    }).join('')}</div></div>`;
}

// ── план недели в чек-листе: шея, осанка, активности из профиля (C.weekPlan) ──
function planRows(date) {
  const list = safe(() => C.weekPlan(date), []);
  if (!list.length) return '';
  const future = date > C.today();
  return list.map(e => {
    const done = e.frac >= 1, cls = done ? 'on' : e.frac > 0 ? 'part' : '';
    const why = [e.why || '', !e.due ? 'сверх плана недели'
      : e.moved ? `перенесено: на неделе осталось ${e.left} из ${e.n}`
      : e.n >= 7 ? 'каждый день' : `${e.n} ${plural(e.n, 'раз', 'раза', 'раз')} в неделю · ${e.ideal.map(d => WD[d]).join(', ')}`].filter(Boolean).join(' · ');
    if (e.kind === 'module') {
      const m = modDef(e.module), rec = store.get(routineId(date, e.module));
      const min = rec?.data.minutes || e.minutes || m?.def;
      const go = future ? '' : `data-act="td-goto-mod" data-m="${e.module}" data-date="${date}"`;
      return `<div class="row ${done ? 'done' : ''}" data-dom="train">${future ? '<span></span>'
        : `<button class="tick ${cls}" ${go} aria-label="Открыть: ${esc(m?.title || e.module)}">${CHECK}</button>`}
        <div><div class="title">${esc(m?.title || e.module)}${min ? ` · ${min} мин` : ''}</div><div class="hint">${esc(why)}</div></div>
        ${future ? '<span></span>' : `<button class="go" ${go}>${rec ? 'упражнения' : 'собрать'} →</button>`}</div>`;
    }
    const name = e.name || activityName(e.type);
    const rec = store.byDate('activity', date).find(r => r.data.type === e.type);
    const open = future ? '' : rec ? `data-act="td-ac-edit" data-id="${rec.id}"`
      : `data-act="td-ac-open" data-date="${date}" data-type="${esc(e.type)}" data-min="${e.minutes || ''}" data-int="${esc(e.intensity || 'mid')}"`;
    return `<div class="row ${done ? 'done' : ''}" data-dom="move">${future ? '<span></span>'
      : `<button class="tick ${cls}" ${open} aria-label="${rec ? 'Изменить' : 'Записать'}: ${esc(name)}">${CHECK}</button>`}
      <div><div class="title">${esc(name)}${e.minutes ? ` · ${e.minutes} мин` : ''}</div><div class="hint">${esc(why)}</div></div>
      ${future ? '<span></span>' : `<button class="go" ${open}>${rec ? 'изменить' : 'записать'} →</button>`}</div>`;
  }).join('');
}

// ── активности ──
function activitiesBlock(date) {
  const list = activitiesOf(date);
  const prof = profile();
  const typical = (prof.activities || []).filter(a => a.type && (!a.weekdays?.length || a.weekdays.includes((C.parse(date).getDay() + 6) % 7)));
  const total = list.reduce((a, r) => a + (Number(r.data.minutes) || 0), 0);
  return `<div class="section" data-dom="move"><div class="section-title"><span class="smallcaps">Активности</span>${total ? `<span class="note"><span class="mono">${total}</span> мин за день</span>` : ''}</div>
    ${list.length ? `<div class="checklist">${list.map(r => activityRow(r)).join('')}</div>` : '<p class="empty a-tight">Сегодня пока без активностей. Велосипед, бассейн, танцы, массаж - всё считается.</p>'}
    <div class="a-row-btns"><button class="btn" data-act="td-ac-open" data-date="${date}">+ Активность</button>${PC.copyButton(date)}
      ${typical.slice(0, 4).map(a => `<button class="btn quiet" data-act="td-ac-open" data-date="${date}" data-type="${esc(a.type)}" data-min="${a.minutes || ''}" data-int="${a.intensity || ''}">${esc(activityName(a.type))}${a.minutes ? ` · ${a.minutes} мин` : ''}</button>`).join('')}</div></div>`;
}
function activityRow(r) {
  const a = r.data, det = activityDetails(a);
  return `<div class="a-act">
    <button class="a-act-main" data-act="td-ac-edit" data-id="${r.id}" aria-label="Изменить: ${esc(activityName(a.type))}">
      <span class="a-act-name">${esc(activityName(a.type))}</span><span class="a-act-meta">${activityLine(a)}${a.source === 'health' ? ' · из «Здоровья»' : ''}</span></button>
    ${det.length || a.note ? `<dl class="a-dl">${det.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${a.note ? `<dt>Заметка</dt><dd>${esc(a.note)}</dd>` : ''}</dl>` : ''}</div>`;
}

const ACT_HINT = { low: 'можно спокойно разговаривать', mid: 'дыхание учащено, говорить можно короткими фразами', high: 'говорить трудно, пульс высокий' };
function actModalHtml() {
  const f = S.forms.act || {};
  const def = f.type ? activityDef(f.type) : null;
  const q = (f.q || '').trim().toLowerCase();
  const list = activityList();
  const match = a => !q || [a.name, ...(a.aliases || [])].some(s => (' ' + String(s).toLowerCase()).includes(' ' + q));
  const hint = def?.intensity_hint;
  const hintText = f.intensity ? (typeof hint === 'string' ? hint : hint?.[f.intensity] || ACT_HINT[f.intensity]) : '';
  const fieldHtml = fd => {
    const key = 'd_' + fd.key, cur = f[key];
    let inner;
    if (fd.type === 'text') inner = `<textarea class="control" rows="2" data-form="act" data-key="${key}">${esc(cur || '')}</textarea>`;
    else inner = `<div class="chips">${(fd.options || (fd.type === 'scale' ? [[0, '0'], [1, '1'], [2, '2'], [3, '3']] : [])).map(([k, l]) => {
      const on = fd.type === 'multi' ? (cur || []).map(String).includes(String(k)) : cur !== undefined && cur !== null && String(cur) === String(k);
      return `<button type="button" class="chip ${on ? 'on' : ''}" aria-pressed="${on}" data-act="td-ac-f" data-k="${key}" data-v="${esc(k)}" data-multi="${fd.type === 'multi' ? 1 : ''}" data-num="${fd.type === 'scale' ? 1 : ''}">${esc(l)}</button>`;
    }).join('')}</div>`;
    return `<div class="field a-fld"><span class="smallcaps">${esc(fd.label)}</span>${inner}</div>`;
  };
  const kcal = def && f.minutes ? activityKcal(f.type, f.minutes, f.intensity || 'mid') : 0;
  return `<div class="modal-head"><div class="kicker smallcaps">Активность · ${esc(fmt(f.date, { day: 'numeric', month: 'long' }))}</div><h2>${def ? esc(def.name) : 'Что было?'}</h2></div>
    <div class="modal-body">
      ${def && !f.pickType ? `<div class="a-picked"><button type="button" class="btn quiet" data-act="td-ac-change">← Другая активность</button></div>` : `
      <input class="control a-search" id="act-q" type="search" placeholder="Найти: велосипед, бассейн, массаж…" value="${esc(f.q || '')}" aria-label="Поиск активности" autocomplete="off">
      ${(() => {
        const rank = activityRank(), mine = list.filter(a => rank.has(a.id)).sort((a, b) => rank.get(b.id) - rank.get(a.id)).slice(0, 10);
        const rest = list.filter(a => !mine.includes(a));
        const chip = a => `<button type="button" class="chip ${f.type === a.id ? 'on' : ''}" data-act="td-ac-type" data-v="${esc(a.id)}"
          data-search="${esc([a.name, ...(a.aliases || [])].join(' ').toLowerCase())}" ${match(a) || f.type === a.id ? '' : 'hidden'}>${esc(a.name)}</button>`;
        return mine.length ? `<div class="smallcaps muted a-types-h" ${q ? 'hidden' : ''}>Ваши</div><div class="chips a-types" data-dom="move">${mine.map(chip).join('')}</div>
          <div class="smallcaps muted a-types-h" ${q ? 'hidden' : ''}>Все</div><div class="chips a-types" data-dom="move">${rest.map(chip).join('')}</div>`
          : `<div class="chips a-types" data-dom="move">${list.map(chip).join('')}</div>`;
      })()}
      <p class="note a-noresults" ${list.some(match) ? 'hidden' : ''}>Ничего не нашлось - выберите похожее по нагрузке: например, «Растяжка» или «Ходьба».</p>`}
      ${def ? `<div class="a-actform" data-dom="move">
        <div class="a-times">${field('Минут', input('act', 'minutes', f.minutes, 'type="number" inputmode="numeric" min="1" max="600"'))}
          <div class="field"><span class="smallcaps">Ккал</span><div class="a-kcal mono">${kcal ? '≈ ' + num(kcal) : '-'}</div></div></div>
        <div class="field a-fld"><span class="smallcaps">Интенсивность</span><div class="chips">${INTENSITY.map(([k, l]) =>
          `<button type="button" class="chip ${f.intensity === k ? 'on' : ''}" aria-pressed="${f.intensity === k}" data-act="td-ac-f" data-k="intensity" data-v="${k}">${l}</button>`).join('')}</div>
          ${hintText ? `<span class="note">${esc(hintText)}</span>` : ''}</div>
        ${(def.fields || []).filter(fd => fd.key !== 'note').map(fieldHtml).join('')}
        <div class="field a-fld"><span class="smallcaps">Заметка</span>${textarea('act', 'note', f.note, 'rows="2" placeholder="как прошло"')}</div>
      </div>` : ''}
    </div>
    <div class="modal-foot">${f.id ? `<button class="btn danger" data-act="td-ac-del" data-id="${f.id}">Удалить</button>` : ''}
      <button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="td-ac-save" ${def ? '' : 'disabled'}>Сохранить</button></div>`;
}
function actModal() {
  const body = document.querySelector('#modal .modal-body');
  const y = body ? body.scrollTop : 0;
  openModal(actModalHtml());
  const nb = document.querySelector('#modal .modal-body');
  if (nb) nb.scrollTop = y;
}
// поиск по видам активности без перерисовки (фокус остаётся в поле)
document.addEventListener('input', e => {
  if (e.target.id !== 'act-q') return;
  const q = e.target.value.trim().toLowerCase();
  (S.forms.act ||= {}).q = e.target.value;
  let any = false;
  document.querySelectorAll('#modal .a-types [data-search]').forEach(b => {
    // по началу слов: «мма» - это ММА, а не «хаммам»
    const ok = !q || (' ' + b.dataset.search).includes(' ' + q) || b.classList.contains('on');
    b.hidden = !ok; any = any || ok;
  });
  const nr = document.querySelector('#modal .a-noresults');
  if (nr) nr.hidden = any;
  document.querySelectorAll('#modal .a-types-h').forEach(h => { h.hidden = !!q; });
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'act-q' && e.key === 'Enter') {
    e.preventDefault();
    const first = document.querySelector('#modal .a-types [data-search]:not([hidden])');
    if (first) first.click();
  }
});

// ── чек-лист (как в v1) ──
// цвет галочки — по смыслу пункта (accents.css); простые «да/нет» остаются без домена
function domAttr(d) {
  const dom = d.type === 'routine' || d.type === 'workout' ? 'train' : d.type === 'food' ? 'food'
    : d.target_from === 'water' ? 'water' : d.target_from === 'steps' ? 'move' : d.track ? 'food' : '';
  return dom ? ` data-dom="${dom}"` : '';
}
function itemRow(it, date) {
  const d = it.data, p = C.progress(it, date);
  if (!p.applies) {
    if (d.type === 'workout') {
      const planned = store.list('workout').some(w => w.date >= C.today()) || store.list('program').length;
      return planned ? `<div class="row" data-dom="train"><span></span><div><div class="title">${esc(d.title)}</div><div class="hint">сегодня день отдыха</div></div>
      <a class="go" href="#program">план →</a></div>`
        : `<div class="row" data-dom="train"><span></span><div><div class="title">${esc(d.title)}</div><div class="hint">программы ещё нет</div></div>
      <a class="go" href="#program">составить →</a></div>`;
    }
    return '';
  }
  const done = p.frac >= 1;
  const da = domAttr(d);
  const tick = (act = '') => `<button class="tick ${done ? 'on' : p.frac > 0 ? 'part' : ''}" ${act} aria-label="Отметить: ${esc(d.title)}">${CHECK}</button>`;
  // у пунктов, которые отмечаются не галочкой (шаги, еда, тренировка), кружок ведёт туда, где их заполняют
  const tickGo = (href, label) => `<a class="tick ${done ? 'on' : p.frac > 0 ? 'part' : ''}" href="${href}" aria-label="${esc(label)}">${CHECK}</a>`;
  const attrs = `data-item="${it.id}" data-date="${date}"`;
  const title = d.exercise_id && S.exMap.has(d.exercise_id)
    ? `<button data-act="tech" data-ex="${d.exercise_id}">${esc(d.title)}</button>` : esc(d.title);

  if (d.type === 'routine') {
    const m = d.module || 'morning';
    const hint = p.rec ? `упражнений ${p.value} из ${p.target} · ${p.rec.data.minutes || ''} мин` : 'соберётся на сегодня сама - под ваше время';
    return `<div class="row ${done ? 'done' : ''}"${da}><button class="tick ${done ? 'on' : p.frac > 0 ? 'part' : ''}" data-act="td-goto-mod" data-m="${m}" data-date="${date}" aria-label="Открыть: ${esc(d.title)}">${CHECK}</button>
      <div><div class="title">${esc(d.title)}</div><div class="hint">${esc(hint)}</div></div>
      <button class="go" data-act="td-goto-mod" data-m="${m}" data-date="${date}">${p.rec ? 'открыть' : 'собрать'} →</button></div>`;
  }
  if (d.type === 'bool') {
    return `<div class="row ${done ? 'done' : ''}"${da}>${tick(`data-act="toggle" ${attrs}`)}
      <div><div class="title">${title}</div>${d.hint ? `<div class="hint">${esc(d.hint)}</div>` : ''}</div><span></span></div>`;
  }
  if (d.type === 'counter' && d.track && (d.target_from === 'smoke' || d.target_from === 'alcohol')) {
    // курение/алкоголь: только у тех, кто отметил цель в профиле - каждый случай отдельной записью, без даты
    // с точностью до минуты (важно само событие, не время), «−» убирает последнюю запись за день
    const kind = d.target_from;
    const list = kind === 'smoke' ? C.smokeList(date) : C.alcoholList(date);
    const label = kind === 'smoke' ? C.smokeLabel : C.alcoholLabel;
    const free = kind === 'smoke' ? C.smokeFreeDays() : C.alcoholFreeDays();
    const hint = list.length ? list.map(r => label(r.data.type)).join(', ')
      : free != null ? `${free} ${plural(free, 'день', 'дня', 'дней')} без записей` : 'отмечайте каждый случай - тренер отследит прогресс';
    const ka = `data-kind="${kind}" data-date="${date}"`;
    return `<div class="row a-cup"${da}><span></span><div class="a-cup-t"><span class="title">${esc(d.title)}</span><span class="hint">${esc(hint)}</span></div>
      <div class="stepper"><button data-act="log-del-last" ${ka} aria-label="Убрать последнюю запись: ${esc(d.title)}" ${list.length ? '' : 'disabled'}>−</button>
        <span class="val">${list.length}</span><button data-act="log-add" ${ka} aria-label="Записать: ${esc(d.title)}">+</button></div></div>`;
  }
  if (d.type === 'counter' && d.track) {
    // учёт, а не задача: без галочки и цели. Каждая чашка со своим временем - для анализа сна
    const kind = d.target_from, list = C.cupList(date, kind), v = list.reduce((a, r) => a + C.cupAmount(r), 0);
    const times = list.filter(r => r.data.time).map(r => r.data.time + (C.cupAmount(r) < 1 ? ' (½)' : ''));
    const hint = v ? (times.length <= 4 ? times.join(', ') : `последняя в ${times[times.length - 1]}`) : 'отмечайте каждую чашку - тренер сравнит со сном';
    const ka = `data-kind="${kind}" data-date="${date}"`;
    return `<div class="row a-cup"${da}><button class="a-cup-g" data-act="cup-edit" ${ka} aria-label="Чашки: ${esc(d.title)}, изменить время">${glyph('cup')}</button>
      <button class="a-cup-t" data-act="cup-edit" ${ka}><span class="title">${esc(d.title)}</span><span class="hint">${esc(hint)}${v ? ' · изменить' : ''}</span></button>
      <div class="stepper"><button data-act="cup-del-last" ${ka} aria-label="Убрать последнюю: ${esc(d.title)}" ${v ? '' : 'disabled'}>−</button>
        <span class="val">${C.cupNum(v)}</span><button data-act="cup-add" ${ka} aria-label="Ещё чашка: ${esc(d.title)}">+</button></div></div>`;
  }
  if (d.type === 'counter') {
    // вода - и по полстакана: «½» заполняет стакан наполовину, второй «½» - целиком
    const water = d.target_from === 'water', v = Number(p.value) || 0;
    const glasses = water && p.target <= 16
      ? `<div class="glasses">${Array.from({ length: p.target }, (_, i) => `<i class="${i + 1 <= v ? 'on' : i < v ? 'half' : ''}"></i>`).join('')}</div>` : '';
    return `<div class="row ${done ? 'done' : ''}"${da}>${tick(`data-act="inc" data-d="1" ${attrs}`)}
      <div><div class="title">${esc(d.title)}</div>${glasses || `<div class="hint">цель ${p.target} ${esc(d.unit || '')}</div>`}</div>
      <div class="stepper"><button data-act="inc" data-d="-1" ${attrs} aria-label="Меньше${water && v % 1 ? ' на полстакана' : ''}">−</button>
        <span class="val">${water ? C.glassNum(v) : p.value}/${p.target}</span><button data-act="inc" data-d="1" ${attrs} aria-label="Больше">+</button>${water ? `<button class="half" data-act="inc" data-d="0.5" ${attrs} aria-label="Полстакана">½</button>` : ''}</div></div>`;
  }
  if (d.type === 'number') {
    return `<div class="row ${done ? 'done' : ''}"${da}>${tick(`data-act="focus-num" data-item="${it.id}"`)}
      <div><div class="title">${esc(d.title)}</div><div class="hint">цель ${num(p.target)} ${esc(d.unit || '')}</div></div>
      <input class="control num-in" type="number" inputmode="numeric" min="0" placeholder="0" value="${p.value || ''}" data-act="setnum" ${attrs} aria-label="${esc(d.title)}"></div>`;
  }
  if (d.type === 'workout') {
    const w = p.value, total = w.data.exercises.reduce((a, x) => a + x.sets, 0);
    const doneSets = w.data.exercises.reduce((a, x) => a + (x.log || []).filter(s => s?.done).length, 0);
    const v = w.data.variant && w.data.variant !== 'full' ? ` · ${VARIANT_NAME[w.data.variant] || ''}` : '';
    return `<div class="row ${done ? 'done' : ''}"${da}>${tickGo(`#workout/${date}`, `Открыть тренировку: ${w.data.title}`)}
      <div><div class="title">${esc(w.data.title)}</div><div class="hint">${w.data.done ? 'тренировка завершена' : `подходов ${doneSets} из ${total}`}${v}</div></div>
      <a class="go" href="#workout/${date}">открыть →</a></div>`;
  }
  if (d.type === 'food') {
    return `<div class="row ${done ? 'done' : ''}"${da}>${tickGo(`#food/${date}`, 'Записать еду')}
      <div><div class="title">${esc(d.title)}</div><div class="hint">${dayTypeOf(date) === 'cheat' ? 'читмил - сегодня без подсчётов' : `записано приёмов пищи: ${p.value} из ${p.target}`}</div></div>
      <a class="go" href="#food/${date}">записать →</a></div>`;
  }
  return '';
}

// лента вех группы (item 15): агрегированно - тип, подпись, минуты, без подробностей (что съедено, какие
// именно упражнения); видна, только если есть общая группа - store.groups() пуст, если групп нет вовсе
function groupFeedBlock() {
  if (!store.groups().length) return '';
  const items = C.groupHighlights(1).slice(0, 8);
  if (!items.length) return '<p class="note a-tight">В группе сегодня пока не отмечено активности.</p>';
  return `<div class="a-quick"><span class="smallcaps muted">Активность группы сегодня</span>
    <ul class="a-hlfeed">${items.map(h => `<li><b>${esc(h.name)}</b> - ${esc(h.label || h.type)}${h.minutes ? ` · ${h.minutes} мин` : ''}</li>`).join('')}</ul></div>`;
}

// ── партнёр ──
function partnersBlock(date) {
  const ps = store.partners();
  if (!ps.length) return '';
  const streakMin = safe(() => C.streakMin?.(date), C.STREAK_MIN);
  return `<div class="section"><div class="section-title"><span class="smallcaps">Вместе</span></div>
    ${ps.map(p => {
      const pct = C.pctOf(date, p.id), mine = C.pctOf(date, store.uid()), st = C.streaks(p.id);
      const ds = store.get(`ds:${p.id}:${date}`)?.data;
      const pg = dayGrade(date, p.id), mg = dayGrade(date);
      const both = (pg.grade !== 'none' && mg.grade !== 'none') ? (pg.grade === 'good' && mg.grade === 'good') : (pct >= streakMin && mine >= streakMin);
      return `<div class="raised card partner">${ring(pct, 48, 5, 'sm g-' + pg.grade)}
        <div class="ell"><div class="name">${esc(p.name)} ${pg.grade !== 'none' ? `<span class="a-gtag g-${pg.grade}">${GRADE_NAME[pg.grade]}</span>` : ''}</div>
        <div class="note">${ds ? `${ds.done} из ${ds.total} пунктов` : 'пока без отметок'}${ds?.workout === 'done' ? ' · тренировка сделана' : ''} · серия ${st.current} дн.</div></div>
        ${both ? '<span class="chip">оба в строю</span>' : ''}</div>`;
    }).join('')}${duelBlock(date)}${groupFeedBlock()}</div>`;
}

// соревнование пары: полученная поддержка и счёт недели (если соревнование включено у обоих)
function duelBlock(date) {
  if (date !== C.today()) return '';
  const d = safe(() => C.duel?.(), null);
  const line = d?.state === 'ok' ? safe(() => C.duelScoreLine(d), '') : '';
  return `${line ? `<div class="t-duel-line"><span class="note ell">${esc(line)}</span><a class="link" href="#together">вместе →</a></div>` : ''}`;
}

// общий комплекс с партнёром: с кем, что последнее он поменял
function pairLine(k, d) {
  const pa = P.pairPartner?.(k);
  if (!pa) return '';
  const ins = esc(C.nameForms?.(pa.id)?.ins || pa.name);
  return `<p class="note a-tight a-pair">Общий комплекс с ${ins}: замена и пересборка - сразу у обоих.${d.pair_note ? ` <b>${esc(d.pair_note)}.</b>` : ''}</p>`;
}

// ════════════════ запись ════════════════

async function setLog(itemId, date, v) {
  await store.put('log', C.logId(date, itemId), { v }, date);
  await afterChange(date);
}
// оценка сна - через пару секунд после последней правки: время подъёма часто вводят раньше будильника,
// и «пересып» сразу после него был бы неверным
let praiseTimer = null;
function praiseLater(date) {
  clearTimeout(praiseTimer);
  praiseTimer = setTimeout(() => { const rec = sleepRec(date); if (rec?.data.bed && rec.data.wake) sleepPraise(sleepInfo(rec)); }, 2500);
}
async function upsertDaily(kind, prefix, date, fields) {
  const id = `${prefix}:${store.uid()}:${date}`;
  const cur = store.get(id);
  await store.put(kind, id, { ...(cur?.data || { entered_at: Date.now() }), ...fields }, date);
  await afterChange(date);
}

function sleepPraise(info) {
  if (!info) return;
  const f = profile().sex === 'f';
  if (info.verdict === 'nap') return toast(byTone({ soft: 'Дневной сон записан - иногда это лучшее, что можно сделать.', coach: 'Дневной сон записан. В ночную статистику не идёт.', sergeant: 'Тихий час засчитан. Ночь - отдельно.' }));
  const t = info.verdict === 'short'
    ? byTone({ soft: 'Недосып - сегодня без рекордов, береги себя.', coach: 'Недосып. Тренировку подстрою, а вечером - лечь пораньше.', sergeant: 'Недосып, боец! Сегодня щадящий режим, вечером - отбой вовремя.' })
    : info.verdict === 'long' ? byTone({ soft: 'Долгий сон - организму, видимо, было нужно.', coach: 'Пересып. Бывает, но держи режим.', sergeant: `Проспал${f ? 'а' : ''} полдня? Режим, боец!` })
      : byTone({ soft: `Выспал${f ? 'ась' : 'ся'} - отличное начало дня.`, coach: 'Сон в норме. Работаем.', sergeant: `Выспал${f ? 'ась' : 'ся'}. Значит, отговорок нет.` });
  toast(t);
}

// курение/алкоголь: тип отмечается сразу по нажатию - без отдельного шага «сохранить»
function logTypeModal(kind, date) {
  const opts = kind === 'smoke' ? C.smokeTypesOf() : C.ALCOHOL_TYPES;
  const title = kind === 'smoke' ? 'Что закурил' : 'Что выпил';
  openModal(`<div class="modal-head"><h2>${esc(title)}</h2></div>
    <div class="modal-body"><div class="chips">${opts.map(([k, l]) => `<button type="button" class="chip" data-act="log-type" data-kind="${kind}" data-date="${date}" data-type="${k}">${esc(l)}</button>`).join('')}</div></div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button></div>`);
}

function openActivity(date, preset = {}) {
  S.forms.act = { date, q: '', intensity: 'mid', ...preset };
  actModal();
  setTimeout(() => { if (!preset.type) document.getElementById('act-q')?.focus(); }, 30);
}

export const actions = {
  'focus-num': el => { const i = document.querySelector(`input.num-in[data-item="${el.dataset.item}"]`); if (i) { i.focus(); i.select?.(); } },
  toggle: async el => {
    const { item, date } = el.dataset;
    await setLog(item, date, !C.logVal(date, item));
  },
  // чай и кофе: каждая чашка - запись drink со временем. Сегодня «+» ставит текущее время,
  // за прошлый день сразу открывает окно, где время вводится
  'cup-add': async el => {
    const { kind, date } = el.dataset;
    if (date !== C.today()) return cupEditor(kind, date, true);
    await store.put('drink', store.newId(), { kind, time: nowHM(), created: Date.now() }, date);
    await afterChange(date);
    toast(`${C.CUPS[kind].title} в ${nowHM()} - время можно поправить, нажав на строку`, 3000);
  },
  'cup-del-last': async el => {
    const { kind, date } = el.dataset;
    const last = C.cupList(date, kind).sort((a, b) => (a.data.created || 0) - (b.data.created || 0)).pop();
    if (last) { await store.remove(last.id); await afterChange(date); }
  },
  'cup-edit': el => cupEditor(el.dataset.kind, el.dataset.date),
  // курение/алкоголь: «+» сразу спрашивает тип (без него не понять, что считать); «−» убирает последнюю запись дня
  'log-add': el => logTypeModal(el.dataset.kind, el.dataset.date),
  'log-type': async el => {
    const { kind, date, type } = el.dataset;
    closeModal();
    await store.put(kind, store.newId(), { type, time: nowHM(), created: Date.now() }, date);
    await afterChange(date);
    const label = kind === 'smoke' ? C.smokeLabel(type) : C.alcoholLabel(type);
    toast(`Записал: ${label}`, 3000);
  },
  'log-del-last': async el => {
    const { kind, date } = el.dataset;
    const list = kind === 'smoke' ? C.smokeList(date) : C.alcoholList(date);
    const last = [...list].sort((a, b) => (a.data.created || 0) - (b.data.created || 0)).pop();
    if (last) { await store.remove(last.id); await afterChange(date); }
  },
  'cup-new': async el => {
    const { kind, date } = el.dataset;
    const t = document.getElementById('cup-new-time')?.value || nowHM();
    await store.put('drink', store.newId(), { kind, time: t, created: Date.now() }, date);
    await afterChange(date);
    cupEditor(kind, date);
  },
  // половинка чашки: 0.5 (целая - поле убираем, как у старых записей)
  'cup-amt': async el => {
    const v = Number(el.dataset.v), r = store.get(el.dataset.id);
    if (!r) return;
    const { amount, ...rest } = r.data;
    await store.put('drink', r.id, v === 1 ? rest : { ...rest, amount: v }, r.date);
    await afterChange(el.dataset.date);
    cupEditor(el.dataset.kind, el.dataset.date);
  },
  'cup-rm': async el => {
    const r = store.get(el.dataset.id);
    if (r?.data.food_id && store.get(r.data.food_id)) await store.remove(r.data.food_id);
    await store.remove(el.dataset.id);
    await afterChange(el.dataset.date);
    cupEditor(el.dataset.kind, el.dataset.date);
  },
  // молоко к кофе - в БЖУ дня (как протеин у добавок); выключили - связанная запись еды убирается
  'cup-milk-on': async el => {
    const r = store.get(el.dataset.id);
    if (!r) return;
    await C.setCupMilk(el.dataset.id, r.data.milk ? null : { type: '2.5', ml: 50 });
    await afterChange(el.dataset.date);
    cupEditor('coffee', el.dataset.date);
  },
  inc: async el => {
    const { item, date } = el.dataset;
    const cur = Number(C.logVal(date, item)) || 0;
    // «−» после полстакана убирает полстакана, иначе - целый
    const dv = Number(el.dataset.d) === -1 && cur % 1 ? -(cur % 1) : Number(el.dataset.d);
    const v = Math.max(0, Math.round((cur + dv) * 2) / 2);
    await setLog(item, date, v);
  },
  // сон
  'td-sleep': async el => {
    const { k, v, date } = el.dataset;
    const cur = sleepRec(date)?.data || {};
    await upsertDaily('sleep', 'sleep', date, { [k]: cur[k] === v ? null : v });
    if (k === 'alarms') praiseLater(date);
    const d = sleepRec(date)?.data;
    if (d && SLEEP_Q.every(([q]) => d[q]) && sleepInfo(sleepRec(date)) && S.forms.td?.sleepOpen) { S.forms.td.sleepOpen = false; S.render(); }
  },
  'td-sleep-open': () => { const t = (S.forms.td ||= {}); t.sleepOpen = !t.sleepOpen; S.render(); },
  // самочувствие
  'td-state': async el => {
    const { k, v, date } = el.dataset;
    const cur = stateRec(date)?.data || {};
    await upsertDaily('state', 'state', date, { [k]: cur[k] === v ? null : v });
  },
  // тип дня
  'td-daytype': async el => {
    const { v, date, force } = el.dataset;
    const id = `daytype:${store.uid()}:${date}`;
    const t = (S.forms.td ||= {});
    if (v === 'cheat' && !force && dayTypeOf(date) !== 'cheat') {
      const a = safe(() => C.cheatAdvice?.(date), () => cheatAdviceLocal(date));
      if (!a.allowed) { t.cheatAsk = date; S.render(); return; }
    }
    t.cheatAsk = null;
    if (!v) { if (store.get(id)) await store.remove(id); }
    else await store.put('daytype', id, { ...(store.get(id)?.data || {}), type: v, entered_at: Date.now() }, date);
    await afterChange(date);
    if (v === 'cheat') toast(byTone({ soft: 'Читмил! Наслаждайся - сегодня без подсчётов.', coach: 'Читмил отмечен. Завтра - снова по плану.', sergeant: 'Читмил разрешён. Один. Завтра - в строй.' }));
    S.render();
  },
  'td-cheat-cancel': () => { (S.forms.td ||= {}).cheatAsk = null; S.render(); },
  // вариант тренировки
  'td-variant': async el => {
    const { v, date } = el.dataset;
    const w = C.workout(date);
    if (w && (w.data.variant || 'full') === v) return;
    await applyVariant(date, v);
  },
  // модули
  'td-mod-open': el => { (S.forms.td ||= {}).mod_sel = el.dataset.m; S.render(); },
  // чип комплекса: открыть / свернуть (повторное нажатие). Собранный комплекс при сворачивании не удаляется
  'td-mod-sel': el => {
    const t = (S.forms.td ||= {}), k = el.dataset.m;
    const hid = new Set(t.mod_hidden || []);
    const open = el.getAttribute('aria-pressed') === 'true';
    if (open) { hid.add(k); if (t.mod_sel === k) t.mod_sel = null; }
    else { hid.delete(k); t.mod_sel = k; }
    t.mod_hidden = [...hid];
    S.render();
    if (!open) setTimeout(() => document.getElementById(`mod-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  },
  'td-mod-min': el => { (S.forms.td ||= {})['min_' + el.dataset.m] = Number(el.dataset.v); S.render(); },
  'td-mod-add': async el => {
    const { m, min, date } = el.dataset;
    await makeRoutine(m, Number(min), date);
    const t = (S.forms.td ||= {});
    t.mod_sel = m; t.mod_hidden = (t.mod_hidden || []).filter(x => x !== m);
    S.render();
    setTimeout(() => document.getElementById(`mod-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  },
  'td-mod-make': async el => {
    // нажатие на уже выбранное время в собранном комплексе ничего не пересобирает
    if (store.get(routineId(el.dataset.date, el.dataset.m))?.data.minutes === Number(el.dataset.min) && el.getAttribute('aria-pressed') === 'true') return;
    await makeRoutine(el.dataset.m, Number(el.dataset.min), el.dataset.date);
    S.render();
  },
  'td-mod-redo': async el => {
    const cur = store.get(routineId(el.dataset.date, el.dataset.m))?.data;
    await makeRoutine(el.dataset.m, cur?.minutes || modDef(el.dataset.m)?.def || 15, el.dataset.date);
    const pa = P.pairPartner?.(el.dataset.m);
    if (pa) toast(`Пересобрано у вас и у ${C.nameForms?.(pa.id)?.gen || pa.name}`);
  },
  'td-mod-gear': async el => {
    const { m, g, date } = el.dataset, p = profile();
    if (P.gearOf(m) === g) return;
    await store.put('profile', `profile:${store.uid()}`, { ...p, modules: { ...(p.modules || {}), [m]: { ...(p.modules?.[m] || {}), gear: g } } });
    const n = g === 'any' ? 0 : await P.applyGear(m, date);
    S.render();
    toast(g === 'any' ? 'Инвентарь - любой из профиля: со следующей сборки' : n ? `Заменил упражнений: ${n}. Дальше комплекс собирается так же` : 'Запомнил - комплекс собирается так и дальше');
  },
  'td-goto-mod': async el => {
    const { m, date } = el.dataset;
    if (!store.get(routineId(date, m))) await makeRoutine(m, Number(profile().modules?.[m]?.minutes || modDef(m)?.def || 15), date);
    S.render();
    setTimeout(() => document.getElementById(`mod-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  },
  'td-unpin-all': async el => {
    await setPinned([]);
    await makeRoutine('morning', Number(store.get(routineId(el.dataset.date, 'morning'))?.data.minutes || MODULES.morning.def), el.dataset.date);
    toast('Открепили - разминку теперь подбирает тренер. Закрепить снова: «Делать каждый день» в описании упражнения', 4500);
  },
  'td-pin': async el => {
    const id = el.dataset.ex, cur = pinnedOf();
    const on = cur.includes(id);
    await setPinned(on ? cur.filter(x => x !== id) : [...cur, id]);
    toast(on ? 'Откреплено - дальше по ситуации' : 'Закреплено: это упражнение будет в разминке каждый день');
  },
  'td-pain': async el => {
    const { k, date } = el.dataset, on = !(stateRec(date)?.data.pains || []).includes(k);
    const did = await setPain(date, k, on);
    const name = PAINS.find(x => x[0] === k)?.[1] || k, pl = k === 'knees';
    toast(on ? `Отметил: ${pl ? 'болят' : 'болит'} ${name}.${did ? ` План на сегодня подстроил: ${did}.` : ''}` : `Снял отметку: ${name} ${pl ? 'больше не болят' : 'больше не болит'}`);
    await afterChange(date);
  },
  'td-nap-add': async el => {
    const date = el.dataset.date, naps = [...(sleepRec(date)?.data.naps || []), { from: null, to: null }];
    await upsertDaily('sleep', 'sleep', date, { naps });
    setTimeout(() => document.querySelector(`[data-act="td-nap-time"][data-i="${naps.length - 1}"][data-end="from"][data-part="h"]`)?.focus(), 60);
  },
  'td-nap-rm': async el => {
    const date = el.dataset.date, i = Number(el.dataset.i);
    await upsertDaily('sleep', 'sleep', date, { naps: (sleepRec(date)?.data.naps || []).filter((_, j) => j !== i) });
  },
  'td-rt-tick': async el => {
    const { m, date } = el.dataset, i = Number(el.dataset.i);
    const rec = store.get(routineId(date, m));
    if (!rec) return;
    const exercises = structuredClone(rec.data.exercises);
    exercises[i].done = !exercises[i].done;
    const done = exercises.every(x => x.done);
    await store.patch(rec.id, { exercises, done, ...(done ? { done_at: Date.now() } : {}) });
    await afterChange(date);
    if (done && !rec.data.done) {
      toast(byTone({ soft: 'Комплекс сделан - ты молодец!', coach: 'Комплекс закрыт. Отлично.', sergeant: 'Комплекс выполнен. Засчитано.' }));
      // веха для ленты «Вместе»: какой комплекс и сколько минут (без списка упражнений); id постоянный - без дублей
      const title = String(rec.data.title || P.MODULES?.[m]?.title || 'Комплекс').replace(/\s*·.*$/, '');
      await C.shareHighlight('complex', title, Number(rec.data.minutes) || null, date, `highlight:${store.uid()}:${date}:${m}`, rec.id);
    } else if (!done && rec.data.done) await C.unshareHighlight(`highlight:${store.uid()}:${date}:${m}`);   // сняли отметку - и из ленты
  },
  // активности
  'td-ac-open': el => {
    const { date, type, min, int } = el.dataset;
    openActivity(date, type ? { type, minutes: min || '', intensity: int || 'mid' } : {});
  },
  'td-ac-edit': el => {
    const r = store.get(el.dataset.id);
    if (!r) return;
    const a = r.data, pre = { id: r.id, type: a.type, minutes: a.minutes, intensity: a.intensity, note: a.note || '' };
    for (const [k, v] of Object.entries(a.details || {})) pre['d_' + k] = v;
    openActivity(r.date, pre);
  },
  'td-ac-type': el => {
    const f = (S.forms.act ||= {});
    if (f.type !== el.dataset.v) {
      for (const k of Object.keys(f)) if (k.startsWith('d_')) delete f[k];
      f.type = el.dataset.v;
      const typical = (profile().activities || []).find(a => a.type === f.type);
      if (!f.minutes && typical?.minutes) f.minutes = typical.minutes;
      if (typical?.intensity) f.intensity = typical.intensity;
    }
    f.q = ''; f.pickType = false;
    actModal();
  },
  // выбранный вид сворачивает список из полусотни видов — форма сразу на виду; вернуть список — этой кнопкой
  'td-ac-change': () => { (S.forms.act ||= {}).pickType = true; actModal(); setTimeout(() => document.getElementById('act-q')?.focus(), 30); },
  'td-ac-f': el => {
    const f = (S.forms.act ||= {});
    const { k, multi } = el.dataset;
    const v = el.dataset.num ? Number(el.dataset.v) : el.dataset.v;
    if (multi) { const cur = (f[k] || []).map(String); f[k] = cur.includes(String(v)) ? cur.filter(x => x !== String(v)) : [...cur, String(v)]; }
    else f[k] = String(f[k]) === String(v) && k !== 'intensity' ? null : v;
    actModal();
  },
  'td-ac-save': async () => {
    const f = S.forms.act || {};
    const def = activityDef(f.type);
    if (!def) return toast('Выберите вид активности');
    const minutes = Math.round(Number(f.minutes) || 0);
    if (minutes <= 0) return toast('Сколько минут длилось?');
    const details = {};
    for (const fd of def.fields || []) {
      const v = f['d_' + fd.key];
      if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) details[fd.key] = v;
    }
    const intensity = f.intensity || 'mid';
    const id = f.id || store.newId();
    const prev = f.id ? store.get(f.id)?.data : null;
    await store.put('activity', id, {
      type: f.type, minutes, intensity, kcal: activityKcal(f.type, minutes, intensity), note: (f.note || '').trim(),
      details, source: prev?.source || 'manual', entered_at: prev?.entered_at || Date.now(),
    }, f.date);
    closeModal();
    delete S.forms.act;
    await afterChange(f.date);
    // личное (массаж, баня, медитация, дети) в ленту группы не уходит
    const hl = `highlight:${store.uid()}:act:${id}`;
    if (!prev && !def.private) await C.shareHighlight('activity', def.name, minutes, f.date, hl, id);
    else if (prev && store.get(hl)) await store.patch(hl, { label: def.name, minutes });     // поменяли длительность - и в ленте
    toast(f.id ? 'Активность обновлена' : `${def.name}: ${minutes} мин записано`);
    if (!f.id && isBackdated(f.date)) setTimeout(() => toast('Засчитал. В следующий раз лучше отметить в тот же день.'), 3000);
  },
  'td-ac-del': async el => {
    const r = store.get(el.dataset.id);
    closeModal();
    await store.remove(el.dataset.id);
    await C.unshareHighlight(`highlight:${store.uid()}:act:${el.dataset.id}`);
    if (r) await afterChange(r.date);
    toast('Активность удалена');
  },
};

export const confirms = {
  'td-ac-del': el => { const r = store.get(el.dataset.id); const n = r ? activityName(r.data.type) : ''; return { title: 'Удалить активность?', text: `${n ? `«${n}»${r.data.minutes ? `, ${r.data.minutes} мин` : ''} пропадёт` : 'Активность пропадёт'} из дня.` }; },
  'cup-rm': el => { const r = store.get(el.dataset.id); return { title: 'Удалить чашку?', text: `${r?.data.time ? `Чашка в ${r.data.time} пропадёт` : 'Чашка пропадёт'} из дня${r?.data.food_id ? ' вместе с молоком в записи еды' : ''}.` }; },
  'td-nap-rm': () => ({ title: 'Убрать дневной сон?', ok: 'Убрать', text: 'Запись о дневном сне пропадёт из дня.' }),
};

export const changes = {
  'cup-time': async el => {
    if (!el.value) return;
    const r = store.get(el.dataset.id);
    await store.patch(el.dataset.id, { time: el.value });
    if (r?.data.food_id && store.get(r.data.food_id)) await store.patch(r.data.food_id, { time: el.value, meal: C.milkMeal(r.data.milk, el.value) });
    await afterChange(el.dataset.date);
  },
  // к какому приёму пищи отнести молоко ('' - по времени чашки)
  'cup-milk-meal': async el => {
    const r = store.get(el.dataset.id);
    if (!r?.data.milk) return;
    await C.setCupMilk(el.dataset.id, { ...r.data.milk, meal: el.value || null });
    await afterChange(el.dataset.date);
  },
  // какое молоко к кофе (жирность/растительное) - пересчитывает связанную запись еды
  'cup-milk-type': async el => {
    const r = store.get(el.dataset.id);
    if (!r) return;
    await C.setCupMilk(el.dataset.id, { ...r.data.milk, type: el.value });
    await afterChange(el.dataset.date);
  },
  'cup-milk-ml': async el => {
    const r = store.get(el.dataset.id);
    if (!r) return;
    await C.setCupMilk(el.dataset.id, { ...r.data.milk, ml: Math.max(0, Number(el.value) || 0) });
    await afterChange(el.dataset.date);
  },
  setnum: el => setLog(el.dataset.item, el.dataset.date, Math.max(0, Number(el.value) || 0)),
  // часы и минуты - отдельные поля (не единый <input type="time">): у него .value пуст, пока не заполнены
  // ОБА внутренних окошка сразу, поэтому заполнение только часов и уход с поля ничего не сохраняло
  'td-nap-time': async el => {
    const { i, end, date } = el.dataset;
    const pair = [...document.querySelectorAll(`[data-act="td-nap-time"][data-i="${i}"][data-end="${end}"][data-date="${date}"]`)];
    const raw = part => (pair.find(x => x.dataset.part === part)?.value ?? '').trim();
    const h = raw('h'), m = raw('m');
    const value = !h && !m ? null
      : `${String(Math.min(23, Math.max(0, parseInt(h, 10) || 0))).padStart(2, '0')}:${String(Math.min(59, Math.max(0, parseInt(m, 10) || 0))).padStart(2, '0')}`;
    const naps = structuredClone(sleepRec(date)?.data.naps || []);
    if (!naps[Number(i)]) return;
    naps[Number(i)][end] = value;
    await upsertDaily('sleep', 'sleep', date, { naps });
  },
  'td-sleep-time': async el => {
    const { k, date } = el.dataset;
    const pair = [...document.querySelectorAll(`[data-act="td-sleep-time"][data-k="${k}"][data-date="${date}"]`)];
    const raw = part => (pair.find(x => x.dataset.part === part)?.value ?? '').trim();
    const h = raw('h'), m = raw('m');
    const value = !h && !m ? null
      : `${String(Math.min(23, Math.max(0, parseInt(h, 10) || 0))).padStart(2, '0')}:${String(Math.min(59, Math.max(0, parseInt(m, 10) || 0))).padStart(2, '0')}`;
    const extra = {};
    // первый будильник указан - значит, проснулся по будильнику; убран - и счётчик будильников не нужен
    if (k === 'alarm' && value && !sleepRec(date)?.data.awakening) extra.awakening = 'alarm';
    if (k === 'alarm' && !value) extra.alarms = null;
    await upsertDaily('sleep', 'sleep', date, { [k]: value, ...extra });
    praiseLater(date);
  },
};

// часы/минуты сна: при фокусе выделить всё (ввод заменяет старое, а не дописывается к нему - «0300»),
// только цифры, после двух цифр часов - сразу к минутам
const hmBox = t => t?.matches?.('.a-hm input');
document.addEventListener('focusin', e => {
  if (!hmBox(e.target)) return;
  const el = e.target;
  setTimeout(() => { if (document.activeElement === el) el.select(); });
});
// Safari снимает выделение отпусканием пальца/кнопки сразу после фокуса
document.addEventListener('mouseup', e => { if (hmBox(e.target) && e.target.selectionStart !== e.target.selectionEnd) e.preventDefault(); });
document.addEventListener('input', e => {
  const el = e.target;
  if (!hmBox(el)) return;
  const v = el.value.replace(/\D/g, '').slice(0, 2);
  if (v !== el.value) el.value = v;
  if (el.dataset.part === 'h' && v.length === 2) el.parentElement.querySelector('[data-part="m"]')?.focus();
});

// поле «минуты» в форме активности: пересчитать ккал в окне без перерисовки
document.addEventListener('input', e => {
  if (e.target.dataset?.form !== 'act' || e.target.dataset.key !== 'minutes') return;
  const f = S.forms.act || {};
  const out = document.querySelector('#modal .a-kcal');
  if (out && f.type) { const k = activityKcal(f.type, e.target.value, f.intensity || 'mid'); out.textContent = k ? '≈ ' + num(k) : '-'; }
});

export const routes = { today: () => viewDay(C.today()), day: arg => viewDay(/^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? arg : C.today()) };

export const H = {
  safe, mondayOf, tone, sleepRec, stateRec, sleepInfo, dayTypeOf, activitiesOf, activityList, activityDef, activityName,
  activityDetails, activityLine, activityKcal, dayGrade, shownGrade, readiness, workoutVariant, applyVariant, variantBlock, pick, gradeDot,
  foodTotals, bodyWeight, SLEEP_Q, STATE_Q, STATE_EMOJI, DAY_TYPE_NAME, GRADE_NAME, READY_NAME, VARIANT_NAME, INTENSITY,
};
