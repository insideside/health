// Цели v3: не только вес. Цель-показатель — «талия 94 → 88 см», «отжимания 15 → 30», «сон 6,5 → 7,5 ч».
//
// Всё считается на клиенте и офлайн: каталог показателей, текущее значение из записей (body, mtest,
// логи тренировок, чек-лист, сон, еда), прогресс и тренд, честная оценка реалистичности срока,
// влияние целей на тренировки и питание (effects → plan.js), короткие реплики для тренера (lines).
// Темпы — средние по статистике для пола и уровня подготовки; у конкретного человека бывает иначе,
// поэтому в интерфейсе они подписаны как ориентир.
//
// Модель (goal:{uid}.data.goals[]): { type: 'metric', metric, from, to, unit, deadline?, priority, since }.
// Качественные цели v2 ({type: lose_fat|gain_muscle|tone|…}) живут в том же списке и тоже влияют на effects().
import * as store from './store.js';
import * as C from './coach.js';

// ── кэш на такт (как в coach.js): функции зовутся на каждой перерисовке ──
let TICK = null;
function memo(key, fn) {
  if (!TICK) { TICK = new Map(); queueMicrotask(() => { TICK = null; }); }
  if (TICK.has(key)) return TICK.get(key);
  const v = fn();
  TICK.set(key, v);
  return v;
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const numv = v => (v === '' || v == null || Number.isNaN(Number(String(v).replace(',', '.'))) ? null : Number(String(v).replace(',', '.')));
const prof = uid => store.get(`profile:${uid}`)?.data || {};
const goalRec = uid => store.get(`goal:${uid}`)?.data || {};
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
}

export const LEVELS = ['comfortable', 'moderate', 'aggressive', 'unrealistic'];
export const LEVEL_RU = { comfortable: 'комфортно', moderate: 'умеренно', aggressive: 'агрессивно', unrealistic: 'нереально' };
export const GROUPS = [['body', 'Обхваты'], ['comp', 'Вес и состав тела'], ['perf', 'Сила и выносливость'], ['habit', 'Привычки']];

// ── каталог показателей ──
// src: body — поле записи body (fields — среднее левой и правой); weight — вес; test — тест/лог (mtest + подходы);
//      habit — среднее за 7 дней из чек-листа, сна или еды.
// dirs — допустимые направления; rates(ctx) → [комфортно, умеренно, агрессивно] — верхние границы темпа в неделю
//      в единицах показателя; всё, что быстрее «агрессивно», — нереально.
// lim — физиологические границы цели (ниже/выше — нереально при любом сроке).
// eff — как цель меняет план: fat/gain — сдвиг калорий, zones/patterns — множители объёма, cardio — мин/нед.
const PER_MONTH = 1 / 4.35;
const levelK = (lv, a = 1, b = 0.5, c = 0.25) => (lv <= 1 ? a : lv === 2 ? b : c);

// «сброс обхвата» — идёт только вместе с общим жиром; крупнее обхват — быстрее уходит
function downRates(base, femK = 0.85, ref = null) {
  return ({ sex, cur }) => {
    let k = sex === 'f' ? femK : 1;
    if (ref && cur) k *= clamp(cur / (sex === 'f' ? ref[1] : ref[0]), 0.8, 1.4);
    return base.map(x => x * k);
  };
}
// «рост обхвата» мышцами: см в месяц у новичка-мужчины, женщинам и опытным — медленнее; на дефиците — вдвое медленнее
function upRates(perMonth, femK = 0.5) {
  return ({ sex, level, cutting }) => perMonth.map(x => x * PER_MONTH * (sex === 'f' ? femK : 1) * levelK(level) * (cutting ? 0.6 : 1));
}

const CIRC_DOWN_NOTE = 'Обхват уходит только вместе с общим жиром: дефицит калорий и шаги. Упражнения на зону жир точечно не сжигают - они дают форму.';
const MUSCLE_UP_NOTE = 'Рост обхвата - это мышцы: прогрессия веса в упражнениях на зону, белок и калории не ниже поддержки. На дефиците растёт медленнее.';

