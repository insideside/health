import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import { S, esc, fmt, dayTitle, WD, profile, CHECK, toast, field, select, input, openModal, closeModal, techHtml, jobFor, addJob, dateNav, afterChange, routeArg } from '../ui.js';
import { H } from './today.js';
import * as PF from '../prefs.js';
import { exActions } from './fit.js';

// Тренировка дня, программа, генератор «на любой случай», недельный баланс.

const WEIGHTED = new Set(['dumbbells', 'barbell', 'machine', 'cable', 'kettlebell']);
const FOCUS = [['full', 'всё тело'], ['upper', 'верх'], ['lower', 'низ'], ['core', 'пресс'], ['cardio', 'кардио'], ['recovery', 'восстановление'], ['quick', 'бодрость']];
const FOCUS_NAME = Object.fromEntries(FOCUS);
const $rest = document.getElementById('rest');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

const SCENARIOS_LOCAL = [
  { id: 'before_work', title: '15 минут перед работой', minutes: 15, focus: 'quick', note: 'Проснуться и размяться, без пота и душа.' },
  { id: 'travel', title: 'В командировке без инвентаря', minutes: 25, focus: 'full', note: 'Только вес тела, тихо - можно в гостинице.' },
  { id: 'recovery', title: 'Восстановление', minutes: 20, focus: 'recovery', note: 'Мобильность и растяжка после тяжёлого дня.' },
  { id: 'cardio', title: 'Кардио дома', minutes: 25, focus: 'cardio', note: 'Пульс вверх без прыжков по соседям.' },
  { id: 'upper', title: 'Верх тела', minutes: 30, focus: 'upper', note: 'Грудь, спина, плечи и руки.' },
  { id: 'lower', title: 'Ноги и ягодицы', minutes: 30, focus: 'lower', note: 'Приседания, выпады, мосты.' },
  { id: 'abs', title: 'Пресс', minutes: 15, focus: 'core', note: 'Кор и стабилизация.' },
];
const scenarios = () => (Array.isArray(P.SCENARIOS) && P.SCENARIOS.length ? P.SCENARIOS : SCENARIOS_LOCAL);

// ── тренировка ──
function prevPerformance(exId, date) {
  const ws = store.list('workout', store.uid(), r => r.date < date && r.data.exercises?.some(x => x.id === exId && x.log?.some(s => s?.done)))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!ws.length) return '';
  const x = ws[0].data.exercises.find(x => x.id === exId);
  const sets = x.log.filter(s => s?.done).map(s => `${s.reps || '?'}${s.weight ? '×' + s.weight + ' кг' : ''}`);
  return `прошлый раз (${fmt(ws[0].date, { day: 'numeric', month: 'short' })}): ${sets.join(', ')}`;
}

// always - на экране программы кнопка есть всегда: разгрузиться можно и по своему ощущению
function deloadNote({ always = false } = {}) {
  const active = H.safe(() => P.deloadWeek?.(), null);
  if (active) {
    return `<div class="notice a-deload"><span>Разгрузочная неделя до ${esc(fmt(active.until, { day: 'numeric', month: 'long' }))}: подходов меньше, веса на 30-40 % легче.</span>
      <button class="btn quiet" data-act="wo-deload-undo">Вернуть обычные тренировки</button></div>`;
  }
  const need = H.safe(() => P.needsDeload?.(), false);
  if (!need) return always ? `<div class="actions"><button class="btn quiet" data-act="wo-deload">Сделать разгрузочную неделю</button>
    <span class="note">подходов около 60 %, веса легче - на 7 дней, отменить можно в любой момент</span></div>` : '';
  return `<div class="notice a-deload"><span>${esc(H.safe(() => ({
    soft: 'Ты давно тренируешься без передышки. Предлагаю разгрузочную неделю: те же упражнения, но веса и подходы поменьше - мышцы скажут спасибо.',
    coach: 'Пора разгрузка: неделю работаем на 60–70 % объёма. Это не слабость, а часть прогрессии.',
    sergeant: 'Разгрузочная неделя, боец. Приказ: объём на 60 %. Восстановление - тоже служба.',
  })[H.tone()], ''))}</span>
    <button class="btn" data-act="wo-deload">Сделать разгрузочную неделю</button></div>`;
}

