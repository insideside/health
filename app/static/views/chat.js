import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import * as PF from '../prefs.js';
import { setPain } from './today.js';
import { S, esc, fmt, WD, profile, toast, field, input, chips, openModal, closeModal, jobFor, addJob, afterChange, glyph, aiOff, aiOffHint } from '../ui.js';

// Чат с тренером (#chat). Свободные вопросы уходят в ИИ на сервере (только онлайн);
// быстрые сценарии и сообщения-правила работают без ИИ и без сети.

const safe = (fn, fb = null) => { try { const v = fn(); return v === undefined ? fb : v; } catch (e) { console.warn(e); return fb; } };
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const created = m => m.data.created || m.updated_at;
const wdName = d => ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'][(C.parse(d).getDay() + 6) % 7];

// окончания по полу: «Устал{|а}» → «Устал» / «Устала»
const gx = t => t.replace(/\{([^|}]*)\|([^}]*)\}/g, (_, m, f) => (store.get(`profile:${store.uid()}`)?.data?.sex === 'f' ? f : m));
const QUICK = [['cant', 'Сегодня не могу тренироваться'], ['short', 'Есть только 15 минут'], ['tired', 'Устал{|а} / плохо спал{|а}'],
  ['pain', 'Болит…'], ['move', 'Перенеси тренировку на завтра'], ['cheat', 'Хочу читмил']];
const PAIN_ZONES = [['head', 'голова'], ['stomach', 'живот'], ['knees', 'колени'], ['lower_back', 'поясница'], ['back', 'спина'], ['neck', 'шея'], ['shoulders', 'плечи'], ['arms', 'руки'],
  ['wrists', 'запястья'], ['chest', 'грудь'], ['abs', 'пресс'], ['hips', 'таз'], ['glutes', 'ягодицы'], ['legs', 'ноги'], ['ankles', 'голеностоп']];
const ZONE_NAME = Object.fromEntries(PAIN_ZONES);

const pending = new Set();   // действия, которые сейчас выполняются
let lastCount = -1, entered = true;
// где человек оставил список: внизу (pinned - новые сообщения подтягивают вниз) или выше (lastTop). Перерисовка
// страницы создаёт список заново - без этого он прыгал вниз, пока человек читал старые сообщения.
let pinned = true, lastTop = 0;
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#chat')) entered = true; });

function messages() {
  const all = store.list('chat').sort((a, b) => created(a) - created(b));
  // защита от двойника: если сервер тоже записал вопрос пользователя
  const out = [];
  for (const m of all) {
    const prev = out[out.length - 1];
    if (prev && m.data.role === 'user' && prev.data.role === 'user' && prev.data.text === m.data.text && Math.abs(created(m) - created(prev)) < 60000) continue;
    out.push(m);
  }
  return out;
}

// ── экран ──
function listHtml() {
  const msgs = messages();
  const job = jobFor('chat');
  let lastDay = '';
  const list = msgs.map(m => {
    const day = C.ymd(new Date(created(m)));
    const sep = day !== lastDay ? `<div class="chat-day smallcaps">${esc(dayLabel(day))}</div>` : '';
    lastDay = day;
    return sep + msgHtml(m);
  }).join('');
  return `${msgs.length ? '' : `<div class="msg m-coach intro"><div class="bubble">Привет! Я на связи. Спрашивай про питание, упражнения и план - или жми кнопку ниже: частые ситуации решаются сразу, даже без сети.${profile().setup_done ? '' : ' Но сначала заполни <a class="link" href="#profile">профиль</a> - без роста, веса и цели мои советы будут общими.'}</div></div>`}
    ${list}
    ${job ? `<div class="msg m-coach typing"><div class="bubble"><span class="dots"><i></i><i></i><i></i></span>${job.ahead ? ` <span class="note">в очереди ${job.ahead}</span>` : ''}</div></div>` : ''}`;
}

