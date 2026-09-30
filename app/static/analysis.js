// Локальный анализ «что на что влияет» по своим данным — без сервера и без ИИ.
// Сравниваем дни и недели за последние 4–8 недель: сон → оценка следующего дня, поздняя еда → сон,
// белок и шаги → изменение веса и талии, тренировки → замеры, читмилы → оценка недели.
// Честно: это совпадения в ваших данных, а не доказанная причина; при малом числе наблюдений так и говорим.
// Точнее — с сервером: полгода истории и сравнение с людьми твоего типа (GET /api/brain/insights).
import * as store from './store.js';
import * as SP from './supps.js';
import * as C from './coach.js';
import { S, esc, num, toast } from './ui.js';

const WEEKS = 8, MIN_WEEKS = 4, MIN_DAYS = 8;
const avg = xs => { const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const dec = (v, d = 1) => (v == null ? '-' : (+v).toFixed(d).replace('.', ','));
const weeksWord = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'неделю' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'недели' : 'недель'}`;
const daysWord = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней'}`;

// подписи для признаков и результатов — общие для локального анализа и ответа сервера
export const FEATURE_HIGH = { sleep_h: 'больше сна', steps: 'больше шагов', workouts: 'больше тренировок', protein_gkg: 'больше белка',
  kcal_pct: 'больше калорий', activity_min: 'больше активности', cheat_days: 'больше читмилов', late_meals: 'больше поздней еды' };
export const FEATURE_NAME = { sleep_h: 'сон, ч', steps: 'шаги в день', workouts: 'тренировок в неделю', protein_gkg: 'белок, г/кг',
  kcal_pct: 'калории от нормы, %', activity_min: 'активность, мин/нед', cheat_days: 'читмилов в неделю', late_meals: 'поздних приёмов пищи' };
// что именно должно быть записано за неделю (для подсказки «мало данных»)
const FEATURE_WHAT = { sleep_h: 'сон', steps: 'шаги', workouts: 'тренировки', protein_gkg: 'белок', kcal_pct: 'калории',
  activity_min: 'активности', cheat_days: 'читмилы', late_meals: 'время еды' };
const RESULT_TEXT = {
  d_weight: r => (r < 0 ? 'вес снижался быстрее' : 'вес рос или снижался медленнее'),
  d_waist: r => (r < 0 ? 'талия уменьшалась заметнее' : 'талия уменьшалась хуже'),
  d_arm: r => (r > 0 ? 'рука прибавляла заметнее' : 'рука прибавляла меньше'),
  grade: r => (r > 0 ? 'оценка недели выше' : 'оценка недели ниже'),
};
export function strengthOf(r, n, min = MIN_WEEKS) {
  if (n < min || r == null) return 'few';
  const a = Math.abs(r);
  return a >= 0.5 ? 'strong' : a >= 0.3 ? 'moderate' : a >= 0.15 ? 'weak' : 'none';
}
const STRENGTH_RU = { strong: 'заметная связь', moderate: 'умеренная связь', weak: 'слабая связь', none: 'связи не видно', few: 'мало данных' };
export function effectText(e) {
  return `${FEATURE_HIGH[e.feature] || e.feature} - ${RESULT_TEXT[e.result] ? RESULT_TEXT[e.result](e.r) : e.result}`;
}