function balanceLocal(date) {
  const mon = H.mondayOf(date), sun = C.addDays(mon, 6);
  const ws = store.list('workout', store.uid(), r => r.date >= mon && r.date <= sun);
  const plannedSessions = ws.length, doneSessions = ws.filter(w => w.data.done).length;
  const minOf = w => Number(w.data.planned_minutes) || 45;
  const plannedMin = ws.reduce((a, w) => a + minOf(w), 0);
  const doneMin = ws.filter(w => w.data.done).reduce((a, w) => a + minOf(w), 0);
  const activityMin = store.list('activity', store.uid(), r => r.date >= mon && r.date <= sun).reduce((a, r) => a + (Number(r.data.minutes) || 0), 0);
  const missed = ws.filter(w => !w.data.done && w.date < C.today()).reduce((a, w) => a + minOf(w), 0);
  const deficitMin = Math.max(0, missed - Math.round(activityMin * 0.5));
  const left = ws.filter(w => !w.data.done && w.date >= C.today()).length;
  const suggestion = deficitMin
    ? `Недобрано ≈${deficitMin} мин. ${left ? `Добавь по ${Math.ceil(deficitMin / left / 5) * 5} мин к оставшимся тренировкам` : 'Закрой их короткой домашней тренировкой из генератора'} - без фанатизма.`
    : doneSessions >= plannedSessions && plannedSessions ? 'План недели выполнен. Остальное - бонус.' : 'Идёшь по плану.';
  return { plannedSessions, doneSessions, plannedMin, doneMin, activityMin, deficitMin, suggestion };
}
function balanceCard(date) {
  const b = H.safe(() => P.weeklyBalance?.(date), () => balanceLocal(date));
  if (!b || (!b.plannedSessions && !b.activityMin)) return '';
  const pct = b.plannedSessions ? Math.min(100, b.doneSessions / b.plannedSessions * 100) : 100;
  return `<div class="section" data-dom="train"><div class="section-title"><span class="smallcaps">Баланс недели</span><span class="note">с учётом активностей</span></div>
    <div class="raised a-card">
      <div class="a-bal">
        <div><b class="mono">${b.doneSessions}/${b.plannedSessions}</b><span>тренировок</span></div>
        <div><b class="mono">${Math.round(b.doneMin || 0)}/${Math.round(b.plannedMin || 0)}</b><span>минут по плану</span></div>
        <div data-dom="move"><b class="mono">${Math.round(b.activityMin || 0)}</b><span>минут активностей</span></div>
        <div><b class="mono ${b.deficitMin ? 'g-bad-t' : 'g-good-t'}">${Math.round(b.deficitMin || 0)}</b><span>добрать, мин</span></div>
        ${b.cardio ? `<div data-dom="move"><b class="mono">${b.cardio.done}/${b.cardio.target}</b><span>кардио, мин</span></div>` : ''}
      </div>
      <div class="groove a-groove"><div class="fill" style="width:${pct}%"></div></div>
      ${b.suggestion ? `<p class="note a-tight">${esc(b.suggestion)}</p>` : ''}
    </div></div>`;
}

