// Разбор записи о еде без сервера: «гречка 200г, 2 яйца, кофе с молоком», «тарелка борща», «пол пачки творога».
// Порт app/food.py (split, parse_chunk, stem, match, grams_for, prefer_used) — правила должны совпадать с сервером,
// иначе одна и та же запись посчитается по-разному офлайн и онлайн. Сверху — память «мозга» (brain.js):
// фразы, которые ИИ уже разбирала, синонимы и порции. Справочник — кэш foods.js (meta 'foods').
import * as store from './store.js';
import * as foods from './foods.js';
import * as brain from './brain.js';

const W = '[\\p{L}\\p{N}_]';                 // \w с Юникодом: в JS \w и \b кириллицу не знают
const UNITS = [
  [`кг|килограмм${W}*`, 'kg'], [`г|гр|грамм${W}*`, 'g'], [`мл|миллилитр${W}*`, 'ml'], [`л|литр${W}*`, 'l'],
  [`шт${W}*|штук${W}*`, 'шт'], [`ст\\.?\\s?л\\.?|столов${W}+\\s+лож${W}*`, 'ст.л.'], [`ч\\.?\\s?л\\.?|чайн${W}+\\s+лож${W}*`, 'ч.л.'],
  [`стакан${W}*`, 'стакан'], [`чашк${W}*|чашек`, 'чашка'], [`ломтик${W}*|ломт${W}*`, 'ломтик'],
  [`кус${W}*`, 'кусок'], [`тарел${W}*`, 'тарелка'], [`порци${W}*`, 'порция'], [`горст${W}*`, 'горсть'],
];
const UNIT_RE = UNITS.map(([p]) => `(?:${p})`).join('|');
const UNIT_FULL = UNITS.map(([p, code]) => [new RegExp(`^(?:${p})$`, 'iu'), code]);
const WORD_NUM = { 'пол': 0.5, 'половина': 0.5, 'половинка': 0.5, 'один': 1, 'одна': 1, 'одно': 1, 'два': 2, 'две': 2,
  'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'полтора': 1.5, 'полторы': 1.5 };
const QTY_RE = new RegExp(`(?<![\\p{L}\\p{N}_.,])(?<n>\\d+(?:[.,]\\d+)?|${Object.keys(WORD_NUM).join('|')})(?![.,]?\\d)\\s*(?<u>${UNIT_RE})?(?=$|[\\s.,)])`, 'iu');
const BARE_UNIT_RE = new RegExp(`(?<!${W})(?:стакан${W}*|чашк${W}*|тарел${W}*|кус${W}*|ломтик${W}*|порци${W}*|горст${W}*|ст\\.\\s?л\\.?|ч\\.\\s?л\\.?)(?!${W})`, 'iu');
// слова состояния: «гречка сухая», «рис варёный» — выбор состояния сделал человек, историю не применяем
const STATE_WORDS = new RegExp(`(?<!${W})(сух${W}*|сыр(ой|ая|ое|ые|ом|ую)|вар[её]н${W}*|отварн${W}*|готов${W}*|жарен${W}*|запеч[её]н${W}*|`
  + `тушен${W}*|на пару|крупа|хлопь${W}*|каш${W}+|свеж${W}*)(?!${W})`, 'iu');
const MASS = { g: 1, ml: 1, kg: 1000, l: 1000 };

// как food.norm на сервере: всё, кроме букв, цифр, пробелов, % . - — в пробел
export const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}_\s%.-]/gu, ' ')
  .replace(/\s+/g, ' ').replace(/^[ .-]+|[ .-]+$/g, '');

export function unitCode(u) {
  if (!u) return null;
  const t = u.trim();
  for (const [re, code] of UNIT_FULL) if (re.test(t)) return code;
  return null;
}

export function split(text) {
  // запятая внутри числа («молоко 1,5%») — не разделитель
  return String(text || '').split(/(?<!\d),|,(?!\d)|[;\n+]|\s+и\s+(?=\d)/).map(p => (p || '').trim()).filter(Boolean);
}

