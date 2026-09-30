// Витамины и добавки: карточка на «Сегодня», раздел профиля, справочник, окна приёмов и плана.
// Логика и данные - supps.js; здесь только разметка и действия.
import * as store from '../store.js';
import * as C from '../coach.js';
import * as SP from '../supps.js';
import { S, esc, num, dec, fmt, toast, openModal, closeModal, afterChange, nowHM, glyph } from '../ui.js';

const LVL_CLS = { A: 'good', B: 'ok', C: 'weak', D: 'bad' };
const lvl = l => (l ? `<span class="chip sp-lvl sp-${LVL_CLS[l] || 'weak'}" title="${esc(SP.LEVEL[l] || '')}">${esc(l)}</span>` : '');
const TIMING = { morning: 'утром', day: 'днём', evening: 'вечером', with_food: 'с едой', empty_stomach: 'натощак', before_workout: 'до тренировки',
  during_workout: 'во время тренировки', after_workout: 'после тренировки', before_sleep: 'перед сном', any: 'в любое время' };
const isToday = d => d === C.today();
const UNIT_SHORT = { 'мерная ложка': 'ложка', капсула: 'капс.', таблетка: 'табл.', порция: 'порц.' };
const us = u => UNIT_SHORT[u] || u || '';

// ── «Сегодня» ──
export function todayCard(date) {
  if (!SP.enabled()) return '';
  const st = SP.dayStatus(date);
  const done = st.reduce((a, x) => a + Math.min(x.taken.length, x.planned), 0), total = st.reduce((a, x) => a + x.planned, 0);
  const adv = date === C.today() ? SP.advice()[0] : null;
  return `<div class="section sp-today" data-dom="food"><div class="section-title"><span class="smallcaps">Добавки</span><span class="note">${done} из ${total}</span></div>
    ${st.map(({ s, planned, taken, left }) => {
      const stop = SP.warnings(s).some(w => w.level === 'stop');
      const hint = [taken.map(r => [r.data.time, r.data.dose ? SP.doseText(r.data.dose, r.data.dose_unit) : ''].filter(Boolean).join(' ')).join(', '), left.length ? `ещё ${left.join(', ')}` : ''].filter(Boolean).join(' · ')
        || (s.times?.length ? `по плану ${s.times.join(', ')}` : 'раз в день');
      const a = `data-key="${esc(s.key)}" data-date="${date}"`;
      return `<div class="row sp-row ${taken.length >= planned ? 'done' : ''}">
        <button class="tick ${taken.length >= planned ? 'on' : taken.length ? 'part' : ''}" data-act="sp-take" ${a} aria-label="Принял: ${esc(s.name)}">${glyph('check')}</button>
        <button class="sp-t" data-act="sp-intakes" ${a}><span class="title">${esc(s.name)}${stop ? ' <span class="chip sp-lvl sp-bad err" title="Есть предупреждение - откройте план приёма">внимание</span>' : ''}</span><span class="hint">${esc(hint)}</span></button>
        <span class="mono muted">${taken.length}/${planned}</span></div>`;
    }).join('')}
    ${adv ? adviceLine(adv, true) : ''}</div>`;
}

function adviceLine(a, compact = false) {
  return `<div class="notice sp-adv"><div><b>Тренер предлагает:</b> ${esc(a.item.name)} ${lvl(a.level)}${a.test ? ' <span class="note">по анализу</span>' : ''}
      <div class="small">${esc(a.why)}</div>${compact ? '' : `<div class="note">${esc(SP.LEVEL[a.level] || '')}. ${esc(SP.DISCLAIMER)}</div>`}</div>
    <div class="a-row-btns"><button class="btn quiet" data-act="sp-info" data-sid="${esc(a.item.id)}">Подробнее</button>
      <button class="btn quiet" data-act="sp-dismiss" data-k="${esc(a.key)}">Не сейчас</button></div></div>`;
}

