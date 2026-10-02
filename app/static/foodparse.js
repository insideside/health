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
  return String(text || '').replace(QTY_DOT_RE, '$1, ').split(/[;\n]|\+(?![^()]*\))/).map(p => (p || '').trim()).filter(Boolean);
}
export function split(text) {
  return splitStrong(text).flatMap(splitWeak);
}
// один кусок «между ;/переносами строк» → отдельные продукты: по запятой и «и» перед числом
export function splitWeak(text) {
  // запятая внутри скобок - не граница: «шарлотка (яблоки, яйца, мука) 180 г» - состав одного блюда
  const parts = String(text || '').split(/(?<!\d),(?![^()]*\))|,(?!\d)(?![^()]*\))|\s+и\s+(?=\d)(?![^()]*\))/).map(p => (p || '').trim()).filter(Boolean);
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
// кусок текста (между ;/переносами строк) с явными КБЖУ → [[название блюда, КБЖУ | null], …] - как
// food.split_macro_segment. К блюду с КБЖУ относится кусок списка с числами, соседние куски перед ним БЕЗ своего
// количества (части составного блюда: «рис с креветками, яйцом и луком фри кбжу …») и куски после него, где только
// количество («…кбжу 250/30/5/10, 200г»). Куски со своим количеством («слива 72 гр.») - отдельные продукты, с КБЖУ
// null, дальше - по справочнику. Нет чисел вовсе - null.
const WEAK_COMMA_RE = /(?<!\d),(?![^()]*\))|,(?!\d)(?![^()]*\))/u;   // и не внутри скобок (состав блюда)
const BARE_QTY_RE = /^[\s\-–(]*\d+(?:[.,]\d+)?\s*(?:г|гр|грамм[\p{L}]*|кг|мл|л|шт|штук[\p{L}]*)?\.?[\s)]*$/iu;
const PH_RE = /\u0000(\d+)\u0000/gu;
const hasQty = p => QTY_RE.test(p) || BARE_UNIT_RE.test(p);
function splitMacroSegment(seg) {
  const whole = MACRO_WHOLE_RE.exec(seg);
  if (whole) return [['', macroFrom(nums(whole))]];
  const ms = [...seg.matchAll(new RegExp(MACRO_SLASH_RE.source, 'gu'))];
  if (!ms.length) return null;
  const macros = ms.map(m => macroFrom(nums(m)));
  // числа КБЖУ сами бывают через «, » - прячем их, прежде чем делить список по запятым
  let ph = '', last = 0;
  ms.forEach((m, i) => { ph += seg.slice(last, m.index) + `\u0000${i}\u0000`; last = m.index + m[0].length; });
  ph += seg.slice(last);
  const pieces = ph.split(WEAK_COMMA_RE);
  const clean = t => t.replace(MACRO_LABEL_RE, ' ').replace(/\s+/g, ' ').trim().replace(/^[\s,]+|[\s,]+$/g, '');
  const marksOf = p => [...p.matchAll(new RegExp(PH_RE.source, 'gu'))];
  const out = [];
  let pending = [], k = 0;
  const flush = () => { const rest = pending.filter(x => x.trim()).join(', ').trim(); if (rest) out.push([rest, null]); pending = []; };
  while (k < pieces.length) {
    const piece = pieces[k], marks = marksOf(piece);
    if (!marks.length) { pending.push(piece); k++; continue; }
    let take = [];
    while (pending.length && pending[pending.length - 1].trim() && !hasQty(pending[pending.length - 1])) take.unshift(pending.pop());
    // в куске только «кбжу …» без названия: блюдо - предыдущий кусок («курица 200г, кбжу 250/30/5/10»)
    if (!clean(piece.replace(new RegExp(PH_RE.source, 'gu'), ' ')) && !take.length && pending.length) take = [pending.pop()];
    flush();
    const tail = [];
    let j = k + 1;
    while (j < pieces.length && !marksOf(pieces[j]).length && BARE_QTY_RE.test(pieces[j])) tail.push(pieces[j++]);
    const cuts = [0, ...marks.map(m => m.index + m[0].length)];
    marks.forEach((m, n) => {
      const end = m.index + m[0].length;
      const head = piece.slice(cuts[n], m.index);
      let parts;
      if (n + 1 < marks.length) {
        // между двумя КБЖУ без запятой: вес сразу после чисел - этому блюду, остальное - следующему
        const after = piece.slice(end, marks[n + 1].index);
        const q = /^[\s\-–)]*\d+(?:[.,]\d+)?\s*(?:г|гр|грамм[\p{L}]*|кг|мл|л|шт)?\.?/iu.exec(after);
        parts = [...(n === 0 ? take : []), head + ' ' + (q ? q[0] : '')];
        if (q) cuts[n + 1] = end + q[0].length;
      } else {
        parts = [...(n === 0 ? take : []), head + ' ' + piece.slice(end), ...tail];
      }
      out.push([clean(parts.filter(x => x.trim()).join(', ')), macros[Number(m[1])]]);
    });
    k = j;
  }
  flush();
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
// штуки: категория яйца, личный вес, справочник - одно правило с поиском (foods.pieceOf)
export const { EGG_G, eggCategory, pieces } = foods;
const EGG_RE = /яйц|яиц|яичн/i;
// вес штуки для этой записи → копия продукта с piece_g (как food.with_piece на сервере)
export function withPiece(food, chunk) {
  if (!food) return food;
  const g = foods.pieceOf(food, chunk);
  return g && g !== Number(food.portions?.['шт']) ? { ...food, piece_g: g } : food;
}

