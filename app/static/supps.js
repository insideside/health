// Витамины и добавки: план приёма из профиля, отметки приёмов, БЖУ спортпита, проверки доз и советы тренера.
//
// План — profile.supplements: [{key, sid (id из справочника или null), name, dose, dose_unit (доза за приём:
//   30 г, 200 мг, 2000 МЕ, 1 капсула…), times ['08:00'], custom {serving, macros, caffeine_mg}, active}].
// Приём — запись supp {key, sid, name, time, dose, dose_unit, food_id?}: одна на каждый приём; время и доза правятся.
// Если у добавки есть калории (протеин, гейнер, изотоник), приём пишет и запись food с пометкой supp_id —
// так белок и углеводы попадают в БЖУ дня везде (экран еды, оценки, отчёты, сервер) без особых случаев.
// Советы — только из справочника и только с доказательностью A/B; тренер не врач и ничего не назначает.
import * as store from './store.js';
import * as C from './coach.js';
import { S } from './ui.js';

export const LEVEL = { A: 'сильные доказательства', B: 'умеренные доказательства', C: 'данные слабые', D: 'пользы не доказано' };
export const CATEGORY = {
  protein: 'Протеин и белок', creatine: 'Креатин', amino: 'Аминокислоты', vitamin: 'Витамины', mineral: 'Минералы',
  omega: 'Омега-3', electrolyte: 'Изотоники и электролиты', carbs: 'Углеводы и гели', caffeine: 'Кофеин и предтрены',
  sleep: 'Сон и нервы', joint: 'Суставы', digestive: 'Пищеварение и клетчатка', herbal: 'Растительные', fat_loss: 'Для похудения', other: 'Другое',
};
const CONTRA_OF_LIMIT = { pregnancy: 'pregnancy', hypertension: 'hypertension', heart: 'heart', diabetes: 'diabetes' };
const CONTRA_LABEL = { pregnancy: 'беременность', kidney: 'почки', liver: 'печень', hypertension: 'давление', heart: 'сердце',
  anticoagulants: 'антикоагулянты', diabetes: 'диабет', thyroid: 'щитовидная железа', epilepsy: 'эпилепсия', under18: 'до 18 лет', gi: 'ЖКТ' };
export const DISCLAIMER = 'Тренер не врач: советы - только проверенные исследованиями и в безопасных дозах. Перед приёмом, особенно при лекарствах и болезнях, обсудите с врачом.';

const prof = (uid = store.uid()) => store.get(`profile:${uid}`)?.data || {};
export const cat = id => (id ? S.supps.items.get(id) || null : null);
export const keyOf = s => s.key || s.sid;
export const nameOf = s => s.name || cat(s.sid)?.name || s.sid || 'Добавка';
export const catalog = () => [...S.supps.items.values()];

// ── план ──
// по времени приёма: раньше - выше, без времени - в конце; при одинаковом времени - порядок добавления
export function plan(uid = store.uid()) {
  const first = s => (s.times?.length ? [...s.times].sort()[0] : '99:99');
  return (prof(uid).supplements || []).filter(s => s.active !== false)
    .map(s => ({ ...s, ...(s.times?.length ? { times: [...s.times].sort() } : {}), key: keyOf(s), item: cat(s.sid), name: nameOf(s) }))
    .sort((a, b) => first(a).localeCompare(first(b)));
}
export const enabled = (uid = store.uid()) => plan(uid).length > 0;
export function servingOf(s) {
  const it = cat(s.sid);
  return s.custom?.serving || it?.serving || { amount: 1, unit: s.unit || 'порция', label: s.unit || 'порция' };
}
function macrosOf(s) {
  const m = s.custom?.macros || cat(s.sid)?.macros;
  return m && (Number(m.kcal) || Number(m.p) || Number(m.c) || Number(m.f)) ? m : null;
}
const caffeineOf = s => Number(s.custom?.caffeine_mg ?? cat(s.sid)?.caffeine_mg) || 0;

