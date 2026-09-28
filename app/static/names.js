// Склонение русских личных имён и подстановка в шаблоны реплик тренера.
//
// Работает без сети и без словаря на сервере: правила по окончаниям (-а/-я/-ия/-ья/-ь/согласная/-й)
// плюс короткий список исключений (беглые гласные: Павел → Павла, Лев → Льва; Пётр → Петра).
// Модуль не зависит от store.js — его можно проверять в node без браузера.
//
// decl(name, sex) → { nom, gen, dat, acc, ins, prep, voc, sex }
//   voc — разговорное обращение («Маш», «Вань»), только для уменьшительных; иначе = nom.
// fill(template, ctx) — шаблоны: {name}, {name_gen|dat|acc|ins|prep|voc}, {,name} (→ «, Маша» или пусто),
//   {partner}, {partner_dat}…, {м|ж} (окончания по полу пользователя), {pa:м|ж} (по полу партнёра), {key} — ctx[key].

const VOWELS = 'аеёиоуыэюя';
const HUSH = 'жшчщц';            // после них безударное -ей/-ем, а не -ой/-ом
const GKH = 'гкхжшчщ';           // после них -и, а не -ы

// Мужские имена на -а/-я (иначе такие имена считаем женскими)
const MALE_A = new Set(('никита илья кузьма фома лука савва саша женя валя дима ваня лёша леша серёжа сережа коля миша паша гоша ' +
  'слава витя петя федя вова костя толя юра даня лёва лева стёпа степа боря гриша тёма тема рома гена жора сеня лёня леня ' +
  'вася алёша алеша митя шура егорка сёма сема веня владя ярик дёма дема тоша вадя игорёк мотя кеша яша стасик ' +
  'данила гаврила ванюша мишаня димон').split(' '));
// Имена, одинаково мужские и женские: пол только из профиля
const BOTH = new Set(['саша', 'женя', 'валя', 'шура', 'слава']);
// Женские имена на -ь и на согласную
const FEM_SOFT = new Set(['любовь', 'нинель', 'адель', 'ассоль', 'рахиль', 'эсфирь', 'юдифь', 'руфь', 'изабель', 'габриэль', 'аннабель', 'мишель']);
const FEM_HARD = new Set(['ирен', 'элен', 'кармен', 'эстер', 'рут', 'мариам', 'марьям', 'гульнар', 'айгуль', 'гузель', 'асель', 'жанель']);

// Беглые гласные и прочие особые основы (основа для косвенных падежей)
const STEM = { 'павел': 'павл', 'лев': 'льв', 'пётр': 'петр', 'петр': 'петр', 'арсений': null };
// Готовые формы, которые правилами не получить
const FORMS = {
  'илья': ['Илья', 'Ильи', 'Илье', 'Илью', 'Ильёй', 'Илье'],
  'ия': ['Ия', 'Ии', 'Ие', 'Ию', 'Ией', 'Ие'],
  'любовь': ['Любовь', 'Любови', 'Любови', 'Любовь', 'Любовью', 'Любови'],
};
// Обращения, которые не выводятся правилом (сочетание согласных перед окончанием и т. п.)
const VOC = { 'настя': 'Насть', 'наташа': 'Наташ', 'марина': 'Марин', 'серёжа': 'Серёж', 'сережа': 'Сереж', 'алёша': 'Алёш',
  'алеша': 'Алеш', 'танюша': 'Танюш', 'ксюша': 'Ксюш', 'катюша': 'Катюш', 'андрюша': 'Андрюш', 'светка': null };

// Полное имя → привычное уменьшительное (подсказка для профиля, сами реплики его не подставляют)
export const SHORT = {
  'иван': 'Ваня', 'мария': 'Маша', 'александр': 'Саша', 'александра': 'Саша', 'екатерина': 'Катя', 'анастасия': 'Настя',
  'дмитрий': 'Дима', 'сергей': 'Серёжа', 'андрей': 'Андрюша', 'алексей': 'Лёша', 'ольга': 'Оля', 'юлия': 'Юля', 'анна': 'Аня',
  'наталья': 'Наташа', 'наталия': 'Наташа', 'елена': 'Лена', 'михаил': 'Миша', 'николай': 'Коля', 'павел': 'Паша', 'пётр': 'Петя',
  'петр': 'Петя', 'татьяна': 'Таня', 'светлана': 'Света', 'ксения': 'Ксюша', 'евгений': 'Женя', 'евгения': 'Женя', 'владимир': 'Вова',
  'константин': 'Костя', 'виктор': 'Витя', 'виктория': 'Вика', 'григорий': 'Гриша', 'артём': 'Тёма', 'роман': 'Рома', 'дарья': 'Даша',
  'ирина': 'Ира', 'людмила': 'Люда', 'галина': 'Галя', 'надежда': 'Надя', 'вера': 'Вера', 'любовь': 'Люба', 'полина': 'Поля',
  'софья': 'Соня', 'софия': 'Соня', 'валентина': 'Валя', 'валентин': 'Валя', 'юрий': 'Юра', 'фёдор': 'Федя', 'степан': 'Стёпа',
  'борис': 'Боря', 'анатолий': 'Толя', 'вячеслав': 'Слава', 'ярослав': 'Слава', 'станислав': 'Стас', 'лев': 'Лёва', 'илья': 'Илюша',
};

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const low = s => String(s || '').toLowerCase();
const isCyr = s => /^[а-яё]+$/i.test(s);
const syllables = s => [...low(s)].filter(c => VOWELS.includes(c)).length;