// в скобках перечислен состав блюда («шарлотка (яблоки, яйца, мука, сахар) 180 г») - разбирает ИИ (= food.composite)
export function composite(chunk) {
  for (const m of String(chunk || '').matchAll(/\(([^)]*)\)/g)) {
    if (STATE_HINT.some(([re]) => re.test(m[1]))) continue;
    if (m[1].split(/,|\s+и\s+|\s*\+\s*/).filter(w => /\p{L}{2,}/u.test(w)).length >= 2) return true;
  }
  return false;
}

export function prepare(chunk) {
  let hint = null;
  for (const m of String(chunk).matchAll(/\(([^)]*)\)/g)) {
    for (const [re, w] of STATE_HINT) if (re.test(m[1])) { hint = w; break; }
  }
  let text = String(chunk).replace(/\([^)]*\)/g, ' ');
  if (hint) text = text.replace(new RegExp(STATE_WORDS.source, 'giu'), ' ') + ' ' + hint;
  text = text.replace(QUALIFIER_RE, ' ').replace(WITHOUT_RE, ' ');     // «без сахара» - не продукт
  if (EGG_RE.test(text)) text = text.replace(new RegExp(foods.EGG_CAT_RE.source, 'giu'), ' ');   // «яйцо С0» - категория в вес штуки
  text = text.replace(/\s[-–]\s/g, ' ');     // «яйцо С0 - 1 шт»: одиночное тире между словами - не часть названия
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

