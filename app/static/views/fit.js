// «Не предлагать», замены упражнений, сигнал «не заходит», карточки погоды и кардио на «Сегодня»,
// раздел профиля «Мои упражнения» (SPEC-v3 п. 17–20). Логика подбора — plan.js, данные — prefs.js.
import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import * as PF from '../prefs.js';
import { S, esc, fmt, profile, toast, openModal, closeModal, isModalOpen, afterChange, glyph, exCtx, ctxAttrs, showTech } from '../ui.js';

const exName = id => S.exMap.get(id)?.name || id;
const hm = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ── действия с упражнением в карточке: «Заменить», «Не предлагать», «Нравится» ──
export function exActions(id, ctx, { like = true } = {}) {
  const liked = PF.isLiked(id);
  return `<div class="fx-exacts">
    ${ctx ? `<button type="button" class="btn quiet a-mini" data-act="ex-swap-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Заменить</button>` : ''}
    <button type="button" class="btn quiet a-mini" data-act="ex-excl-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Не предлагать</button>
    ${like ? `<button type="button" class="btn quiet a-mini fx-like ${liked ? 'on' : ''}" data-act="ex-like" data-ex="${esc(id)}" aria-pressed="${liked}">${liked ? `${glyph('heart', { fill: true })} любимое` : `${glyph('heart')} нравится`}</button>` : ''}
  </div>`;
}

function swapModal(id, ctx) {
  const alts = P.alternativesIn(ctx, 5);
  const meta = e => [(e.muscles || []).slice(0, 3).join(', '), (e.equipment || []).length ? (e.equipment || []).map(PF.equipLabel).join(', ') : 'без инвентаря'].filter(Boolean).join(' · ');
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Замена · ${esc(exName(id))}</div><h2>На что заменить?</h2></div>
    <div class="modal-body">${alts.length ? `<div class="fx-alts">${alts.map(e => `<button type="button" class="raised fx-alt" data-act="ex-swap-do" data-to="${esc(e.id)}" ${ctxAttrs(ctx)}>
        <b>${esc(e.name)}</b>${PF.isLiked(e.id) ? ' <span class="chip">любимое</span>' : ''}<span class="note">${esc(meta(e))}</span></button>`).join('')}</div>
      <p class="note">Тот же тип движения и мышцы, с учётом инвентаря, ограничений и «не предлагать». Отметки остальных упражнений сохранятся.</p>`
      : '<p class="empty">Подходящей замены в каталоге нет. Проверьте в профиле «Что есть дома» - с новым инвентарём вариантов станет больше.</p>'}</div>
    <div class="modal-foot"><button class="btn quiet" data-act="ex-excl-open" data-ex="${esc(id)}" ${ctxAttrs(ctx)}>Не предлагать совсем</button><button class="btn" data-act="close">Отмена</button></div>`);
}

const REASON_NOTE = {
  pain: 'Если болит сустав или мышца - отметьте это в профиле («Здоровье» → травма) или в чате: тренер уберёт всю зону, а не одно упражнение.',
  no_equipment: 'Нет тренажёра в зале? Отметьте его в профиле («Что есть дома» → «В зале нет») - уберу все упражнения на нём.',
};
function exclModalHtml() {
  const f = S.forms.exx || {};
  const ctx = f.ctx;
  return `<div class="modal-head"><div class="kicker smallcaps">Не предлагать</div><h2>${esc(exName(f.id))}</h2></div>
    <div class="modal-body"><div class="field"><span class="smallcaps">Почему</span><div class="chips">${PF.EXCLUDE_REASONS.map(([k, l]) =>
      `<button type="button" class="chip ${f.reason === k ? 'on' : ''}" aria-pressed="${f.reason === k}" data-act="ex-excl-reason" data-v="${k}">${esc(l)}</button>`).join('')}</div></div>
      ${REASON_NOTE[f.reason] ? `<p class="note">${esc(REASON_NOTE[f.reason])}</p>` : ''}
      <p class="note">Тренер уберёт его из разминок, домашних и зальных тренировок и из новых программ${ctx || P.findToday(f.id) ? ', а в сегодняшнем списке сразу заменит похожим' : ''}. Вернуть можно в профиле: «Мои упражнения».</p></div>
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
  const n = Object.keys(p.exclude).length, l = p.like.length;
  return [n ? `не предлагать: ${n}` : '', l ? `любимых: ${l}` : ''].filter(Boolean).join(' · ') || 'пока без отметок';
}
export function myExBody() {
  const p = PF.exPrefs();
  const ex = Object.entries(p.exclude).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const keep = Object.keys(p.keep);
  const row = (id, meta, btn) => `<div class="item-row fx-myrow"><span class="ell"><button class="a-linkbtn" data-act="tech" data-ex="${esc(id)}">${esc(exName(id))}</button>${meta ? `<span class="note"> · ${esc(meta)}</span>` : ''}</span>${btn}</div>`;
  return `<p class="note" style="margin-top:0">Отмечается прямо в упражнении: «Не предлагать», «Заменить», «нравится» - в разминке, тренировке и в описании техники.</p>
    <div class="field"><span class="smallcaps">Не предлагать</span>${ex.length ? ex.map(([id, v]) => row(id, [PF.REASON_NAME[v.reason] || v.reason, v.at ? fmt(C.ymd(new Date(v.at)), { day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(', '),
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
    const from = P.ctxInfo(ctx)?.id;
    const e = await P.swapExercise(ctx, el.dataset.to);
    closeModal();
    if (e) toast(`Заменил${from ? ` «${exName(from)}»` : ''} на «${e.name}»`);
    await afterPrefs(ctx?.date);
  },
  'ex-excl-open': el => {
    S.forms.exx = { id: el.dataset.ex, ctx: exCtx(el), reason: 'uncomfortable' };
    reopenExcl();
  },
  'ex-excl-reason': el => { (S.forms.exx ||= {}).reason = el.dataset.v; reopenExcl(); },
  'ex-excl-do': async () => {
    const f = S.forms.exx;
    if (!f?.id) return closeModal();
    const ctx = f.ctx || P.findToday(f.id);
    const name = exName(f.id);
    const { alt } = await P.excludeExercise(f.id, f.reason || 'other', ctx);
    closeModal();
    delete S.forms.exx;
    toast(alt ? `Больше не предлагаю «${name}». Вместо него - «${alt.name}».` : `Больше не предлагаю «${name}». Вернуть: Профиль → «Мои упражнения».`, 4000);
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
