// «Как у партнёра» для занятий: тренировка и активности партнёра по группе за день - копия к себе обычными своими
// записями (правятся без ограничений). Только если партнёр разрешил (profile.share_training); сервер отдаёт по
// запросу (/api/partner/activities), в синхронизацию чужое не попадает. Еда - то же в views/food.js (pm-*).
import * as store from '../store.js';
import * as C from '../coach.js';
import { S, esc, num, fmt, toast, openModal, closeModal, isModalOpen, afterChange, confirmAction } from '../ui.js';
import * as N from '../names.js';
import { activityDef, activityKcal } from './today.js';

const PC = { date: null, data: null, error: null, loading: false };
const INT = { low: 'легко', mid: 'средне', high: 'интенсивно' };

// подпись кнопки: «Как у Марии» (один партнёр) или «Как у партнёра»
export function copyLabel() {
  const ps = store.partners();
  return ps.length === 1 ? `Как у ${N.decl(ps[0].name, ps[0].sex).gen}` : 'Как у партнёра';
}
export const copyButton = date => (store.partners().length
  ? `<button class="btn quiet" data-act="pc-open" data-date="${date}" title="Скопировать тренировку или активность партнёра к себе">${esc(copyLabel())}</button>` : '');

const name = t => activityDef(t)?.name || t;
function woLine(w) {
  const ex = w.exercises || [];
  return `${ex.slice(0, 5).map(e => esc(e.name || e.id)).join(', ')}${ex.length > 5 ? ` и ещё ${ex.length - 5}` : ''}`;
}

function html() {
  const d = PC.data;
  const body = PC.loading ? '<p class="note"><span class="spinner"></span> Загружаю…</p>'
    : PC.error ? `<p class="err">${esc(PC.error)}</p>`
    : `${(d.partners || []).map(p => `<div class="pm-who"><div class="smallcaps">${esc(p.name)}</div>
        ${p.workout ? `<div class="raised fp-var"><div class="fp-var-t">${esc(p.workout.title)}${p.workout.done ? ' <span class="muted">· сделана</span>' : ''}</div>
          <div class="note a-tight">${woLine(p.workout)}</div>
          <div class="a-row-btns"><button type="button" class="btn" data-act="pc-wo" data-pid="${esc(p.id)}">Скопировать себе</button></div></div>` : ''}
        ${p.activities.map((a, i) => `<div class="raised fp-var"><div class="fp-var-t">${esc(name(a.type))} <span class="mono muted">${num(a.minutes)} мин · ${esc(INT[a.intensity] || '')}</span></div>
          <div class="a-row-btns"><button type="button" class="btn" data-act="pc-act" data-pid="${esc(p.id)}" data-i="${i}">Скопировать себе</button></div></div>`).join('')}
        ${!p.workout && !p.activities.length ? '<p class="note a-tight">За этот день тренировок и активностей нет.</p>' : ''}</div>`).join('')}
      ${d.closed?.length ? `<p class="note">${esc(d.closed.join(', '))}: копировать тренировки и активности пока не разрешено - это включается в профиле, «Прогресс вместе» → «Тренировки и активности».</p>` : ''}
      ${!d.partners?.length && !d.closed?.length ? '<p class="note">Партнёров по группе нет.</p>' : ''}`;
  return `<div class="modal-head"><div class="kicker smallcaps">${esc(copyLabel())} · ${esc(fmt(PC.date, { day: 'numeric', month: 'long' }))}</div><h2>Скопировать занятие</h2></div>
    <div class="modal-body fp"><p class="note a-tight">Копия станет вашей обычной записью: минуты, интенсивность, упражнения, подходы и веса можно менять как угодно. У партнёра ничего не изменится.</p>${body}</div>
    <div class="modal-foot"><button type="button" class="btn quiet" data-act="close">Закрыть</button></div>`;
}

const find = pid => PC.data?.partners?.find(x => x.id === pid);

async function copyWorkout(p) {
  const w = p.workout, date = PC.date, past = date < C.today();
  // прошлый день или партнёр уже сделал - копируем как сделанную (с отметками и весами), иначе - план на день
  const done = past || w.done;
  const exercises = w.exercises.map(e => ({ ...e, log: done ? (e.log?.length ? e.log.map(l => ({ ...l })) : Array.from({ length: e.sets || 1 }, () => ({ done: true }))) : [] }));
  await store.put('workout', `wo:${store.uid()}:${date}`, {
    title: w.title, focus: w.focus || null, source: 'manual', place: w.place || null, exercises, copied_from: p.name,
    done, ...(done ? { finished_at: Date.now() } : {}),
  }, date);
  closeModal();
  await afterChange(date);
  toast(`Тренировка скопирована${done ? ' как сделанная' : ''} - поправьте веса и подходы, если были другие`, 5000);
  location.hash = `#workout/${date}`;
}

export const actions = {
  'pc-open': async el => {
    if (!store.state.online) return toast('Нужна связь с сервером: чужие записи на устройстве не хранятся');
    Object.assign(PC, { date: el.dataset.date || C.today(), data: null, error: null, loading: true });
    openModal(html());
    try { PC.data = await store.api(`/api/partner/activities?date=${encodeURIComponent(PC.date)}`); }
    catch (e) { PC.error = e.status === 404 ? 'Эта функция появится после обновления сервера' : e.status === 0 ? 'Нет связи с сервером' : e.message; }
    PC.loading = false;
    if (isModalOpen()) openModal(html());
  },
  'pc-act': async el => {
    const p = find(el.dataset.pid), a = p?.activities?.[Number(el.dataset.i)];
    if (!a) return;
    const id = store.newId();
    // калории - по своему весу, не партнёра
    await store.put('activity', id, { type: a.type, minutes: a.minutes, intensity: a.intensity, kcal: activityKcal(a.type, a.minutes, a.intensity),
      note: '', details: { ...(a.details || {}) }, source: 'manual', copied_from: p.name, entered_at: Date.now() }, PC.date);
    closeModal();
    await afterChange(PC.date);
    const def = activityDef(a.type);
    if (def && !def.private) await C.shareHighlight('activity', def.name, a.minutes, PC.date, `highlight:${store.uid()}:act:${id}`, id);
    toast(`${name(a.type)}: ${a.minutes} мин записано - поправьте, если было иначе`, 5000);
  },
  'pc-wo': async el => {
    const p = find(el.dataset.pid);
    if (!p?.workout) return;
    const mine = C.workout(PC.date);
    if (mine?.data?.exercises?.length) {
      const ok = await confirmAction({ title: 'Заменить свою тренировку?', ok: 'Заменить', danger: false,
        text: `На этот день у вас уже есть «${mine.data.title || 'тренировка'}» - она заменится копией тренировки ${N.decl(p.name).gen}.` });
      if (!ok) return;
    }
    await copyWorkout(p);
  },
};
