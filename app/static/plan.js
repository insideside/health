// Адаптивный план (v2), целиком на клиенте и офлайн:
// готовность дня, вариант тренировки (полная / облегчённая / восстановление / перенос), недельный баланс,
// генераторы утренней зарядки, модулей «шея и скулы» и «осанка», домашних тренировок по сценариям,
// калории активностей по MET, подсказки прогрессии и разгрузка.
//
// Каталог упражнений берём из store.getMeta('exercises') (его кладёт туда app.js), активности — из
// store.getMeta('activities'). Выбор упражнений детерминирован: одинаковая дата → одинаковый набор,
// а соседние дни не повторяют друг друга.
import * as store from './store.js';
import * as C from './coach.js';
import * as G from './goals.js';
import * as PF from './prefs.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const prof = (uid = store.uid()) => store.get(`profile:${uid}`)?.data || {};
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const rnd = s => (hash(s) % 100000) / 100000;

// ── каталог ──
// v2-поля (tags, zones, contraindications, impact) берём из каталога; если их нет — выводим из v1-полей.
const POSTURE_IDS = new Set(['wall_angels', 'cat_cow', 'thoracic_rotation', 'open_book', 'bird_dog', 'superman', 'chest_stretch_wall',
  'chin_tuck', 'prone_y_raise', 'prone_t_raise', 'prone_w_raise', 'scapular_squeeze', 'doorway_pec_stretch', 'wall_posture_hold']);
const JUMPY = /jump|прыж|burpee|бёрпи|берпи|skater_jumps|jumping_jacks|скакалк|hop/i;
function deriveTags(e, impact) {
  const t = new Set();
  const txt = `${e.id} ${e.name}`.toLowerCase();
  if (e.morning) t.add('morning');
  if (e.category === 'warmup') t.add('warmup');
  if (e.category === 'mobility') { t.add('mobility'); t.add('recovery'); }
  if (e.category === 'core') t.add('core');
  if (e.category === 'cardio') t.add('cardio');
  if (e.category === 'strength') t.add('strength');
  if (/neck|шея|шеи|шейн|подбород|chin/.test(txt)) t.add('neck');
  if (/face|jaw|лиц|скул|челюст/.test(txt)) t.add('face');
  if (POSTURE_IDS.has(e.id) || /posture|осанк|лопат/.test(txt)) t.add('posture');
  if (impact === 'low') t.add('low_impact');
  if (impact !== 'high') t.add('quiet');
  return t;
}
const MUSCLE_ZONES = [[/бицепс(?! бедра)|трицепс|предплеч/, 'arms'], [/дельт|плеч/, 'shoulders'], [/ягодич/, 'glutes'],
  [/квадри|бицепс бедра|икр|приводящ|бедр/, 'legs'], [/груд/, 'chest'], [/спин|широчайш|трапец|ромб/, 'back'],
  [/пресс|прям.*живот/, 'abs'], [/косые/, 'sides']];
function deriveZones(e) {
  const z = new Set();
  const P = { push_h: ['chest', 'arms'], push_v: ['shoulders', 'arms'], pull_h: ['back', 'arms'], pull_v: ['back', 'arms'],
    squat: ['legs', 'glutes'], lunge: ['legs', 'glutes'], hinge: ['glutes', 'legs', 'back'], core_flex: ['abs'], core_anti: ['abs'] };
  (P[e.pattern] || []).forEach(x => z.add(x));
  const m = (e.muscles || []).join(' ').toLowerCase();
  for (const [rx, zone] of MUSCLE_ZONES) if (rx.test(m)) z.add(zone);
  if (/side|oblique|twist|бок|косые|russian/.test(`${e.id} ${e.name}`.toLowerCase())) z.add('sides');
  return [...z];
}
function deriveContra(e, impact) {
  const c = new Set();
  if (e.pattern === 'squat' || e.pattern === 'lunge') c.add('knees');
  if (e.pattern === 'hinge' && (e.equipment || []).some(q => ['barbell', 'dumbbells', 'kettlebell'].includes(q))) c.add('lower_back');
  if (e.pattern === 'push_v') c.add('shoulders');
  if (e.pattern === 'push_h' && !(e.equipment || []).length) c.add('wrists');
  if (e.pattern === 'core_flex') { c.add('hernia'); c.add('pregnancy'); }
  if ((e.equipment || []).includes('ab_wheel')) { c.add('lower_back'); c.add('hernia'); c.add('pregnancy'); }
  if (impact === 'high') ['knees', 'ankles', 'overweight_joints', 'pregnancy', 'hernia', 'heart'].forEach(x => c.add(x));
  if (/neck|шея|шеи/.test(e.id + e.name)) c.add('neck');
  return [...c];
}
let catSrc = null, catNorm = [];
export function catalog() {
  const src = store.getMeta('exercises', null) || [];
  if (src === catSrc) return catNorm;
  catSrc = src;
  catNorm = src.map(e => {
    const impact = e.impact || (JUMPY.test(`${e.id} ${e.name}`) ? 'high' : e.category === 'cardio' ? 'mid' : 'low');
    const tags = e.tags?.length ? new Set(e.tags) : deriveTags(e, impact);
    if (e.morning) tags.add('morning');
    return { ...e, impact, _tags: tags, _zones: e.zones?.length ? e.zones : deriveZones(e),
      _contra: Array.isArray(e.contraindications) ? e.contraindications : deriveContra(e, impact) };
  });
  return catNorm;
}
const exById = id => catalog().find(e => e.id === id);

// противопоказания: ограничения из профиля + зоны открытых травм
export function excludedFor(uid = store.uid()) {
  const out = new Set(prof(uid).limitations || []);
  const t = C.today();
  for (const r of store.list('injury', uid)) {
    const d = r.data;
    if (d.zone && (!d.resolved || d.resolved > t) && (!d.since || d.since <= t)) out.add(d.zone);
  }
  return out;
}
const NO_IMPACT = ['knees', 'ankles', 'overweight_joints', 'pregnancy', 'hernia', 'heart', 'varicose'];

function userLevel(uid) {
  const progs = store.list('program', uid).filter(r => r.data.active);
  const lv = Number(progs[0]?.data.level);
  if (lv >= 1 && lv <= 3) return lv;
  const done = store.list('workout', uid, r => r.data.done).length;
  return done >= 30 ? 3 : 2;
}

// пул упражнений под место, инвентарь, ограничения и уровень
function pool({ place = 'home', equipment, level, uid = store.uid(), noJump, quiet } = {}) {
  const excl = excludedFor(uid);
  const skip = PF.excludedIds(uid);                 // «не предлагать» (profile.exercise_prefs.exclude)
  const missing = place === 'gym' ? PF.gymMissing(uid) : null;   // чего нет в зале
  const noHigh = noJump || quiet || NO_IMPACT.some(x => excl.has(x));
  let eq = null;
  if (place === 'home') {
    if (Array.isArray(equipment)) eq = new Set(equipment);                // сценарий задал набор явно
    else if (Array.isArray(prof(uid).equipment)) eq = new Set([...prof(uid).equipment, 'mat', 'chair']);   // пол и стул есть везде
  }
  const lv = level || userLevel(uid);
  return catalog().filter(e => (e.place || []).includes(place)
    && !skip.has(e.id)
    && !(missing?.size && (e.equipment || []).some(q => missing.has(q)))
    && (!eq || (e.equipment || []).every(q => eq.has(q)))
    && !(e._contra || []).some(c => excl.has(c))
    && (Number(e.level) || 1) <= lv
    && !(noHigh && e.impact === 'high')
    && !(quiet && e._tags.has('quiet') === false && e.impact !== 'low'));
}

// акценты целей (goals.js): зоны и паттерны с множителями; без целей — пусто, и подбор как раньше
function goalEffects(uid) { try { return G.effects(undefined, uid); } catch (e) { return null; } }

// длительность одного подхода в секундах (с переходом)
function setSec(e, amount) {
  if (e.unit === 'seconds') return (e.per_side ? 2 * amount : amount) + 10;
  return e.per_side ? 70 : 40;
}
const fmtAmount = (e, n) => e.unit === 'seconds' ? `${n} с` : `${n} раз`;

