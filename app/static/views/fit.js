// «Не предлагать», замены упражнений, сигнал «не заходит», карточки погоды и кардио на «Сегодня»,
// раздел профиля «Мои упражнения» (SPEC-v3 п. 17–20). Логика подбора — plan.js, данные — prefs.js.
import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import * as PF from '../prefs.js';
import * as MX from '../myex.js';
import { S, esc, fmt, profile, toast, openModal, closeModal, isModalOpen, afterChange, glyph, exCtx, ctxAttrs, showTech, field, input, textarea, chips, WD } from '../ui.js';

const exName = id => S.exMap.get(id)?.name || id;
const hm = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ── действия с упражнением в карточке: «Заменить», «Не предлагать», «Нравится» ──
export function exActions(id, ctx, { like = true } = {}) {
  const liked = PF.isLiked(id);
  return `<div class="fx-exacts">
    ${ctx ? `<button type="button" class="btn quiet a-mini" data-act="ex-swap-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Заменить</button>` : ''}
    <button type="button" class="btn quiet a-mini" data-act="ex-excl-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Не предлагать</button>
    <button type="button" class="btn quiet a-mini" data-act="ex-cl-open" data-ex="${esc(id)}">${clItem(id) ? 'В чек-листе' : 'В чек-лист'}</button>
    ${like ? `<button type="button" class="btn quiet a-mini fx-like ${liked ? 'on' : ''}" data-act="ex-like" data-ex="${esc(id)}" aria-pressed="${liked}">${liked ? `${glyph('heart', { fill: true })} любимое` : `${glyph('heart')} нравится`}</button>` : ''}
  </div>`;
}

// с кем общий комплекс, в котором меняем упражнение (творительный падеж имени) - или null
function pairWith(ctx) {
  const pa = ctx?.kind === 'routine' ? P.pairPartner?.(ctx.module) : null;
  return pa ? (C.nameForms?.(pa.id)?.ins || pa.name) : null;
}
// где запоминать замену: разминка/комплекс - по модулю, тренировка - по месту (зал/дом)
const swapPlace = ctx => (ctx?.kind === 'routine' ? ctx.module || 'morning' : P.ctxInfo(ctx)?.place || 'home');
const exMeta = e => [e.own ? 'своё' : '', e.how || '', (e.muscles || []).slice(0, 3).join(', '),
  (e.equipment || []).length ? (e.equipment || []).map(PF.equipLabel).join(', ') : 'без инвентаря'].filter(Boolean).join(' · ');
const altBtn = (e, ctx) => `<button type="button" class="raised fx-alt" data-act="ex-swap-do" data-to="${esc(e.id)}" ${ctxAttrs(ctx)}>
  <b>${esc(e.name)}</b>${PF.isLiked(e.id) ? ' <span class="chip">любимое</span>' : ''}<span class="note">${esc(exMeta(e))}</span></button>`;
function swapResults() {
  const f = S.forms.swp || {};
  if (!String(f.q || '').trim()) return '';
  const found = P.searchIn(f.ctx, f.q, 12);
  return found.length ? `<div class="fx-alts">${found.map(e => altBtn(e, f.ctx)).join('')}</div>`
    : '<p class="note">В каталоге не нашлось - добавьте как своё упражнение.</p>';
}
function swapModal(id, ctx, keepForm = false) {
  if (!keepForm) S.forms.swp = { id, ctx, q: '', always: ctx?.kind !== 'routine' };
  const f = S.forms.swp;
  const alts = P.alternativesIn(ctx, 5);
  const workout = ctx?.kind !== 'routine';
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Замена · ${esc(exName(id))}</div><h2>На что заменить?</h2></div>
    <div class="modal-body">${alts.length ? `<div class="fx-alts">${alts.map(e => altBtn(e, ctx)).join('')}</div>
      <p class="note">Тот же тип движения и мышцы, с учётом инвентаря, ограничений и «не предлагать». Отметки остальных упражнений сохранятся.</p>`
      : '<p class="note" style="margin-top:0">Похожего в каталоге нет - найдите другое или добавьте своё.</p>'}
      <div class="field" style="margin-top:12px"><span class="smallcaps">Другое упражнение</span>
        <input class="control" type="search" id="swp-q" value="${esc(f.q || '')}" placeholder="название или мышцы" autocomplete="off" aria-label="Найти упражнение для замены" data-act="swp-q"></div>
      <div id="swp-res">${swapResults()}</div>
      <div class="a-row-btns"><button type="button" class="btn quiet a-mini" data-act="mx-open" data-from="${esc(id)}" ${ctxAttrs(ctx)}>+ Своё упражнение</button></div>
      <label class="chk fx-swp-always"><input type="checkbox" data-form="swp" data-key="always" ${f.always ? 'checked' : ''}><span>И дальше ставить выбранное вместо «${esc(exName(id))}»${workout ? ' - и в следующих тренировках' : ''}</span></label>
      <p class="note">Тренер запоминает каждую замену и учитывает её в разборе недели, в чате и при следующей программе.</p>
      ${pairWith(ctx) ? `<div class="notice">Это общий комплекс с ${esc(pairWith(ctx))}: замена будет сразу у вас обоих.</div>` : ''}</div>
    <div class="modal-foot"><button class="btn quiet" data-act="ex-excl-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Не предлагать совсем</button><button class="btn" data-act="close">Отмена</button></div>`);
}