// окно приёмов за день: время каждого правится, лишний удаляется, новый - с любым временем
function intakesModal(key, date, focusNew = false) {
  const s = SP.plan().find(x => x.key === key);
  if (!s) return;
  const list = SP.intakes(date, key), pd = SP.planDose(s), over = SP.dayOverUL(date, key);
  openModal(`<div class="modal-head"><h2>${esc(s.name)} · ${esc(fmt(date, { day: 'numeric', month: 'long' }))}</h2></div><div class="modal-body">
    <p class="note" style="margin-top:0">по плану ${esc(SP.doseText(pd.dose, pd.unit))} за приём${s.times?.length ? ` · ${esc(s.times.join(', '))}` : ''}</p>
    ${over ? `<div class="notice err">${esc(over)}</div>` : ''}
    ${list.length ? `<div class="sp-intakes">${list.map((r, i) => `<div class="sp-line"><span class="smallcaps muted">${i + 1}</span>
      <input class="control" type="time" value="${esc(r.data.time || '')}" data-act="sp-time" data-id="${r.id}" data-date="${date}" aria-label="Время приёма ${i + 1}">
      <label class="sp-dose"><input class="control mono" type="number" inputmode="decimal" min="0" step="any" value="${esc(r.data.dose ?? '')}" data-act="sp-dose" data-id="${r.id}" data-date="${date}" aria-label="Доза приёма ${i + 1}"><span class="muted">${esc(us(r.data.dose_unit || pd.unit))}</span></label>
      <button class="btn quiet" data-act="sp-rm" data-id="${r.id}" data-key="${esc(key)}" data-date="${date}" aria-label="Удалить приём ${i + 1}">${glyph('cross')}</button></div>`).join('')}</div>`
      : '<p class="note">Ещё не отмечено.</p>'}
    <div class="sp-line sp-new"><span class="smallcaps muted">+</span><input class="control" type="time" id="sp-new-time" value="${isToday(date) ? nowHM() : (s.times?.[0] || '')}" aria-label="Время приёма">
      <label class="sp-dose"><input class="control mono" type="number" inputmode="decimal" min="0" step="any" id="sp-new-dose" value="${esc(pd.dose)}" aria-label="Доза"><span class="muted">${esc(us(pd.unit))}</span></label>
      <button class="btn" data-act="sp-add" data-key="${esc(key)}" data-date="${date}">Отметить</button></div>
    </div><div class="modal-foot"><button class="btn quiet" data-act="sp-plan" data-key="${esc(key)}">План приёма</button><button class="btn solid" data-act="close">Готово</button></div>`);
  if (focusNew) document.getElementById('sp-new-time')?.focus();
}