function viewWorkout(date) {
  const w = C.workout(date);
  if (!w) {
    const next = store.list('workout', store.uid(), r => r.date > date).sort((a, b) => a.date.localeCompare(b.date))[0];
    const moved = store.list('workout', store.uid(), r => r.data.moved_from === date)[0];
    const prog = activeProgram();
    return `<div class="head-row"><div><div class="kicker smallcaps">Тренировка · ${esc(dayTitle(date))}</div><h1>День отдыха</h1></div>${dateNav('workout', date)}</div>
      <p class="lede">${moved ? `Тренировка перенесена на ${esc(dayTitle(moved.date))}.` : prog ? 'По программе в этот день тренировки нет. Восстановление - часть прогресса.' : 'Программы тренировок пока нет.'}</p>
      ${next ? `<p>Следующая: <a class="link" href="#workout/${next.date}">${esc(next.data.title)} - ${esc(dayTitle(next.date))}</a></p>` : ''}
      ${date >= C.today() ? H.variantBlock(date) : ''}
      ${date >= C.today() && prog ? deloadNote() : ''}
      <div class="actions"><a class="btn" href="#generator/${date}">Тренировка на любой случай <span class="arrow">→</span></a>
        <a class="btn ${prog ? 'quiet' : 'solid'}" href="#program">${prog ? 'Программа' : 'Составить программу'}</a></div>
      ${balanceCard(date)}`;
  }
  const d = w.data;
  const exRow = (x, xi) => {
    const e = S.exMap.get(x.id);
    const weighted = e && x.unit !== 'seconds' && (e.equipment || []).some(q => WEIGHTED.has(q));
    const sets = Array.from({ length: x.sets }, (_, i) => {
      const s = (x.log || [])[i] || {};
      return `<div class="set ${s.done ? 'done' : ''}"><span class="sn">${i + 1}</span>
        <input class="control" type="number" inputmode="decimal" placeholder="${esc(String(x.reps).split(/[-–\s]/)[0])}" value="${s.reps ?? ''}" data-act="set-val" data-f="reps" data-x="${xi}" data-i="${i}" aria-label="${/мин/.test(String(x.reps)) ? 'минут' : x.unit === 'seconds' ? 'секунд' : 'повторов'}, подход ${i + 1}">
        ${weighted ? `<span class="x">×</span><input class="control" type="number" inputmode="decimal" placeholder="кг" value="${s.weight ?? ''}" data-act="set-val" data-f="weight" data-x="${xi}" data-i="${i}" aria-label="вес, подход ${i + 1}">` : ''}
        <button class="tick ${s.done ? 'on' : ''}" data-act="set-done" data-x="${xi}" data-i="${i}" aria-label="Подход ${i + 1} выполнен">${CHECK}</button></div>`;
    }).join('');
    const prev = prevPerformance(x.id, date);
    const hint = H.safe(() => P.progressionHint?.(x.id, date), '');
    return `<div class="raised ex" data-dom="train"><h3>${esc(x.name || e?.name || x.id)}</h3>
      <div class="meta">${x.sets} × ${esc(x.reps)}${x.per_side ? ' на сторону' : ''} · отдых ${x.rest_sec || 60} с</div>
      ${x.note ? `<p class="note">${esc(x.note)}</p>` : ''}${prev ? `<div class="prev">${esc(prev)}</div>` : ''}
      ${hint ? `<div class="a-prog"><span class="smallcaps">прогрессия</span> ${esc(hint)}</div>` : ''}
      <div class="sets">${sets}</div>
      ${e ? `<details class="tech"><summary>Техника</summary>${techHtml(e)}</details>` : ''}
      ${!d.done && date >= C.today() && !(x.log || []).some(s => s?.done) ? exActions(x.id, { kind: 'workout', date, i: xi }) : ''}</div>`;
  };
  const chipList = (ids, kind) => `<div class="chips">${ids.map((id, i) => `<button class="chip" data-act="tech" data-ex="${id}" ${!d.done && date >= C.today() ? `data-ctx="${kind}" data-date="${date}" data-i="${i}"` : ''}>${esc(S.exMap.get(id)?.name || id)}</button>`).join('')}</div>`;
  const pr = Math.round(C.workoutProgress(w) * 100);
  const sub = [d.focus, d.week && d.weeks ? `неделя ${d.week} из ${d.weeks}` : '', d.source === 'generated' ? 'собрана генератором' : '',
    d.planned_minutes ? `≈${d.planned_minutes} мин` : '', d.moved_from ? `перенесена с ${fmt(d.moved_from, { day: 'numeric', month: 'short' })}` : ''].filter(Boolean).join(' · ');
  const VBANNER = {
    light: 'Облегчённый вариант: меньше подходов, дольше отдых. Недобранный объём распределится по неделе.',
    recovery: 'Восстановительная сессия: лёгкие веса, без отказа, больше мобильности.',
    deload: 'Те же упражнения, подходов около 60 %, рабочие веса на 30-40 % легче, без отказа. Так мышцы и связки успевают восстановиться.',
  };
  return `<div class="head-row"><div><div class="kicker smallcaps">Тренировка · ${esc(dayTitle(date))}</div><h1>${esc(d.title)}</h1></div>${dateNav('workout', date)}</div>
    ${sub ? `<p class="lede">${esc(sub)}</p>` : ''}
    ${VBANNER[d.variant] ? `<div class="notice a-vbanner"><b class="smallcaps">${H.VARIANT_NAME[d.variant]}</b> ${esc(VBANNER[d.variant])}</div>` : ''}
    ${deloadNote()}
    ${!d.done && date >= C.today() ? H.variantBlock(date, { compact: true }) : ''}
    <div class="groove" data-dom="train"><div class="fill" style="width:${pr}%"></div></div>
    ${d.warmup?.length ? `<div class="section" data-dom="move"><div class="section-title"><span class="smallcaps">Разминка</span><span class="note">нажмите, чтобы увидеть технику</span></div>${chipList(d.warmup, 'warmup')}</div>` : ''}
    <div class="section" data-dom="train"><div class="section-title"><span class="smallcaps">Основная часть</span></div>${(d.exercises || []).map(exRow).join('') || '<p class="empty">Упражнений нет.</p>'}</div>
    ${d.cooldown?.length ? `<div class="section" data-dom="move"><div class="section-title"><span class="smallcaps">Заминка</span></div>${chipList(d.cooldown, 'cooldown')}</div>` : ''}
    <div class="actions">${d.done ? `<span class="chip">завершена</span><button class="btn quiet" data-act="wo-undo">Вернуть в работу</button>`
      : `<button class="btn solid" data-act="wo-finish">Завершить тренировку</button>`}<a class="btn quiet" href="#program">Программа</a><a class="btn quiet" href="#generator/${date}">Другая тренировка</a></div>
    ${balanceCard(date)}`;
}