const M = [
  // обхваты
  { id: 'waist', label: 'Талия', acc: 'талию', group: 'body', unit: 'см', src: 'body', fields: ['waist'], dirs: ['down'], step: 0.5,
    how: 'по самому узкому месту, утром до еды', lim: { down: ({ height }) => (height ? height * 0.38 : 55) },
    rates: { down: downRates([0.35, 0.7, 1.0], 0.85, [90, 78]) }, note: { down: CIRC_DOWN_NOTE },
    eff: { down: { fat: 1, cardio: 30, zones: { abs: 1.15, sides: 1.15 } } }, hint: { down: 'Проверь дефицит калорий и шаги - талия идёт за ними.' } },
  { id: 'belly', label: 'Живот', acc: 'живот', group: 'body', unit: 'см', src: 'body', fields: ['belly'], dirs: ['down'], step: 0.5,
    how: 'по линии пупка, на выдохе, не втягивая', lim: { down: ({ height }) => (height ? height * 0.4 : 60) },
    rates: { down: downRates([0.4, 0.8, 1.1], 0.85, [95, 85]) }, note: { down: CIRC_DOWN_NOTE },
    eff: { down: { fat: 1, cardio: 30, zones: { abs: 1.2, sides: 1.15 } } }, hint: { down: 'Живот уходит от дефицита и шагов, а не от скручиваний.' } },
  { id: 'hips', label: 'Бёдра (таз)', acc: 'бёдра', group: 'body', unit: 'см', src: 'body', fields: ['hips'], dirs: ['down', 'up'], step: 0.5,
    how: 'по самым широким точкам ягодиц',
    rates: { down: downRates([0.2, 0.45, 0.7], 0.9), up: upRates([0.3, 0.6, 1.0], 0.9) }, note: { down: CIRC_DOWN_NOTE, up: 'Объём таза растёт за счёт ягодиц: мосты, тяги, выпады с прогрессией веса.' },
    eff: { down: { fat: 1, cardio: 20, zones: { glutes: 1.1, legs: 1.1 } }, up: { gain: 1, zones: { glutes: 1.6, legs: 1.2 }, patterns: { hinge: 1.4, lunge: 1.2 } } },
    hint: { down: 'Дефицит и шаги - главное.', up: 'Добавь подход на ягодичный мост или тягу и прибавляй вес.' } },
  { id: 'chest', label: 'Грудь', acc: 'грудь', group: 'body', unit: 'см', src: 'body', fields: ['chest'], dirs: ['up', 'down'], step: 0.5,
    how: 'по самым выступающим точкам',
    rates: { down: downRates([0.2, 0.4, 0.6]), up: upRates([0.5, 1.0, 1.5]) }, note: { down: CIRC_DOWN_NOTE, up: MUSCLE_UP_NOTE },
    eff: { down: { fat: 1, cardio: 20 }, up: { gain: 1, zones: { chest: 1.5, shoulders: 1.15, back: 1.1 }, patterns: { push_h: 1.4 } } },
    hint: { down: 'Дефицит и шаги.', up: 'Жимы и отжимания - с прогрессией, белок каждый день.' } },
  { id: 'neck', label: 'Шея', acc: 'шею', group: 'body', unit: 'см', src: 'body', fields: ['neck'], dirs: ['down'], step: 0.5,
    how: 'под кадыком, лента горизонтально',
    rates: { down: downRates([0.07, 0.15, 0.25]) }, note: { down: 'Шея и подбородок худеют вместе со всем телом; упражнения дают тонус и осанку.' },
    eff: { down: { fat: 1, cardio: 20, zones: { neck: 1.2 } } }, hint: { down: 'Общий дефицит и модуль «шея и скулы».' } },
  { id: 'arms', label: 'Руки (среднее)', acc: 'руки', group: 'body', unit: 'см', src: 'body', fields: ['arm_l', 'arm_r'], dirs: ['up', 'down'], step: 0.5,
    how: 'в самой широкой части расслабленного плеча, обе руки',
    rates: { down: downRates([0.07, 0.15, 0.25]), up: upRates([0.5, 0.8, 1.2]) }, lim: { upDelta: 6 }, note: { down: CIRC_DOWN_NOTE, up: MUSCLE_UP_NOTE },
    eff: { down: { fat: 1, cardio: 20 }, up: { gain: 1, zones: { arms: 1.6, shoulders: 1.1, back: 1.1 }, patterns: { isolation: 1.3, pull_v: 1.15, push_v: 1.1 } } },
    hint: { down: 'Дефицит и шаги.', up: 'Добавь подход на бицепс и трицепс, прибавляй вес и следи за белком.' } },
  { id: 'arm_r', label: 'Правая рука', acc: 'правую руку', group: 'body', unit: 'см', src: 'body', fields: ['arm_r'], dirs: ['up', 'down'], step: 0.5, detail: true,
    how: 'в самой широкой части расслабленного плеча', rates: { down: downRates([0.07, 0.15, 0.25]), up: upRates([0.5, 0.8, 1.2]) }, lim: { upDelta: 6 },
    note: { down: CIRC_DOWN_NOTE, up: MUSCLE_UP_NOTE }, eff: { down: { fat: 1 }, up: { gain: 1, zones: { arms: 1.6 }, patterns: { isolation: 1.3 } } } },
  { id: 'arm_l', label: 'Левая рука', acc: 'левую руку', group: 'body', unit: 'см', src: 'body', fields: ['arm_l'], dirs: ['up', 'down'], step: 0.5, detail: true,
    how: 'в самой широкой части расслабленного плеча', rates: { down: downRates([0.07, 0.15, 0.25]), up: upRates([0.5, 0.8, 1.2]) }, lim: { upDelta: 6 },
    note: { down: CIRC_DOWN_NOTE, up: MUSCLE_UP_NOTE }, eff: { down: { fat: 1 }, up: { gain: 1, zones: { arms: 1.6 }, patterns: { isolation: 1.3 } } } },
  { id: 'thighs', label: 'Бёдра-ноги (среднее)', acc: 'бёдра', group: 'body', unit: 'см', src: 'body', fields: ['thigh_l', 'thigh_r'], dirs: ['down', 'up'], step: 0.5,
    how: 'на 15 см выше колена, обе ноги',
    rates: { down: downRates([0.15, 0.3, 0.5], 0.9), up: upRates([0.4, 0.8, 1.2], 0.7) }, note: { down: CIRC_DOWN_NOTE, up: MUSCLE_UP_NOTE },
    eff: { down: { fat: 1, cardio: 20 }, up: { gain: 1, zones: { legs: 1.5, glutes: 1.2 }, patterns: { squat: 1.3, lunge: 1.3 } } },
    hint: { down: 'Дефицит и шаги.', up: 'Приседания и выпады с прогрессией веса.' } },
  { id: 'calves', label: 'Голени (среднее)', acc: 'голени', group: 'body', unit: 'см', src: 'body', fields: ['calf_l', 'calf_r'], dirs: ['up', 'down'], step: 0.5,
    how: 'в самой широкой части', rates: { down: downRates([0.05, 0.1, 0.15]), up: upRates([0.15, 0.3, 0.45], 0.6) },
    note: { down: CIRC_DOWN_NOTE, up: 'Голени растут медленнее всего - во многом это генетика.' },
    eff: { down: { fat: 1 }, up: { zones: { legs: 1.2 } } } },
  // вес и состав
  { id: 'weight', label: 'Вес', acc: 'вес', group: 'comp', unit: 'кг', src: 'weight', dirs: ['down', 'up'], step: 0.5,
    how: 'утром натощак; в расчёт идёт сглаженный тренд',
    lim: { down: ({ height }) => (height ? 18.5 * (height / 100) ** 2 : 45) },
    // шкала та же, что у норм на сервере: ≤0,5 / 1 / 1,5 % веса в неделю; набор — 0,25 / 0,5 / 0,75 %
    rates: { down: ({ cur }) => [0.005, 0.01, 0.015].map(x => x * (cur || 70)), up: ({ cur, sex }) => [0.0025, 0.005, 0.0075].map(x => x * (cur || 70) * (sex === 'f' ? 0.8 : 1)) },
    note: { down: 'Вес скачет на 0,5–1 кг от воды и соли - смотрим на тренд, а не на одно взвешивание.', up: 'Набор без лишнего жира - не больше 0,5 % веса в неделю.' },
    eff: { down: { fat: 1, cardio: 30 }, up: { gain: 1 } }, hint: { down: 'Проверь калории за неделю и шаги.', up: 'Добавь 200–300 ккал в день и белок.' } },
  { id: 'body_fat_pct', label: 'Процент жира', acc: 'процент жира', group: 'comp', unit: '%', src: 'test', dirs: ['down'], step: 0.5, manual: true,
    how: 'весы с анализатором или калипер - одним прибором и в одно время', lim: { down: ({ sex }) => (sex === 'f' ? 15 : 8) },
    rates: { down: ({ sex }) => [0.15, 0.3, 0.5].map(x => x * (sex === 'f' ? 0.85 : 1)) },
    note: { down: 'Бытовые весы ошибаются на 3–5 %, но тренд одним прибором показывают честно.' },
    eff: { down: { fat: 1, cardio: 30 } }, hint: { down: 'Дефицит, белок и силовые - чтобы уходил жир, а не мышцы.' } },
  // сила и выносливость
  { id: 'pushups_max', label: 'Отжимания', acc: 'отжимания', group: 'perf', unit: 'раз', src: 'test', ex: ['pushup'], dirs: ['up'], step: 1, dec: 0,
    how: 'максимум за один подход, классические, с полной амплитудой',
    rates: { up: ({ sex, level, cur }) => [2, 3, 4].map(x => x * levelK(level, 1, 0.6, 0.35) * (sex === 'f' ? 0.8 : 1) * ((cur || 0) >= 30 ? 0.5 : 1)) },
    note: { up: 'Растёт быстро, если отжиматься часто: 2–3 раза в неделю несколько подходов почти до отказа.' },
    eff: { up: { zones: { chest: 1.3, arms: 1.2, shoulders: 1.1 }, patterns: { push_h: 1.5 } } }, hint: { up: 'Добавь «лесенку» отжиманий в дни без тренировок.' } },
  { id: 'pullups_max', label: 'Подтягивания', acc: 'подтягивания', group: 'perf', unit: 'раз', src: 'test', ex: ['pullup'], dirs: ['up'], step: 1, dec: 0,
    how: 'максимум за подход, из виса на прямых руках, подбородок над перекладиной',
    rates: { up: ({ sex, level, cur }) => ((cur || 0) < 1 ? [0.15, 0.25, 0.4] : [0.5, 1, 1.5]).map(x => x * levelK(level, 1, 0.6, 0.35) * (sex === 'f' ? 0.6 : 1)) },
    note: { up: 'Первое подтягивание обычно занимает 1–3 месяца: негативы, тяги и вис.' },
    eff: { up: { zones: { back: 1.4, arms: 1.2 }, patterns: { pull_v: 1.6, pull_h: 1.2 } } }, hint: { up: 'Негативные подтягивания и тяги 2 раза в неделю.' } },
  { id: 'plank_sec', label: 'Планка', acc: 'планку', group: 'perf', unit: 'с', src: 'test', ex: ['plank'], dirs: ['up'], step: 5, dec: 0,
    how: 'на предплечьях, ровная линия тела, до потери техники',
    rates: { up: ({ level, cur }) => [10, 15, 25].map(x => x * levelK(level, 1, 0.7, 0.5) * ((cur || 0) >= 120 ? 0.5 : 1)) },
    lim: { up: () => 600 }, note: { up: 'Больше 2–3 минут планка почти ничего не добавляет - дальше лучше усложнять.' },
    eff: { up: { zones: { abs: 1.4, sides: 1.1 }, patterns: { core_anti: 1.6 } } }, hint: { up: 'Планка в конце каждой тренировки, +5 с каждый раз.' } },
  { id: 'squat_1rm', label: 'Присед (1ПМ)', acc: 'присед', group: 'perf', unit: 'кг', src: 'test', ex: ['barbell_back_squat'], e1rm: true, dirs: ['up'], step: 2.5,
    how: 'оценка по формуле Эпли из рабочих подходов (до 12 повторов) или ваш тест',
    rates: { up: ({ level, cur }) => (level <= 1 ? [1.5, 2.5, 4] : level === 2 ? [0.5, 1, 1.5] : [0.25, 0.5, 0.75]).map(x => x / 100 * (cur || 40)) },
    note: { up: 'Новичок прибавляет почти каждую неделю; дальше прогресс идёт циклами.' },
    eff: { up: { zones: { legs: 1.4, glutes: 1.2 }, patterns: { squat: 1.6 } } }, hint: { up: 'Приседай 2 раза в неделю и прибавляй 2,5 кг, когда все подходы сделаны.' } },
  { id: 'bench_1rm', label: 'Жим лёжа (1ПМ)', acc: 'жим лёжа', group: 'perf', unit: 'кг', src: 'test', ex: ['barbell_bench_press'], e1rm: true, dirs: ['up'], step: 2.5,
    how: 'оценка по формуле Эпли из рабочих подходов (до 12 повторов) или ваш тест',
    rates: { up: ({ level, cur, sex }) => (level <= 1 ? [1, 2, 3] : level === 2 ? [0.4, 0.8, 1.2] : [0.2, 0.4, 0.6]).map(x => x / 100 * (cur || 30) * (sex === 'f' ? 0.8 : 1)) },
    note: { up: 'Жим растёт медленнее приседа; помогают отжимания на брусьях и трицепс.' },
    eff: { up: { zones: { chest: 1.4, arms: 1.2, shoulders: 1.1 }, patterns: { push_h: 1.6 } } }, hint: { up: 'Жим 2 раза в неделю, трицепс - отдельным упражнением.' } },
  { id: 'run_5k_min', label: 'Бег 5 км', acc: 'время на 5 км', group: 'perf', unit: 'мин', src: 'test', dirs: ['down'], step: 0.5, manual: true,
    how: 'время забега на 5 км (часы или приложение)', lim: { down: ({ sex }) => (sex === 'f' ? 17 : 15) },
    rates: { down: ({ level, cur }) => [0.7, 1.2, 2].map(x => x / 100 * (cur || 30) * levelK(level, 1, 0.6, 0.35)) },
    note: { down: 'Время улучшают 2–3 пробежки в неделю: одна длинная спокойная, одна с ускорениями.' },
    eff: { down: { cardio: 60, zones: { legs: 1.1 }, tags: { cardio: 1.3 } } }, hint: { down: 'Добавь пробежку с ускорениями раз в неделю.' } },
  // привычки (среднее за 7 дней)
  { id: 'steps_avg', label: 'Шаги в день', acc: 'шаги', group: 'habit', unit: 'шагов', src: 'habit', dirs: ['up'], step: 500, dec: 0,
    how: 'среднее за 7 дней по пункту «Шаги» чек-листа', rates: { up: () => [700, 1500, 3000] },
    note: { up: 'Шаги - самый недооценённый способ тратить калории: +2000 шагов ≈ +80–100 ккал в день.' },
    eff: { up: { steps: true } }, hint: { up: 'Прогулка после ужина - +2000 шагов без усилий.' } },
  { id: 'sleep_avg_h', label: 'Сон', acc: 'сон', group: 'habit', unit: 'ч', src: 'habit', dirs: ['up'], step: 0.25,
    how: 'среднее за 7 ночей по записям сна', rates: { up: () => [0.15, 0.3, 0.6] }, lim: { up: () => 9.5 },
    note: { up: 'Сон прибавляют отбоем: на 15 минут раньше каждую неделю.' }, eff: { up: {} }, hint: { up: 'Отбой на 15 минут раньше - и без телефона.' } },
  { id: 'water_avg', label: 'Вода', acc: 'воду', group: 'habit', unit: 'стак.', src: 'habit', dirs: ['up'], step: 1, dec: 1,
    how: 'среднее за 7 дней по пункту «Вода» чек-листа', rates: { up: () => [1, 2, 4] }, lim: { up: () => 16 },
    note: { up: 'Стакан воды к каждому приёму пищи - самый простой способ.' }, eff: { up: {} }, hint: { up: 'Стакан воды к каждой еде.' } },
  { id: 'protein_avg_g', label: 'Белок', acc: 'белок', group: 'habit', unit: 'г/день', src: 'habit', dirs: ['up'], step: 5, dec: 0,
    how: 'среднее за 7 дней по дневнику питания (дни с посчитанной едой)', rates: { up: () => [10, 20, 40] },
    note: { up: 'Белок в каждый приём пищи: творог, яйца, мясо, рыба, бобовые.' }, eff: { up: { protein: true } }, hint: { up: 'Белок в каждый приём пищи.' } },
];
export const CATALOG = M;
const BY_ID = Object.fromEntries(M.map(m => [m.id, m]));
export const metric = id => BY_ID[id] || null;

