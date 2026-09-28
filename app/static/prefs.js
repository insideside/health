// Личные предпочтения в тренировках (SPEC-v3 п. 17–20), целиком на устройстве:
// «не предлагать» и любимые упражнения, инвентарь дома и чего нет в зале, кардио (любимые виды, где удобно),
// город и погода (кэш последнего прогноза), сезон. Подбор упражнений и план кардио — в plan.js.
import * as store from './store.js';
import * as C from './coach.js';

const prof = (uid = store.uid()) => store.get(`profile:${uid}`)?.data || {};
const profId = (uid = store.uid()) => `profile:${uid}`;

// ── инвентарь ──
// подписи — как в каталоге (app/seed/exercises.json); неизвестный код показываем как есть
export const EQUIP_LABEL = {
  mat: 'коврик', chair: 'стулья', bench: 'скамья', dumbbells: 'гантели', kettlebell: 'гиря', barbell: 'штанга',
  pullup_bar: 'турник', dip_bars: 'брусья', ab_wheel: 'ролик для пресса', band: 'резинки / эспандер', fitball: 'фитбол',
  jump_rope: 'скакалка', foam_roller: 'массажный ролик (МФР)', trx: 'петли TRX', stepper: 'степпер', bike: 'велотренажёр',
  treadmill: 'беговая дорожка', elliptical: 'эллипс (орбитрек)', rower: 'гребной тренажёр', rack: 'силовая стойка',
  machine: 'силовые тренажёры', cable: 'блочный тренажёр / кроссовер',
};
export const equipLabel = k => EQUIP_LABEL[k] || k;
export const CARDIO_MACHINES = ['stepper', 'bike', 'treadmill', 'elliptical', 'rower'];
// «Что есть дома» — чек-лист по группам
export const HOME_EQUIP_GROUPS = [
  ['Коврик и мелочи', ['mat', 'chair', 'bench']],
  ['Свободные веса', ['dumbbells', 'kettlebell']],
  ['Тренажёры для кардио', CARDIO_MACHINES],
  ['Турник и брусья', ['pullup_bar', 'dip_bars']],
  ['Прочее', ['band', 'fitball', 'jump_rope', 'foam_roller', 'ab_wheel', 'trx']],
];
// что бывает в зале — отмечаем, чего в нашем зале НЕТ
export const GYM_EQUIP = ['machine', 'cable', 'barbell', 'rack', 'bench', 'dumbbells', 'kettlebell', 'pullup_bar', 'dip_bars',
  'treadmill', 'elliptical', 'bike', 'rower', 'stepper', 'trx', 'band', 'fitball'];
export function homeEquipment(uid) { return new Set([...(prof(uid).equipment || []), 'mat', 'chair']); }
export function gymMissing(uid) { return new Set(prof(uid).gym_equipment?.missing || []); }

// ── «не предлагать» и любимые упражнения ──
export const EXCLUDE_REASONS = [['uncomfortable', 'неудобно'], ['no_equipment', 'нет тренажёра'], ['pain', 'больно'], ['other', 'другое']];
export const REASON_NAME = { ...Object.fromEntries(EXCLUDE_REASONS), skipped: 'пропускаю' };
export function exPrefs(uid = store.uid()) {
  const p = prof(uid).exercise_prefs || {};
  return { exclude: p.exclude || {}, like: p.like || [], keep: p.keep || {} };
}
// Где не предлагать: только в утренней разминке, дома, в зале или нигде (старые отметки без scope - «нигде»).
// where - контекст подбора: { place: 'home'|'gym', module?: 'morning'|… }; без него учитываются только «нигде».
export const EXCLUDE_SCOPES = [['morning', 'в утренней разминке'], ['home', 'дома'], ['gym', 'в зале'], ['all', 'нигде']];
export const SCOPE_NAME = { morning: 'в разминке', home: 'дома', gym: 'в зале', all: 'нигде' };
export function excludeApplies(v, where) {
  const sc = v?.scope || 'all';
  if (sc === 'all') return true;
  if (!where) return false;
  return sc === 'morning' ? where.module === 'morning' : sc === where.place;
}
// сцена по контексту на экране: разминка → «в разминке», другие комплексы → «дома», тренировка → её место
export function scopeFor(ctx, place) {
  if (ctx?.kind === 'routine') return (ctx.module || 'morning') === 'morning' ? 'morning' : 'home';
  return place === 'gym' ? 'gym' : place === 'home' ? 'home' : 'all';
}
export const excludedIds = (uid = store.uid(), where) => new Set(Object.entries(exPrefs(uid).exclude).filter(([, v]) => excludeApplies(v, where)).map(([id]) => id));
export const likedIds = (uid = store.uid()) => new Set(exPrefs(uid).like);
export const isExcluded = (id, uid, where) => { const v = exPrefs(uid).exclude[id]; return !!v && excludeApplies(v, where); };
export const exclusionOf = (id, uid) => exPrefs(uid).exclude[id] || null;   // отмечено хоть где-то
export const isLiked = (id, uid) => exPrefs(uid).like.includes(id);