// → [название, количество | null, единица | null]
export function parseChunk(chunk) {
  const m = QTY_RE.exec(chunk);
  if (!m) {
    // «тарелка борща», «стакан кефира» — единица без числа значит одну штуку
    const u = BARE_UNIT_RE.exec(chunk);
    if (u) return [norm(chunk.slice(0, u.index) + ' ' + chunk.slice(u.index + u[0].length)), 1, unitCode(u[0])];
    return [norm(chunk), null, null];
  }
  const raw = m.groups.n.toLowerCase().replace(',', '.');
  const n = WORD_NUM[raw] ?? parseFloat(raw);
  return [norm(chunk.slice(0, m.index) + ' ' + chunk.slice(m.index + m[0].length)), n, unitCode(m.groups.u)];
}

const ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее',
  'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь'].sort((a, b) => b.length - a.length);
export function stem(name) {
  return norm(name).split(' ').filter(Boolean).map(w => {
    if (w.length > 3) for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
    return w;
  }).join(' ');
}
const baseName = name => stem(norm(name).replace(new RegExp(STATE_WORDS.source, 'giu'), ' '));

// ── индекс справочника (перестраивается, когда меняется кэш foods.js) ──
let idx = null, idxKey = '';
function index() {
  const cache = store.getMeta('foods', null), pending = store.getMeta('foods_pending', []);
  const key = `${cache?.ts || 0}:${cache?.items?.length || 0}:${pending.length}`;
  if (idx && key === idxKey) return idx;
  const list = [...(cache?.items || []), ...pending];
  const keys = new Map(), stems = new Map(), bases = new Map(), byId = new Map();
  for (const f of list) {
    byId.set(f.id, f);
    for (const k of [f.name, ...(f.aliases || [])]) {
      const nk = norm(k);
      if (!keys.has(nk)) keys.set(nk, f);
      const sk = stem(k);
      if (!stems.has(sk)) stems.set(sk, f);
    }
    const b = baseName(f.name);
    if (!bases.has(b)) bases.set(b, []);
    bases.get(b).push(f);
  }
  idx = { keys, stems, bases, byId, size: list.length };
  idxKey = key;
  return idx;
}
export const ready = () => index().size > 0;

// близкое написание («гречкка»): аналог difflib cutoff 0.86 — по расстоянию Левенштейна, только среди ключей похожей длины
function lev(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}
function close(name, keys) {
  if (name.length < 4) return null;
  let best = null, bestR = 0.86;
  for (const [k, f] of keys) {
    if (Math.abs(k.length - name.length) > 3 || k[0] !== name[0]) continue;
    const r = 1 - lev(name, k) / Math.max(name.length, k.length);
    if (r >= bestR) { bestR = r; best = f; }
  }
  return best;
}

function siblings(f) {
  return (index().bases.get(baseName(f.name)) || []).filter(x => x.id !== f.id && x.state !== f.state);
}
// «гречка 80 г» без слова о состоянии: если человек обычно пишет сухую — берём сухую (как prefer_used на сервере)
function preferUsed(f) {
  const u = foods.usage();
  const cnt = x => u.get(x.id)?.count || 0;
  let best = null;
  for (const s of siblings(f)) if (!best || cnt(s) > cnt(best)) best = s;
  return best && cnt(best) > cnt(f) ? best : f;
}

// alias: искать и в синонимах из памяти («гречневая каша с маслом» → продукт); onlyAlias — только в них
export function match(name, { raw = false, alias = true, onlyAlias = false } = {}) {
  const I = index();
  const n = norm(name);
  if (!n) return null;
  let f = onlyAlias ? null : I.keys.get(n) || I.stems.get(stem(n)) || null;
  if (!f && (alias || onlyAlias)) {
    const fid = brain.alias(stem(n));
    f = fid != null ? I.byId.get(fid) || null : null;
  }
  if (!f && !onlyAlias) f = close(n, I.keys);
  if (f && !raw && !STATE_WORDS.test(n)) f = preferUsed(f);
  return f;
}