// ── своё упражнение: окно добавления/правки; из замены - сразу ставится вместо упражнения ──
const clItem = id => store.list('item').find(i => i.data.exercise_id === id && i.data.active !== false) || null;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
function myExModal() {
  const f = S.forms.mx;
  const days = f.days || [];
  return `<div class="modal-head"><div class="kicker smallcaps">${f.edit ? 'Своё упражнение' : f.from ? `Вместо «${esc(exName(f.from))}»` : 'Своё упражнение'}</div>
    <h2>${f.edit ? 'Изменить' : 'Новое упражнение'}</h2></div>
    <div class="modal-body fx-mx">
      ${field('Название', input('mx', 'name', '', 'id="mx-name" name="mx-exercise" placeholder="например: лимфодренажные прыжки" autocomplete="off" autocorrect="off" data-lpignore="true" data-1p-ignore'))}
      ${field('Сколько', input('mx', 'how', '', 'placeholder="3 минуты, 50 раз, 3 × 12"'))}
      <div class="field"><span class="smallcaps">Что это</span>${chips('mx', 'category', f.category || 'cardio', MX.CATEGORIES)}</div>
      <div class="field"><span class="smallcaps">Где делаю</span>${chips('mx', 'place', f.place || ['home'], [['home', 'дома'], ['gym', 'в зале']], true)}</div>
      ${field('Как делать (по желанию)', textarea('mx', 'technique', '', 'rows="3" placeholder="по шагу на строку"'))}
      <div class="field"><span class="smallcaps">В чек-лист</span>
        <div class="chips">${WD.map((w, i) => `<button type="button" class="chip ${days.includes(i) ? 'on' : ''}" aria-pressed="${days.includes(i)}" data-act="mx-day" data-d="${i}">${esc(w)}</button>`).join('')}
          <button type="button" class="chip ${days.length === 7 ? 'on' : ''}" data-act="mx-day" data-d="all">каждый день</button></div>
        <p class="note">${days.length ? `Будет пунктом чек-листа ${days.length === 7 ? 'каждый день' : `по дням: ${days.map(d => WD[d]).join(', ')}`}.` : 'Дни не выбраны - упражнение будет в каталоге: для замены, закрепления в разминке и записи тренировки.'}</p></div>
    </div>
    <div class="modal-foot">${f.edit ? `<button class="btn danger" data-act="mx-del" data-ex="${esc(f.edit)}">Удалить</button>` : '<button class="btn quiet" data-act="close">Отмена</button>'}
      <button class="btn solid" data-act="mx-save">${f.from ? 'Сохранить и заменить' : 'Сохранить'}</button></div>`;
}
export function openMyEx({ edit = null, from = null, ctx = null } = {}) {
  const e = edit ? MX.byId(edit) : null, it = edit ? clItem(edit) : null;
  S.forms.mx = e ? { edit, name: e.name, how: e.how, category: e.category, place: e.place, technique: MX.recOf(edit)?.data.technique || '',
    days: it ? (it.data.weekdays?.length ? it.data.weekdays : ALL_DAYS) : [] }
    : { from, ctx, category: 'cardio', place: [ctx && P.ctxInfo(ctx)?.place === 'gym' ? 'gym' : 'home'], days: [] };
  openModal(myExModal());
  setTimeout(() => document.getElementById('mx-name')?.focus(), 60);
}
// пункт чек-листа для упражнения (своего или из каталога): дни недели, пусто - убрать из чек-листа
async function setChecklist(id, days) {
  const e = S.exMap.get(id), it = store.list('item').find(i => i.data.exercise_id === id);
  if (!days.length) { if (it) await store.patch(it.id, { active: false }); return; }
  const title = e ? `${e.name}${e.how ? ` · ${e.how}` : ''}` : id;
  const weekdays = days.length === 7 ? [] : [...days].sort();
  if (it) await store.patch(it.id, { title, weekdays, active: true });
  else {
    const order = Math.max(0, ...store.list('item').map(i => i.data.order ?? 0)) + 1;
    await store.put('item', store.newId(), { title, type: 'bool', group: 'day', exercise_id: id, weekdays, order, active: true });
  }
}
function clModal(id) {
  const f = S.forms.cl;
  const days = f.days || [];
  return `<div class="modal-head"><div class="kicker smallcaps">В чек-лист</div><h2>${esc(exName(id))}</h2></div>
    <div class="modal-body fx-mx"><div class="field"><span class="smallcaps">По каким дням</span>
      <div class="chips">${WD.map((w, i) => `<button type="button" class="chip ${days.includes(i) ? 'on' : ''}" aria-pressed="${days.includes(i)}" data-act="cl-day" data-d="${i}">${esc(w)}</button>`).join('')}
        <button type="button" class="chip ${days.length === 7 ? 'on' : ''}" data-act="cl-day" data-d="all">каждый день</button></div></div>
      <p class="note">${days.length ? 'Отдельный пункт на «Сегодня» с галочкой - вместе с остальными делами дня. Тренер видит отметки.' : 'Дни не выбраны - пункта в чек-листе не будет.'}</p></div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="cl-save" data-ex="${esc(id)}">Сохранить</button></div>`;
}