// основы слов-брендов из товаров (как food.brand_words): слово стоит в бренде хотя бы в 40 % случаев, где
// встречается («простоквашин», «может»), и его нет в названиях базовых продуктов («домашн»)
function brandWords(list) {
  const common = new Set(), inName = new Map(), inBrand = new Map(), inc = (m, w) => m.set(w, (m.get(w) || 0) + 1);
  for (const x of list) if (x.source === 'seed') bagOf(x.name).forEach(w => common.add(w));
  for (const x of list) {
    if (!x.brand) continue;
    const bw = bagOf(x.brand);
    bw.forEach(w => inc(inBrand, w));
    new Set([...bagOf(x.name), ...bw]).forEach(w => inc(inName, w));
  }
  return new Set([...inBrand].filter(([w, n]) => n >= 2 && n >= 0.4 * inName.get(w) && w.length > 3 && !common.has(w) && !STOP.has(w)).map(([w]) => w));
}
// товар с брендом из текста («сосиски папа может») по справочнику товаров (как Index.branded): все слова запроса
// есть в «название + бренд», процент жирности тот же; название целиком - этот товар, иначе все подходящие; цифры
// почти одинаковые - самый популярный, заметно разные - варианты на выбор человеку (окно «Уточнение продуктов»)
const PCT_RE = /(\d+(?:[.,]\d+)?)\s*%/g;
const pcts = t => new Set([...String(t).matchAll(PCT_RE)].map(m => m[1].replace(',', '.')));
export const near = (a, b) => Math.abs(a.kcal - b.kcal) <= Math.max(15, 0.12 * Math.max(a.kcal, b.kcal))
  && ['p', 'f', 'c'].every(k => Math.abs(a[k] - b[k]) <= Math.max(3, 0.15 * Math.max(a[k], b[k])));
function branded(name) {
  const I = index(), q = bagOf(name);
  if (!q.size || ![...q].some(w => /[a-z]{3}/.test(w) || I.brands.has(w))) return [null, []];
  I.storeBags ||= I.list.filter(f => f.brand).map(f => [bagOf(`${f.name} ${f.brand}`), f]);
  const want = pcts(name), exact = [], fits = [];
  for (const [b, f] of I.storeBags) {
    if (!subset(q, b) || (want.size && !subset(want, pcts(f.name)))) continue;
    (b.size === q.size ? exact : fits).push(f);
  }
  const all = exact.length ? exact : fits;
  if (!all.length) return [null, []];
  const groups = [];
  for (const f of all) { const g = groups.find(g => near(g[0], f)); if (g) g.push(f); else groups.push([f]); }
  return groups.length === 1 ? [all[0], []] : [null, groups.slice(0, 4).map(g => g[0])];
}
export const choiceOptions = opts => opts.map(f => ({ title: f.name, titles: [f.name], brand: f.brand || '', food_id: f.id,
  kcal: f.kcal, p: f.p, f: f.f, c: f.c, sources: [{ site: 'справочник товаров', title: f.name }] }));
function brandedItem(chunk) {
  const [clean] = prepare(chunk);
  const [name, n, unit] = parseChunk(clean);
  const [hit, opts] = branded(name);
  const f = withPiece(hit || opts[0], chunk);
  const g = f ? gramsFor(f, n, unit) : null;
  if (!g) return null;
  const it = itemFrom(f, g, chunk, 'db');
  if (!hit) it.choice = { query: name, ai: null, options: choiceOptions(opts) };
  return [it];
}

// процент жирности в запросе другой, чем у продукта («молоко 2,5%» - не «Молоко 3,2%»; как food.pct_clash)
function pctClash(n, f) {
  const want = pcts(n);
  if (!want.size) return false;
  const have = pcts([f.name, ...(f.aliases || [])].join(' '));
  return have.size > 0 && ![...want].every(x => have.has(x));
}

// в запросе бренд, которого у продукта нет: «йогурт активиа» - не «Йогурт натуральный» (как Index.misses_brand)
function missesBrand(n, f) {
  const have = bagOf([f.name, ...(f.aliases || []), f.brand || ''].join(' '));
  return [...bagOf(n)].some(w => !have.has(w) && (/[a-z]{3}/.test(w) || index().brands.has(w)));
}

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
  idx = { keys, stems, bases, byId, bags, size: list.length, brands: brandWords(list), list, storeBags: null };
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
    // товары из магазина - только точно (как food.Index.fuzzy на сервере): бренды и проценты не угадываем
    if (f.source === 'off' || Math.abs(k.length - name.length) > 3 || k[0] !== name[0]) continue;
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
  if (f && (missesBrand(n, f) || pctClash(n, f))) return null;
  if (f && !raw && !STATE_WORDS.test(n)) f = preferUsed(f);
  return f;
}