// Внутренний подбор: → { list: [{id, name, amount, per_side, unit, n, sec}], rounds, sec }
function pickInternal({ tags, fallback, zones, minutes = 10, place = 'home', date = C.today(), seed, level, uid = store.uid(),
  avoid = [], equipment, noJump, quiet, secAmount = 30, repAmount = 10, maxPerPattern = 2, requireZones = false, maxItems = 99, excludeTags = [] } = {}) {
  const budget = Math.max(60, minutes * 60);
  const base = pool({ place, equipment, level, uid, noJump, quiet });
  const has = (e, ts) => !ts || !ts.length || ts.some(t => e._tags.has(t));
  const base2 = excludeTags.length ? base.filter(e => !excludeTags.some(t => e._tags.has(t))) : base;
  let cand = base2.filter(e => has(e, tags) && (!requireZones || !zones?.length || e._zones.some(z => zones.includes(z))));
  if (fallback && cand.length < 6) {
    const more = base2.filter(e => !cand.includes(e) && has(e, fallback));
    cand = cand.concat(more.map(e => ({ ...e, _fb: true })));
  }
  const avoidSet = new Set(avoid);
  const s = seed || `${date}|${(tags || []).join(',')}`;
  const eff = goalEffects(uid);
  const liked = PF.likedIds(uid);
  const scored = cand.map(e => ({
    e,
    sc: rnd(s + '|' + e.id) + (liked.has(e.id) ? 0.35 : 0) + G.exerciseBoost(e, eff) * 0.5 + (zones?.length && e._zones.some(z => zones.includes(z)) ? 0.5 : 0)
      + (tags?.length && tags.some(t => e._tags.has(t)) ? 0.2 : 0) - (e._fb ? 0.6 : 0) - (avoidSet.has(e.id) ? 0.8 : 0),
  })).sort((a, b) => b.sc - a.sc);
  const list = [], perPattern = {};
  let used = 0;
  for (const { e } of scored) {
    if (used >= budget - 15 || list.length >= maxItems) break;
    const n = e.unit === 'seconds' ? secAmount : (e.per_side ? Math.max(6, repAmount - 2) : repAmount);
    const sec = setSec(e, n);
    if (used + sec > budget + 20) continue;
    const pat = e.pattern || 'other';
    if (pat !== 'mobility' && (perPattern[pat] || 0) >= maxPerPattern) continue;
    perPattern[pat] = (perPattern[pat] || 0) + 1;
    list.push({ id: e.id, name: e.name, amount: fmtAmount(e, n), per_side: !!e.per_side, unit: e.unit, n, sec });
    used += sec;
  }
  // не хватило упражнений — удлиняем каждое, потом добавляем круги
  let rounds = 1;
  if (list.length && used < budget * 0.8) {
    const k = Math.min(2, budget * 0.9 / used);
    used = 0;
    for (const x of list) {
      const e = exById(x.id);
      x.n = e.unit === 'seconds' ? Math.min(60, Math.round(x.n * k / 5) * 5) : Math.min(20, Math.round(x.n * k / 2) * 2);
      x.amount = fmtAmount(e, x.n);
      x.sec = setSec(e, x.n);
      used += x.sec;
    }
    if (used < budget * 0.8) rounds = clamp(Math.round(budget / used), 1, 4);
  }
  // порядок как в нормальной зарядке: разогрев → кардио → сила и кор → растяжка
  const phase = x => { const e = exById(x.id); return e.category === 'warmup' ? 0 : e.category === 'cardio' ? 1 : e.category === 'mobility' ? 3 : 2; };
  list.sort((a, b) => phase(a) - phase(b));
  return { list, rounds, sec: used * rounds };
}

// Публичный подбор: → [{ id, amount, per_side }] (+ name, unit, sec для удобства экранов)
export function pickExercises({ tags, zones, minutes = 10, place = 'home', date = C.today(), seed, level, avoid, equipment, noJump, quiet } = {}) {
  const r = pickInternal({ tags, zones, minutes, place, date, seed, level, avoid, equipment, noJump, quiet });
  return r.list.map(({ id, amount, per_side, name, unit, sec }) => ({ id, amount, per_side, name, unit, sec }));
}

// ── короткие модули: утренняя зарядка, шея и скулы, осанка ──
const MODULES = {
  morning: { title: 'Утренняя разминка', tags: ['morning', 'warmup', 'mobility'], fallback: ['recovery'], minutes: 10, sec: 30, reps: 10, perMin: 0.8, excludeTags: ['face'] },
  neck: { title: 'Шея и скулы', tags: ['neck', 'face'], fallback: ['posture'], zones: ['neck'], minutes: 5, sec: 30, reps: 10, perMin: 1.2 },
  posture: { title: 'Осанка', tags: ['posture'], fallback: ['mobility'], zones: ['back', 'shoulders', 'neck'], minutes: 10, sec: 30, reps: 10, perMin: 0.9 },
  // комплексы по желанию на «Сегодня»: короткая тренировка и группы мышц (дома, под инвентарь из профиля)
  workout: { title: 'Короткая тренировка', tags: ['strength', 'core'], fallback: ['cardio'], minutes: 20, sec: 40, reps: 12, perMin: 0.45, maxPerPattern: 2, excludeTags: ['face', 'neck'] },
  abs: { title: 'Пресс и кор', tags: ['core', 'strength'], fallback: ['posture'], zones: ['abs', 'sides'], requireZones: true, minutes: 10, sec: 40, reps: 15, perMin: 0.8 },
  legs: { title: 'Ноги и ягодицы', tags: ['strength'], fallback: ['mobility'], zones: ['legs', 'glutes'], requireZones: true, minutes: 15, sec: 40, reps: 15, perMin: 0.6, maxPerPattern: 3 },
  arms: { title: 'Руки и плечи', tags: ['strength'], fallback: ['posture'], zones: ['arms', 'shoulders'], requireZones: true, minutes: 15, sec: 40, reps: 12, perMin: 0.6, maxPerPattern: 3 },
  back: { title: 'Спина и грудь', tags: ['strength', 'posture'], fallback: ['mobility'], zones: ['back', 'chest'], requireZones: true, minutes: 15, sec: 40, reps: 12, perMin: 0.6, maxPerPattern: 3 },
  stretch: { title: 'Растяжка', tags: ['mobility', 'recovery'], fallback: ['posture'], minutes: 10, sec: 40, reps: 8, perMin: 0.8, excludeTags: ['face'] },
  cardio: { title: 'Кардио дома', tags: ['cardio'], fallback: ['strength'], minutes: 15, sec: 40, reps: 20, perMin: 0.6, maxPerPattern: 3 },
};
export const MODULE_NOTES = {
  neck: 'Упражнения укрепляют мышцы шеи и улучшают осанку, подбородок выглядит подтянутее. Жир под подбородком уходит только вместе с общим снижением жира - упражнения его не «сжигают».',
};

// makeRoutine(module, date) или makeRoutine(module, minutes, date). Возвращает запись routine (готовую или новую).
export async function makeRoutine(module, a, b, opts = {}) {
  let date = C.today(), minutes = null;
  if (typeof a === 'number') { minutes = a; date = b || date; } else { date = a || date; if (typeof b === 'number') minutes = b; }
  const rebuild = Number(opts.rebuild) || 0;       // пересборка: другой набор по тем же правилам
  const cfg = MODULES[module];
  if (!cfg) throw new Error(`Неизвестный модуль: ${module}`);
  const uid = store.uid();
  const id = `routine:${uid}:${date}:${module}`;
  const cur = store.get(id);
  if (cur && !rebuild) return cur;
  minutes = Number(minutes || prof(uid).modules?.[module]?.minutes || cfg.minutes);
  const asked = minutes;
  let tags = cfg.tags;
  // в тяжёлое утро зарядка мягче: мобилити и восстановление
  if (module === 'morning') {
    const r = readiness(date, uid);
    if (r.level === 'rest' || r.level === 'low') tags = ['mobility', 'recovery', 'morning'];
  }
  const avoid = [];
  for (const d of [C.addDays(date, -1), C.addDays(date, -2)]) {
    for (const x of store.get(`routine:${uid}:${d}:${module}`)?.data.exercises || []) avoid.push(x.id);
  }
  const seed = `${date}|${module}|${uid}${rebuild ? `|${rebuild}` : ''}`;
  if (rebuild) for (const x of cur?.data.exercises || []) if (!x.pinned) avoid.push(x.id);   // не повторять только что показанное
  // закреплённые пользователем упражнения («моя зарядка») идут первыми, генератор добирает остальное время
  const skipIds = PF.excludedIds(uid);
  const pinned = module === 'morning' ? (prof(uid).modules?.morning?.pinned || []).filter(x => !skipIds.has(x) && catalog().some(e => e.id === x)) : [];
  const pinnedList = pinned.map(pid => {
    const e = catalog().find(x => x.id === pid);
    return { id: pid, amount: e.unit === 'seconds' ? `${cfg.sec || 30} с` : `${cfg.reps || 10} раз`, per_side: !!e.per_side, pinned: true };
  });
  minutes = Math.max(2, minutes - pinned.length * 0.75);
  avoid.push(...pinned);
  const res = pickInternal({ tags, fallback: cfg.fallback, zones: cfg.zones, requireZones: !!cfg.requireZones, minutes, place: 'home', date, seed, avoid,
    secAmount: cfg.sec, repAmount: cfg.reps, maxPerPattern: cfg.maxPerPattern ?? 99, uid, maxItems: Math.max(3, Math.round(minutes * cfg.perMin)), excludeTags: cfg.excludeTags || [] });
  if (!res.list.length && !pinnedList.length) return null;     // каталог ещё не загружен
  const total = asked;
  const data = {
    module, minutes: total, title: `${cfg.title} · ${total} мин`,
    exercises: [...pinnedList, ...res.list].map(x => ({ id: x.id, amount: x.amount, per_side: x.per_side, done: false, ...(x.pinned ? { pinned: true } : {}) })),
    done: false, seed, rounds: res.rounds, seed_n: rebuild,
  };
  if (MODULE_NOTES[module]) data.note = MODULE_NOTES[module];
  return store.put('routine', id, data, date);
}