const REASON_NOTE = {
  pain: 'Если болит сустав или мышца - отметьте это в профиле («Здоровье» → травма) или в чате: тренер уберёт всю зону, а не одно упражнение.',
  no_equipment: 'Нет тренажёра в зале? Отметьте его в профиле («Что есть дома» → «В зале нет») - уберу все упражнения на нём.',
};
function exclModalHtml() {
  const f = S.forms.exx || {};
  const ctx = f.ctx;
  return `<div class="modal-head"><div class="kicker smallcaps">Не предлагать</div><h2>${esc(exName(f.id))}</h2></div>
    <div class="modal-body"><div class="field"><span class="smallcaps">Где не предлагать</span><div class="chips">${PF.EXCLUDE_SCOPES.map(([k, l]) =>
      `<button type="button" class="chip ${f.scope === k ? 'on' : ''}" aria-pressed="${f.scope === k}" data-act="ex-excl-scope" data-v="${k}">${esc(l)}</button>`).join('')}</div></div>
      <div class="field" style="margin-top:16px"><span class="smallcaps">Почему</span><div class="chips">${PF.EXCLUDE_REASONS.map(([k, l]) =>
      `<button type="button" class="chip ${f.reason === k ? 'on' : ''}" aria-pressed="${f.reason === k}" data-act="ex-excl-reason" data-v="${k}">${esc(l)}</button>`).join('')}</div></div>
      ${REASON_NOTE[f.reason] ? `<p class="note">${esc(REASON_NOTE[f.reason])}</p>` : ''}
      <p class="note">${({ morning: 'Тренер уберёт его только из утренней разминки - в комплексах и тренировках оно останется.',
        home: 'Тренер уберёт его из разминок, комплексов и тренировок дома - в зале оно останется.',
        gym: 'Тренер уберёт его из тренировок в зале и зальных программ - дома оно останется.',
        all: 'Тренер уберёт его отовсюду: из разминок, комплексов, тренировок дома и в зале, из новых программ.' })[f.scope || 'all']}${ctx ? ' В сегодняшнем списке сразу заменит похожим.' : ''} Вернуть можно в профиле: «Мои упражнения».</p></div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="ex-excl-do">Не предлагать</button></div>`;
}