// ── доза за приём ──
export const DOSE_UNITS = ['г', 'мг', 'мкг', 'МЕ', 'мл', 'капсула', 'таблетка', 'мерная ложка', 'порция', 'саше', 'капли'];
const MASS = new Set(['г', 'мл']);
// граммы в одной порции: «1 мерная ложка (30 г)» → 30; порция в г/мл → её количество
function servingGrams(sv) {
  if (MASS.has(sv.unit)) return Number(sv.amount) || null;
  const m = String(sv.label || '').match(/(\d+(?:[.,]\d+)?)\s*(г|мл)(?![а-яё])/i);
  return m ? Number(m[1].replace(',', '.')) : null;
}
// доза по умолчанию: граммы порции для спортпита, иначе нижняя дневная доза справочника на число приёмов, иначе 1 порция
export function defaultDose(s) {
  const it = cat(s.sid), sv = servingOf(s), n = Math.max(1, s.times?.length || 1);
  const g = servingGrams(sv);
  if (g && (it?.macros || s.custom?.macros || MASS.has(sv.unit) || it?.dose?.unit === 'г')) return { dose: g, unit: MASS.has(sv.unit) ? sv.unit : 'г' };
  if (it?.dose?.per_day_min && ['мг', 'мкг', 'МЕ', 'г'].includes(it.dose.unit)) return { dose: Math.round(it.dose.per_day_min / n * 100) / 100, unit: it.dose.unit };
  return { dose: Number(sv.amount) || 1, unit: sv.unit || 'порция' };
}
export function planDose(s) {
  if (s.dose && s.dose_unit) return { dose: Number(s.dose), unit: s.dose_unit };
  if (s.amount && !s.dose) { const sv = servingOf(s); return { dose: Number(s.amount) * (Number(sv.amount) || 1), unit: sv.unit || 'порция' }; }   // старый формат
  return defaultDose(s);
}
// сколько порций справочника в дозе (для калорий и кофеина): граммы к граммам, единицы порции к единицам, иначе 1
function servingsIn(s, dose, unit) {
  const sv = servingOf(s), g = servingGrams(sv);
  if (unit === sv.unit) return (Number(dose) || 0) / (Number(sv.amount) || 1);
  if (MASS.has(unit) && g) return (Number(dose) || 0) / g;
  return 1;
}
export const doseText = (dose, unit) => `${String(Math.round(Number(dose) * 100) / 100).replace('.', ',')} ${unit}`;

export async function savePlan(list, uid = store.uid()) {
  const r = store.get(`profile:${uid}`);
  await store.put('profile', `profile:${uid}`, { ...(r?.data || {}), supplements: list }, null);
}

// ── приёмы ──
export function intakes(date, key = null, uid = store.uid()) {
  return store.byDate('supp', date, uid).filter(r => !key || r.data.key === key)
    .sort((a, b) => (a.data.time || '').localeCompare(b.data.time || '') || (a.data.created || 0) - (b.data.created || 0));
}
// → [{s, planned, taken: [записи], left: ['21:00'] - плановые времена без приёма рядом (±2 ч)}]
export function dayStatus(date, uid = store.uid()) {
  return plan(uid).map(s => {
    const taken = intakes(date, s.key, uid);
    const times = s.times?.length ? s.times : [];
    const planned = times.length || 1;
    const used = new Set();
    const left = times.filter(t => {
      const i = taken.findIndex((r, j) => !used.has(j) && Math.abs((C.toMin(r.data.time) ?? -999) - C.toMin(t)) <= 120);
      if (i >= 0) { used.add(i); return false; }
      return true;
    });
    // приёмы не у планового времени тоже считаются: сколько приёмов, столько закрыто
    const leftN = Math.max(0, planned - taken.length);
    return { s, planned, taken, left: left.slice(left.length - leftN) };
  });
}

function mealAt(time) {
  const m = C.toMin(time) ?? 12 * 60;
  return m < 11 * 60 ? 'breakfast' : m < 16 * 60 ? 'lunch' : m < 21 * 60 ? 'dinner' : 'snack';
}

// приёмы, отмеченные тренером из чата (сервер пишет только supp): дописать запись еды для протеина и т. п. -
// справочник порций и БЖУ только здесь. Один раз на приём (food_id или food_checked).
export async function ensureFoods(dates, uid = store.uid()) {
  for (const d of dates) {
    for (const r of store.byDate('supp', d, uid)) {
      if (r.data.via !== 'chat' || r.data.food_id || r.data.food_checked) continue;
      const s = plan(uid).find(x => x.key === r.data.key);
      const f = s && foodFor(s, r.data.dose || planDose(s).dose, r.data.dose_unit || planDose(s).unit, r.data.time);
      if (f) {
        const fid = store.newId();
        await store.put('food', fid, { ...f, supp_id: r.id, created: Date.now(), entered_at: Date.now() }, d);
        await store.patch(r.id, { food_id: fid });
      } else await store.patch(r.id, { food_checked: true });
    }
  }
}