function viewChat() {
  const off = aiOff(), online = store.state.online && !off;
  const job = jobFor('chat');
  const tone = profile().tone || 'coach';
  return `<div class="chat-v2">
    <div class="kicker smallcaps">Тренер · тон «${esc((C.TONE_NAMES?.[tone] || '').toLowerCase())}»</div><h1>Чат с тренером</h1>
    <p class="note a-tight"><a class="link" href="#advice">Все рекомендации по твоим данным →</a></p>
    <div class="chat-list" id="chat-list">${listHtml()}</div>
    <div class="composer" id="chat-composer">
      <div class="chat-quick">${QUICK.map(([k, l]) => `<button type="button" class="chip" data-act="chat-quick" data-q="${k}">${esc(gx(l))}</button>`).join('')}</div>
      ${online ? '' : off ? `<p class="chat-off">${aiOffHint('Свободные вопросы понимает ИИ')} Кнопки выше работают и так.</p>` : '<p class="note chat-off">Чат работает при подключении к серверу. Кнопки выше - и без сети.</p>'}
      <div class="chat-in-row">
        <textarea class="control" id="chat-in" data-form="chat" data-key="text" rows="1" placeholder="${online ? 'Спросите тренера…' : off ? 'ИИ выключена в профиле' : 'Нет связи с сервером'}" ${online ? '' : 'disabled'}>${esc(S.forms.chat?.text || '')}</textarea>
        <button class="btn solid" data-act="chat-send" ${online && !job ? '' : 'disabled'} aria-label="Отправить">Отправить</button>
      </div>
    </div></div>`;
}

// Пока в поле ввода фокус, app.js откладывает перерисовку — список сообщений обновляем сами.
function refreshList() {
  const el = document.getElementById('chat-list');
  if (S.pressing) { setTimeout(refreshList, 400); return; }
  if (!el || !location.hash.startsWith('#chat')) return;
  const top = el.scrollTop;
  el.innerHTML = listHtml();
  el.scrollTop = pinned ? el.scrollHeight : top;
  const btn = document.querySelector('[data-act=chat-send]');
  if (btn) btn.disabled = !(store.state.online && !aiOff() && !jobFor('chat'));
  afterRender();
}
store.on(refreshList);

function dayLabel(d) {
  if (d === C.today()) return 'Сегодня';
  if (d === C.addDays(C.today(), -1)) return 'Вчера';
  return fmt(d, { weekday: 'short', day: 'numeric', month: 'long' });
}

function msgHtml(m) {
  const d = m.data;
  const role = d.role === 'user' ? 'user' : 'coach';
  const src = role === 'coach' ? (d.source || 'ai') : '';
  const tag = src === 'rule' ? (d.rule && /remind|^r_|reminder/.test(d.rule) ? 'напоминание' : 'тренер заметил') : src === 'quick' ? 'быстрый ответ' : '';
  const acts = (d.actions || []);
  // «Отменить» у уже сделанной отметки - одна кнопка, без «Не надо» (отменять отмену нечего)
  const offered = acts.filter(a => (a.status || 'offered') === 'offered' && !a.undo_of);
  const actHtml = acts.length ? `<div class="msg-acts">${acts.map(a => {
    const st = a.status || 'offered';
    const key = `${m.id}|${a.id}`;
    if (st === 'done') return `<span class="chip on">${glyph('check')} ${esc(a.label)}</span>`;
    if (st === 'declined') return `<span class="chip dim">${esc(a.label)} - нет</span>`;
    return `<button class="btn" data-act="chat-act" data-m="${esc(m.id)}" data-a="${esc(a.id)}" ${pending.has(key) ? 'disabled' : ''}>${pending.has(key) ? '<span class="spinner"></span> ' : ''}${esc(a.label)}</button>`;
  }).join('')}${offered.length ? `<button class="btn quiet" data-act="chat-decline" data-m="${esc(m.id)}">Не надо</button>` : ''}</div>` : '';
  const solved = d.resolved_at ? ` · ${glyph('check')} сделано в <span class="mono">${hhmm(d.resolved_at)}</span>` : '';
  return `<div class="msg m-${role} ${src ? 'src-' + src : ''} ${d.mood ? 'mood-' + esc(d.mood) : ''} ${d.resolved_at ? 'resolved' : ''}">
    <div class="bubble">${esc(d.text).replace(/\n/g, '<br>')}</div>${actHtml}
    <div class="msg-meta"><span class="mono">${hhmm(created(m))}</span>${tag ? ` · ${tag}` : ''}${solved}</div></div>`;
}