export function activeProgram() { return store.list('program').find(p => p.data.active) || null; }

// ── генератор «на любой случай» ──
function viewGenerator(arg) {
  const date = isDate(arg) ? arg : C.today();
  const f = (S.forms.gen ||= { minutes: 20, focus: 'full' });
  const w = C.workout(date);
  const r = H.readiness(date);
  const prof = profile();
  const eq = (prof.equipment || []).map(PF.equipLabel);
  return `<div class="head-row"><div><div class="kicker smallcaps">Спорт · ${esc(dayTitle(date))}</div><h1>Тренировка на любой случай</h1></div>${dateNav('generator', date)}</div>
    <p class="lede">Соберу домашнюю тренировку из каталога под время, инвентарь и ограничения. Инвентарь: ${esc(eq.join(', ') || 'без инвентаря')}.</p>
    ${r.level === 'low' || r.level === 'rest' ? `<div class="notice">Готовность сегодня ${H.READY_NAME[r.level]} - ${r.level === 'rest' ? 'лучше «Восстановление»' : 'выбирай что полегче'}.</div>` : ''}
    ${w && !w.data.done ? `<div class="notice">На этот день уже есть «${esc(w.data.title)}». Новая тренировка её заменит.</div>` : ''}
    <div class="section"><div class="section-title"><span class="smallcaps">Готовые сценарии</span></div>
      <div class="a-scen">${scenarios().map(s => `<button class="raised a-scard" data-act="gen-make" data-min="${s.minutes}" data-focus="${esc(s.focus)}" data-title="${esc(s.title)}" data-sc="${esc(s.id)}" data-date="${date}">
        <span class="a-stitle">${esc(s.title)}</span><span class="mono muted">${s.minutes} мин · ${esc(FOCUS_NAME[s.focus] || s.focus)}</span>${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}</button>`).join('')}</div></div>
    <div class="section"><div class="section-title"><span class="smallcaps">Своя</span></div>
      <div class="a-q"><span class="smallcaps muted">Минут</span>${H.pick('gen-set', f.minutes, [10, 15, 20, 30, 45, 60].map(n => [n, String(n)]), 'data-k="minutes"')}</div>
      <div class="a-q"><span class="smallcaps muted">Фокус</span>${H.pick('gen-set', f.focus, FOCUS, 'data-k="focus"')}</div>
      <div class="actions"><button class="btn solid" data-act="gen-make" data-min="${f.minutes}" data-focus="${esc(f.focus)}" data-date="${date}">Собрать на ${f.minutes} мин <span class="arrow">→</span></button></div></div>
    ${balanceCard(date)}`;
}