async function savePrefs(fn, extra = p => ({})) {
  const uid = store.uid(), p = prof(uid);
  const cur = exPrefs(uid);
  const next = fn({ exclude: { ...cur.exclude }, like: [...cur.like], keep: { ...cur.keep } });
  await store.put('profile', profId(uid), { ...p, exercise_prefs: next, ...extra(p) });
}
// «не предлагать»: из любимых и «оставить» — прочь; закреплённое в утренней разминке — открепляем
export async function exclude(id, reason = 'other', via = '', scope = 'all') {
  await savePrefs(x => {
    x.exclude[id] = { reason, at: Date.now(), scope, ...(via ? { via } : {}) };
    if (scope === 'all') x.like = x.like.filter(i => i !== id);      // «любимое» остаётся, если убрали только из одного места
    delete x.keep[id];
    return x;
  }, p => {
    const mo = p.modules?.morning;
    if (!mo?.pinned?.includes(id) || scope === 'gym') return {};
    return { modules: { ...p.modules, morning: { ...mo, pinned: mo.pinned.filter(i => i !== id) } } };
  });
}
export async function unexclude(id) { await savePrefs(x => { delete x.exclude[id]; return x; }); }
export async function setLike(id, on) {
  await savePrefs(x => {
    x.like = x.like.filter(i => i !== id);
    if (on) { x.like.push(id); delete x.exclude[id]; }
    return x;
  });
}
// «Оставить»: тренер больше не предлагает замену, пока не накопится 3 новых пропуска после этой даты
export async function keep(id) { await savePrefs(x => { x.keep[id] = { at: Date.now(), date: C.today() }; return x; }); }
export async function unkeep(id) { await savePrefs(x => { delete x.keep[id]; return x; }); }

