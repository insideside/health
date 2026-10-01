// Свои упражнения: человек дополняет каталог тем, чего в нём нет («Лимфодренажные прыжки», упражнение от своего
// тренера в зале). Запись myex:{uid}:{ex_id} - только своя, партнёру не уходит. В каталоге (plan.catalog, S.exMap)
// они идут наравне с общими: замена, закрепление, чек-лист, ручная запись тренировки. Сервер берёт их в программу
// зала (jobs.job_program) и показывает тренеру в чате.
// data: { ex_id, name, how ('3 мин', '50 раз'), unit reps|seconds, place ['home','gym'], category, equipment [], technique }
import * as store from './store.js';

export const CATEGORIES = [['cardio', 'кардио, прыжки'], ['strength', 'сила'], ['core', 'пресс и кор'], ['mobility', 'растяжка, мобилити'], ['warmup', 'разминка']];
const PATTERN = { cardio: 'cardio', mobility: 'mobility', warmup: 'mobility', core: 'core_anti', strength: 'isolation' };

export const recs = (uid = store.uid()) => store.list('myex', uid).filter(r => r.data.ex_id && r.data.name);
export const isOwn = id => String(id || '').startsWith('my_');
export const recOf = (id, uid = store.uid()) => store.get(`myex:${uid}:${id}`);

// единица по тому, как человек записал «сколько»: минуты и секунды - время, иначе повторы
export const unitOf = how => (/(мин|сек|\d\s*с\b|час)/i.test(String(how || '')) ? 'seconds' : 'reps');

// запись → упражнение в формате каталога (app/seed/exercises.json)
export function toCatalog(r) {
  const d = r.data, cat = d.category || 'strength';
  const tech = String(d.technique || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  return {
    id: d.ex_id, name: d.name, own: true, how: d.how || '', category: cat, region: 'full', pattern: PATTERN[cat] || 'isolation',
    muscles: [], equipment: d.equipment || [], place: d.place?.length ? d.place : ['home'], level: 1, unit: d.unit || unitOf(d.how),
    per_side: !!d.per_side, morning: cat === 'warmup' || cat === 'mobility', technique: tech.length ? tech : ['Как записали вы - своё упражнение.'],
    mistakes: [], easier: null, harder: null,
    tags: [cat, ...(cat === 'warmup' ? ['morning', 'warmup'] : []), ...(cat === 'mobility' ? ['mobility', 'recovery'] : [])], zones: d.zones || [],
  };
}
let sig = '', cache = [];
export function list(uid = store.uid()) {
  const rs = recs(uid);
  const s = rs.map(r => `${r.id}|${r.updated_at}`).join(',');
  if (s !== sig) { sig = s; cache = rs.map(toCatalog); }
  return cache;
}
export const byId = id => (isOwn(id) ? list().find(e => e.id === id) || null : null);

export async function save(form, id = null) {
  const uid = store.uid();
  const ex_id = id || `my_${Math.random().toString(36).slice(2, 8)}`;
  const cur = id ? recOf(id)?.data || {} : {};
  const name = String(form.name || '').trim();
  if (!name) throw new Error('Назовите упражнение');
  const data = { ...cur, ex_id, name, how: String(form.how || '').trim(), unit: unitOf(form.how),
    place: form.place?.length ? form.place : ['home'], category: form.category || 'strength', equipment: form.equipment || [],
    technique: String(form.technique || '').trim(), created: cur.created || Date.now() };
  await store.put('myex', `myex:${uid}:${ex_id}`, data, null);
  return toCatalog(store.get(`myex:${uid}:${ex_id}`) || { data });
}
export async function remove(id) {
  const r = recOf(id);
  if (r) await store.remove(r.id);
}