function makeHomeLocal({ minutes, focus, date, title }) {
  const prof = profile();
  const have = new Set(['mat', 'chair', ...(prof.equipment || [])]);
  const excl = H.safe(() => P.excludedFor?.(), new Set());
  const skip = PF.excludedIds();
  const ok = e => (e.place || []).includes('home') && !skip.has(e.id) && (e.equipment || []).every(q => have.has(q)) && !(e.contraindications || []).some(c => excl.has?.(c));
  const all = [...S.exMap.values()].filter(ok);
  const PAT = {
    full: ['squat', 'push_h', 'hinge', 'pull_h', 'lunge', 'core_anti', 'push_v', 'core_flex'],
    quick: ['squat', 'push_h', 'core_anti', 'lunge', 'mobility'],
    upper: ['push_h', 'pull_h', 'push_v', 'isolation', 'pull_v', 'push_h', 'core_anti'],
    lower: ['squat', 'lunge', 'hinge', 'squat', 'lunge', 'isolation'],
    core: ['core_anti', 'core_flex', 'core_anti', 'core_flex', 'core_anti'],
    cardio: ['cardio', 'cardio', 'squat', 'cardio', 'lunge', 'cardio'],
    recovery: ['mobility', 'mobility', 'mobility', 'core_anti', 'mobility'],
  }[focus] || [];
  const seed = date + focus + minutes;
  const h = s => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x); };
  const perEx = minutes <= 15 ? 3 : 5;
  const n = Math.max(3, Math.min(8, Math.round(minutes / perEx)));
  const used = new Set(), out = [];
  for (let i = 0; out.length < n && i < n * 3; i++) {
    const pat = PAT[i % PAT.length];
    const cand = all.filter(e => !used.has(e.id) && (e.pattern === pat || (pat === 'cardio' && e.category === 'cardio') || (pat === 'mobility' && ['mobility', 'warmup'].includes(e.category))))
      .sort((a, b) => h(seed + a.id) - h(seed + b.id));
    const e = cand[0] || (i >= PAT.length ? all.filter(x => !used.has(x.id)).sort((a, b) => h(seed + a.id) - h(seed + b.id))[0] : null);
    if (!e) continue;
    used.add(e.id);
    const sec = e.unit === 'seconds';
    out.push({ id: e.id, name: e.name, sets: focus === 'recovery' || minutes <= 15 ? 2 : 3, reps: sec ? (focus === 'cardio' ? '30-40' : '30') : focus === 'recovery' ? '8-10' : '10-15',
      unit: e.unit, per_side: !!e.per_side, rest_sec: focus === 'cardio' ? 30 : 45, note: '' });
  }
  const warm = [...S.exMap.values()].filter(e => e.morning && ok(e)).sort((a, b) => h(seed + a.id) - h(seed + b.id)).slice(0, 3).map(e => e.id);
  return { title: title || `Дома · ${FOCUS_NAME[focus] || focus} · ${minutes} мин`, focus: FOCUS_NAME[focus] || focus, exercises: out, warmup: warm, cooldown: [],
    source: 'generated', planned_minutes: minutes, variant: 'full', created: Date.now() };
}

async function generate({ minutes, focus, date, title, scenario }) {
  if (P.makeHomeWorkout) {
    await P.makeHomeWorkout({ minutes, focus, date, scenario, title });
  } else {
    const data = makeHomeLocal({ minutes, focus, date, title });
    if (!data.exercises.length) return toast('Каталог упражнений ещё не загружен - нужна связь с сервером');
    await store.put('workout', `wo:${store.uid()}:${date}`, data, date);
  }
  await afterChange(date);
  location.hash = `#workout/${date}`;
}