// граммы по количеству и единице; порции — справочник, а уверенная поправка людей (память ≥ 0,7) важнее
export function gramsFor(food, n, unit) {
  const portions = food.portions || {};
  if (unit === 'g' || unit === 'ml') return n;
  if (unit === 'kg' || unit === 'l') return n * 1000;
  // категория яйца или личный вес штуки (withPiece) важнее и справочника, и памяти тренера
  if (food.piece_g && (unit === 'шт' || (unit == null && (n == null ? !('порция' in portions) : n <= 20)))) return (n ?? 1) * food.piece_g;
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
  if (macro) return [macroItem(chunk, name, macroGrams(n, unit, withPiece(match(name, { alias: false }), chunk)), macro)];
  const byFood = (f0, source) => {
    const f = withPiece(f0, chunk);
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
      if (composite(chunk)) { rest.push(chunk); continue; }
      const got = ready() ? parsePiece(chunk) || brandedItem(chunk) : null;
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

// ── этикетка: текст таблицы «Пищевая ценность» (iPhone «Сканировать текст», вставка) → КБЖУ ──
// Понимает «Белки 12,5 г», «бел. 12», «Б 12», «Protein 12 g», калории «250 ккал» / «1046 кДж» (переводим),
// колонку «на 100 г» и «на порцию 30 г»: если на этикетке есть 100 г - берём первую колонку (она обычно на 100 г).
const LBL_NUM = '(\\d+(?:[.,]\\d+)?)';
const LBL = {
  p: new RegExp(`(?:белк\\p{L}*|бел\\.|protein\\p{L}*|(?<!\\p{L})б(?!\\p{L}))[^\\d\\n]{0,24}?${LBL_NUM}`, 'iu'),
  f: new RegExp(`(?<!насыщ\\p{L}*\\s{0,3})(?:жир\\p{L}*|жир\\.|fat\\p{L}*|(?<!\\p{L})ж(?!\\p{L}))[^\\d\\n]{0,24}?${LBL_NUM}`, 'iu'),
  c: new RegExp(`(?:углевод\\p{L}*|угл\\.|carbohydrate\\p{L}*|carbs?|(?<!\\p{L})у(?!\\p{L}))[^\\d\\n]{0,24}?${LBL_NUM}`, 'iu'),
};
export function parseLabel(text) {
  const t = String(text || '').replace(/ /g, ' ');
  if (t.trim().length < 6) return null;
  const n = m => (m ? Number(m[1].replace(',', '.')) : null);
  const out = { p: n(LBL.p.exec(t)), f: n(LBL.f.exec(t)), c: n(LBL.c.exec(t)) };
  const kcal = /(\d+(?:[.,]\d+)?)\s*(?:к?кал|kcal)(?!\p{L})/iu.exec(t), kj = /(\d+(?:[.,]\d+)?)\s*(?:кдж|kj)(?!\p{L})/iu.exec(t);
  out.kcal = kcal ? n(kcal) : kj ? Math.round(n(kj) / 4.184) : null;
  const found = ['kcal', 'p', 'f', 'c'].filter(k => out[k] != null).length;
  if (out.kcal == null && out.p != null && out.f != null && out.c != null) out.kcal = Math.round(4 * out.p + 4 * out.c + 9 * out.f);
  const per100 = /100\s*(?:г|гр|g|мл|ml)(?!\p{L})/iu.test(t);
  const portion = /порци\p{L}*\D{0,12}(\d+(?:[.,]\d+)?)\s*(?:г|гр|g|мл)/iu.exec(t) || /(\d+(?:[.,]\d+)?)\s*(?:г|гр|g)\s*\)?\s*(?:порци|serving)/iu.exec(t);
  return found >= 2 ? { ...out, found, per100: per100 || !portion, portion: per100 ? null : n(portion) } : null;
}