// ── домашние тренировки ──
const FOCUS = {
  full: { title: 'всё тело', slots: [['squat', 'lunge'], ['push_h', 'push_v'], ['hinge'], ['pull_h', 'pull_v'], ['core_anti', 'core_flex'], ['lunge', 'squat'], ['isolation'], ['carry', 'cardio']] },
  upper: { title: 'верх тела', region: 'upper', slots: [['push_h'], ['pull_h', 'pull_v'], ['push_v'], ['isolation'], ['push_h', 'push_v'], ['pull_h'], ['isolation'], ['core_anti']] },
  lower: { title: 'ноги и ягодицы', region: 'lower', slots: [['squat'], ['hinge'], ['lunge'], ['isolation'], ['squat', 'lunge'], ['hinge'], ['isolation']] },
  core: { title: 'пресс и бока', slots: [['core_anti'], ['core_flex'], ['core_anti'], ['core_flex']], tags: ['core'] },
  cardio: { title: 'кардио', circuit: true, tags: ['cardio'] },
  recovery: { title: 'восстановление', recovery: true, tags: ['recovery', 'mobility'] },
  quick: { title: 'быстрая', slots: [['squat', 'lunge'], ['push_h', 'push_v'], ['hinge'], ['core_anti', 'core_flex'], ['pull_h', 'lunge']], quick: true },
};

export const SCENARIOS = [
  { id: 'five', title: '5 минут, когда совсем некогда', minutes: 5, focus: 'quick', note: 'Два круга по всему телу, без прыжков - чтобы день не прошёл совсем без движения.', noJump: true },
  { id: 'before_work', title: '15 минут перед работой', minutes: 15, focus: 'quick', note: 'Бодрит, но не выматывает: без прыжков, чтобы не пришлось второй раз в душ.', noJump: true },
  { id: 'lunch_break', title: 'Обеденный перерыв, 10 минут', minutes: 10, focus: 'quick', note: 'Без коврика и инвентаря: стоя и со стулом, можно в офисной одежде.', equipment: ['chair'], noJump: true, quiet: true },
  { id: 'evening_recovery', title: 'Вечер без сил - восстановление', minutes: 15, focus: 'recovery', note: 'Спокойная мобилити и растяжка. Засчитывается как движение и помогает уснуть.' },
  { id: 'travel', title: 'В командировке без инвентаря', minutes: 25, focus: 'full', note: 'Только вес тела, пол и стул в номере.', equipment: ['mat', 'chair'] },
  { id: 'quiet', title: 'Тихо в квартире', minutes: 20, focus: 'full', note: 'Без прыжков и топота - соседи не заметят.', noJump: true, quiet: true },
  { id: 'upper_30', title: 'Верх тела, 30 минут', minutes: 30, focus: 'upper', note: 'Грудь, спина, плечи и руки.' },
  { id: 'abs_15', title: 'Пресс и бока, 15 минут', minutes: 15, focus: 'core', note: 'Мышцы кора и косые. Плоский живот делает дефицит калорий, а пресс - осанку и форму.', zones: ['abs', 'sides'] },
  { id: 'cardio_20', title: 'Кардио 20 минут без прыжков', minutes: 20, focus: 'cardio', note: 'Работа 40 с, отдых 20 с. Бережно к коленям.', noJump: true },
  { id: 'legs_30', title: 'Ноги и ягодицы, 30 минут', minutes: 30, focus: 'lower', note: 'Приседания, выпады, мосты.', zones: ['glutes', 'legs'] },
  { id: 'bedtime_stretch', title: 'Растяжка перед сном', minutes: 10, focus: 'recovery', note: 'Медленно, с длинным выдохом. Без телефона после.', quiet: true, tags: ['recovery', 'mobility'] },
  { id: 'desk_reset', title: 'После долгого сидения', minutes: 10, focus: 'recovery', note: 'Грудной отдел, шея, бёдра - всё, что затекает за столом.', zones: ['back', 'neck', 'shoulders'], tags: ['posture', 'mobility'] },
  { id: 'weekend_full', title: 'Выходной - полная, 45 минут', minutes: 45, focus: 'full', note: 'Полноценная тренировка на всё тело с разминкой и заминкой.' },
];

function hasLogs(wd) { return (wd?.exercises || []).some(x => (x.log || []).some(s => s && (s.done || s.reps || s.weight))); }

function repsRange(level, quick) { return quick ? '10-12' : level <= 1 ? '10-15' : '8-12'; }

function toWorkoutEx(e, { sets, reps, secs, rest, note }) {
  return { id: e.id, name: e.name, unit: e.unit, per_side: !!e.per_side, sets,
    reps: e.unit === 'seconds' ? `${secs} с` : reps, rest_sec: rest, note: note || '', log: [] };
}
const exSec = C.exerciseSec;

// Состав тренировки (без записи): → data записи workout
export function buildHomeWorkout({ minutes, focus = 'full', date = C.today(), scenario, equipment, noJump, quiet, zones, tags, machine, intensity, uid = store.uid() } = {}) {
  const sc = SCENARIOS.find(s => s.id === scenario);
  if (sc) {
    minutes = minutes || sc.minutes; focus = sc.focus;
    equipment = equipment ?? sc.equipment; noJump = noJump ?? sc.noJump; quiet = quiet ?? sc.quiet;
    zones = zones ?? sc.zones; tags = tags ?? sc.tags;
  }
  const F = FOCUS[focus] || FOCUS.full;
  minutes = clamp(Number(minutes) || 30, 5, 120);
  const r = readiness(date, uid);
  if (r.level === 'low' || r.level === 'rest') noJump = true;
  const ramp = C.rampFactor(date, uid);
  const loadK = ramp * (r.level === 'low' ? 0.8 : 1);
  const lv = userLevel(uid);
  const seed = `${date}|${focus}|${scenario || ''}|${uid}`;
  const common = { place: 'home', date, uid, equipment, noJump, quiet };
  // вчерашняя сгенерированная тренировка — не повторяем
  const prev = store.get(`wo:${uid}:${C.addDays(date, -1)}`)?.data;
  const avoid = prev ? (prev.exercises || []).map(x => x.id) : [];

  let warmup = [], cooldown = [], exercises = [];
  if (F.recovery) {
    const res = pickInternal({ ...common, tags: tags || F.tags, fallback: ['mobility', 'posture'], zones, minutes, seed, avoid,
      secAmount: 45, repAmount: 10, maxPerPattern: 99 });
    exercises = res.list.map(x => toWorkoutEx(exById(x.id), { sets: res.rounds > 1 ? Math.min(2, res.rounds) : 1, reps: String(x.n), secs: x.n, rest: 0 }));
  } else {
    const warmMin = minutes >= 20 ? 4 : minutes >= 10 ? 2 : 1;
    const coolMin = minutes >= 25 ? 3 : minutes >= 10 ? 2 : 0;
    warmup = pickInternal({ ...common, tags: ['warmup'], fallback: ['morning', 'mobility'], minutes: warmMin, seed: seed + '|w', maxPerPattern: 99 }).list.map(x => x.id);
    cooldown = coolMin ? pickInternal({ ...common, tags: ['mobility', 'recovery'], minutes: coolMin, seed: seed + '|c', avoid: warmup, maxPerPattern: 99 }).list.map(x => x.id) : [];
    const budget = (minutes - warmMin - coolMin) * 60;
    const base = pool({ ...common, level: lv }).filter(e => !warmup.includes(e.id) && !cooldown.includes(e.id));
    const eff = goalEffects(uid);
    const liked = PF.likedIds(uid);
    const score = e => rnd(seed + '|' + e.id) + (liked.has(e.id) ? 0.35 : 0) + (zones?.length && e._zones.some(z => zones.includes(z)) ? 0.6 : 0)
      - (avoid.includes(e.id) ? 0.7 : 0) + (e.category === 'strength' || e.category === 'core' ? 0.1 : 0) + G.exerciseBoost(e, eff);
    const used = new Set();
    let spent = 0;
    const fitI = e => (/interval/.test(e.id) === (intensity === 'high') ? 1 : 0);
    // кардио на своём тренажёре (степпер, велотренажёр, эллипс…): один ровный блок или интервалы на всё время
    const onMachine = F.circuit && machine ? base.filter(e => (e.equipment || []).includes(machine) && (e._tags.has('cardio') || e.category === 'cardio'))
      .sort((a, b) => fitI(b) - fitI(a) || score(b) - score(a))[0] : null;
    if (onMachine) {
      const mins = Math.max(5, Math.round(budget / 60));
      const x = toWorkoutEx(onMachine, { sets: 1, reps: '', secs: mins * 60, rest: 0 });
      x.reps = `${mins} мин`;
      x.note = intensity === 'high' ? 'Интервалы: 1 мин быстро, 2 мин спокойно. Последние 3 минуты - плавное замедление.'
        : intensity === 'low' ? 'Спокойный темп: можно свободно разговаривать.' : 'Ровный темп, зона 2: дыхание чаще, но говорить фразами можно.';
      exercises.push(x);
    } else if (F.circuit) {
      // кардио-круг: работа 40 с / отдых 20 с; кругов столько, чтобы заполнить время
      const isCardio = e => e._tags.has('cardio') || e.category === 'cardio';
      const extra = e => !isCardio(e) && e.impact !== 'high' && !(e.equipment || []).length
        && (e.category === 'core' || e.category === 'strength') && e.unit !== 'seconds';
      const cand = [...base.filter(isCardio).sort((a, b) => score(b) - score(a)),
        ...base.filter(extra).sort((a, b) => score(b) - score(a))].slice(0, minutes >= 30 ? 8 : 6);
      const round = cand.map(e => {
        const x = toWorkoutEx(e, { sets: 1, reps: '12-15', secs: 40, rest: 20 });
        return x;
      });
      const perRound = round.reduce((a, x) => a + exSec({ ...x, sets: 1 }) + 20, 0);
      const rounds = perRound ? clamp(Math.round(budget / perRound), 1, 8) : 0;
      for (const x of round) {
        x.sets = rounds;
        x.note = 'Круговая: по одному подходу каждого упражнения подряд, затем следующий круг.';
        exercises.push(x);
      }
        } else {
      const sets0 = F.quick ? 2 : minutes >= 40 ? 4 : 3;
      const sets = Math.max(1, Math.round(sets0 * loadK));
      const rest = F.quick ? 30 : 60;
      const reps = repsRange(lv, F.quick);
      const tagFilter = e => !F.tags || F.tags.some(t => e._tags.has(t)) || e.category === 'core';
      let guard = 0;
      while (spent < budget - 45 && guard++ < 4) {
        let added = false;
        for (const slot of F.slots) {
          const cand = base.filter(e => !used.has(e.id) && slot.includes(e.pattern) && tagFilter(e)
            && e.category !== 'mobility' && e.category !== 'warmup'
            && (!F.region || e.region === F.region || slot.some(p => p.startsWith('core'))))
            .sort((a, b) => score(b) - score(a));
          const e = cand[0];
          if (!e) continue;
          const x = toWorkoutEx(e, { sets, reps, secs: e.category === 'core' ? 30 : 40, rest });
          const hint = progressionHint(e.id, date, uid);
          if (hint) x.note = hint;
          const sec = exSec(x);
          if (spent + sec > budget + 60) continue;
          exercises.push(x); used.add(e.id); spent += sec; added = true;
          if (spent >= budget - 45) break;
        }
        if (!added) break;
      }
      // слотов не хватило (мало инвентаря или много ограничений) — добираем любыми подходящими, потом подходами
      if (spent < budget * 0.8) {
        const rest2 = base.filter(e => !used.has(e.id) && e.category !== 'mobility' && e.category !== 'warmup' && tagFilter(e)
          && (!F.region || e.region === F.region || e.category === 'core')).sort((a, b) => score(b) - score(a));
        for (const e of rest2) {
          const x = toWorkoutEx(e, { sets, reps, secs: e.category === 'core' ? 30 : 40, rest });
          const sec = exSec(x);
          if (spent + sec > budget + 60) continue;
          exercises.push(x); used.add(e.id); spent += sec;
          if (spent >= budget - 45) break;
        }
      }
      // цели-показатели: упражнениям на акцентные зоны — подход сверху, если время позволяет
      for (const x of exercises) {
        const e = exById(x.id);
        if (G.exerciseBoost(e, eff) < 0.3) continue;
        const before = exSec(x); x.sets += 1;
        const add = exSec(x) - before;
        if (spent + add > budget + 60) { x.sets -= 1; continue; }
        spent += add;
      }
      for (let k = 0; spent < budget * 0.8 && exercises.length && k < 2; k++) {
        for (const x of exercises) {
          if (spent >= budget * 0.9) break;
          const before = exSec(x); x.sets += 1; spent += exSec(x) - before;
        }
      }
    }
  }
  const mName = machine && exercises.length === 1 && /мин$/.test(exercises[0].reps) ? PF.equipLabel(machine) : '';
  const title = sc ? sc.title : mName ? `Кардио дома: ${mName} · ${minutes} мин` : `Дома: ${F.title} · ${minutes} мин`;
  return { title, focus, week: 1, weeks: 1, warmup, exercises, cooldown, done: false, variant: 'full',
    source: 'generated', planned_minutes: minutes, scenario: scenario || null };
}