// ── сигнал «не заходит» на «Сегодня» ──
export function skipNotice(date) {
  if (date !== C.today()) return '';
  let s = null;
  try { s = P.skipSignals()[0]; } catch (e) { console.warn(e); }
  if (!s) return '';
  const where = s.where === 'routine' ? 'в разминке' : 'в тренировке';
  return `<div class="notice fx-signal" data-dom="train"><span class="smallcaps">Тренер заметил</span>
    <p>«${esc(s.name)}» ${esc(where)} осталось без отметки ${s.skips} раза из ${s.of}, хотя остальное сделано. Похоже, не заходит - заменим?</p>
    <div class="a-row-btns">${s.alt ? `<button class="btn" data-act="ex-sig-swap" data-ex="${esc(s.id)}" data-to="${esc(s.alt.id)}">Заменить на «${esc(s.alt.name)}»</button>` : ''}
      <button class="btn quiet" data-act="ex-excl-open" data-ex="${esc(s.id)}">Не предлагать</button>
      <button class="btn quiet" data-act="ex-sig-keep" data-ex="${esc(s.id)}">Оставить</button></div></div>`;
}

// ── погода ──
export function weatherCard(date) {
  if (date !== C.today()) return '';
  const loc = profile().location;
  if (!loc) return '';
  const w = PF.weatherFor(date);
  if (!w) {
    if (PF.weatherOff()) return '';
    return `<div class="raised a-card fx-weather" data-dom="water"><div class="a-card-head"><span class="smallcaps">Погода · ${esc(loc.city || '')}</span></div>
      <p class="note a-tight">${store.state.online ? 'Загружаю прогноз…' : 'Нет связи - прогноз появится, когда сервер будет доступен.'}</p></div>`;
  }
  const sky = PF.skyOf(w.code);
  const bits = [];
  if (w.feels != null && Math.round(w.feels) !== Math.round(w.temp)) bits.push(`ощущается ${PF.fmtT(w.feels)}`);
  bits.push(PF.SKY_NAME[sky]);
  if (w.wind != null) bits.push(`ветер ${Math.round(w.wind)} м/с`);
  const day = [w.tmin != null && w.tmax != null ? `днём ${PF.fmtT(w.tmin).replace(' °C', '')}…${PF.fmtT(w.tmax)}` : '',
    w.dayPrecip >= 0.5 ? `осадки ${String(Math.round(w.dayPrecip * 10) / 10).replace('.', ',')} мм` : '',
    w.sunrise && w.sunset ? `светло ${w.sunrise}–${w.sunset}` : ''].filter(Boolean).join(' · ');
  const old = !store.state.online || w.stale;
  const note = PF.weatherNote(w);
  return `<div class="raised a-card fx-weather" data-dom="water">
    <div class="a-card-head"><span class="smallcaps">Погода · ${esc(w.city || loc.city || '')}</span><span class="note mono">${esc(old ? fmt(C.ymd(new Date(w.saved_at)), { day: 'numeric', month: 'short' }) + ', ' : '')}${hm(w.saved_at)}</span></div>
    <div class="fx-w-main"><span class="fx-w-ic" aria-hidden="true">${PF.SKY_GLYPH[sky] ? glyph(PF.SKY_GLYPH[sky]) : ''}${w.wind >= 10 ? glyph('wind') : ''}</span>
      <b class="mono">${PF.fmtT(w.temp)}</b><span class="note">${esc(bits.join(' · '))}</span></div>
    ${day ? `<p class="note a-tight">${esc(day)}</p>` : ''}
    ${note ? `<p class="fx-w-coach">${esc(note)}</p>` : ''}
    ${old ? `<p class="note a-tight">${store.state.online ? 'Прогноз не обновлялся несколько часов.' : 'Без связи - последний сохранённый прогноз.'}</p>` : ''}
  </div>`;
}