// запись еды для спортпита с калориями: белок протеина идёт в БЖУ дня
function foodFor(s, dose, unit, time) {
  const m = macrosOf(s);
  if (!m) return null;
  const k = servingsIn(s, dose, unit), r1 = v => Math.round((Number(v) || 0) * k * 10) / 10;
  const item = { text: `${nameOf(s)} ${doseText(dose, unit)}`, name: nameOf(s), grams: MASS.has(unit) ? Number(dose) : null,
    kcal: Math.round((Number(m.kcal) || 0) * k), p: r1(m.p), f: r1(m.f), c: r1(m.c), source: 'supp' };
  return { meal: mealAt(time), text: item.text, items: [item], totals: { kcal: item.kcal, p: item.p, f: item.f, c: item.c }, status: 'calculated', calc: 'supp', time };
}

export async function mark(s, date, time, dose = null, unit = null) {
  const pd = planDose(s), d = Number(dose ?? pd.dose) || pd.dose, u = unit || pd.unit, id = store.newId();
  const data = { key: keyOf(s), sid: s.sid || null, name: nameOf(s), time, dose: d, dose_unit: u, created: Date.now() };
  const f = foodFor(s, d, u, time);
  if (f) {
    const fid = store.newId();
    await store.put('food', fid, { ...f, supp_id: id, created: Date.now(), entered_at: Date.now() }, date);
    data.food_id = fid;
  }
  await store.put('supp', id, data, date);
  return id;
}
// поменять дозу приёма: запись еды пересчитывается (или появляется / исчезает)
export async function setDose(id, dose) {
  const r = store.get(id);
  if (!r || !(Number(dose) > 0)) return;
  const s = (prof().supplements || []).find(x => keyOf(x) === r.data.key) || { sid: r.data.sid, name: r.data.name };
  const u = r.data.dose_unit || planDose(s).unit;
  await store.patch(id, { dose: Number(dose), dose_unit: u });
  const f = foodFor(s, Number(dose), u, r.data.time);
  if (r.data.food_id && store.get(r.data.food_id)) {
    if (f) await store.put('food', r.data.food_id, { ...store.get(r.data.food_id).data, ...f }, r.date);
  }
}
export async function unmark(id) {
  const r = store.get(id);
  if (!r) return;
  if (r.data.food_id && store.get(r.data.food_id)) await store.remove(r.data.food_id);
  await store.remove(id);
}
export async function setTime(id, time) {
  const r = store.get(id);
  if (!r || !time) return;
  await store.patch(id, { time });
  if (r.data.food_id && store.get(r.data.food_id)) await store.patch(r.data.food_id, { time, meal: mealAt(time) });
}

// кофеин из добавок после 14:00 (для анализа сна) и ключи принятого за день
export function caffeineLate(date, uid = store.uid()) {
  let mg = 0;
  for (const r of intakes(date, null, uid)) {
    if ((C.toMin(r.data.time) ?? 0) < 14 * 60) continue;
    const s = (prof(uid).supplements || []).find(x => keyOf(x) === r.data.key) || { sid: r.data.sid };
    mg += caffeineOf(s) * (r.data.dose ? servingsIn(s, r.data.dose, r.data.dose_unit) : Number(r.data.amount) || 1);
  }
  return mg;
}
export const takenKeys = (date, uid = store.uid()) => new Set(intakes(date, null, uid).map(r => r.data.key));
// факт за день против безопасного предела → текст предупреждения или null
export function dayOverUL(date, key, uid = store.uid()) {
  const s = plan(uid).find(x => x.key === key), it = s?.item;
  if (!it?.ul?.value) return null;
  let sum = 0;
  for (const r of intakes(date, key, uid)) { const v = toUnit(Number(r.data.dose) || 0, r.data.dose_unit, it.ul.unit); if (v == null) return null; sum += v; }
  return sum > it.ul.value ? `За день ${doseText(sum, it.ul.unit)} - больше безопасного предела ${it.ul.value} ${it.ul.unit}. Лишний приём лучше не делать.` : null;
}