// makeHomeWorkout({minutes, focus, date, scenario?, equipment?, noJump?, quiet?, zones?}) → запись workout.
// Уже начатую тренировку дня (есть логи подходов) не перезаписывает — возвращает её.
export async function makeHomeWorkout(opts = {}) {
  const uid = store.uid();
  const date = opts.date || C.today();
  const id = `wo:${uid}:${date}`;
  const cur = store.get(id);
  if (cur && hasLogs(cur.data)) return cur;
  const data = buildHomeWorkout({ ...opts, date, uid });
  if (!data.exercises.length) return null;          // каталог не загружен
  if (cur && cur.data.source !== 'generated') {
    data.replaced = { program_id: cur.data.program_id || null, title: cur.data.title, week: cur.data.week || null };
  }
  const rec = await store.put('workout', id, data, date);
  await C.refreshDsum(date);
  return rec;
}

// ── активности ──
const MET_FALLBACK = { low: 3, mid: 5, high: 7.5 };
export function findActivity(type) {
  const t = String(type || '').toLowerCase().trim();
  const acts = store.getMeta('activities', []) || [];
  return acts.find(a => a.id === t) || acts.find(a => a.name?.toLowerCase() === t) || acts.find(a => (a.aliases || []).includes(t)) || null;
}
function lastWeight(uid = store.uid()) {
  const ws = C.weights(uid);
  return ws.length ? ws[ws.length - 1].w : Number(prof(uid).weight) || 70;
}
export function activityKcal(type, minutes, intensity = 'mid', weight) {
  const a = findActivity(type);
  const met = Number(a?.met?.[intensity] ?? a?.met?.mid) || MET_FALLBACK[intensity] || MET_FALLBACK.mid;
  const w = Number(weight) || lastWeight();
  return Math.round(met * w * (Number(minutes) || 0) / 60);
}

// ── готовность дня ──
// → { score: 0..100, level: 'high'|'normal'|'low'|'rest', reasons: [] }
// Пульс в покое выше обычного и HRV ниже обычного — признаки недовосстановления (усталость, стресс,
// начинающаяся простуда). Базовая линия — медиана за 21 день до этой даты; нужно хотя бы 5 замеров.
export function vitalsSignal(date = C.today(), uid = store.uid()) {
  const today = store.get(`vitals:${uid}:${date}`)?.data;
  if (!today) return null;
  const hist = store.list('vitals', uid, r => r.date < date && r.date >= C.addDays(date, -21)).map(r => r.data);
  const med = k => {
    const v = hist.map(x => Number(x[k])).filter(x => x > 0).sort((a, b) => a - b);
    return v.length >= 5 ? v[Math.floor(v.length / 2)] : null;
  };
  let delta = 0, reason = '';
  const rhr = Number(today.resting_hr), rb = med('resting_hr');
  if (rhr && rb) {
    const d = rhr - rb;
    if (d >= 7) { delta -= 14; reason = `пульс в покое ${Math.round(rhr)} - на ${Math.round(d)} выше обычного`; }
    else if (d >= 4) { delta -= 7; reason = `пульс в покое чуть выше обычного (${Math.round(rhr)})`; }
    else if (d <= -3) { delta += 3; }
  }
  const hrv = Number(today.hrv), hb = med('hrv');
  if (hrv && hb) {
    const r = hrv / hb;
    if (r <= 0.75) { delta -= 12; reason = reason || `HRV ${Math.round(hrv)} мс - заметно ниже обычного`; }
    else if (r <= 0.88) { delta -= 5; reason = reason || 'HRV чуть ниже обычного'; }
    else if (r >= 1.12) { delta += 4; reason = reason || 'HRV выше обычного - организм восстановился'; }
  }
  if (!rb && !hb) return { delta: 0, reason: '', baseline: false };
  return { delta, reason, baseline: true, resting_hr: rhr || null, hrv: hrv || null, rb, hb };
}

