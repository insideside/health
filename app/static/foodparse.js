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

// точка после количества или слова - конец продукта: «хлеб 25 гр. форель 50 г», «кофе. молоко» (но не «1 ст. л.»)
const QTY_DOT_RE = /(\d\s*(?:г|гр|грамм\p{L}*|кг|мл|л|шт|штук\p{L}*)?|\p{L}{3,})\.\s+(?=[\p{L}\d])/giu;
// продолжение предыдущего продукта после запятой: «2 куриных ножки, запечённых с оливками», «кофе, на молоке»
const CONT_RE = /^(?:(?:с|со|в|во|на|под|без|из|по)\s|[а-яё]+(?:нн|енн|анн|ённ)[а-яё]{1,3}(?:\s|$))/iu;
// границы между заведомо разными блюдами: «;», перенос строки, «+». Запятая внутри — слабая граница (см. split):
// у составного блюда через запятую часто перечислены его части («рис с креветками, яйцом и луком»), а не отдельные блюда.
export function splitStrong(text) {
  // запятая внутри числа («молоко 1,5%») уже защищена этой заменой
  return String(text || '').replace(QTY_DOT_RE, '$1, ').split(/[;\n+]/).map(p => (p || '').trim()).filter(Boolean);
}
export function split(text) {
  return splitStrong(text).flatMap(splitWeak);
}
// один кусок «между ;/переносами строк» → отдельные продукты: по запятой и «и» перед числом
export function splitWeak(text) {
  const parts = String(text || '').split(/(?<!\d),|,(?!\d)|\s+и\s+(?=\d)/).map(p => (p || '').trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    // кусок без количества, который начинается с предлога или причастия, - уточнение предыдущего продукта
    if (out.length && !QTY_RE.test(p) && !BARE_UNIT_RE.test(p) && CONT_RE.test(p)) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out.flatMap(splitTwo);
}
// два количества с единицами в одном куске: «творог 200 г со сметаной 20 г» → два продукта (как food.split_two)
function splitTwo(p) {
  const re = new RegExp(QTY_RE.source, 'giu');
  const ms = [...p.matchAll(re)].filter(m => m.groups.u);
  if (ms.length < 2) return [p];
  const end0 = ms[0].index + ms[0][0].length, gap = p.slice(end0, ms[1].index);
  const js = [...gap.matchAll(/\s(?:с|со|и|плюс)\s/giu)];
  if (!js.length) return [p];
  const j = js[js.length - 1];
  return [p.slice(0, end0 + j.index).trim(), ...splitTwo(p.slice(end0 + j.index + j[0].length).trim())];
}

// ── явные КБЖУ/БЖУ в тексте: «курица 200г 250/30/5/10», «250/30/5/10 курица 200г», «кбжу: 250/30/5/10» (как food.py) ──
// 4 числа — калории/белки/жиры/углеводы по порядку; 3 — белки/жиры/углеводы (калории считаем). Числа относятся
// к продукту рядом (в том же куске или в соседнем, если написаны отдельной строкой), и это значения на 100 г
// продукта (как в справочниках питания) — итог в БЖУ приёма пищи считаем на реально указанный вес; если продукта
// ещё нет в справочнике — он запоминается там как есть (per100).
const NUM = '\\d+(?:[.,]\\d+)?';
// число, за которым сразу (без разделителя-цифры) не идёт единица веса - иначе это не значение КБЖУ, а вес
// продукта: «…17.9, 170г» (запятая перед весом как ещё один разделитель списка) не должно принять «170» за
// 4-е число КБЖУ. JS не умеет possessive-квантификаторы/атомарные группы (в отличие от re в Python) - тот же
// эффект (число не может «сжаться» при бэктрекинге на пути к проверке единицы) даёт связка lookahead+backref:
// число один раз жадно захватывается в именованную группу, затем сопоставляется с ней же буквально.
let _macroTag = 0;
function numStrict() {
  const g = `mn${_macroTag++}`;
  // \b в JS не видит кириллицу словом даже с флагом 'u' - граница берётся через (?!W), как везде в этом файле
  return `(?=(?<${g}>${NUM}))\\k<${g}>(?!\\s*(?:кг|км|г|гр|грамм${W}*|мл|л|литр${W}*)(?!${W}))`;
}
const MACRO_LABEL_RE = /(?:^|\s)(?:кбжу|бжу)\s*:?(?=\s|$)/giu;
// числа КБЖУ подряд: через / \ (пробелы вокруг не обязательны) или через запятую с пробелом после -
// «191, 12.5, 11.83, 8.97»; запятая без пробела после («12,5») — десятичная, не разделитель, её не трогаем
const SEP = '(?:\\s*[/\\\\]\\s*|,\\s+)';
const MACRO_SLASH_RE = new RegExp(
  `(?<![\\d.,/\\\\])(?<v1>${numStrict()})${SEP}(?<v2>${numStrict()})${SEP}(?<v3>${numStrict()})(?:${SEP}(?<v4>${numStrict()}))?`
  + `(?!\\d|\\.)(?!${SEP}${numStrict()})`, 'gu');
// кусок целиком — только числа через пробел (после разбиения по ;/переносам строк так остаётся, если КБЖУ
// написаны отдельной строкой без названия рядом, «Курица\n250 30 5 10»)
const MACRO_WHOLE_RE = new RegExp(
  `^\\s*(?:кбжу|бжу)?\\s*:?\\s*(?<v1>${numStrict()})[\\s/\\\\]+(?<v2>${numStrict()})[\\s/\\\\]+(?<v3>${numStrict()})`
  + `(?:[\\s/\\\\]+(?<v4>${numStrict()}))?\\s*$`, 'iu');
const nums = m => [m.groups.v1, m.groups.v2, m.groups.v3, m.groups.v4].filter(Boolean).map(x => parseFloat(x.replace(',', '.')));
function macroFrom(ns) {
  let kcal, p, f, c;
  if (ns.length === 4) [kcal, p, f, c] = ns; else { [p, f, c] = ns; kcal = 4 * p + 9 * f + 4 * c; }
  return { kcal: Math.round(kcal), p: r1(p), f: r1(f), c: r1(c) };
}
// кусок текста (между ;/переносами строк) с одним или несколькими КБЖУ → [[кусок без этих чисел, КБЖУ], …],
// по одной паре на каждое вхождение — так «курица кбжу А, В кбжу Б» не сливает два блюда в одно. Между двумя
// вхождениями режем по первой запятой: то, что до неё, — хвост (обычно вес) текущего блюда, после — начало
// следующего. Нет чисел вовсе — null (кусок обрабатывается как обычно, по справочнику) — как food.split_macro_segment.
function splitMacroSegment(seg) {
  const whole = MACRO_WHOLE_RE.exec(seg);
  if (whole) return [['', macroFrom(nums(whole))]];
  const re = new RegExp(MACRO_SLASH_RE.source, 'gu');
  const ms = [...seg.matchAll(re)];
  if (!ms.length) return null;
  const out = [];
  let prevEnd = 0;
  ms.forEach((m, i) => {
    const nextStart = i + 1 < ms.length ? ms[i + 1].index : seg.length;
    const between = seg.slice(m.index + m[0].length, nextStart);
    const cut = i + 1 < ms.length ? between.indexOf(',') : -1;
    const tail = cut < 0 ? between : between.slice(0, cut);
    const macro = macroFrom(nums(m));
    const name = (seg.slice(prevEnd, m.index) + ' ' + tail).replace(MACRO_LABEL_RE, ' ').replace(/\s+/g, ' ').trim();
    out.push([name, macro]);
    prevEnd = m.index + m[0].length + tail.length + (cut >= 0 ? 1 : 0);
  });
  return out;
}
// куски → [[кусок без КБЖУ, КБЖУ | null], …], по одной паре на каждое найденное КБЖУ - один кусок может дать
// и несколько пар (см. splitMacroSegment). КБЖУ без названия рядом (своя строка, цифры отдельно) приклеиваются
// к соседней паре — сначала к предыдущей, иначе к следующей — как food.macro_annotate.
export function macroAnnotate(chunks) {
  const parsed = chunks.flatMap(c => splitMacroSegment(c) ?? [[c, null]]);
  const out = parsed.map(([name, macro]) => [name, macro]);
  parsed.forEach(([name, macro], i) => {
    if (name || macro == null) return;
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < out.length && out[j][0] && out[j][1] == null) { out[j][1] = macro; break; }
    }
  });
  return out.filter(([name]) => name);
}