// ── уровень и контекст ──
// 1 новичок · 2 средний · 3 опытный: по активной программе, иначе по числу сделанных тренировок
export function level(uid = store.uid()) {
  return memo(`glv|${uid}`, () => {
    const pr = store.list('program', uid).find(r => r.data.active);
    const lv = Number(pr?.data.level);
    if (lv >= 1 && lv <= 3) return lv;
    const done = store.list('workout', uid, r => r.data.done).length;
    return done < 24 ? 1 : done < 100 ? 2 : 3;
  });
}

const FAT_DOWN_TYPES = new Set(['lose_fat']);
function goalsOf(g) {
  if (Array.isArray(g)) return g;
  if (g?.goals?.length) return g.goals;
  const out = [];
  if (g?.fat_kg) out.push({ type: 'lose_fat', amount: g.fat_kg, priority: 1 });
  if ((g?.muscle_upper_kg || 0) + (g?.muscle_lower_kg || 0)) out.push({ type: 'gain_muscle', priority: 2 });
  return out;
}
export const dirOf = gl => {
  const f = numv(gl.from), t = numv(gl.to);
  if (f != null && t != null && f !== t) return t < f ? 'down' : 'up';
  return metric(gl.metric)?.dirs[0] || 'down';
};
// в дефиците ли человек: есть цель на сброс (явная или показатель «вниз» из группы тела)
function cutting(list) {
  return list.some(x => FAT_DOWN_TYPES.has(x.type) || (x.type === 'metric' && (metric(x.metric)?.eff?.[dirOf(x)]?.fat) && (Number(x.priority) || 2) <= 2));
}