export function readiness(date = C.today(), uid = store.uid()) {
  let score = 75;
  const reasons = [];
  const si = C.sleepInfo(C.sleep(date, uid), uid);
  if (si) {
    score += (si.score - 70) * 0.4;
    if (si.verdict === 'short') reasons.push(`сон ${String(Math.round(si.hours * 10) / 10).replace('.', ',')} ч - недосып`);
    else if (si.score < 50) reasons.push('сон неспокойный');
    else if (si.score >= 85) reasons.push('хороший сон');
  }
  const st = C.stateOf(date, uid);
  if (st) {
    score += { great: 10, good: 3, meh: -10, broken: -30 }[st.wellbeing] || 0;
    score += { light: -5, strong: -15 }[st.soreness] || 0;
    score += { mid: -3, high: -10 }[st.stress] || 0;
    score += { low: -8, high: 5 }[st.energy] || 0;
    if (st.wellbeing === 'broken') reasons.push('самочувствие «разбит»');
    else if (st.wellbeing === 'meh') reasons.push('самочувствие так себе');
    if (st.soreness === 'strong') reasons.push('сильная мышечная боль');
    if (st.stress === 'high') reasons.push('высокий стресс');
  }
  // вчерашняя нагрузка
  const y = C.addDays(date, -1);
  const yw = C.workout(y, uid);
  if (yw && yw.data.variant !== 'moved' && C.workoutProgress(yw) >= 0.8 && (yw.data.variant || 'full') === 'full') {
    score -= 6; reasons.push('вчера была тренировка');
  }
  let hard = 0, recov = 0;
  for (const r of store.byDate('activity', y, uid)) {
    const m = Number(r.data.minutes) || 0;
    if (C.isPassive(r.data.type)) { recov += m; continue; }
    if (r.data.intensity === 'high') hard += m; else if (r.data.intensity === 'mid') hard += m * 0.5;
  }
  if (hard >= 45) { score -= hard >= 90 ? 10 : 6; reasons.push('вчера интенсивная активность'); }
  if (recov >= 20) { score += 4; reasons.push('вчера восстановление'); }
  // пульс в покое и HRV из «Здоровья»: сравниваем не с «нормой вообще», а с вашей обычной за 2–3 недели
  const vt = vitalsSignal(date, uid);
  if (vt) { score += vt.delta; if (vt.reason) reasons.push(vt.reason); }
  // травмы
  const t = C.today();
  const inj = store.list('injury', uid).filter(r => r.data.zone && (!r.data.resolved || r.data.resolved > t));
  if (inj.length) { score -= Math.min(20, inj.length * 10); reasons.push(`травма: ${inj.map(r => ZONE_NAMES[r.data.zone] || r.data.zone).join(', ')}`); }
  // цикл
  const cy = C.cycleInfo(date, uid);
  if (cy?.phase === 'menstrual') { score -= cy.day <= 2 ? 12 : 6; reasons.push('первые дни цикла'); }
  const dt = C.dayType(date, uid);
  score = clamp(Math.round(score), 0, 100);
  if (dt === 'sick') { score = Math.min(score, 20); reasons.unshift('болезнь'); }
  const level = score >= 80 ? 'high' : score >= 55 ? 'normal' : score >= 35 ? 'low' : 'rest';
  return { score, level, reasons };
}
const ZONE_NAMES = { chest: 'грудь', shoulders: 'плечи', arms: 'руки', back: 'спина', abs: 'пресс', sides: 'бока', glutes: 'ягодицы',
  legs: 'ноги', neck: 'шея', knees: 'колени', lower_back: 'поясница', wrists: 'запястья', ankles: 'голеностоп', hips: 'тазобедренные' };

// ── вариант тренировки ──
// ближайший свободный день этой недели после date под тренировку длиной minutes
export function nextFreeDay(date, minutes = 45, uid = store.uid()) {
  const p = prof(uid);
  const budget = Number(p.time_budget_min) || 60;
  const sun = C.addDays(C.mondayOf(date), 6);
  const cand = [];
  for (let d = C.addDays(date, 1); d <= sun; d = C.addDays(d, 1)) {
    const w = C.workout(d, uid);
    if (w && w.data.variant !== 'moved') continue;
    const dt = C.dayType(d, uid);
    if (dt === 'sick' || dt === 'rest' || dt === 'special') continue;
    const wd = C.weekday(d);
    if (p.schedule?.days?.[wd]?.slot === 'none') continue;
    const actMin = (p.activities || []).filter(a => a.weekdays?.includes(wd)).reduce((s, a) => s + (Number(a.minutes) || 0), 0);
    if (Math.min(minutes, budget) + actMin > budget && actMin > 0) continue;
    const near = [C.addDays(d, -1), C.addDays(d, 1)].some(x => { const o = C.workout(x, uid); return o && o.data.variant !== 'moved' && x !== date; });
    cand.push({ d, near });
  }
  return (cand.find(c => !c.near) || cand[0])?.d || null;
}

const DELOAD_SETS = 0.6;
const DELOAD_WHY = 'Разгрузочная неделя: те же упражнения, подходов около 60 %, рабочие веса на 30-40 % легче, без отказа.';

// → { variant: 'full'|'light'|'recovery'|'move'|'deload', why, adjust: {setsFactor, restFactor}, readiness, to? }
export function workoutVariant(date = C.today()) {
  const uid = store.uid();
  const w = C.workout(date, uid);
  const r = readiness(date, uid);
  const FULL = { setsFactor: 1, restFactor: 1 }, LIGHT = { setsFactor: 0.6, restFactor: 1.25 }, REC = { setsFactor: 0, restFactor: 1 };
  if (w && (hasLogs(w.data) || w.data.done)) {
    const v = ['light', 'recovery', 'deload'].includes(w.data.variant) ? w.data.variant : 'full';
    return { variant: v, why: 'Тренировка уже начата - продолжаем как есть.', adjust: v === 'light' || v === 'deload' ? LIGHT : v === 'recovery' ? REC : FULL, readiness: r };
  }
  const reasons = r.reasons.filter(x => x !== 'хороший сон' && x !== 'вчера восстановление').join(', ');
  const dt = C.dayType(date, uid);
  if (dt === 'sick') return { variant: 'recovery', why: 'День болезни: только лёгкая мобилити, если вообще хочется.', adjust: REC, readiness: r };
  // разгрузочная неделя уже сама по себе облегчение - поверх неё «облегчить» не предлагаем
  if (w?.data.variant === 'deload') return { variant: 'deload', why: DELOAD_WHY, adjust: { setsFactor: DELOAD_SETS, restFactor: 1 }, readiness: r };
  if (r.level === 'high' || r.level === 'normal') {
    return { variant: 'full', why: r.level === 'high' ? 'Готовность высокая - полный объём, можно прибавить вес.' : 'Готовность в норме - полный объём.', adjust: FULL, readiness: r };
  }
  if (r.level === 'low') {
    return { variant: 'light', why: `Готовность снижена (${reasons || 'по совокупности'}) - облегчённый вариант: около 60 % подходов.`, adjust: LIGHT, readiness: r };
  }
  const mins = w ? C.estimateMinutes(w.data) : 45;
  const to = w ? nextFreeDay(date, mins, uid) : null;
  if (to) return { variant: 'move', why: `Сегодня лучше восстановиться (${reasons}). Тренировку переносим на ${to.slice(8)}.${to.slice(5, 7)} - недельный объём сохранится.`, adjust: FULL, readiness: r, to };
  return { variant: 'recovery', why: `Сегодня тело просит отдыха (${reasons}). Вместо тренировки - 20 минут восстановления.`, adjust: REC, readiness: r };
}

// Переписать тренировку дня под вариант. → { ok, variant, to?, reason? }
export async function applyVariant(date = C.today(), variant = 'light') {
  const uid = store.uid();
  const w = C.workout(date, uid);
  if (!w) return { ok: false, reason: 'На этот день тренировки нет.' };
  if (hasLogs(w.data)) return { ok: false, reason: 'Тренировка уже начата - менять поздно.' };
  const d = w.data;
  const orig = d.original || { title: d.title, exercises: d.exercises, warmup: d.warmup || [], cooldown: d.cooldown || [], planned_minutes: d.planned_minutes || null };
  const baseMin = orig.planned_minutes || C.estimateMinutes({ ...orig, planned_minutes: null });
  const id = `wo:${uid}:${date}`;
  const clean = ex => (ex || []).map(x => ({ ...x, log: [] }));
  let data;
  if (variant === 'full') {
    const { original, ...rest } = d;
    data = { ...rest, ...orig, exercises: clean(orig.exercises), variant: 'full' };
    if (!orig.planned_minutes) delete data.planned_minutes;
  } else if (variant === 'light') {
    data = { ...d, original: orig, variant: 'light', title: orig.title,
      exercises: clean(orig.exercises).map(x => ({ ...x, sets: Math.max(1, Math.round((Number(x.sets) || 1) * 0.6)), rest_sec: Math.round((Number(x.rest_sec) || 60) * 1.25) })),
      planned_minutes: Math.max(10, Math.round(baseMin * 0.6)) };
  } else if (variant === 'deload') {
    data = { ...d, original: orig, variant: 'deload', title: orig.title,
      exercises: clean(orig.exercises).map(x => ({ ...x, sets: Math.max(1, Math.round((Number(x.sets) || 1) * DELOAD_SETS)) })),
      planned_minutes: Math.max(10, Math.round(baseMin * 0.65)) };
  } else if (variant === 'recovery') {
    const minutes = clamp(Math.round(baseMin * 0.5), 15, 25);
    const res = pickInternal({ tags: ['recovery', 'mobility'], fallback: ['posture'], minutes, place: 'home', date, seed: `${date}|recovery|${uid}`,
      secAmount: 45, repAmount: 10, maxPerPattern: 99, uid });
    data = { ...d, original: orig, variant: 'recovery', title: `Восстановление вместо «${orig.title}»`, warmup: [], cooldown: [],
      exercises: res.list.map(x => toWorkoutEx(exById(x.id), { sets: Math.min(2, res.rounds), reps: String(x.n), secs: x.n, rest: 0 })),
      planned_minutes: minutes };
  } else if (variant === 'move') {
    const to = nextFreeDay(date, baseMin, uid);
    if (!to) return { ok: false, reason: 'На этой неделе нет свободного дня - лучше облегчённый вариант.' };
    const { original, ...rest } = d;
    await store.put('workout', `wo:${uid}:${to}`, { ...rest, ...orig, exercises: clean(orig.exercises), variant: 'full', moved_from: date, done: false }, to);
    await store.put('workout', id, { ...d, variant: 'moved', moved_to: to }, date);
    await C.refreshDsum(date);
    await C.refreshDsum(to);
    return { ok: true, variant, to };
  } else {
    return { ok: false, reason: `Неизвестный вариант: ${variant}` };
  }
  await store.put('workout', id, data, date);
  await C.refreshDsum(date);
  return { ok: true, variant };
}