// ── запись сообщений ──
async function say(role, text, extra = {}) {
  const now = Date.now() + (role === 'coach' ? 1 : 0);
  const id = store.newId();
  await store.put('chat', id, { role, text, created: now, ...extra }, C.today());
  return id;
}
const coach = (text, actions) => say('coach', text, { source: 'quick', ...(actions ? { actions: actions.map((a, i) => ({ id: a.id || `a${i}`, status: 'offered', local: true, params: {}, ...a })) } : {}) });
// уведомление о завершении фоновой задачи (программа составлена/пересобрана, разбор недели готов…) - в чат,
// чтобы не пропустить: тост живёт 4 секунды, а тут остаётся видно, что тренер закончил и что сделал
export const announce = coach;

// ── локальные действия (без сервера) ──
function workoutToday(date = C.today()) { const w = C.workout(date); return w && !w.data.done && w.data.variant !== 'moved' ? w : null; }

async function setDayType(date, type, note = '') {
  await store.put('daytype', `daytype:${store.uid()}:${date}`, { type, note }, date);
  await afterChange(date);
}

// перенос тренировки на ближайший свободный день (сначала завтра)
async function moveWorkout(from) {
  const w = workoutToday(from);
  if (!w) return { ok: false, text: 'Сегодня тренировки нет - переносить нечего.' };
  const uid = store.uid();
  let to = null;
  for (let i = 1; i <= 3; i++) { const d = C.addDays(from, i); const x = C.workout(d); if (!x || x.data.variant === 'moved') { to = d; break; } }
  if (!to) return { ok: false, text: 'Ближайшие три дня уже заняты тренировками. Лучше сделать сегодня облегчённый вариант.' };
  const { original, ...rest } = w.data;
  await store.put('workout', `wo:${uid}:${to}`, { ...rest, ...(original || {}), variant: 'full', moved_from: from, done: false }, to);
  await store.put('workout', w.id, { ...w.data, variant: 'moved', moved_to: to }, from);
  await afterChange(from); await afterChange(to);
  return { ok: true, to, text: `Готово: «${w.data.title}» перенесена на ${wdName(to)}, ${fmt(to, { day: 'numeric', month: 'long' })}.` };
}

async function variant(v) {
  const date = C.today();
  if (!workoutToday(date)) return 'Сегодня тренировки нет.';
  if (P.applyVariant) {
    const r = await P.applyVariant(date, v);
    await afterChange(date);
    if (r && r.ok === false) return r.reason || 'Не получилось изменить тренировку.';
    if (v === 'move') return r?.to ? `Перенёс на ${wdName(r.to)}, ${fmt(r.to, { day: 'numeric', month: 'long' })}. Недельный объём сохраняется.` : 'Перенёс.';
    return v === 'light' ? 'Сделал облегчённый вариант: меньше подходов, дольше отдых. Недобранный объём разложу по неделе.'
      : v === 'recovery' ? 'Заменил на восстановление: мобильность, растяжка, лёгкое кардио.' : 'Готово.';
  }
  // запасной путь: пометить вариант, объём уменьшится вручную
  const w = workoutToday(date);
  const k = v === 'light' ? 0.7 : 0.5;
  await store.patch(w.id, { variant: v, exercises: w.data.exercises.map(e => ({ ...e, sets: Math.max(1, Math.round(e.sets * k)) })) });
  await afterChange(date);
  return v === 'light' ? 'Сократил подходы примерно на треть. Веса оставь прежними, отдыхай подольше.' : 'Оставил половину подходов - работай вполсилы, без отказа.';
}

async function runLocal(a) {
  const date = C.today();
  switch (a.kind) {
    case 'local_move': { if (P.applyVariant) return variant('move'); const r = await moveWorkout(date); return r.text; }
    case 'local_rest': await setDayType(date, 'rest'); return 'Отметил день отдыха. Ругать не буду - но воду и шаги никто не отменял.';
    case 'local_light': return variant('light');
    case 'local_recovery': return variant('recovery');
    case 'local_cheat': await setDayType(date, 'cheat'); return 'Отметил читмил. Сегодня без упрёков - наслаждайся, а завтра возвращаемся в режим.';
    case 'local_home15': return quickWorkout(true);
    case 'open': if (a.params?.href) location.hash = a.params.href; return '';
    // сигнал «упражнение не заходит» (plan.skipSignals → coach.ruleMessages)
    case 'local_ex_swap': {
      await P.replaceExercise(a.params.id, a.params.to);
      await afterChange(date);
      return `Готово: вместо «${S.exMap.get(a.params.id)?.name || a.params.id}» буду предлагать «${S.exMap.get(a.params.to)?.name || a.params.to}». Вернуть можно в профиле: «Мои упражнения».`;
    }
    case 'local_ex_exclude': {
      const r = await P.excludeExercise(a.params.id, 'skipped', P.findToday(a.params.id), 'signal');
      await afterChange(date);
      return `Убрал «${S.exMap.get(a.params.id)?.name || a.params.id}» из предложений${r.alt ? `, сегодня вместо него - «${r.alt.name}»` : ''}.`;
    }
    case 'local_ex_keep': await PF.keep(a.params.id); return 'Оставляю. Напомню, только если пропуски продолжатся.';
    default: return '';
  }
}