// ── справочник ──
function infoModal(sid) {
  const it = SP.cat(sid);
  if (!it) return;
  const inPlan = SP.plan().some(s => s.sid === sid);
  openModal(`<div class="modal-head"><h2>${esc(it.name)} ${lvl(it.evidence)}</h2></div><div class="modal-body">
    <p class="note" style="margin-top:0">${esc(SP.CATEGORY[it.category] || '')} · ${esc(SP.LEVEL[it.evidence] || '')}</p>
    <p>${esc(it.about || '')}</p>
    ${it.claims?.length ? `<ul class="small sp-claims">${it.claims.map(c => `<li>${lvl(c.level)} ${esc(c.text)}${c.source ? ` <span class="note">(${esc(c.source)})</span>` : ''}</li>`).join('')}</ul>` : ''}
    <p class="small"><b>Обычная доза:</b> ${esc(it.dose?.text || '-')}${it.ul ? ` · безопасный предел ${num(it.ul.value)} ${esc(it.ul.unit)} в день (${esc(it.ul.source || '')})` : ''}</p>
    ${it.timing?.length ? `<p class="small"><b>Когда:</b> ${esc(it.timing.map(t => TIMING[t] || t).join(', '))}</p>` : ''}
    ${it.macros ? `<p class="small"><b>В порции</b> (${esc(it.serving?.label || '')}): ${num(it.macros.kcal)} ккал · Б ${dec(it.macros.p)} · Ж ${dec(it.macros.f)} · У ${dec(it.macros.c)} - учитывается в БЖУ дня</p>` : ''}
    ${it.cautions?.length ? `<div class="notice"><b>Осторожно:</b><ul class="small">${it.cautions.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
    ${it.needs_test ? '<p class="small"><b>Только по анализу</b> и после разговора с врачом.</p>' : ''}
    ${it.sport_note ? `<p class="note">${esc(it.sport_note)}</p>` : ''}
    <p class="note">${esc(SP.DISCLAIMER)}</p>
    </div><div class="modal-foot"><button class="btn quiet" data-act="sp-catalog">К справочнику</button>
      ${inPlan ? '<button class="btn solid" data-act="close">Понятно</button>' : `<button class="btn solid" data-act="sp-new" data-sid="${esc(sid)}">Принимаю</button>`}</div>`);
}

function catalogModal(q = '', catKey = '', focus = false) {
  const nq = q.trim().toLowerCase();
  const list = SP.catalog().filter(x => (!catKey || x.category === catKey)
    && (!nq || [x.name, ...(x.aliases || [])].some(a => String(a).toLowerCase().includes(nq))))
    .sort((a, b) => a.evidence.localeCompare(b.evidence) || a.name.localeCompare(b.name));
  const stop = nq.length >= 3 ? SP.stopMatch(nq) : null;
  const cats = [...new Set(SP.catalog().map(x => x.category))];
  openModal(`<div class="modal-head"><h2>Витамины и добавки</h2></div><div class="modal-body">
    <input class="control" id="sp-q" placeholder="магний, протеин, омега…" value="${esc(q)}" aria-label="Поиск" data-cat="${esc(catKey)}">
    <div class="chips sp-cats"><button class="chip ${catKey ? '' : 'on'}" data-act="sp-cat" data-c="">все</button>${cats.map(c => `<button class="chip ${c === catKey ? 'on' : ''}" data-act="sp-cat" data-c="${esc(c)}">${esc((SP.CATEGORY[c] || c).toLowerCase())}</button>`).join('')}</div>
    <p class="note">Буква - сила доказательств: A сильные, B умеренные, C слабые, D пользы не доказано.</p>
    ${stop ? `<div class="notice err"><b>${esc(stop.name)}:</b> ${esc(stop.why)}</div>` : ''}
    <div class="sp-list">${list.map(x => `<button class="sp-item" data-act="sp-info" data-sid="${esc(x.id)}"><span>${esc(x.name)}<span class="note"> · ${esc((SP.CATEGORY[x.category] || '').toLowerCase())}</span></span>${lvl(x.evidence)}</button>`).join('') || '<p class="empty">Ничего не нашлось.</p>'}</div>
    </div><div class="modal-foot"><button class="btn quiet" data-act="sp-custom">Своя добавка</button><button class="btn solid" data-act="close">Закрыть</button></div>`);
  const inp = document.getElementById('sp-q');
  if (inp && (q || focus)) { inp.focus(); inp.setSelectionRange(q.length, q.length); }
}

// ── план приёма: доза, время, дневная доза для проверки предела ──
function planModal(key, sid = null, custom = false) {
  const cur = key ? SP.plan().find(x => x.key === key) : null;
  const it = SP.cat(cur?.sid || sid);
  const s = cur || { sid, amount: 1, times: it?.default_times || ['08:00'], name: custom ? '' : it?.name };
  const sv = SP.servingOf(s), pd = SP.planDose(s);
  const warn = cur ? SP.warnings(cur) : it ? SP.warnings({ sid }) : [];
  const times = [...(s.times || []), '', ''].slice(0, 3);
  openModal(`<div class="modal-head"><h2>${custom && !cur ? 'Своя добавка' : esc(s.name || it?.name || '')}</h2></div><div class="modal-body">
    ${custom || cur?.custom ? `<label class="field"><span class="smallcaps">Название</span><input class="control" id="sp-name" value="${esc(s.name || '')}" placeholder="например: витамин D3 2000 МЕ"></label>
      <div class="grid3"><label class="field"><span class="smallcaps">Порция</span><input class="control" id="sp-serv" value="${esc(s.custom?.serving?.label || 'таблетка')}"></label>
        <label class="field"><span class="smallcaps">Ккал в порции</span><input class="control" id="sp-kcal" type="number" inputmode="decimal" min="0" value="${esc(s.custom?.macros?.kcal ?? '')}"></label>
        <label class="field"><span class="smallcaps">Белок, г</span><input class="control" id="sp-p" type="number" inputmode="decimal" min="0" value="${esc(s.custom?.macros?.p ?? '')}"></label></div>` : ''}
    <div class="grid3"><label class="field"><span class="smallcaps">Доза за приём</span><input class="control mono" id="sp-dose" type="number" inputmode="decimal" min="0" step="any" value="${esc(pd.dose)}"></label>
      <label class="field"><span class="smallcaps">Единица</span><select class="control" id="sp-unit">${[...new Set([pd.unit, ...SP.DOSE_UNITS])].map(u => `<option ${u === pd.unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label></div>
    <p class="note">${it ? `Порция в справочнике: ${esc(sv.label || sv.unit || '')}. Обычно: ${esc(it.dose?.text || '-')}.` : 'Укажите дозу по этикетке.'}</p>
    <div class="field"><span class="smallcaps">Время приёма</span><div class="sp-times">${times.map((t, i) => `<input class="control" type="time" id="sp-t${i}" value="${esc(t)}" aria-label="Время ${i + 1}">`).join('')}</div>
      <span class="note">пустое поле - не используется</span></div>
    ${it?.ul ? `<p class="note">Безопасный предел: ${num(it.ul.value)} ${esc(it.ul.unit)} в день - тренер сверит с вашей дозой.</p>` : ''}
    ${warn.map(w => `<div class="notice ${w.level === 'stop' ? 'err' : ''}">${esc(w.text)}</div>`).join('')}
    <p class="note">${esc(SP.DISCLAIMER)}</p>
    </div><div class="modal-foot">${cur ? `<button class="btn danger" data-act="sp-remove" data-key="${esc(cur.key)}">Не принимаю</button>` : '<button class="btn quiet" data-act="close">Отмена</button>'}
      <button class="btn solid" data-act="sp-save" data-key="${esc(cur?.key || '')}" data-sid="${esc(sid || cur?.sid || '')}" data-custom="${custom || cur?.custom ? 1 : ''}">Сохранить</button></div>`);
}

// ── профиль ──
export function profileSummary() {
  const n = SP.plan().length;
  return n ? `${n} ${n === 1 ? 'добавка' : n < 5 ? 'добавки' : 'добавок'}` : 'не отмечаю';
}
export function profileBody() {
  const pl = SP.plan(), adv = SP.advice();
  return `<p class="note" style="margin-top:0">По желанию: что вы принимаете. Приёмы отмечаются на «Сегодня», протеин и спортпит идут в БЖУ дня, а тренер сравнивает приём с самочувствием и сном.</p>
    ${pl.length ? `<div class="sp-plan">${pl.map(s => {
      const w = SP.warnings(s).filter(x => x.level !== 'info');
      return `<div class="row"><span></span><div><div class="title">${esc(s.name)} ${lvl(s.item?.evidence)}</div>
        <div class="hint">${esc(SP.doseText(SP.planDose(s).dose, SP.planDose(s).unit))} за приём${s.times?.length ? ` · ${esc(s.times.join(', '))}` : ''}</div>
        ${w.map(x => `<div class="small ${x.level === 'stop' ? 'err' : 'muted'}">${esc(x.text)}</div>`).join('')}</div>
        <button class="go" data-act="sp-plan" data-key="${esc(s.key)}">изменить</button></div>`;
    }).join('')}</div>` : ''}
    <div class="actions"><button class="btn" data-act="sp-catalog">${pl.length ? 'Добавить' : 'Выбрать из справочника'}</button><button class="btn quiet" data-act="sp-custom">Своя добавка</button></div>
    ${adv.length ? `<div class="smallcaps muted" style="margin-top:14px">Тренер предлагает</div>${adv.map(a => adviceLine(a)).join('')}` : ''}
    <p class="note">${esc(SP.DISCLAIMER)}</p>`;
}

// ── действия ──
const rerender = async date => { await afterChange(date || C.today()); };
export const actions = {
  // задним числом отмечаем так же, одним нажатием (как еда, активности и всё остальное) - время «сейчас»
  // не имеет смысла для прошлого дня, но его можно поправить потом, нажав на название приёма
  'sp-take': async el => {
    const { key, date } = el.dataset, s = SP.plan().find(x => x.key === key);
    if (!s) return;
    await SP.mark(s, date, nowHM());
    await rerender(date);
    toast(`${s.name}: отмечено${isToday(date) ? ` в ${nowHM()}` : ''} - время можно поправить, нажав на название`, 3000);
  },
  'sp-intakes': el => intakesModal(el.dataset.key, el.dataset.date),
  'sp-add': async el => {
    const { key, date } = el.dataset, s = SP.plan().find(x => x.key === key);
    if (!s) return;
    await SP.mark(s, date, document.getElementById('sp-new-time')?.value || nowHM(), Number(String(document.getElementById('sp-new-dose')?.value || '').replace(',', '.')) || null);
    await rerender(date);
    intakesModal(key, date);
  },
  'sp-rm': async el => { await SP.unmark(el.dataset.id); await rerender(el.dataset.date); intakesModal(el.dataset.key, el.dataset.date); },
  'sp-info': el => infoModal(el.dataset.sid),
  'sp-catalog': () => catalogModal(),
  'sp-cat': el => catalogModal(document.getElementById('sp-q')?.value || '', el.dataset.c),
  'sp-custom': () => planModal(null, null, true),
  'sp-new': el => planModal(null, el.dataset.sid),
  'sp-plan': el => planModal(el.dataset.key),
  'sp-dismiss': async el => { await SP.dismiss(el.dataset.k); await rerender(); toast('Хорошо, вернусь к этому позже'); },
  'sp-remove': async el => {
    await SP.savePlan((store.get(`profile:${store.uid()}`)?.data.supplements || []).filter(s => SP.keyOf(s) !== el.dataset.key));
    closeModal(); await rerender(); toast('Убрано из плана. Прошлые отметки остаются в истории.');
  },
  'sp-save': async el => {
    const { key, sid, custom } = el.dataset, v = id => document.getElementById(id)?.value ?? '';
    const list = [...(store.get(`profile:${store.uid()}`)?.data.supplements || [])];
    const i = key ? list.findIndex(s => SP.keyOf(s) === key) : -1;
    const base = i >= 0 ? list[i] : { key: sid || `custom_${store.newId().slice(0, 8)}`, sid: sid || null, active: true };
    const times = [0, 1, 2].map(n => v(`sp-t${n}`)).filter(Boolean).sort();
    const dose = Number(String(v('sp-dose')).replace(',', '.'));
    if (!(dose > 0)) return toast('Укажите дозу за приём');
    const next = { ...base, dose, dose_unit: v('sp-unit') || 'порция', times };
    delete next.amount; delete next.daily; delete next.daily_unit;
    if (custom) {
      const name = v('sp-name').trim();
      if (!name) return toast('Напишите название');
      const kcal = Number(v('sp-kcal')) || 0, p = Number(v('sp-p')) || 0;
      next.name = name;
      next.custom = { serving: { amount: 1, unit: v('sp-serv') || 'порция', label: v('sp-serv') || 'порция' }, macros: kcal || p ? { kcal, p, f: 0, c: Math.max(0, Math.round((kcal - p * 4) / 4 * 10) / 10) } : null };
      const stop = SP.stopMatch(name);
      if (stop && !confirmStop(el)) return;
    }
    if (i >= 0) list[i] = next; else list.push(next);
    await SP.savePlan(list);
    closeModal(); await rerender();
    const w = SP.warnings(next).find(x => x.level === 'stop');
    toast(w ? w.text : 'Сохранено', w ? 7000 : 2500);
  },
};
// вещество из стоп-листа: сохраняем только после второго нажатия, с явным предупреждением
function confirmStop(el) {
  if (el.dataset.confirmed) return true;
  el.dataset.confirmed = '1';
  el.textContent = 'Всё равно сохранить';
  toast('Это вещество в стоп-листе: опасно или запрещено. Тренер его не советует.', 6000);
  return false;
}

export const changes = {
  'sp-time': async el => { if (el.value) { await SP.setTime(el.dataset.id, el.value); await rerender(el.dataset.date); } },
  'sp-dose': async el => {
    const v = Number(String(el.value).replace(',', '.'));
    if (v > 0) { await SP.setDose(el.dataset.id, v); await rerender(el.dataset.date); }
  },
};

// поиск в справочнике - на ходу, без потери фокуса
document.addEventListener('input', e => {
  if (e.target.id === 'sp-q') catalogModal(e.target.value, e.target.dataset.cat || '', true);
});