// ── разгрузочная неделя ──
// Облегчает тренировки ближайших 7 дней, которые ещё не начаты; оригинал каждой хранится в data.original,
// поэтому отмена возвращает всё как было. Начатые, выполненные и перенесённые не трогаем.
const deloadable = w => w && !w.data.done && !hasLogs(w.data) && !['moved', 'recovery', 'deload'].includes(w.data.variant);

export function deloadWeek(uid = store.uid()) {
  const t = C.today();
  const ws = store.list('workout', uid, r => r.date >= t && r.data.variant === 'deload').sort((a, b) => a.date.localeCompare(b.date));
  return ws.length ? { until: ws[ws.length - 1].date, count: ws.length } : null;
}

export async function applyDeloadWeek(from = C.today(), uid = store.uid()) {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = C.addDays(from, i), w = C.workout(d, uid);
    if (!deloadable(w)) continue;
    const r = await applyVariant(d, 'deload');
    if (r.ok) n++;
  }
  return n;
}

export async function undoDeloadWeek(uid = store.uid()) {
  const t = C.today();
  let n = 0;
  for (const w of store.list('workout', uid, r => r.date >= t && r.data.variant === 'deload')) {
    if (hasLogs(w.data)) continue;
    const r = await applyVariant(w.date, 'full');
    if (r.ok) n++;
  }
  return n;
}

// ── недельный баланс ──
export function weeklyBalance(date = C.today()) {
  const uid = store.uid();
  const b = C.weekActivity(date, uid);
  const budget = Number(prof(uid).time_budget_min) || 60;
  let suggestion;
  const n = Math.round(b.deficitMin / 5) * 5, m = Math.round(b.deficitMin);  // m — как в плитке «добрать»
  if (!b.plannedMin) suggestion = 'Плана на неделю пока нет - любые минуты движения идут в плюс.';
  else if (n < 5) suggestion = 'Недельный объём выполнен. Остальное - по желанию и в удовольствие.';
  else if (!b.daysLeft) suggestion = `Неделя закрывается с недобором около ${m} мин. Не страшно - на следующей держим план.`;
  else if (n <= 25) suggestion = `Добери ${m} мин до конца недели: быстрая ходьба или короткая домашняя тренировка.`;
  else if (n <= Math.min(45, budget)) suggestion = `Добери ${m} мин до конца недели: одна домашняя тренировка закроет разницу.`;
  else {
    const per = Math.min(budget, Math.ceil(n / b.daysLeft / 5) * 5);
    suggestion = `Не хватает ${m} мин. Раскидай по оставшимся дням - примерно по ${per} мин в день.`;
  }
  // кардио — отдельной строкой: недельная норма по целям, засчитываются активности и кардио в тренировках
  let cardio = null;
  try {
    const t = cardioTarget(uid), cw = cardioWeek(date, uid);
    cardio = { target: t.minutes, done: cw.done, left: Math.max(0, t.minutes - cw.done) };
    if (cardio.left >= 10 && b.daysLeft) suggestion += ` Кардио: ещё ${cardio.left} мин до недельной нормы (${t.minutes}).`;
  } catch (e) { cardio = null; }
  return { ...b, suggestion, cardio };
}

// ── прогрессия и разгрузка ──
function range(reps) {
  const m = String(reps || '').match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = parseInt(reps, 10);
  return n ? [n, n] : [8, 12];
}
export function progressionHint(exId, date = C.today(), uid = store.uid()) {
  const ws = store.list('workout', uid, r => r.date < date && (r.data.exercises || []).some(x => x.id === exId && (x.log || []).some(s => s?.done)))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!ws.length) return '';
  const x = ws[0].data.exercises.find(e => e.id === exId && (e.log || []).some(s => s?.done));
  const [lo, hi] = range(x.reps);
  const sets = Number(x.sets) || 1;
  const done = (x.log || []).filter(s => s?.done);
  const w = Math.max(0, ...done.map(s => Number(s.weight) || 0));
  const val = s => Number(s.reps) || lo;
  const top = done.length >= sets && done.every(s => val(s) >= hi);
  const failed = sets - done.length + done.filter(s => val(s) < lo).length;
  const secs = x.unit === 'seconds';
  if (top) {
    if (secs) return `В прошлый раз все подходы по ${hi} с - добавь 5–10 секунд.`;
    const e = exById(exId);
    const heavy = (e?.equipment || []).some(q => q === 'barbell' || q === 'machine' || q === 'cable');
    if (w > 0) return `В прошлый раз ${done.length}×${hi} на ${String(w).replace('.', ',')} кг - добавь ${heavy ? '2,5' : '1–2'} кг.`;
    return `В прошлый раз все подходы на верхней границе - добавь 2 повтора или возьми вариант сложнее.`;
  }
  if (failed * 2 >= sets) {
    return w > 0 ? `В прошлый раз было тяжело (${done.length} из ${sets} подходов) - сбавь вес на 5–10 % и отработай технику.`
      : 'В прошлый раз было тяжело - возьми вариант проще или сделай меньше повторов, но чисто.';
  }
  return w > 0 ? `Держи ${String(w).replace('.', ',')} кг и добивай до ${hi} повторов во всех подходах.`
    : `Держи объём и добивай до ${hi}${secs ? ' с' : ' повторов'} во всех подходах.`;
}

export function needsDeload(uid = store.uid()) {
  const t = C.today();
  const prog = store.list('program', uid).filter(r => r.data.active && r.data.start && r.data.start <= t)
    .sort((a, b) => b.data.start.localeCompare(a.data.start))[0];
  if (prog) {
    const week = Math.floor(C.daysBetween(prog.data.start, t) / 7) + 1;
    if (week >= 5 && week % 5 === 0) return true;
  }
  if (C.plateau(uid).lifts) {
    const rs = [0, 1, 2, 3, 4].map(i => readiness(C.addDays(t, -i), uid).score);
    if (rs.reduce((a, b) => a + b, 0) / rs.length < 55) return true;
  }
  return false;
}

// ════════════════ предпочтения, замены, кардио (SPEC-v3 п. 17–20) ════════════════

// где выполняется тренировка: генератор — дом, программа — её место, иначе по профилю
function placeOfWorkout(wd, uid = store.uid()) {
  if (!wd || wd.source === 'generated') return 'home';
  const pr = wd.program_id ? store.get(wd.program_id)?.data : null;
  return pr?.place || (prof(uid).gym ? 'gym' : 'home');
}
export { placeOfWorkout };

// Альтернативы упражнению: тот же паттерн / категория / зоны, разрешённые местом, инвентарём, ограничениями
// и «не предлагать». → [упражнение каталога] по убыванию похожести
export function alternativesFor(id, { place = 'home', exclude = [], n = 4, uid = store.uid() } = {}) {
  const e = exById(id);
  const skip = new Set([id, ...exclude]);
  const base = pool({ place, uid, level: 3 }).filter(x => !skip.has(x.id));
  if (!e) return base.slice(0, n);
  const lv = userLevel(uid), liked = PF.likedIds(uid), zs = new Set(e._zones || []);
  const KEY_TAGS = ['morning', 'warmup', 'mobility', 'recovery', 'posture', 'neck', 'face', 'cardio', 'core'];
  const sc = x => (x.pattern === e.pattern ? 3 : 0) + (x.category === e.category ? 2 : 0)
    + (x._zones || []).filter(z => zs.has(z)).length * 0.8 + (x.region === e.region ? 0.5 : 0)
    + KEY_TAGS.filter(t => e._tags.has(t) && x._tags.has(t)).length * 0.6
    + ([e.easier, e.harder].includes(x.id) || [x.easier, x.harder].includes(id) ? 1 : 0)
    + (liked.has(x.id) ? 0.8 : 0) + (x.unit === e.unit ? 0.3 : 0)
    - Math.abs((Number(x.level) || 1) - (Number(e.level) || 1)) * 0.4 - ((Number(x.level) || 1) > lv ? 1.5 : 0)
    - (e.impact !== 'high' && x.impact === 'high' ? 1 : 0) + rnd(id + '|' + x.id) * 0.2;
  return base.filter(x => x.pattern === e.pattern || x.category === e.category || (x._zones || []).some(z => zs.has(z)))
    .map(x => [x, sc(x)]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);
}

