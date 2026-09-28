// Ориентировочные нормы прямо на устройстве — когда сервера нет рядом.
//
// Те же формулы, что и в app/norms.py, но упрощённо: без шкалы сроков, без поправок на телосложение
// и без комментария тренера. Результат помечается source: 'local', и при следующем пересчёте с
// сервером заменяется точным. Меняете формулы в norms.py — сверьтесь и здесь.
import * as store from './store.js';
import * as C from './coach.js';
import * as G from './goals.js';

const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, high: 1.725 };
const PACE = { slower: 0.6, normal: 1, faster: 1.35 };

function age(birth) {
  const b = C.parse(birth), t = new Date();
  return t.getFullYear() - b.getFullYear() - ((t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) ? 1 : 0);
}

// режим по целям: метрические цели (goals.js) → v2-типы → поля v1
function modeOf(goal) {
  const eff = G.effects?.(goal);
  if (eff?.mode) return eff.mode;
  const types = new Set((goal.goals || []).map(g => g.type));
  const fat = types.has('lose_fat') || Number(goal.fat_kg) > 0;
  const gain = types.has('gain_muscle') || types.has('gain_weight') || Number(goal.muscle_upper_kg) > 0 || Number(goal.muscle_lower_kg) > 0;
  return fat && gain ? 'recomp' : fat ? 'cut' : gain ? 'bulk' : 'maintain';
}

// → данные записи target или { missing: [...] }, если не хватает параметров
export function estimate(uid = store.uid()) {
  const p = store.get(`profile:${uid}`)?.data || {};
  const goal = store.get(`goal:${uid}`)?.data || {};
  const weight = C.weights(uid).slice(-1)[0]?.w ?? p.weight;
  const missing = [['пол', p.sex], ['дата рождения', p.birth], ['рост', p.height], ['вес', weight]].filter(x => !x[1]).map(x => x[0]);
  if (missing.length) return { missing };

  const h = Number(p.height), w = Number(weight), a = age(p.birth);
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === 'm' ? 5 : -161);
  // регулярные активности считаем отдельно по MET, а бытовую активность тогда не выше «лёгкой» — без двойного счёта
  const acts = p.activities || [];
  const catalog = store.getMeta('activities', []) || [];
  let actKcalDay = 0;
  for (const x of acts) {
    const met = catalog.find(c => c.id === x.type)?.met?.[x.intensity || 'mid'] ?? 5;
    actKcalDay += (met - 1) * w * (Number(x.minutes) || 45) / 60 * (Number(x.per_week) || 1) / 7;
  }
  const actKey = acts.length && (ACTIVITY[p.activity] || 1.375) > 1.375 ? 'light' : (p.activity || 'light');
  const tdee = bmr * ACTIVITY[actKey] + actKcalDay;

  const mode = modeOf(goal);
  const bmi = w / (h / 100) ** 2;
  const k = PACE[p.pace] || 1;
  const adj = { cut: -0.2 * k, recomp: (bmi >= 25 ? -0.15 : -0.08) * k, bulk: 0.1 * k, maintain: 0 }[mode];
  const kcal = Math.max(p.sex === 'm' ? 1500 : 1200, tdee * (1 + adj));
  const refW = bmi > 30 ? Math.min(w, 27 * (h / 100) ** 2) : w;
  const prot = refW * (mode === 'recomp' || mode === 'bulk' ? 2.0 : 1.8);
  const fat = Math.max(0.8 * w, kcal * 0.25 / 9);
  const carbs = Math.max(0, (kcal - prot * 4 - fat * 9) / 4);
  const glass = Number(p.glass_ml) || 250;
  const waterMl = w * 30;
  const eff = G.effects?.(goal);
  const steps = Math.max({ cut: 10000, recomp: 9000, maintain: 8000, bulk: 7000 }[mode], eff?.steps_min || 0);

  return {
    mode, source: 'local', valid_from: C.today(), weight: w, age: a,
    bmr: Math.round(bmr), tdee: Math.round(tdee), bmi: Math.round(bmi * 10) / 10,
    kcal: Math.round(kcal / 10) * 10, p: Math.round(prot), f: Math.round(fat), c: Math.round(carbs),
    fiber: Math.round(kcal / 1000 * 14),
    water_ml: Math.round(waterMl / 50) * 50, water_glasses: Math.ceil(waterMl / glass),
    water_glasses_gym: Math.ceil((waterMl + 500) / glass),
    steps, sleep_hours: a < 26 ? 8 : 7.5,
    warnings: [], explanation: '', tips: [],
    note: 'Ориентировочно: рассчитано на этом устройстве по формулам. С сервером - точнее (сроки, активности, телосложение) и с комментарием тренера.',
  };
}

// записать ориентировочные нормы как новую версию target
export async function saveEstimate(uid = store.uid()) {
  const t = estimate(uid);
  if (t.missing) return t;
  await store.put('target', store.newId(), t, null);
  return t;
}