// ── история и текущее значение ──
const bodyRecs = uid => memo(`gbody|${uid}`, () => store.list('body', uid, r => r.date).sort((a, b) => a.date.localeCompare(b.date)));
const epley = (w, r) => (w > 0 && r > 0 && r <= 12 ? w * (1 + r / 30) : null);
function itemVals(uid, source, days = 56) {
  const it = C.items(uid).find(i => i.data.target_from === source);
  if (!it) return [];
  const t = C.today(), out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = C.addDays(t, -i), v = Number(C.logVal(d, it.id, uid));
    if (v > 0) out.push({ date: d, v });
  }
  return out;
}
function habitDaily(id, uid) {
  if (id === 'steps_avg') return itemVals(uid, 'steps');
  if (id === 'water_avg') return itemVals(uid, 'water');
  const t = C.today(), out = [];
  for (let i = 55; i >= 0; i--) {
    const d = C.addDays(t, -i);
    if (id === 'sleep_avg_h') { const s = C.sleep(d, uid), si = s && C.sleepInfo(s, uid); if (si?.hours) out.push({ date: d, v: si.hours }); }
    if (id === 'protein_avg_g' && i > 0) { const fd = C.foodDay(d, uid); if (fd?.calculated && fd.p > 0) out.push({ date: d, v: fd.p }); }
  }
  return out;
}