// ── программа ──
function viewProgram() {
  const prog = activeProgram(), prof = profile();
  const job = jobFor('program');
  const f = 'program';
  if (!S.forms[f]) S.forms[f] = {
    place: prof.gym ? 'gym' : 'home', weekdays: [...(prof.weekdays || [0, 2, 4])], weeks: 6,
    minutes: prof.gym ? 60 : 45, level: 1, start: C.today(), notes: '',
  };
  const fm = S.forms[f];
  const cur = prog ? prog.data : null;
  const acts = (prof.activities || []).filter(a => a.type);
  const ramp = prof.start_mode === 'smooth' ? H.safe(() => C.rampFactor?.(C.today()), null) : null;
  return `<div class="kicker smallcaps">Программа тренировок</div>
    <h1>${cur ? esc(cur.title) : 'Программы пока нет'}</h1>
    ${cur ? `<p class="lede">${esc(cur.summary)}</p>
      <p class="small">${cur.place === 'gym' ? 'Зал' : 'Дом'} · ${(cur.weekdays || []).map(i => WD[i]).join(', ')} · ${cur.weeks} нед. · с ${esc(fmt(cur.start, { day: 'numeric', month: 'long' }))}${cur.end ? ` по ${esc(fmt(cur.end, { day: 'numeric', month: 'long' }))}` : ''}</p>
      ${cur.progression ? `<div class="notice">${esc(cur.progression)}</div>` : ''}
      ${deloadNote({ always: true })}` :
      '<p class="lede">Локальная ИИ составит программу под ваши цели, дни и инвентарь. Технику каждого упражнения можно открыть прямо в тренировке.</p>'}
    ${prof.start_mode === 'smooth' ? `<p class="note">Плавный старт: объём растёт с 60 до 100 % за три недели${ramp ? ` - сейчас <span class="mono">${Math.round(ramp * 100)} %</span>` : ''}.</p>` : ''}
    ${acts.length ? `<div class="section"><div class="section-title"><span class="smallcaps">Учитываются активности</span></div>
      <div class="chips">${acts.map(a => `<span class="chip">${esc(H.activityName(a.type))}${a.per_week ? ` · ${a.per_week}×/нед` : ''}${a.weekdays?.length ? ` (${a.weekdays.map(i => WD[i]).join(', ')})` : ''}${a.minutes ? ` · ${a.minutes} мин` : ''}</span>`).join('')}</div>
      <p class="note">Нагрузку на те же зоны план ставит не впритык к активностям. Поменяли набор - пересоберите план.</p></div>` : ''}
    ${cur ? `<div class="actions"><button class="btn" data-act="prog-rebuild" ${job || !store.state.online ? 'disabled' : ''}>Пересобрать план</button><span class="note">${store.state.online ? 'будущие тренировки под текущие активности, темп и ограничения' : 'пересборка - на сервере, нужна связь с ним'}</span></div>
      ${cur.days.map(dd => `<div class="raised card" style="margin-top:12px"><h3 style="margin:0">${esc(dd.name)}</h3><div class="note">${esc(dd.focus)}</div>
        <ul class="small a-plist">${dd.exercises.map(x => `<li><button class="a-linkbtn" data-act="tech" data-ex="${x.id}">${esc(x.name || S.exMap.get(x.id)?.name || x.id)}</button> - ${x.sets} × ${esc(x.reps)}</li>`).join('')}</ul></div>`).join('')}` : ''}
    <div class="section"><div class="section-title"><span class="smallcaps">${cur ? 'Новая программа' : 'Параметры'}</span></div>
      ${job ? `<div class="notice"><span class="spinner"></span> ИИ составляет программу${job.ahead ? ` · в очереди ${job.ahead}` : ''}… обычно это 1–3 минуты. Можно уйти с экрана.</div>` : ''}
      <div class="grid2">
        ${field('Где', select(f, 'place', fm.place, [['gym', 'Тренажёрный зал'], ['home', 'Дома']], 'data-rerender'))}
        ${field('Начать с', input(f, 'start', fm.start, 'type="date"'))}
        ${field('Недель', select(f, 'weeks', fm.weeks, [4, 5, 6, 7, 8].map(n => [n, n])))}
        ${field('Длительность, мин', select(f, 'minutes', fm.minutes, [30, 40, 45, 60, 75, 90].map(n => [n, n])))}
        ${field('Уровень', select(f, 'level', fm.level, [[1, 'Новичок'], [2, 'Средний'], [3, 'Продвинутый']]))}
      </div>
      <div class="field" style="margin-top:14px"><span class="smallcaps">Дни недели</span><div class="chips">
        ${WD.map((w, i) => `<button class="chip ${fm.weekdays.includes(i) ? 'on' : ''}" aria-pressed="${fm.weekdays.includes(i)}" data-act="prog-day" data-i="${i}">${w}</button>`).join('')}</div></div>
      <div style="margin-top:14px">${field('Пожелания', `<textarea class="control" data-form="${f}" data-key="notes" rows="2" placeholder="например: больнее колено - без прыжков; хочу больше спины">${esc(fm.notes)}</textarea>`)}</div>
      ${fm.place === 'home' ? `<p class="note">Домашний инвентарь берётся из профиля: ${esc((prof.equipment || []).map(PF.equipLabel).join(', ') || 'без инвентаря')}.</p>` : ''}
      <div class="actions"><button class="btn solid" data-act="prog-make" ${job || !store.state.online ? 'disabled' : ''}>${cur ? 'Составить заново' : 'Составить программу'} <span class="arrow">→</span></button>
        <a class="btn quiet" href="#generator">Тренировка на любой случай</a></div>
      ${!store.state.online ? '<p class="note">Программу составляет локальная ИИ на сервере - нужна связь с ним. Без сети можно собрать разовую тренировку: «Тренировка на любой случай».</p>' : ''}
      ${cur ? '<p class="note">Будущие тренировки старой программы заменятся новыми; уже начатые и прошедшие останутся.</p>' : ''}
    </div>`;
}

