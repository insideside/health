import * as store from '../store.js';
import * as C from '../coach.js';
import { S, esc, num, fmt, WD, profile, goal, toast, field, fval, input, textarea, select, chips, openModal, closeModal, jobFor, addJob, afterChange, glyph , IS_ANDROID } from '../ui.js';
import { competeBody, competeSummary } from './together.js';
import * as BR from '../brain.js';
import * as GL from '../goals.js';
import * as NL from '../normslocal.js';
import * as PF from '../prefs.js';
import * as P from '../plan.js';
import { myExBody, myExSummary } from './fit.js';
import * as SPV from './supp.js';

// Профиль v2: разделы-«гармошки» (свёрнуты по умолчанию, в заголовке — краткая сводка).
// Всё, что относится к профилю и цели, собирается в черновик S.forms.profile и пишется одной кнопкой «Сохранить».
// Травмы, пункты чек-листа, токен «Здоровья» — отдельные записи, сохраняются сразу.

const F = 'profile';

// ── справочники подписей ──
const GOALS = [['lose_fat', 'Похудеть'], ['gain_muscle', 'Набрать мышцы'], ['endurance', 'Выносливость'], ['tone', 'Тонус'],
  ['sleep', 'Качество сна'], ['gain_weight', 'Набрать вес'], ['maintain', 'Удержать форму'], ['posture', 'Осанка'], ['neck', 'Шея и скулы']];
const GOAL_NAME = Object.fromEntries(GOALS);
const GOAL_KG = new Set(['lose_fat', 'gain_muscle', 'gain_weight']);
const GOAL_HINT = {
  endurance: 'Больше кардио и активностей, дольше без одышки.',
  tone: 'Подтянутость без большого набора массы: силовые + умеренный дефицит.',
  sleep: 'Режим отхода ко сну, напоминания, меньше кофе вечером.',
  maintain: 'Держим вес и форму, без дефицита.',
  posture: 'Короткий модуль упражнений на спину и плечи.',
  neck: 'Честно: подбородок уходит только с общим снижением жира. Упражнения тонизируют шею и улучшают осанку.',
};
const ZONES_MUSCLE = [['chest', 'грудь'], ['shoulders', 'плечи'], ['arms', 'руки'], ['back', 'спина'], ['abs', 'пресс'], ['sides', 'бока'], ['glutes', 'ягодицы'], ['legs', 'ноги']];
const INJURY_ZONES = [...ZONES_MUSCLE, ['neck', 'шея'], ['knees', 'колени'], ['lower_back', 'поясница'], ['wrists', 'запястья'], ['ankles', 'голеностоп'], ['hips', 'тазобедренный сустав']];
const ZONE_NAME = Object.fromEntries(INJURY_ZONES);
const HABITS = [['less_sugar', 'меньше сахара'], ['less_flour', 'меньше мучного'], ['less_coffee', 'меньше кофе'], ['less_alcohol', 'меньше алкоголя'],
  ['less_fastfood', 'меньше фастфуда'], ['less_late_eating', 'не есть поздно'], ['more_veg', 'больше овощей'], ['more_protein', 'больше белка'],
  ['more_fiber', 'больше клетчатки'], ['quit_smoking', 'бросить курить']];
const SMOKE_TYPES = [['cigarette', 'Сигареты'], ['vape', 'Вейп / HQD'], ['iqos', 'Системы нагревания (IQOS и похожие)'], ['hookah', 'Кальян'], ['other', 'Другое']];
const PRIO = [[1, 'главная'], [2, 'важная'], [3, 'по возможности']];
const BODY = [['ecto', 'Эктоморф'], ['meso', 'Мезоморф'], ['endo', 'Эндоморф'], ['mixed', 'Смешанный']];
const BODY_HINT = {
  ecto: 'Худощавый, узкая кость, быстрый обмен. Набирать вес и мышцы трудно - нужен профицит и упор на силовые.',
  meso: 'Атлетичный от природы: мышцы отзываются быстро, вес держится ровно.',
  endo: 'Ширококостный, легко набирает и мышцы, и жир; жир уходит медленнее - важны шаги и питание.',
  mixed: 'Черты разных типов - так у большинства. Тренер ориентируется на ваши заметки ниже.',
};
const LIMITS = [['knees', 'колени'], ['lower_back', 'поясница'], ['neck', 'шея'], ['shoulders', 'плечи'], ['wrists', 'запястья'], ['hips', 'тазобедренные'],
  ['ankles', 'голеностопы'], ['hypertension', 'давление'], ['heart', 'сердце'], ['hernia', 'грыжа'], ['varicose', 'варикоз'], ['pregnancy', 'беременность'],
  ['asthma', 'астма'], ['diabetes', 'диабет'], ['overweight_joints', 'суставы и лишний вес']];
const DIETS = [['normal', 'Обычное питание'], ['vegetarian', 'Вегетарианство'], ['vegan', 'Веганство'], ['pescatarian', 'Пескетарианство'],
  ['lactose_free', 'Без лактозы'], ['gluten_free', 'Без глютена'], ['low_carb', 'Меньше углеводов'], ['keto', 'Кето'], ['halal', 'Халяль'],
  ['kosher', 'Кошер'], ['if_16_8', 'Интервальное 16/8'], ['if_18_6', 'Интервальное 18/6'], ['diabetic', 'Диабетическое']];
const ACT = [['sedentary', 'Сидячая'], ['light', 'Лёгкая'], ['moderate', 'Умеренная'], ['high', 'Высокая']];
const INTENSITY = [['low', 'лёгкая'], ['mid', 'средняя'], ['high', 'высокая']];
const SLOTS = [['any', 'когда угодно'], ['morning', 'утром'], ['day', 'днём'], ['evening', 'вечером'], ['none', 'не могу']];
const REMINDERS = [['sleep', 'Внести сон'], ['state', 'Самочувствие'], ['food', 'Записать еду'], ['water', 'Вода'], ['weight', 'Взвеситься'],
  ['measure', 'Замеры'], ['workout', 'Тренировка']];
const TL = { comfortable: 'комфортно', moderate: 'умеренно', aggressive: 'агрессивно', unrealistic: 'нереально' };
const PACE = { slower: 'медленнее обычного', normal: 'обычный', faster: 'быстрее обычного' };
const PACES = ['slower', 'normal', 'faster'];
const TONE_SAMPLE = { soft: 'Вчера получилось только 40 %. Не переживай - сегодня новый день.', coach: 'Вчера 40 %. Это мало. Сегодня минимум 80.', sergeant: 'Вчера 40 %?! Это не тренировка, это санаторий.' };

const clone = x => JSON.parse(JSON.stringify(x ?? null));
const n = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(String(v).replace(',', '.'))) ? null : Number(String(v).replace(',', '.')));
const ageOf = b => { if (!b) return null; const d = C.parse(b), t = new Date(); return t.getFullYear() - d.getFullYear() - ((t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) ? 1 : 0); };
const actName = a => S.activities.get(a.type)?.name || a.name || a.type;

function apiMsg(e, what) {
  if (e.status === 404) return `${what}: на сервере этого ещё нет - обновите сервер`;
  if (e.status === 0) return 'Нет связи с сервером';
  if (e.status === 503) return `Локальная ИИ недоступна. ${e.message || ''}`.trim();
  return e.message || 'Ошибка';
}

// ── черновик формы ──
function legacyGoals(g) {
  const out = [];
  if (g.fat_kg) out.push({ type: 'lose_fat', amount: g.fat_kg, priority: 1 });
  const m = (g.muscle_upper_kg || 0) + (g.muscle_lower_kg || 0);
  if (m) out.push({ type: 'gain_muscle', amount: m, priority: out.length ? 2 : 1,
    zones: [...(g.muscle_upper_kg ? ['chest', 'shoulders', 'arms', 'back'] : []), ...(g.muscle_lower_kg ? ['glutes', 'legs'] : [])] });
  return out;
}

function initForm() {
  const p = profile(), g = goal();
  const days = {};
  for (let i = 0; i < 7; i++) days[i] = { busy: p.schedule?.days?.[i]?.busy || '', slot: p.schedule?.days?.[i]?.slot || 'any' };
  const m = p.modules || {};
  return {
    name: p.name ?? store.me()?.name ?? '', sex: p.sex || '', birth: p.birth || '', height: p.height ?? '',
    weight: C.weights().slice(-1)[0]?.w ?? p.weight ?? '', activity: p.activity || 'light',
    body_type: p.body_type || '', patterns: p.patterns || '',
    goals: g.goals?.length ? clone(g.goals) : legacyGoals(g), habits: [...(g.habits || [])], smoking_types: [...(g.smoking_types || [])],
    deadline: g.deadline || '', goal_text: g.text || '',
    pace: p.pace || 'normal',
    limitations: [...(p.limitations || [])], limitations_note: p.limitations_note || '', diet: p.diet || 'normal',
    allergies: p.allergies || '', medications: p.medications || '', extra_notes: p.extra_notes || '',
    cycle_on: !!p.cycle?.enabled, cycle_last: p.cycle?.last_start || '', cycle_len: p.cycle?.length || 28, cycle_period: p.cycle?.period || 5,
    gym: !!p.gym, gym_program: p.gym_program === 'own' ? 'own' : 'ai', weekdays: [...(p.weekdays || [0, 2, 4])], max_sessions_week: p.max_sessions_week ?? (p.weekdays || [0, 2, 4]).length,
    time_budget_min: p.time_budget_min || 60, equipment: [...(p.equipment || [])], start_mode: p.start_mode || 'smooth',
    gym_missing: [...(p.gym_equipment?.missing || [])], cardio_likes: [...(p.cardio?.likes || [])],
    cardio_places: [...(p.cardio?.places || (p.gym ? ['gym', 'home', 'outdoor'] : ['home', 'outdoor']))], location: p.location ? { ...p.location } : null,
    sched_irregular: !!p.schedule?.irregular, sched_days: days,
    activities: clone(p.activities || []),
    mod_home_on: m.home_plan?.enabled !== false,
    mod_morning_on: m.morning?.enabled ?? true, mod_morning_min: m.morning?.minutes || 10, mod_morning_gear: m.morning?.gear || 'any',
    mod_neck_on: !!m.neck?.enabled, mod_neck_week: m.neck?.per_week || 3, mod_neck_min: m.neck?.minutes || 5,
    mod_posture_on: !!m.posture?.enabled, mod_posture_week: m.posture?.per_week || 3, mod_posture_min: m.posture?.minutes || 10,
    ew_on: !!p.eating_window?.enabled, ew_from: p.eating_window?.from || '10:00', ew_to: p.eating_window?.to || '20:00',
    glass_ml: p.glass_ml || 250, milk_mode: p.milk_mode === 'hidden' ? 'hidden' : 'meal', reminders: clone(p.reminders || []), tone: p.tone || 'coach',
    ai: p.ai === 'off' ? 'off' : 'on',
    share_activity: p.share_activity !== false,
    share_meals: !!p.share_meals,
    share_training: !!p.share_training,
  };
}
let snapshot = '', stamp = '';
const recStamp = () => `${store.get(`profile:${store.uid()}`)?.updated_at || 0}|${store.get(`goal:${store.uid()}`)?.updated_at || 0}`;
// черновик пересоздаётся, если профиль изменился извне (синк с другого устройства), а правок ещё нет
const form = () => {
  if (S.forms[F] && stamp !== recStamp() && JSON.stringify(S.forms[F]) === snapshot) delete S.forms[F];
  if (!S.forms[F]) {
    S.forms[F] = initForm(); snapshot = JSON.stringify(S.forms[F]); stamp = recStamp();
    // несохранённый черновик (ушли с экрана, закрыли приложение) — возвращаем поверх свежих данных
    // только те поля, что меняли сами: так правки с другого устройства в остальных полях не затираются
    const d = store.getMeta('draft_profile');
    if (d && d.uid === store.uid()) {
      const base = JSON.parse(d.snapshot || '{}');
      for (const [k, v] of Object.entries(d.form || {})) if (JSON.stringify(v) !== JSON.stringify(base[k])) S.forms[F][k] = v;
    }
  }
  return S.forms[F];
};

// черновик профиля — в память устройства, чтобы правки пережили уход с экрана и перезапуск PWA
let draftTimer = null;
function keepDraft() {
  if (!S.forms[F]) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => store.setMeta('draft_profile', dirty() ? { uid: store.uid(), form: S.forms[F], snapshot } : null), 400);
}

// ── состояние разделов, оценки срока, токена ──
const openSecs = new Set();
let openInit = false;
const preview = { key: '', loading: false, data: null, error: '' };
let previewTimer = null;
const health = { token: null, loading: false, error: '' };
let serverConfig = null, configTried = 0;

