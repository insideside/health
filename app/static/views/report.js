// Отчёт за день/неделю/период: питание, сон, активности - печатается через системный диалог печати
// («Сохранить как PDF» есть в нём на любом устройстве), поэтому не нужен ни сервер, ни библиотека
// для рисования PDF (кириллица в них - отдельная головная боль со шрифтами, а печать браузера просто работает).
import * as store from '../store.js';
import * as C from '../coach.js';
import { S, esc, num, dec, fmt } from '../ui.js';

const PERIODS = [['day', 'День'], ['week', 'Неделя'], ['range', 'Период']];
const actName = type => (store.getMeta('activities', []) || []).find(a => a.id === type)?.name || type;

function form() {
  const today = C.today();
  return (S.forms.report ||= { period: 'day', date: today, from: C.addDays(today, -6), to: today });
}

function datesFor(f) {
  if (f.period === 'day') return [f.date];
  if (f.period === 'week') { const mon = C.mondayOf(f.date); return Array.from({ length: 7 }, (_, i) => C.addDays(mon, i)); }
  const from = f.from > f.to ? f.to : f.from, to = f.from > f.to ? f.from : f.to;
  const out = [];
  for (let d = from; d <= to && out.length < 62; d = C.addDays(d, 1)) out.push(d);
  return out;
}

function reportData(dates, uid = store.uid()) {
  const nutrition = dates.map(d => { const f = C.foodDay(d, uid); return f ? { date: d, kcal: f.kcal, p: f.p, f: f.f, c: f.c } : null; }).filter(Boolean);
  const sleepRows = dates.map(d => {
    const rec = C.sleep(d, uid), info = rec && C.sleepInfo(rec, uid);
    const nap = C.napMinutes?.(d, uid) || 0;
    return (info && !info.nap) || nap ? { date: d, hours: info && !info.nap ? info.hours : null, label: info && !info.nap ? info.label : '', nap } : null;
  }).filter(Boolean);
  const activities = dates.flatMap(d => store.byDate('activity', d, uid).map(r => ({ date: d, type: r.data.type, minutes: r.data.minutes, intensity: r.data.intensity })));
  return { nutrition, sleepRows, activities };
}

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const dayName = d => esc(fmt(d, { weekday: 'short', day: 'numeric', month: 'short' }));
const INT_NAME = { low: 'лёгкая', mid: 'средняя', high: 'высокая' };

function reportBody(f) {
  const dates = datesFor(f);
  const { nutrition, sleepRows, activities } = reportData(dates);
  const person = store.get(`profile:${store.uid()}`)?.data?.name || 'Пользователь';
  const title = f.period === 'day' ? `за ${dayName(f.date)}` : f.period === 'week' ? `за неделю с ${dayName(C.mondayOf(f.date))}` : `с ${dayName(dates[0])} по ${dayName(dates[dates.length - 1])}`;
  return `<div class="report-print">
    <h1>Отчёт ${title}</h1>
    <p class="note">${esc(person)} · сформировано ${esc(fmt(C.today(), { day: 'numeric', month: 'long', year: 'numeric' }))}</p>
    <h2>Питание</h2>
    ${nutrition.length ? `<table class="report-tbl"><thead><tr><th>День</th><th>Ккал</th><th>Белки</th><th>Жиры</th><th>Углеводы</th></tr></thead>
      <tbody>${nutrition.map(r => `<tr><td>${dayName(r.date)}</td><td>${num(r.kcal)}</td><td>${dec(r.p)}</td><td>${dec(r.f)}</td><td>${dec(r.c)}</td></tr>`).join('')}
      ${nutrition.length > 1 ? `<tr class="report-avg"><td>В среднем</td><td>${num(avg(nutrition.map(r => r.kcal)))}</td><td>${dec(avg(nutrition.map(r => r.p)))}</td><td>${dec(avg(nutrition.map(r => r.f)))}</td><td>${dec(avg(nutrition.map(r => r.c)))}</td></tr>` : ''}</tbody></table>`
      : '<p class="note">Питание за этот период не записано.</p>'}
    <h2>Сон</h2>
    ${sleepRows.length ? `<table class="report-tbl"><thead><tr><th>Ночь</th><th>Часы</th><th>Оценка</th><th>Днём, мин</th></tr></thead>
      <tbody>${sleepRows.map(r => `<tr><td>${dayName(r.date)}</td><td>${r.hours != null ? dec(r.hours) : '-'}</td><td>${esc(r.label)}</td><td>${r.nap || '-'}</td></tr>`).join('')}
      ${sleepRows.length > 1 ? `<tr class="report-avg"><td>В среднем</td><td>${sleepRows.some(r => r.hours != null) ? dec(avg(sleepRows.filter(r => r.hours != null).map(r => r.hours))) : '-'}</td><td></td><td>${sleepRows.some(r => r.nap) ? Math.round(avg(sleepRows.filter(r => r.nap).map(r => r.nap))) : '-'}</td></tr>` : ''}</tbody></table>`
      : '<p class="note">Сон за этот период не записан.</p>'}
    <h2>Активности</h2>
    ${activities.length ? `<table class="report-tbl"><thead><tr><th>День</th><th>Что</th><th>Минут</th><th>Интенсивность</th></tr></thead>
      <tbody>${activities.map(a => `<tr><td>${dayName(a.date)}</td><td>${esc(actName(a.type))}</td><td>${num(a.minutes || 0)}</td><td>${esc(INT_NAME[a.intensity] || '-')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="note">Активности за этот период не записаны.</p>'}
  </div>`;
}

function viewReport() {
  const f = form();
  return `<div class="kicker smallcaps">Прогресс · Отчёт</div><h1>Отчёт для печати</h1>
    <p class="lede">Питание, сон и активности за выбранный период - можно распечатать или сохранить как PDF через диалог печати браузера.</p>
    <div class="section no-print">
      <div class="chips">${PERIODS.map(([k, l]) => `<button type="button" class="chip ${f.period === k ? 'on' : ''}" data-act="rp-period" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="grid2" style="margin-top:12px">
        ${f.period === 'range'
          ? `<label class="field"><span class="smallcaps">С</span><input class="control" type="date" data-form="report" data-key="from" data-rerender value="${f.from}"></label>
             <label class="field"><span class="smallcaps">По</span><input class="control" type="date" data-form="report" data-key="to" data-rerender value="${f.to}"></label>`
          : `<label class="field"><span class="smallcaps">${f.period === 'week' ? 'Любой день этой недели' : 'Дата'}</span><input class="control" type="date" data-form="report" data-key="date" data-rerender value="${f.date}"></label>`}
      </div>
      <div class="actions" style="margin-top:14px"><button class="btn solid" data-act="rp-print">Печать / сохранить PDF</button></div>
    </div>
    ${reportBody(f)}`;
}

export const routes = { report: () => viewReport() };
export const actions = {
  'rp-period': el => { form().period = el.dataset.v; S.render(); },
  'rp-print': () => window.print(),
};
