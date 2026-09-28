// Рацион на день без сети и без ИИ. Слоты — из распорядка, сна, окна питания, привычного времени еды и тренировки дня;
// продукты — из того, что человек обычно ест (∩ здоровое), «что есть дома» и базовых продуктов справочника;
// граммы подбираются под цель слота. ИИ (задача mealplan со slots) только уточняет и пишет рецепты — сервер
// перепроверяет его ответ по справочнику, так что формат слотов у обоих вариантов один.
import * as store from './store.js';
import * as C from './coach.js';
import * as foods from './foods.js';

const r1 = x => Math.round((Number(x) || 0) * 10) / 10;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hmOf = m0 => { const m = ((Math.round(m0) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const round5 = m => Math.round(m / 5) * 5;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const low = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

export const LABEL = { breakfast: 'Завтрак', snack: 'Перекус', lunch: 'Обед', dinner: 'Ужин', pre: 'До тренировки', post: 'После тренировки' };
export const HONEST = 'Составлено на этом устройстве по справочнику и вашей истории; с ИИ - точнее и с рецептами.';

// ── фильтр «здоровое» ──
// Группы, которые рацион не предлагает никогда: даже если человек их ест, это не то, что стоит советовать.
const BAD_GROUPS = new Set(['фастфуд', 'сладости', 'напитки', 'соусы и приправы', 'колбасы и полуфабрикаты', 'готовые блюда']);
const BAD_RE = /чипс|(?<![а-я])фри(?![а-я])|панировк|в кляре|глазир|сладк|с сахаром|сгущ|майонез|бекон|(?<![а-я])сало(?![а-я])|смалец|копч|шоколад|торт|печенье|вафл|конфет|морожен|пирожн|сироп|варень|джем|к пиву|гейнер|маргарин|спред|кранч|гранол|сдоб|пончик|булоч|круассан|батон|хлеб белый|хлеб пшеничн|тостов|быстрого приготовления|в масле|в томат|цукат|жарен|солен|с маслом|сливочн|\(снек\)|шарики|хлопья кукуруз|кукурузные хлопья|хлопья для завтрака|манн|мука|крахмал|сухари|сушки|отбивн|фарш|с сыром|с ветчиной|с беконом|бенедикт|фаршир|утк|гусь|сырок|творожн(ая|ый) (масса|десерт)|десерт|пудинг шок|коктейль в бутылке|молочный коктейль|сливки|сметана 2|сметана 3|сыр плавлен|колбасн/;
// спортпит — только понятные вещи; печенье, чипсы, гейнер и гели — нет
const SPORT_OK = /^(протеин|изолят сывороточного|казеин|соевый протеин|протеиновый батончик|протеиновый коктейль на (воде|молоке))/;
const GLUTEN_RE = /хлеб|макарон|булгур|кускус|перлов|манн|ячнев|лаваш|лапша|овсян|мюсли|гранол|пшен(?!о)|батон|багет|полба|хлебцы хруст/;
const PORK_RE = /свин|сало|бекон|смалец/;
const LACTOSE_OK_RE = /безлактоз|пармезан|гауда|чеддер|маасдам|изолят/;
const DRIED_RE = /сушен|вялен|изюм|кураг|урюк|финик|чернослив|инжир суш|годжи/;
const STATE_RE = /(?<![а-я])(сыр(ой|ая|ое|ые)|сух(ой|ая|ое|ие)|вар[её]н[а-я]*|отварн[а-я]*|жарен[а-я]*|запеч[её]нн?[а-я]*|туш[её]н[а-я]*|готов[а-я]*|свеж[а-я]*|гриль|на воде|до варки)(?![а-я])/g;
const baseKey = name => low(name).replace(/\(.*?\)/g, '').replace(STATE_RE, ' ').replace(/\s+/g, ' ').trim();

function allergyWords(text) {
  return low(text).split(/[,;\n/]+|\s+/).map(w => w.replace(/^[\s.-]+|[\s.-]+$/g, ''))
    .filter(w => w.length >= 3 && !['нет', 'без', 'аллергия', 'аллергии', 'на'].includes(w)).map(w => foods.stem(w).slice(0, Math.max(3, foods.stem(w).length)));
}

// подходит ли продукт диете и аллергиям (как nutrition.allowed на сервере)
function dietOk(f, diet, allergy) {
  const g = f.group || '', n = low(f.name);
  const meat = ['мясо', 'птица', 'колбасы и полуфабрикаты'].includes(g), fish = g === 'рыба и морепродукты';
  const dairy = g === 'молочные' || g === 'сыры' || /сывороточ|казеин|на молоке/.test(n), egg = g === 'яйца';
  if ((diet === 'vegetarian' || diet === 'vegan') && (meat || fish)) return false;
  if (diet === 'pescatarian' && meat) return false;
  if (diet === 'vegan' && (dairy || egg || /(?<![а-я])мед(?![а-я])/.test(n))) return false;
  if (diet === 'lactose_free' && dairy && !LACTOSE_OK_RE.test(n)) return false;
  if (diet === 'gluten_free' && GLUTEN_RE.test(n)) return false;
  if ((diet === 'halal' || diet === 'kosher') && PORK_RE.test(n)) return false;
  if (diet === 'kosher' && fish && /кревет|кальмар|миди|осьминог|краб/.test(n)) return false;
  return !allergy.some(w => n.includes(w) || low(g).includes(w));
}

// почему продукт не годится в «здоровый» рацион (или null — годится)
export function unhealthy(f) {
  const g = f.group || '', n = low(f.name);
  if (g === 'спортпит') return SPORT_OK.test(n) ? null : 'спортпит';
  if (BAD_GROUPS.has(g)) return g;
  if (BAD_RE.test(n)) return 'способ приготовления или добавки';
  if (C.foodFlags(f.name, g).has('alcohol')) return 'алкоголь';
  return null;
}

// ── роль продукта в тарелке ──
// prot — основной белок, egg, dairy — белковые молочные (и кефир), sport, grain — крупы/гарнир, bread, fruit, veg, oil, nuts, dried
function roleOf(f) {
  const g = f.group || '', n = low(f.name);
  if (g === 'спортпит') return 'sport';
  if (g === 'яйца') return /яйцо|омлет|болтун|глазун|белок/.test(n) ? 'egg' : null;
  if (g === 'птица' || g === 'мясо') return f.f <= 16 && !/печен|сердц|сердеч|желуд|язык|шашлык|люля|гуляш|азу|рулет|крыл|голен|по-франц|терияки|кисло|сливоч|сметан|ростбиф|тушенк/.test(n) ? 'prot' : null;
  if (g === 'рыба и морепродукты') return /икра|палочк|сушен|вялен|печень|консерв|в среднем|пресерв|слабосол|коктейль/.test(n) ? null : 'prot';
  if (g === 'бобовые') return f.state === 'cooked' && !/в томат|хумус/.test(n) ? (/тофу|соев|эдамаме/.test(n) || f.p >= 7 ? 'prot' : null) : null;
  if (g === 'молочные') return /творог|йогурт (греч|натур|высокобел)|скайр|кефир|ряженка 2|айран|простокваш|высокобелковый кисломол/.test(n) && !/сладк|детск|масса|десерт/.test(n) ? 'dairy' : null;
  if (g === 'сыры') return /адыгей|моцарелл|рикотт|сыр лёгкий|сыр легкий|брынз|фета|панир|творожный легкий/.test(n) ? 'cheese' : null;
  if (g === 'крупы') return /мука|крахмал|отруб|толокно|мюсли|хлопья для|на молоке|с маслом|в пакетике|каша готовая|каша на воде \(|каша молочная/.test(n) ? null : 'grain';
  if (g === 'макароны') return /макарон|соба|удон|рисовая|фунчоз/.test(n) && !/с |паст/.test(n) ? 'grain' : null;
  if (g === 'хлеб и выпечка') return /цельнозерн|ржан|бородин|отрубн|хлебцы|мультизерн|безглютен|дарниц|на закваске/.test(n) ? 'bread' : null;
  if (g === 'овощи') {
    if (/^картоф|^батат/.test(n)) return /пюре$|пюре на воде|варен|запечен|^батат/.test(n) && !/дольк|с маслом|с гриб/.test(n) ? 'grain' : null;
    if (/кукуруза вар|горошек зел/.test(n)) return 'veg';
    if (/оливк|маслин|чеснок|имбир|чили|укроп|петрушк|кинза|базилик|грибы суш|вялен|каперс|кукуруз/.test(n)) return null;
    return 'veg';
  }
  if (g === 'фрукты и ягоды') {
    if (/авокадо/.test(n)) return 'fat';
    if (/кокос|лимон|лайм|консерв|пюре детск/.test(n)) return null;
    return DRIED_RE.test(n) ? 'dried' : f.state === 'fresh' ? 'fruit' : null;
  }
  if (g === 'орехи и семена') return /в оболочк|солен|жарен|стружк|каштан|мука|мак$|смесь орехов и сух/.test(n) ? null : 'nuts';
  if (g === 'жиры и масла') return /масло (оливк|подсол|льнян|рапс|авокадо|кукуруз|горчич)/.test(n) ? 'oil' : null;
  return null;
}

// клетчатка на 100 г — в справочнике её нет, поэтому оценка по виду продукта (≈)
export function fiberOf(f) {
  const n = low(f.name), g = f.group || '', dry = f.state === 'dry';
  if (g === 'овощи') return /^картоф/.test(n) ? 1.8 : /батат/.test(n) ? 3 : /огур|салат|кабач/.test(n) ? 1 : 2.5;
  if (g === 'фрукты и ягоды') return DRIED_RE.test(n) ? 7 : /малин|ежевик|смородин/.test(n) ? 5 : /ягод|черник|клубник|голубик/.test(n) ? 3 : /авокадо/.test(n) ? 6.7 : 2.3;
  if (g === 'крупы') { const d = /перлов|булгур|овсян|гречк|полба|отруб/.test(n) ? 10 : /рис бур|рис дик|киноа/.test(n) ? 5 : /рис/.test(n) ? 1.3 : 6; return dry ? d : r1(d / (f.cooked_ratio || 3)); }
  if (g === 'бобовые') return dry ? 15 : /тофу/.test(n) ? 1 : 7;
  if (g === 'орехи и семена') return /чиа/.test(n) ? 34 : /льн/.test(n) ? 27 : 7;
  if (g === 'хлеб и выпечка') return /хлебцы/.test(n) ? 10 : /цельнозерн|ржан|бородин|отрубн|мультизерн/.test(n) ? 7 : 2.5;
  if (g === 'макароны') return /цельнозерн/.test(n) ? (dry ? 9 : 4) : dry ? 3 : 1.5;
  return 0;
}

// ── базовые продукты: на случай короткой истории ──
const STAPLES = {
  prot: ['Куриная грудка запечённая', 'Куриная грудка варёная', 'Индейка филе варёное', 'Говядина нежирная варёная', 'Минтай отварной', 'Треска',
    'Лосось запечённый', 'Горбуша запечённая', 'Чечевица варёная', 'Нут варёный', 'Фасоль варёная', 'Тофу'],
  egg: ['Яйцо варёное', 'Омлет', 'Яичница-болтунья'],
  dairy: ['Творог 5%', 'Творог 2%', 'Йогурт греческий', 'Скайр', 'Кефир 1%', 'Йогурт натуральный 2,5%'],
  grain: ['Гречка сырая', 'Рис бурый сырой', 'Булгур сырой', 'Овсяные хлопья сухие', 'Киноа сырая', 'Картофель запечённый', 'Макароны цельнозерновые сухие', 'Перловка сырая'],
  bread: ['Хлеб цельнозерновой', 'Хлеб ржаной', 'Хлебцы хрустящие'],
  veg: ['Огурец', 'Помидор', 'Капуста белокочанная', 'Брокколи', 'Морковь', 'Перец болгарский', 'Салат листовой', 'Кабачок', 'Овощная смесь замороженная', 'Капуста цветная', 'Шпинат'],
  fruit: ['Банан', 'Яблоко', 'Апельсин', 'Мандарин', 'Груша', 'Киви', 'Ягоды замороженные'],
  oil: ['Масло оливковое', 'Масло подсолнечное'],
  nuts: ['Грецкий орех', 'Миндаль', 'Семена льна'],
  fat: ['Авокадо'],
  sport: ['Протеин сывороточный', 'Протеиновый батончик'],
  dried: ['Финики'],
  cheese: ['Сыр лёгкий 17%', 'Моцарелла', 'Адыгейский сыр'],
};
const STAPLE_SET = new Set(Object.values(STAPLES).flat());

// ── «что есть дома» и «не предлагать» (локально, в meta; синхронизировать не нужно) ──
export function pantry() { return store.getMeta('pantry', []) || []; }
export async function setPantry(list) { await store.setMeta('pantry', list.slice(0, 80)); }
export async function addPantry(f) { const p = pantry(); if (!p.some(x => x.id === f.id)) await setPantry([...p, { id: f.id, name: f.name }]); }
export async function removePantry(id) { await setPantry(pantry().filter(x => String(x.id) !== String(id))); }
export function excluded() { return store.getMeta('mp_exclude', []) || []; }
export async function toggleExclude(f) {
  const ex = excluded();
  await store.setMeta('mp_exclude', ex.some(x => x.id === f.id) ? ex.filter(x => x.id !== f.id) : [...ex, { id: f.id, name: f.name }]);
}

// ── случайность от даты: рацион меняется день ото дня, но один день стабилен ──
function rngOf(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── кандидаты: продукты с ролью, оценкой «насколько это ваше» ──
function candidates(ctx) {
  const all = store.getMeta('foods', null)?.items || [];
  const pend = store.getMeta('foods_pending', []) || [];
  const usage = foods.usage();
  const pantryIds = new Set(pantry().map(x => String(x.id)));
  const pantryBases = new Set(pantry().map(x => baseKey(x.name)));
  const exIds = new Set(excluded().map(x => String(x.id)));
  const out = [], skipped = new Map();
  // любовь к продукту переносится на его здоровую версию: «грудка жареная» → «грудка запечённая»
  const baseLove = new Map();
  const byId = new Map([...all, ...pend].map(f => [f.id, f]));
  for (const [id, u] of usage) {
    const f = byId.get(id);
    if (!f) continue;
    const b = baseKey(f.name);
    baseLove.set(b, (baseLove.get(b) || 0) + u.count);
    const why = unhealthy(f);
    if (why && u.count >= 1) skipped.set(f.name, (skipped.get(f.name) || 0) + u.count);
  }
  for (const f of byId.values()) {
    if (f.deleted || !f.name || !(f.kcal >= 0)) continue;
    const role = roleOf(f);
    if (!role || unhealthy(f) || !dietOk(f, ctx.diet, ctx.allergy) || exIds.has(String(f.id))) continue;
    if (ctx.habits.has('less_flour') && (role === 'bread' || f.group === 'макароны')) continue;
    if ((ctx.habits.has('less_sugar') || ctx.diet === 'diabetic') && role === 'dried') continue;
    if (ctx.medsGrapefruit && /грейпфрут|помело/.test(low(f.name))) continue;
    const u = usage.get(f.id);
    const own = u?.count || 0;
    const love = baseLove.get(baseKey(f.name)) || 0;
    const home = pantryIds.has(String(f.id)) || pantryBases.has(baseKey(f.name));
    let score = 0;
    if (own) score += 30 + Math.min(own, 12) * 6;
    else if (love) score += 18 + Math.min(love, 12) * 4;          // та же еда, другой способ приготовления
    if (STAPLE_SET.has(f.name)) score += 12;
    if (home) score += 400;
    if (!score) continue;                                          // экзотику из справочника не предлагаем
    if (f.generic) score -= 8;
    if (foods.isMine(f)) score += 4;
    out.push({ f, role, score, own, home, base: baseKey(f.name) });
  }
  // одна «основа» — одна версия: сухая гречка или варёная, смотря что человек взвешивает
  const best = new Map();
  for (const c of out) {
    const k = c.role + '|' + c.base;
    const cur = best.get(k);
    const pref = x => x.score + (x.own ? 50 : 0) + (x.f.state === 'dry' && x.f.cooked_ratio ? 6 : 0) + (x.f.state === 'cooked' && ['prot'].includes(x.role) ? 6 : 0);
    if (!cur || pref(c) > pref(cur)) best.set(k, c);
  }
  return { list: [...best.values()], skipped };
}

// ── контекст дня ──
function context(date, opts) {
  const uid = store.uid();
  const p = store.get(`profile:${uid}`)?.data || {};
  const g = store.get(`goal:${uid}`)?.data || {};
  const diet = p.diet || 'normal';
  const habits = new Set(g.habits || []);
  const goals = new Set((g.goals || []).map(x => x.type));
  const wd = C.weekday(date);
  const sched = p.schedule?.days?.[wd] || {};
  const busy = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(String(sched.busy || '').replace(/\s/g, ''));
  const busyFrom = busy ? C.toMin(busy[1]) : null, busyTo = busy ? C.toMin(busy[2]) : null;
  const sl = C.sleep(date);
  const st = C.sleepStats(14, uid, C.addDays(date, -1));
  const wake = C.toMin(sl?.wake) ?? C.toMin(st.avgWake) ?? 7 * 60;
  let bed = C.toMin(st.avgBed);
  if (bed === null) bed = wake + 1440 - Math.round(C.sleepTarget(uid) * 60);
  if (bed < 12 * 60) bed += 1440;                                  // 00:30 → 24:30, чтобы считать «до сна»
  const win = p.eating_window?.enabled && C.toMin(p.eating_window.from) !== null && C.toMin(p.eating_window.to) !== null
    ? { from: C.toMin(p.eating_window.from), to: C.toMin(p.eating_window.to) } : null;
  if (win && win.to <= win.from) win.to += 1440;
  // привычное время приёмов пищи — медианы за 6 недель
  const usual = {};
  const times = { breakfast: [], lunch: [], dinner: [], snack: [] };
  for (const r of store.list('food', uid, r => r.date && r.date >= C.addDays(date, -42) && r.date < date)) {
    const t = C.toMin(r.data.time);
    if (t !== null && times[r.data.meal || 'snack']) times[r.data.meal || 'snack'].push(t);
  }
  for (const [k, a] of Object.entries(times)) if (a.length >= 3) usual[k] = round5(median(a));
  // тренировка дня
  const w = C.workout(date, uid);
  let workout = null;
  if (w && w.data.variant !== 'moved' && !w.data.skipped && C.dayType(date, uid) !== 'sick') {
    const minutes = C.estimateMinutes(w.data) || 60;
    workout = { title: w.data.title || 'Тренировка', minutes, source: 'workout', intensity: w.data.variant === 'recovery' ? 'low' : w.data.variant === 'light' ? 'mid' : 'high' };
  }
  // активности: запланированные на этот день недели и уже записанные
  const acts = [];
  const actName = t => (store.getMeta('activities', []) || []).find(a => a.id === t)?.name || t;
  for (const a of p.activities || []) {
    if (!a?.type || !Array.isArray(a.weekdays) || !a.weekdays.includes(wd)) continue;
    acts.push({ type: a.type, name: actName(a.type), minutes: Number(a.minutes) || 45, intensity: a.intensity || 'mid', planned: true });
  }
  for (const r of store.byDate('activity', date)) {
    if (C.isPassive(r.data.type)) continue;
    const same = acts.find(a => a.type === r.data.type && a.planned);
    if (same) { same.logged = true; same.minutes = Number(r.data.minutes) || same.minutes; continue; }
    acts.push({ type: r.data.type, name: actName(r.data.type), minutes: Number(r.data.minutes) || 30, intensity: r.data.intensity || 'mid', logged: true });
  }
  const heavyAct = acts.filter(a => a.minutes >= 30 && a.intensity !== 'low').sort((a, b) => b.minutes - a.minutes)[0];
  if (!workout && heavyAct) workout = { title: heavyAct.name, minutes: heavyAct.minutes, source: 'activity', intensity: heavyAct.intensity };
  if (workout) {
    const rem = (p.reminders || []).find(r => r?.kind === 'workout' && r.enabled !== false && C.toMin(r.time) !== null);
    let t = C.toMin(opts.workoutTime) ?? C.toMin(w?.data?.time) ?? (rem ? C.toMin(rem.time) : null);
    let how = t !== null ? (opts.workoutTime ? 'manual' : 'set') : 'guess';
    if (t === null) {
      const slot = sched.slot || 'any';
      if (slot === 'morning') t = busyFrom !== null ? Math.max(wake + 45, busyFrom - workout.minutes - 60) : wake + 60;
      else if (slot === 'day') t = 13 * 60;
      else t = busyTo !== null ? busyTo + 30 : 18 * 60 + 30;
    }
    workout.time = round5(t);
    workout.how = how;
  }
  const meds = low(p.medications);
  return {
    uid, p, g, diet, habits, goals, wd, busyFrom, busyTo, wake, bed, win, usual, workout, acts, sleepKnown: !!sl?.wake,
    allergy: allergyWords(p.allergies), medsGrapefruit: !!meds.trim(), meds: meds.trim(),
    lowCarb: diet === 'keto' || diet === 'low_carb', ifDiet: diet === 'if_16_8' || diet === 'if_18_6',
  };
}

// ── слоты дня ──
function buildSlots(ctx) {
  const { wake, bed, win, usual, busyFrom, workout } = ctx;
  const lastEat = bed - (ctx.habits.has('less_late_eating') ? 210 : 180);    // ужин — не позже чем за 3 ч до сна
  const inWin = t => !win || (t >= win.from && t <= win.to) || (t + 1440 >= win.from && t + 1440 <= win.to);
  let bf = usual.breakfast ?? wake + 45;
  bf = Math.max(bf, wake + 20);
  if (busyFrom !== null && busyFrom > wake + 40) bf = Math.min(bf, busyFrom - 20);
  let lunch = usual.lunch ?? Math.max(13 * 60, bf + 4 * 60);
  if (lunch < bf + 180) lunch = bf + 180;
  let dinner = usual.dinner ?? Math.max(19 * 60, lunch + 5 * 60);
  dinner = Math.min(dinner, lastEat);
  if (dinner < lunch + 180) dinner = Math.min(lunch + 240, Math.max(lastEat, lunch + 180));
  let slots = [];
  const skipBreakfast = win && win.from >= 11 * 60;
  if (!skipBreakfast) slots.push({ kind: 'breakfast', t: Math.max(bf, win ? win.from : 0) });
  slots.push({ kind: 'lunch', t: skipBreakfast ? Math.max(win.from, Math.min(lunch, win.from + 60)) : lunch });
  slots.push({ kind: 'dinner', t: win ? Math.min(dinner, win.to - 15) : dinner });

  if (workout) {
    const T = workout.time, E = T + workout.minutes;
    const morning = T <= slots[0].t + 45;
    if (morning) {
      // утренняя тренировка: лёгкий перекус до (если есть время), завтрак — после
      if (T - wake >= 40) slots.push({ kind: 'pre', t: Math.max(wake + 10, T - 45), light: true });
      const first = slots[0];
      first.t = Math.max(first.t, E + 30);
      first.post = true;
    } else {
      // есть ли основной приём за 1,5–3 ч до начала — тогда отдельный перекус «до» не нужен
      const before = slots.filter(s => s.t <= T - 60 && s.t >= T - 180).sort((a, b) => b.t - a.t)[0];
      if (before) before.pre = true;
      // приёмы, попадающие на саму тренировку (−45 мин … конец), сдвигаем после неё
      for (const s of slots) if (s.t > T - 60 && s.t < E + 20) { s.t = E + 45; s.post = true; }
      let after = slots.find(s => s.t >= E && s.t <= E + 120);
      if (after) after.post = true;
      if (!before) slots.push({ kind: 'pre', t: T - 75 });
      if (!after) slots.push({ kind: 'post', t: E + 30 });
      // «после» позже, чем можно есть перед сном, — оставляем лёгкий белковый перекус, ужин переносим до тренировки
      for (const s of slots) if (s.kind === 'dinner' && s.t > lastEat + 30) {
        if (T - 150 > lunch + 150) { s.t = T - 150; s.post = false; s.pre = true; slots = slots.filter(x => x.kind !== 'pre'); if (!slots.some(x => x.kind === 'post')) slots.push({ kind: 'post', t: E + 30, light: true }); }
        else s.t = Math.min(s.t, lastEat + 60);
      }
    }
  }
  slots.sort((a, b) => a.t - b.t);
  // длинные промежутки — перекус посередине
  const add = [];
  for (let i = 0; i < slots.length - 1; i++) {
    const a = slots[i], b = slots[i + 1];
    if (b.t - a.t > 270 && a.kind !== 'pre' && b.kind !== 'pre') {
      const t = round5((a.t + b.t) / 2 / 15) * 15;
      if (inWin(t) && !(ctx.habits.has('less_late_eating') && t >= 20 * 60)) add.push({ kind: 'snack', t });
    }
  }
  slots = [...slots, ...add].sort((a, b) => a.t - b.t);
  // окно питания: перекусы вне окна убираем, «до/после» — оставляем только если внутри
  if (win) slots = slots.filter(s => inWin(s.t) || ['breakfast', 'lunch', 'dinner'].includes(s.kind));
  const seen = {};
  return slots.map(s => {
    seen[s.kind] = (seen[s.kind] || 0) + 1;
    return { ...s, t: round5(s.t), key: s.kind + (seen[s.kind] > 1 ? seen[s.kind] : '') };
  });
}

function slotLabel(s) {
  if (s.kind === 'pre') return s.light ? 'Перед тренировкой' : 'За 60–90 мин до тренировки';
  if (s.kind === 'post') return 'После тренировки';
  const base = s.kind === 'lunch' && s.first ? 'Первый приём' : LABEL[s.kind];
  return s.post ? `${base} · после тренировки` : s.pre ? `${base} · до тренировки` : base;
}
function slotReason(s, ctx) {
  if (s.kind === 'pre') return s.light ? 'Лёгкие быстрые углеводы, чтобы не тренироваться на пустой желудок; если привыкли натощак - можно пропустить.'
    : 'Перед тренировкой - быстрые углеводы и немного белка, мало жира и клетчатки: энергия без тяжести.';
  if (s.kind === 'post') return s.light ? 'Поздно для ужина - лёгкий белок для восстановления без нагрузки на сон.'
    : 'В течение часа после тренировки: белок 20–30 г и углеводы на восстановление.';
  if (s.post) return 'После тренировки: белок 30–40 г и углеводы восполняют запасы - самое время для гарнира.';
  if (s.pre) return 'За 2–3 ч до тренировки - полноценная еда, но без жирного и тяжёлого.';
  if (s.kind === 'breakfast') return ctx.busyFrom !== null ? 'До работы: белок дольше держит сытость, цельная крупа - ровная энергия.' : 'Белок с утра дольше держит сытость, цельная крупа - ровная энергия.';
  if (s.kind === 'lunch') return 'Главный приём дня: белок, гарнир и овощи - половина тарелки.';
  if (s.kind === 'dinner') return `Не позже чем за 3 ч до сна: белок и овощи, гарнира поменьше.`;
  return 'Чтобы не приходить к следующему приёму голодным.';
}
const mealOf = s => ['breakfast', 'lunch', 'dinner'].includes(s.kind) ? s.kind : 'snack';

// ── цели по слотам ──
function slotTargets(slots, T) {
  const kShare = s => s.kind === 'breakfast' ? 0.25 : s.kind === 'lunch' ? 0.32 : s.kind === 'dinner' ? (s.post ? 0.28 : 0.24)
    : s.kind === 'pre' ? (s.light ? 0.05 : 0.09) : s.kind === 'post' ? (s.light ? 0.08 : 0.12) : 0.09;
  const pW = s => ['breakfast', 'lunch', 'dinner'].includes(s.kind) ? 1 : s.kind === 'post' ? 0.8 : s.kind === 'pre' ? 0.35 : 0.45;
  const fW = s => s.kind === 'pre' || s.pre ? 0.15 : s.kind === 'post' ? 0.3 : s.kind === 'snack' ? 0.6 : 1;
  const ks = slots.map(kShare), kSum = ks.reduce((a, x) => a + x, 0);
  const pw = slots.map(pW), pSum = pw.reduce((a, x) => a + x, 0);
  const fw = slots.map(fW), fSum = fw.reduce((a, x) => a + x, 0);
  const main = s => ['breakfast', 'lunch', 'dinner'].includes(s.kind);
  // белок: основной приём 25–45 г, после тренировки 20–30, остальное 8–20; излишек — основным приёмам
  let ps = slots.map((s, i) => T.p * pw[i] / pSum);
  ps = ps.map((p, i) => { const s = slots[i]; return main(s) ? clamp(p, Math.min(25, T.p * 0.2), 48) : s.kind === 'post' ? clamp(p, 20, s.light ? 25 : 32) : clamp(p, 6, 20); });
  const extra = T.p - ps.reduce((a, x) => a + x, 0), mains = slots.filter(main).length || 1;
  ps = ps.map((p, i) => main(slots[i]) ? Math.max(8, p + extra / mains) : p);
  return slots.map((s, i) => {
    const kcal = T.kcal * ks[i] / kSum, p = ps[i];
    let f = T.f * fw[i] / fSum;
    let c = (kcal - 4 * p - 9 * f) / 4;
    if (c < 0) { f = Math.max(2, (kcal - 4 * p) / 9); c = Math.max(0, (kcal - 4 * p - 9 * f) / 4); }
    return { kcal: Math.round(4 * p + 4 * c + 9 * f), p: r1(p), f: r1(f), c: r1(c) };
  });
}

// ── состав тарелки ──
// роль в подгонке: P — под белок, C — под углеводы, F — под жиры, X — фиксированная порция
function composition(s, ctx, sportOk) {
  const lc = ctx.lowCarb;
  if (s.kind === 'pre') return s.light ? [['C', ['fruit', 'dried', 'bread']]] : [['C', ['fruit', 'bread', 'dried']], ['P', sportOk.bar ? ['sport:bar', 'dairy'] : ['dairy']]];
  if (s.kind === 'post') return s.light ? [['P', ['dairy', 'egg']]] : [['P', sportOk.shake ? ['sport:shake', 'dairy'] : ['dairy', 'egg']], ['C', ['fruit', 'bread']]];
  if (s.kind === 'snack') return lc ? [['P', ['dairy', 'egg', 'cheese']], ['X', ['veg']], ['F', ['nuts']]] : [['P', ['dairy', 'egg']], ['X', ['fruit']], ['F', ['nuts']]];
  if (s.kind === 'breakfast' && !s.post) return lc ? [['P', ['egg', 'dairy']], ['X', ['veg']], ['F', ['fat', 'cheese', 'nuts']]]
    : [['P', ['egg', 'dairy']], ['C', ['grain:breakfast', 'bread']], ['X', ['fruit', 'veg']], ['F', ['nuts', 'fat']]];
  // обед, ужин и «после тренировки» основным приёмом
  const out = [['P', ['prot', ...(s.kind === 'breakfast' ? ['egg', 'dairy'] : [])]]];
  if (!lc) out.push(['C', s.kind === 'breakfast' ? ['grain:breakfast', 'bread'] : ['grain:side', 'bread']]);
  out.push(['X', ['veg']]);
  if (!s.pre) out.push(['F', ['oil']]);
  return out;
}

const BREAKFAST_GRAIN = /овсян|гречк|пшен|рисовые хлопья|гречневые хлопья|киноа|полба|хлопья/;
const SIDE_GRAIN = /гречк|рис|булгур|киноа|перлов|полба|макарон|картоф|батат|пшен|кускус|соба|удон|фунчоз/;
function poolFor(kind, cands, ctx) {
  if (kind === 'sport:shake') return cands.filter(c => c.role === 'sport' && /протеин|изолят|казеин|коктейль/.test(low(c.f.name)) && !/батончик/.test(low(c.f.name)));
  if (kind === 'sport:bar') return cands.filter(c => c.role === 'sport' && /батончик/.test(low(c.f.name)));
  if (kind === 'grain:breakfast') return cands.filter(c => c.role === 'grain' && BREAKFAST_GRAIN.test(low(c.f.name)));
  if (kind === 'grain:side') return cands.filter(c => c.role === 'grain' && SIDE_GRAIN.test(low(c.f.name)) && !/овсян/.test(low(c.f.name)));
  if (kind === 'fruit' && ctx.diet === 'diabetic') return cands.filter(c => c.role === 'fruit' && !/банан|виноград|манго|хурм/.test(low(c.f.name)));
  return cands.filter(c => c.role === kind);
}

// пределы порции (г) по роли и продукту
function bounds(f, kind, role, s) {
  const n = low(f.name);
  if (kind === 'sport:shake') return /коктейль/.test(n) ? [250, 330, 330] : [25, 30, 40];
  if (kind === 'sport:bar') return [f.portions?.['шт'] || 60, f.portions?.['шт'] || 60, f.portions?.['шт'] || 60];
  switch (kind.split(':')[0]) {
    case 'prot': return f.state === 'raw' ? [100, 150, 300] : [80, 140, 250];
    case 'egg': return /омлет|болтун|глазун/.test(n) ? [100, 150, 200] : [50, 100, 150];
    case 'dairy': return /кефир|ряжен|айран|простокваш|напиток/.test(n) ? [150, 250, 300] : [80, 150, 300];
    case 'cheese': return [20, 30, 50];
    case 'grain': return f.state === 'dry' ? [30, 60, 110] : [80, 180, 320];
    case 'bread': return [20, 40, 90];
    case 'fruit': { const pc = f.portions?.['шт']; return pc ? [pc, pc, pc * 2] : [100, 150, 250]; }
    case 'dried': return [15, 25, 40];
    case 'veg': return s.kind === 'snack' || s.kind === 'breakfast' ? [100, 150, 200] : [150, 200, 300];
    case 'oil': return [0, 5, 15];
    case 'nuts': return [10, 15, 30];
    case 'fat': return [30, 50, 100];
    default: return [30, 100, 250];
  }
}

// граммы: по кругу подгоняем белок, углеводы и жиры; фиксированное не трогаем
function solve(rows, tgt) {
  const val = (r, k) => (r.f[k] || 0) * r.g / 100;
  for (let it = 0; it < 25; it++) {
    for (const [role, key] of [['P', 'p'], ['C', 'c'], ['F', 'f']]) {
      const mine = rows.filter(r => r.fit === role && (r.f[key] || 0) > 0.5);
      if (!mine.length) continue;
      const others = rows.filter(r => !mine.includes(r)).reduce((a, r) => a + val(r, key), 0);
      const have = mine.reduce((a, r) => a + val(r, key), 0) || 1;
      const k = Math.max(0, tgt[key] - others) / have;
      for (const r of mine) r.g = clamp(r.g * k || r.lo, r.lo, r.hi);
    }
  }
}

function roundG(r) {
  const pc = r.f.portions?.['шт'] || r.f.portions?.['ломтик'];
  if (pc && ['egg', 'fruit', 'bread', 'sport'].includes(r.kind.split(':')[0])) {
    const n = Math.max(1, Math.round(r.g / pc * (r.kind === 'bread' ? 1 : 2)) / (r.kind === 'bread' ? 1 : 2));
    const whole = r.kind.startsWith('egg') ? Math.max(1, Math.round(r.g / pc)) : n;
    return { g: Math.round(whole * pc), pieces: whole, unit: r.f.portions?.['шт'] ? 'шт' : 'ломт.' };
  }
  if (r.kind === 'oil') return { g: Math.max(5, Math.round(r.g / 5) * 5) };
  const step = r.g < 100 ? 5 : 10;
  return { g: Math.max(step, Math.round(r.g / step) * step) };
}

// подсказка к весу: сухая крупа ↔ готовая, сырое мясо ↔ готовое
export function weightHint(it) {
  const f = it.food_id != null ? foods.get(it.food_id) : foods.findByName(it.name);
  if (!f) return '';
  const g = Number(it.grams) || 0;
  if (f.state === 'dry' && f.cooked_ratio > 1) return `сухой · ≈${Math.round(g * f.cooked_ratio / 10) * 10} г готовой`;
  if (f.state === 'raw' && f.cooked_ratio > 0 && f.cooked_ratio < 1) return `сырой вес · ≈${Math.round(g * f.cooked_ratio / 5) * 5} г готового`;
  if (f.state === 'cooked' && ['крупы', 'макароны'].includes(f.group)) {
    const b = baseKey(f.name);
    const dry = (store.getMeta('foods', null)?.items || []).find(x => x.state === 'dry' && x.cooked_ratio > 1 && baseKey(x.name) === b);
    if (dry) return `готовой · ≈${Math.round(g / dry.cooked_ratio / 5) * 5} г сухой`;
  }
  return '';
}

function pickFrom(pool, rng, used, usedBase) {
  const fresh = pool.filter(c => !used.has(c.f.id) && !usedBase.has(c.base));
  const src = (fresh.length ? fresh : pool).slice().sort((a, b) => b.score - a.score);
  if (!src.length) return null;
  if (src[0].home) {                                       // дома есть — берём из дома
    const homes = src.filter(c => c.home);
    return homes[Math.floor(rng() * homes.length)];
  }
  const top = src.slice(0, 4);
  const sum = top.reduce((a, c) => a + Math.max(1, c.score), 0);
  let x = rng() * sum;
  for (const c of top) { x -= Math.max(1, c.score); if (x <= 0) return c; }
  return top[0];
}

function assemble(s, tgt, ctx, cands, rng, used, usedBase, sportOk) {
  const rows = [];
  for (const [fit, kinds] of composition(s, ctx, sportOk)) {
    // спортпит — в приоритете, если уместен; остальные виды — общим списком, чтобы завтрак был не только из яиц
    let got = null;
    for (const k of kinds.filter(k => k.startsWith('sport'))) {
      const c = pickFrom(poolFor(k, cands, ctx), rng, used, usedBase);
      if (c) { got = { ...c, kind: k }; break; }
    }
    if (!got) {
      const pool = kinds.filter(k => !k.startsWith('sport')).flatMap(k => poolFor(k, cands, ctx).map(c => ({ ...c, kind: k })));
      got = pickFrom(pool, rng, used, fit === 'X' ? new Set() : usedBase);
    }
    if (!got) continue;
    const [lo, def, hi] = bounds(got.f, got.kind, fit, s);
    rows.push({ f: got.f, g: def, lo, hi, fit, kind: got.kind, home: got.home, own: got.own });
    used.add(got.f.id);
    if (fit !== 'X') usedBase.add(got.base);
  }
  solve(rows, tgt);
  // жирный белок (лосось, яйца) уже закрыл жиры слота — масло или орехи не нужны
  const fat = rows.reduce((x, r) => x + (r.f.f || 0) * r.g / 100, 0);
  for (const r of rows) if (r.fit === 'F' && fat - (r.f.f || 0) * r.g / 100 >= tgt.f - 2) r.g = 0;
  return rows;
}

// день целиком: белок и калории доводим по всем приёмам сразу (пределы порций чуть растянуты)
function dayFit(rows, T) {
  const sum = k => rows.reduce((x, r) => x + (r.f[k] || 0) * r.g / 100, 0);
  const scale = (sel, key, gap) => {
    const mine = rows.filter(r => sel(r) && r.g > 0 && (r.f[key] || 0) > 0);
    const have = mine.reduce((x, r) => x + (r.f[key] || 0) * r.g / 100, 0);
    if (!mine.length || have <= 0) return;
    const k = 1 + gap / have;
    for (const r of mine) r.g = clamp(r.g * k, r.lo, r.kind === 'egg' ? r.hi : r.hi * 1.25);
  };
  for (let i = 0; i < 4; i++) {
    scale(r => r.fit === 'P' && !r.kind.startsWith('sport'), 'p', T.p - sum('p'));
    if (sum('f') > T.f * 1.1) scale(r => r.fit === 'F', 'f', T.f - sum('f'));
    scale(r => r.fit === 'C' && r.kind !== 'fruit', 'kcal', T.kcal - sum('kcal'));
  }
}

function toItems(rows, cands) {
  const items = [];
  for (const r of rows) {
    if (r.g < 2.5) continue;
    const { g, pieces, unit } = roundG(r);
    const it = foods.itemFor(r.f, g);
    it.fiber = r1(fiberOf(r.f) * g / 100);
    if (pieces) it.pieces = `${String(pieces).replace('.', ',')} ${unit}`;
    if (r.home) it.home = true;
    if (r.own) it.usual = true;
    if (r.kind.startsWith('sport')) {
      it.optional = true;
      const alt = cands.filter(c => c.role === 'dairy' && c.f.p >= 8).sort((a, b) => b.score - a.score)[0];
      if (alt) it.alt = `${alt.f.name} ${Math.round(it.p / alt.f.p * 100 / 10) * 10} г`;
    }
    const h = weightHint(it);
    if (h) it.hint = h;
    items.push(it);
  }
  return items;
}

const sumOf = items => {
  const t = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
  for (const i of items) for (const k in t) t[k] += Number(i[k]) || 0;
  return { kcal: Math.round(t.kcal), p: r1(t.p), f: r1(t.f), c: r1(t.c), fiber: r1(t.fiber) };
};

// ── оценка «здоровости» плана ──
export function healthOf(slots, T) {
  const items = slots.flatMap(s => s.items || []);
  const tot = sumOf(items);
  const notes = [];
  const fiberT = T.fiber || Math.round(T.kcal / 1000 * 14);
  const fib = Math.min(1, tot.fiber / fiberT);
  notes.push(fib >= 0.9 ? `Клетчатка ≈${Math.round(tot.fiber)} г из ${fiberT} - хорошо.` : `Клетчатки ≈${Math.round(tot.fiber)} г из ${fiberT}: добавьте овощей или бобовых.`);
  const mains = slots.filter(s => ['breakfast', 'lunch', 'dinner'].includes(s.kind) && s.items?.length);
  const okP = mains.filter(s => sumOf(s.items).p >= 20).length;
  const spread = mains.length ? okP / mains.length : 0;
  notes.push(spread >= 1 ? 'Белок распределён по всем основным приёмам.' : 'В одном из основных приёмов мало белка.');
  const sugar = items.filter(i => { const f = i.food_id != null ? foods.get(i.food_id) : null; return C.foodFlags(i.name, f?.group).has('sugar') || (f && DRIED_RE.test(low(f.name))); }).length;
  const sug = sugar === 0 ? 1 : sugar === 1 ? 0.6 : 0.2;
  if (sugar) notes.push('Есть немного сахара (сухофрукты или батончик) - это к тренировке, не каждый день.');
  const distinct = new Set(items.map(i => i.food_id ?? i.name)).size;
  const vegFruit = items.reduce((a, i) => { const f = i.food_id != null ? foods.get(i.food_id) : null; return a + (f && ['овощи', 'фрукты и ягоды'].includes(f.group) && !/^картоф|^батат/.test(low(f.name)) ? Number(i.grams) || 0 : 0); }, 0);
  const vari = Math.min(1, distinct / 10) * 0.5 + Math.min(1, vegFruit / 400) * 0.5;
  notes.push(vegFruit >= 400 ? `Овощи и фрукты: ${Math.round(vegFruit)} г - норма ВОЗ (400 г) есть.` : `Овощей и фруктов ${Math.round(vegFruit)} г - до 400 г не хватает.`);
  const score = Math.round(30 * fib + 25 * spread + 15 * sug + 30 * vari);
  return { score, parts: { fiber: Math.round(fib * 100), protein: Math.round(spread * 100), sugar: Math.round(sug * 100), variety: Math.round(vari * 100) }, notes, fiber_target: fiberT, veg_fruit_g: Math.round(vegFruit), distinct };
}

// дневная цель: нормы; в день тренировки часть энергии жиров уходит в углеводы вокруг нагрузки
function dayTarget(ctx) {
  const t = C.target(ctx.uid);
  let T, note = '';
  if (t?.kcal) T = { kcal: +t.kcal, p: +t.p || 0, f: +t.f || 0, c: +t.c || 0, fiber: +t.fiber || 0 };
  else {
    const w = Number(ctx.p.weight) || [...store.list('body', ctx.uid)].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0]?.data?.weight || 70;
    T = { kcal: Math.round(w * 28), p: Math.round(w * 1.6), f: Math.round(w * 0.9), c: 0, fiber: 0 };
    T.c = Math.round((T.kcal - 4 * T.p - 9 * T.f) / 4);
    note = 'Нормы ещё не посчитаны - цифры примерные, по весу. Посчитайте нормы в профиле.';
  }
  if (!T.c) T.c = Math.max(0, Math.round((T.kcal - 4 * T.p - 9 * T.f) / 4));
  if (ctx.workout && ctx.workout.intensity !== 'low' && !ctx.lowCarb) {
    const dc = Math.round(T.c * 0.08);
    T.c += dc; T.f = Math.max(30, Math.round(T.f - dc * 4 / 9));
  }
  return { T, note };
}

// ── главная функция ──
// opts: { variant: число для «другой вариант», workoutTime: 'HH:MM', fullDay: bool — не учитывать уже съеденное }
export function buildDayPlan(date, opts = {}) {
  const ctx = context(date, opts);
  const { T, note } = dayTarget(ctx);
  const { list: cands, skipped } = candidates(ctx);
  const usage = foods.usage();
  const sportHist = [...usage.keys()].some(id => foods.get(id)?.group === 'спортпит');
  const gain = ctx.goals.has('gain_muscle') || ctx.goals.has('gain_weight');
  const sportAllowed = !!ctx.workout && (sportHist || gain);
  const sportOk = { shake: sportAllowed && poolFor('sport:shake', cands, ctx).length > 0, bar: sportAllowed && sportHist && poolFor('sport:bar', cands, ctx).some(c => c.own || c.home) };
  const raw = buildSlots(ctx);
  // сегодня: уже прошедшие приёмы и записи из дневника; остаток цели распределяем на оставшиеся слоты
  const isToday = date === C.today();
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const dayFood = store.byDate('food', date);
  const eaten = sumOf(dayFood.map(r => r.data.totals || {}));
  const done = new Map(dayFood.filter(r => r.data.mp_slot).map(r => [r.data.mp_slot, r]));
  const adjust = isToday && !opts.fullDay && eaten.kcal > 0;
  const slots = raw.map(s => ({ ...s, time: hmOf(s.t), label: slotLabel(s), reason: slotReason(s, ctx), meal: mealOf(s) }));
  for (const s of slots) {
    if (done.has(s.key)) { s.status = 'logged'; s.items = done.get(s.key).data.items || []; }
    else if (adjust && s.t < nowM - 20) s.status = 'past';
  }
  const open = slots.filter(s => !s.status);
  let rest = T;
  if (adjust) rest = { kcal: Math.max(0, T.kcal - eaten.kcal), p: Math.max(0, T.p - eaten.p), f: Math.max(0, T.f - eaten.f), c: Math.max(0, T.c - eaten.c), fiber: T.fiber };
  const tg = open.length ? slotTargets(open, rest) : [];
  const rng = rngOf(`${ctx.uid}|${date}|${opts.variant || 0}`);
  const used = new Set(), usedBase = new Set();
  // сначала основные приёмы — им достаются лучшие белки, потом перекусы
  const order = open.map((s, i) => i).sort((a, b) => ['lunch', 'dinner', 'breakfast', 'post', 'pre', 'snack'].indexOf(open[a].kind) - ['lunch', 'dinner', 'breakfast', 'post', 'pre', 'snack'].indexOf(open[b].kind));
  for (const i of order) {
    const s = open[i];
    s.target = tg[i];
    s._rows = rest.kcal < 150 ? [] : assemble(s, tg[i], ctx, cands, rng, used, usedBase, sportOk);
  }
  dayFit(open.flatMap(s => s._rows), rest);
  for (const s of open) {
    s.items = toItems(s._rows, cands);
    delete s._rows;
    if (s.items.length && ['lunch', 'dinner'].includes(s.kind)) s.title = s.items.slice(0, 3).map(i => i.name.replace(/\s+(сыр(ой|ая|ое|ые)|сух(ой|ая|ое|ие)|варён[а-я]*|запечённ[а-я]*)$/i, '')).join(', ').toLowerCase().replace(/^./, c => c.toUpperCase());
  }
  for (const s of slots) { s.totals = sumOf(s.items || []); delete s.t; }
  const planned = slots.filter(s => s.status !== 'past');
  const plannedItems = planned.flatMap(s => s.items || []);
  const totals = sumOf(plannedItems);
  const dayTotals = adjust ? sumOf([...dayFood.map(r => r.data.totals || {}).filter(x => x.kcal), ...open.flatMap(s => s.items)]) : totals;
  const diff_pct = {};
  for (const k of ['kcal', 'p', 'f', 'c']) diff_pct[k] = T[k] ? Math.round((dayTotals[k] - T[k]) / T[k] * 100) : null;
  const notes = [];
  if (note) notes.push(note);
  if (ctx.workout) notes.push(`${ctx.workout.source === 'workout' ? 'Тренировка' : ctx.workout.title} в ${hmOf(ctx.workout.time)}, ~${ctx.workout.minutes} мин${ctx.workout.how === 'guess' ? ' (время прикинуто по распорядку - поправьте, если иначе)' : ''}. Углеводов в этот день чуть больше - вокруг нагрузки.`);
  for (const a of ctx.acts) if (!ctx.workout || a.name !== ctx.workout.title) notes.push(`${a.logged ? 'Записана' : 'Запланирована'} активность: ${a.name}, ${a.minutes} мин.`);
  if (adjust) notes.push(`Учтено уже съеденное: ${eaten.kcal} ккал - план на оставшиеся приёмы.`);
  if (skipped.size) notes.push(`Из вашей истории не предлагаю: ${[...skipped.keys()].slice(0, 5).join(', ').toLowerCase()} - это не про здоровое питание.`);
  if (ctx.p.allergies) notes.push(`Исключено по аллергиям: «${String(ctx.p.allergies).slice(0, 60)}».`);
  if (ctx.meds) notes.push('Вы указали лекарства: грейпфрут и помело убраны (частое взаимодействие). По остальному - к врачу; это не медицинская рекомендация.');
  if (ctx.p.limitations?.includes('diabetes') || ctx.diet === 'diabetic') notes.push('При диабете порции углеводов согласуйте с врачом - план не заменяет его рекомендации.');
  const health = healthOf(planned.filter(s => s.items?.length), T);
  return {
    date, source: 'local', variant: opts.variant || 0, generated: Date.now(), target: T, eaten: adjust ? eaten : null,
    slots, totals, day_totals: dayTotals, diff_pct, health, notes,
    workout: ctx.workout ? { title: ctx.workout.title, time: hmOf(ctx.workout.time), minutes: ctx.workout.minutes, how: ctx.workout.how, source: ctx.workout.source } : null,
    activities: ctx.acts.map(a => ({ name: a.name, minutes: a.minutes, intensity: a.intensity })),
    wake: hmOf(ctx.wake), bed: hmOf(ctx.bed), pantry_n: pantry().length,
    usual_n: cands.filter(c => c.own).length, thin: cands.filter(c => c.own).length < 8,
  };
}

// вход ИИ-задачи mealplan: слоты со временем и целями, продукты человека, дом, исключения, нагрузка
export function aiInput(plan) {
  const { list: cands, skipped } = candidates(context(plan.date, {}));
  const usual = cands.filter(c => c.own).sort((a, b) => b.own - a.own).slice(0, 30).map(c => c.f.name);
  return {
    date: plan.date, variant: 'day',
    slots: plan.slots.filter(s => !s.status).map(s => ({ key: s.key, kind: s.kind, time: s.time, label: s.label, reason: s.reason, meal: s.meal,
      target: s.target, items: (s.items || []).map(i => ({ name: i.name, grams: i.grams })) })),
    pantry: pantry().map(x => x.name),
    usual_foods: usual,
    exclude: [...skipped.keys(), ...excluded().map(x => x.name)],
    workout: plan.workout, activities: plan.activities,
    target: plan.target, eaten: plan.eaten,
  };
}

// ИИ-рацион на дату (запись coach kind mealplan, variant day) → в той же форме, что локальный
export function aiPlanFor(date) {
  const recs = store.list('coach').filter(r => r.data.kind === 'mealplan' && r.data.variant === 'day' && r.data.date === date);
  recs.sort((a, b) => (b.data.created || b.updated_at) - (a.data.created || a.updated_at));
  const r = recs[0];
  if (!r) return null;
  const d = r.data;
  // клетчатку и подсказки к весу считаем здесь: сервер отдаёт только БЖУ из справочника
  const slots = (d.slots || []).map(s => {
    const items = (s.items || []).map(it => {
      const f = it.food_id != null ? foods.get(it.food_id) : foods.findByName(it.name);
      const h = weightHint(it);
      return { ...it, ...(h ? { hint: h } : {}), fiber: f ? r1(fiberOf(f) * (Number(it.grams) || 0) / 100) : 0 };
    });
    return { ...s, items, totals: sumOf(items) };
  });
  const T = d.target || {};
  const totals = sumOf(slots.flatMap(s => s.items));
  const eaten = d.eaten || null;
  const day_totals = eaten ? { ...totals, kcal: totals.kcal + (eaten.kcal || 0), p: r1(totals.p + (eaten.p || 0)), f: r1(totals.f + (eaten.f || 0)), c: r1(totals.c + (eaten.c || 0)) } : totals;
  const notes = [...(d.notes || []), ...(eaten?.kcal ? [`Учтено уже съеденное: ${Math.round(eaten.kcal)} ккал - план на оставшиеся приёмы.`] : [])];
  return { ...d, id: r.id, source: 'ai', slots, totals, day_totals, notes, health: healthOf(slots, { kcal: 2000, ...T }) };
}