async function quickWorkout(force = false) {
  const date = C.today();
  if (!P.makeHomeWorkout) {
    return 'Быстрая 15-минутка без инвентаря: 3 круга - 12 приседаний, 10 отжиманий (можно с колен), 10 выпадов на каждую ногу, 30 с планки, 30 с отдыха между кругами.';
  }
  if (workoutToday(date) && !force) return null;
  await P.makeHomeWorkout({ minutes: 15, focus: 'quick', date });
  await afterChange(date);
  return 'Собрал тренировку на 15 минут - она уже в разделе «Спорт». Разминка внутри, начинай.';
}

// ── быстрые сценарии ──
const SCENARIO = {
  async cant() {
    await say('user', 'Сегодня не могу тренироваться', { source: 'quick' });
    const w = workoutToday();
    const bal = safe(() => P.weeklyBalance?.(C.today()));
    if (!w) return coach(`Сегодня тренировки по плану и нет. Отдыхай, но про воду и шаги не забывай.${bal?.suggestion ? '\n' + bal.suggestion : ''}`);
    return coach(`Понял. Чтобы неделя не просела, перенесу «${w.data.title}» на ближайший свободный день - или сделаем сегодня днём отдыха.${bal?.suggestion ? '\n' + bal.suggestion : ''}`,
      [{ label: 'Перенести', kind: 'local_move' }, { label: 'День отдыха', kind: 'local_rest' }]);
  },
  async short() {
    await say('user', 'Есть только 15 минут', { source: 'quick' });
    const w = workoutToday();
    if (w && P.makeHomeWorkout) {
      return coach(`15 минут - лучше, чем ничего. Могу заменить сегодняшнюю «${w.data.title}» на короткую тренировку, а недобранное разложу по неделе.`,
        [{ label: 'Собрать 15-минутку', kind: 'local_home15' }, { label: 'Облегчить текущую', kind: 'local_light' }]);
    }
    const text = await quickWorkout();
    return coach(text, P.makeHomeWorkout ? [{ label: 'Открыть тренировку', kind: 'open', params: { href: '#workout' } }] : null);
  },
  async tired() {
    await say('user', gx('Устал{|а}, плохо спал{|а}'), { source: 'quick' });
    const r = safe(() => P.readiness?.(C.today()));
    const v = safe(() => P.workoutVariant?.(C.today()));
    const ready = r ? `Готовность сегодня ${Math.round(r.score)} из 100${r.reasons?.length ? ` (${r.reasons.slice(0, 2).join(', ')})` : ''}. ` : '';
    if (!workoutToday()) return coach(`${ready}Тренировки сегодня нет - хороший шанс восстановиться. Прогулка 20–30 минут и лечь сегодня на полчаса раньше.`);
    if (v?.variant === 'full') {
      return coach(`${ready}Спасибо, что сказал. По цифрам ты в норме, можно и полный объём - но слушай себя: если тяжело, облегчу.`,
        [{ label: 'Облегчить', kind: 'local_light' }, { label: 'Восстановление', kind: 'local_recovery' }]);
    }
    const rec = v?.variant === 'recovery' ? 'восстановление' : 'облегчённый вариант';
    return coach(`${ready}Спасибо, что сказал. Через силу - не лучшая идея: предлагаю ${rec}.${v?.why ? ' ' + v.why : ''}`,
      [{ label: 'Облегчить', kind: 'local_light' }, { label: 'Восстановление', kind: 'local_recovery' }]);
  },
  pain() {
    S.forms.pain = { zone: S.forms.pain?.zone || 'knees', note: '' };
    openPain();
  },
  async move() {
    await say('user', 'Перенеси тренировку на завтра', { source: 'quick' });
    const r = await moveWorkout(C.today());
    return coach(r.text + (r.ok ? ' Недельный объём сохраняется.' : ''));
  },
  async cheat() {
    await say('user', 'Хочу читмил', { source: 'quick' });
    let adv = safe(() => C.cheatAdvice?.(C.today()));
    if (!adv) {
      const mon = C.addDays(C.today(), -((C.parse(C.today()).getDay() + 6) % 7));
      const used = store.list('daytype').filter(r => r.data.type === 'cheat' && r.date >= mon && r.date !== C.today()).length;
      adv = used ? { allowed: false, reason: 'На этой неделе читмил уже был. Давай дотерпим до следующей.' } : { allowed: true, reason: 'На этой неделе читмила ещё не было.' };
    }
    if (C.dayType?.(C.today()) === 'cheat' || store.get(`daytype:${store.uid()}:${C.today()}`)?.data?.type === 'cheat') return coach('Сегодня уже отмечен читмил. Наслаждайся без чувства вины.');
    return adv.allowed
      ? coach(`Можно. ${adv.reason || ''} Отметить сегодня как день читмила? Тогда ругать за калории не буду.`.replace(/\s+/g, ' ').trim(), [{ label: 'Отметить читмил', kind: 'local_cheat' }])
      : coach(`${adv.reason || 'Сегодня я бы не советовал.'} Решать тебе - но я против.`, [{ label: 'Всё равно отметить', kind: 'local_cheat' }]);
  },
};