// ── проверки ──
const norm = t => String(t || '').toLowerCase().replace(/ё/g, 'е');
export function stopMatch(name) {
  const n = norm(name);
  if (n.length < 3) return null;
  return S.supps.stoplist.find(x => [x.name, ...(x.aliases || [])].some(a => { const k = norm(a); return k.length >= 3 && (n.includes(k) || k === n); })) || null;
}
// дневная доза: в единицах справочника; витамин D - МЕ и мкг переводим (1 мкг = 40 МЕ)
function toUnit(v, from, to) {
  if (!from || !to || from === to) return v;
  if (from === 'МЕ' && to === 'мкг') return v / 40;
  if (from === 'мкг' && to === 'МЕ') return v * 40;
  if (from === 'г' && to === 'мг') return v * 1000;
  if (from === 'мг' && to === 'г') return v / 1000;
  if (from === 'мг' && to === 'мкг') return v * 1000;
  if (from === 'мкг' && to === 'мг') return v / 1000;
  return null;
}
// → [{level: 'stop'|'warn'|'info', text}]
export function warnings(s, uid = store.uid()) {
  const p = prof(uid), it = cat(s.sid), out = [];
  const stop = it ? null : stopMatch(s.name);     // справочник проверен; стоп-лист - для своих добавок
  if (stop) out.push({ level: 'stop', text: `${stop.name}: ${stop.why} Тренер не советует это принимать.` });
  if (it) {
    const pd = planDose(s), daily = pd.dose * Math.max(1, s.times?.length || 1);
    if (it.ul?.value) {
      const v = toUnit(daily, pd.unit, it.ul.unit);
      if (v != null && v > it.ul.value) out.push({ level: 'stop', text: `По плану ${doseText(daily, pd.unit)} в день - выше безопасного предела (${it.ul.value} ${it.ul.unit} в день, ${it.ul.source || 'EFSA'}). Без назначения врача так принимать не стоит.` });
    }
    const lim = new Set((p.limitations || []).map(l => CONTRA_OF_LIMIT[l]).filter(Boolean));
    const hit = (it.contra || []).filter(c => lim.has(c));
    if (hit.length) out.push({ level: 'warn', text: `С учётом профиля (${hit.map(c => CONTRA_LABEL[c] || c).join(', ')}) - только после разговора с врачом.` });
    if (it.needs_test) out.push({ level: 'warn', text: 'Принимают по анализу: без него легко получить избыток.' });
    if (it.evidence === 'C' || it.evidence === 'D') out.push({ level: 'info', text: `${LEVEL[it.evidence][0].toUpperCase()}${LEVEL[it.evidence].slice(1)}: ждать заметного эффекта не стоит.` });
  }
  if ((p.medications || '').trim()) out.push({ level: 'info', text: 'У вас указаны лекарства - совместимость лучше уточнить у врача или фармацевта.' });
  return out;
}