let restTimer = null;
function startRest(sec, name) {
  clearInterval(restTimer);
  const end = Date.now() + sec * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    $rest.hidden = false;
    $rest.innerHTML = left > 0
      ? `<span>Отдых</span><b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b><button class="btn quiet" data-act="rest-stop">Пропустить</button>`
      : `<span>Отдых окончен - ${esc(name)}</span><button class="btn quiet" data-act="rest-stop">Ок</button>`;
    if (left <= 0) {
      clearInterval(restTimer);
      try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* нет вибрации */ }
      setTimeout(() => { if (!restTimer || Date.now() > end + 5000) $rest.hidden = true; }, 6000);
    }
  };
  tick();
  restTimer = setInterval(tick, 500);
}

function woPraise() {
  const t = profile().tone || 'coach';
  return { soft: 'Тренировка сделана! Ты умница.', coach: 'Тренировка завершена. Хорошая работа.', sergeant: 'Тренировка засчитана. Вольно, боец.' }[t];
}

async function updateWorkout(date, fn) {
  const w = C.workout(date);
  if (!w) return;
  const data = structuredClone(w.data);
  fn(data);
  await store.put('workout', w.id, data, date);
  await afterChange(date);
}
const woDate = () => { const a = routeArg(); return isDate(a) ? a : C.today(); };