// контекст упражнения на экране: { kind: 'routine', module, date, i } | { kind: 'workout', date, i } | { kind: 'warmup'|'cooldown', date, i }
export function ctxInfo(ctx, uid = store.uid()) {
  if (!ctx) return null;
  if (ctx.kind === 'routine') {
    const rec = store.get(`routine:${uid}:${ctx.date}:${ctx.module}`);
    const exs = rec?.data.exercises || [];
    return rec && exs[ctx.i] ? { id: exs[ctx.i].id, place: 'home', others: exs.map(x => x.id) } : null;
  }
  const w = C.workout(ctx.date, uid);
  if (!w) return null;
  const list = ctx.kind === 'workout' ? (w.data.exercises || []).map(x => x.id) : (w.data[ctx.kind] || []);
  const id = list[ctx.i];
  return id ? { id, place: placeOfWorkout(w.data, uid), others: [...list, ...(w.data.warmup || []), ...(w.data.cooldown || []), ...(w.data.exercises || []).map(x => x.id)] } : null;
}
export function alternativesIn(ctx, n = 4, uid = store.uid()) {
  const inf = ctxInfo(ctx, uid);
  return inf ? alternativesFor(inf.id, { place: inf.place, exclude: inf.others, n, uid }) : [];
}

// Заменить упражнение в текущей разминке/тренировке; отметки и логи остальных упражнений не трогаем.
export async function swapExercise(ctx, to, uid = store.uid()) {
  const e = exById(to);
  if (!e || !ctx) return null;
  if (ctx.kind === 'routine') {
    const id = `routine:${uid}:${ctx.date}:${ctx.module}`;
    const rec = store.get(id);
    const exs = structuredClone(rec?.data.exercises || []);
    const cur = exs[ctx.i];
    if (!cur) return null;
    const old = exById(cur.id), cfg = MODULES[ctx.module] || MODULES.morning;
    const amount = old && old.unit === e.unit ? cur.amount : e.unit === 'seconds' ? `${cfg.sec || 30} с` : `${cfg.reps || 10} раз`;
    exs[ctx.i] = { id: to, amount, per_side: !!e.per_side, done: false, swapped_from: cur.id };
    await store.patch(id, { exercises: exs, done: exs.every(x => x.done) });
    await C.refreshDsum(ctx.date);
    return e;
  }
  const w = C.workout(ctx.date, uid);
  if (!w) return null;
  const data = structuredClone(w.data);
  if (ctx.kind === 'warmup' || ctx.kind === 'cooldown') {
    if (!data[ctx.kind]?.[ctx.i]) return null;
    data[ctx.kind][ctx.i] = to;
  } else {
    const cur = data.exercises?.[ctx.i];
    if (!cur) return null;
    const old = exById(cur.id);
    const same = old && old.unit === e.unit;
    const x = toWorkoutEx(e, { sets: cur.sets, reps: same ? cur.reps : repsRange(userLevel(uid)), secs: 30, rest: cur.rest_sec ?? 60 });
    if (same) x.reps = cur.reps; else if (e.unit === 'seconds') x.reps = '30-45 с';
    data.exercises[ctx.i] = { ...x, ...(cur.sets_base ? { sets_base: cur.sets_base } : {}), swapped_from: cur.id };
  }
  await store.put('workout', w.id, data, ctx.date);
  await C.refreshDsum(ctx.date);
  return e;
}

// «Не предлагать» (+ сразу заменить в текущем списке, если он указан) → { alt } — на что заменили
export async function excludeExercise(id, reason = 'other', ctx = null, via = '') {
  let alt = null;
  if (ctx) {
    const a = alternativesIn(ctx, 1)[0];
    await PF.exclude(id, reason, via);
    if (a) alt = await swapExercise(ctx, a.id);
  } else await PF.exclude(id, reason, via);
  return { alt };
}

// где сегодня стоит упражнение (не выполненное): для замены из чата и с «Сегодня»
export function findToday(id, date = C.today(), uid = store.uid()) {
  for (const m of Object.keys(MODULES)) {
    const exs = store.get(`routine:${uid}:${date}:${m}`)?.data.exercises || [];
    const i = exs.findIndex(x => x.id === id && !x.done);
    if (i >= 0) return { kind: 'routine', module: m, date, i };
  }
  const w = C.workout(date, uid);
  if (w && !w.data.done) {
    const i = (w.data.exercises || []).findIndex(x => x.id === id && !(x.log || []).some(s => s?.done));
    if (i >= 0) return { kind: 'workout', date, i };
    for (const k of ['warmup', 'cooldown']) { const j = (w.data[k] || []).indexOf(id); if (j >= 0) return { kind: k, date, i: j }; }
  }
  return null;
}
// сигнал тренера «заменить на X»: X — в любимые, прежнее — «не предлагать» (пропускаю), и замена в сегодняшнем списке
export async function replaceExercise(id, to) {
  const ctx = findToday(id);
  await PF.exclude(id, 'skipped', 'signal');
  if (to) await PF.setLike(to, true);
  if (ctx && to) await swapExercise(ctx, to);
}

// ── неявный сигнал: упражнение систематически не отмечают, хотя соседние в том же списке сделаны ──
// → [{ id, name, skips, of, where: 'routine'|'workout', place, alt }] — сначала самые «пропускаемые»
export function skipSignals(uid = store.uid(), date = C.today()) {
  const pr = PF.exPrefs(uid);
  const seen = new Map();
  const push = (id, d, done, where, place) => { if (!seen.has(id)) seen.set(id, []); seen.get(id).push({ d, done, where, place }); };
  const from = C.addDays(date, -35);
  for (const r of store.list('routine', uid, r => r.date >= from && r.date < date)) {
    const xs = r.data.exercises || [];
    if (!xs.some(x => x.done)) continue;          // ничего не сделано — это пропуск дня, а не упражнения
    for (const x of xs) push(x.id, r.date, !!x.done, 'routine', 'home');
  }
  for (const r of store.list('workout', uid, r => r.date >= from && r.date < date && r.data.variant !== 'moved')) {
    const xs = r.data.exercises || [];
    const did = x => (x.log || []).some(s => s?.done);
    if (!xs.some(did)) continue;
    for (const x of xs) push(x.id, r.date, did(x), 'workout', placeOfWorkout(r.data, uid));
  }
  const out = [];
  for (const [id, arr] of seen) {
    if (id in pr.exclude) continue;
    const since = pr.keep[id]?.date;
    const recent = arr.filter(a => !since || a.d > since).sort((a, b) => b.d.localeCompare(a.d)).slice(0, 5);
    const skips = recent.filter(a => !a.done).length;
    if (skips < 3 || skips * 2 <= recent.length) continue;
    const e = exById(id);
    if (!e) continue;
    const where = recent[0].where, place = recent[0].place;
    const alt = alternativesFor(id, { place, n: 1, uid })[0] || null;
    out.push({ id, name: e.name, skips, of: recent.length, where, place, alt: alt ? { id: alt.id, name: alt.name } : null });
  }
  return out.sort((a, b) => b.skips - a.skips || b.skips / b.of - a.skips / a.of);
}

// ── кардио ──
// недельная норма: из норм (intensity.cardio_minutes), иначе по цели: сброс ~150, поддержание ~120, набор ~60
export function cardioTarget(uid = store.uid()) {
  const t = Number(C.target(uid)?.intensity?.cardio_minutes);
  if (t > 0) return { minutes: Math.round(t), source: 'norms' };
  const dir = C.goalDir(uid);
  let m = dir === 'down' ? 150 : dir === 'up' ? 60 : 120;
  const extra = goalEffects(uid)?.cardio_extra || 0;
  if (extra >= 60) m = Math.max(m, 150);
  return { minutes: m, source: 'goal' };
}
const isCardioEx = e => e && (e.category === 'cardio' || e._tags?.has('cardio'));
// кардио-минуты за день: активности с кардио (лёгкая интенсивность — наполовину) + кардио-упражнения тренировки
export function cardioMinutesOn(date, uid = store.uid()) {
  let m = 0;
  for (const r of store.byDate('activity', date, uid)) {
    const a = r.data;
    if (!(a.cardio || PF.isCardioActivity(a.type))) continue;
    m += (Number(a.minutes) || 0) * (a.intensity === 'low' && !a.cardio ? 0.5 : 1);   // запланированное тренером кардио — полностью
  }
  const w = C.workout(date, uid);
  if (w && w.data.variant !== 'moved') {
    for (const x of w.data.exercises || []) {
      const e = exById(x.id);
      if (!isCardioEx(e)) continue;
      const n = (x.log || []).filter(s => s?.done).length;
      if (!n) continue;
      const mm = /мин/.test(String(x.reps)) ? parseInt(x.reps, 10) : null;
      m += mm ? mm * n : n * (e.unit === 'seconds' ? (parseInt(x.reps, 10) || 40) : 40) / 60;
    }
  }
  return Math.round(m);
}
export function cardioWeek(date = C.today(), uid = store.uid()) {
  const mon = C.mondayOf(date);
  let done = 0;
  for (let d = mon; d <= date; d = C.addDays(d, 1)) done += cardioMinutesOn(d, uid);
  return { done, today: cardioMinutesOn(date, uid), monday: mon };
}
// тяжёлые ноги в этот день: ≥ 2 силовых на низ в тренировке или активность с высокой нагрузкой на ноги
function heavyLegs(date, uid) {
  const w = C.workout(date, uid);
  if (w && w.data.variant !== 'moved' && w.data.variant !== 'recovery') {
    const n = (w.data.exercises || []).filter(x => { const e = exById(x.id); return e && e.region === 'lower' && e.category === 'strength'; }).length;
    if (n >= 2) return true;
  }
  const acts = store.getMeta('activities', []) || [];
  return store.byDate('activity', date, uid).some(r => r.data.intensity === 'high' && (acts.find(a => a.id === r.data.type)?.zones || []).includes('legs'));
}
export const CARDIO_ZONE = { low: 'спокойно: можно свободно разговаривать', mid: 'зона 2: дыхание чаще, говорить можно фразами', high: 'интервалы: 1 мин быстро, 2 мин спокойно' };
const lc = s => (s ? s[0].toLowerCase() + s.slice(1) : s);
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; };