// ── кардио ──
export function cardioCard(date) {
  if (date !== C.today()) return '';
  let cp = null;
  try { cp = P.cardioPlan(date); } catch (e) { console.warn(e); }
  if (!cp) return '';
  const pick = S.forms.cardio?.alt;
  let t = cp.today;
  if (t && pick) {
    const a = cp.alternatives.find(x => `${x.kind}|${x.place}` === pick);
    if (a) t = { ...t, ...a, finisher: false, reason: '' };
  }
  const pct = cp.target ? Math.min(100, Math.round(cp.done / cp.target * 100)) : 0;
  const loc = profile().location;
  const liked = t?.liked ? ' <span class="chip">любимое</span>' : '';
  const hasWorkout = !!C.workout(date);
  let body;
  if (!t) body = `<p class="note a-tight">${esc(cp.note)}</p>`;
  else if (t.done) body = `<p class="a-tight">Сегодня уже <b class="mono">${cp.doneToday}</b> мин кардио - засчитано.</p>`;
  else {
    body = `<div class="fx-c-today"><b>${esc(t.name)} · <span class="mono">${t.minutes}</span> мин</b>
        <span class="chip">${esc(t.finisher ? 'после тренировки' : PF.PLACE_NAME[t.place] || '')}</span>${liked}</div>
      <p class="note a-tight">${esc(t.zone)}</p>
      ${t.optional ? `<p class="note a-tight">${esc(t.reason)}</p>` : ''}
      ${!t.optional && /На улице/.test(t.reason || '') ? `<p class="note a-tight">${esc(t.reason.slice(t.reason.indexOf('На улице')))}</p>` : ''}
      <div class="a-row-btns"><button class="btn" data-act="fx-c-done" data-date="${date}" data-type="${esc(t.act)}" data-kind="${esc(t.kind)}" data-min="${t.minutes}" data-int="${t.intensity}" data-place="${esc(t.place)}">Сделал${profile().sex === 'f' ? 'а' : ''} ${t.minutes} мин</button>
        ${t.generator && !hasWorkout ? `<button class="btn quiet" data-act="fx-c-gen" data-date="${date}" data-min="${t.minutes}" data-int="${t.intensity}" data-eq="${esc(t.eq || '')}">Собрать дома</button>` : ''}
        <button class="btn quiet" data-act="td-ac-open" data-date="${date}" data-type="${esc(t.act)}" data-min="${t.minutes}" data-int="${t.intensity}">Записать своё</button></div>
      ${cp.alternatives.length ? `<div class="fx-c-alts"><span class="smallcaps muted">или</span>${cp.alternatives.map(a =>
        `<button type="button" class="chip ${pick === `${a.kind}|${a.place}` ? 'on' : ''}" data-act="fx-c-alt" data-v="${esc(a.kind)}|${esc(a.place)}">${esc(a.name)} · ${esc(PF.PLACE_NAME[a.place] || '')}</button>`).join('')}
        ${pick ? '<button type="button" class="chip" data-act="fx-c-alt" data-v="">как предложил тренер</button>' : ''}</div>` : ''}`;
  }
  const honest = cp.approx && t && !t.done ? (loc ? 'Прогноза нет - место выбрано по сезону.' : 'Место выбрано по сезону. Укажите город в профиле - учту погоду.') : '';
  return `<div class="raised a-card fx-cardio" data-dom="move">
    <div class="a-card-head"><span class="smallcaps">Кардио на неделе</span><span class="mono">${cp.done}/${cp.target} мин</span></div>
    <div class="groove a-groove"><div class="fill" style="width:${pct}%"></div></div>
    ${body}
    ${honest ? `<p class="note a-tight">${esc(honest)}${!loc ? ' <a class="link" href="#profile" data-act="fx-open-sec" data-sec="cardio">в профиль</a>' : ''}</p>` : ''}
  </div>`;
}

