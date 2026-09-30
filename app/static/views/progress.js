import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import * as GL from '../goals.js';
import * as AN from '../analysis.js';
import { S, esc, num, fmt, WD, profile, goal, toast, ring, field, fval, input, jobFor, addJob, afterChange, MOOD_GLYPH, gradeGlyph, aiOff, aiOffHint } from '../ui.js';

// Прогресс: путь к цели (вехи + уровень), вес со сглаживанием, сон, достижения;
// #week/{понедельник} — недельный отчёт; #body/{дата} — дневник замеров.

// ── помощники ──
const safe = (fn, fb = null) => { try { const v = fn(); return v === undefined ? fb : v; } catch (e) { console.warn(e); return fb; } };
const dec = (v, d = 1) => (v == null || Number.isNaN(+v) ? '-' : (+v).toFixed(d).replace('.', ','));
const sgn = (v, d = 1) => (v == null ? '-' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${dec(Math.abs(v), d)}`);
const mondayOf = d => C.addDays(d, -((C.parse(d).getDay() + 6) % 7));
const short = d => fmt(d, { day: 'numeric', month: 'short' });
// длительность: «7 ч 36 мин» (не «7:36» — это читается как время на часах)
const hm = h => { if (h == null) return '-'; const t = Math.round(h * 60), m = t % 60; return `${Math.floor(t / 60)} ч${m ? ` ${m} мин` : ''}`; };
function apiMsg(e, what) {
  if (e.status === 404 || (e.status === 400 && /unknown kind/i.test(e.message))) return `${what}: на сервере этого ещё нет - обновите сервер`;
  if (e.status === 0) return 'Нет связи с сервером';
  if (e.status === 503) return e.message || 'Локальная ИИ недоступна';
  return e.message || 'Ошибка';
}
const GOAL_NAME = { lose_fat: 'Похудеть', gain_muscle: 'Набрать мышцы', endurance: 'Выносливость', tone: 'Тонус', sleep: 'Качество сна',
  gain_weight: 'Набрать вес', maintain: 'Удержать форму', posture: 'Осанка', neck: 'Шея и скулы' };
function goalsList() {
  const g = goal();
  if (g.goals?.length) return [...g.goals].sort((a, b) => (a.priority || 2) - (b.priority || 2));
  const out = [];
  if (g.fat_kg) out.push({ type: 'lose_fat', amount: g.fat_kg });
  if ((g.muscle_upper_kg || 0) + (g.muscle_lower_kg || 0)) out.push({ type: 'gain_muscle', amount: (g.muscle_upper_kg || 0) + (g.muscle_lower_kg || 0) });
  return out;
}

// сглаженный вес: из coach.js, иначе — скользящее среднее за 7 дней
function smoothed() {
  const s = safe(() => C.smoothedWeights?.());
  if (Array.isArray(s) && s.length) return s.map(p => ({ date: p.date, w: +p.w, trend: +(p.trend ?? p.w) }));
  const ws = C.weights();
  return ws.map(p => {
    const from = C.addDays(p.date, -6);
    const win = ws.filter(q => q.date >= from && q.date <= p.date);
    return { ...p, trend: win.reduce((a, q) => a + q.w, 0) / win.length };
  });
}

// ── графики (SVG растягивается по ширине; точки — отрезки нулевой длины, чтобы оставались круглыми) ──
function lineChart(series, { h = 170, dots = [], cls = '' } = {}) {
  const all = [...series.flatMap(s => s.pts), ...dots];
  if (all.length < 2) return '';
  const vs = all.map(p => p.v), min = Math.min(...vs), max = Math.max(...vs);
  const pad = (max - min) * 0.12 || 0.5, lo = min - pad, hi = max + pad;
  const ts = all.map(p => C.parse(p.date).getTime()), t0 = Math.min(...ts), t1 = Math.max(...ts);
  const W = 1000, x = d => ((C.parse(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - 16) + 8, y = v => 6 + ((hi - v) / (hi - lo)) * (h - 12);
  const ds = all.map(p => p.date).sort();
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  return `<div class="pg-chart ${cls}"><span class="pg-y top mono">${dec(max)}</span><span class="pg-y bot mono">${dec(min)}</span>
    <svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" style="height:${h}px" aria-hidden="true">
      <line class="pg-grid" x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" vector-effect="non-scaling-stroke"/>
      <line class="pg-grid" x1="0" x2="${W}" y1="${y(min)}" y2="${y(min)}" vector-effect="non-scaling-stroke"/>
      ${dots.map(p => `<path class="pg-dot" d="M${x(p.date).toFixed(1)},${y(p.v).toFixed(1)}h0" vector-effect="non-scaling-stroke"><title>${esc(short(p.date))}: ${dec(p.v)}</title></path>`).join('')}
      ${series.map(s => `<path class="pg-line ${s.cls || ''}" d="${path(s.pts)}" vector-effect="non-scaling-stroke"/>`).join('')}
    </svg>
    <div class="pg-x mono"><span>${esc(short(ds[0]))}</span><span>${esc(short(ds[ds.length - 1]))}</span></div></div>`;
}

// ════════════ #progress ════════════
function viewProgress() {
  const uid = store.uid();
  const lv = C.level(C.totalXp()), st = C.streaks();
  const earned = new Set(store.list('ach').map(a => a.data.code));
  const g = goal();
  const today = C.today(), mon = mondayOf(today);
  const ws = safe(() => C.weekSummary?.(mon));
  const plateau = safe(() => C.plateau?.()) || {};
  const deload = safe(() => P.needsDeload?.(), false);
  const week = Array.from({ length: 7 }, (_, i) => C.addDays(today, i - 6));
  const avg = id => Math.round(week.reduce((a, d) => a + C.pctOf(d, id), 0) / 7);
  const people = [{ id: uid, name: 'Вы' }, ...store.partners()];
  const achList = C.ACHIEVEMENTS || [];

  const notices = [
    plateau.weight ? 'Вес стоит больше трёх недель. Это нормально - тело адаптируется. Пересчитайте нормы или добавьте шагов.' : '',
    plateau.measures ? 'Замеры не меняются три недели. Можно сменить программу или темп.' : '',
    plateau.lifts ? 'Рабочие веса застыли. Скорее всего, нужен отдых или смена упражнений.' : '',
    deload ? 'Пора разгрузочную неделю: объём −40 %, веса те же. Так мышцы и суставы успеют восстановиться, а прогресс продолжится.' : '',
  ].filter(Boolean);

  return `<div class="kicker smallcaps">Прогресс</div><h1>Путь к цели</h1>
    <p class="lede">${g.deadline ? `Цель к ${esc(fmt(g.deadline, { day: 'numeric', month: 'long', year: 'numeric' }))}${weeksLeft(g.deadline)}.` : 'Вехи - за результат, опыт - за регулярность.'}</p>
    <div data-dom="goal">${pathBlock()}</div>
    <div class="pg-level" data-dom="goal"><div class="lvl"><div class="num">${lv.n}</div><div class="grow">
      <div class="pg-level-t"><b>${esc(lv.title)}</b><span class="mono">${num(lv.xp)} XP</span></div>
      <div class="groove"><div class="fill" style="width:${Math.round(lv.frac * 100)}%"></div></div>
      <div class="note" style="margin-top:6px">до уровня ${lv.n + 1} ещё ${num(lv.to - lv.xp)} XP · серия ${st.current} дн. · рекорд ${st.best}</div></div></div></div>
    ${notices.map(t => `<div class="notice">${esc(t)}</div>`).join('')}

    <div class="pg-links">
      <a class="raised pg-link" href="#week/${mon}"><span class="smallcaps muted">Эта неделя</span>
        <b class="g-${LETTER_G[ws?.grade] || 'none'}-t">${ws ? `${gradeGlyph(ws.grade)} ${esc(ws.grade || '')}` : '-'}</b><span class="note">${ws?.score != null ? `${Math.round(ws.score)} из 100` : 'отчёт по дням'} →</span></a>
      <a class="raised pg-link" href="#body"><span class="smallcaps muted">Замеры</span>
        <b>${lastMeasureDate() ? esc(short(lastMeasureDate())) : '-'}</b><span class="note">${measureDue() ? 'пора обновить' : 'дневник и графики'} →</span></a>
      <a class="raised pg-link" href="#report"><span class="smallcaps muted">Отчёт</span>
        <b>PDF</b><span class="note">питание, сон, активности →</span></a>
      ${togetherLink()}
    </div>

    <div class="section" data-dom="goal"><div class="section-title"><span class="smallcaps">Вес</span>${weightTrendNote()}</div>
      ${weightBlock()}
      <div class="actions">${input('weight', 'w', '', 'type="number" inputmode="decimal" step="0.1" placeholder="кг" style="width:110px" aria-label="Вес сегодня, кг" enterkeyhint="done" data-enter="weight-add"')}
        <button class="btn" data-act="weight-add">Записать вес за сегодня</button></div></div>

    ${sleepBlock()}

    ${safe(() => AN.renderInsights(), '')}

    <div class="section" data-dom="coach"><div class="section-title"><span class="smallcaps">Неделя: средний % выполнения</span></div>
      <div class="vs">${people.map(p => `<div><div class="ell">${esc(p.name)}</div><div class="groove"><div class="fill" style="width:${avg(p.id)}%"></div></div></div><span class="mono">${avg(p.id)}%</span>`).join('')}</div></div>

    <div class="section" data-dom="goal"><div class="section-title"><span class="smallcaps">Достижения · ${achList.filter(a => earned.has(a.code)).length} из ${achList.length}</span></div>
      <div class="ach">${achList.map(a => `<div class="raised ${earned.has(a.code) ? '' : 'off'}"><b>${esc(a.title)}</b><span>${esc(a.text)}</span></div>`).join('')}</div></div>`;
}

// карточка «Вместе»: счёт недели с партнёром (или приглашение включить соревнование)
function togetherLink() {
  const d = safe(() => C.duel?.());
  if (!d || d.state === 'no_partner') return '';
  const b = d.state === 'ok' ? `${d.score.me}:${d.score.them}` : '-';
  const note = d.state === 'ok' ? `вы и ${esc(d.partner.name)}` : d.state === 'me_off' ? 'соревнование выключено' : `${esc(d.partner.name)} пока не в игре`;
  return `<a class="raised pg-link" href="#together"><span class="smallcaps muted">Вместе</span><b class="mono">${b}</b><span class="note ell">${note} →</span></a>`;
}

function weeksLeft(deadline) {
  const d = Math.round((C.parse(deadline) - C.parse(C.today())) / 864e5);
  if (d < 0) return ' - срок прошёл, пора поставить новый';
  const w = Math.ceil(d / 7);
  return ` - осталось ${w} ${w % 10 === 1 && w % 100 !== 11 ? 'неделя' : [2, 3, 4].includes(w % 10) && ![12, 13, 14].includes(w % 100) ? 'недели' : 'недель'}`;
}

function pathBlock() {
  const gs = goalsList();
  if (!gs.length) return `<p class="note">Цели не заданы. <a class="link" href="#profile">Выберите цели в профиле</a> - здесь появятся вехи.</p>`;
  const sm = smoothed();
  const start = sm[0]?.w ?? profile().weight;
  const cur = sm.length ? sm[sm.length - 1].trend : null;
  const wDone = store.list('workout', store.uid(), r => r.data.done).length;
  const st = C.streaks();
  const rows = gs.map(g => {
    if (g.type === 'metric') return metricPathRow(g);
    let have = 0, need = 1, unit = '', label = GOAL_NAME[g.type] || g.type, marks = [0.25, 0.5, 0.75, 1], fmtv = v => dec(v, 1);
    if ((g.type === 'lose_fat' || g.type === 'gain_weight') && g.amount && start) {
      need = +g.amount; unit = 'кг';
      have = cur == null ? 0 : g.type === 'lose_fat' ? start - cur : cur - start;
      label = `${g.type === 'lose_fat' ? 'Минус' : 'Плюс'} ${dec(need, need % 1 ? 1 : 0)} кг`;
    } else if (g.type === 'gain_muscle' || g.type === 'tone' || g.type === 'endurance') {
      need = g.type === 'endurance' ? 36 : 48; unit = 'трен.'; have = wDone; fmtv = v => String(Math.round(v));
      label = `${GOAL_NAME[g.type]}${g.amount ? ` · +${dec(g.amount, g.amount % 1 ? 1 : 0)} кг` : ''}`;
    } else {
      need = 60; unit = 'дн. серии'; have = st.best; fmtv = v => String(Math.round(v));
    }
    const frac = Math.max(0, Math.min(1, have / need));
    const next = marks.find(m => frac < m);
    return `<div class="pg-goal">
      <div class="pg-goal-h"><b class="ell">${esc(label)}</b><span class="mono">${fmtv(Math.max(0, have))} / ${fmtv(need)} ${unit}</span></div>
      <div class="pg-track"><div class="groove"><div class="fill" style="width:${Math.round(frac * 100)}%"></div></div>
        ${marks.map(m => `<i class="pg-mark ${frac >= m ? 'on' : ''} ${m === next ? 'next' : ''}" style="left:${m * 100}%"></i>`).join('')}</div>
      <div class="note">${next ? `следующая веха - ${fmtv(need * next)} ${unit}, осталось ${fmtv(Math.max(0, need * next - have))}` : 'цель достигнута - поставьте следующую!'}</div></div>`;
  }).join('');
  return `<div class="pg-path">${rows}</div>`;
}

// цель-показатель (goals.js): сейчас vs цель, тренд, прогноз, «по плану / отстаёте / опережаете»
function metricPathRow(g) {
  const pr = GL.progress(g), m = pr.metric;
  if (!m) return '';
  const u = esc(m.unit), marks = [0.25, 0.5, 0.75, 1];
  const days = pr.cur?.date && g.since ? C.daysBetween(g.since, pr.cur.date) : null;
  const stale = m.src === 'body' && pr.cur?.date && C.addDays(pr.cur.date, 30) <= C.today();
  const bits = [
    pr.change != null && days >= 3 ? `${GL.fmtSigned(pr.change, m)} ${u} за ${GL.periodText(days)}` : '',
    pr.trend != null ? `тренд ${GL.fmtSigned(pr.trend, m, m.dec === 0 ? 1 : 2)} ${u}/нед.` : '',
    pr.eta && pr.status !== 'done' ? `прогноз - к ${esc(short(pr.eta))}` : '',
    g.deadline ? `срок - ${esc(short(g.deadline))}` : '',
  ].filter(Boolean).join(' · ');
  const status = pr.status === 'nodata' ? (m.src === 'habit' ? 'данных за неделю пока нет' : 'нет замеров') : pr.label;
  const src = pr.cur?.approx ? (m.src === 'habit' ? ' · мало дней, ориентировочно' : ' · по подходам в тренировках, ориентировочно') : '';
  const act = m.src === 'body' || m.src === 'weight'
    ? `<a class="link" href="#body">${stale ? 'пора обновить замеры' : 'замеры'} →</a>`
    : m.src === 'test' ? `<span style="display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0">${input('gtest', m.id, '', `type="number" inputmode="decimal" step="${m.step}" min="0" placeholder="${u}" style="width:90px"`)}
        <button class="btn quiet" data-act="goal-test" data-m="${m.id}">Записать результат</button></span>` : '';
  return `<div class="pg-goal">
    <div class="pg-goal-h"><b class="ell">${esc(m.label)}: ${GL.fmtNum(pr.from, m)} → ${GL.fmtNum(pr.to, m)} ${u}</b><span class="mono">${pr.current != null ? GL.fmtNum(pr.current, m) : '-'} ${u}</span></div>
    <div class="pg-track"><div class="groove"><div class="fill" style="width:${Math.round(pr.pct * 100)}%"></div></div>
      ${marks.map(k => `<i class="pg-mark ${pr.pct >= k ? 'on' : ''}" style="left:${k * 100}%"></i>`).join('')}</div>
    <div class="note"><b>${esc(status)}</b>${bits ? ` · ${bits}` : ''}${src}</div>
    ${act ? `<div class="actions" style="margin-top:6px">${act}</div>` : ''}</div>`;
}

function weightTrendNote() {
  const tr = C.weightTrend(21);
  return tr !== null ? `<span class="note">тренд ${sgn(tr, 2)} кг/нед</span>` : '';
}

function weightBlock() {
  const sm = smoothed();
  if (sm.length < 2) return `<p class="empty">${sm.length ? `Записан один замер: ${dec(sm[0].w)} кг. График появится со второго.` : 'Взвешиваний пока нет.'}</p>`;
  const pts = sm.slice(-90);
  const last = pts[pts.length - 1];
  return `${lineChart([{ pts: pts.map(p => ({ date: p.date, v: p.trend })) }], { dots: pts.map(p => ({ date: p.date, v: p.w })) })}
    <p class="note">Линия - сглаженный вес за 7 дней, точки - взвешивания. Сейчас ≈ <span class="mono">${dec(last.trend)}</span> кг${sm.length > 1 ? `, от старта ${sgn(last.trend - sm[0].w)} кг` : ''}. Колебания в 0,5–1 кг за день - это вода, не жир.</p>`;
}

// ── сон ──
const FACTOR = {
  fall: ['Засыпание', { fast: 'сразу', moderate: 'умеренно', long: 'долго' }],
  continuity: ['Сон', { solid: 'сплошной', interrupted: 'прерывался' }],
  awakening: ['Пробуждение', { self: 'сам', alarm: 'будильник' }],
  rise: ['Подъём', { fresh: 'бодро', hard: 'тяжело' }],
  verdict: ['Длительность', { short: 'недосып', ok: 'норма', long: 'пересып' }],
};
function sleepBlock() {
  const s = safe(() => C.sleepStats?.(14));
  const head = `<div class="section" data-dom="sleep"><div class="section-title"><span class="smallcaps">Сон · 14 дней</span>${s?.trend != null ? `<span class="note">${esc(trendText(s.trend))}</span>` : ''}</div>`;
  if (!s || !(s.avgHours > 0)) return `${head}<p class="empty">${C.sleepStats ? 'Отмечайте сон на экране «Сегодня» - после трёх ночей здесь появится статистика.' : 'Статистика сна пока недоступна.'}</p></div>`;
  const factors = Object.entries(s.byFactor || {}).map(([k, v]) => {
    const [title, labels] = FACTOR[k] || [k, {}];
    if (v == null || typeof v !== 'object') return '';
    const cells = Object.entries(v).map(([opt, val]) => {
      const cnt = typeof val === 'number' ? val : val?.n ?? val?.count;
      const sc = typeof val === 'object' ? (val.avgScore ?? val.score) : null;
      return cnt || sc != null ? `<span class="chip">${esc(labels[opt] || opt)}${cnt != null ? ` <span class="mono">${cnt}</span>` : ''}${sc != null ? ` <span class="muted mono">· ${Math.round(sc)}</span>` : ''}</span>` : '';
    }).join('');
    return cells ? `<div class="pg-factor"><span class="smallcaps muted">${esc(title)}</span><div class="chips">${cells}</div></div>` : '';
  }).join('');
  return `${head}<div class="pg-stats">
      <div><b class="mono">${hm(s.avgHours)}</b><span>в среднем за ночь</span></div>
      <div><b class="mono">${s.avgScore != null ? Math.round(s.avgScore) : '-'}</b><span>индекс качества из 100</span></div>
      <div><b class="mono">${s.bedtimeSpreadMin != null ? '±' + Math.round(s.bedtimeSpreadMin) : '-'}</b><span>мин разброс отхода ко сну</span></div>
      <div><b class="mono">${s.shortNights ?? '-'}</b><span>ночей с недосыпом</span></div>
      ${s.snoozeNights ? `<div><b class="mono">${s.avgSnooze}</b><span>мин дрёмы после будильника (${s.snoozeNights} ${s.snoozeNights === 1 ? 'ночь' : s.snoozeNights < 5 ? 'ночи' : 'ночей'})</span></div>` : ''}</div>
    <p class="note">${esc(sleepAdvice(s))}</p>
    ${factors ? `<div class="pg-factors">${factors}</div><p class="note">Числа - сколько ночей; серым - средний индекс качества в такие ночи.</p>` : ''}</div>`;
}
function trendText(t) {
  if (typeof t === 'string') return { up: 'становится лучше', down: 'становится хуже', flat: 'без изменений' }[t] || t;
  return t > 0 ? 'становится лучше' : t < 0 ? 'становится хуже' : 'без изменений';
}
function sleepAdvice(s) {
  if (s.avgHours < 7) return 'Сна меньше нормы (7–9 ч). Недосып мешает худеть и восстанавливаться - попробуйте ложиться на 30 минут раньше.';
  if (s.snoozeNights >= 3 && s.avgSnooze >= 30) return `После первого будильника вы в среднем ${s.avgSnooze} мин дремлете. Это рваный сон: лучше один будильник на время реального подъёма - те же минуты уйдут в полноценный сон.`;
  if (s.bedtimeSpreadMin > 60) return 'Время отхода ко сну сильно гуляет. Постоянный режим (±30 мин) улучшает качество сна сильнее, чем лишний час.';
  if (s.avgHours > 9.5) return 'Сна больше обычного. Если при этом нет бодрости - стоит обратить внимание.';
  return 'Сон в норме. Так держать.';
}

// ── замеры: общие данные ──
const MEASURES = [['weight', 'Вес', 'кг'], ['neck', 'Шея', 'см'], ['chest', 'Грудь', 'см'], ['waist', 'Талия', 'см'], ['belly', 'Живот', 'см'], ['hips', 'Бёдра (таз)', 'см'],
  ['arm_l', 'Рука левая', 'см'], ['arm_r', 'Рука правая', 'см'], ['thigh_l', 'Бедро левое', 'см'], ['thigh_r', 'Бедро правое', 'см'], ['calf_l', 'Голень левая', 'см'], ['calf_r', 'Голень правая', 'см']];
const CM = MEASURES.slice(1).map(m => m[0]);
const bodyRecs = () => store.list('body').filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date));
function lastMeasureDate() { const r = bodyRecs().filter(r => CM.some(k => r.data[k])); return r.length ? r[r.length - 1].date : null; }
function measureDue() { const d = lastMeasureDate(); return !d || C.addDays(d, 30) <= C.today(); }

// ════════════ #body ════════════
function viewBody(arg) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? arg : C.today();
  const uid = store.uid();
  const rec = store.get(`body:${uid}:${date}`)?.data || {};
  const recs = bodyRecs();
  const last = lastMeasureDate();
  const job = jobFor('analysis');
  const analysis = store.list('coach').filter(r => r.data.kind === 'analysis').sort((a, b) => b.updated_at - a.updated_at)[0];
  const series = MEASURES.map(([k, name, unit]) => ({ k, name, unit, pts: recs.filter(r => r.data[k] != null && r.data[k] !== '').map(r => ({ date: r.date, v: +r.data[k] })) })).filter(s => s.pts.length);
  const monthAgo = C.addDays(C.today(), -30);

  const cards = series.map(s => {
    const first = s.pts[0], lastp = s.pts[s.pts.length - 1];
    const base = [...s.pts].reverse().find(p => p.date <= monthAgo);
    return `<div class="pg-m"><div class="pg-m-h"><span class="smallcaps">${esc(s.name)}</span><b class="mono">${dec(lastp.v)}</b></div>
      ${s.pts.length > 1 ? lineChart([{ pts: s.pts }], { h: 44, cls: 'mini', dots: s.pts }) : '<div class="pg-m-empty note">один замер</div>'}
      <div class="pg-m-d mono"><span>всего ${s.pts.length > 1 ? sgn(lastp.v - first.v) : '-'}</span><span>за мес. ${base ? sgn(lastp.v - base.v) : '-'}</span></div></div>`;
  }).join('');

  const hist = recs.filter(r => CM.some(k => r.data[k] != null && r.data[k] !== '')).reverse();   // вес без сантиметров — на графике веса
  const cols = MEASURES.filter(([k]) => hist.some(r => r.data[k] != null && r.data[k] !== ''));

  return `<div class="kicker smallcaps">Прогресс · замеры</div><h1>Дневник замеров</h1>
    <p class="lede">Раз в месяц, утром, до еды. Сантиметры показывают то, чего не видно на весах.</p>
    ${measureDue() ? `<div class="notice">${last ? `Последние замеры - ${esc(fmt(last, { day: 'numeric', month: 'long' }))}. Прошёл месяц - пора обновить.` : 'Замеров ещё нет. Сделайте первые - через месяц будет с чем сравнить.'}</div>` : ''}

    <div class="section"><div class="section-title"><span class="smallcaps">Замеры за день</span></div>
      <div class="grid3">${field('Дата', `<input class="control" type="date" data-act="body-date" value="${date}" max="${C.today()}">`)}</div>
      <div class="pg-mform">${MEASURES.map(([k, name, unit]) => field(`${name}, ${unit}`, input('body', k, rec[k] ?? '', `type="number" inputmode="decimal" step="0.1" min="0"`))).join('')}</div>
      <details class="pf-inner"><summary>Как мерить</summary><ul class="small">
        <li>Сантиметровая лента - горизонтально, плотно, но не пережимая кожу.</li>
        <li>Шея - под кадыком; грудь - по самым выступающим точкам; талия - самое узкое место; живот - по пупку; бёдра - по самым широким точкам ягодиц.</li>
        <li>Рука - в самой широкой части расслабленного плеча; бедро - на 15 см выше колена; голень - в самой широкой части.</li>
        <li>Каждый раз в одно время и в одних условиях - тогда цифры сравнимы.</li></ul></details>
      <div class="actions"><button class="btn solid" data-act="body-save" data-date="${date}">Сохранить замеры</button>
        ${date !== C.today() ? `<a class="btn quiet" href="#body/${C.today()}">К сегодня</a>` : ''}</div></div>

    ${cards ? `<div class="section" data-dom="goal"><div class="section-title"><span class="smallcaps">Динамика</span><span class="note">изменение от старта и за месяц</span></div>
      <div class="pg-mgrid">${cards}</div></div>` : ''}

    ${hist.length ? `<div class="section"><div class="section-title"><span class="smallcaps">История</span></div>
      <div class="pg-table-w"><table class="pg-table"><thead><tr><th>Дата</th>${cols.map(([, name]) => `<th>${esc(name)}</th>`).join('')}</tr></thead>
      <tbody>${hist.map(r => `<tr><td><a class="link" href="#body/${r.date}">${esc(short(r.date))}</a></td>${cols.map(([k]) => `<td class="mono">${r.data[k] != null && r.data[k] !== '' ? dec(r.data[k]) : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>` : ''}

    <div class="section"><div class="section-title"><span class="smallcaps">Анализ истории</span></div>
      <p class="note" style="margin-top:0">Тренер сопоставит замеры, вес, питание, сон и тренировки и скажет, что сработало.</p>
      ${job ? `<div class="notice"><span class="spinner"></span> Тренер анализирует историю${job.ahead ? ` · в очереди ${job.ahead}` : ''}…</div>` : ''}
      <div class="actions" style="margin-top:8px"><button class="btn" data-act="body-analysis" ${job || !store.state.online || aiOff() ? 'disabled' : ''}>Проанализировать</button>${aiOff() ? aiOffHint('Анализ делает ИИ') : `<span class="note">${store.state.online ? 'локальная ИИ, по запросу' : 'локальная ИИ на сервере - нужна связь с ним'}</span>`}</div>
      ${analysis ? reviewCard(analysis) : ''}</div>`;
}

function reviewCard(r) {
  const d = r.data;
  const list = d.next || d.points || d.recommendations || [];
  return `<div class="inset review"><div class="smallcaps muted">${esc(fmt(r.date || C.today(), { day: 'numeric', month: 'long' }))}</div>
    ${d.title ? `<h3 style="margin:4px 0">${esc(d.title)}</h3>` : ''}${d.text ? `<p>${esc(d.text)}</p>` : ''}
    ${list.length ? `<div class="smallcaps muted" style="margin-top:8px">${d.kind === 'weekly' ? 'На следующую неделю' : 'Что делать дальше'}</div><ul class="small">${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${d.day_tip ? `<p class="note"><b>Совет на каждый день:</b> ${esc(d.day_tip)}</p>` : ''}</div>`;
}

// ════════════ #week ════════════
// смысловые цвета частей оценки и буквы недели (accents.css)
const PART_DOM = { activity: 'move', workouts: 'train', sleep: 'sleep', food: 'food', water: 'water', state: 'mood' };
const LETTER_G = { A: 'good', B: 'good', C: 'ok', D: 'bad', E: 'bad' };
const PARTS = [['activity', 'Активность'], ['workouts', 'Тренировки'], ['sleep', 'Сон'], ['food', 'Питание'], ['water', 'Вода'], ['state', 'Самочувствие']];
const partVal = p => (p == null ? null : typeof p === 'number' ? p : p.score ?? p.pct ?? null);
const MOOD = { great: [MOOD_GLYPH.great, 'отлично'], good: [MOOD_GLYPH.good, 'хорошо'], meh: [MOOD_GLYPH.meh, 'так себе'], broken: [MOOD_GLYPH.broken, 'разбит'] };
const DAYTYPE = { cheat: 'читмил', special: 'особый день', sick: 'болезнь', rest: 'отдых' };

function dayRow(d) {
  const uid = store.uid();
  const tg = C.target();
  const foods = store.byDate('food', d).filter(r => r.data.totals);
  const t = foods.reduce((a, r) => ({ kcal: a.kcal + (r.data.totals.kcal || 0), p: a.p + (r.data.totals.p || 0), f: a.f + (r.data.totals.f || 0), c: a.c + (r.data.totals.c || 0) }), { kcal: 0, p: 0, f: 0, c: 0 });
  const its = C.items();
  const water = its.find(i => i.data.target_from === 'water'), steps = its.find(i => i.data.target_from === 'steps');
  const wv = water ? Number(C.logVal(d, water.id)) || 0 : null, wt = water ? C.itemTarget(water, d) : null;
  const sv = steps ? Number(C.logVal(d, steps.id)) || 0 : null;
  const srec = safe(() => C.sleep?.(d)) || store.get(`sleep:${uid}:${d}`);
  const sinfo = srec ? safe(() => C.sleepInfo?.(srec.data || srec)) : null;
  const state = safe(() => C.stateOf?.(d)) || store.get(`state:${uid}:${d}`)?.data;
  const dt = safe(() => C.dayType?.(d)) || store.get(`daytype:${uid}:${d}`)?.data?.type;
  const cls = v => (!tg || !foods.length ? '' : v > 1.1 ? 'over' : v < 0.85 ? 'under' : 'hit');
  const cups = safe(() => C.cups(d, uid), null);
  return { d, pct: C.pctOf(d, uid), t, has: foods.length > 0, kc: tg ? cls(t.kcal / tg.kcal) : '', pc: tg ? cls(t.p / tg.p) : '', wv, wt, sv, sinfo, state, dt, cups, future: d > C.today() };
}

function viewWeek(arg) {
  const mon = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? mondayOf(arg) : mondayOf(C.today());
  const sun = C.addDays(mon, 6), prev = C.addDays(mon, -7), next = C.addDays(mon, 7);
  const isCur = mon === mondayOf(C.today());
  const wsRaw = safe(() => C.weekSummary?.(mon));
  const ws = wsRaw && wsRaw.score != null ? wsRaw : null;
  const wsPrev = safe(() => C.weekSummary?.(prev));
  const tg = C.target();
  const days = Array.from({ length: 7 }, (_, i) => dayRow(C.addDays(mon, i)));
  const past = days.filter(r => !r.future);
  const fed = past.filter(r => r.has);
  const avg = (arr, f) => (arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : null);
  const job = jobFor(`weekly:${mon}`) || (isCur ? jobFor('weekly') : null);
  const reviews = store.list('coach').filter(r => r.data.kind === 'weekly' && ((r.data.monday && r.data.monday === mon) || (!r.data.monday && r.date >= mon && r.date <= C.addDays(sun, 1))))
    .sort((a, b) => b.updated_at - a.updated_at);
  const partners = store.partners().map(p => ({ p, w: store.get(`ws:${p.id}:${mon}`)?.data })).filter(x => x.w);
  const score = ws?.score != null ? Math.round(ws.score) : null;
  const delta = score != null && wsPrev?.score != null ? score - Math.round(wsPrev.score) : null;

  return `<div class="head-row"><div><div class="kicker smallcaps">Неделя · ${esc(short(mon))} - ${esc(short(sun))}</div>
      <h1>${ws?.grade ? `${gradeGlyph(ws.grade)} Оценка ${esc(ws.grade)}` : ws?.started ? 'Неделя только началась' : 'Недельный отчёт'}</h1></div>
    <div class="datenav"><a class="btn quiet" href="#week/${prev}" aria-label="Прошлая неделя">←</a>
      ${!isCur ? `<a class="btn" href="#week/${mondayOf(C.today())}">Эта неделя</a>` : ''}
      ${!isCur ? `<a class="btn quiet" href="#week/${next}" aria-label="Следующая неделя">→</a>` : ''}</div></div>
    ${isCur ? '<p class="lede">Неделя ещё идёт - оценка обновляется каждый день.</p>' : ''}

    ${ws ? `<div class="summary"><div class="pg-score g-${LETTER_G[ws.grade] || 'none'}"><b class="mono">${score}</b><span class="smallcaps muted">из 100</span></div><div class="pg-cmp">
        ${delta != null ? `<span class="chip">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} к прошлой неделе</span>` : ''}
        ${partners.map(x => `<span class="chip">${esc(x.p.name)}: ${gradeGlyph(x.w.grade)} ${esc(x.w.grade || '')}${x.w.score != null ? ` · ${Math.round(x.w.score)}` : ''}</span>`).join('')}
      </div></div>
      <div class="pg-parts">${PARTS.filter(([k]) => ws.parts?.[k] != null).map(([k, l]) => {
        const raw = ws.parts[k];
        if (k === 'workouts' && typeof raw === 'object') {
          const pl = raw.planned || 0, dn = raw.done || 0;
          if (!pl && !dn) return '';
          return `<div class="pg-part"${PART_DOM[k] ? ` data-dom="${PART_DOM[k]}"` : ''}><span class="smallcaps muted">${l}</span><div class="groove"><div class="fill" style="width:${pl ? Math.min(100, Math.round(dn / pl * 100)) : 100}%"></div></div>
            <span class="mono">${dn} из ${pl}</span></div>`;
        }
        const v = partVal(raw), pv = partVal(wsPrev?.parts?.[k]);
        return `<div class="pg-part"${PART_DOM[k] ? ` data-dom="${PART_DOM[k]}"` : ''}><span class="smallcaps muted">${l}</span><div class="groove"><div class="fill" style="width:${Math.max(0, Math.min(100, v ?? 0))}%"></div></div>
          <span class="mono">${v != null ? Math.round(v) : '-'}${pv != null && v != null ? `<i class="${v >= pv ? 'up' : 'down'}"> ${v >= pv ? '+' : '−'}${Math.abs(Math.round(v - pv))}</i>` : ''}</span></div>`;
      }).join('')}</div>`
    : `<p class="note">${wsRaw ? 'Для оценки недели пока мало записей - отмечайте день, сон и еду.' : 'Сводная оценка недели пока недоступна.'} Ниже - цифры по дням.</p>`}

    <div class="section"><div class="section-title"><span class="smallcaps">По дням</span>${tg ? `<span class="note">норма ${num(tg.kcal)} ккал · белок ${tg.p} г</span>` : ''}</div>
      <div class="pg-table-w"><table class="pg-table pg-week"><thead><tr><th>День</th><th>Чек-лист</th><th>Ккал</th><th>Б / Ж / У</th><th>Вода</th><th title="чашек кофе / чая; в скобках - после 14:00">Кофе / чай</th><th>Шаги</th><th>Сон</th><th>Состояние</th></tr></thead>
      <tbody>${days.map(r => `<tr class="${r.future ? 'fut' : ''}"><td><a class="link" href="#day/${r.d}">${WD[(C.parse(r.d).getDay() + 6) % 7]} ${C.parse(r.d).getDate()}</a>${r.dt ? `<span class="pg-dt">${esc(DAYTYPE[r.dt] || r.dt)}</span>` : ''}</td>
        <td class="mono">${r.future ? '' : r.pct + '%'}</td>
        <td class="mono ${r.kc}">${r.has ? num(r.t.kcal) : ''}</td>
        <td class="mono"><span class="${r.pc}">${r.has ? Math.round(r.t.p) : ''}</span>${r.has ? ` / ${Math.round(r.t.f)} / ${Math.round(r.t.c)}` : ''}</td>
        <td class="mono">${r.wv != null && !r.future ? `${r.wv}/${r.wt}` : ''}</td>
        <td class="mono">${r.cups?.tracked && !r.future && (r.cups.coffee || r.cups.tea) ? `${C.cupNum(r.cups.coffee || 0)} / ${C.cupNum(r.cups.tea || 0)}${r.cups.late ? ` (${C.cupNum(r.cups.late)})` : ''}` : ''}</td>
        <td class="mono">${r.sv ? num(r.sv) : ''}</td>
        <td class="mono">${r.sinfo?.hours ? hm(r.sinfo.hours) : ''}</td>
        <td>${r.state?.wellbeing ? `<span title="${esc(MOOD[r.state.wellbeing]?.[1] || '')}">${MOOD[r.state.wellbeing]?.[0] || ''}</span>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Среднее</td><td class="mono">${past.length ? Math.round(avg(past, r => r.pct)) + '%' : ''}</td>
        <td class="mono">${fed.length ? num(avg(fed, r => r.t.kcal)) : ''}</td><td class="mono">${fed.length ? `${Math.round(avg(fed, r => r.t.p))} / ${Math.round(avg(fed, r => r.t.f))} / ${Math.round(avg(fed, r => r.t.c))}` : ''}</td>
        <td></td><td class="mono">${past.some(r => r.cups?.tracked && (r.cups.coffee || r.cups.tea)) ? (() => { const c = past.filter(r => r.cups?.tracked); return `${(avg(c, r => r.cups.coffee || 0)).toFixed(1).replace('.', ',')} / ${(avg(c, r => r.cups.tea || 0)).toFixed(1).replace('.', ',')}`; })() : ''}</td><td class="mono">${past.some(r => r.sv) ? num(avg(past.filter(r => r.sv), r => r.sv)) : ''}</td>
        <td class="mono">${past.some(r => r.sinfo?.hours) ? hm(avg(past.filter(r => r.sinfo?.hours), r => r.sinfo.hours)) : ''}</td><td></td></tr></tfoot></table></div>
      <p class="note">Зелёным - в норме, терракотой - перебор калорий или недобор белка. Питание считается по дням, где оно записано.</p></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Разбор недели</span></div>
      ${job ? `<div class="notice"><span class="spinner"></span> Тренер разбирает неделю${job.ahead ? ` · в очереди ${job.ahead}` : ''}…</div>` : ''}
      ${reviews.length ? reviews.slice(0, 2).map(reviewCard).join('') : '<p class="note" style="margin-top:0">Тренер посмотрит на все цифры недели и даст задачи на следующую и совет на каждый день.</p>'}
      <div class="actions"><button class="btn solid" data-act="weekly" data-mon="${mon}" ${job || !store.state.online || aiOff() ? 'disabled' : ''}>${reviews.length ? 'Разобрать заново' : 'Разобрать неделю'}</button>
        ${aiOff() ? aiOffHint('Разбор недели делает ИИ') : `<span class="note">${store.state.online ? 'локальная ИИ, по вашим цифрам' : 'локальная ИИ на сервере - нужна связь с ним; цифры выше посчитаны и без неё'}</span>`}</div></div>`;
}

// ── действия ──
export const actions = {
  ...AN.actions,
  'goal-test': async el => {
    const id = el.dataset.m, m = GL.metric(id);
    const v = parseFloat(String(fval('gtest', id, document.querySelector(`[data-form=gtest][data-key=${id}]`)?.value || '')).replace(',', '.'));
    if (!(v > 0)) return toast('Впишите результат');
    await GL.record(id, v);
    if (S.forms.gtest) delete S.forms.gtest[id];
    toast(`Записал: ${m.label.toLowerCase()} ${GL.fmtNum(v, m)} ${m.unit}`);
    await afterChange(C.today());
  },
  'weight-add': async () => {
    const w = parseFloat(String(fval('weight', 'w', document.querySelector('[data-form=weight]')?.value || '')).replace(',', '.'));
    if (!(w > 20 && w < 400)) return toast('Введите вес в килограммах');
    const d = C.today();
    await store.put('body', `body:${store.uid()}:${d}`, { ...(store.get(`body:${store.uid()}:${d}`)?.data || {}), weight: w }, d);
    S.forms.weight = {};
    toast('Вес записан');
    await afterChange(d);
  },
  weekly: async el => {
    const mon = el.dataset.mon || mondayOf(C.today());
    const sun = C.addDays(mon, 6);
    const end = sun < C.today() ? sun : C.today();
    try {
      await store.sync();
      await safe(() => C.refreshWsum?.(mon));
      const res = await store.api('/api/ai/jobs', { kind: 'weekly', input: { end, monday: mon } });
      await addJob(res.job_id, 'weekly', `weekly:${mon}`);
    } catch (e) { toast(apiMsg(e, 'Разбор недели'), 5000); }
  },
  'body-save': async el => {
    const date = el.dataset.date || C.today();
    const f = S.forms.body || {};
    const id = `body:${store.uid()}:${date}`;
    const cur = { ...(store.get(id)?.data || {}) };
    let changed = 0;
    for (const [k] of MEASURES) {
      if (!(k in f)) continue;
      const raw = String(f[k]).trim().replace(',', '.');
      if (raw === '') { if (cur[k] != null) { delete cur[k]; changed++; } continue; }
      const v = Number(raw);
      if (!(v > 0 && v < 400)) return toast('Проверьте значения: нужны числа в сантиметрах (вес - в кг)');
      if (cur[k] !== v) { cur[k] = v; changed++; }
    }
    if (!changed) return toast('Нечего сохранять - введите хотя бы один замер');
    await store.put('body', id, cur, date);
    S.forms.body = {};
    toast('Замеры сохранены');
    await afterChange(date);
  },
  'body-analysis': async () => {
    try {
      await store.sync();
      const res = await store.api('/api/ai/jobs', { kind: 'analysis', input: { scope: 'body' } });
      await addJob(res.job_id, 'analysis', 'analysis');
    } catch (e) { toast(apiMsg(e, 'Анализ истории'), 5000); }
  },
};

export const changes = {
  'body-date': el => { if (el.value) location.hash = `#body/${el.value}`; },
};

export const routes = { progress: () => viewProgress(), week: arg => viewWeek(arg), body: arg => viewBody(arg) };

export function afterRender(arg) {
  const v = location.hash.slice(1).split('/')[0];
  if (v === 'week' && C.refreshWsum) {
    const mon = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? mondayOf(arg) : mondayOf(C.today());
    if (mon <= C.today()) Promise.resolve().then(() => C.refreshWsum(mon)).catch(e => console.warn(e));
  }
}