// ── кардио ──
// Виды кардио строятся из справочника активностей (поля cardio/setting/season/cold_ok/weather_sensitive);
// если справочник старый — из запасного списка ниже. eq — тренажёр (дома — из «Что есть дома», в зале — если он есть).
const CARDIO_BASE = [
  { id: 'elliptical_trainer', name: 'Эллипс', eq: 'elliptical', setting: ['indoor'], impact: 'low', ex: ['elliptical', 'elliptical_intervals'] },
  { id: 'treadmill', name: 'Беговая дорожка', eq: 'treadmill', setting: ['indoor'], impact: 'mid', act: ['treadmill', 'walk_fast'], ex: ['treadmill_incline_walk', 'treadmill_jog', 'treadmill_intervals'] },
  { id: 'stationary_bike', name: 'Велотренажёр', eq: 'bike', setting: ['indoor'], impact: 'low', ex: ['stationary_bike', 'bike_intervals'] },
  { id: 'indoor_rowing', name: 'Гребной тренажёр', eq: 'rower', setting: ['indoor'], impact: 'low', ex: ['rowing_machine', 'rower_intervals'] },
  { id: 'stepper', name: 'Степпер', eq: 'stepper', setting: ['indoor'], impact: 'low', act: ['stepper', 'stairs'], ex: ['stepper_steady', 'stepper_intervals'] },
  { id: 'jump_rope', name: 'Скакалка', eq: 'jump_rope', setting: ['indoor', 'outdoor'], impact: 'high', home: true, ex: ['jump_rope_basic', 'jump_rope_alternate', 'jump_rope_intervals'] },
  { id: 'home_cardio', name: 'Кардио-круг дома', setting: ['home'], impact: 'low', act: ['functional_training'], generator: true },
  { id: 'walk_fast', name: 'Быстрая ходьба', setting: ['outdoor'], impact: 'low', cold_ok: true, weather_sensitive: true },
  { id: 'running', name: 'Бег', setting: ['outdoor'], impact: 'high', cold_ok: false, weather_sensitive: true },
  { id: 'nordic_walking', name: 'Скандинавская ходьба', setting: ['outdoor'], impact: 'low', cold_ok: true, weather_sensitive: true },
  { id: 'cycling', name: 'Велосипед', setting: ['outdoor'], impact: 'low', season: ['spring', 'summer', 'autumn'], weather_sensitive: true },
  { id: 'swimming', name: 'Бассейн', setting: ['indoor', 'water'], impact: 'low', pool: true },
  { id: 'cross_country_skiing', name: 'Беговые лыжи', setting: ['outdoor'], impact: 'low', season: ['winter'], cold_ok: true, weather_sensitive: true, snow: true },
];
const EQ_OF_ACT = { elliptical_trainer: 'elliptical', treadmill: 'treadmill', stationary_bike: 'bike', indoor_rowing: 'rower', stepper: 'stepper', jump_rope: 'jump_rope' };
const PASSIVE = new Set(['sauna', 'massage', 'breathing', 'stretching', 'yoga']);
let kindsSrc = null, kindsCache = [];
// → [{ id, name, eq, places: ['gym'|'home'|'outdoor'|'indoor'], impact, season, cold_ok, weather_sensitive, act (для записи), ex }]
export function cardioKinds() {
  const acts = store.getMeta('activities', []) || [];
  if (acts === kindsSrc) return kindsCache;
  kindsSrc = acts;
  const byId = new Map(acts.map(a => [a.id, a]));
  const norm = k => {
    const a = byId.get(k.id) || {};
    const setting = [].concat(a.setting || k.setting || []);
    const eq = k.eq || EQ_OF_ACT[k.id] || null;
    const places = new Set();
    if (setting.includes('outdoor')) places.add('outdoor');
    if (k.generator || k.home) places.add('home');
    if (eq) { places.add('gym'); places.add('home'); } else if (!k.generator && (setting.includes('indoor') || setting.includes('water'))) places.add('indoor');
    const season = [].concat(a.season || k.season || ['all']);
    const act = (k.act || [k.id]).find(x => byId.has(x)) || (k.act || [k.id])[0];
    return { ...k, name: k.name || a.name || k.id, full: a.name || k.name, eq, places: [...places], impact: a.impact || k.impact || 'low',
      season, cold_ok: a.cold_ok ?? k.cold_ok ?? false, weather_sensitive: a.weather_sensitive ?? k.weather_sensitive ?? places.has('outdoor'),
      act, ex: k.ex || [] };
  };
  const out = CARDIO_BASE.map(norm);
  // остальные кардио-виды справочника (танцы, бокс, баскетбол…) — только если пользователь их отметил любимыми
  for (const a of acts) {
    if (out.some(k => k.id === a.id) || PASSIVE.has(a.id)) continue;
    const cardio = a.cardio ?? a.load === 'cardio';
    if (cardio) out.push({ ...norm({ id: a.id, name: a.name }), extra: true });
  }
  kindsCache = out;
  return out;
}
export const cardioKind = id => cardioKinds().find(k => k.id === id) || null;
export function cardioPrefs(uid = store.uid()) {
  const c = prof(uid).cardio || {};
  return { likes: c.likes || [], places: c.places?.length ? c.places : ['gym', 'home', 'outdoor'] };
}
export const PLACE_NAME = { gym: 'в зале', home: 'дома', outdoor: 'на улице', indoor: 'в помещении' };
export function isCardioActivity(type) {
  if (!type || PASSIVE.has(type)) return false;
  const a = (store.getMeta('activities', []) || []).find(x => x.id === type);
  if (a) return a.cardio ?? (a.load === 'cardio');
  return CARDIO_BASE.some(k => k.id === type || (k.act || []).includes(type));
}