// ── профиль: «Мои упражнения» ──
export function myExSummary() {
  const p = PF.exPrefs();
  const n = Object.keys(p.exclude).length, l = p.like.length, o = MX.list().length, w = Object.keys(p.swaps).length;
  return [o ? `своих: ${o}` : '', w ? `замен: ${w}` : '', n ? `не предлагать: ${n}` : '', l ? `любимых: ${l}` : ''].filter(Boolean).join(' · ') || 'пока без отметок';
}
const PLACE_NAME = { gym: 'в зале', home: 'дома', morning: 'в разминке' };
export function myExBody() {
  const p = PF.exPrefs();
  const ex = Object.entries(p.exclude).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const keep = Object.keys(p.keep);
  const row = (id, meta, btn) => `<div class="item-row fx-myrow"><span class="ell"><button class="a-linkbtn" data-act="tech" data-ex="${esc(id)}">${esc(exName(id))}</button>${meta ? `<span class="note"> · ${esc(meta)}</span>` : ''}</span>${btn}</div>`;
  const own = MX.list(), swaps = Object.entries(p.swaps).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const days = id => { const it = clItem(id); return it ? (it.data.weekdays?.length ? `в чек-листе: ${it.data.weekdays.map(d => WD[d]).join(', ')}` : 'в чек-листе каждый день') : ''; };
  return `<p class="note" style="margin-top:0">Отмечается прямо в упражнении: «Не предлагать», «Заменить», «нравится», «В чек-лист» - в разминке, тренировке и в описании техники.</p>
    <div class="field"><span class="smallcaps">Свои упражнения</span>${own.map(e => row(e.id, [e.how, e.place.map(x => PLACE_NAME[x]).join(', '), days(e.id)].filter(Boolean).join(', '),
      `<button class="btn quiet" data-act="mx-edit" data-ex="${esc(e.id)}">Изменить</button>`)).join('') || '<p class="note">Чего нет в каталоге - добавьте сами: тренер будет ставить и предлагать его наравне с остальными.</p>'}
      <div class="a-row-btns"><button class="btn" data-act="mx-open">+ Своё упражнение</button></div></div>
    ${swaps.length ? `<div class="field" style="margin-top:20px"><span class="smallcaps">Замены</span>${swaps.map(([id, v]) => row(id,
      `заменено на «${exName(v.to)}»${v.place ? ` · ${PLACE_NAME[v.place] || v.place}` : ''}${v.n > 1 ? ` · ${v.n} раза` : ''}${v.always ? ' · всегда' : ''}`,
      `<span class="fx-swbtns"><button class="btn quiet a-mini" data-act="ex-swap-always" data-ex="${esc(id)}">${v.always ? 'Не всегда' : 'Всегда так'}</button><button class="btn quiet a-mini" data-act="ex-unswap" data-ex="${esc(id)}">Забыть</button></span>`)).join('')}
      <p class="note">«Всегда так» - тренер ставит выбранное вместо прежнего в разминках, комплексах и программе.</p></div>` : ''}
    <div class="field" style="margin-top:20px"><span class="smallcaps">Не предлагать</span>${ex.length ? ex.map(([id, v]) => row(id, [(v.scope || 'all') === 'all' ? 'нигде' : PF.SCOPE_NAME[v.scope], PF.REASON_NAME[v.reason] || v.reason, v.at ? fmt(C.ymd(new Date(v.at)), { day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(', '),
      `<button class="btn quiet" data-act="ex-unexcl" data-ex="${esc(id)}">Вернуть</button>`)).join('') : '<p class="note">Пусто - тренер предлагает всё, что подходит по инвентарю и здоровью.</p>'}</div>
    <div class="field" style="margin-top:12px"><span class="smallcaps">Любимые</span>${p.like.length ? p.like.map(id => row(id, '', `<button class="btn quiet" data-act="ex-like" data-ex="${esc(id)}">Убрать</button>`)).join('') : '<p class="note">Любимые упражнения тренер ставит чаще.</p>'}</div>
    ${keep.length ? `<div class="field" style="margin-top:12px"><span class="smallcaps">Оставлены, хотя пропускаются</span>${keep.map(id => row(id, '', `<button class="btn quiet" data-act="ex-unkeep" data-ex="${esc(id)}">Снова следить</button>`)).join('')}</div>` : ''}`;
}

// ── действия ──
async function afterPrefs(date = C.today()) { await afterChange(date); S.render(); }
function reopenExcl() { openModal(exclModalHtml()); }