// Пол по имени: 'm' | 'f' | null (не угадать — «Саша», «Женя», латиница)
export function guessSex(name) {
  const w = low(String(name || '').trim().split(/[\s-]+/)[0]);
  if (!w || !isCyr(w)) return null;
  if (BOTH.has(w)) return null;
  if (FEM_SOFT.has(w) || FEM_HARD.has(w)) return 'f';
  if (MALE_A.has(w)) return 'm';
  const last = w[w.length - 1];
  if (last === 'а' || last === 'я') return 'f';
  if (last === 'ь') return 'm';
  if (!VOWELS.includes(last) || last === 'й') return 'm';
  return null;
}

// разговорное обращение: «Маша» → «Маш», «Ваня» → «Вань»; для полных имён — само имя
function vocOf(w, nom) {
  if (w in VOC) return VOC[w] ? VOC[w] : nom;
  const n = w.length, last = w[n - 1], prev = w[n - 2], pre2 = w[n - 3];
  if ((last !== 'а' && last !== 'я') || n < 3) return nom;
  if (VOWELS.includes(prev) || prev === 'ь' || prev === 'й') return nom;             // Мария, Наталья, Илья
  if (!pre2 || !VOWELS.includes(pre2)) return nom;                                     // Анна, Ольга, Настя (исключения — в VOC)
  if (syllables(w) !== 2) return nom;                                                  // Екатерина, Татьяна — не усекаем
  if ('кгх'.includes(prev)) return nom;                                                // «Вика» → «Вик» звучит грубо
  const stem = nom.slice(0, -1);
  return last === 'я' ? stem + 'ь' : stem;
}

function one(word, sex) {
  const nom = cap(word);
  const w = low(word);
  const same = { nom, gen: nom, dat: nom, acc: nom, ins: nom, prep: nom, voc: nom };
  if (!isCyr(w) || w.length < 2) return same;                                          // латиница, инициалы — не склоняем
  if (FORMS[w]) { const [a, b, c, d, e, f] = FORMS[w]; return { nom: a, gen: b, dat: c, acc: d, ins: e, prep: f, voc: a }; }
  const last = w[w.length - 1], prev = w[w.length - 2];
  const base = nom.slice(0, -1);
  if (last === 'а') {
    const g = GKH.includes(prev) ? 'и' : 'ы';
    const ins = HUSH.includes(prev) ? 'ей' : 'ой';
    return { nom, gen: base + g, dat: base + 'е', acc: base + 'у', ins: base + ins, prep: base + 'е', voc: vocOf(w, nom) };
  }
  if (last === 'я') {
    if (prev === 'и') return { nom, gen: base + 'и', dat: base + 'и', acc: base + 'ю', ins: base + 'ей', prep: base + 'и', voc: nom };
    return { nom, gen: base + 'и', dat: base + 'е', acc: base + 'ю', ins: base + 'ей', prep: base + 'е', voc: vocOf(w, nom) };
  }
  if (last === 'ь') {
    if (sex === 'f' || (sex !== 'm' && FEM_SOFT.has(w))) {
      return { nom, gen: base + 'и', dat: base + 'и', acc: nom, ins: nom + 'ю', prep: base + 'и', voc: nom };
    }
    return { nom, gen: base + 'я', dat: base + 'ю', acc: base + 'я', ins: base + 'ем', prep: base + 'е', voc: nom };
  }
  if (last === 'й') {
    const prep = prev === 'и' ? 'и' : 'е';                                             // о Юрии, но о Сергее
    return { nom, gen: base + 'я', dat: base + 'ю', acc: base + 'я', ins: base + 'ем', prep: base + prep, voc: nom };
  }
  if (VOWELS.includes(last)) return same;                                              // Нелли, Марко, Софи
  if (sex === 'f') return same;                                                        // Ирен, Кармен
  // мужское на согласную
  let stem = nom;
  if (w in STEM && STEM[w]) stem = cap(STEM[w]);
  const o = HUSH.includes(last) ? 'ем' : 'ом';
  return { nom, gen: stem + 'а', dat: stem + 'у', acc: stem + 'а', ins: stem + o, prep: stem + 'е', voc: nom };
}