function pearson(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = avg(pts.map(p => p[0])), my = avg(pts.map(p => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// ── данные ──
function stepsItemId(uid) { return store.list('item', uid).find(r => r.data.target_from === 'steps')?.id || null; }

function days(uid, n = WEEKS * 7) {
  const end = C.addDays(C.today(), -1);
  const stepsId = stepsItemId(uid);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = C.addDays(end, -i);
    const sl = C.sleep(d, uid);
    const fd = C.foodDay(d, uid);
    const wo = C.workout(d, uid);
    const st = stepsId ? Number(C.logVal(d, stepsId, uid)) : NaN;
    let grade = null;
    try { grade = C.dayGrade(d, uid)?.score ?? null; } catch (e) { grade = null; }
    // кофе после 14:00 и алкоголь за день — для сравнения со сном следующей ночи
    let coffeeLate = null, alcohol = null, coffeeMany = null;
    const recs = store.byDate('food', d, uid);
    if (recs.length) {
      coffeeLate = 0; alcohol = 0;
      for (const r of recs) {
        const names = r.data.items?.length ? r.data.items.map(x => [x.name, x.group]) : [[r.data.text, null]];
        const flags = new Set(names.flatMap(([nm, g]) => [...C.foodFlags(nm, g)]));
        if (flags.has('alcohol')) alcohol = 1;
        if (flags.has('coffee') && (C.toMin(r.data.time) ?? 0) >= 14 * 60) coffeeLate = 1;
      }
    }
    // чашки из чек-листа: кофеин после 14:00 (кофе или чай) и «много кофе» - 3 чашки и больше
    const cp = C.cups(d, uid);
    if (cp.tracked) {
      coffeeLate = (coffeeLate || 0) || (cp.late ? 1 : 0);
      coffeeMany = (cp.coffee || 0) >= 3 ? 1 : 0;
    }
    // добавки: кофеин (предтрен, таблетки) после 14:00 - тоже поздний кофеин; принятые за день - для сравнения со сном
    const suppOn = SP.enabled(uid);
    if (suppOn && SP.caffeineLate(d, uid) > 0) coffeeLate = 1;
    const supps = suppOn ? SP.takenKeys(d, uid) : null;
    const si = sl ? C.sleepInfo(sl, uid) : null;
    const sleepy = C.stateOf(d, uid)?.sleepy;
    out.push({
      date: d, sleep: si?.hours ?? null, sleepScore: si?.score ?? null, coffeeLate, coffeeMany, alcohol, grade, supps,
      protein: fd?.calculated ? fd.p : null, kcal: fd?.calculated ? fd.kcal : null, late: fd ? fd.late.length : null,
      steps: st > 0 ? st : null, workout: wo && wo.data.variant !== 'moved' ? (wo.data.done ? 1 : 0) : 0,
      cheat: C.dayType(d, uid) === 'cheat' ? 1 : 0,
      sleepy: sleepy ? { none: 0, some: 1, strong: 2 }[sleepy] ?? null : null,
      act: store.byDate('activity', d, uid).reduce((a, r) => a + (Number(r.data.minutes) || 0), 0),
    });
  }
  return out;
}

// недели (пн–вс), только завершённые: признаки + изменение веса/талии/руки к следующей неделе
function weeks(uid) {
  const ds = days(uid, WEEKS * 7 + 7);
  const thisMon = C.mondayOf(C.today());
  const ws = C.weights(uid);
  const meas = C.measures(uid);
  const byMon = new Map();
  for (const d of ds) {
    const m = C.mondayOf(d.date);
    if (m >= thisMon) continue;
    if (!byMon.has(m)) byMon.set(m, []);
    byMon.get(m).push(d);
  }
  const wAvg = m => avg(ws.filter(p => p.date >= m && p.date <= C.addDays(m, 6)).map(p => p.w));
  const change = (key, m) => {
    const val = r => key === 'arm' ? avg([Number(r.data.arm_l) || null, Number(r.data.arm_r) || null]) : Number(r.data[key]) || null;
    const end = C.addDays(m, 6), nxt = C.addDays(m, 13), from = C.addDays(m, -14);
    const before = meas.filter(r => r.date >= from && r.date <= end && val(r)).map(val);
    const after = meas.filter(r => r.date > end && r.date <= nxt && val(r)).map(val);
    return before.length && after.length ? after[after.length - 1] - before[before.length - 1] : null;
  };
  const w0 = ws.length ? ws[ws.length - 1].w : Number(store.get(`profile:${uid}`)?.data?.weight) || null;
  return [...byMon.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-WEEKS).map(([m, dd]) => {
    const wNow = wAvg(m), wNext = wAvg(C.addDays(m, 7));
    const p = avg(dd.map(d => d.protein));
    let grade = null;
    try { grade = C.weekSummary(m, uid)?.score ?? null; } catch (e) { grade = null; }
    return {
      monday: m,
      f: { sleep_h: avg(dd.map(d => d.sleep)), steps: avg(dd.map(d => d.steps)), workouts: dd.reduce((a, d) => a + d.workout, 0),
        protein_gkg: p != null && (wNow || w0) ? p / (wNow || w0) : null, cheat_days: dd.reduce((a, d) => a + d.cheat, 0),
        activity_min: dd.reduce((a, d) => a + d.act, 0), late_meals: dd.reduce((a, d) => a + (d.late || 0), 0) },
      r: { d_weight: wNow != null && wNext != null ? wNext - wNow : null, d_waist: change('waist', m), d_arm: change('arm', m), grade },
    };
  });
}

// ── выводы ──
function splitCompare(pairs, thr) {
  const hi = pairs.filter(p => p[0] >= thr).map(p => p[1]), lo = pairs.filter(p => p[0] < thr).map(p => p[1]);
  return { hi: avg(hi), lo: avg(lo), nHi: hi.length, nLo: lo.length };
}

function sleepVsGrade(ds) {
  const pairs = ds.filter(d => d.sleep != null && d.grade != null).map(d => [d.sleep, d.grade]);
  const n = pairs.length;
  const title = 'Сон и следующий день';
  if (n < MIN_DAYS) return { title, text: `Мало данных: ночей с записанным сном и оценкой дня - ${n}. Нужно ещё ${MIN_DAYS - n}, чтобы сравнивать.`, strength: 'few', n };
  const c = splitCompare(pairs, 7);
  if (c.nHi < 3 || c.nLo < 3) return { title, text: `За ${daysWord(n)} почти все ночи ${c.nHi < 3 ? 'короче' : 'не короче'} 7 часов - сравнить не с чем.`, strength: 'few', n };
  const diff = c.hi - c.lo, r = pearson(pairs);
  return { title, n, strength: strengthOf(r, n, MIN_DAYS),
    text: `По твоим данным за ${daysWord(n)}: после сна от 7 часов оценка дня в среднем ${num(c.hi)}, после короткого - ${num(c.lo)}`
      + ` (${c.nHi} и ${c.nLo} ночей). ${Math.abs(diff) < 4 ? 'Разница небольшая.' : diff > 0 ? 'Выспавшись, ты проводишь день лучше.' : 'Любопытно: после короткого сна дни у тебя не хуже.'}` };
}

// сон прошедшей ночи (записан на день пробуждения) → сонливость в этот же день: доля дней «клонит в сон»
function sleepVsSleepy(ds) {
  const title = 'Сон и сонливость днём';
  const pairs = ds.filter(d => d.sleep != null && d.sleepy != null).map(d => [d.sleep, d.sleepy]);
  const n = pairs.length;
  if (!ds.some(d => d.sleepy != null)) return null;               // пункт ещё не отмечали - молчим
  if (n < MIN_DAYS) return { title, n, strength: 'few', text: `Мало данных: дней, где отмечены и сон, и сонливость, - ${n}. Нужно ещё ${MIN_DAYS - n}.` };
  const share = xs => Math.round(xs.filter(v => v >= 1).length / xs.length * 100);
  const hi = pairs.filter(p => p[0] >= 7).map(p => p[1]), lo = pairs.filter(p => p[0] < 7).map(p => p[1]);
  if (hi.length < 3 || lo.length < 3) {
    const all = share(pairs.map(p => p[1]));
    return { title, n, strength: 'few', text: `Сонливость днём - ${all} % дней из ${n}. Сравнить короткие и длинные ночи пока не с чем: почти все ночи ${hi.length < 3 ? 'короче' : 'не короче'} 7 часов.`
      + (hi.length >= 3 && all >= 50 ? ' Сна хватает, а в сон клонит часто - посмотри на качество сна, кофе после обеда и тяжёлый обед; если так неделями, стоит обсудить с врачом.' : '') };
  }
  const a = share(hi), b = share(lo), d = b - a;
  return { title, n, strength: d >= 30 ? 'moderate' : d >= 15 ? 'weak' : 'none',
    text: `После ночей от 7 часов в сон днём клонило в ${a} % дней, после коротких - в ${b} % (${hi.length} и ${lo.length} дней). `
      + (d >= 15 ? 'Дневная сонливость у тебя идёт от недосыпа - лучшее средство ложиться раньше, а не ещё кофе.'
        : a >= 50 ? 'Сонливость бывает и после нормального сна - дело может быть в качестве сна, еде или кофеине; если так неделями, стоит обсудить с врачом.'
        : 'Заметной связи с длиной сна нет.') };
}

function lateVsSleep(ds) {
  const title = 'Поздняя еда и сон';
  const pairs = [];
  for (let i = 0; i < ds.length - 1; i++) if (ds[i].late != null && ds[i + 1].sleep != null) pairs.push([ds[i].late > 0 ? 1 : 0, ds[i + 1].sleep]);
  const n = pairs.length;
  const late = pairs.filter(p => p[0]).map(p => p[1]), early = pairs.filter(p => !p[0]).map(p => p[1]);
  if (n < MIN_DAYS || late.length < 2 || early.length < 2) return { title, n, strength: 'few',
    text: late.length < 2 && n >= MIN_DAYS ? `${late.length ? 'Поздняя еда была всего один раз' : 'Поздней еды не было ни разу'} за ${daysWord(n)} - сравнивать не с чем. Хорошая привычка.`
      : `Мало данных: нужны дни и с поздней едой, и без неё, со сном на следующую ночь (сейчас ${n}).` };
  const d = avg(late) - avg(early);
  return { title, n, strength: Math.abs(d) >= 0.5 ? 'moderate' : Math.abs(d) >= 0.25 ? 'weak' : 'none',
    text: `После поздней еды сон в среднем ${dec(avg(late))} ч, в остальные ночи - ${dec(avg(early))} ч (${late.length} и ${early.length} ночей). `
      + (Math.abs(d) < 0.25 ? 'Заметной разницы нет.' : d < 0 ? 'Поздний ужин, похоже, крадёт сон.' : 'На сон поздняя еда у тебя не влияет.') };
}

// Кофе после 14:00 / алкоголь → сон следующей ночи: длительность и качество (0–100).
// Сон записан на день пробуждения, поэтому «следующая ночь» для дня i — запись сна дня i+1.
// добавки, которые могут влиять на сон (магний, мелатонин, глицин…): ночи после дней с приёмом и без.
// Честно: это наблюдение по твоим дням, а не доказательство - в тексте так и сказано.
function suppVsSleep(ds, uid) {
  const out = [];
  for (const s of SP.plan(uid)) {
    if (!s.item?.sleep_related || (s.item.caffeine_mg || 0) > 0) continue;
    const key = `supp_${s.key}`;
    const rows = ds.map(x => ({ ...x, [key]: x.supps ? (x.supps.has(s.key) ? 1 : 0) : null }));
    const r = substanceVsSleep(rows, key, `${s.name} и сон`, `с приёмом «${s.name}»`,
      { bad: 'После дней с приёмом сон хуже - стоит обсудить с врачом, нужна ли добавка.',
        good: 'После дней с приёмом сон лучше. Это твоё наблюдение, а не доказательство: влиять могло и другое (нагрузка, стресс, время отбоя).', ok: 'Заметной разницы по твоим данным нет - это нормально: у многих добавок эффект небольшой.' });
    if (r) out.push(r);
  }
  return out;
}

function substanceVsSleep(ds, key, title, what, verdicts) {
  const pairs = [];
  for (let i = 0; i < ds.length - 1; i++) if (ds[i][key] != null && ds[i + 1].sleep != null) pairs.push([ds[i][key], ds[i + 1].sleep, ds[i + 1].sleepScore]);
  const yes = pairs.filter(p => p[0]), no = pairs.filter(p => !p[0]);
  const n = pairs.length;
  if (!yes.length) return null;                                    // не было ни разу — нечего сравнивать
  if (n < MIN_DAYS || yes.length < 2 || no.length < 2) return { title, n, strength: 'few',
    text: `Мало данных: нужны дни и ${what}, и без, с записанным сном на следующую ночь (сейчас ${yes.length} и ${no.length}).` };
  const dh = avg(yes.map(p => p[1])) - avg(no.map(p => p[1]));
  const ys = yes.map(p => p[2]).filter(x => x != null), ns = no.map(p => p[2]).filter(x => x != null);
  const dq = ys.length && ns.length ? avg(ys) - avg(ns) : null;
  const bad = dh <= -0.25 || (dq != null && dq <= -5);
  // verdicts.good - для того, что может и помогать (добавки для сна): улучшение тоже называем
  const good = !bad && verdicts.good && (dh >= 0.25 || (dq != null && dq >= 5));
  const strength = good ? (dh >= 0.5 || (dq != null && dq >= 10) ? 'moderate' : 'weak')
    : dh <= -0.5 || (dq != null && dq <= -10) ? 'moderate' : bad ? 'weak' : 'none';
  return { title, n, strength,
    text: `После дней ${what} сон в среднем ${dec(avg(yes.map(p => p[1])))} ч`
      + (dq != null ? ` (качество ${num(avg(ys))})` : '') + `, в остальные ночи - ${dec(avg(no.map(p => p[1])))} ч`
      + (dq != null ? ` (${num(avg(ns))})` : '') + ` - ${yes.length} и ${no.length} ночей. ` + (bad ? verdicts.bad : good ? verdicts.good : verdicts.ok) };
}

const WEEK_PAIRS = [
  ['protein_gkg', 'd_weight', 'Белок и вес'], ['steps', 'd_weight', 'Шаги и вес'], ['protein_gkg', 'd_waist', 'Белок и талия'],
  ['workouts', 'd_waist', 'Тренировки и талия'], ['workouts', 'd_arm', 'Тренировки и объём руки'], ['sleep_h', 'd_weight', 'Сон и вес'],
];

function weekly(ws) {
  const out = [];
  for (const [f, r, title] of WEEK_PAIRS) {
    const pts = ws.filter(w => w.f[f] != null && w.r[r] != null).map(w => [w.f[f], w.r[r]]);
    const n = pts.length;
    if (n < MIN_WEEKS) {
      // про замеры молчим, если их нет вообще, — иначе список превратится в перечень «мало данных»
      if (n === 0 && r !== 'd_weight') continue;
      out.push({ title, n, strength: 'few', text: `Недель, где записаны и ${FEATURE_WHAT[f]}, и ${r === 'd_weight' ? 'вес' : 'замеры'}: ${n}. Нужно ещё ${weeksWord(MIN_WEEKS - n)}.` });
      continue;
    }
    const rr = pearson(pts);
    const st = strengthOf(rr, n);
    out.push({ title, n, strength: st, r: rr,
      text: st === 'none' || rr == null ? `По твоим данным за ${weeksWord(n)} связи не видно.`
        : `По твоим данным за ${weeksWord(n)}: ${effectText({ feature: f, result: r, r: rr })}.` });
  }
  return out;
}

function cheatVsGrade(ws) {
  const title = 'Читмилы и неделя';
  const pts = ws.filter(w => w.r.grade != null);
  const w1 = pts.filter(w => w.f.cheat_days > 0).map(w => w.r.grade), w0 = pts.filter(w => !w.f.cheat_days).map(w => w.r.grade);
  if (!w1.length) return null;                     // читмилов не было — не о чем говорить
  if (pts.length < MIN_WEEKS || !w0.length) return { title, n: pts.length, strength: 'few', text: `Мало данных для сравнения недель с читмилами и без (${weeksWord(pts.length)}).` };
  const d = avg(w1) - avg(w0);
  return { title, n: pts.length, strength: Math.abs(d) >= 10 ? 'moderate' : Math.abs(d) >= 5 ? 'weak' : 'none',
    text: `Недели с читмилом: оценка в среднем ${num(avg(w1))}, без - ${num(avg(w0))} (${w1.length} и ${w0.length}). `
      + (Math.abs(d) < 5 ? 'Один читмил неделю не портит.' : d < 0 ? 'Читмил тянет за собой всю неделю - может, делать его реже.' : 'Читмилы тебе не мешают.') };
}

// → [{ title, text, strength: strong|moderate|weak|none|few, n }], сначала самые заметные
export function insights(uid = store.uid()) {
  const ds = days(uid), ws = weeks(uid);
  const list = [sleepVsGrade(ds), sleepVsSleepy(ds), lateVsSleep(ds),
    substanceVsSleep(ds, 'coffeeLate', 'Кофе и чай после обеда и сон', 'с кофе или чаем после 14:00',
      { bad: 'Похоже, дневной кофеин мешает тебе спать - попробуй последнюю чашку до 14:00.', ok: 'На сон это у тебя заметно не влияет.' }),
    substanceVsSleep(ds, 'coffeeMany', 'Сколько кофе и сон', 'с 3 и более чашками кофе',
      { bad: 'В дни с тремя и больше чашками кофе ты спишь хуже - попробуй остановиться на двух.', ok: 'Количество кофе на сон у тебя заметно не влияет.' }),
    substanceVsSleep(ds, 'alcohol', 'Алкоголь и сон', 'с алкоголем',
      { bad: 'Алкоголь съедает сон - даже если заснуть легче, восстанавливаешься хуже.', ok: 'Заметной разницы по твоим данным нет.' }),
    ...suppVsSleep(ds, uid),
    ...weekly(ws), cheatVsGrade(ws)].filter(Boolean);
  const rank = { strong: 0, moderate: 1, weak: 2, none: 3, few: 4 };
  return list.sort((a, b) => rank[a.strength] - rank[b.strength]);
}

// ── сравнение с сервером (по кнопке; ответ хранится в meta, чтобы был виден и без сети) ──
let loading = false;
export async function compare() {
  if (loading) return;
  loading = true; S.render();
  try {
    const res = await store.api('/api/brain/insights?refresh=1');
    await store.setMeta('brain_insights', { ...res, at: Date.now() });
  } catch (e) {
    toast(e.status === 0 ? 'Нужна связь с сервером' : e.status === 404 ? 'На сервере этого ещё нет - обновите сервер' : e.message);
  } finally { loading = false; S.render(); }
}

function serverBlock() {
  const r = store.getMeta('brain_insights', null);
  const btn = `<button class="btn quiet" data-act="an-compare" ${loading ? 'disabled' : ''}>${loading ? 'Считаю…' : r ? 'Обновить с сервера' : 'Точнее с сервером'}</button>`;
  if (!r) return `<div class="actions an-actions">${btn}<span class="note">полгода истории и сравнение с людьми твоего типа</span></div>`;
  const eff = (e, i) => `<li class="an-e an-${strengthOf(e.r, e.n)}"><span>${esc(effectText(e))}</span><span class="mono muted">r ${dec(e.r, 2)} · ${e.n} нед.</span></li>`;
  const own = (r.own?.effects || []).filter(e => strengthOf(e.r, e.n) !== 'none').slice(0, 4);
  const avgLine = g => ['sleep_h', 'steps', 'protein_gkg', 'workouts'].filter(k => g.avg?.[k] != null && r.own?.avg?.[k] != null)
    .map(k => `${FEATURE_NAME[k]}: у тебя ${k === 'steps' ? num(r.own.avg[k]) : dec(r.own.avg[k])}, в группе ${k === 'steps' ? num(g.avg[k]) : dec(g.avg[k])}`).join(' · ');
  return `<div class="an-server">
    <div class="smallcaps muted">С сервера · ${esc(new Date(r.at).toLocaleDateString('ru', { day: 'numeric', month: 'short' }))}</div>
    ${r.own?.weeks ? `<p class="note">Твоя история: ${weeksWord(r.own.weeks)}.</p>` : ''}
    ${own.length ? `<ul class="an-list">${own.map(eff).join('')}</ul>` : '<p class="note">Заметных связей в твоей истории пока нет.</p>'}
    ${(r.groups || []).map(g => `<div class="an-group"><div class="an-gt"><b>${esc(g.label)}</b> <span class="mono muted">${g.users} чел. · ${g.weeks} нед.</span></div>
      ${avgLine(g) ? `<p class="note">${esc(avgLine(g))}</p>` : ''}
      <ul class="an-list">${g.effects.filter(e => strengthOf(e.r, e.n) !== 'none').slice(0, 4).map(eff).join('') || '<li class="note">Заметных связей нет.</li>'}</ul></div>`).join('')}
    ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
    <div class="actions an-actions">${btn}</div></div>`;
}

// блок для экрана «Прогресс»
export function renderInsights(uid = store.uid()) {
  let list = [];
  try { list = insights(uid); } catch (e) { console.warn(e); }
  // выводы — отдельными карточками; всё, где пока «мало данных», — одной сводной, чтобы не было стены одинаковых блоков
  const shown = list.filter(x => x.strength !== 'few').slice(0, 6), few = list.filter(x => x.strength === 'few');
  const card = x => `<li class="an-i an-${x.strength}"><div class="an-h"><b>${esc(x.title)}</b><span class="smallcaps muted">${STRENGTH_RU[x.strength]}</span></div><p>${esc(x.text)}</p></li>`;
  const fewCard = few.length ? `<li class="an-i an-few"><div class="an-h"><b>Пока мало данных</b><span class="smallcaps muted">${few.length}</span></div>
    <ul class="an-few-l">${few.map(x => `<li><b>${esc(x.title)}.</b> ${esc(x.text.replace(/^Мало данных:?\s*/, ''))}</li>`).join('')}</ul></li>` : '';
  return `<div class="section an-block"><div class="section-title"><span class="smallcaps">Что на что влияет</span><span class="note">по твоим данным, без сети</span></div>
    ${shown.length || few.length ? `<ul class="an-list">${shown.map(card).join('')}${fewCard}</ul>`
      : '<p class="note">Пока нечего сравнивать - записывайте сон, еду и вес, и через пару недель здесь появятся выводы.</p>'}
    <p class="note">Это совпадения в ваших данных, а не доказанная причина: на результат влияет многое сразу.</p>
    ${serverBlock()}</div>`;
}

export const actions = { 'an-compare': () => compare() };
