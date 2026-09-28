import * as store from '../store.js';
import * as C from '../coach.js';
import { esc, num, fmt, dayTitle, WD, profile, glyph, gradeGlyph } from '../ui.js';
import { H } from './today.js';

// Календарь — дневник здоровья с масштабами: день → неделя → месяц → квартал → год.
// Маршрут: #calendar/{scale}/{anchor}; старые ссылки #calendar/{YYYY-MM} открывают месяц.

const SCALES = [['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц'], ['quarter', 'Квартал'], ['year', 'Год']];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const z = n => String(n).padStart(2, '0');
const monthStart = d => d.slice(0, 8) + '01';
const addMonths = (d, n) => { const x = C.parse(monthStart(d)); x.setMonth(x.getMonth() + n); return C.ymd(x); };
const daysIn = d => new Date(+d.slice(0, 4), +d.slice(5, 7), 0).getDate();
const dec = n => String(Math.round(n * 10) / 10).replace('.', ',');

function parseRoute() {
  const [, a, b] = location.hash.slice(1).split('/');
  const t = C.today();
  if (/^\d{4}-\d{2}$/.test(a || '')) return { scale: 'month', anchor: `${a}-01` };
  const scale = SCALES.some(([k]) => k === a) ? a : 'month';
  return { scale, anchor: isDate(b) ? b : t };
}
function norm(scale, d) {
  if (scale === 'week') return H.mondayOf(d);
  if (scale === 'month') return monthStart(d);
  if (scale === 'quarter') { const m = Math.floor((+d.slice(5, 7) - 1) / 3) * 3 + 1; return `${d.slice(0, 4)}-${z(m)}-01`; }
  if (scale === 'year') return `${d.slice(0, 4)}-01-01`;
  return d;
}
function shift(scale, d, n) {
  if (scale === 'day') return C.addDays(d, n);
  if (scale === 'week') return C.addDays(d, 7 * n);
  if (scale === 'month') return addMonths(d, n);
  if (scale === 'quarter') return addMonths(d, 3 * n);
  return `${+d.slice(0, 4) + n}-01-01`;
}
const href = (scale, d) => `#calendar/${scale}/${d}`;