// История показателя: [{date, v, src}] по возрастанию даты
export function history(id, uid = store.uid()) {
  return memo(`ghist|${id}|${uid}`, () => {
    const m = metric(id);
    if (!m) return [];
    if (m.src === 'weight') return C.smoothedWeights(uid).map(p => ({ date: p.date, v: p.trend, raw: p.w, src: 'body' }));
    if (m.src === 'body') {
      const out = [];
      for (const r of bodyRecs(uid)) {
        const vs = m.fields.map(f => Number(r.data[f])).filter(v => v > 0);
        if (vs.length) out.push({ date: r.date, v: Math.round(avg(vs) * 10) / 10, src: 'body' });
      }
      return out;
    }
    if (m.src === 'habit') {
      // недельные средние (по воскресеньям) — дневные значения слишком шумные для тренда
      const daily = habitDaily(id, uid);
      const weeks = new Map();
      for (const p of daily) {
        const end = C.addDays(C.mondayOf(p.date), 6);
        if (!weeks.has(end)) weeks.set(end, []);
        weeks.get(end).push(p.v);
      }
      return [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, vs]) => ({ date: date > C.today() ? C.today() : date, v: avg(vs), n: vs.length, src: 'habit' }));
    }
    // test: ручные записи mtest + лучшие подходы из тренировок
    const byDate = new Map();
    const put = (date, v, src) => { const p = byDate.get(date); if (!p || v > p.v || (src === 'mtest' && p.src !== 'mtest')) byDate.set(date, { date, v, src }); };
    for (const r of store.list('mtest', uid, r => r.data.metric === id && r.date)) { const v = Number(r.data.value); if (v > 0) put(r.date, v, 'mtest'); }
    if (id === 'body_fat_pct') for (const r of bodyRecs(uid)) { const v = Number(r.data.body_fat); if (v > 0) put(r.date, v, 'body'); }
    if (m.ex?.length) {
      for (const w of store.list('workout', uid, r => r.date && r.data.exercises?.some(x => m.ex.includes(x.id)))) {
        let best = null;
        for (const x of w.data.exercises) {
          if (!m.ex.includes(x.id)) continue;
          for (const s of x.log || []) {
            if (!s?.done) continue;
            const v = m.e1rm ? epley(Number(s.weight), Number(s.reps)) : Number(s.reps);
            if (v > 0 && (best == null || v > best)) best = v;
          }
        }
        if (best != null) {
          const p = byDate.get(w.date);
          if (!p) byDate.set(w.date, { date: w.date, v: Math.round(best * 10) / 10, src: 'log' });
        }
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  });
}

// → { value, date, src: 'body'|'mtest'|'log'|'habit', approx, n? } | null
export function current(id, uid = store.uid()) {
  return memo(`gcur|${id}|${uid}`, () => {
    const m = metric(id), h = history(id, uid);
    if (!m || !h.length) return null;
    if (m.src === 'habit') {
      const d = habitDaily(id, uid).filter(p => p.date > C.addDays(C.today(), -7));
      if (!d.length) return null;
      return { value: Math.round(avg(d.map(p => p.v)) * 10) / 10, date: d[d.length - 1].date, src: 'habit', n: d.length, approx: d.length < 4 };
    }
    if (m.src === 'test') {
      // лучший результат за последние 4 недели: в подходах редко выкладываются на максимум, поэтому берём максимум
      const from = C.addDays(C.today(), -28);
      const recent = h.filter(p => p.date >= from);
      const pick = recent.length ? recent.reduce((a, b) => (b.v > a.v || (b.v === a.v && b.date > a.date) ? b : a)) : h[h.length - 1];
      if (m.dirs[0] === 'down' && recent.length) {           // время и % жира: берём последнее, а не «лучшее»
        const last = recent[recent.length - 1];
        return { value: last.v, date: last.date, src: last.src, approx: last.src === 'log' };
      }
      return { value: pick.v, date: pick.date, src: pick.src, approx: pick.src === 'log' };
    }
    const last = h[h.length - 1];
    return { value: Math.round(last.v * 10) / 10, date: last.date, src: last.src, approx: false };
  });
}

// наклон (единиц в неделю) методом наименьших квадратов по точкам за `days` дней
function slope(pts, days) {
  const from = C.addDays(C.today(), -days);
  const p = pts.filter(x => x.date >= from);
  if (p.length < 2) return null;
  const xs = p.map(x => C.daysBetween(from, x.date)), ys = p.map(x => x.v);
  if (xs[xs.length - 1] - xs[0] < 10) return null;
  const mx = avg(xs), my = avg(ys);
  let a = 0, b = 0;
  xs.forEach((x, i) => { a += (x - mx) * (ys[i] - my); b += (x - mx) ** 2; });
  return b ? a / b * 7 : null;
}
const TREND_DAYS = { body: 56, weight: 28, test: 42, habit: 42 };

// ── реалистичность ──
function ctxFor(gl, uid, list) {
  const p = prof(uid);
  const cur = numv(gl.from) ?? current(gl.metric, uid)?.value ?? null;
  const w = C.weights(uid).slice(-1)[0]?.w || Number(p.weight) || null;
  return { sex: p.sex === 'f' ? 'f' : 'm', height: Number(p.height) || null, weight: w, level: level(uid), cur, cutting: cutting(list || goalsOf(goalRec(uid))) };
}
export function rates(gl, uid = store.uid(), list) {
  const m = metric(gl.metric), dir = dirOf(gl);
  const fn = m?.rates?.[dir];
  return fn ? fn(ctxFor(gl, uid, list)) : null;
}
const labelFor = (need, r) => (need <= r[0] + 1e-9 ? 'comfortable' : need <= r[1] + 1e-9 ? 'moderate' : need <= r[2] + 1e-9 ? 'aggressive' : 'unrealistic');
const typical = r => (r[0] + r[1]) / 2;