function openPain() {
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Тренер</div><h2>Что болит?</h2></div>
    <div class="modal-body">${chips('pain', 'zone', 'knees', PAIN_ZONES)}
      <div style="margin-top:14px">${field('Как болит', input('pain', 'note', '', 'placeholder="например: тянет при приседе"'))}</div>
      <p class="note">Упражнения на эту зону уберу из плана, пока не отметите в профиле «прошло». При головной боли - предложу облегчить или перенести тренировку. Острая боль или больше 3–5 дней - повод к врачу.</p></div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button><button class="btn" data-act="chat-pain">Записать</button></div>`);
}

// ── действия ──
async function send() {
  const text = (S.forms.chat?.text ?? document.getElementById('chat-in')?.value ?? '').trim();
  if (!text) return;
  if (!store.state.online) return toast('Нет связи с сервером - чат недоступен');
  if (jobFor('chat')) return toast('Тренер ещё отвечает на прошлый вопрос');
  pinned = true;                        // своё сообщение - всегда видно
  const id = await say('user', text);
  S.forms.chat = { text: '' };
  const ta = document.getElementById('chat-in');
  if (ta) { ta.value = ''; ta.style.height = ''; ta.blur(); }
  refreshList();
  try {
    await store.sync();
    const res = await store.api('/api/chat', { text, message_id: id });
    if (res?.job_id) { await addJob(res.job_id, 'chat', 'chat'); refreshList(); }
  } catch (e) {
    if (e.status === 404) await coach('Свободный чат с ИИ ещё не подключён на сервере. Пока работают быстрые кнопки внизу.');
    else if (e.status === 503) await coach(`Локальная ИИ сейчас недоступна${e.message ? ` (${e.message})` : ''}. Попробуй позже - или воспользуйся быстрыми кнопками.`);
    else if (e.status === 0) await coach('Не достучался до сервера. Вопрос сохранён выше - повтори, когда будет связь.');
    else toast(e.message || 'Ошибка', 5000);
  }
}

async function setStatus(msgId, actId, status) {
  const m = store.get(msgId);
  if (!m) return;
  await store.patch(msgId, { actions: (m.data.actions || []).map(a => (actId === '*' ? (a.status || 'offered') === 'offered' : a.id === actId) ? { ...a, status } : a) });
}

export const actions = {
  'chat-send': () => send(),
  'chat-quick': el => SCENARIO[el.dataset.q]?.(),
  'chat-pain': async () => {
    const f = S.forms.pain || {};
    const zone = f.zone || 'knees', note = (f.note || '').trim();
    closeModal();
    // то же, что «Что-то болит» в самочувствии на «Сегодня»: отметка там и подстройка плана дня
    const pain = { head: 'head', stomach: 'stomach', back: 'back', lower_back: 'back', knees: 'knees' }[zone];
    const did = pain ? await setPain(C.today(), pain, true) : '';
    const w = workoutToday(), tail = did ? ` План на сегодня подстроил: ${did}.` : '';
    if (zone === 'head' || zone === 'stomach') {
      // голова и живот - не травма зоны: обычно проходит за день - без записи «до отметки прошло»
      const what = zone === 'head' ? 'голова' : 'живот';
      await say('user', `Болит ${what}${note ? ` - ${note}` : ''}`, { source: 'quick' });
      const advice = zone === 'head' ? 'Попей воды, проветри, отдохни от экрана.' : 'Сегодня без пресса и тяжёлых нагрузок, еда - попроще.';
      await coach(`Понял, болит ${what}. Отметил в самочувствии на сегодня.${tail} ${w && !did.includes('облегчил') ? 'Если через силу - лучше облегчить или перенести тренировку.' : ''} ${advice} Если боль сильная, внезапная или повторяется - к врачу.`.replace(/\s+/g, ' ').trim(),
        w ? [{ label: 'Облегчить сегодняшнюю', kind: 'local_light' }, { label: 'Перенести на завтра', kind: 'local_move' }] : null);
      await afterChange(C.today());
      return;
    }
    await store.put('injury', store.newId(), { zone, note, since: C.today(), resolved: null }, C.today());
    await say('user', `Болит: ${ZONE_NAME[zone] || zone}${note ? ` - ${note}` : ''}`, { source: 'quick' });
    if (!pain) await P.adaptToday?.(C.today());
    await coach(`Записал: ${ZONE_NAME[zone] || zone}. Пока не отметишь «прошло» в профиле, упражнения на эту зону уберу из плана.${tail} Если боль острая или не проходит 3–5 дней - покажись врачу.`,
      w ? [{ label: 'Облегчить сегодняшнюю', kind: 'local_light' }] : null);
    await afterChange(C.today());
  },
  'chat-act': async el => {
    const m = store.get(el.dataset.m);
    const a = m?.data.actions?.find(x => x.id === el.dataset.a);
    if (!a) return;
    const key = `${m.id}|${a.id}`;
    if (pending.has(key)) return;
    pending.add(key); S.render(); refreshList();
    try {
      if (a.local || m.data.source === 'quick' || a.kind?.startsWith('local_') || a.kind === 'open') {
        const reply = await runLocal(a);
        await setStatus(m.id, a.id, 'done');
        if (a.kind !== 'open') await setStatus(m.id, '*', 'declined');   // остальные варианты — уже не актуальны
        if (reply) await coach(reply);
      } else {
        const res = await store.api('/api/chat/action', { message_id: m.id, action_id: a.id });
        await store.sync();
        if (store.get(m.id)?.data.actions?.find(x => x.id === a.id)?.status === 'offered') await setStatus(m.id, a.id, 'done');
        const msg = typeof res?.result === 'string' ? res.result : res?.result?.text;
        toast(msg || 'Готово');
      }
    } catch (e) {
      toast(e.status === 404 ? 'Сервер ещё не умеет выполнять действия чата - обновите сервер' : e.status === 0 ? 'Нет связи с сервером' : (e.message || 'Ошибка'), 5000);
    } finally { pending.delete(key); S.render(); refreshList(); }
  },
  'chat-decline': el => setStatus(el.dataset.m, '*', 'declined'),
};

document.addEventListener('keydown', e => {
  if (e.target?.id === 'chat-in' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
// поле ввода растёт по мере набора
document.addEventListener('input', e => {
  if (e.target?.id !== 'chat-in') return;
  const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight + 2) + 'px';
});

export const routes = { chat: () => viewChat() };

// Сообщения крутятся в своей области между заголовком и полем ввода, а не всей страницей: иначе, чтобы вернуть
// шапку (синхронизация, «обновление», тема), приходилось листать всю переписку вверх. Колесо/палец над остальной
// страницей прокручивает её саму.
const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
function fitList() {
  const comp = document.getElementById('chat-composer'), list = document.getElementById('chat-list');
  if (!comp || !list) return;
  const tab = document.querySelector('.tabbar');
  const mobile = tab && getComputedStyle(tab).display !== 'none';
  comp.style.bottom = mobile ? `${tab.offsetHeight}px` : '';
  const fresh = !list.dataset.watch;
  if (fresh) {
    list.dataset.watch = '1';
    list.addEventListener('scroll', () => { pinned = nearBottom(list); lastTop = list.scrollTop; }, { passive: true });
  }
  if (mobile) {
    // телефон: поле ввода закреплено над вкладками - низ списка (и листа под ним) ставим прямо к его верхнему краю.
    // Считаем по фактическому положению на экране, а не по innerHeight: в приложении на iOS высота окна
    // и отступы страницы не совпадают с видимой областью, и список получался короче на пару сантиметров.
    const sheetPad = parseFloat(getComputedStyle(list.closest('.sheet') || list).paddingBottom) || 0;
    list.style.height = `${Math.max(220, comp.getBoundingClientRect().top - sheetPad - 6 - list.getBoundingClientRect().top)}px`;
  } else {
    const top = list.getBoundingClientRect().top + window.scrollY;
    const h = Math.max(220, window.innerHeight - top - comp.offsetHeight - 24);
    list.style.height = `${h}px`;
    // отступы листа и раскладки под полем ввода: убираем то, на что страница всё ещё длиннее окна
    const extra = document.documentElement.scrollHeight - window.innerHeight;
    if (extra > 0 && h > 220) list.style.height = `${Math.max(220, h - extra)}px`;
  }
  if (pinned) list.scrollTop = list.scrollHeight;
  else if (fresh) list.scrollTop = lastTop;          // список создан заново - туда же, где читали
}
const refit = () => { if (location.hash.startsWith('#chat')) fitList(); };
window.addEventListener('resize', refit);
window.visualViewport?.addEventListener('resize', refit);     // iOS: клавиатура меняет видимую часть экрана

export function afterRender() {
  fitList();
  // шрифты и шапка могут догрузиться/сдвинуться после первой раскладки - подогнать ещё раз
  requestAnimationFrame(refit); setTimeout(refit, 350); document.fonts?.ready.then(refit);
  const list = document.getElementById('chat-list');
  const count = messages().length + (jobFor('chat') ? 1 : 0);
  if (entered) pinned = true;            // зашли в чат - к последним сообщениям
  // новое сообщение прокручивает вниз, только если человек и так был внизу, а не читает старое
  if (list && (entered || (count !== lastCount && pinned))) list.scrollTop = list.scrollHeight;
  entered = false; lastCount = count;
  // прочитано: снимаем точку на вкладке
  const hadDot = document.querySelector('a[href="#chat"] .dot');
  store.setMeta('chat_seen', Date.now()).then(() => { if (hadDot) S.render(); });
}

// замечания, которые снимаются сами, когда человек сделал то, о чём просили (записал сон, отметил самочувствие…)
const RESOLVABLE = new Set(['sleep', 'state', 'food', 'food_evening', 'water', 'weight', 'workout', 'measure', 'activity_unclear']);

// Сообщения-правила и напоминания: раз в день на правило, id chat:{uid}:{date}:{rule}
export async function background() {
  const uid = store.uid();
  if (!uid || !C.ruleMessages) return;
  const list = safe(() => C.ruleMessages(new Date()), []) || [];
  const d = C.today();
  // уже сделано - помечаем сегодняшнее замечание, чтобы в чате не висело «сон не записан», когда он записан
  const active = new Set(list.map(m => m?.rule));
  for (const r of store.byDate('chat', d)) {
    const x = r.data;
    if (x.source === 'rule' && RESOLVABLE.has(x.rule) && !x.resolved_at && !active.has(x.rule)) {
      await store.patch(r.id, { resolved_at: Date.now() });
      // помимо галочки «сделано» - короткая похвала тем же тоном, что было исправлено (раз в день на правило)
      const text = safe(() => C.resolvedPraise(x.rule), null);
      const pid = `chat:${uid}:${d}:${x.rule}:done`;
      if (text && !store.get(pid)) await store.put('chat', pid, { role: 'coach', text, created: Date.now(), source: 'rule', rule: x.rule, mood: 'praise' }, d);
    }
  }
  let i = 0;
  for (const m of list) {
    if (!m?.rule || !m.text) continue;
    const id = `chat:${uid}:${d}:${m.rule}`;
    if (store.get(id)) continue;
    const acts = m.href ? [{ id: 'open', label: m.hrefLabel || 'Открыть', kind: 'open', params: { href: m.href }, status: 'offered', local: true }] : (m.actions || null);
    await store.put('chat', id, { role: 'coach', text: m.text, created: Date.now() + i++, source: 'rule', rule: m.rule, mood: m.mood || null, ...(acts ? { actions: acts } : {}) }, d);
  }
}