// ── данные дня (кэш на одну отрисовку) ──
let cache = new Map(), since = null;
function grade(d, uid = store.uid()) {
  const k = uid + d;
  if (!cache.has(k)) cache.set(k, d > C.today() || (uid === store.uid() && (!since || d < since)) ? { grade: 'none', score: 0, parts: {} } : H.dayGrade(d, uid));
  return uid === store.uid() ? H.shownGrade(d, cache.get(k)) : cache.get(k);
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// смысловой цвет части оценки (accents.css): атрибут data-dom или пусто
const PART_DOM = { checklist: 'coach', sleep: 'sleep', state: 'mood', food: 'food', activity: 'move', water: 'water', workouts: 'train' };
const domA = k => PART_DOM[k] ? ` data-dom="${PART_DOM[k]}"` : '';
const LETTER_G = { A: 'good', B: 'good', C: 'ok', D: 'bad', E: 'bad' };
function itemBy(pred) { return C.items().find(pred); }
function logNum(d, it) { return it ? Number(C.logVal(d, it.id)) || 0 : 0; }
function metrics(d) {
  const s = C.dayScore(d);
  const sl = H.sleepInfo(H.sleepRec(d));
  const st = H.stateRec(d)?.data;
  const acts = H.activitiesOf(d);
  const ft = H.foodTotals(d);
  const w = C.workout(d);
  const stepsIt = itemBy(i => i.data.target_from === 'steps'), waterIt = itemBy(i => i.data.target_from === 'water');
  return {
    s, sl, st, acts, ft, w, type: H.dayTypeOf(d),
    actMin: acts.reduce((a, r) => a + (Number(r.data.minutes) || 0), 0),
    steps: logNum(d, stepsIt), stepsTarget: stepsIt ? C.itemTarget(stepsIt, d) : 0,
    water: logNum(d, waterIt), waterTarget: waterIt ? C.itemTarget(waterIt, d) : 0,
  };
}

// ── общие куски ──
function head(scale, anchor, title) {
  const t = C.today();
  const cur = norm(scale, t) === anchor;
  return `<div class="head-row"><div><div class="kicker smallcaps">Дневник здоровья</div><h1>${esc(cap(title))}</h1></div>
    <div class="datenav"><a class="btn quiet" href="${href(scale, shift(scale, anchor, -1))}" aria-label="Назад">←</a>
      ${cur ? '' : `<a class="btn" href="${href(scale, norm(scale, t))}">Сегодня</a>`}
      <a class="btn quiet" href="${href(scale, shift(scale, anchor, 1))}" aria-label="Вперёд">→</a></div></div>
    <nav class="a-tabs" aria-label="Масштаб">${SCALES.map(([k, l]) => `<a href="${href(k, norm(k, pickAnchor(scale, anchor)))}" class="${k === scale ? 'on' : ''}" ${k === scale ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
}
// при переходе с крупного масштаба на мелкий — сегодня, если он внутри периода, иначе начало периода
function pickAnchor(scale, anchor) {
  const t = C.today();
  const end = C.addDays(shift(scale, anchor, 1), -1);
  return t >= anchor && t <= end ? t : anchor;
}
function legend(partner, wo = true) {
  return `<div class="legend a-legend">
    <span>${H.gradeDot('good')}хороший</span><span>${H.gradeDot('ok')}средний</span><span>${H.gradeDot('bad')}слабый</span><span>${H.gradeDot('live')}сегодня, идёт</span><span>${H.gradeDot('none')}нет данных</span>
    <span><i class="a-mk cheat"></i>читмил</span><span><i class="a-mk special"></i>особый / болею / отдых</span>
    ${wo ? '<span><i class="a-wo"></i>тренировка</span><span><i class="a-wo done"></i>сделана</span>' : ''}
    ${partner ? `<span><i class="a-pb"></i>${esc(partner.name)}</span>` : ''}</div>`;
}
function countGrades(days) {
  const c = { good: 0, ok: 0, bad: 0, none: 0, live: 0, sum: 0, n: 0, best: 0 };
  let run = 0;
  for (const d of days) {
    const g = grade(d);
    c[g.grade]++;
    if (g.grade !== 'none' && g.score !== null) { c.sum += g.score; c.n++; }
    run = g.grade === 'good' ? run + 1 : 0;
    c.best = Math.max(c.best, run);
  }
  c.avg = c.n ? Math.round(c.sum / c.n) : 0;
  return c;
}
function gradeStats(c) {
  return `<div class="a-gstats">
    <div><b class="mono g-good-t">${c.good}</b><span>хороших</span></div><div><b class="mono g-ok-t">${c.ok}</b><span>средних</span></div>
    <div><b class="mono g-bad-t">${c.bad}</b><span>слабых</span></div><div><b class="mono">${c.avg || '-'}</b><span>средний балл</span></div>
    <div><b class="mono">${c.best}</b><span>лучшая серия хороших</span></div></div>`;
}
function range(from, to) { const out = []; for (let d = from; d <= to; d = C.addDays(d, 1)) out.push(d); return out; }
const markType = type => type === 'cheat' ? 'cheat' : type ? 'special' : '';

// ════════════════ день ════════════════
function viewDay(date) {
  const m = metrics(date), g = grade(date);
  const tg = C.target();
  const prof = profile();
  const body = store.get(`body:${store.uid()}:${date}`)?.data;
  const future = date > C.today();
  const parts = g.parts || {};
  const PART = { checklist: 'чек-лист', sleep: 'сон', state: 'самочувствие', food: 'питание', activity: 'активность' };
  const sec = (title, inner, dom = '') => `<div class="a-dsec"${dom ? ` data-dom="${dom}"` : ''}><div class="smallcaps muted">${title}</div><div>${inner}</div></div>`;
  const empty = t => `<span class="empty">${t}</span>`;

  const verdict = {
    good: { soft: 'Хороший день - так держать.', coach: 'День в зачёт.', sergeant: 'Годится. Не расслабляться.' },
    ok: { soft: 'Нормальный день, есть куда расти.', coach: 'Средне. Подтяни слабые места.', sergeant: 'Середнячок. Мало.' },
    bad: { soft: 'Слабый день. Бывает - следующий будет лучше.', coach: 'Слабый день. Разберись, что помешало.', sergeant: 'Провал. Работаем над ошибками.' },
    none: { soft: 'Этот день почти пустой.', coach: 'Данных нет.', sergeant: 'Доклада не поступало.' },
    live: { soft: 'День ещё идёт - всё можно успеть.', coach: 'День в процессе. Доделывай план.', sergeant: 'День не окончен. Работаем!' },
  }[future ? 'none' : g.grade] || {};
  const who = C.TONE_NAMES[prof.tone || 'coach'];

  const sleep = m.sl ? `<span class="mono">${dec(m.sl.hours)} ч</span> · <span class="a-verdict v-${m.sl.verdict}">${esc(m.sl.label)}</span> · качество <span class="mono">${Math.round(m.sl.score)}</span>
      <div class="note">${esc(H.sleepRec(date).data.bed)}–${esc(H.sleepRec(date).data.wake)} · ${esc(H.SLEEP_Q.map(([k, , o]) => o.find(x => x[0] === H.sleepRec(date).data[k])?.[1]).filter(Boolean).join(', '))}</div>` : empty('не отмечен');
  const state = m.st?.wellbeing ? `${H.STATE_EMOJI[m.st.wellbeing] || ''} ${esc(H.STATE_Q.map(([k, l, o]) => m.st[k] ? `${l.toLowerCase()}: ${o.find(x => x[0] === m.st[k])?.[1]}` : '').filter(Boolean).join(' · '))}` : empty('не отмечено');
  // пульс в покое и HRV из «Здоровья» — рядом с самочувствием: это тот же вопрос «как восстановился»
  const vit = store.get(`vitals:${store.uid()}:${date}`)?.data;
  const vitals = vit && (vit.resting_hr || vit.hrv)
    ? `<div class="note">${vit.resting_hr ? `пульс в покое <span class="mono">${Math.round(vit.resting_hr)}</span>` : ''}${vit.resting_hr && vit.hrv ? ' · ' : ''}${vit.hrv ? `HRV <span class="mono">${Math.round(vit.hrv)}</span> мс` : ''} · из «Здоровья»</div>` : '';
  const acts = m.acts.length ? m.acts.map(r => {
    const det = H.activityDetails(r.data);
    return `<div class="a-dact"><b>${esc(H.activityName(r.data.type))}</b> · ${H.activityLine(r.data)}
      ${det.length || r.data.note ? `<dl class="a-dl">${det.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${r.data.note ? `<dt>Заметка</dt><dd>${esc(r.data.note)}</dd>` : ''}</dl>` : ''}</div>`;
  }).join('') : empty('нет');
  let wo = empty('не было');
  if (m.w) {
    const d = m.w.data, total = (d.exercises || []).reduce((a, x) => a + (x.sets || 0), 0);
    const done = (d.exercises || []).reduce((a, x) => a + (x.log || []).filter(s => s?.done).length, 0);
    wo = `<a class="link" href="#workout/${date}">${esc(d.title)}</a> · ${d.done ? '<span class="g-good-t">завершена</span>' : `подходов <span class="mono">${done}/${total}</span>`}
      ${d.variant && d.variant !== 'full' ? ` · ${H.VARIANT_NAME[d.variant] || d.variant}` : ''}`;
  }
  const routines = ['morning', 'neck', 'posture'].map(k => store.get(`routine:${store.uid()}:${date}:${k}`)).filter(Boolean)
    .map(r => `${esc(r.data.title)}: <span class="mono">${r.data.exercises.filter(x => x.done).length}/${r.data.exercises.length}</span>`).join('<br>');
  const food = m.type === 'cheat' ? `читмил - без подсчётов${m.ft.kcal ? ` · <span class="mono">${num(m.ft.kcal)}</span> ккал` : ''}`
    : m.ft.n ? `<span class="mono">${num(m.ft.kcal)}${tg ? ' / ' + num(tg.kcal) : ''}</span> ккал · Б <span class="mono">${num(m.ft.p)}</span> · Ж <span class="mono">${num(m.ft.f)}</span> · У <span class="mono">${num(m.ft.c)}</span>
      <div class="note">записей: ${m.ft.n}${tg && m.ft.kcal ? ` · ${Math.abs(m.ft.kcal - tg.kcal) <= tg.kcal * 0.1 ? 'в норме' : m.ft.kcal > tg.kcal ? 'выше нормы' : 'ниже нормы'}` : ''}</div>` : empty('не записано');
  const BODY = [['weight', 'вес', 'кг'], ['neck', 'шея'], ['chest', 'грудь'], ['waist', 'талия'], ['belly', 'живот'], ['hips', 'бёдра'], ['arm_l', 'рука Л'], ['arm_r', 'рука П'], ['thigh_l', 'бедро Л'], ['thigh_r', 'бедро П'], ['calf_l', 'голень Л'], ['calf_r', 'голень П']];
  const meas = body ? BODY.filter(([k]) => body[k]).map(([k, l, u]) => `${l} <span class="mono">${dec(Number(body[k]))}</span> ${u || 'см'}`).join(' · ') : '';

  return `${head('day', date, fmt(date, { weekday: 'long', day: 'numeric', month: 'long' }))}
    <div class="a-dhead">
      <span class="a-gbig g-${future ? 'none' : g.grade}">${future ? 'впереди' : H.GRADE_NAME[g.grade]}${!future && g.grade !== 'none' && g.score !== null ? ` <b class="mono">${Math.round(g.score)}</b>` : ''}</span>
      ${m.type ? `<span class="chip"><i class="a-mk ${markType(m.type)}"></i>${esc(H.DAY_TYPE_NAME[m.type])}</span>` : ''}
      ${!future ? `<span class="chip">чек-лист <span class="mono">${m.s.pct}%</span></span>` : ''}
    </div>
    <div class="coach inset ${g.grade === 'good' ? 'praise' : g.grade === 'bad' ? 'scold' : 'info'}"><div class="who smallcaps">${who}</div><q>${esc(verdict[prof.tone || 'coach'] || verdict.coach)}</q>
      ${Object.keys(parts).length ? `<div class="a-parts">${Object.entries(parts).map(([k, v]) => `<div${domA(k)}><span class="smallcaps muted">${PART[k] || k}</span><div class="groove"><div class="fill" style="width:${Math.max(0, Math.min(100, v))}%"></div></div></div>`).join('')}</div>` : ''}</div>
    <div class="a-diary">
      ${sec('Сон', sleep, 'sleep')}${sec('Самочувствие', state + vitals, 'mood')}${sec('Активности', acts, 'move')}
      ${sec('Тренировка', wo + (routines ? `<div class="note">${routines}</div>` : ''), 'train')}
      ${sec('Питание', food, 'food')}
      ${sec('Вода и шаги', `${m.waterTarget ? `вода <span class="mono">${m.water}/${m.waterTarget}</span> ст.` : ''}${m.waterTarget && m.stepsTarget ? ' · ' : ''}${m.stepsTarget ? `шаги <span class="mono">${num(m.steps)}</span> из <span class="mono">${num(m.stepsTarget)}</span>` : ''}` || empty('-'), 'water')}
      ${meas ? sec('Замеры', meas, 'goal') : ''}
    </div>
    <div class="actions"><a class="btn solid" href="#day/${date}">${future ? 'Открыть день' : 'Изменить день'} <span class="arrow">→</span></a>
      <a class="btn quiet" href="#food/${date}">Питание</a>${m.w ? `<a class="btn quiet" href="#workout/${date}">Тренировка</a>` : ''}</div>`;
}

// ════════════════ неделя ════════════════
function weekSummaryLocal(monday) {
  const days = range(monday, C.addDays(monday, 6)).filter(d => d <= C.today());
  const gs = days.map(d => grade(d)).filter(g => g.grade !== 'none');
  const score = gs.length ? Math.round(gs.reduce((a, g) => a + g.score, 0) / gs.length) : 0;
  const L = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'E';
  return { score, grade: gs.length ? L : '-', emoji: '', parts: null };
}
function viewWeek(monday) {
  const days = range(monday, C.addDays(monday, 6));
  const sum = H.safe(() => C.weekSummary?.(monday), () => weekSummaryLocal(monday));
  const tg = C.target();
  const PARTS = { activity: 'активность', sleep: 'сон', food: 'питание', water: 'вода', state: 'самочувствие', workouts: 'тренировки' };
  const rows = days.map(d => {
    const future = d > C.today(), g = grade(d);
    if (future) return `<a class="a-wrow future" href="${href('day', d)}"><span class="a-wd"><b>${WD[(C.parse(d).getDay() + 6) % 7]}</b><span class="mono">${+d.slice(8)}</span></span>${H.gradeDot('none')}<span class="note">впереди${C.workout(d) ? ' · тренировка по плану' : ''}</span></a>`;
    const m = metrics(d);
    const cell = (label, val, cls = '', dom = '') => `<span class="a-met ${cls}"${dom ? ` data-dom="${dom}"` : ''}><span class="smallcaps muted">${label}</span><span class="mono">${val}</span></span>`;
    return `<a class="a-wrow ${d === C.today() ? 'today' : ''}" href="${href('day', d)}">
      <span class="a-wd"><b>${WD[(C.parse(d).getDay() + 6) % 7]}</b><span class="mono">${+d.slice(8)}</span></span>
      <span class="a-wg">${H.gradeDot(g.grade)}<span class="mono">${g.score === null || g.grade === 'none' ? '-' : Math.round(g.score)}</span>${m.type ? `<i class="a-mk ${markType(m.type)}" title="${esc(H.DAY_TYPE_NAME[m.type])}"></i>` : ''}</span>
      <span class="a-mets">
        ${cell('сон', m.sl ? dec(m.sl.hours) + ' ч' : '-', m.sl?.verdict === 'short' ? 'warn' : '', 'sleep')}
        ${cell('чек-лист', m.s.total ? m.s.pct + '%' : '-', '', 'coach')}
        ${cell('трен.', m.w ? (m.w.data.done ? glyph('check') : glyph('cross')) : '-', m.w && !m.w.data.done ? 'warn' : '', 'train')}
        ${cell('ккал', m.type === 'cheat' ? 'чит' : m.ft.kcal ? num(m.ft.kcal) : '-', tg && m.ft.kcal > tg.kcal * 1.1 && m.type !== 'cheat' ? 'warn' : '', 'food')}
        ${cell('шаги', m.steps ? num(m.steps) : '-', '', 'move')}
        ${cell('актив.', m.actMin ? m.actMin + ' мин' : '-', '', 'move')}
        ${cell('сост.', m.st?.wellbeing ? H.STATE_EMOJI[m.st.wellbeing] : '-', '', 'mood')}
      </span></a>`;
  }).join('');
  const c = countGrades(days);
  const end = C.addDays(monday, 6);
  const title = monday.slice(0, 7) === end.slice(0, 7)
    ? `${+monday.slice(8)}–${fmt(end, { day: 'numeric', month: 'long' })}` : `${fmt(monday, { day: 'numeric', month: 'short' }).replace('.', '')} – ${fmt(end, { day: 'numeric', month: 'short' }).replace('.', '')}`;
  return `${head('week', monday, title)}
    <div class="raised a-card a-wsum">
      ${sum.grade ? `<div class="a-wgrade"><b class="g-${LETTER_G[sum.grade] || 'none'}-t">${esc(sum.grade)}</b><span aria-hidden="true">${gradeGlyph(sum.grade)}</span></div>` : ''}
      <div class="a-grow"><div class="smallcaps muted">${sum.grade ? `Итог недели · балл <span class="mono">${sum.score}</span>` : sum.started ? 'Неделя только началась - оценка появится завтра' : 'Итог недели'}</div>
        ${sum.parts ? `<div class="a-parts">${Object.entries(sum.parts).filter(([, v]) => typeof v === 'number').map(([k, v]) => `<div${domA(k)}><span class="smallcaps muted">${PARTS[k] || k}</span><div class="groove"><div class="fill" style="width:${Math.max(0, Math.min(100, v))}%"></div></div></div>`).join('')}</div>`
          : `<p class="note a-tight">хороших ${c.good} · средних ${c.ok} · слабых ${c.bad}</p>`}</div></div>
    <div class="a-week">${rows}</div>
    ${legend()}
    <p class="note">Нажмите на день, чтобы открыть дневник.</p>`;
}

// ════════════════ месяц ════════════════
function monthGrid(first, { mini = false, partner = null } = {}) {
  const off = (C.parse(first).getDay() + 6) % 7;
  const n = daysIn(first), t = C.today();
  let cells = mini ? '' : WD.map(w => `<div class="dow smallcaps">${w}</div>`).join('');
  for (let i = 0; i < off; i++) cells += '<span class="a-cell pad"></span>';
  for (let i = 1; i <= n; i++) {
    const d = first.slice(0, 8) + z(i);
    const g = grade(d), future = d > t;
    const type = !future ? H.dayTypeOf(d) : null;
    const w = C.workout(d);
    const tip = `${dayTitle(d)} - ${future ? 'впереди' : H.GRADE_NAME[g.grade]}${type ? ', ' + H.DAY_TYPE_NAME[type] : ''}`;
    if (mini) {
      cells += `<a class="a-cell g-${g.grade} ${future ? 'future' : ''} ${d === t ? 'today' : ''}" href="${href('day', d)}" title="${esc(tip)}" aria-label="${esc(tip)}">${type ? `<i class="a-mk ${markType(type)}"></i>` : ''}</a>`;
      continue;
    }
    const pg = partner && !future ? grade(d, partner.id) : null;
    const pp = partner && !future ? C.pctOf(d, partner.id) : 0;
    cells += `<a class="a-day g-${g.grade} ${future ? 'future' : ''} ${d === t ? 'today' : ''}" href="${href('day', d)}" title="${esc(tip)}" aria-label="${esc(tip)}">
      <span class="n mono">${i}</span>${type ? `<i class="a-mk ${markType(type)}"></i>` : ''}
      <span class="marks">${w ? `<i class="a-wo ${w.data.done ? 'done' : ''}"></i>` : ''}${pg && (pg.grade !== 'none' || pp) ? `<span class="a-pbar"><i class="g-${pg.grade}" style="width:${Math.max(pp, pg.score || 0, 12)}%"></i></span>` : ''}</span></a>`;
  }
  return `<div class="${mini ? 'a-mgrid' : 'a-cal'}">${cells}</div>`;
}
function monthStats(from, to) {
  const days = range(from, to < C.today() ? to : C.today());
  let woP = 0, woD = 0, actMin = 0, sleepSum = 0, sleepN = 0;
  for (const d of range(from, to)) { const w = C.workout(d); if (w && d <= C.today()) { woP++; if (w.data.done) woD++; } }
  for (const d of days) {
    actMin += H.activitiesOf(d).reduce((a, r) => a + (Number(r.data.minutes) || 0), 0);
    const s = H.sleepInfo(H.sleepRec(d)); if (s) { sleepSum += s.hours; sleepN++; }
  }
  return { c: countGrades(days), woP, woD, actMin, sleep: sleepN ? sleepSum / sleepN : null };
}
function statChips(st) {
  return `<div class="stats a-statrow"><span class="chip">тренировок <span class="mono">${st.woD}/${st.woP}</span></span>
    <span class="chip">активности <span class="mono">${num(st.actMin)}</span> мин</span>
    ${st.sleep ? `<span class="chip">сон в среднем <span class="mono">${dec(st.sleep)}</span> ч</span>` : ''}</div>`;
}
function viewMonth(first) {
  const partner = store.partners()[0];
  const last = first.slice(0, 8) + z(daysIn(first));
  const st = monthStats(first, last);
  const title = `${MONTHS[+first.slice(5, 7) - 1]} ${first.slice(0, 4)}`;
  return `${head('month', first, title)}
    ${gradeStats(st.c)}${statChips(st)}
    <div style="margin-top:16px">${monthGrid(first, { partner })}</div>
    ${legend(partner)}`;
}

// ════════════════ квартал и год ════════════════
function viewQuarter(first) {
  const last = C.addDays(addMonths(first, 3), -1);
  const st = monthStats(first, last);
  const q = Math.floor((+first.slice(5, 7) - 1) / 3) + 1;
  const months = [0, 1, 2].map(i => addMonths(first, i));
  return `${head('quarter', first, `${q}-й квартал ${first.slice(0, 4)}`)}
    ${gradeStats(st.c)}${statChips(st)}
    <div class="a-months q">${months.map(m => {
      const c = countGrades(range(m, m.slice(0, 8) + z(daysIn(m))).filter(d => d <= C.today()));
      return `<div class="a-month"><a class="a-mtitle-l" href="${href('month', m)}">${MONTHS[+m.slice(5, 7) - 1]}</a>
        <div class="a-mdow">${WD.map(w => `<span>${w[0]}</span>`).join('')}</div>${monthGrid(m, { mini: true })}
        <div class="note a-mnote">${c.good + c.ok + c.bad ? `<span class="g-good-t" title="хороших">${c.good}</span> · <span class="g-ok-t" title="средних">${c.ok}</span> · <span class="g-bad-t" title="слабых">${c.bad}</span>` : '<span class="muted">нет данных</span>'}</div></div>`;
    }).join('')}</div>
    ${legend(null, false)}`;
}
function viewYear(first) {
  const last = `${first.slice(0, 4)}-12-31`;
  const st = monthStats(first, last);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(first, i));
  const streak = C.streaks();
  return `${head('year', first, `${first.slice(0, 4)} год`)}
    ${gradeStats(st.c)}${statChips(st)}
    <p class="note a-tight">Серия по чек-листу: сейчас ${streak.current} дн., рекорд ${streak.best} дн.</p>
    <div class="a-months y">${months.map(m => `<div class="a-month"><a class="a-mtitle-l" href="${href('month', m)}">${MONTHS[+m.slice(5, 7) - 1].slice(0, 3)}</a>${monthGrid(m, { mini: true })}</div>`).join('')}</div>
    ${legend(null, false)}`;
}

function viewCalendar() {
  cache = new Map();
  since = C.firstDay() || C.today();
  for (const k of ['sleep', 'state', 'activity', 'daytype']) for (const r of store.list(k)) if (r.date && r.date < since) since = r.date;
  const { scale, anchor } = parseRoute();
  const a = norm(scale, anchor);
  if (scale === 'day') return viewDay(a);
  if (scale === 'week') return viewWeek(a);
  if (scale === 'quarter') return viewQuarter(a);
  if (scale === 'year') return viewYear(a);
  return viewMonth(a);
}

export const actions = {};
export const routes = { calendar: () => viewCalendar() };