// realism(goal, profile?) → { label, label_ru, need_week, rates, weeks_typical, realistic_deadline, options[], text, warnings[] }
// Работает и для черновика цели (не записанной). Срок — goal.deadline, иначе общий срок цели.
export function realism(gl, profileOrUid, list) {
  const uid = typeof profileOrUid === 'string' ? profileOrUid : store.uid();
  const m = metric(gl.metric);
  const from = numv(gl.from) ?? current(gl.metric, uid)?.value, to = numv(gl.to);
  const res = { label: null, label_ru: '', need_week: null, rates: null, weeks_typical: null, realistic_deadline: null, options: [], text: '', warnings: [] };
  if (!m || from == null || to == null) return res;
  const dir = to < from ? 'down' : to > from ? 'up' : null;
  if (!dir) { res.text = 'Цель равна текущему значению - это цель «удержать».'; return res; }
  if (!m.dirs.includes(dir)) {
    res.label = 'unrealistic'; res.label_ru = LEVEL_RU.unrealistic;
    res.text = dir === 'up' ? `${m.label}: такая цель обычно ставится на уменьшение.` : `${m.label}: такая цель обычно ставится на рост.`;
    return res;
  }
  const r = rates({ ...gl, from }, uid, list);
  res.rates = r;
  const delta = Math.abs(to - from);
  const ctx = ctxFor({ ...gl, from }, uid, list);
  // физиологические границы
  const lim = m.lim?.[dir]?.(ctx);
  if (lim != null && ((dir === 'down' && to < lim) || (dir === 'up' && to > lim))) {
    res.warnings.push(dir === 'down' ? `Ниже ${fmtNum(lim, m)} ${m.unit} - уже за пределами здоровой нормы.` : `Больше ${fmtNum(lim, m)} ${m.unit} - за пределами разумного.`);
    res.label = 'unrealistic'; res.label_ru = LEVEL_RU.unrealistic;
  }
  if (m.lim?.upDelta && dir === 'up' && delta > m.lim.upDelta) res.warnings.push(`+${fmtNum(delta, m)} ${m.unit} - это работа на годы, а не на месяцы. Разбейте на этапы по 1–2 см.`);
  if (ctx.cutting && m.eff?.up?.gain && dir === 'up') res.warnings.push('Одновременно стоит цель на сброс жира - в дефиците мышцы растут заметно медленнее. Темп уже пересчитан с учётом этого.');
  const today = C.today();
  res.weeks_typical = Math.ceil(delta / typical(r));
  res.realistic_deadline = C.addDays(today, res.weeks_typical * 7);
  res.options = ['comfortable', 'moderate', 'aggressive'].map((l, i) => {
    const w = Math.max(1, Math.ceil(delta / r[i]));
    return { label: l, weeks: w, deadline: C.addDays(today, w * 7) };
  });
  const deadline = gl.deadline || goalRec(uid).deadline || null;
  if (deadline) {
    const weeks = Math.max(0.5, C.daysBetween(today, deadline) / 7);
    res.need_week = delta / weeks;
    if (res.label !== 'unrealistic') res.label = labelFor(res.need_week, r);
    res.label_ru = LEVEL_RU[res.label];
    const sign = dir === 'down' ? '−' : '+';
    res.text = `Нужно ${rateText(res.need_week, m, sign)} - ${res.label_ru}.`
      + (res.label === 'unrealistic' || res.label === 'aggressive' ? ` Реалистично - к ${fmtDate(res.realistic_deadline)} (≈ ${res.weeks_typical} ${plural(res.weeks_typical, 'неделя', 'недели', 'недель')}).` : '');
  } else {
    res.text = `Без срока: в среднем темпе ≈ ${res.weeks_typical} ${plural(res.weeks_typical, 'неделя', 'недели', 'недель')} - к ${fmtDate(res.realistic_deadline)}.`;
  }
  return res;
}

// ── прогресс ──
// progress(goal) → { from, to, current, pct, done, trend (ед./нед.), need_week, eta, status, label, change, since_days, cur }
// status: done | ahead | on | behind | early (мало данных для тренда) | nodata
export const STATUS_RU = { done: 'цель достигнута', ahead: 'опережаете', on: 'по плану', behind: 'отстаёте', early: 'рано судить', nodata: 'нет данных' };
export function progress(gl, uid = store.uid()) {
  const m = metric(gl.metric);
  const cur = current(gl.metric, uid);
  const since = gl.since || null;
  const from = numv(gl.from) ?? history(gl.metric, uid).find(p => !since || p.date >= since)?.v ?? cur?.value ?? null;
  const to = numv(gl.to);
  const out = { metric: m, from, to, current: cur?.value ?? null, cur, pct: 0, done: 0, trend: null, need_week: null, eta: null,
    status: 'nodata', label: STATUS_RU.nodata, change: null, since_days: since ? C.daysBetween(since, C.today()) : null };
  if (!m || from == null || to == null || cur == null) return out;
  const dir = to < from ? -1 : 1, total = Math.abs(to - from) || 1;
  out.done = (cur.value - from) * dir;
  out.pct = clamp(out.done / total, 0, 1);
  out.change = cur.value - from;
  const h = history(gl.metric, uid);
  out.trend = slope(since ? h.filter(p => p.date >= C.addDays(since, -7)) : h, TREND_DAYS[m.src] || 42) ?? slope(h, 120);
  const left = Math.abs(to - cur.value);
  const deadline = gl.deadline || goalRec(uid).deadline || null;
  const r = rates(gl, uid);
  if (deadline && deadline > C.today()) out.need_week = left / Math.max(0.5, C.daysBetween(C.today(), deadline) / 7);
  else if (r) out.need_week = typical(r);
  const moving = out.trend != null ? out.trend * dir : null;            // > 0 — в сторону цели
  if (moving > 0) out.eta = C.addDays(C.today(), Math.ceil(left / moving * 7));
  if ((cur.value - to) * dir >= 0) out.status = 'done';
  else if (moving == null) {
    // тренда ещё нет: сравним с плановой линией, если прошло хотя бы 2 недели
    if (deadline && since && out.since_days >= 14) {
      const plan = clamp(out.since_days / Math.max(1, C.daysBetween(since, deadline)), 0, 1);
      out.status = out.pct >= plan * 1.15 ? 'ahead' : out.pct >= plan * 0.75 ? 'on' : 'behind';
    } else out.status = 'early';
  } else if (!out.need_week) out.status = moving > 0 ? 'on' : 'behind';
  else out.status = moving >= out.need_week * 1.25 ? 'ahead' : moving >= out.need_week * 0.75 ? 'on' : 'behind';
  out.label = STATUS_RU[out.status];
  return out;
}