// граммы по количеству и единице; порции — справочник, а уверенная поправка людей (память ≥ 0,7) важнее
export function gramsFor(food, n, unit) {
  const portions = food.portions || {};
  if (unit === 'g' || unit === 'ml') return n;
  if (unit === 'kg' || unit === 'l') return n * 1000;
  const learned = (u, c) => (typeof food.id === 'number' ? brain.portion(food.id, u, c) : null);
  if (n == null) {
    for (const u of ['порция', 'шт', 'чашка', 'стакан', 'тарелка', 'кусок']) if (u in portions) return learned(u, 0.7) ?? portions[u];
    return null;
  }
  if (unit == null) {
    // «2 яйца» — штуки; «гречка 200» — граммы
    if (n > 20) return n;
    const g = learned('шт', 0.7) ?? portions['шт'] ?? learned('шт');
    return g ? n * g : null;
  }
  const g = learned(unit, 0.7) ?? portions[unit] ?? learned(unit);
  return g ? n * g : null;
}

const r1 = x => Math.round(x * 10) / 10;
export function itemFrom(food, grams, text, source = 'db') {
  const k = grams / 100;
  const it = { text, name: food.name, grams: Math.round(grams), kcal: Math.round((food.kcal || 0) * k), p: r1((food.p || 0) * k),
    f: r1((food.f || 0) * k), c: r1((food.c || 0) * k), source };
  if (food.id != null) it.food_id = food.id;
  if (food.state) it.state = food.state;
  return it;
}

// ключ фразы в памяти — как brain.phrase_key на сервере: «основа названия|единица» (граммы → g)
export function phraseParts(chunk) {
  const [name, n, unit] = parseChunk(chunk);
  const base = stem(name);
  if (!base) return null;
  if (unit in MASS) return { base, n: (n || 0) * MASS[unit], unit: 'g', key: `${base}|g` };
  return { base, n: n || 1, unit: unit || '', key: `${base}|${unit || ''}` };
}

// одна часть текста → позиции или null
function parsePiece(chunk) {
  const I = index();
  const [name, n, unit] = parseChunk(chunk);
  const byFood = (f, source) => {
    const g = f ? gramsFor(f, n, unit) : null;
    if (!g) return null;
    const it = itemFrom(f, g, chunk, source);
    const pu = unit && !(unit in MASS) ? unit : n != null && unit == null && n <= 20 ? 'шт' : null;
    if (pu) Object.assign(it, { pu, pn: n || 1 });
    return [it];
  };
  // 1) справочник (как quick_parse на сервере)
  const hit = byFood(match(name, { alias: false }), 'db');
  if (hit) return hit;
  // 2) память: фраза целиком, которую уже разбирала ИИ («кружка какао с зефирками»), — с её граммами
  const pp = phraseParts(chunk);
  const ph = pp && pp.n ? brain.phrase(pp.key) : null;
  if (ph?.items?.length) {
    const fs = ph.items.map(x => [I.byId.get(x.food_id), x.g]);
    if (fs.every(([fd]) => fd)) return fs.map(([fd, gg]) => ({ ...itemFrom(fd, gg * pp.n, chunk, 'brain'), phrase: pp.key, pn: pp.n }));
  }
  // 3) память: синоним продукта + порция из справочника или памяти
  return byFood(match(name, { onlyAlias: true }), 'brain');
}

// Разбор текста → { items, rest }: rest — куски, которые без ИИ не понять
export function parse(text) {
  const items = [], rest = [];
  for (const chunk of split(text)) {
    const got = ready() ? parsePiece(chunk) : null;
    if (got) items.push(...got); else rest.push(chunk);
  }
  return { items, rest };
}

export function totals(items) {
  const t = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const it of items) for (const k in t) t[k] += Number(it[k]) || 0;
  return { kcal: Math.round(t.kcal), p: r1(t.p), f: r1(t.f), c: r1(t.c) };
}

// Поля записи food по локальному разбору: всё понятно — сразу «посчитано по справочнику»; часть — частичный
// итог и список того, что нужно ИИ; справочник ещё не загружен — ничего не меняем (посчитает сервер).
export function localCalc(text) {
  if (!ready()) return {};
  const { items, rest } = parse(text);
  if (items.length && !rest.length) return { items, totals: totals(items), status: 'calculated', calc: 'local', unresolved: null, partial: null };
  if (items.length) return { items, totals: totals(items), status: 'raw', unresolved: rest, partial: true };
  return { unresolved: rest.length ? rest : null };
}