// уточнения, которые мешают найти продукт: «(это в сухом виде)», «сорта богатырь», «марки …» (как food.prepare)
const QUALIFIER_RE = new RegExp(`(?<!${W})(?:сорта|сорт|марки|фирмы|бренда|производства)\\s+[\\p{L}\\p{N}-]+`, 'giu');
const WITHOUT_RE = new RegExp(`(?<!${W})без\\s+[\\p{L}\\p{N}-]+`, 'giu');
// «… с оливками»: добавка к блюду без своего количества - отдельный продукт, если блюдо её не покрывает
const WITH_RE = /\s(?:с|со|плюс)\s+(.+)$/iu;
const SMALL_RE = new RegExp(`(?<!${W})(?:немного|немножко|чуть-чуть|чуть|щепотк${W}*|несколько листьев|пар[ау] листьев)(?!${W})`, 'giu');
const STATE_HINT = [[/сух/i, 'сухой'], [/сыр(ой|ая|ое|ом)/i, 'сырой'], [/вар[её]н|отварн/i, 'варёный'], [/запеч/i, 'запечённый'], [/жарен/i, 'жареный'], [/готов/i, 'готовый']];
export const SMALL_G = 20;          // «немного» без числа - горсть или 20 г
export function prepare(chunk) {
  let hint = null;
  for (const m of String(chunk).matchAll(/\(([^)]*)\)/g)) {
    for (const [re, w] of STATE_HINT) if (re.test(m[1])) { hint = w; break; }
  }
  let text = String(chunk).replace(/\([^)]*\)/g, ' ');
  if (hint) text = text.replace(new RegExp(STATE_WORDS.source, 'giu'), ' ') + ' ' + hint;
  text = text.replace(QUALIFIER_RE, ' ').replace(WITHOUT_RE, ' ');     // «без сахара» - не продукт
  SMALL_RE.lastIndex = 0;
  const small = SMALL_RE.test(text) && !QTY_RE.test(text);
  if (small) text = text.replace(SMALL_RE, ' ');
  return [text.replace(/\s+/g, ' ').trim(), small];
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

const ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ых', 'их', 'ые', 'ие', 'ым', 'им',
  'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь'].sort((a, b) => b.length - a.length);
export function stem(name) {
  return norm(name).split(' ').filter(Boolean).map(w => {
    if (w.length > 3) for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
    return w;
  }).join(' ');
}
const baseName = name => stem(norm(name).replace(new RegExp(STATE_WORDS.source, 'giu'), ' '));
const STOP = new Set(['с', 'со', 'и', 'в', 'во', 'на', 'из', 'по', 'под', 'без', 'для', 'к', 'это', 'вид', 'виде', 'шт', 'г', 'гр', 'мл']);
const bagOf = name => new Set(stem(name).split(' ').filter(w => w && !STOP.has(w) && !/^\d+$/.test(w)));
const subset = (a, b) => [...a].every(x => b.has(x));

// ── индекс справочника (перестраивается, когда меняется кэш foods.js) ──
let idx = null, idxKey = '';
function index() {
  const cache = store.getMeta('foods', null), pending = store.getMeta('foods_pending', []);
  const key = `${cache?.ts || 0}:${cache?.items?.length || 0}:${pending.length}`;
  if (idx && key === idxKey) return idx;
  const list = [...(cache?.items || []), ...pending];
  const keys = new Map(), stems = new Map(), bases = new Map(), byId = new Map(), bags = [];
  for (const f of list) {
    byId.set(f.id, f);
    for (const k of [f.name, ...(f.aliases || [])]) {
      const nk = norm(k);
      if (!keys.has(nk)) keys.set(nk, f);
      const sk = stem(k);
      if (!stems.has(sk)) stems.set(sk, f);
      if (f.source !== 'off') { const b = bagOf(k); if (b.size) bags.push([b, f]); }   // товары из магазина - только точно
    }
    const b = baseName(f.name);
    if (!bases.has(b)) bases.set(b, []);
    bases.get(b).push(f);
  }
  idx = { keys, stems, bases, byId, bags, size: list.length };
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

// слова в любом порядке и падеже, лишние можно (как Index._bag_match на сервере): покрыто не меньше половины слов
// запроса и нет равного соперника; иначе - одно лишнее слово в названии («салат из свежих овощей» → «… с маслом»)
function bagMatch(name) {
  const I = index(), q = bagOf(name);
  if (!q.size) return null;
  const cover = new Map();
  for (const [b, f] of I.bags) if (subset(b, q)) { const c = cover.get(f.id) || { f, w: new Set() }; b.forEach(x => c.w.add(x)); cover.set(f.id, c); }
  if (cover.size) {
    const ranked = [...cover.values()].sort((a, b) => b.w.size - a.w.size || a.f.name.length - b.f.name.length);
    const [best, second] = ranked, n = best.w.size;
    const rival = second && second.w.size === n && baseName(second.f.name) !== baseName(best.f.name);
    if (n * 2 >= q.size && !rival) return best.f;
  }
  if (q.size >= 2) {
    const wider = new Map();
    for (const [b, f] of I.bags) if (b.size - q.size === 1 && subset(q, b)) { const k = baseName(f.name); if (!wider.has(k)) wider.set(k, f); }
    if (wider.size === 1) return [...wider.values()][0];
  }
  return null;
}

// совпало название или синоним целиком - тогда «с …» часть блюда («кофе с молоком»)
function isExact(name) { const I = index(), n = norm(name); return I.keys.has(n) || I.stems.has(stem(n)); }
function coveredBy(name, f) {
  const q = bagOf(name), out = new Set();
  for (const [b, g] of index().bags) if (g.id === f.id && subset(b, q)) b.forEach(x => out.add(x));
  return out;
}
// хвост «с …», который найденный продукт не покрывает (как food.with_extra)
export function withExtra(name, f) {
  const m = WITH_RE.exec(norm(name));
  if (!m || isExact(name)) return null;
  const tail = m[1].trim(), tb = bagOf(tail);
  return tb.size && !subset(tb, coveredBy(name, f)) ? tail : null;
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
  if (!f && !onlyAlias) f = bagMatch(n) || close(n, I.keys);
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
// вес, к которому относятся явные КБЖУ: указанный рядом (граммы/мл, штуки по порции продукта), иначе — число
// без единицы, похожее на граммы, или порция продукта по умолчанию, иначе 100 г (как food._macro_grams)
function macroGrams(n, unit, food) {
  if (unit === 'g' || unit === 'ml') return n;
  if (unit === 'kg' || unit === 'l') return n * 1000;
  if (unit && food) { const g = gramsFor(food, n, unit); if (g) return g; }
  if (n != null && unit == null && n > 20) return n;
  if (food) { const g = gramsFor(food, null, null); if (g) return g; }
  return 100;
}
// позиция по явным КБЖУ, не по справочнику: числа - значения на 100 г продукта, итог считаем на реально
// указанный вес. Продукта ещё нет в справочнике - запоминаем его там как есть (per100) в фоне (не мешает
// записи, если не получится сразу — ничего страшного).
function macroItem(chunk, name, grams, macro) {
  const t = name.replace(/\s+/g, ' ').trim();
  const title = t ? t[0].toUpperCase() + t.slice(1) : 'Без названия';
  // «уже есть в справочнике» — как на сервере (idx.match: с учётом синонимов), не только точное имя:
  // «курица» не задваивает «Курицу варёную», у которой это уже алиас
  if (!match(title, { alias: false })) {
    foods.save({ name: title, kcal: macro.kcal, p: macro.p, f: macro.f, c: macro.c, source: 'manual' }, { force: true }).catch(() => {});
  }
  const k = grams / 100;
  return { text: chunk, name: title, grams: Math.round(grams), kcal: Math.round(macro.kcal * k), p: r1(macro.p * k), f: r1(macro.f * k), c: r1(macro.c * k), source: 'manual' };
}

function parsePiece(chunk, macro) {
  const I = index();
  const [clean, small] = prepare(chunk);
  const [name, n, unit] = parseChunk(clean);
  if (macro) return [macroItem(chunk, name, macroGrams(n, unit, match(name, { alias: false })), macro)];
  const byFood = (f, source) => {
    const g = f ? (small ? f.portions?.['горсть'] || SMALL_G : gramsFor(f, n, unit)) : null;
    if (!g) return null;
    const it = itemFrom(f, g, chunk, source);
    const pu = unit && !(unit in MASS) ? unit : n != null && unit == null && n <= 20 ? 'шт' : null;
    if (pu) Object.assign(it, { pu, pn: n || 1 });
    return [it];
  };
  // 1) справочник (как quick_parse на сервере); ничего не теряем: «ножки … с оливками» - оливки отдельной строкой
  const f0 = match(name, { alias: false });
  const hit = byFood(f0, 'db');
  if (hit) {
    const extra = withExtra(name, f0);
    if (extra) {
      const f2 = match(extra, { alias: false });
      if (!f2) return { items: hit, rest: extra };
      hit.push(itemFrom(f2, f2.portions?.['горсть'] || SMALL_G, extra, 'db'));
    }
    return hit;
  }
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
  // явные КБЖУ относятся к целому куску «между ;/переносами строк» - составное блюдо с перечислением через
  // запятую в названии («рис с креветками, яйцом и луком») не разваливается; запятая делит на блюда, только
  // когда КБЖУ рядом нет (splitWeak) - см. food.quick_parse
  for (const [seg, macro] of macroAnnotate(splitStrong(text))) {
    if (macro) {
      const got = ready() ? parsePiece(seg, macro) : null;
      if (got) items.push(...got); else rest.push(seg);
      continue;
    }
    for (const chunk of splitWeak(seg)) {
      const got = ready() ? parsePiece(chunk) : null;
      if (got?.rest) { items.push(...got.items); rest.push(got.rest); } else if (got) items.push(...got); else rest.push(chunk);
    }
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