document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.sec) return;
  if (d.open) openSecs.add(d.dataset.sec); else openSecs.delete(d.dataset.sec);
  if (d.open && d.dataset.sec === 'iphone' && !health.token && !health.loading) loadToken();
  if (d.open && d.dataset.sec === 'deadline') maybePreview();
}, true);

// поиск активностей — без перерисовки экрана, чтобы не терять фокус
document.addEventListener('input', e => {
  if (e.target.id === 'pf-act-q') renderActSuggest(e.target.value);
  // оценка новой цели-показателя — на лету, без перерисовки экрана (фокус остаётся в поле)
  // (после общего обработчика в app.js, который записывает значение в черновик)
  if (e.target.dataset?.form === 'gm') setTimeout(() => { const v = document.getElementById('gm-verdict'); if (v) v.innerHTML = gmVerdict(); }, 0);
});

function sec(id, title, summary, body, group = '') {
  return `<details class="psec" data-sec="${id}" id="sec-${id}" ${openSecs.has(id) ? 'open' : ''}>
    <summary><span class="psec-t">${title}</span><span class="psec-s ell">${summary || ''}</span></summary>
    <div class="psec-b">${body}</div></details>`;
}
const chk = (key, label, on, rerender = true) => `<label class="chk pf-chk"><input type="checkbox" data-form="${F}" data-key="${key}" ${on ? 'checked' : ''} ${rerender ? 'data-rerender' : ''}>${label}</label>`;

// ── экран ──
function viewProfile() {
  const prof = profile(), fm = form();
  const po = sessionStorage.getItem('pf_open');
  if (po) { openSecs.add(po); sessionStorage.removeItem('pf_open'); }
  if (!openInit) {
    openInit = true;
    if (!prof.setup_done) { openSecs.add('params'); openSecs.add('goals'); }
  }
  const tgRec = latestTarget();
  const tg = tgRec?.data;
  const age = ageOf(fm.birth);
  const selGoals = fm.goals.map(g => g.type === 'metric' ? `${GL.metric(g.metric)?.label || g.metric} → ${GL.fmtNum(g.to, GL.metric(g.metric))} ${GL.metric(g.metric)?.unit || ''}`
    : GOAL_NAME[g.type] + (g.amount ? ` ${String(g.amount).replace('.', ',')} кг` : '')).join(', ');
  const injuries = store.list('injury').filter(r => !r.data.resolved);
  const acts = fm.activities;

  const grp = (title, note = '') => `<div class="pgroup"><span class="smallcaps">${title}</span>${note ? `<span class="note">${note}</span>` : ''}</div>`;
  const sections = [
    grp('О вас', 'по этому считаются нормы и подбираются упражнения'),
    sec('params', 'Параметры', [age ? `${age} лет` : '', fm.height ? `${fm.height} см` : '', fm.weight ? `${String(fm.weight).replace('.', ',')} кг` : ''].filter(Boolean).join(' · ') || 'не заполнено', paramsBody(fm)),
    sec('body', 'Телосложение и особенности', fm.body_type ? BODY.find(b => b[0] === fm.body_type)?.[1] : 'не указано', bodyBody(fm)),
    sec('health', 'Здоровье', [fm.limitations.length ? `ограничений: ${fm.limitations.length}` : '', injuries.length ? `травм: ${injuries.length}` : '', fm.diet !== 'normal' ? DIETS.find(d => d[0] === fm.diet)?.[1] : ''].filter(Boolean).join(' · ') || 'без ограничений', healthBody(fm)),
    fm.sex === 'f' ? sec('cycle', 'Цикл', fm.cycle_on ? 'учитывается' : 'не учитывается', cycleBody(fm)) : '',

    grp('Цели и нормы', 'к чему идём и сколько нужно в день'),
    sec('goals', 'Цели', selGoals || 'не выбраны', goalsBody(fm)),
    sec('deadline', 'Срок цели', fm.deadline ? `до ${esc(fmt(fm.deadline, { day: 'numeric', month: 'long', year: 'numeric' }))}${preview.data?.label ? ' · ' + (TL[preview.data.label] || '') : ''}` : 'без срока', deadlineBody(fm, tg)),
    sec('norms', 'Нормы', tg ? `${num(tg.kcal)} ккал · белок ${tg.p} г · ${num(tg.steps_manual || tg.steps)} шагов` : 'ещё не считались', normsBody(tgRec)),

    grp('Тренировки', 'где, когда и что делать'),
    sec('training', 'Где и когда', `${fm.gym ? (fm.gym_program === 'own' ? 'зал - своя программа' : 'зал') : 'дома'} · ${fm.weekdays.map(i => WD[i]).join(', ') || 'дни не выбраны'} · до ${fm.time_budget_min} мин`, trainingBody(fm)),
    sec('equipment', 'Что есть дома', equipSummary(fm), equipBody(fm)),
    sec('modules', 'Короткие комплексы', [fm.mod_home_on ? 'под цели' : '', fm.mod_morning_on ? `разминка ${fm.mod_morning_min} мин` : '', fm.mod_neck_on ? 'шея' : '', fm.mod_posture_on ? 'осанка' : ''].filter(Boolean).join(' · ') || 'выключены', modulesBody(fm)),
    sec('cardio', 'Кардио', cardioSummary(fm), cardioBody(fm)),
    sec('activities', 'Активности', acts.length ? acts.map(a => esc(actName(a))).join(', ') : 'нет', activitiesBody(fm)),
    sec('myex', 'Мои упражнения', myExSummary(), myExBody()),

    grp('Питание'),
    sec('food', 'Режим питания', [fm.ew_on ? `окно ${esc(fm.ew_from)}–${esc(fm.ew_to)}` : '', `стакан ${fm.glass_ml} мл`, fm.milk_mode === 'hidden' ? 'молоко в итогах' : 'молоко в приёмах'].filter(Boolean).join(' · '), foodBody(fm)),
    sec('supps', 'Витамины и добавки', SPV.profileSummary(), SPV.profileBody()),

    grp('Каждый день', 'что отмечать и когда напоминать'),
    sec('checklist', 'Чек-лист', `${store.list('item').filter(i => i.data.active !== false).length} пунктов`, checklistBody()),
    sec('reminders', 'Напоминания', fm.reminders.filter(r => r.enabled).length ? fm.reminders.filter(r => r.enabled).map(r => esc(r.time)).join(', ') : 'нет', remindersBody(fm)),

    grp('Тренер'),
    sec('tone', 'Тон тренера', C.TONE_NAMES[fm.tone] || '', toneBody(fm)),
    sec('ai', 'ИИ-тренер', fm.ai === 'off' ? 'выключена' : 'включена', aiBody(fm)),

    store.partners().length || store.groups().length || store.isAdmin() ? grp('Вместе', 'что видят другие и что делаете вместе') : '',
    store.partners().length ? sec('compete', 'Прогресс вместе', competeSummary(), competeBody()) : '',
    store.groups().length || store.isAdmin() ? sec('group', 'Группа', groupSummary(fm), groupBody(fm)) : '',

    grp('Приложение и данные'),
    IS_ANDROID ? '' : sec('iphone', 'Здоровье iPhone', 'шаги, сон и вес через «Команды»', iphoneBody()),
    sec('privacy', 'Данные и приватность', BR.privacySummary(), BR.privacyBody()),
    sec('app', 'Приложение', 'тема, адрес, установка, экспорт, выход', appBody()),
  ];

  return `<div class="kicker smallcaps">Профиль</div><h1>${esc(prof.name || store.me()?.name || 'Профиль')}</h1>
    <p class="lede">${prof.setup_done ? 'Всё, что тренер знает о вас. Откройте нужный раздел, поправьте и сохраните.'
      : 'Начнём знакомство: заполните параметры и цели - по ним тренер посчитает нормы и составит план. Остальное можно добавить потом.'}</p>
    <div class="profile-v2">${sections.join('')}</div>
    <div class="pf-savebar"><span class="note" id="pf-dirty">${dirty() ? 'Есть несохранённые изменения' : 'Всё сохранено'}</span>
      <button class="btn solid" data-act="prof-save" id="pf-save" ${dirty() ? '' : 'disabled'}>Сохранить</button></div>`;
}

// кнопка «Сохранить» оживает сразу при вводе — экран при наборе текста не перерисовывается
function syncSaveBar() {
  const btn = document.getElementById('pf-save'), note = document.getElementById('pf-dirty');
  if (!btn) return;
  const d = dirty();
  btn.disabled = !d;
  if (note) note.textContent = d ? 'Есть несохранённые изменения' : 'Всё сохранено';
}
for (const ev of ['input', 'change', 'click']) document.addEventListener(ev, () => setTimeout(() => { syncSaveBar(); if (location.hash.startsWith('#profile')) keepDraft(); }, 0));

function dirty() { return !!S.forms[F] && JSON.stringify(S.forms[F]) !== snapshot; }

// ── разделы ──
function paramsBody(fm) {
  return `<div class="grid3">
    ${field('Имя', input(F, 'name', fm.name))}
    ${field('Пол', select(F, 'sex', fm.sex, [['', '-'], ['m', 'Мужской'], ['f', 'Женский']], 'data-rerender'))}
    ${field('Дата рождения', input(F, 'birth', fm.birth, 'type="date"'))}
    ${field('Рост, см', input(F, 'height', fm.height, 'type="number" inputmode="numeric" min="100" max="250"'))}
    ${field('Вес, кг', input(F, 'weight', fm.weight, 'type="number" inputmode="decimal" step="0.1"'))}
    ${field('Активность вне тренировок', select(F, 'activity', fm.activity, ACT))}
  </div>
  <p class="note">Активность - обычный день без спорта: сидячая работа - «сидячая», много хожу - «умеренная», физический труд - «высокая».</p>`;
}

function bodyBody(fm) {
  return `<div class="field"><span class="smallcaps">Тип телосложения</span>${chips(F, 'body_type', fm.body_type, BODY)}</div>
    ${fm.body_type ? `<p class="note">${esc(BODY_HINT[fm.body_type])}</p>` : `<p class="note">Не уверены - выберите «Смешанный» или оставьте пустым.</p>`}
    <div style="margin-top:12px">${field('Что мне помогает и мои особенности', textarea(F, 'patterns', fm.patterns, 'rows="3" placeholder="например: лучше тренируюсь утром, вечером тянет на сладкое"'))}</div>
    <p class="note">Тренер учитывает это при составлении программы и норм.</p>`;
}

function goalsBody(fm) {
  const sel = new Set(fm.goals.map(g => g.type));
  const rows = fm.goals.filter(g => g.type !== 'metric').map(g => `<div class="pf-goal">
    <div class="pf-goal-h"><b>${esc(GOAL_NAME[g.type] || g.type)}</b>
      <div class="chips pf-prio">${PRIO.map(([k, l]) => `<button type="button" class="chip ${Number(g.priority || 2) === k ? 'on' : ''}" data-act="pf-prio" data-t="${g.type}" data-v="${k}">${l}</button>`).join('')}</div></div>
    ${GOAL_KG.has(g.type) ? `<label class="pf-inline"><span class="smallcaps muted">${g.type === 'lose_fat' ? 'сбросить' : 'набрать'}, кг</span>
      <input class="control pf-num" type="number" inputmode="decimal" step="0.5" min="0" value="${esc(g.amount ?? '')}" data-act="pf-goal-amt" data-t="${g.type}"></label>` : ''}
    ${g.type === 'gain_muscle' ? `<div class="field" style="margin-top:10px"><span class="smallcaps">Какие зоны в приоритете</span>
      <div class="chips">${ZONES_MUSCLE.map(([k, l]) => `<button type="button" class="chip ${(g.zones || []).includes(k) ? 'on' : ''}" data-act="pf-zone" data-t="${g.type}" data-z="${k}">${l}</button>`).join('')}</div></div>` : ''}
    ${GOAL_HINT[g.type] ? `<p class="note" style="margin:6px 0 0">${esc(GOAL_HINT[g.type])}</p>` : ''}
  </div>`).join('');
  return `<div class="field"><span class="smallcaps">Чего хотите добиться - можно несколько</span>
      <div class="chips">${GOALS.map(([k, l]) => `<button type="button" class="chip ${sel.has(k) ? 'on' : ''}" data-act="pf-goal" data-t="${k}">${l}</button>`).join('')}</div></div>
    ${rows ? `<div class="pf-goals">${rows}</div>` : fm.goals.length ? '' : '<p class="note">Выберите хотя бы одну цель.</p>'}
    ${metricGoalsBody(fm)}
    <div class="field" style="margin-top:16px"><span class="smallcaps">Пищевые привычки, которые хочу изменить</span>${chips(F, 'habits', fm.habits, HABITS, true)}</div>
    <p class="note">Выбранные привычки станут пунктами чек-листа и войдут в оценку питания.</p>
    ${fm.habits.includes('quit_smoking') ? `<div class="field" style="margin-top:10px"><span class="smallcaps">Что курите - можно несколько</span>
      ${chips(F, 'smoking_types', fm.smoking_types, SMOKE_TYPES, true)}</div>
      <p class="note">Появится счётчик в чек-листе на «Сегодня» - отмечайте каждый раз, тренер будет отслеживать прогресс.</p>` : ''}
    ${fm.habits.includes('less_alcohol') ? '<p class="note">Появится журнал алкоголя на «Сегодня» - отмечайте выпитое, тренер будет отслеживать прогресс.</p>' : ''}
    <div style="margin-top:12px">${field('Своими словами', textarea(F, 'goal_text', fm.goal_text, 'rows="2" placeholder="например: подтянуть живот к лету, выносливость для походов"'))}</div>`;
}