// ── влияние целей на план ──
// effects(goals?) → { mode, kcal, zones: {zone: ×}, patterns: {pattern: ×}, tags: {tag: ×}, cardio_extra, steps_min, protein, notes[], emphasis[] }
// mode/kcal — подсказка клиенту; нормы считает сервер (norms.py), он учитывает те же правила.
const PRIO_K = { 1: 1, 2: 0.7, 3: 0.4 };
const V2_EFF = {
  lose_fat: { fat: 1, cardio: 30 },
  gain_muscle: { gain: 1 },
  gain_weight: { gain: 1 },
  endurance: { cardio: 60, tags: { cardio: 1.3 } },
  tone: { cardio: 20 },
  posture: { zones: { back: 1.2, shoulders: 1.1 } },
  neck: { zones: { neck: 1.2 } },
};
export function effects(g, uid = store.uid()) {
  const list = goalsOf(g === undefined ? goalRec(uid) : g);
  return memo(`geff|${uid}|${JSON.stringify(list)}`, () => {
    const out = { mode: null, kcal: null, zones: {}, patterns: {}, tags: {}, cardio_extra: 0, steps_min: null, protein: false, notes: [], emphasis: [] };
    let fat = 0, gain = 0;
    const bump = (obj, k, v, pk) => { const x = 1 + (v - 1) * pk; if (x > (obj[k] || 1)) obj[k] = Math.round(x * 100) / 100; };
    for (const x of list) {
      const pk = PRIO_K[Number(x.priority) || 2] || 0.7;
      let e;
      if (x.type === 'metric') {
        const m = metric(x.metric);
        if (!m) continue;
        const dir = dirOf(x);
        e = m.eff?.[dir] || {};
        if (e.steps && numv(x.to)) out.steps_min = Math.max(out.steps_min || 0, numv(x.to));
        if (e.protein) out.protein = true;
        if (e.zones || e.patterns) out.emphasis.push(`${m.label} ${dir === 'down' ? '↓' : '↑'}`);
      } else {
        e = { ...(V2_EFF[x.type] || {}) };
        if (x.type === 'gain_muscle' && x.zones?.length) e.zones = Object.fromEntries(x.zones.map(z => [z, 1.35]));
      }
      // на калории влияют только главные и важные цели: «по возможности» не должна переключать режим
      if (e.fat && pk >= 0.7) fat += pk;
      if (e.gain && pk >= 0.7) gain += pk;
      if (e.cardio) out.cardio_extra = Math.max(out.cardio_extra, Math.round(e.cardio * pk / 5) * 5);
      for (const [k, v] of Object.entries(e.zones || {})) bump(out.zones, k, v, pk);
      for (const [k, v] of Object.entries(e.patterns || {})) bump(out.patterns, k, v, pk);
      for (const [k, v] of Object.entries(e.tags || {})) bump(out.tags, k, v, pk);
    }
    const p = prof(uid), w = C.weights(uid).slice(-1)[0]?.w || Number(p.weight), h = Number(p.height);
    const bmi = w && h ? w / (h / 100) ** 2 : null;
    if (fat && gain) { out.mode = 'recomp'; out.kcal = 'deficit'; out.notes.push('Сброс и рост одновременно (рекомпозиция): небольшой дефицит, много белка, силовые с прогрессией. Оба процесса идут медленнее.'); }
    else if (fat) { out.mode = 'cut'; out.kcal = 'deficit'; }
    else if (gain) {
      if (bmi && bmi >= 25) { out.mode = 'maintain'; out.kcal = 'maintenance'; out.notes.push('Рост объёма при ИМТ от 25 - на поддержке калорий, без профицита: мышцы растут, жир не прибавляется.'); }
      else { out.mode = 'bulk'; out.kcal = 'surplus'; }
      out.protein = true;
    } else if (list.length) { out.mode = 'maintain'; out.kcal = 'maintenance'; }
    if (out.cardio_extra) out.notes.push(`Кардио: +${out.cardio_extra} мин в неделю к норме.`);
    return out;
  });
}

// Насколько упражнение попадает в акценты целей: 0…0.45 (для взвешивания в plan.js)
export function exerciseBoost(e, eff = effects()) {
  if (!e || !eff) return 0;
  let z = 0, p = 0, t = 0;
  for (const k of e._zones || e.zones || []) z = Math.max(z, (eff.zones[k] || 1) - 1);
  p = (eff.patterns[e.pattern] || 1) - 1;
  for (const [k, v] of Object.entries(eff.tags || {})) if (e._tags?.has?.(k) || (e.tags || []).includes(k)) t = Math.max(t, v - 1);
  return Math.min(0.45, z * 0.6 + p * 0.4 + t * 0.3);
}

// ── запись результата (тест или замер) ──
export async function record(id, value, date = C.today(), uid = store.uid()) {
  const m = metric(id), v = numv(value);
  if (!m || !(v > 0)) return null;
  if (m.src === 'body' && m.fields.length === 1) {
    const rid = `body:${uid}:${date}`;
    return store.put('body', rid, { ...(store.get(rid)?.data || {}), [m.fields[0]]: v }, date);
  }
  if (m.src === 'weight') {
    const rid = `body:${uid}:${date}`;
    return store.put('body', rid, { ...(store.get(rid)?.data || {}), weight: v }, date);
  }
  if (m.src === 'test') return store.put('mtest', `mtest:${uid}:${date}:${id}`, { metric: id, value: v, entered_at: Date.now() }, date);
  return null;
}
export const recordable = id => { const m = metric(id); return !!m && (m.src === 'test' || m.src === 'weight' || (m.src === 'body' && m.fields.length === 1)); };