export const actions = {
  'ex-swap-open': el => swapModal(el.dataset.ex, exCtx(el)),
  'ex-swap-do': async el => {
    const ctx = exCtx(el);
    const from = P.ctxInfo(ctx)?.id, to = el.dataset.to;
    const always = !!S.forms.swp?.always, place = swapPlace(ctx);
    const e = await P.swapExercise(ctx, to);
    closeModal();
    let more = 0;
    if (e && from) {
      await PF.recordSwap(from, to, place, always);
      if (always && ctx.kind === 'workout') more = await P.applySwapForward(from, to, place);
    }
    const pw = pairWith(ctx);
    const pp = pw ? P.pairPartner(ctx.module) : null;
    if (e) toast(`Заменил${from ? ` «${exName(from)}»` : ''} на «${e.name}»${pp ? ` - у вас и у ${C.nameForms?.(pp.id)?.gen || pp.name}` : ''}${more ? `, и в следующих тренировках (${more})` : always ? '. Дальше так и буду ставить' : ''}`, 3500);
    await afterPrefs(ctx?.date);
  },
  'mx-open': el => openMyEx({ from: el.dataset.from || null, ctx: exCtx(el) }),
  'mx-edit': el => openMyEx({ edit: el.dataset.ex }),
  'mx-day': el => {
    const f = S.forms.mx, d = el.dataset.d, cur = f.days || [];
    f.days = d === 'all' ? (cur.length === 7 ? [] : [...ALL_DAYS]) : cur.includes(Number(d)) ? cur.filter(x => x !== Number(d)) : [...cur, Number(d)];
    openModal(myExModal());
  },
  'mx-save': async () => {
    const f = S.forms.mx;
    if (!f) return closeModal();
    const e = await MX.save(f, f.edit);
    if (f.days?.length || clItem(e.id)) await setChecklist(e.id, f.days || []);
    let msg = f.edit ? `«${e.name}» сохранено` : `«${e.name}» добавлено в ваши упражнения`;
    if (f.from && f.ctx) {
      const done = await P.swapExercise(f.ctx, e.id);
      if (done) {
        const place = swapPlace(f.ctx), always = !!S.forms.swp?.always;
        await PF.recordSwap(f.from, e.id, place, always);
        const more = always && f.ctx.kind === 'workout' ? await P.applySwapForward(f.from, e.id, place) : 0;
        msg = `«${e.name}» вместо «${exName(f.from)}»${more ? `, и в следующих тренировках (${more})` : ''}`;
      }
    }
    if (f.days?.length) msg += f.days.length === 7 ? ' · в чек-листе каждый день' : ` · в чек-листе: ${f.days.sort().map(d => WD[d]).join(', ')}`;
    const date = f.ctx?.date;
    delete S.forms.mx;
    closeModal();
    toast(msg, 3500);
    await afterPrefs(date);
  },
  'mx-del': async el => {
    const id = el.dataset.ex, name = exName(id);
    if (!confirm(`Удалить своё упражнение «${name}»? В прошедших тренировках оно останется.`)) return;
    const it = clItem(id);
    if (it) await store.patch(it.id, { active: false });
    await MX.remove(id);
    delete S.forms.mx;
    closeModal();
    toast(`«${name}» удалено`);
    await afterPrefs();
  },
  'ex-cl-open': el => {
    const id = el.dataset.ex, it = clItem(id);
    S.forms.cl = { id, days: it ? (it.data.weekdays?.length ? [...it.data.weekdays] : [...ALL_DAYS]) : [...ALL_DAYS] };
    openModal(clModal(id));
  },
  'cl-day': el => {
    const f = S.forms.cl, d = el.dataset.d, cur = f.days || [];
    f.days = d === 'all' ? (cur.length === 7 ? [] : [...ALL_DAYS]) : cur.includes(Number(d)) ? cur.filter(x => x !== Number(d)) : [...cur, Number(d)];
    openModal(clModal(f.id));
  },
  'cl-save': async el => {
    const id = el.dataset.ex, days = S.forms.cl?.days || [];
    await setChecklist(id, days);
    delete S.forms.cl;
    closeModal();
    toast(days.length ? `«${exName(id)}» в чек-листе ${days.length === 7 ? 'каждый день' : `по дням: ${[...days].sort().map(d => WD[d]).join(', ')}`}` : `«${exName(id)}» убрано из чек-листа`, 3500);
    await afterPrefs();
  },
  'ex-unswap': async el => { await PF.unswap(el.dataset.ex); toast('Замену забыл - тренер снова подбирает сам'); S.render(); },
  'ex-swap-always': async el => {
    const v = PF.swapsOf()[el.dataset.ex];
    if (!v) return;
    await PF.setSwapAlways(el.dataset.ex, !v.always);
    toast(v.always ? 'Больше не ставлю замену сама собой - только запомнил' : `Дальше ставлю «${exName(v.to)}» вместо «${exName(el.dataset.ex)}»`, 3500);
    S.render();
  },
  'ex-excl-open': el => {
    const ctx = exCtx(el);
    // по умолчанию - там, где нажали: в разминке - только в разминке, в тренировке - в её месте (дом/зал)
    S.forms.exx = { id: el.dataset.ex, ctx, reason: 'uncomfortable', scope: ctx ? PF.scopeFor(ctx, P.ctxInfo(ctx)?.place) : 'all' };
    reopenExcl();
  },
  'ex-excl-reason': el => { (S.forms.exx ||= {}).reason = el.dataset.v; reopenExcl(); },
  'ex-excl-scope': el => { (S.forms.exx ||= {}).scope = el.dataset.v; reopenExcl(); },
  'ex-excl-do': async () => {
    const f = S.forms.exx;
    if (!f?.id) return closeModal();
    const ctx = f.ctx || P.findToday(f.id);
    const name = exName(f.id);
    const { alt, scope } = await P.excludeExercise(f.id, f.reason || 'other', ctx, '', f.scope || 'all');
    closeModal();
    delete S.forms.exx;
    const where = scope === 'all' ? '' : ` ${PF.SCOPE_NAME[scope]}`;
    toast(alt ? `Больше не предлагаю «${name}»${where}. Вместо него - «${alt.name}».` : `Больше не предлагаю «${name}»${where}. Вернуть: Профиль → «Мои упражнения».`, 4000);
    await afterPrefs(ctx?.date);
  },
  'ex-like': async el => {
    const id = el.dataset.ex, on = !PF.isLiked(id);
    await PF.setLike(id, on);
    toast(on ? `«${exName(id)}» - в любимых, буду ставить чаще` : 'Убрал из любимых');
    if (isModalOpen() && document.querySelector('#modal .fx-tech-acts')) showTech(id, exCtx(el));
    S.render();
  },
  'ex-unexcl': async el => { await PF.unexclude(el.dataset.ex); toast(`«${exName(el.dataset.ex)}» снова в предложениях`); if (isModalOpen() && document.querySelector('#modal .fx-tech-acts')) showTech(el.dataset.ex, exCtx(el)); S.render(); },
  'ex-unkeep': async el => { await PF.unkeep(el.dataset.ex); S.render(); },
  'ex-sig-swap': async el => {
    const alt = S.exMap.get(el.dataset.to);
    await P.replaceExercise(el.dataset.ex, el.dataset.to);
    toast(`Заменил «${exName(el.dataset.ex)}» на «${alt?.name || el.dataset.to}»`, 3500);
    await afterPrefs();
  },
  'ex-sig-keep': async el => {
    await PF.keep(el.dataset.ex);
    toast('Оставляю. Напомню, только если пропуски продолжатся.', 3500);
    S.render();
  },
  'fx-c-done': async el => {
    const { date, type, kind, min, int, place } = el.dataset;
    const minutes = Number(min) || 20;
    const k = PF.cardioKind(kind);
    const def = S.activities.get(type);
    const w = C.weights().slice(-1)[0]?.w || Number(profile().weight) || 70;
    const kcal = P.activityKcal(type, minutes, int, w);
    await store.put('activity', store.newId(), {
      type, minutes, intensity: int || 'mid', kcal, note: k && def && def.name !== k.name ? k.name : '', details: {},
      cardio: true, place: place || null, source: 'cardio_plan', entered_at: Date.now(),
    }, date);
    delete S.forms.cardio;
    await afterChange(date);
    toast(`${k?.name || def?.name || 'Кардио'}: ${minutes} мин записано`);
  },
  'fx-c-gen': async el => {
    const { date, min, int, eq } = el.dataset;
    const rec = await P.makeHomeWorkout({ minutes: Number(min) || 20, focus: 'cardio', date, machine: eq || null, intensity: int, noJump: true });
    if (!rec) return toast('Каталог упражнений ещё не загружен');
    await afterChange(date);
    location.hash = `#workout/${date}`;
  },
  'fx-c-alt': el => { (S.forms.cardio ||= {}).alt = el.dataset.v || null; S.render(); },
  'fx-open-sec': () => { sessionStorage.setItem('pf_open', 'cardio'); },
};

// прогноз — раз в 30 минут, пока приложение открыто и есть связь
export async function background({ hidden } = {}) {
  if (hidden || !store.me() || !profile().location) return;
  const before = store.getMeta('weather', null)?.saved_at;
  await PF.loadWeather();
  if (store.getMeta('weather', null)?.saved_at !== before) S.render();
}

export const changes = {
  'swp-q': el => {
    (S.forms.swp ||= {}).q = el.value;
    const box = document.getElementById('swp-res');
    if (box) box.innerHTML = swapResults();
  },
};