// План кардио на день: → { target, done, doneToday, left, daysLeft, today: {kind, name, place, minutes, intensity, zone,
//   act, eq, generator, finisher, optional, done, reason}, alternatives: [...], note, weather, season, approx }
export function cardioPlan(date = C.today(), uid = store.uid()) {
  const p = prof(uid);
  if (!p.setup_done) return null;
  const tg = cardioTarget(uid), wk = cardioWeek(date, uid);
  const left = Math.max(0, tg.minutes - wk.done), daysLeft = 7 - C.weekday(date);
  const weather = PF.weatherFor(date, uid);
  const base = { target: tg.minutes, targetSource: tg.source, done: wk.done, doneToday: wk.today, left, daysLeft,
    season: PF.season(date, uid), weather, approx: !weather, today: null, alternatives: [], note: '' };
  const dt = C.dayType(date, uid);
  if (dt === 'sick') return { ...base, note: 'День болезни - кардио не нужно.' };
  if (!left) return { ...base, note: `Недельная норма кардио выполнена: ${wk.done} из ${tg.minutes} мин.` };
  const sessions = clamp(Math.ceil(left / 30), 1, daysLeft);
  let per = clamp(Math.round(left / sessions / 5) * 5, 10, 60);
  const r = readiness(date, uid);
  let intensity = 'mid';
  if (r.level === 'low') { intensity = 'low'; per = Math.max(10, Math.round(per * 0.7 / 5) * 5); }
  if (r.level === 'rest' || dt === 'rest') { intensity = 'low'; per = Math.min(per, 20); }
  if (r.level === 'high' && (goalEffects(uid)?.cardio_extra || 0) >= 60) intensity = 'high';
  const heavy = heavyLegs(date, uid), heavyY = heavyLegs(C.addDays(date, -1), uid);
  const optional = heavy && daysLeft - 1 >= sessions && wk.today < 10;
  if (optional) { intensity = 'low'; per = Math.min(per, 15); }

  const cp = PF.cardioPrefs(uid), likes = new Set(cp.likes), places = new Set(cp.places);
  const homeEq = PF.homeEquipment(uid), missing = PF.gymMissing(uid);
  const w = C.workout(date, uid);
  const wPlace = w && w.data.variant !== 'moved' ? placeOfWorkout(w.data, uid) : null;
  const gymDay = !!p.gym && (wPlace === 'gym' || (!w && (p.weekdays || []).includes(C.weekday(date))));
  const noImpact = NO_IMPACT.some(x => excludedFor(uid).has(x));
  const yTypes = new Set(store.byDate('activity', C.addDays(date, -1), uid).map(a => a.data.type));
  const season = base.season;
  const opts = [], blocked = [];
  for (const k of PF.cardioKinds()) {
    if (k.extra && !likes.has(k.id)) continue;
    if (k.impact === 'high' && (noImpact || heavy || heavyY || intensity === 'low')) continue;
    for (const pl of k.places) {
      if (pl !== 'indoor' && !places.has(pl)) continue;
      let s = 0;
      if (pl === 'gym') { if (!p.gym || (k.eq && missing.has(k.eq)) || (!k.eq)) continue; s += gymDay ? 1.5 : -0.6; }
      else if (pl === 'home') { if (k.eq && !homeEq.has(k.eq)) continue; s += k.eq ? 1.2 : 0; if (k.generator) s -= 0.4; }
      else if (pl === 'indoor') { if (!likes.has(k.id)) continue; }
      else if (pl === 'outdoor') {
        const o = PF.outdoorOk(k, date, uid);
        if (!o.ok) { blocked.push({ kind: k, why: o.why }); continue; }
        s += { summer: 0.9, spring: 0.6, autumn: 0.2, winter: -0.8 }[season] ?? 0;
        if (o.approx) s -= 0.3;
        if (o.penalty) { s -= o.penalty; if (o.penalty >= 2) blocked.push({ kind: k, why: o.why }); }
      }
      if (likes.has(k.id)) s += 3;
      if (yTypes.has(k.act) || yTypes.has(k.id)) s -= 1;
      if ((heavy || heavyY) && k.impact === 'low') s += 0.4;
      s += rnd(`${date}|${k.id}|${pl}`) * 0.4;
      opts.push({ k, pl, s });
    }
  }
  opts.sort((a, b) => b.s - a.s);
  const pickOut = ({ k, pl }) => ({ kind: k.id, name: k.name, place: pl, act: k.act, eq: k.eq,
    generator: pl === 'home' && (k.generator || (k.eq && (k.ex || []).some(id => exById(id)))), liked: likes.has(k.id) });
  const best = opts[0];
  if (!best) return { ...base, note: 'Нет подходящего кардио: отметьте в профиле, что есть дома, и любимые виды.' };
  const seenK = new Set([best.k.id]);
  const alternatives = [];
  for (const o of opts.slice(1)) { if (seenK.has(o.k.id)) continue; seenK.add(o.k.id); alternatives.push(pickOut(o)); if (alternatives.length >= 3) break; }
  const finisher = best.pl === 'gym' && wPlace === 'gym' && !w.data.done;
  const where = finisher ? 'после тренировки' : PF.PLACE_NAME[best.pl];
  let reason;
  if (optional) reason = `Сегодня тяжёлые ноги - кардио лучше завтра. Если хочется подвигаться: ${lc(best.k.name)} ${per} мин спокойно.`;
  else {
    const whereTxt = best.pl === 'home' && /дома/.test(best.k.name) ? '' : ` ${where}`;
    reason = `До недельной нормы кардио осталось ${left} мин - ${lc(best.k.name)} ${per} мин${whereTxt} сегодня`;
    if (sessions >= 2 && daysLeft >= 2) reason += sessions === 2 ? ' и завтра' : ` и ещё ${sessions - 1} ${plural(sessions - 1, 'раз', 'раза', 'раз')} на неделе`;
    reason += '.';
  }
  const coldBlock = blocked.find(b => likes.has(b.kind.id)) || (best.pl !== 'outdoor' ? blocked.find(b => b.kind.id === 'walk_fast' || b.kind.id === 'running') : null);
  if (coldBlock && best.pl !== 'outdoor' && coldBlock.why) reason += ` На улице сейчас не лучший вариант (${coldBlock.why}).`;
  const today = { ...pickOut(best), minutes: per, intensity, zone: CARDIO_ZONE[intensity], finisher, optional, done: wk.today >= per, reason };
  return { ...base, today, alternatives };
}

// ── реплики тренера: кардио на «Сегодня» и сигнал «упражнение не заходит» в чате ──
const SIG_TEXT = {
  soft: (s, alt) => `Заметил: «${s.name}» ${s.skips} раза из ${s.of} осталось без отметки, хотя остальное ты делаешь. Может, оно просто неудобное? ${alt ? `Могу заменить на «${alt}».` : 'Могу убрать его из предложений.'}`,
  coach: (s, alt) => `«${s.name}» пропущено ${s.skips} раза из ${s.of} при выполненных соседних. Похоже, не заходит - ${alt ? `заменим на «${alt}»?` : 'уберём из предложений?'}`,
  sergeant: (s, alt) => `«${s.name}» - ${s.skips} пропуска из ${s.of}, а остальное сделано. Саботаж или неудобно? ${alt ? `Предлагаю замену: «${alt}».` : 'Могу снять его с довольствия.'}`,
};
C.extend?.('lines', (now, uid) => {
  const d = C.ymd(now);
  if (now.getHours() >= 21) return [];
  const cp = cardioPlan(d, uid);
  if (!cp?.today || cp.today.done || cp.today.optional || cp.left < 15) return [];
  return [{ event: 'cardio_plan', mood: 'info', text: cp.today.reason, pri: 57 }];
});
C.extend?.('rules', (now, uid) => {
  const s = skipSignals(uid, C.ymd(now))[0];
  if (!s) return [];
  const tone = prof(uid).tone || 'coach';
  const text = (SIG_TEXT[tone] || SIG_TEXT.coach)(s, s.alt?.name);
  const actions = [
    ...(s.alt ? [{ id: 'swap', label: `Заменить на «${s.alt.name}»`, kind: 'local_ex_swap', params: { id: s.id, to: s.alt.id } }] : []),
    { id: 'excl', label: 'Не предлагать', kind: 'local_ex_exclude', params: { id: s.id } },
    { id: 'keep', label: 'Оставить', kind: 'local_ex_keep', params: { id: s.id } },
  ].map(a => ({ ...a, status: 'offered', local: true }));
  return [{ rule: `ex_skip_${s.id}`, text, mood: 'info', actions }];
});