// ── цели-показатели v3 (goals.js): талия, руки, отжимания, шаги… ──
const gkey = g => (g.type === 'metric' ? 'm:' + g.metric : g.type);
const gmForm = () => (S.forms.gm ||= { metric: '', from: '', to: '', deadline: '' });
function metricGoalsBody(fm) {
  const mg = fm.goals.filter(g => g.type === 'metric');
  const gm = gmForm(), used = new Set(mg.map(g => g.metric));
  const opts = GL.GROUPS.map(([gid, gl]) => `<optgroup label="${gl}">${GL.CATALOG.filter(m => m.group === gid && !used.has(m.id))
    .map(m => `<option value="${m.id}" ${gm.metric === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</optgroup>`).join('');
  const m = GL.metric(gm.metric), cur = m ? GL.current(m.id) : null;
  return `<div class="field" style="margin-top:18px"><span class="smallcaps">Цели в цифрах - обхваты, сила, привычки</span>
      <p class="note" style="margin:0">Не только вес: талия, объём рук, отжимания, шаги, сон. Прогресс считается по вашим замерам и тренировкам, а план смещает акценты под эти цели.</p></div>
    ${mg.length ? `<div class="pf-goals">${mg.map(g => metricRow(g, fm)).join('')}</div>` : ''}
    <div class="pf-goals"><div class="pf-goal">
      <div class="grid2">${field('Новая цель', `<select class="control" data-act="pf-gm-metric"><option value="">- выберите показатель -</option>${opts}</select>`)}
        ${m ? field('Срок - по желанию', `<input class="control" type="date" data-form="gm" data-key="deadline" value="${esc(gm.deadline)}" min="${C.addDays(C.today(), 7)}">`) : ''}</div>
      ${m ? `<p class="note" style="margin:0 0 8px">${cur ? `Сейчас <b class="mono">${GL.fmtNum(cur.value, m)}</b> ${esc(m.unit)} · ${cur.src === 'habit' ? `среднее за 7 дней` : `от ${esc(fmt(cur.date, { day: 'numeric', month: 'short' }))}`}${cur.approx ? ' · ориентировочно' : ''}.`
        : 'Замеров ещё нет - впишите стартовое значение.'} Как мерить: ${esc(m.how)}.</p>
      <div class="grid2">${field(`Сейчас, ${esc(m.unit)}`, `<input class="control" type="number" inputmode="decimal" step="${m.step}" min="0" data-form="gm" data-key="from" value="${esc(gm.from)}">`)}
        ${field(`Хочу, ${esc(m.unit)}`, `<input class="control" type="number" inputmode="decimal" step="${m.step}" min="0" data-form="gm" data-key="to" value="${esc(gm.to)}">`)}</div>
      <div id="gm-verdict">${gmVerdict()}</div>
      <div class="actions"><button class="btn" data-act="pf-gm-add">Добавить цель</button></div>` : ''}
    </div></div>`;
}
function gmVerdict() {
  const gm = gmForm(), m = GL.metric(gm.metric);
  if (!m) return '';
  const g = { type: 'metric', metric: m.id, from: gm.from, to: gm.to, deadline: gm.deadline || null };
  return verdictHtml(GL.realism(g, store.uid(), [...form().goals, g]), m, g);
}
// локальная оценка темпа: по статистике для пола и опыта, без сервера
function verdictHtml(r, m, g) {
  if (!r.text && !r.warnings.length) return '';
  const dir = GL.dirOf(g);
  const opts = !r.label && r.options.length ? `<div class="pf-verdict-n">${r.options.map(o => `<span>${esc(TL[o.label])} - <b class="mono">${o.weeks}</b> нед.</span>`).join('')}</div>` : '';
  return `<div class="pf-verdict ${r.label ? 'tl-' + r.label : ''}">${r.label ? `<div class="pf-verdict-l">${esc(r.label_ru)}</div>` : ''}
    ${opts}<p class="note" style="margin:6px 0 0">${esc(r.text)}</p>
    ${r.warnings.map(w => `<p class="note" style="margin:4px 0 0">${esc(w)}</p>`).join('')}
    ${m.note?.[dir] ? `<p class="note" style="margin:4px 0 0">${esc(m.note[dir])}</p>` : ''}
    <p class="note" style="margin:4px 0 0">Темп - по статистике для вашего пола и опыта; через 3–4 недели замеров прогноз станет точнее.</p></div>`;
}
function metricRow(g, fm) {
  const m = GL.metric(g.metric);
  if (!m) return '';
  const key = gkey(g), pr = GL.progress(g), r = GL.realism(g, store.uid(), fm.goals);
  const trend = pr.trend != null ? ` · тренд ${GL.fmtSigned(pr.trend, m, m.dec === 0 ? 1 : 2)} ${esc(m.unit)}/нед.` : '';
  const rec = GL.recordable(m.id)
    ? `<label class="pf-inline"><span class="smallcaps muted">${m.src === 'test' ? 'новый результат' : 'новый замер'}</span>
        <input class="control pf-num" type="number" inputmode="decimal" step="${m.step}" min="0" id="gm-rec-${m.id}" placeholder="${esc(m.unit)}"></label>
        <button class="btn quiet" data-act="pf-gm-rec" data-m="${m.id}">Записать</button>`
    : m.src === 'body' ? `<a class="link" href="#body">Внести замеры →</a>` : '';
  return `<div class="pf-goal">
    <div class="pf-goal-h"><b class="ell">${esc(m.label)}</b>
      <div class="chips pf-prio">${PRIO.map(([k, l]) => `<button type="button" class="chip ${Number(g.priority || 2) === k ? 'on' : ''}" data-act="pf-prio" data-t="${key}" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="note" style="margin:0 0 6px"><span class="mono">${GL.fmtNum(g.from, m)} → ${GL.fmtNum(g.to, m)}</span> ${esc(m.unit)}${pr.current != null ? ` · сейчас <b class="mono">${GL.fmtNum(pr.current, m)}</b>` : ''}${pr.status !== 'nodata' ? ` · ${esc(pr.label)}` : ''}${trend}</div>
    <div class="groove"><div class="fill" style="width:${Math.round(pr.pct * 100)}%"></div></div>
    <div class="grid2" style="margin-top:10px">${field(`Цель, ${esc(m.unit)}`, `<input class="control" type="number" inputmode="decimal" step="${m.step}" min="0" value="${esc(g.to ?? '')}" data-act="pf-gm-to" data-m="${m.id}">`)}
      ${field('Срок', `<input class="control" type="date" value="${esc(g.deadline || '')}" min="${C.addDays(C.today(), 7)}" data-act="pf-gm-dl" data-m="${m.id}">`)}</div>
    ${!g.deadline && fm.deadline ? `<p class="note" style="margin:0">Без своего срока - берётся общий срок цели.</p>` : ''}
    ${verdictHtml(r, m, g)}
    <div class="actions">${rec}<button class="btn quiet" data-act="pf-gm-del" data-m="${m.id}">Убрать цель</button></div>
  </div>`;
}
// «Срок цели»: как общий срок выглядит для целей-показателей без своего срока (локально, офлайн)
function metricDeadlineNote(fm) {
  const mg = fm.goals.filter(g => g.type === 'metric' && !g.deadline && GL.metric(g.metric));
  if (!mg.length || !fm.deadline) return '';
  return `<div class="field" style="margin-top:14px"><span class="smallcaps">Цели в цифрах к этой дате</span>${mg.map(g => {
    const m = GL.metric(g.metric), r = GL.realism({ ...g, deadline: fm.deadline }, store.uid(), fm.goals);
    return `<p class="note" style="margin:4px 0 0"><b>${esc(m.label)}</b> ${GL.fmtNum(g.from, m)} → ${GL.fmtNum(g.to, m)} ${esc(m.unit)}: ${esc(r.text || '-')}</p>`;
  }).join('')}<p class="note" style="margin:4px 0 0">Оценка по статистике, без сервера.</p></div>`;
}

function deadlineBody(fm, tg) {
  const p = preview.data;
  const tl = tg?.timeline;
  const opts = tl?.options || [];
  const pv = preview.loading ? '<p class="note"><span class="spinner"></span> Оцениваю срок…</p>'
    : preview.error ? `<p class="note">${esc(preview.error)}</p>`
    : p ? `<div class="pf-verdict tl-${esc(p.label)}"><div class="pf-verdict-l">${esc(TL[p.label] || p.label || '')}</div>
        <div class="pf-verdict-n">${p.weeks != null ? `<span><b class="mono">${num(p.weeks)}</b> ${plural(p.weeks, 'неделя', 'недели', 'недель')}</span>` : ''}
        ${p.deficit_pct != null ? `<span><b class="mono">${p.deficit_pct > 0 ? '−' : p.deficit_pct < 0 ? '+' : ''}${Math.abs(Math.round(p.deficit_pct))} %</b> ${p.deficit_pct >= 0 ? 'дефицит' : 'профицит'} калорий</span>` : ''}
        ${p.sessions != null ? `<span><b class="mono">${p.sessions}</b> трен. в неделю</span>` : ''}
        ${p.kcal ? `<span><b class="mono">${num(p.kcal)}</b> ккал в день</span>` : ''}</div>
        <p class="note" style="margin:6px 0 0">${esc(verdictText(p.label))}</p></div>` : '';
  return `<p class="note" style="margin-top:0">Поставьте дату - тренер честно скажет, насколько это реально, и какой нужен дефицит и объём тренировок.</p>
    <div class="grid2">${field('Хочу к дате', `<input class="control" type="date" data-act="pf-deadline" value="${esc(fm.deadline)}" min="${C.addDays(C.today(), 7)}">`)}
      <div class="field"><span class="smallcaps">Темп</span><div class="pf-pace">
        <button class="btn" data-act="pf-pace" data-d="-1" ${fm.pace === 'slower' ? 'disabled' : ''}>Медленнее</button>
        <span class="mono">${esc(PACE[fm.pace] || fm.pace)}</span>
        <button class="btn" data-act="pf-pace" data-d="1" ${fm.pace === 'faster' ? 'disabled' : ''}>Быстрее</button></div></div></div>
    ${pv}
    ${metricDeadlineNote(fm)}
    ${opts.length ? `<div class="field" style="margin-top:14px"><span class="smallcaps">Варианты из последних норм</span><div class="pf-tl">
      ${opts.map(o => `<button class="raised pf-tl-o tl-${esc(o.label)}" data-act="pf-set-deadline" data-d="${esc(o.deadline || '')}">
        <b>${esc(TL[o.label] || o.label)}</b><span class="mono">${o.weeks ?? '-'} нед.</span><span class="note">${o.deadline ? esc(fmt(o.deadline, { day: 'numeric', month: 'short', year: 'numeric' })) : ''}${o.deficit_pct != null ? ` · дефицит ${Math.round(o.deficit_pct)} %` : ''}${o.sessions ? ` · ${o.sessions} трен./нед` : ''}</span></button>`).join('')}</div></div>` : ''}
    ${!fm.deadline && tl?.realistic_weeks ? `<div class="actions"><button class="btn" data-act="pf-set-deadline" data-d="${C.addDays(C.today(), tl.realistic_weeks * 7)}">Поставить реалистичный срок · ${tl.realistic_weeks} нед.</button></div>` : ''}
    ${fm.deadline ? `<div class="actions"><button class="btn quiet" data-act="pf-set-deadline" data-d="">Без срока</button></div>` : ''}
    <p class="note">Темп и срок применятся после сохранения и пересчёта норм.</p>`;
}
function verdictText(l) {
  return { comfortable: 'Спокойный темп: легко держать, мало риска сорваться.', moderate: 'Рабочий темп: потребует дисциплины, но реально.',
    aggressive: 'Жёстко: большой дефицит и много тренировок. Возможны срывы и усталость.',
    unrealistic: 'Так быстро без вреда для здоровья не получится. Лучше отодвинуть срок.' }[l] || '';
}
function plural(k, one, few, many) { const a = Math.abs(k) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; }

function healthBody(fm) {
  const inj = store.list('injury').sort((a, b) => (b.data.since || '').localeCompare(a.data.since || ''));
  const open = inj.filter(r => !r.data.resolved), closed = inj.filter(r => r.data.resolved).slice(0, 5);
  return `<div class="field"><span class="smallcaps">Ограничения по здоровью</span>${chips(F, 'limitations', fm.limitations, LIMITS, true)}</div>
    <div style="margin-top:12px">${field('Уточнение', input(F, 'limitations_note', fm.limitations_note, 'placeholder="например: правое колено после травмы, нельзя прыжки"'))}</div>
    <div class="grid2" style="margin-top:14px">
      ${field('Питание', select(F, 'diet', fm.diet, DIETS))}
      ${field('Аллергии и исключения', input(F, 'allergies', fm.allergies, 'placeholder="орехи, грибы…"'))}
    </div>
    <div class="grid2" style="margin-top:14px">
      ${field('Лекарства', textarea(F, 'medications', fm.medications, 'rows="2" placeholder="если влияют на аппетит, давление, пульс"'))}
      ${field('Дополнительно учесть', textarea(F, 'extra_notes', fm.extra_notes, 'rows="2" placeholder="всё, что тренеру стоит знать"'))}
    </div>
    <p class="note">Тренер - не врач и не заменяет его. При болях, давлении, беременности и хронических болезнях согласуйте нагрузки с врачом.</p>
    <div class="pf-sub smallcaps">Боли и травмы</div>
    ${open.length ? open.map(r => `<div class="pf-row"><div class="ell"><b>${esc(ZONE_NAME[r.data.zone] || r.data.zone)}</b>
        <span class="note"> · с ${esc(fmt(r.data.since || r.date || C.today(), { day: 'numeric', month: 'short' }))}${r.data.note ? ' · ' + esc(r.data.note) : ''}</span></div>
        <button class="btn" data-act="pf-inj-resolve" data-id="${r.id}">Прошло</button></div>`).join('')
      : '<p class="note">Сейчас ничего не болит. Пока травма открыта, упражнения на эту зону не попадают в план.</p>'}
    <div class="grid3 pf-inj-add">
      ${field('Что болит', select('inj', 'zone', 'knees', INJURY_ZONES))}
      ${field('Подробнее', input('inj', 'note', '', 'placeholder="тянет при приседе"'))}
      ${field('С какого дня', input('inj', 'since', C.today(), 'type="date"'))}
    </div>
    <div class="actions" style="margin-top:10px"><button class="btn" data-act="pf-inj-add">Добавить</button></div>
    ${closed.length ? `<p class="note">Прошло: ${closed.map(r => `${esc(ZONE_NAME[r.data.zone] || r.data.zone)} (${esc(fmt(r.data.resolved, { day: 'numeric', month: 'short' }))})`).join(', ')}</p>` : ''}`;
}

function cycleBody(fm) {
  return `<p class="note" style="margin-top:0">По желанию. Тренер не будет считать провалом задержку воды и скачки веса в конце цикла и смягчит нагрузку в тяжёлые дни.</p>
    ${chk('cycle_on', 'Учитывать цикл', fm.cycle_on)}
    ${fm.cycle_on ? `<div class="grid3" style="margin-top:12px">
      ${field('Начало последнего цикла', input(F, 'cycle_last', fm.cycle_last, 'type="date"'))}
      ${field('Длина цикла, дней', input(F, 'cycle_len', fm.cycle_len, 'type="number" inputmode="numeric" min="20" max="45"'))}
      ${field('Длительность, дней', input(F, 'cycle_period', fm.cycle_period, 'type="number" inputmode="numeric" min="2" max="10"'))}
    </div>` : ''}`;
}

function trainingBody(fm) {
  const own = fm.gym && fm.gym_program === 'own';
  return `${chk('gym', 'Хожу в зал', fm.gym)}
    ${fm.gym ? `<div class="field" style="margin-top:10px"><span class="smallcaps">Кто ведёт зал</span>${chips(F, 'gym_program', fm.gym_program, [['ai', 'Тренер составляет программу'], ['own', 'Своя программа или личный тренер']])}</div>
      <p class="note">${own ? 'Программу в зале строите сами или с личным тренером - здесь только записываете, что делали. Тренер приложения не предлагает упражнения в зале, но анализирует, советует по питанию и сну и собирает остальное: разминку, домашние комплексы, кардио.'
        : 'Тренер составит программу в зале по вашим целям, дням и инвентарю - ниже.'}</p>` : ''}
    <div class="field" style="margin-top:14px"><span class="smallcaps">Дни силовых</span>${chips(F, 'weekdays', fm.weekdays, WD.map((w, i) => [i, w]), true)}</div>
    <div class="grid2" style="margin-top:14px">
      ${field('Максимум тренировок в неделю', select(F, 'max_sessions_week', fm.max_sessions_week, [1, 2, 3, 4, 5, 6, 7].map(k => [k, String(k)])))}
      ${field('Сколько минут в день на тренировку', select(F, 'time_budget_min', fm.time_budget_min, [15, 20, 30, 45, 60, 75, 90, 120].map(k => [k, `${k} мин`])))}
    </div>
    <p class="note">Инвентарь дома и чего нет в зале - в разделе <a class="link" href="#profile" data-act="pf-open" data-sec="equipment">«Что есть дома»</a>.</p>
    <div class="field" style="margin-top:14px"><span class="smallcaps">Как входить в режим</span>${chips(F, 'start_mode', fm.start_mode, [['smooth', 'Плавно'], ['hard', 'Сразу']])}</div>
    <p class="note">${fm.start_mode === 'hard' ? 'Сразу полный объём и порог серии 80 %. Подходит, если вы уже тренировались.'
      : 'Плавно: первые три недели объём растёт с 60 до 100 %, а для серии хватает 50 → 80 % дня. Меньше риска бросить.'}</p>
    <details class="pf-inner" ${fm.sched_irregular || Object.values(fm.sched_days).some(d => d.busy || d.slot !== 'any') ? 'open' : ''}>
      <summary>Рабочий график</summary>
      ${chk('sched_irregular', 'График плавающий (смены)', fm.sched_irregular)}
      <p class="note">${fm.sched_irregular ? 'Тренер будет подстраиваться по дням и предлагать короткие тренировки, когда окно маленькое.' : 'Укажите занятые часы и удобное время - тренировки встанут в свободные окна.'}</p>
      <div class="pf-sched">${WD.map((w, i) => `<div class="pf-sched-r"><span class="smallcaps">${w}</span>
        <input class="control mono" data-act="pf-sched" data-d="${i}" data-k="busy" value="${esc(fm.sched_days[i].busy)}" placeholder="09:00-18:00" inputmode="numeric" aria-label="Занят ${w}">
        <select class="control" data-act="pf-sched" data-d="${i}" data-k="slot" aria-label="Удобно ${w}">${SLOTS.map(([k, l]) => `<option value="${k}" ${fm.sched_days[i].slot === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}</div>
    </details>
    <div class="actions">${own ? '<a class="btn quiet" href="#workout">Записанные тренировки <span class="arrow">→</span></a>' : '<a class="btn quiet" href="#program">Программа тренировок <span class="arrow">→</span></a>'}</div>`;
}

// ── «Что есть дома» и зал ──
function equipSummary(fm) {
  const n = fm.equipment.length, m = fm.gym ? fm.gym_missing.length : 0;
  return [n ? `дома: ${n}` : 'дома: без инвентаря', fm.gym ? (m ? `в зале нет: ${m}` : 'зал: всё есть') : ''].filter(Boolean).join(' · ');
}
function equipBody(fm) {
  const grp = ([title, codes]) => `<div class="field pf-eqg"><span class="smallcaps">${esc(title)}</span>${chips(F, 'equipment', fm.equipment, codes.map(c => [c, PF.equipLabel(c)]), true)}</div>`;
  return `<p class="note" style="margin-top:0">Отметьте, что есть дома: из этого тренер собирает домашние тренировки, разминки и кардио. Пол и стул считаются всегда.</p>
    ${PF.HOME_EQUIP_GROUPS.map(grp).join('')}
    ${fm.equipment.some(c => PF.CARDIO_MACHINES.includes(c)) ? '<p class="note">Кардиотренажёр дома - тренер будет предлагать кардио на нём, когда на улице холодно или некогда идти в зал.</p>' : ''}
    <div class="field pf-eqg" style="margin-top:16px"><span class="smallcaps">В зале нет</span>
      ${fm.gym ? `${chips(F, 'gym_missing', fm.gym_missing, PF.GYM_EQUIP.map(c => [c, PF.equipLabel(c)]), true)}
        <p class="note">Отмеченное уберу из зальных программ и замен. Новую программу лучше пересобрать.</p>`
        : '<p class="note">Если ходите в зал - включите «Хожу в зал» в разделе «Тренировки», и здесь можно отметить, каких тренажёров там нет.</p>'}</div>`;
}

// ── кардио ──
function cardioSummary(fm) {
  const t = (() => { try { return P.cardioTarget().minutes; } catch (e) { return null; } })();
  const likes = fm.cardio_likes.map(id => PF.cardioKind(id)?.name || id);
  return [t ? `${t} мин в неделю` : '', likes.length ? likes.slice(0, 3).join(', ') : ''].filter(Boolean).join(' · ') || 'не настроено';
}
function cardioBody(fm) {
  const kinds = PF.cardioKinds();
  const grp = (title, list) => list.length ? `<div class="field pf-eqg"><span class="smallcaps">${esc(title)}</span>${chips(F, 'cardio_likes', fm.cardio_likes, list.map(k => [k.id, k.name]), true)}</div>` : '';
  const machines = kinds.filter(k => k.eq && PF.CARDIO_MACHINES.includes(k.eq));
  const home = kinds.filter(k => !machines.includes(k) && k.places.includes('home'));
  const out = kinds.filter(k => !machines.includes(k) && !home.includes(k) && k.places.includes('outdoor') && !k.extra);
  const other = kinds.filter(k => !machines.includes(k) && !home.includes(k) && !out.includes(k));
  let t = null; try { t = P.cardioTarget(); } catch (e) { t = null; }
  const w = PF.weatherCached(), loc = fm.location;
  const res = cityState.results;
  return `<p class="note" style="margin-top:0">Кардио - отдельная часть плана${t ? `: <b class="mono">${t.minutes}</b> мин в неделю ${t.source === 'norms' ? 'по нормам' : 'по вашей цели'}` : ''}.
      Засчитываются кардио-активности и кардио в тренировках (лёгкая интенсивность - наполовину). На «Сегодня» тренер предложит, что и где сделать.</p>
    <div class="field pf-eqg"><span class="smallcaps">Где удобно</span>${chips(F, 'cardio_places', fm.cardio_places, [['gym', 'в зале'], ['home', 'дома'], ['outdoor', 'на улице']], true)}</div>
    <p class="smallcaps muted" style="margin:14px 0 0">Любимое кардио</p>
    ${grp('Тренажёры (в зале или дома)', machines)}${grp('Дома без тренажёра', home)}${grp('На улице', out)}
    ${other.length ? `<details class="pf-inner" ${fm.cardio_likes.some(id => other.some(k => k.id === id)) ? 'open' : ''}><summary>Ещё виды</summary>${grp('Секции и игры', other)}</details>` : ''}
    <div class="field pf-eqg" style="margin-top:16px"><span class="smallcaps">Город для погоды</span>
      ${loc ? `<div class="pf-city"><b>${esc(loc.city)}</b>${loc.region ? `<span class="note">${esc(loc.region)}</span>` : ''}<button type="button" class="btn quiet a-mini" data-act="pf-city-clear">Убрать</button></div>` : ''}
      <div class="pf-city-f"><input class="control" id="pf-city-q" placeholder="${loc ? 'другой город' : 'например: Москва'}" autocomplete="off" data-enter="pf-city-find" aria-label="Город">
        <button type="button" class="btn" data-act="pf-city-find" ${store.state.online ? '' : 'disabled'}>Найти</button></div>
      ${cityState.loading ? '<p class="note"><span class="spinner"></span> Ищу…</p>' : cityState.error ? `<p class="note">${esc(cityState.error)}</p>` : ''}
      ${res?.length ? `<div class="chips">${res.map((r, i) => `<button type="button" class="chip" data-act="pf-city-set" data-i="${i}">${esc(r.city)}${r.region ? `, ${esc(r.region)}` : ''}</button>`).join('')}</div>` : res ? '<p class="note">Не нашёл такой город.</p>' : ''}
      <p class="note">Погоду берёт сервер у Open-Meteo: туда уходят только координаты города, без имени и данных о вас.
        В холод, дождь и ветер тренер переносит кардио под крышу; без связи - последний прогноз или сезон.${w && loc ? ` Прогноз обновлён ${esc(fmt(C.ymd(new Date(w.saved_at)), { day: 'numeric', month: 'short' }))}.` : ''}${!store.state.online ? ' Поиск города - когда сервер на связи.' : ''}</p></div>`;
}
const cityState = { loading: false, error: '', results: null };

function activitiesBody(fm) {
  const rows = fm.activities.map((a, i) => `<div class="pf-act">
    <div class="pf-act-h"><b class="ell">${esc(actName(a))}</b><button class="btn danger" data-act="pf-act-del" data-i="${i}">Убрать</button></div>
    <div class="pf-act-g">
      <label class="pf-inline"><span class="smallcaps muted">раз в неделю</span>
        <select class="control" data-act="pf-act" data-i="${i}" data-k="per_week">${[1, 2, 3, 4, 5, 6, 7].map(k => `<option value="${k}" ${Number(a.per_week) === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label class="pf-inline"><span class="smallcaps muted">минут</span>
        <input class="control pf-num" type="number" inputmode="numeric" min="5" step="5" value="${esc(a.minutes ?? '')}" data-act="pf-act" data-i="${i}" data-k="minutes"></label>
      <label class="pf-inline"><span class="smallcaps muted">интенсивность</span>
        <select class="control" data-act="pf-act" data-i="${i}" data-k="intensity">${INTENSITY.map(([k, l]) => `<option value="${k}" ${a.intensity === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="chips pf-wd"><span class="smallcaps muted">дни (необязательно)</span>${WD.map((w, d) => `<button type="button" class="chip ${(a.weekdays || []).includes(d) ? 'on' : ''}" data-act="pf-act-wd" data-i="${i}" data-d="${d}">${w}</button>`).join('')}</div>
  </div>`).join('');
  const noCat = !S.activities.size;
  return `<p class="note" style="margin-top:0">Всё, чем вы регулярно занимаетесь помимо силовых: велосипед, бассейн, танцы, массаж… План учтёт нагрузку и восстановление.</p>
    ${rows || ''}
    <div class="field pf-act-add"><span class="smallcaps">Добавить активность</span>
      <input class="control" id="pf-act-q" placeholder="${noCat ? 'название, например: бассейн' : 'начните вводить: вел, бассейн, танцы…'}" autocomplete="off">
      <div id="pf-act-sugg" class="chips"></div></div>
    ${noCat ? '<p class="note">Справочник активностей ещё не загружен с сервера - можно добавить своими словами.</p>' : ''}`;
}

function renderActSuggest(q) {
  const box = document.getElementById('pf-act-sugg');
  if (!box) return;
  q = q.trim().toLowerCase();
  if (!q) { box.innerHTML = ''; return; }
  const found = [...S.activities.values()].filter(a => a.name.toLowerCase().includes(q) || (a.aliases || []).some(x => x.toLowerCase().includes(q)))
    .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 8);
  box.innerHTML = found.map(a => `<button type="button" class="chip" data-act="pf-act-add" data-type="${esc(a.id)}">+ ${esc(a.name)}</button>`).join('')
    + (!found.length ? `<button type="button" class="chip" data-act="pf-act-add" data-custom="${esc(q)}">+ «${esc(q)}» своими словами</button>` : '');
}

function modulesBody(fm) {
  return `<div class="pf-mod"><div>${chk('mod_home_on', '<b>Домашние комплексы под цели</b>', fm.mod_home_on)}
      <p class="note">Тренер ставит в дни без зала комплексы на зоны из ваших целей (например, руки или пресс) и добирает тренировки до нормы. Пропущенное переносит на другие дни недели.</p></div></div>
    <div class="pf-mod"><div>${chk('mod_morning_on', '<b>Утренняя разминка</b>', fm.mod_morning_on)}
      <p class="note">Каждый день новая, из упражнений для дома, под выбранное время.</p>
      ${fm.mod_morning_on && store.partners().length ? `<p class="note">Делать разминку и другие комплексы вместе с ${esc(C.nameForms(store.partners()[0].id).ins || store.partners()[0].name)} - в разделе «Прогресс вместе» → «Общие комплексы».</p>` : ''}</div>
      ${fm.mod_morning_on ? `<div class="pf-mod-o">${chips(F, 'mod_morning_min', fm.mod_morning_min, [5, 10, 15, 20].map(k => [k, `${k} мин`]))}
        ${chips(F, 'mod_morning_gear', fm.mod_morning_gear, [['any', 'любой инвентарь'], ['mat', 'только коврик'], ['none', 'без коврика и инвентаря']])}</div>` : ''}</div>
    <div class="pf-mod"><div>${chk('mod_neck_on', '<b>Шея и скулы</b>', fm.mod_neck_on)}
      <p class="note">Тонус шеи и осанка. Честно: второй подбородок уходит только вместе с общим жиром.</p></div>
      ${fm.mod_neck_on ? `<div class="pf-mod-o">${select(F, 'mod_neck_week', fm.mod_neck_week, [1, 2, 3, 4, 5, 6, 7].map(k => [k, `${k} ${plural(k, 'раз', 'раза', 'раз')} в неделю`]), 'aria-label="Шея и скулы: сколько раз в неделю"')}
        ${chips(F, 'mod_neck_min', fm.mod_neck_min, [5, 10].map(k => [k, `${k} мин`]))}</div>` : ''}</div>
    <div class="pf-mod"><div>${chk('mod_posture_on', '<b>Осанка</b>', fm.mod_posture_on)}
      <p class="note">Спина, плечи, грудной отдел - против «сидячей» сутулости.</p></div>
      ${fm.mod_posture_on ? `<div class="pf-mod-o">${select(F, 'mod_posture_week', fm.mod_posture_week, [1, 2, 3, 4, 5, 6, 7].map(k => [k, `${k} ${plural(k, 'раз', 'раза', 'раз')} в неделю`]), 'aria-label="Осанка: сколько раз в неделю"')}
        ${chips(F, 'mod_posture_min', fm.mod_posture_min, [5, 10, 15].map(k => [k, `${k} мин`]))}</div>` : ''}</div>`;
}

function foodBody(fm) {
  return `${chk('ew_on', 'Есть в окне (интервальное питание)', fm.ew_on)}
    ${fm.ew_on ? `<div class="grid3" style="margin-top:12px">${field('С', input(F, 'ew_from', fm.ew_from, 'type="time"'))}${field('До', input(F, 'ew_to', fm.ew_to, 'type="time"'))}</div>
      <p class="note">Приёмы пищи вне окна тренер отметит - без упрёков, просто для статистики.</p>` : ''}
    <div class="grid3" style="margin-top:12px">${field('Объём стакана, мл', input(F, 'glass_ml', fm.glass_ml, 'type="number" inputmode="numeric" min="100" max="600"'))}</div>
    <div class="field" style="margin-top:14px"><span class="smallcaps">Молоко в кофе</span>
      ${chips(F, 'milk_mode', fm.milk_mode, [['meal', 'Показывать в приёмах пищи'], ['hidden', 'Только в итогах дня']])}
      <p class="note">${fm.milk_mode === 'hidden'
        ? 'Молоко считается в калориях и БЖУ дня, но в приёмах пищи его нет - оно видно у счётчика кофе на «Сегодня» и одной строкой под приёмами пищи.'
        : 'Молоко - отдельной строкой в приёме пищи. У каждой чашки с молоком можно выбрать, к какому приёму её отнести; без выбора - по времени чашки.'}</p></div>`;
}

function remindersBody(fm) {
  return `<p class="note" style="margin-top:0">Напоминания приходят сообщением тренера в чате и на «Сегодня», когда вы открываете приложение после заданного времени. Push-уведомлений нет.</p>
    ${fm.reminders.map((r, i) => `<div class="pf-rem">
      <select class="control" data-act="pf-rem" data-i="${i}" data-k="kind" aria-label="Что">${REMINDERS.map(([k, l]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="control mono" type="time" value="${esc(r.time || '')}" data-act="pf-rem" data-i="${i}" data-k="time" aria-label="Время">
      <label class="chk"><input type="checkbox" data-act="pf-rem" data-i="${i}" data-k="enabled" ${r.enabled ? 'checked' : ''}>вкл.</label>
      <button class="btn danger" data-act="pf-rem-del" data-i="${i}" aria-label="Удалить">${glyph('cross')}</button></div>`).join('') || '<p class="note">Напоминаний нет.</p>'}
    <div class="actions" style="margin-top:10px"><button class="btn" data-act="pf-rem-add">Добавить напоминание</button>
      ${!fm.reminders.length ? '<button class="btn quiet" data-act="pf-rem-defaults">Типовой набор</button>' : ''}</div>`;
}

function toneBody(fm) {
  return ['soft', 'coach', 'sergeant'].map(t => `<label class="tone-opt"><input type="radio" name="tone" data-form="${F}" data-key="tone" value="${t}" ${fm.tone === t ? 'checked' : ''}>
    <b>${C.TONE_NAMES[t]}</b><span class="note">«${TONE_SAMPLE[t]}»</span></label>`).join('');
}

// Режим ИИ: включена - по кнопкам, а комментарий к нормам обновляется сам; выключена - модель не вызывается вовсе
function aiBody(fm) {
  const opt = (v, t, d) => `<label class="tone-opt"><input type="radio" name="ai" data-form="${F}" data-key="ai" value="${v}" ${fm.ai === v ? 'checked' : ''}>
    <b>${t}</b><span class="note">${d}</span></label>`;
  return opt('on', 'Включена', 'Чат, разбор недели, рецепты, программы - по вашим кнопкам. Комментарий тренера к нормам обновляется сам после каждого пересчёта. Если модель на сервере не запущена, запросы подождут в очереди.')
    + opt('off', 'Выключена', 'Модель для вас не вызывается совсем. Работает всё основное: нормы по формулам, еда по справочнику и памяти тренера, план, анализ, быстрые кнопки чата.')
    + '<p class="note">ИИ локальная: работает на компьютере-сервере, данные никуда не уходят.</p>';
}

function latestTarget() {
  return store.list('target').sort((a, b) => (a.data.valid_from || '').localeCompare(b.data.valid_from || '') || a.updated_at - b.updated_at).pop() || null;
}

// цель «Вода» в «Целях» важнее расчётной нормы: в чек-листе стоит она (coach.itemTarget)
const waterGoal = () => (goal()?.goals || []).find(g => g.type === 'metric' && g.metric === 'water_avg' && Number(g.to) > 0)?.to || null;
function normsBody(tgRec) {
  const tg = tgRec?.data;
  const job = tgRec ? jobFor(tgRec.id) : null;
  const it = tg?.intensity;
  const tl = tg?.timeline;
  return `${tg ? `<p class="note" style="margin-top:0">Посчитаны ${esc(fmt(tg.valid_from || C.today(), { day: 'numeric', month: 'long' }))}${tg.weight ? ` при весе ${String(tg.weight).replace('.', ',')} кг` : ''}.</p>
      <div class="norms">
        <div><b>${num(tg.kcal)}</b><span>ккал в день</span></div>
        <div><b>${tg.p} / ${tg.f} / ${tg.c}</b><span>белки / жиры / углеводы, г${tg.macros_manual ? ' (свои)' : ''}</span></div>
        ${tg.fiber ? `<div><b>${tg.fiber}</b><span>клетчатка, г</span></div>` : ''}
        <div><b>${tg.water_glasses ?? '-'}${tg.water_glasses_gym && tg.water_glasses_gym !== tg.water_glasses ? '–' + tg.water_glasses_gym : ''}</b><span>стаканов воды${tg.water_ml ? ` (${num(tg.water_ml)} мл)` : ''}${waterGoal() ? ` · в чек-листе ${waterGoal()} - ваша цель` : ''}</span></div>
        <div><b>${num(tg.steps_manual || tg.steps)}</b><span>шагов${tg.steps_manual ? ' (своя цель)' : ''}</span></div>
        ${tg.sleep_hours ? `<div><b>${String(tg.sleep_hours).replace('.', ',')}</b><span>часов сна</span></div>` : ''}
        ${tg.tdee ? `<div><b>${num(tg.tdee)}</b><span>расход, ккал</span></div>` : ''}
        ${(tl?.realistic_weeks ?? tg.weeks_needed) ? `<div><b>${tl?.realistic_weeks ?? tg.weeks_needed}</b><span>недель до цели - реалистично</span></div>` : ''}
      </div>
      ${it ? `<p class="small">Нагрузка: ${it.weekly_sessions ?? '-'} трен. в неделю, ${it.weekly_minutes ?? '-'} мин${it.cardio_minutes ? `, из них кардио ${it.cardio_minutes} мин` : ''}${it.deficit_pct ? ` · дефицит ${Math.round(it.deficit_pct)} %` : ''}.</p>` : ''}
      ${tl?.options?.length ? `<p class="small">Сроки: ${tl.options.map(o => `${esc(TL[o.label] || o.label)} - ${o.weeks} нед.`).join(' · ')}</p>` : ''}
      ${(tg.warnings || []).map(w => `<div class="notice">${esc(w)}</div>`).join('')}
      ${job ? (job.waiting ? `<p class="note">${glyph('moon')} Комментарий тренера напишется, когда проснётся ИИ на сервере</p>` : '<p class="note"><span class="spinner"></span> Тренер пишет комментарий…</p>') : ''}
      ${tg.source === 'local' ? `<p class="note">${esc(tg.note || 'Ориентировочно, рассчитано на этом устройстве - точнее с сервером.')}</p>` : ''}
      ${tg.explanation ? `<div class="coach inset info"><div class="who smallcaps">Комментарий тренера</div><p style="margin:0">${esc(tg.explanation)}</p>
        ${tg.tips?.length ? `<ul>${tg.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      <div class="pf-steps pf-macros"><span class="smallcaps muted">свои БЖУ, г</span>
        ${[['p', 'белки'], ['f', 'жиры'], ['c', 'углеводы']].map(([k, l]) => `<label class="pf-inline"><span class="note">${l}</span>
          <input class="control pf-num" type="number" inputmode="numeric" step="5" min="0" placeholder="${num(tg.formula?.[k] ?? tg[k])}" value="${esc(tg.macros_manual?.[k] ?? '')}" data-act="pf-macro" data-k="${k}" data-id="${tgRec.id}" aria-label="Своя норма: ${l}"></label>`).join('')}
        <span class="note">${tg.macros_manual ? `по формуле было ${num(tg.formula?.kcal)} ккал, ${tg.formula?.p} / ${tg.formula?.f} / ${tg.formula?.c} г; пусто - вернуть расчёт` : 'пусто - по формуле; калории пересчитаются сами'}</span></div>
      ${(tg.manual_warnings || []).map(w => `<div class="notice">${esc(w)}</div>`).join('')}
      <div class="pf-steps"><label class="pf-inline"><span class="smallcaps muted">своя цель шагов</span>
        <input class="control pf-num" type="number" inputmode="numeric" step="500" min="1000" placeholder="${num(tg.steps)}" value="${esc(tg.steps_manual || '')}" data-act="pf-steps" data-id="${tgRec.id}"></label>
        <span class="note">пусто - по формуле</span></div>`
    : '<p class="note" style="margin-top:0">Нормы ещё не считались. Заполните параметры и цели, сохраните и нажмите «Пересчитать».</p>'}
    <div class="actions"><button class="btn" data-act="norms">Пересчитать нормы</button><span class="note">${profile().ai === 'off' ? 'по формулам; комментарий тренера - при включённой ИИ' : 'формулы + комментарий локальной ИИ'}</span></div>`;
}

function checklistBody() {
  const allItems = store.list('item').filter(i => !i.data.migrated).sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
  const morningEx = [...S.exMap.values()].filter(e => e.morning).sort((a, b) => a.name.localeCompare(b.name));
  return `${allItems.map(it => `<div class="item-row ${it.data.active === false ? 'off' : ''}"><span class="ell">${esc(it.data.title)}
      <span class="note"> · ${{ bool: 'галочка', counter: 'счётчик', number: 'число', workout: 'тренировка', food: 'питание' }[it.data.type] || ''}${it.data.group === 'morning' ? ', зарядка' : ''}</span></span>
      <button class="btn quiet" data-act="item-toggle" data-id="${it.id}">${it.data.active === false ? 'Включить' : 'Выключить'}</button>
      <button class="btn danger" data-act="item-del" data-id="${it.id}">Удалить</button></div>`).join('') || '<p class="note">Пунктов пока нет.</p>'}
    <div class="grid3" style="margin-top:14px">
      ${field('Новый пункт', input('item', 'title', '', 'placeholder="например: 10 минут растяжки"'))}
      ${field('Тип', select('item', 'type', 'bool', [['bool', 'Галочка'], ['counter', 'Счётчик'], ['number', 'Число']]))}
      ${field('Цель (для счётчика/числа)', input('item', 'target', '', 'type="number" inputmode="numeric"'))}
      ${field('Группа', select('item', 'group', 'day', [['morning', 'Зарядка'], ['day', 'В течение дня']]))}
    </div>
    <div class="actions"><button class="btn" data-act="item-add">Добавить пункт</button></div>
    ${morningEx.length ? `<div class="grid2" style="margin-top:14px">${field('Упражнение в утреннюю разминку', select('item', 'ex', morningEx[0].id, morningEx.map(e => [e.id, e.name])))}</div>
      <div class="actions"><button class="btn quiet" data-act="tech" data-ex-from-form="1">Техника</button><button class="btn" data-act="item-add-ex">Делать каждый день</button></div>` : ''}`;
}

// ── группы (item 15): создаёт и правит только админ; у остальных - только вид своей группы и переключатель ──
function groupSummary() {
  const gs = store.groups();
  return gs.length ? gs.map(g => g.name).join(', ') : store.isAdmin() ? 'групп ещё нет' : 'вы не в группе';
}
const adminGroups = { loading: false, users: null, groups: null };
async function loadAdminGroups() {
  if (adminGroups.loading) return;
  adminGroups.loading = true;
  try {
    const [u, g] = await Promise.all([store.api('/api/admin/users'), store.api('/api/admin/groups')]);
    adminGroups.users = u.users; adminGroups.groups = g.groups;
  } catch (e) { toast(e.message || 'Не удалось загрузить группы', 5000); }
  adminGroups.loading = false;
  S.render();
}
function groupBody(fm) {
  const gs = store.groups();
  const mine = `${gs.length ? `<div class="chips">${gs.map(g => `<span class="chip">${esc(g.name)} · ${g.members.map(m => esc(m.name)).join(', ')}</span>`).join('')}</div>`
    : '<p class="note" style="margin-top:0">Вы не состоите ни в одной группе - её создаёт админ.</p>'}
    ${gs.length ? '<p class="note">Что видят участники группы - в разделе «Прогресс вместе» выше: переключатель «Показывать в ленте».</p>' : ''}`;
  if (!store.isAdmin()) return mine;
  if (!adminGroups.users && !adminGroups.loading) loadAdminGroups();
  const editing = S.forms.grp || null;
  const userOpt = uid => adminGroups.users?.find(u => u.id === uid)?.name || uid;
  return `${mine}<div class="pf-sub smallcaps" style="margin-top:16px">Управление группами (админ)</div>
    ${adminGroups.loading && !adminGroups.groups ? '<p class="note">Загрузка…</p>' : `
    ${(adminGroups.groups || []).map(g => `<div class="raised card" style="margin-top:8px"><div class="ell"><b>${esc(g.name)}</b>
      <div class="note">${(g.member_ids || []).map(userOpt).map(esc).join(', ') || 'без участников'}</div></div>
      <div class="a-row-btns"><button class="btn quiet a-mini" data-act="grp-edit" data-id="${esc(g.id)}">Изменить</button>
      <button class="btn quiet a-mini" data-act="grp-del" data-id="${esc(g.id)}">Удалить</button></div></div>`).join('')}
    <div class="raised card" style="margin-top:8px">
      <label class="field"><span class="smallcaps">${editing ? 'Изменить группу' : 'Новая группа'}</span>
        <input class="control" data-form="grp" data-key="name" value="${esc(editing?.name || '')}" placeholder="Название группы"></label>
      <div class="field" style="margin-top:8px"><span class="smallcaps">Участники</span>
        <div class="chips">${(adminGroups.users || []).map(u => `<button type="button" class="chip ${(editing?.member_ids || []).includes(u.id) ? 'on' : ''}" data-act="grp-member" data-id="${esc(u.id)}">${esc(u.name)}</button>`).join('')}</div></div>
      <div class="actions" style="margin-top:10px"><button class="btn solid" data-act="grp-save">${editing ? 'Сохранить' : 'Создать'}</button>${editing ? '<button class="btn quiet" data-act="grp-cancel">Отмена</button>' : ''}</div>
    </div>`}`;
}

function iphoneBody() {
  const base = serverConfig?.lan_host_url || serverConfig?.all_urls?.[0] || location.origin;
  const tok = health.loading ? '<span class="note"><span class="spinner"></span> Загружаю…</span>'
    : health.error ? `<span class="note">${esc(health.error)}</span>`
    : health.token ? `<code class="pf-token mono" id="pf-token">${esc(health.token)}</code>` : '<span class="note">-</span>';
  return `<p class="note" style="margin-top:0">Браузер не может читать «Здоровье» напрямую - это ограничение iOS. Данные передаёт команда из приложения «Команды»: раз в день она отправляет шаги, сон, вес и тренировки на сервер Тренера.</p>
    <div class="field"><span class="smallcaps">Ваш личный токен</span><div class="pf-token-row">${tok}
      ${health.token ? '<button class="btn" data-act="pf-token-copy">Копировать</button>' : ''}
      <button class="btn quiet" data-act="pf-token-new">${health.token ? 'Выпустить новый' : 'Получить'}</button></div></div>
    <ol class="pf-steps-list small">
      <li>Откройте «Команды» → «+» → назовите команду «Тренер - Здоровье».</li>
      <li>Добавьте «Найти образцы Здоровья» для шагов (сегодня, сумма), веса (последний), анализа сна (прошлая ночь) и активной энергии.</li>
      <li>Добавьте «Словарь» с ключами <span class="mono">date</span>, <span class="mono">steps</span>, <span class="mono">weight</span>, <span class="mono">active_kcal</span>, <span class="mono">sleep</span> (<span class="mono">bed</span>, <span class="mono">wake</span>).</li>
      <li>«Получить содержимое URL»: адрес <span class="mono pf-url">${esc(base)}/api/health/import</span>, метод POST, заголовок <span class="mono">X-Trainer-Token</span> = токен выше, тело запроса - JSON из словаря.</li>
      <li>Вкладка «Автоматизация» → «Время суток», например 23:00 → запустить команду, «Не спрашивать».</li>
    </ol>
    <p class="note">Каждый настраивает команду на своём iPhone со своим токеном. Новый токен отключает старый.</p>
    <div class="actions"><a class="btn" href="#health">Пошаговая инструкция <span class="arrow">→</span></a></div>`;
}

function themeSwitch() {
  return `<div class="theme-switch" role="group" aria-label="Тема"><button data-theme-set="auto" title="Как в системе">Авто</button><button data-theme-set="dark" aria-label="Тёмная тема" title="Тёмная тема">${glyph('night')}</button><button data-theme-set="light" aria-label="Светлая тема" title="Светлая тема">${glyph('sun')}</button></div>`;
}

function appBody() {
  return `${themeSwitch()}
    <p class="small" id="server-info"><span class="note">Адрес для телефона…</span></p>
    <p class="note">На iPhone: откройте адрес в Safari → скачайте <a class="link" href="/ca.crt">сертификат</a> → Настройки → «Профиль загружен» → Установить → Основные → Об этом устройстве → Доверие сертификатам → включить «Trainer local CA». Потом «Поделиться → На экран „Домой“».</p>
    <p class="small"><a class="link" href="#connect">Адреса сервера и доступ из интернета →</a></p>
    <p class="small"><a class="link" href="#install">Установить на iPhone и iPad: сертификат и экран «Домой» →</a></p>
    <p class="small"><a class="link" href="#about">Как это работает: что без сети, что с сервером →</a></p>
    <div class="actions"><button class="btn quiet" data-act="sync-now">Синхронизировать</button><button class="btn quiet" data-act="pf-export">Скачать мои данные</button>
      <button class="btn danger" data-act="logout">Выйти</button></div>`;
}

// ── сеть: оценка срока, токен, адреса ──
function maybePreview() {
  const fm = form();
  if (!fm.deadline) { preview.key = ''; preview.data = null; preview.error = ''; return; }
  const key = fm.deadline + '|' + fm.pace + '|' + JSON.stringify(fm.goals);
  if (key === preview.key) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    preview.key = key; preview.loading = true; preview.error = ''; S.render();
    try {
      preview.data = await store.api('/api/norms/preview', { deadline: fm.deadline, pace: fm.pace, goal: buildGoal(fm) });
    } catch (e) {
      preview.data = null;
      preview.error = e.status === 404 ? 'Оценка срока появится после обновления сервера.' : e.status === 400 ? e.message : apiMsg(e, 'Оценка срока');
    }
    preview.loading = false; S.render();
  }, 450);
}

async function loadToken(renew = false) {
  health.loading = true; health.error = ''; S.render();
  try {
    const r = await store.api('/api/health/token', renew ? {} : undefined);
    health.token = r.token || null;
  } catch (e) { health.error = apiMsg(e, 'Токен'); }
  health.loading = false; S.render();
}

export async function fillServerInfo() {
  const show = () => {
    const el = document.getElementById('server-info');
    if (!el) return;
    const urls = serverConfig ? [...new Set([serverConfig.lan_host_url, ...(serverConfig.all_urls || [])].filter(Boolean))] : [];
    el.innerHTML = urls.length ? urls.map(u => `<span class="mono">${esc(u)}</span>`).join('<br>') : '<span class="note">Сервер недоступен</span>';
  };
  if (serverConfig) return show();
  // без сети не спрашиваем, и не чаще раза в 30 с: неудачный запрос меняет состояние связи → перерисовка →
  // снова afterRender → снова запрос (без этого офлайн экран профиля перерисовывался десятки раз в секунду)
  if (!store.state.online || Date.now() - configTried < 30000) return show();
  configTried = Date.now();
  try { serverConfig = await store.api('/api/config'); S.render(); } catch (e) { /* офлайн */ }
  show();
}

// ── сохранение ──
function buildProfile(fm) {
  const cur = profile();
  const weekdays = [...fm.weekdays].map(Number).sort();
  const weight = n(fm.weight);
  const days = {};
  for (let i = 0; i < 7; i++) days[i] = { busy: (fm.sched_days[i].busy || '').replace(/\s/g, ''), slot: fm.sched_days[i].slot || 'any' };
  const data = {
    ...cur,
    name: (fm.name || '').trim() || cur.name || store.me()?.name || '', sex: fm.sex || null, birth: fm.birth || null, height: n(fm.height), weight,
    activity: fm.activity || 'light',
    body_type: fm.body_type || null, patterns: (fm.patterns || '').trim(),
    limitations: [...fm.limitations], limitations_note: (fm.limitations_note || '').trim(), diet: fm.diet || 'normal',
    allergies: (fm.allergies || '').trim(), medications: (fm.medications || '').trim(), extra_notes: (fm.extra_notes || '').trim(),
    gym: !!fm.gym, gym_program: fm.gym === true && fm.gym_program === 'own' ? 'own' : 'ai', weekdays, gym_days: weekdays.length, equipment: [...fm.equipment],
    gym_equipment: { ...(cur.gym_equipment || {}), missing: [...(fm.gym_missing || [])] },
    cardio: { ...(cur.cardio || {}), likes: [...(fm.cardio_likes || [])], places: [...(fm.cardio_places || [])] },
    location: fm.location ? { city: fm.location.city, region: fm.location.region || '', lat: fm.location.lat, lon: fm.location.lon } : null,
    time_budget_min: n(fm.time_budget_min) || 60, max_sessions_week: n(fm.max_sessions_week) || weekdays.length || 3,
    schedule: { irregular: !!fm.sched_irregular, days },
    start_mode: fm.start_mode || 'smooth',
    start_date: cur.start_date && cur.start_mode === (fm.start_mode || 'smooth') ? cur.start_date : C.today(),
    activities: fm.activities.map(a => ({ ...a, per_week: n(a.per_week) || 1, minutes: n(a.minutes) || 45, intensity: a.intensity || 'mid' })),
    modules: {
      ...(cur.modules || {}),
      home_plan: { ...(cur.modules?.home_plan || {}), enabled: !!fm.mod_home_on },
      // ...cur: закреплённые упражнения разминки (pinned) правятся не в форме — не теряем их при сохранении
      morning: { ...(cur.modules?.morning || {}), enabled: !!fm.mod_morning_on, minutes: n(fm.mod_morning_min) || 10, gear: fm.mod_morning_gear || 'any' },
      neck: { ...(cur.modules?.neck || {}), enabled: !!fm.mod_neck_on, per_week: n(fm.mod_neck_week) || 3, minutes: n(fm.mod_neck_min) || 5 },
      posture: { ...(cur.modules?.posture || {}), enabled: !!fm.mod_posture_on, per_week: n(fm.mod_posture_week) || 3, minutes: n(fm.mod_posture_min) || 10 },
    },
    eating_window: { enabled: !!fm.ew_on, from: fm.ew_from || '10:00', to: fm.ew_to || '20:00' },
    reminders: fm.reminders.map(r => ({ kind: r.kind, time: r.time || '09:00', enabled: !!r.enabled })),
    pace: fm.pace || 'normal', tone: fm.tone || 'coach', glass_ml: n(fm.glass_ml) || 250, milk_mode: fm.milk_mode === 'hidden' ? 'hidden' : 'meal',
    ai: fm.ai === 'off' ? 'off' : 'on',
    share_activity: fm.share_activity !== false,
    share_meals: !!fm.share_meals,
    share_training: !!fm.share_training,
  };
  if (fm.sex === 'f') data.cycle = { enabled: !!fm.cycle_on, last_start: fm.cycle_last || null, length: n(fm.cycle_len) || 28, period: n(fm.cycle_period) || 5 };
  data.setup_done = !!(data.sex && data.birth && data.height && weight);
  return { profile: data, weight };
}

function buildGoal(fm) {
  const goals = fm.goals.map(g => {
    if (g.type === 'metric') return { type: 'metric', metric: g.metric, from: n(g.from), to: n(g.to), unit: GL.metric(g.metric)?.unit || g.unit || '',
      deadline: g.deadline || null, priority: Number(g.priority) || 2, since: g.since || C.today() };
    const o = { type: g.type, priority: Number(g.priority) || 2 };
    if (GOAL_KG.has(g.type)) o.amount = n(g.amount) || 0;
    if (g.type === 'gain_muscle') o.zones = [...(g.zones || [])];
    return o;
  });
  const fat = goals.find(g => g.type === 'lose_fat')?.amount || 0;
  const mg = goals.find(g => g.type === 'gain_muscle');
  let up = 0, low = 0;
  if (mg?.amount) {
    const zs = mg.zones || [];
    const u = zs.filter(z => ['chest', 'shoulders', 'arms', 'back'].includes(z)).length, l = zs.filter(z => ['glutes', 'legs'].includes(z)).length;
    const share = u + l ? u / (u + l) : 0.6;
    up = Math.round(mg.amount * share * 2) / 2; low = Math.round((mg.amount - up) * 2) / 2;
  }
  return { goals, habits: [...fm.habits], smoking_types: [...(fm.smoking_types || [])], deadline: fm.deadline || null,
    text: (fm.goal_text || '').trim(), fat_kg: fat, muscle_upper_kg: up, muscle_lower_kg: low };
}

const actKey = list => JSON.stringify((list || []).map(a => [a.type, Number(a.per_week) || 1, Number(a.minutes) || 0, a.intensity || 'mid', [...(a.weekdays || [])].sort()]));

async function saveProfile(notify) {
  const fm = S.forms[F];
  if (!fm) return;
  const uid = store.uid();
  const cur = profile();
  const { profile: data, weight } = buildProfile(fm);
  const wasSetup = cur.setup_done;
  const actsChanged = actKey(cur.activities) !== actKey(data.activities);
  const locChanged = JSON.stringify(cur.location || null) !== JSON.stringify(data.location || null);
  await store.put('profile', `profile:${uid}`, data);
  if (locChanged && data.location) PF.loadWeather({ force: true }).then(() => S.render());
  await store.put('goal', `goal:${uid}`, buildGoal(fm));
  const last = C.weights().slice(-1)[0];
  if (weight && (!last || last.w !== weight)) {
    const d = C.today();
    await store.put('body', `body:${uid}:${d}`, { ...(store.get(`body:${uid}:${d}`)?.data || {}), weight }, d);
  }
  delete S.forms[F];
  clearTimeout(draftTimer);
  await store.setMeta('draft_profile', null);
  if (notify) {
    if (actsChanged && wasSetup) offerRebuild();
    else if (!wasSetup && data.setup_done && !store.list('target').length) offerNorms();
    else toast('Сохранено', 3500);
  }
  await afterChange(C.today());
  return { actsChanged };
}

// первое сохранение заполненного профиля: следующий шаг — нормы, сразу отсюда
function offerNorms() {
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Профиль сохранён</div><h2>Посчитать нормы?</h2></div>
    <div class="modal-body"><p>По росту, весу, возрасту, активности и целям тренер посчитает калории, белок, воду, шаги и сон.
      Это секунда; комментарий локальной ИИ придёт следом. Пересчитать можно в любой момент: «Профиль» → «Нормы».</p></div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Позже</button><button class="btn solid" data-act="pf-first-norms">Посчитать нормы</button></div>`);
}

function offerRebuild() {
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Активности изменились</div><h2>Пересобрать план?</h2></div>
    <div class="modal-body"><p>Тренер учтёт новые активности: где-то снизит объём силовых, где-то добавит восстановление. Прошедшие тренировки не трогаются.</p></div>
    <div class="modal-foot"><button class="btn quiet" data-act="close">Не сейчас</button><button class="btn" data-act="pf-rebuild">Пересобрать план</button></div>`);
}

// ── действия ──
const goalOf = t => form().goals.find(g => gkey(g) === t);
const mGoalOf = id => form().goals.find(g => g.type === 'metric' && g.metric === id);

export const actions = {
  'prof-save': () => saveProfile(true),
  // группы (item 15) - создаёт и правит только админ (сервер тоже проверяет)
  'grp-edit': el => { const g = adminGroups.groups?.find(x => x.id === el.dataset.id); if (g) { S.forms.grp = { id: g.id, name: g.name, member_ids: [...(g.member_ids || [])] }; S.render(); } },
  'grp-cancel': () => { delete S.forms.grp; S.render(); },
  'grp-member': el => {
    const f = (S.forms.grp ||= { name: '', member_ids: [] });
    const id = el.dataset.id;
    f.member_ids = f.member_ids.includes(id) ? f.member_ids.filter(x => x !== id) : [...f.member_ids, id];
    S.render();
  },
  'grp-save': async () => {
    const f = S.forms.grp || { name: document.querySelector('[data-form=grp][data-key=name]')?.value, member_ids: [] };
    const name = (document.querySelector('[data-form=grp][data-key=name]')?.value || f.name || '').trim();
    if (!name) return toast('Название группы не может быть пустым');
    try {
      await store.api('/api/admin/groups', { name, member_ids: f.member_ids || [], id: f.id });
      delete S.forms.grp;
      adminGroups.groups = null;
      toast('Группа сохранена');
      await loadAdminGroups();
    } catch (e) { toast(e.message || 'Ошибка', 5000); }
  },
  'grp-del': async el => {
    try { await store.api(`/api/admin/groups/${el.dataset.id}`, undefined, 'DELETE'); adminGroups.groups = null; await loadAdminGroups(); toast('Группа удалена'); }
    catch (e) { toast(e.message || 'Ошибка', 5000); }
  },
  'pf-open': el => { openSecs.add(el.dataset.sec); S.render(); setTimeout(() => document.getElementById(`sec-${el.dataset.sec}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60); },
  'pf-city-find': async () => {
    const q = (document.getElementById('pf-city-q')?.value || '').trim();
    if (q.length < 2) return toast('Введите название города');
    cityState.loading = true; cityState.error = ''; cityState.results = null; S.render();
    try { cityState.results = (await store.api(`/api/weather/geocode?q=${encodeURIComponent(q)}`)).results || []; }
    catch (e) { cityState.error = e.status === 409 ? 'Погода выключена на сервере (Данные и приватность).' : apiMsg(e, 'Поиск города'); }
    cityState.loading = false; S.render();
  },
  'pf-city-set': el => {
    const r = cityState.results?.[Number(el.dataset.i)];
    if (!r) return;
    form().location = { city: r.city, region: r.region || '', lat: r.lat, lon: r.lon };
    cityState.results = null;
    toast(`${r.city}: сохраните профиль - и прогноз появится на «Сегодня»`, 3500);
    S.render();
  },
  'pf-city-clear': () => { form().location = null; S.render(); },
  'pf-first-norms': async () => { closeModal(); await actions.norms(); if (store.list('target').length) location.hash = '#today'; },
  'pf-goal': el => {
    const fm = form(), t = el.dataset.t;
    if (fm.goals.some(g => g.type === t)) fm.goals = fm.goals.filter(g => g.type !== t);
    else {
      fm.goals.push({ type: t, priority: fm.goals.length ? 2 : 1, ...(GOAL_KG.has(t) ? { amount: '' } : {}), ...(t === 'gain_muscle' ? { zones: [] } : {}) });
      // взаимоисключающие цели
      const clash = { lose_fat: ['gain_weight'], gain_weight: ['lose_fat', 'maintain'], maintain: ['gain_weight'] }[t] || [];
      if (fm.goals.some(g => clash.includes(g.type))) toast('Эти цели тянут в разные стороны - тренер выберет главную по приоритету', 4000);
    }
    S.render();
  },
  'pf-gm-add': () => {
    const gm = gmForm(), m = GL.metric(gm.metric), fm = form();
    if (!m) return;
    const from = n(gm.from), to = n(gm.to);
    if (from == null || to == null) return toast('Впишите текущее значение и цель');
    if (from === to) return toast('Цель совпадает с текущим значением');
    const dir = to < from ? 'down' : 'up';
    if (!m.dirs.includes(dir)) return toast(dir === 'up' ? `${m.label}: эту цель ставят на уменьшение` : `${m.label}: эту цель ставят на рост`, 4000);
    fm.goals.push({ type: 'metric', metric: m.id, from, to, unit: m.unit, deadline: gm.deadline || null, priority: fm.goals.length ? 2 : 1, since: C.today() });
    S.forms.gm = { metric: '', from: '', to: '', deadline: '' };
    toast('Цель добавлена - не забудьте сохранить профиль');
    S.render();
  },
  'pf-gm-del': el => { const fm = form(); fm.goals = fm.goals.filter(g => !(g.type === 'metric' && g.metric === el.dataset.m)); S.render(); },
  'pf-gm-rec': async el => {
    const id = el.dataset.m, inp = document.getElementById(`gm-rec-${id}`), m = GL.metric(id);
    const v = n(inp?.value);
    if (!(v > 0)) return toast('Впишите результат');
    await GL.record(id, v);
    toast(`Записал: ${m.label.toLowerCase()} ${GL.fmtNum(v, m)} ${m.unit}`);
    await afterChange(C.today());
  },
  'pf-prio': el => { const g = goalOf(el.dataset.t); if (g) g.priority = Number(el.dataset.v); S.render(); },
  'pf-zone': el => {
    const g = goalOf(el.dataset.t); if (!g) return;
    const z = el.dataset.z; g.zones = (g.zones || []).includes(z) ? g.zones.filter(x => x !== z) : [...(g.zones || []), z];
    S.render();
  },
  'pf-pace': el => {
    const fm = form(); const i = Math.max(0, Math.min(2, PACES.indexOf(fm.pace) + Number(el.dataset.d)));
    fm.pace = PACES[i]; maybePreview(); S.render();
  },
  'pf-set-deadline': el => { form().deadline = el.dataset.d || ''; maybePreview(); S.render(); },
  'pf-act-add': el => {
    const fm = form();
    const type = el.dataset.type;
    if (type) {
      if (fm.activities.some(a => a.type === type)) return toast('Эта активность уже в списке');
      fm.activities.push({ type, per_week: 1, minutes: 60, intensity: 'mid' });
    } else {
      const name = el.dataset.custom.trim();
      fm.activities.push({ type: 'custom_' + name.replace(/\s+/g, '_').slice(0, 30), name: name[0].toUpperCase() + name.slice(1), per_week: 1, minutes: 60, intensity: 'mid' });
    }
    S.render();
  },
  'pf-act-del': el => { form().activities.splice(Number(el.dataset.i), 1); S.render(); },
  'pf-act-wd': el => {
    const a = form().activities[Number(el.dataset.i)], d = Number(el.dataset.d);
    a.weekdays = (a.weekdays || []).includes(d) ? a.weekdays.filter(x => x !== d) : [...(a.weekdays || []), d].sort();
    if (a.weekdays.length > (Number(a.per_week) || 1)) a.per_week = a.weekdays.length;
    S.render();
  },
  'pf-rem-add': () => { form().reminders.push({ kind: 'food', time: '20:00', enabled: true }); S.render(); },
  'pf-rem-defaults': () => {
    form().reminders = [{ kind: 'sleep', time: '09:00', enabled: true }, { kind: 'state', time: '10:00', enabled: true },
      { kind: 'water', time: '14:00', enabled: true }, { kind: 'food', time: '21:00', enabled: true }];
    S.render();
  },
  'pf-rem-del': el => { form().reminders.splice(Number(el.dataset.i), 1); S.render(); },
  'pf-inj-add': async () => {
    const f = S.forms.inj || {};
    const zone = f.zone || document.querySelector('[data-form=inj][data-key=zone]')?.value || 'knees';
    const since = f.since || C.today();
    await store.put('injury', store.newId(), { zone, note: (f.note || '').trim(), since, resolved: null }, since);
    S.forms.inj = {};
    toast(`Записал: ${ZONE_NAME[zone] || zone}. Упражнения на эту зону уберу из плана.`, 4000);
    await afterChange(C.today());
  },
  'pf-inj-resolve': async el => {
    await store.patch(el.dataset.id, { resolved: C.today() });
    toast('Отлично, что прошло! Возвращаю упражнения в план постепенно.', 3500);
    await afterChange(C.today());
  },
  'pf-rebuild': async () => {
    closeModal();
    try {
      await store.sync();
      const r = await store.api('/api/program/rebuild', { reason: 'activities' });
      if (r?.job_id) await addJob(r.job_id, 'program', 'program');
      toast('Тренер пересобирает план…');
    } catch (e) { toast(apiMsg(e, 'Пересборка плана'), 5000); }
  },
  'pf-token-copy': async () => {
    try { await navigator.clipboard.writeText(health.token); toast('Токен скопирован'); } catch (e) {
      const el = document.getElementById('pf-token');
      if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      toast('Выделил токен - скопируйте вручную');
    }
  },
  'pf-token-new': el => {
    return loadToken(!!health.token);
  },
  'pf-export': async () => {
    // через store.api: работает и с домашнего адреса, и через зеркало (с токеном устройства)
    try {
      const data = await store.api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `trainer-${C.today()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      toast(e.status === 404 ? 'Экспорт появится после обновления сервера' : e.status === 0 ? 'Нет связи с сервером' : e.message, 4000);
    }
  },
  norms: async () => {
    if (S.forms[F]) await saveProfile(false);
    try {
      await store.sync();
      const g = goal(), p = profile();
      const res = await store.api('/api/norms', { deadline: g.deadline || null, pace: p.pace || 'normal' });
      await store.sync();
      if (res.job_id) await addJob(res.job_id, 'norms', res.target_id);
      toast('Нормы пересчитаны');
    } catch (e) {
      // сервера нет рядом — считаем по формулам на устройстве, честно помечая «ориентировочно»
      if (e.status === 0 || e.status === 503 || e.status === 404) {
        const t = await NL.saveEstimate();
        if (t.missing) return toast('Заполните в профиле: ' + t.missing.join(', '), 5000);
        await afterChange(C.today());
        return toast('Нормы посчитаны на устройстве ориентировочно - с сервером будут точнее', 5000);
      }
      toast(apiMsg(e, 'Нормы'), 5000);
    }
  },
  'item-toggle': async el => {
    const it = store.get(el.dataset.id);
    await store.patch(it.id, { active: it.data.active === false });
    await afterChange(C.today());
  },
  'item-del': async el => {
    await store.remove(el.dataset.id);
    await afterChange(C.today());
  },
  'item-add': async () => {
    const f = S.forms.item || {};
    const title = (f.title || '').trim();
    if (!title) return toast('Введите название пункта');
    const type = f.type || 'bool';
    const order = Math.max(0, ...store.list('item').map(i => i.data.order ?? 0)) + 1;
    await store.put('item', store.newId(), { title, type, group: f.group || 'day', target: type === 'bool' ? undefined : Number(f.target) || 1, order, active: true });
    S.forms.item = {};
    toast('Пункт добавлен');
    await afterChange(C.today());
  },
  'item-add-ex': async () => {
    // «моя зарядка» — закреплённые упражнения утренней разминки: они будут в ней каждый день
    const id = fval('item', 'ex', document.querySelector('[data-form=item][data-key=ex]')?.value);
    const e = S.exMap.get(id);
    if (!e) return;
    const p = profile(), mo = p.modules?.morning || {};
    const pinned = [...new Set([...(mo.pinned || []), id])];
    await store.put('profile', `profile:${store.uid()}`, { ...p, modules: { ...(p.modules || {}), morning: { ...mo, enabled: true, pinned } } });
    toast(`«${e.name}» теперь в утренней разминке каждый день`);
    await afterChange(C.today());
  },
  'sync-now': async () => { await store.sync(); toast(store.state.error ? store.state.error : 'Синхронизировано'); },
  logout: async () => {
    try { await store.api('/api/auth/logout', {}); } catch (e) { /* офлайн — всё равно выходим */ }
    await store.wipe();
    location.hash = '';
    location.reload();
  },
};

export const confirms = {
  'pf-token-new': () => (health.token ? { title: 'Выпустить новый токен?', ok: 'Выпустить', danger: false, text: 'Старый токен перестанет работать: его нужно заменить в команде «Здоровье» на iPhone.' } : null),
  'item-del': el => { const it = store.get(el.dataset.id); return { title: 'Удалить пункт чек-листа?', text: `${it ? `«${it.data.title}» пропадёт` : 'Пункт пропадёт'} из ежедневного чек-листа.` }; },
  'grp-del': el => { const g = adminGroups.groups?.find(x => String(x.id) === String(el.dataset.id)); return { title: 'Удалить группу?', text: `${g ? `Группа «${g.name}» удалится. ` : ''}Участники останутся, но общая видимость по этой группе пропадёт.` }; },
  'pf-act-del': el => { const a = form().activities?.[Number(el.dataset.i)]; return { title: 'Убрать занятие из профиля?', ok: 'Убрать', text: a ? `«${actName(a)}» больше не попадёт в план недели.` : '' }; },
  'pf-rem-del': () => ({ title: 'Удалить напоминание?', text: 'Оно перестанет появляться у тренера.' }),
  'pf-gm-del': el => { const m = GL.metric(el.dataset.m); return { title: 'Убрать цель?', ok: 'Убрать', text: m ? `Цель «${m.label}» пропадёт из списка целей.` : '' }; },
  'pf-city-clear': () => ({ title: 'Убрать город?', ok: 'Убрать', text: 'Без города погода не учитывается в плане кардио.' }),
  logout: () => ({ title: 'Выйти из аккаунта?', ok: 'Выйти', text: 'Данные на этом устройстве сотрутся, правки, ещё не дошедшие до сервера, пропадут. На сервере всё сохранено: при следующем входе данные загрузятся.' }),
};

export const changes = {
  ...BR.changes,
  'pf-deadline': el => { form().deadline = el.value; maybePreview(); S.render(); },
  'pf-goal-amt': el => { const g = goalOf(el.dataset.t); if (g) g.amount = el.value; },
  'pf-gm-metric': el => { const d = GL.draft(el.value); S.forms.gm = { metric: el.value, from: d?.from ?? '', to: '', deadline: gmForm().deadline || '' }; S.render(); },
  'pf-gm-to': el => { const g = mGoalOf(el.dataset.m); if (g) { g.to = n(el.value); S.render(); } },
  'pf-gm-dl': el => { const g = mGoalOf(el.dataset.m); if (g) { g.deadline = el.value || null; S.render(); } },
  'pf-act': el => { const a = form().activities[Number(el.dataset.i)]; if (a) a[el.dataset.k] = el.dataset.k === 'intensity' ? el.value : Number(el.value) || ''; },
  'pf-sched': el => { form().sched_days[el.dataset.d][el.dataset.k] = el.value; },
  'pf-rem': el => { const r = form().reminders[Number(el.dataset.i)]; if (r) r[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; },
  // свои БЖУ: правится последняя версия нормы (как своя цель шагов), калории пересчитываются от разницы
  'pf-macro': async el => {
    const rec = store.get(el.dataset.id);
    if (!rec) return;
    const v = n(el.value), k = el.dataset.k;
    const manual = { ...(rec.data.macros_manual || {}) };
    if (v > 0) manual[k] = Math.round(v); else delete manual[k];
    const t = NL.applyManual(rec.data, manual);
    const chk = NL.checkManual(t);
    if (chk.why) { toast(chk.why, 4000); S.render(); return; }
    await store.put('target', rec.id, { ...t, manual_warnings: chk.warn }, rec.date);
    toast(Object.keys(manual).length ? `Нормы: ${num(t.kcal)} ккал, ${t.p} / ${t.f} / ${t.c} г` : 'БЖУ - снова по формуле');
    await afterChange(C.today());
  },
  'pf-steps': async el => {
    const v = n(el.value);
    await store.patch(el.dataset.id, { steps_manual: v && v >= 1000 ? Math.round(v) : null });
    toast(v ? 'Своя цель шагов сохранена' : 'Цель шагов - по формуле');
    await afterChange(C.today());
  },
};

export const routes = { profile: () => viewProfile() };
export const afterRender = () => {
  fillServerInfo();
  if (openSecs.has('deadline')) maybePreview();
  if (openSecs.has('iphone') && !health.token && !health.loading && !health.error) loadToken();
};