// ── советы тренера (только A/B, по данным дневника) ──
const FISH_RX = /рыб|лосос|семг|сёмг|форел|сельд|скумбр|тунец|сардин|горбуш|кет[аы]|треск|минта|хек|палтус|анчоус|шпрот/i;
function recentFood(days, uid) {
  const out = [];
  for (let i = 1; i <= days; i++) { const d = C.addDays(C.today(), -i), fd = C.foodDay(d, uid); if (fd) out.push({ d, fd }); }
  return out;
}
function pick(key, p) {
  const list = catalog().filter(x => x.recommend === key && (x.evidence === 'A' || x.evidence === 'B'));
  if (key === 'protein_low') {
    if (p.diet === 'vegan') return list.find(x => /plant|раст/i.test(x.id + x.name)) || list[0];
    if (p.diet === 'lactose_free') return list.find(x => /isolate|изолят|plant|раст/i.test(x.id + x.name)) || list[0];
    return list.find(x => /whey|сыворот/i.test(x.id + x.name)) || list[0];
  }
  return list[0];
}
// → [{key, item, why, level, test}]
export function advice(uid = store.uid()) {
  if (!S.supps.items.size) return [];
  const p = prof(uid), g = store.get(`goal:${uid}`)?.data || {}, taking = new Set(plan(uid).map(s => s.sid).filter(Boolean));
  const takingCat = new Set(plan(uid).map(s => s.item?.category).filter(Boolean));
  const dismissed = p.supp_dismissed || {};
  const fresh = k => !dismissed[k] || C.daysBetween(dismissed[k], C.today()) > 60;
  if ((p.limitations || []).includes('pregnancy')) return [];      // при беременности - только врач
  const out = [], add = (key, why) => {
    const item = pick(key, p);
    if (!item || taking.has(item.id) || !fresh(key)) return;
    out.push({ key, item, why, level: item.evidence, test: !!item.needs_test });
  };
  const tg = C.target(uid);
  const food = recentFood(7, uid).filter(x => x.fd.calculated);
  if (tg?.p && food.length >= 4 && !takingCat.has('protein')) {
    const avg = food.reduce((a, x) => a + x.fd.p, 0) / food.length;
    if (avg < tg.p * 0.8) add('protein_low', `За неделю белка в среднем ${Math.round(avg)} г при норме ${tg.p} г. Сначала - еда (творог, яйца, мясо, рыба, бобовые); если не получается, порция протеина закрывает 20-25 г.`);
  }
  const types = new Set((g.goals || []).map(x => x.type));
  const mode = C.target(uid)?.mode;
  const strength = types.has('gain_muscle') || types.has('strength') || mode === 'bulk' || mode === 'recomp';
  if (strength && (p.gym || store.list('program', uid).some(r => r.data.active)) && !takingCat.has('creatine')) {
    add('strength_goal', 'Цель - мышцы и сила. Креатин моногидрат - самая изученная добавка для силовых: 3-5 г в день, без «загрузки».');
  }
  const month = new Date().getMonth() + 1;
  if ([10, 11, 12, 1, 2, 3].includes(month) && !taking.has(pick('winter_d', p)?.id)) {
    add('winter_d', 'Осенью и зимой солнца мало, и дефицит витамина D частый. Разумно сдать анализ 25(OH)D и решить с врачом, нужен ли приём.');
  }
  const long = store.list('activity', uid, r => r.date >= C.addDays(C.today(), -14)).some(r => Number(r.data.minutes) >= 75);
  if (long) add('long_cardio', 'Были нагрузки дольше 75 минут. На таких тренировках и в жару изотоник или электролиты помогают держать темп и не пересохнуть.');
  const fd21 = recentFood(21, uid);
  if (fd21.length >= 10 && p.diet !== 'vegan' && p.diet !== 'vegetarian' && !takingCat.has('omega')) {
    const fish = fd21.filter(x => store.byDate('food', x.d, uid).some(r => FISH_RX.test(r.data.text || '') || (r.data.items || []).some(i => FISH_RX.test(i.name || '')))).length;
    if (fish < 2) add('low_fish', `За 3 недели рыба была ${fish ? 'один раз' : 'ни разу'}. Лучше жирная рыба 2 раза в неделю; если не выходит - омега-3.`);
  }
  if ((p.diet === 'vegan' || p.diet === 'vegetarian') ) add('vegan_b12', 'При растительном питании витамин B12 почти не поступает с едой - его рекомендуют всем веганам и многим вегетарианцам.');
  return out;
}
export async function dismiss(key, uid = store.uid()) {
  const r = store.get(`profile:${uid}`);
  await store.put('profile', `profile:${uid}`, { ...(r?.data || {}), supp_dismissed: { ...(r?.data.supp_dismissed || {}), [key]: C.today() } }, null);
}

// ── реплика тренера: вечером напомнить о неотмеченном плановом приёме (без упрёков, один раз в строке дня) ──
const MISSED = {
  soft: n => `Сегодня не отмечен приём: ${n}. Если уже принимал - отметь на «Сегодня», если забыл - ничего страшного, двойную дозу не надо.`,
  coach: n => `Не отмечено: ${n}. Принял - отметь, пропустил - просто продолжай по плану завтра, без двойной дозы.`,
  sergeant: n => `По плану был приём: ${n}. Отметки нет. Принял - отметь. Забыл - завтра по графику, дозу не удваиваем.`,
};
C.extend('lines', (now, uid) => {
  if (now.getHours() < 20 || !enabled(uid)) return [];
  const t = C.today(), nowMin = now.getHours() * 60 + now.getMinutes();
  const miss = dayStatus(t, uid).filter(x => x.left.length && x.left.every(tm => (C.toMin(tm) ?? 0) + 120 <= nowMin));
  if (!miss.length) return [];
  const names = miss.map(x => `${x.s.name} (${x.left.join(', ')})`).join(', ');
  const tone = prof(uid).tone || 'coach';
  return [{ event: 'supp_missed', mood: 'info', text: (MISSED[tone] || MISSED.coach)(names), pri: 60 }];
});