export const actions = {
  'wo-deload': async () => {
    const n = await P.applyDeloadWeek();
    await afterChange(C.today());
    toast(n ? `Разгрузка: облегчены тренировки ближайшей недели - ${n}` : 'На ближайшую неделю нет тренировок, которые можно облегчить', 4000);
  },
  'wo-deload-undo': async () => {
    const n = await P.undoDeloadWeek();
    await afterChange(C.today());
    toast(n ? 'Вернули обычные тренировки' : 'Нечего возвращать: разгрузочные тренировки уже начаты');
  },
  'set-done': async el => {
    const x = Number(el.dataset.x), i = Number(el.dataset.i), date = woDate();
    let became = false, ex = null;
    await updateWorkout(date, d => {
      ex = d.exercises[x];
      ex.log = ex.log || [];
      const s = ex.log[i] || {};
      s.done = !s.done; became = s.done;
      if (s.done && !s.reps) s.reps = parseInt(String(ex.reps), 10) || null;
      ex.log[i] = s;
    });
    if (became && ex) startRest(ex.rest_sec || 60, ex.name || S.exMap.get(ex.id)?.name || '');
  },
  'rest-stop': () => { clearInterval(restTimer); restTimer = null; $rest.hidden = true; },
  'wo-finish': async () => {
    await updateWorkout(woDate(), d => { d.done = true; d.finished_at = Date.now(); });
    toast(woPraise());
  },
  'wo-undo': async () => { await updateWorkout(woDate(), d => { d.done = false; }); },
  'prog-day': el => {
    const i = Number(el.dataset.i), w = S.forms.program.weekdays;
    S.forms.program.weekdays = w.includes(i) ? w.filter(x => x !== i) : [...w, i].sort();
    S.render();
  },
  'prog-make': async () => {
    const fm = S.forms.program;
    if (!fm.weekdays.length) return toast('Выберите дни недели');
    try {
      await store.sync();
      const res = await store.api('/api/ai/jobs', { kind: 'program', input: {
        place: fm.place, weekdays: fm.weekdays, weeks: Number(fm.weeks), minutes: Number(fm.minutes),
        level: Number(fm.level), start: fm.start, notes: fm.notes } });
      await addJob(res.job_id, 'program', 'program');
    } catch (e) { toast(e.message, 5000); }
  },
  'prog-rebuild': async () => {
    try {
      await store.sync();
      const res = await store.api('/api/program/rebuild', { reason: 'manual' });
      if (res?.job_id) await addJob(res.job_id, 'program', 'program');
      else { await store.sync(); toast('План пересобран'); }
    } catch (e) {
      if (e.status === 404 || e.status === 405) toast('Пересборка плана появится после обновления сервера', 5000);
      else if (e.status === 0) toast('Нет связи с сервером - пересоберу, когда он будет доступен', 5000);
      else toast(e.message, 6000);
    }
  },
  'gen-set': el => {
    const f = (S.forms.gen ||= {});
    f[el.dataset.k] = el.dataset.k === 'minutes' ? Number(el.dataset.v) : el.dataset.v;
    S.render();
  },
  'gen-make': async el => {
    const { min, focus, date, title, sc } = el.dataset;
    const args = { minutes: Number(min), focus, date, title: title || '', scenario: sc || null };
    const w = C.workout(date);
    if (w && !w.data.done && w.data.source !== 'generated') {
      S.forms.genPending = args;
      openModal(`<div class="modal-head"><div class="kicker smallcaps">Замена</div><h2>Заменить тренировку?</h2></div>
        <div class="modal-body"><p>На этот день запланирована «${esc(w.data.title)}» из программы. Новая тренировка её заменит.</p>
        <p class="note">Если просто нет сил - лучше облегчить или перенести тренировку на экране дня.</p></div>
        <div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="gen-confirm">Заменить</button></div>`);
      return;
    }
    await generate(args);
  },
  'gen-confirm': async () => {
    const args = S.forms.genPending;
    closeModal();
    if (args) await generate(args);
  },
};

export const changes = {
  'set-val': async el => {
    const v = el.value === '' ? null : Number(el.value);
    await updateWorkout(woDate(), d => {
      const ex = d.exercises[Number(el.dataset.x)];
      ex.log = ex.log || [];
      ex.log[Number(el.dataset.i)] = { ...(ex.log[Number(el.dataset.i)] || {}), [el.dataset.f]: v };
    });
  },
};

export const routes = {
  workout: arg => viewWorkout(isDate(arg) ? arg : C.today()),
  program: () => viewProgram(),
  generator: arg => viewGenerator(arg),
};