// ── подписи ──
export function fmtNum(v, m, d) {
  if (v == null || Number.isNaN(+v)) return '-';
  const dd = d ?? m?.dec ?? 1;
  const x = Math.round(+v * 10 ** dd) / 10 ** dd;
  return (m?.unit === 'шагов' ? Math.round(x).toLocaleString('ru') : String(x)).replace('.', ',');
}
const fmtDate = s => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', ...(s.slice(0, 4) !== C.today().slice(0, 4) ? { year: 'numeric' } : {}) }).format(C.parse(s)).replace(/\s*г\.$/, '');
// медленные темпы честнее звучат в месяц: «+0,5 см в месяц», а не «+0,12 см в неделю»
function rateText(v, m, sign) {
  if (v < 0.3 || (m.dec === 0 && v < 1)) return `${sign}${fmtNum(v * 4.35, m, 1)} ${m.unit} в месяц`;
  return `${sign}${fmtNum(v, m, v < 1 ? 2 : 1)} ${m.unit} в неделю`;
}
export const fmtSigned = (v, m, d) => (v == null ? '-' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtNum(Math.abs(v), m, d)}`);
export function title(gl) {
  if (gl.type !== 'metric') return null;
  const m = metric(gl.metric);
  if (!m) return gl.metric;
  return `${m.label} ${fmtNum(gl.from, m)} → ${fmtNum(gl.to, m)} ${m.unit}`;
}
function period(days) {
  if (days < 14) return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  const w = Math.round(days / 7);
  if (w < 9) return `${w} ${plural(w, 'неделю', 'недели', 'недель')}`;
  const mo = Math.round(days / 30);
  return `${mo} ${plural(mo, 'месяц', 'месяца', 'месяцев')}`;
}
export { period as periodText };

// метрические цели пользователя по приоритету
export function metricGoals(uid = store.uid()) {
  return goalsOf(goalRec(uid)).filter(x => x.type === 'metric' && metric(x.metric))
    .sort((a, b) => (Number(a.priority) || 2) - (Number(b.priority) || 2));
}

// ── реплики тренера ──
// lines(uid) → [{ event: 'goal_on'|'goal_ahead'|'goal_behind'|'goal_done', mood, metric, text }] — для coach.lines()
const LINES = {
  on: {
    soft: ['{label} {delta} за {period} - идёшь по плану, так держать.', '{label}: {delta} за {period}. Спокойно и по плану - ты молодец.'],
    coach: ['{label}: {delta} за {period}. По плану. Продолжаем.', '{label} {delta} за {period} - график держим.'],
    sergeant: ['{label} {delta} за {period}. По графику, боец. Не расслабляться.', '{label}: {delta} за {period}. План выполняется. Пока.'],
  },
  ahead: {
    soft: ['{label} {delta} за {period} - даже быстрее плана! Горжусь.', '{label}: {delta} за {period}, с опережением. Береги себя, не перегибай.'],
    coach: ['{label} {delta} за {period} - опережаешь план. Держи темп, но без фанатизма.', '{label}: {delta} за {period}. Быстрее графика - отлично.'],
    sergeant: ['{label} {delta} за {period} - с опережением графика. Неплохо. Не зазнавайся.', '{label}: {delta} за {period}. Быстрее плана. Так и воюем.'],
  },
  behind: {
    soft: ['{label} пока {delta} за {period} - чуть медленнее плана. {hint}', '{label}: {delta} за {period}. Отстаём немного, это поправимо. {hint}'],
    coach: ['{label}: {delta} за {period} - отстаёшь от плана. {hint}', '{label} {delta} за {period}. Медленнее графика. {hint}'],
    sergeant: ['{label} {delta} за {period}? Отстаём от графика. {hint}', '{label}: {delta} за {period}. Это не темп, это прогулка. {hint}'],
  },
  done: {
    soft: ['{label}: цель {to} достигнута! Ты {это сделал|это сделала} - время поставить новую.'],
    coach: ['{label}: {to} - цель взята. Ставим следующую.'],
    sergeant: ['{label}: {to}. Цель взята, боец. Следующая - в профиле, живо.'],
  },
};
const LINE_MOOD = { on: 'praise', ahead: 'praise', behind: 'scold', done: 'praise' };
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

export function lines(uid = store.uid()) {
  const p = prof(uid), tone = p.tone || 'coach', f = p.sex === 'f', today = C.today();
  const out = [];
  for (const gl of metricGoals(uid)) {
    const pr = progress(gl, uid), m = pr.metric;
    if (!LINES[pr.status]) continue;
    // говорим только о реальном сдвиге: хотя бы неделя с начала и изменение заметнее шага показателя
    const days = pr.cur?.date && gl.since ? C.daysBetween(gl.since, pr.cur.date) : null;
    if (pr.status !== 'done' && (days == null || days < 7 || pr.change == null || (Math.abs(pr.change) < (m.step || 0.5) && pr.status !== 'behind'))) continue;
    const vars = { label: m.label, delta: `${fmtSigned(pr.change, m)} ${m.unit}`, period: period(Math.max(1, days || 0)),
      to: `${fmtNum(pr.to, m)} ${m.unit}`, hint: m.hint?.[dirOf(gl)] || '' };
    const set = LINES[pr.status][tone] || LINES[pr.status].coach;
    const text = set[hash(today + gl.metric + pr.status) % set.length]
      .replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, a, b) => (f ? b : a)).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+$/, '');
    out.push({ event: `goal_${pr.status}`, mood: LINE_MOOD[pr.status], metric: gl.metric, priority: Number(gl.priority) || 2, text });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

// Новая цель-показатель (для профиля): стартовое значение — из последнего замера
export function draft(id, uid = store.uid()) {
  const m = metric(id);
  if (!m) return null;
  const cur = current(id, uid);
  return { type: 'metric', metric: id, from: cur?.value ?? '', to: '', unit: m.unit, deadline: '', priority: 2, since: C.today() };
}