const CASES = ['nom', 'gen', 'dat', 'acc', 'ins', 'prep', 'voc'];

// Склонение имени. sex — 'm'|'f' из профиля; без него — угадываем по имени.
// Двойные имена через дефис склоняются по частям; фамилии и отчества не поддерживаем — берём первое слово.
export function decl(name, sex) {
  const raw = String(name || '').trim().split(/\s+/)[0] || '';
  const s = sex === 'm' || sex === 'f' ? sex : guessSex(raw);
  if (!raw) return { nom: '', gen: '', dat: '', acc: '', ins: '', prep: '', voc: '', sex: s };
  const parts = raw.split('-').map(p => one(p, s));
  const out = { sex: s };
  for (const k of CASES) out[k] = parts.map(p => p[k]).join('-');
  if (parts.length > 1) out.voc = out.nom;
  return out;
}

// Полное имя → уменьшительное (или null)
export function short(name) { return SHORT[low(String(name || '').trim())] || null; }

// Подстановка в шаблон. ctx: { name, sex, partner, partner_sex, ...vars }
export function fill(template, ctx = {}) {
  const me = ctx.name ? decl(ctx.name, ctx.sex) : null;
  const pa = ctx.partner ? decl(ctx.partner, ctx.partner_sex) : null;
  const f = (ctx.sex || me?.sex) === 'f';
  const pf = (ctx.partner_sex || pa?.sex) === 'f';
  let s = String(template ?? '');
  // {,name} / {,name_voc} — обращение с запятой, если имя известно
  s = s.replace(/\{,(name|partner)(?:_(\w+))?\}/g, (_, who, c) => {
    const d = who === 'name' ? me : pa;
    const v = d ? d[c || 'nom'] : '';
    return v ? ', ' + v : '';
  });
  s = s.replace(/\{(name|partner)(?:_(gen|dat|acc|ins|prep|voc|nom))?\}/g, (m, who, c) => {
    const d = who === 'name' ? me : pa;
    if (d) return d[c || 'nom'] || '';
    return who === 'partner' && typeof ctx.partner === 'string' ? ctx.partner : '';
  });
  s = s.replace(/\{pa:([^{}|]*)\|([^{}|]*)\}/g, (_, m, w) => (pf ? w : m));
  s = s.replace(/\{([^{}|:]*)\|([^{}|]*)\}/g, (_, m, w) => (f ? w : m));
  s = s.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] ?? ''));
  // если имени нет, не оставляем «, ,» и пробел перед знаком
  return s.replace(/\s+([,.!?])/g, '$1').replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').replace(/\s{2,}/g, ' ').trim();
}

// Обращение по имени внутри готовой фразы — для «естественной доли» реплик.
// mode: 'lead' — «Маша, вчера…», 'tail' — «Вчера было 100 %, Маша. …», 'shout' — «Иван! Вчера…» (сержант).
// Если вставить аккуратно нельзя (первое слово — имя собственное, сокращение «дн.» и т. п.), возвращает текст как есть.
export function address(text, form, mode = 'lead', proper = []) {
  if (!form || !text) return text;
  if (text.includes(form)) return text;
  const first = text.split(/[\s,.!?:;—]/)[0];
  const lowerable = /^[А-ЯЁA-Z][а-яёa-z]/.test(first) && !proper.includes(first);
  if (mode === 'tail') {
    const m = /^([^.!?]{8,80}?)([.!?])(\s|$)/.exec(text);
    if (m && !/(?:дн|мин|ч|г|кг|см|нед|ккал|мл|тыс)$/.test(m[1]) && !/[«"]\S*$/.test(m[1]) && !m[1].includes(':')) {
      return m[1] + ', ' + form + text.slice(m[1].length);
    }
    mode = 'lead';
  }
  if (mode === 'shout') return `${form}! ${text}`;
  if (!lowerable && /^[А-ЯЁA-Z]/.test(first)) return text;                             // «ИИ …», «Маша …» - не трогаем
  const body = lowerable ? text[0].toLowerCase() + text.slice(1) : text;
  return `${form}, ${body}`;
}