// ── сезон и погода ──
// сезон по дате и полушарию (широта города из профиля; без города — северное)
export function season(date = C.today(), uid = store.uid()) {
  const m = C.parse(date).getMonth() + 1;
  const north = !(Number(prof(uid).location?.lat) < 0);
  const s = m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
  if (north) return s;
  return { winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' }[s];
}
export const SEASON_NAME = { winter: 'зима', spring: 'весна', summer: 'лето', autumn: 'осень' };

const locKey = loc => (loc && loc.lat != null ? `${Number(loc.lat).toFixed(2)},${Number(loc.lon).toFixed(2)}` : '');
// последний прогноз из кэша устройства (только если он про город из профиля)
export function weatherCached(uid = store.uid()) {
  const w = store.getMeta('weather', null);
  const loc = prof(uid).location;
  if (!w || !loc || w.loc !== locKey(loc)) return null;
  return w;
}
let wBusy = false;
// Забрать прогноз с сервера: не чаще раза в 30 минут, только при связи и если указан город.
export async function loadWeather({ force = false } = {}) {
  const loc = prof().location;
  if (!loc || loc.lat == null || !store.state.online || wBusy) return weatherCached();
  const cur = weatherCached();
  const tried = store.getMeta('weather_tried', 0);
  if (!force && ((cur && Date.now() - cur.saved_at < 30 * 60e3) || Date.now() - tried < 60e3)) return cur;
  wBusy = true;
  try {
    await store.setMeta('weather_tried', Date.now());
    const r = await store.api('/api/weather');
    const w = { ...r, loc: locKey(loc), city: loc.city, saved_at: Date.now() };
    await store.setMeta('weather', w);
    await store.setMeta('weather_off', false);
    return w;
  } catch (e) {
    if (e.status === 409) await store.setMeta('weather_off', true);
    return cur;
  } finally { wBusy = false; }
}
export const weatherOff = () => !!store.getMeta('weather_off', false);

// погода на дату из кэша: сегодня — текущая + дневная, другие дни (до 3 вперёд) — по дневной
export function weatherFor(date = C.today(), uid = store.uid()) {
  const w = weatherCached(uid);
  if (!w) return null;
  const day = (w.daily || []).find(d => d.date === date);
  const isToday = date === C.today() && w.current?.time?.slice(0, 10) === date;
  if (!day && !isToday) return null;
  const cur = isToday ? w.current : null;
  const temp = cur?.temp ?? (day ? (day.tmax + day.tmin) / 2 : null);
  const feels = cur?.feels ?? temp;
  const code = cur?.code ?? day?.code;
  const precip = Math.max(Number(cur?.precip) || 0, 0);
  const hoursOld = (Date.now() - (w.fetched_at || w.saved_at)) / 3600e3;
  return { temp, feels, code, wind: cur?.wind ?? null, precip, dayPrecip: Number(day?.precip) || 0, tmax: day?.tmax, tmin: day?.tmin,
    sunrise: day?.sunrise, sunset: day?.sunset, saved_at: w.saved_at, fetched_at: w.fetched_at, stale: hoursOld > 3, city: w.city };
}
// коды WMO → вид неба
export function skyOf(code) {
  const c = Number(code);
  if ([0, 1].includes(c)) return 'clear';
  if ([2, 3].includes(c)) return 'cloud';
  if ([45, 48].includes(c)) return 'fog';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if (c >= 95) return 'storm';
  return 'cloud';
}
export const SKY_NAME = { clear: 'ясно', cloud: 'облачно', fog: 'туман', snow: 'снег', rain: 'дождь', storm: 'гроза' };
export const SKY_GLYPH = { clear: 'sun', cloud: 'cloud', fog: 'fog', snow: 'snow', rain: 'rain', storm: 'rain' };
export const fmtT = t => (t == null ? '-' : `${Math.round(t) < 0 ? '−' : ''}${Math.abs(Math.round(t))} °C`);

// Можно ли кардио на улице: → { ok, why }. Без прогноза — по сезону (честно: «по сезону»).
export function outdoorOk(kind, date = C.today(), uid = store.uid()) {
  const s = season(date, uid);
  if (kind.season && !kind.season.includes('all') && !kind.season.includes(s)) return { ok: false, why: `не сезон (${SEASON_NAME[s]})` };
  const w = weatherFor(date, uid);
  if (!w) {
    if (s === 'winter' && !kind.cold_ok) return { ok: false, why: 'зима', approx: true };
    return { ok: true, why: '', approx: true };
  }
  const sky = skyOf(w.code);
  const f = w.feels ?? w.temp;
  if (kind.snow) return (sky === 'snow' || (w.tmax ?? f) <= 1) && f > -20 ? { ok: true, why: '' } : { ok: false, why: 'нет снега' };
  if (f != null && f <= (kind.cold_ok ? -15 : -3)) return { ok: false, why: `${fmtT(f)} по ощущению` };
  if (f != null && f >= 31) return { ok: false, why: 'жара' };
  if (sky === 'storm') return { ok: false, why: 'гроза' };
  if ((sky === 'rain' || w.precip >= 0.3 || w.dayPrecip >= 4) && kind.weather_sensitive !== false) return { ok: false, why: sky === 'snow' ? 'снег' : 'осадки' };
  if (sky === 'snow' && !kind.cold_ok) return { ok: false, why: 'снег' };
  if (w.wind != null && w.wind >= 11) return { ok: false, why: `ветер ${Math.round(w.wind)} м/с` };
  // можно, но неуютно: холод, ветер, снег — тем меньше шансов, что тренер позовёт на улицу
  let penalty = 0;
  if (f != null) penalty += f <= -10 ? 3 : f <= 0 ? 1.5 : f <= 5 ? 0.6 : f >= 27 ? 0.8 : 0;
  if (w.wind != null && w.wind >= 7) penalty += 1;
  if (sky === 'snow') penalty += 1;
  const why = f != null && f <= 0 ? `${fmtT(f)} по ощущению` : sky === 'snow' ? 'снег' : w.wind >= 7 ? `ветер ${Math.round(w.wind)} м/с` : '';
  return { ok: true, why, penalty };
}

// короткая заметка тренера о погоде для «Сегодня»
export function weatherNote(w) {
  if (!w) return '';
  const f = w.feels ?? w.temp, sky = skyOf(w.code), windy = w.wind != null && w.wind >= 7;
  if (f != null && f <= -8) return `${fmtT(f)}${windy ? ' и ветер' : ' по ощущению'} - кардио лучше дома или в зале; на улицу только быстрым шагом и тепло одетым.`;
  if (sky === 'storm') return 'Гроза - кардио сегодня под крышей.';
  if (sky === 'rain' || w.precip >= 0.3 || w.dayPrecip >= 4) return 'Осадки - кардио сегодня под крышей, а прогулку перенесём на сухое окно.';
  if (sky === 'snow') return 'Снег - бег лучше заменить быстрой ходьбой или тренажёром.';
  if (w.wind != null && w.wind >= 11) return `Сильный ветер ${Math.round(w.wind)} м/с - кардио лучше в помещении.`;
  if (f != null && f >= 28) return 'Жарко - двигаться лучше утром или вечером и пить больше воды.';
  if (f != null && f <= 2) return 'Холодно - на улице одевайся слоями, разминку сделай дома.';
  if (f != null && f >= 10 && f <= 24) return 'Хорошая погода - прогулка или пробежка на улице засчитается в кардио.';
  return '';
}
