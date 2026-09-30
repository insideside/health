import * as store from '../store.js';
import * as C from '../coach.js';
import { S, esc, num, dec, fmt, dayTitle, profile, goal, toast, field, fval, select, openModal, closeModal, jobFor, addJob, jobNote, dateNav, isBackdated, afterChange, nowHM, glyph, aiOff, AI_OFF_NOTE, aiOffHint } from '../ui.js';
import { H } from './today.js';
import * as foods from '../foods.js';
import * as FP from '../foodparse.js';
import * as BR from '../brain.js';
import * as MPL from '../mealplan.js';

// Питание: запись еды свободным текстом, время и окно питания, оценка дня, избранное, «как вчера», идеи рациона и рецепты.

const MEALS = [['breakfast', 'Завтрак'], ['lunch', 'Обед'], ['dinner', 'Ужин'], ['snack', 'Перекус']];
const MEAL_NAME = Object.fromEntries(MEALS);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const hm = t => /^\d{1,2}:\d{2}$/.test(t || '') ? t.padStart(5, '0') : null;
const timeOf = e => hm(e.data.time) || (e.data.created ? new Date(e.data.created).toTimeString().slice(0, 5) : '');

// ── окно питания ──
function eatingWindow() {
  const w = profile().eating_window;
  return w?.enabled && hm(w.from) && hm(w.to) ? { from: hm(w.from), to: hm(w.to) } : null;
}
function inWindow(t, w) {
  if (!w || !hm(t)) return true;
  t = hm(t);
  return w.from <= w.to ? t >= w.from && t <= w.to : t >= w.from || t <= w.to;
}
function windowBar(date, w) {
  if (!w) return '';
  const toM = s => +s.slice(0, 2) * 60 + +s.slice(3);
  const a = toM(w.from), b = toM(w.to), len = ((b - a + 1440) % 1440) || 1440;
  const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
  const isToday = date === C.today();
  const open = inWindow(nowHM(), w);
  let state = '';
  if (isToday) {
    if (open) { const left = (b - nm + 1440) % 1440; state = `открыто · до закрытия ${Math.floor(left / 60)} ч ${left % 60} мин`; }
    else { const till = (a - nm + 1440) % 1440; state = `закрыто · откроется через ${Math.floor(till / 60)} ч ${till % 60} мин`; }
  }
  const pos = m => ((m / 1440) * 100).toFixed(2);
  const seg = a + len <= 1440 ? [[a, len]] : [[a, 1440 - a], [0, a + len - 1440]];
  return `<div class="a-win"><div class="a-win-top"><span class="smallcaps muted">Окно питания</span><span class="mono">${w.from}–${w.to}</span>${state ? `<span class="note">${state}</span>` : ''}</div>
    <div class="a-win-bar" role="img" aria-label="Окно питания ${w.from}–${w.to}">${seg.map(([s, l]) => `<i style="left:${pos(s)}%;width:${pos(l)}%"></i>`).join('')}
      ${isToday ? `<b style="left:${pos(nm)}%"></b>` : ''}</div></div>`;
}

// ── оценка дня питания ──
// «1 раз», «2 раза», «5 раз»
const times = n => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'раза' : 'раз');
const HABITS = {
  less_sugar: { re: /сахар|торт|конфет|шоколад|печень|пирожн|мороже|варень|сладк|газиров|кола|мёд|мед\b|вафл/i, bad: n => `Сладкое сегодня: ${n} ${times(n)}. Цель - меньше сахара.`, good: 'Сегодня без сладкого - так держать.' },
  less_flour: { re: /хлеб|булк|батон|пицц|макарон|паст[аы]|пирож|блин|лаваш|багет|круассан|пельмен|вареник/i, bad: n => `Мучное: ${n} ${times(n)}. Попробуй заменить крупой или овощами.`, good: 'Мучного сегодня не было.' },
  less_coffee: { re: /кофе|капучино|латте|эспрессо|американо|раф\b/i, bad: n => n > 2 ? `Кофе: ${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'чашки' : 'чашек'} - многовато, особенно после обеда.` : null, good: null, limit: 2 },
  less_alcohol: { re: /пиво|вино|водк|коньяк|виски|сидр|шампан|ликёр|ликер|джин|ром\b|коктейл/i, bad: () => 'Был алкоголь - он бьёт по сну и восстановлению.', good: 'Без алкоголя - сон скажет спасибо.' },
  less_fastfood: { re: /бургер|шаурм|фри|наггетс|хот-?дог|чипс|фастфуд|kfc|макдон/i, bad: () => 'Был фастфуд. Один раз - не беда, главное не привычка.', good: null },
  more_veg: { grams: true },
};
// овощи и фрукты за день в граммах (картофель и батат не в счёт - это крахмальный гарнир): по группе продукта из
// справочника, для своих и посчитанных ИИ - по названию. Ориентир ВОЗ - 400 г в день, из них овощей хотя бы половина.
const VEG_RE = /овощ|салат|огур|помидор|томат|капуст|брокколи|морков|перец|кабач|шпинат|свекл|баклаж|лук|чеснок|редис|сельдер|спарж|фасоль стручк|горош|тыкв|зелен|укроп|петруш|руккол|цукини|грибы?(?![а-яё])|шампиньон/i;
const FRUIT_RE = /фрукт|яблок|банан|груш|апельсин|мандарин|грейпфрут|киви|ягод|клубник|малин|черник|смородин|вишн|черешн|виноград|слив|персик|абрикос|нектарин|ананас|манго|хурм|гранат|арбуз|дын/i;
const VF_NORM = 400;
function vegFruit(entries) {
  let veg = 0, fruit = 0;
  for (const e of entries) for (const it of e.data.items || []) {
    const g = Number(it.grams) || 0, name = String(it.name || '');
    if (!g || /картоф|батат|пюре|чипс|фри(?![а-яё])|варень|джем|сок(?![а-яё])|сухофрукт|изюм|курага|финик/i.test(name)) continue;
    const grp = it.food_id != null ? foods.get(it.food_id)?.group : null;
    if (grp === 'овощи' || (!grp && VEG_RE.test(name))) veg += g;
    else if (grp === 'фрукты и ягоды' || (!grp && FRUIT_RE.test(name))) fruit += g;
  }
  return { veg: Math.round(veg), fruit: Math.round(fruit), total: Math.round(veg + fruit) };
}
function foodScore(date, entries, tg) {
  const tot = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
  entries.forEach(e => { const t = e.data.totals; if (t) for (const k in tot) tot[k] += Number(t[k]) || 0; });
  const lines = [];
  if (!entries.length) return { score: null, lines, tot };
  const parts = [];
  const unfinished = date === C.today() && new Date().getHours() < 20;
  if (tg?.kcal && tot.kcal && unfinished && tot.kcal <= tg.kcal * 1.1) {
    lines.push(['info', `Пока ${num(tot.kcal)} из ${num(tg.kcal)} ккал - день ещё идёт.`]);
  } else if (tg?.kcal && tot.kcal) {
    const dev = (tot.kcal - tg.kcal) / tg.kcal;
    parts.push([40, Math.max(0, 100 - Math.abs(dev) * 250)]);
    const isPast = date < C.today() || new Date().getHours() >= 20;
    if (dev > 0.1) lines.push(['warn', `Калорий на ${num(tot.kcal - tg.kcal)} больше нормы.`]);
    else if (dev < -0.25 && isPast) lines.push(['warn', `Калорий заметно меньше нормы (${num(tot.kcal)} из ${num(tg.kcal)}) - сильный недобор тормозит обмен.`]);
    else if (Math.abs(dev) <= 0.1) lines.push(['good', 'Калории в норме.']);
  }
  if (tg?.p && unfinished) {
    lines.push(['info', `Белок пока ${num(tot.p)} из ${num(tg.p)} г${tot.p < tg.p * 0.3 ? ' - не забудь про белок в обед и ужин' : ''}.`]);
  } else if (tg?.p) {
    const r = tot.p / tg.p;
    parts.push([30, Math.min(100, r * 100)]);
    lines.push(r >= 0.9 ? ['good', `Белок ${num(tot.p)} г из ${num(tg.p)} - отлично.`] : ['warn', `Белка ${num(tot.p)} г из ${num(tg.p)} - добавь творог, яйца, рыбу или курицу.`]);
  }
  if (tg?.fiber && tot.fiber && !unfinished) {
    const r = tot.fiber / tg.fiber;
    parts.push([15, Math.min(100, r * 100)]);
    lines.push(r >= 0.8 ? ['good', `Клетчатка ${num(tot.fiber)} г - хорошо.`] : ['warn', `Клетчатки ${num(tot.fiber)} г из ${num(tg.fiber)} - нужны овощи, крупы, бобовые.`]);
  }
  const habits = goal().habits || [];
  let hScore = 100, hN = 0;
  const text = entries.map(e => e.data.text || '').join('\n');
  for (const h of habits) {
    const def = HABITS[h];
    if (!def) continue;
    hN++;
    if (def.grams) {
      const vf = vegFruit(entries), split = `овощи ${num(vf.veg)} г, фрукты ${num(vf.fruit)} г`;
      const fewVeg = vf.veg < VF_NORM / 2 && vf.fruit > vf.veg;
      if (vf.total >= VF_NORM) lines.push(fewVeg ? ['warn', `Овощей и фруктов ${num(vf.total)} г (${split}) - норма набрана, но в основном фрукты: овощей нужно хотя бы 200 г.`]
        : ['good', `Овощи и фрукты: ${num(vf.total)} г (${split}) - норма ВОЗ ${VF_NORM} г есть.`]);
      else if (unfinished) lines.push(['info', vf.total ? `Овощей и фруктов пока ${num(vf.total)} г из ${VF_NORM} (${split}) - добавь салат или овощной гарнир, примерно ${num(VF_NORM - vf.total)} г.` : `Овощей и фруктов пока нет - цель ${VF_NORM} г в день: салат к обеду и овощи на гарнир.`]);
      else {
        hScore -= Math.round(20 * (1 - vf.total / VF_NORM));
        lines.push(['warn', vf.total ? `Овощей и фруктов ${num(vf.total)} г из ${VF_NORM} (${split}) - маловато: не хватило около ${num(VF_NORM - vf.total)} г.` : `Овощей и фруктов сегодня не было - нужно около ${VF_NORM} г в день.`]);
      }
      continue;
    }
    const n = entries.filter(e => def.re.test(e.data.text || '')).length;
    if (n > (def.limit || 0)) { hScore -= 20; const t = def.bad(n); if (t) lines.push(['warn', t]); }
    else if (def.good && text) lines.push(['good', def.good]);
  }
  if (habits.includes('less_late_eating')) {
    hN++;
    const late = entries.filter(e => timeOf(e) >= '21:00').length;
    if (late) { hScore -= 20; lines.push(['warn', `Поздняя еда: ${late} ${times(late)} после 21:00.`]); }
  }
  const win = eatingWindow();
  if (win) {
    const out = entries.filter(e => !inWindow(timeOf(e), win)).length;
    if (out) { hN++; hScore -= 15 * out; lines.push(['warn', `Вне окна питания: ${out} ${out === 1 ? 'запись' : 'записи'}.`]); }
  }
  if (hN) parts.push([15, Math.max(0, hScore)]);
  const w = parts.reduce((a, [x]) => a + x, 0);
  const score = w ? Math.round(parts.reduce((a, [x, v]) => a + x * v, 0) / w) : null;
  return { score, lines, tot };
}

// ── планы и рецепты ──
const quickPlans = new Map();   // date → ответ /api/mealplan/quick (в памяти)
function latestCoach(kind, ok = () => true) {
  return store.list('coach').filter(r => r.data.kind === kind && ok(r)).sort((a, b) => (b.data.created || b.updated_at) - (a.data.created || a.updated_at))[0] || null;
}
function planHtml(p) {
  if (!p) return '';
  if (typeof p === 'string') return `<p class="a-pre">${esc(p)}</p>`;
  const itemTxt = it => typeof it === 'string' ? esc(it) : `${esc(it.name || it.title || '')}${it.grams ? ` <span class="mono muted">${num(it.grams)} г</span>` : it.amount ? ` <span class="muted">${esc(it.amount)}</span>` : ''}${it.kcal ? ` <span class="mono muted">· ${num(it.kcal)} ккал</span>` : ''}`;
  const tot = t => t ? `<div class="a-plan-tot mono">${num(t.kcal)} ккал · Б ${num(t.p)} · Ж ${num(t.f)} · У ${num(t.c)}</div>` : '';
  const list = (title, arr, tag = 'ul') => arr?.length ? `<div class="smallcaps muted a-plan-h">${title}</div><${tag}>${arr.map(x => `<li>${itemTxt(x)}</li>`).join('')}</${tag}>` : '';
  const meals = p.meals || p.days?.[0]?.meals;
  return `${p.title ? `<h3 class="a-plan-title">${esc(p.title)}</h3>` : ''}
    ${p.summary || p.text ? `<p class="a-pre">${esc(p.summary || p.text)}</p>` : ''}
    ${meals?.length ? `<div class="a-plan-meals">${meals.map(m => `<div class="a-plan-meal"><div class="a-plan-mh"><span class="smallcaps">${esc(MEAL_NAME[m.meal] || m.meal || m.name || m.title || '')}</span>${m.kcal || m.totals?.kcal ? `<span class="mono muted">${num(m.kcal || m.totals.kcal)} ккал</span>` : ''}</div>
      ${m.title && (m.meal || m.name) ? `<div>${esc(m.title)}</div>` : ''}${m.items?.length ? `<ul>${m.items.map(it => `<li>${itemTxt(it)}</li>`).join('')}</ul>` : m.text ? `<p class="small">${esc(m.text)}</p>` : ''}</div>`).join('')}</div>` : ''}
    ${list('Ингредиенты', p.ingredients)}${list('Как готовить', p.steps, 'ol')}${list('Советы', p.tips)}
    ${tot(p.totals || p.per_serving)}`;
}

function planSection(date) {
  const quick = quickPlans.get(date);
  const planJob = jobFor('mealplan:' + date), recipeJob = jobFor('recipe');
  const aiPlan = latestCoach('mealplan', r => r.data.variant !== 'day'), recipe = latestCoach('recipe');   // рацион на день — в разделе «Рацион»
  const open = S.forms.fd?.plans;
  // «Идеи на день» и «План с ИИ» заменил раздел «Рацион на день» (mpSection) — здесь остались рецепты
  return `<div class="section"><div class="section-title"><span class="smallcaps">Рецепты</span><span class="note">под ваши нормы</span></div>
    <div class="a-row-btns">
      <button class="btn" data-act="fd-recipe" ${recipeJob || !store.state.online || aiOff() ? 'disabled' : ''}${aiOff() ? ` title="${AI_OFF_NOTE}"` : ''}>Подобрать рецепт</button>
      ${!store.state.online ? '<span class="note">рецепты пишет локальная ИИ на сервере - нужна связь с ним</span>' : ''}</div>
    ${S.forms.fd?.recipeAsk ? `<div class="inset a-recipe-ask">${field('Какой рецепт нужен', `<input class="control" data-form="fd" data-key="recipeText" value="${esc(fval('fd', 'recipeText', ''))}" placeholder="например: ужин из курицы и овощей за 20 минут">`)}
      <div class="a-row-btns"><button class="btn" data-act="fd-ai" data-kind="recipe" data-date="${date}">Попросить рецепт</button><button class="btn quiet" data-act="fd-recipe-cancel">Отмена</button></div></div>` : ''}
    ${jobNote(planJob, 'ИИ составляет план питания')}${jobNote(recipeJob, 'ИИ пишет рецепт')}
    ${quick && quick !== 'loading' ? `<div class="raised a-card a-plan">${quick.error ? `<p class="note">${esc(quick.error)}</p>` : `<div class="a-card-head"><span class="smallcaps">Идеи на день</span><span class="note">без ИИ, из справочника</span></div>${planHtml(quick.plan || quick)}`}</div>` : ''}
    ${aiPlan || recipe ? `<details class="a-plans" ${open || [aiPlan, recipe].some(r => r && Date.now() - (r.data.created || r.updated_at) < 3600e3) ? 'open' : ''}><summary>${[aiPlan && 'план от ИИ', recipe && 'последний рецепт'].filter(Boolean).join(' и ')}</summary>
      ${aiPlan ? `<div class="raised a-card a-plan"><div class="a-card-head"><span class="smallcaps">План от ИИ</span><span class="note">${esc(fmt(C.ymd(new Date(aiPlan.data.created || aiPlan.updated_at)), { day: 'numeric', month: 'short' }))}</span></div>${planHtml(aiPlan.data.plan || aiPlan.data)}</div>` : ''}
      ${recipe ? `<div class="raised a-card a-plan"><div class="a-card-head"><span class="smallcaps">Рецепт</span></div>${planHtml(recipe.data.recipe || recipe.data)}</div>` : ''}</details>` : ''}
  </div>`;
}

// ── Рацион на день (mealplan.js): слоты под распорядок и тренировку, «что есть дома», уточнение с ИИ ──
// Локальный план строится заново при каждой отрисовке (это миллисекунды) — он всегда учитывает свежий дневник.
const MP = { date: null, variant: 0, wt: '', view: 'local', q: '', pantryOpen: false, plan: null, ai: null };
const mpKey = date => 'mpday:' + date;
function mpPlan(date) {
  MP.plan = MPL.buildDayPlan(date, { variant: MP.variant, workoutTime: MP.wt || undefined });
  MP.ai = MPL.aiPlanFor(date);
  return MP.view === 'ai' && MP.ai ? MP.ai : MP.plan;
}
const mpMacro = t => `Б ${num(t.p)} · Ж ${num(t.f)} · У ${num(t.c)}`;
function mpItem(it, s, i, src, date) {
  const badges = [it.home ? '<span class="mp-b home">дома</span>' : '', it.usual ? '<span class="mp-b">вы едите</span>' : '',
    it.optional ? '<span class="mp-b opt">по желанию</span>' : ''].join('');
  const sub = [it.hint, it.optional && it.alt ? `можно заменить: ${it.alt}` : ''].filter(Boolean).join(' · ');
  const act = s.status ? '' : `<button type="button" class="btn quiet mp-ib" data-act="mp-add" data-date="${date}" data-src="${src}" data-slot="${esc(s.key)}" data-i="${i}" aria-label="В дневник: ${esc(it.name)}" title="В дневник">+</button>
      ${src === 'local' && it.food_id != null ? `<button type="button" class="btn quiet mp-ib" data-act="mp-ex" data-id="${esc(it.food_id)}" aria-label="Не предлагать: ${esc(it.name)}" title="Не предлагать">×</button>` : ''}`;
  return `<li class="mp-it"><span class="mp-nm">${esc(it.name)}</span><span class="mono mp-g">${num(it.grams)} г${it.pieces ? ` · ${esc(it.pieces)}` : ''}</span>${act}
    ${badges || sub ? `<div class="mp-sub">${badges}${sub ? `<span class="note">${esc(sub)}</span>` : ''}</div>` : ''}</li>`;
}
function mpSlot(s, src, date) {
  const done = s.status === 'logged', past = s.status === 'past';
  const items = s.items || [];
  return `<div class="raised mp-slot ${s.status ? 'mp-' + s.status : ''}" data-dom="food">
    <div class="mp-sh"><span class="mono mp-time">${esc(s.time)}</span><span class="mp-label">${esc(s.label)}</span><span class="mono muted mp-k">${past ? 'прошло' : `${num(s.totals?.kcal || 0)} ккал`}</span></div>
    ${past ? '' : `${s.title && src === 'ai' ? `<div class="mp-title">${esc(s.title)}</div>` : ''}<p class="note mp-why">${esc(s.reason || '')}</p>
    ${items.length ? `<ul class="mp-items">${items.map((it, i) => mpItem(it, s, i, src, date)).join('')}</ul>` : '<p class="note">На этот приём норма уже набрана - можно пропустить или взять овощи.</p>'}
    ${s.recipe?.steps?.length ? `<details class="mp-rec"><summary>Как приготовить${s.recipe.time_min ? ` · ${num(s.recipe.time_min)} мин` : ''}</summary><ol>${s.recipe.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol></details>` : ''}
    <div class="mp-sf"><span class="mono muted">${mpMacro(s.totals || {})}</span>${done ? `<span class="mp-done">${glyph('check')} в дневнике</span>` : items.length ? `<button type="button" class="btn quiet" data-act="mp-add" data-date="${date}" data-src="${src}" data-slot="${esc(s.key)}">В дневник</button>` : ''}</div>`}
  </div>`;
}
function mpSummary(p) {
  const T = p.target || {}, t = p.day_totals || p.totals || {}, h = p.health;
  const cell = (l, k, u = '') => `<div class="mp-sum-c"><span class="smallcaps muted">${l}</span><span class="mono">${num(t[k])}${T[k] ? `<small> / ${num(T[k])}${u}</small>` : ''}</span></div>`;
  return `<div class="raised a-card mp-sum">
    <div class="mp-sum-g">${cell('Ккал', 'kcal')}${cell('Белки', 'p', ' г')}${cell('Жиры', 'f', ' г')}${cell('Углев.', 'c', ' г')}${h ? `<div class="mp-sum-c"><span class="smallcaps muted">Клетч. ≈</span><span class="mono">${num(t.fiber)}<small> / ${num(h.fiber_target)} г</small></span></div>` : ''}</div>
    ${h ? `<div class="mp-health"><b class="mono g-${h.score >= 75 ? 'good' : h.score >= 50 ? 'ok' : 'bad'}-t">${h.score}</b><div><span class="smallcaps muted">здоровье плана</span><ul class="a-flines">${h.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
  </div>`;
}
function mpPantry(date) {
  const list = MPL.pantry(), ex = MPL.excluded();
  const q = MP.q.trim();
  const res = q ? foods.search(q, { limit: 8 }).filter(f => !list.some(x => x.id === f.id)) : [];
  return `<details class="mp-pantry" ${MP.pantryOpen ? 'open' : ''}><summary data-act="mp-pantry-toggle">Что есть дома${list.length ? ` · ${list.length}` : ''}</summary>
    <p class="note a-tight">Отметьте продукты, которые есть, - план возьмёт их в первую очередь.</p>
    ${list.length ? `<div class="chips mp-chips">${list.map(x => `<button type="button" class="chip on" data-act="mp-pantry-rm" data-id="${esc(x.id)}" aria-label="Убрать ${esc(x.name)}"><span class="ell">${esc(x.name)}</span> ×</button>`).join('')}</div>` : ''}
    <input class="control mp-q" id="mp-q" type="search" value="${esc(MP.q)}" placeholder="гречка, курица, яйца…" autocomplete="off" aria-label="Найти продукт">
    <div class="chips mp-chips" id="mp-res">${mpResults(res)}</div>
    ${list.length ? `<div class="a-row-btns"><button type="button" class="btn quiet" data-act="mp-pantry-clear">Очистить список</button></div>` : ''}
    ${ex.length ? `<p class="note a-tight">Не предлагаю: ${ex.map(x => `<button type="button" class="a-linkbtn" data-act="mp-ex" data-id="${esc(x.id)}" title="Вернуть">${esc(x.name)}</button>`).join(', ')} - нажмите, чтобы вернуть.</p>` : ''}
  </details>`;
}
function mpResults(res) {
  if (!MP.q.trim()) return '';
  if (!res.length) return `<span class="note">Ничего не нашлось${foods.count() ? '' : ' - справочник ещё не загружен'}.</span>`;
  return res.map(f => `<button type="button" class="chip" data-act="mp-pantry-add" data-id="${esc(f.id)}"><span class="ell">${esc(f.name)}</span> +</button>`).join('');
}
function mpSection(date) {
  const today = C.today();
  if (date < today || date > C.addDays(today, 6)) return '';
  const tomorrow = C.addDays(today, 1);
  const lbl = d => d === today ? 'Рацион на сегодня' : d === tomorrow ? 'Рацион на завтра' : `Рацион на ${fmt(d, { day: 'numeric', month: 'long' })}`;
  if (MP.date !== date && !(date === today && MP.date === tomorrow)) {
    return `<div class="section mp"><div class="section-title"><span class="smallcaps">Рацион на день</span><span class="note">под режим, тренировку и ваши продукты</span></div>
      <div class="a-row-btns"><button type="button" class="btn" data-act="mp-open" data-date="${date}">${lbl(date)}</button>
        ${date === today ? `<button type="button" class="btn" data-act="mp-open" data-date="${tomorrow}">На завтра</button>` : ''}</div></div>`;
  }
  const d = MP.date;
  const p = mpPlan(d);
  const job = jobFor(mpKey(d));
  const src = p.source === 'ai' ? 'ai' : 'local';
  const online = store.state.online;
  return `<div class="section mp" id="mp"><div class="section-title"><span class="smallcaps">${esc(lbl(d))}</span>
      <button type="button" class="btn quiet mp-close" data-act="mp-close">Свернуть</button></div>
    ${MP.ai ? `<div class="fp-tabs mp-tabs" role="tablist"><button type="button" role="tab" aria-selected="${src === 'local'}" class="${src === 'local' ? 'on' : ''}" data-act="mp-view" data-view="local">На устройстве</button><button type="button" role="tab" aria-selected="${src === 'ai'}" class="${src === 'ai' ? 'on' : ''}" data-act="mp-view" data-view="ai">С ИИ</button></div>` : ''}
    ${src === 'ai' && p.text ? `<p class="a-pre mp-ai-text">${esc(p.text)}</p>` : ''}
    ${(p.notes || []).length ? `<ul class="mp-notes">${p.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${MP.plan.workout ? `<label class="mp-wt"><span class="smallcaps muted">Тренировка в</span><input class="control mono a-time" type="time" value="${esc(MP.wt || MP.plan.workout.time)}" data-act="mp-wt" aria-label="Время тренировки"><span class="note">~${num(MP.plan.workout.minutes)} мин</span></label>` : ''}
    <div class="mp-slots">${p.slots.map(s => mpSlot(s, src, d)).join('')}</div>
    ${mpSummary(p)}
    <div class="a-row-btns">
      ${src === 'local' ? `<button type="button" class="btn" data-act="mp-variant">Другой вариант</button>` : ''}
      <button type="button" class="btn" data-act="mp-ai" data-date="${d}" ${job || !online || aiOff() ? 'disabled' : ''}${aiOff() ? ` title="${AI_OFF_NOTE}"` : ''}>${MP.ai ? 'Уточнить с ИИ ещё раз' : 'Уточнить с ИИ'}</button>
      ${d === today ? `<button type="button" class="btn quiet" data-act="mp-open" data-date="${tomorrow}">На завтра</button>` : `<button type="button" class="btn quiet" data-act="mp-open" data-date="${today}">На сегодня</button>`}</div>
    ${jobNote(job, 'ИИ уточняет рацион и пишет рецепты')}
    ${!online ? '<p class="note a-tight">Без связи план собирается на устройстве; уточнить с ИИ можно, когда появится связь.</p>' : ''}
    ${mpPantry(d)}
    <p class="note mp-honest">${src === 'ai' ? 'ИИ предложил блюда и рецепты; продукты и граммы проверены кодом по справочнику.' : esc(MPL.HONEST)}${p.thin && src === 'local' ? ' Истории пока мало - больше базовых продуктов.' : ''}</p>
  </div>`;
}
function mpFind(el) {
  const p = el.dataset.src === 'ai' ? MP.ai : MP.plan;
  return p?.slots.find(s => s.key === el.dataset.slot) || null;
}
const mpActions = {
  'mp-open': el => { MP.date = el.dataset.date; MP.variant = 0; MP.wt = ''; MP.view = MPL.aiPlanFor(MP.date) ? 'ai' : 'local'; S.render(); setTimeout(() => document.getElementById('mp')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30); },
  'mp-close': () => { MP.date = null; S.render(); },
  'mp-view': el => { MP.view = el.dataset.view; S.render(); },
  'mp-variant': () => { MP.variant++; MP.view = 'local'; S.render(); },
  'mp-pantry-toggle': el => { MP.pantryOpen = !el.closest('details').open; },
  'mp-pantry-add': async el => { const f = foods.get(idOf(el.dataset.id)); if (!f) return; await MPL.addPantry(f); MP.q = ''; MP.pantryOpen = true; S.render(); document.getElementById('mp-q')?.focus(); },
  'mp-pantry-rm': async el => { await MPL.removePantry(el.dataset.id); MP.pantryOpen = true; S.render(); },
  'mp-pantry-clear': async () => { await MPL.setPantry([]); S.render(); },
  'mp-ex': async el => {
    const f = foods.get(idOf(el.dataset.id)) || MPL.excluded().find(x => String(x.id) === el.dataset.id);
    if (!f) return;
    const was = MPL.excluded().some(x => x.id === f.id);
    await MPL.toggleExclude(f);
    toast(was ? `«${f.name}» снова может попасть в рацион` : `«${f.name}» больше не предлагаю`);
    S.render();
  },
  'mp-add': async el => {
    const s = mpFind(el);
    if (!s) return;
    const date = el.dataset.date;
    const pick = el.dataset.i !== undefined ? [s.items[Number(el.dataset.i)]] : s.items;
    const items = pick.filter(Boolean).map(it => {
      const f = it.food_id != null ? foods.get(it.food_id) : foods.findByName(it.name);
      return f ? foods.itemFor(f, it.grams) : { name: it.name, grams: it.grams, kcal: it.kcal, p: it.p, f: it.f, c: it.c, source: 'db' };
    });
    if (!items.length) return;
    const totals = sumItems(items);
    const whole = el.dataset.i === undefined;
    await addEntry(date, { meal: s.meal || 'snack', text: items.map(it => `${it.name} ${num(it.grams)} г`).join(', '), items, totals, status: 'calculated',
      time: s.time, source: 'mealplan', ...(whole ? { mp_slot: s.key } : {}) });
    toast(`${s.label}: в дневнике ${num(totals.kcal)} ккал`);
  },
  'mp-ai': async el => {
    const date = el.dataset.date;
    const plan = MPL.buildDayPlan(date, { variant: MP.variant, workoutTime: MP.wt || undefined });
    try {
      await store.sync();
      const res = await store.api('/api/ai/jobs', { kind: 'mealplan', input: MPL.aiInput(plan) });
      MP.view = 'ai';
      await addJob(res.job_id, 'mealplan', mpKey(date));
    } catch (e) { toast(aiErr(e), 6000); }
  },
};
// поиск в «Что есть дома» — без полной перерисовки, чтобы не терять фокус
document.addEventListener('input', e => {
  if (e.target.id !== 'mp-q') return;
  MP.q = e.target.value;
  const box = document.getElementById('mp-res');
  if (box) box.innerHTML = mpResults(MP.q.trim() ? foods.search(MP.q, { limit: 8 }).filter(f => !MPL.pantry().some(x => x.id === f.id)) : []);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.id !== 'mp-q') return;
  e.preventDefault();
  document.querySelector('#mp-res [data-act=mp-pantry-add]')?.click();
});


// ── справочник продуктов: выбор из списка, свои продукты, поиск БЖУ с ИИ ──
// Состояние окна живёт в памяти модуля: корзина не теряется, если окно случайно закрыли.
const P = { date: null, meal: 'snack', time: '', items: [], q: '', sel: null, grams: '', view: 'search', custom: {}, ai: {}, warn: null, into: null };
const stBadge = st => st && foods.STATE_SHORT[st] ? `<span class="fp-st" title="${esc(foods.STATE_HINT[st])}">${foods.STATE_SHORT[st]}</span>` : '';
const mac = m => `${num(m.kcal)} ккал · Б ${dec(m.p)} · Ж ${dec(m.f)} · У ${dec(m.c)}`;
const r1 = x => Math.round((Number(x) || 0) * 10) / 10;
const CONF = { high: ['высокая', 'good'], mid: ['средняя', 'ok'], low: ['низкая', 'bad'] };

const commitLabel = () => (P.into ? 'Добавить в запись' : 'Записать');
function sumItems(items) {
  const t = { kcal: 0, p: 0, f: 0, c: 0 };
  items.forEach(i => { for (const k in t) t[k] += Number(i[k]) || 0; });
  return { kcal: Math.round(t.kcal), p: r1(t.p), f: r1(t.f), c: r1(t.c) };
}

function resultRow(f) {
  const on = P.sel === f.id;
  return `<div class="fp-item ${on ? 'on' : ''}"><button type="button" class="fp-row" data-act="fp-sel" data-id="${esc(f.id)}" aria-expanded="${on}">
      <span class="fp-nm"><span class="fp-name">${esc(f.name)}</span>${stBadge(f.state)}${f.generic ? '<span class="fp-gen">≈ в среднем</span>' : ''}${f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase()) ? `<span class="fp-brand">${esc(f.brand)}</span>` : ''}${foods.isMine(f) ? '<span class="fp-mine">моё</span>' : foods.isStore(f) ? '<span class="fp-mine" title="Товар из магазина, данные Open Food Facts">магазин</span>' : f.source !== 'seed' && f.source ? '<span class="fp-mine">общее</span>' : ''}</span>
      <span class="fp-k mono">${num(f.kcal)}<small> ккал</small></span>
      ${f.note ? `<span class="fp-note">${esc(f.note)}</span>` : ''}</button>
    ${on ? selEditor(f) : ''}</div>`;
}

function selEditor(f) {
  const g = P.grams;
  const ps = foods.portions(f);
  return `<div class="fp-edit inset">
    ${ps.length ? `<div class="chips fp-portions">${ps.map(([k, v]) => `<button type="button" class="chip" data-act="fp-portion" data-g="${v}">${esc(k)} <span class="mono muted">${num(v)} г</span></button>`).join('')}</div>` : ''}
    <div class="fp-grams"><label class="fp-gl"><input class="control mono" id="fp-g" type="number" inputmode="decimal" min="0" step="any" value="${esc(g)}" placeholder="100" aria-label="Сколько граммов"><span>г</span></label>
      <span class="fp-live mono" id="fp-live">${mac(foods.macrosFor(f, g || 0))}</span></div>
    <div class="fp-per note">на 100 г: ${mac(foods.macrosFor(f, 100))}${f.state ? ` · ${esc(foods.STATE_HINT[f.state])}` : ''}</div>
    <div class="a-row-btns"><button type="button" class="btn" data-act="fp-add">В приём пищи</button>
      ${foods.isMine(f) ? `<button type="button" class="btn quiet" data-act="fp-edit-own" data-id="${esc(f.id)}">Изменить</button><button type="button" class="btn danger" data-act="fp-del-own" data-id="${esc(f.id)}">Удалить</button>` : ''}</div></div>`;
}

function searchResults() {
  const q = P.q.trim();
  if (!q) {
    const rec = foods.recent(12);
    if (!foods.count()) return `<p class="note">${store.state.online ? 'Загружаю справочник…' : 'Справочник ещё не загружен - нужна связь с сервером один раз.'}</p>`;
    return rec.length ? `<div class="smallcaps muted fp-h">Мои и недавние</div>${rec.map(r => resultRow(r.food)).join('')}`
      : '<p class="note">Начните вводить название: «гречка», «творог 5%», «банан».</p>';
  }
  const res = foods.search(q, { limit: 30 });
  if (!res.length) return `<p class="note">Ничего не нашлось по «${esc(q)}». Добавьте <button type="button" class="a-linkbtn" data-act="fp-view" data-view="custom">свой продукт</button>${store.state.online ? ` или <button type="button" class="a-linkbtn" data-act="fp-view" data-view="ai">найдите БЖУ с ИИ</button>` : ''}.</p>`;
  return res.map(resultRow).join('') + `<p class="note fp-more">Нет нужного? <button type="button" class="a-linkbtn" data-act="fp-view" data-view="custom">Свой продукт</button>${store.state.online ? ` · <button type="button" class="a-linkbtn" data-act="fp-view" data-view="ai">Найти БЖУ с ИИ</button>` : ''}</p>`;
}

function stateChips(key, cur) {
  return `<div class="chips fp-states">${foods.STATES.map(([k, l]) => `<button type="button" class="chip ${cur === k ? 'on' : ''}" data-act="fp-state" data-key="${key}" data-val="${k}" aria-pressed="${cur === k}">${esc(l)}</button>`).join('')}</div>`;
}

function customView() {
  const c = P.custom;
  const per = !!c.perPortion;
  const v = k => esc(c[k] ?? '');
  const lk = c.lookup;
  const mm = foods.energyMismatch(convertCustom(c) || {});
  return `${lk ? `<div class="raised fp-ai-res"><div class="a-card-head"><span class="smallcaps">Найдено ИИ</span><span class="fp-conf g-${CONF[lk.confidence]?.[1] || 'bad'}-t">уверенность: ${CONF[lk.confidence]?.[0] || '-'}</span></div>
      ${lk.warnings?.length ? `<ul class="fp-warn">${lk.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="note a-tight">Проверьте цифры с упаковкой и поправьте, если нужно.</p></div>` : ''}
    <div class="fp-form">
      ${field('Название', `<input class="control" data-fp="name" value="${v('name')}" placeholder="например: Творог Простоквашино 5%" maxlength="80">`)}
      <div class="field"><span class="smallcaps">Состояние</span>${stateChips('custom', c.state || '')}</div>
      <label class="chk"><input type="checkbox" data-fp="perPortion" ${per ? 'checked' : ''}>на упаковке указано на порцию</label>
      ${per ? field('Вес порции, г', `<input class="control mono" type="number" inputmode="decimal" min="1" data-fp="portion" value="${v('portion')}" placeholder="40">`) : ''}
      <div class="fp-macros">
        ${[['kcal', 'Ккал'], ['p', 'Белки'], ['f', 'Жиры'], ['c', 'Углев.']].map(([k, l]) => field(`${l}${per ? '' : ''}`, `<input class="control mono" type="number" inputmode="decimal" min="0" step="any" data-fp="${k}" value="${v(k)}">`)).join('')}
      </div>
      <p class="note a-tight" id="fp-cust-hint">${per ? 'Значения на порцию - пересчитаю на 100 г. ' : 'Значения на 100 г. '}${mm !== null && mm > 0.25 ? '<span class="err">Калории не сходятся с БЖУ - проверьте цифры.</span>' : ''}</p>
      <div class="grid2">${field('Бренд', `<input class="control" data-fp="brand" value="${v('brand')}" placeholder="необязательно" maxlength="60">`)}
        ${field('1 шт, г', `<input class="control mono" type="number" inputmode="decimal" min="0" data-fp="piece" value="${v('piece')}" placeholder="необязательно">`)}</div>
      ${field('Заметка', `<input class="control" data-fp="note" value="${v('note')}" placeholder="например: вес указан до варки" maxlength="200">`)}
      ${P.warn ? `<div class="notice fp-confirm"><b>Проверьте:</b><ul class="fp-warn">${P.warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
        <div class="a-row-btns"><button type="button" class="btn" data-act="fp-custom-save" data-force="1">Всё верно, сохранить</button><button type="button" class="btn quiet" data-act="fp-warn-close">Исправлю</button></div></div>` : ''}
      <div class="a-row-btns"><button type="button" class="btn" data-act="fp-custom-save">${c.id ? 'Сохранить изменения' : 'Сохранить в справочник'}</button>
        <button type="button" class="btn quiet" data-act="fp-view" data-view="search">Назад к поиску</button></div>
      ${!store.state.online ? '<p class="note">Сейчас нет связи: продукт появится у вас сразу, в общий справочник уйдёт при подключении.</p>' : ''}
    </div>`;
}

function aiView() {
  const a = P.ai;
  if (!store.state.online) return '<p class="note">Поиск с ИИ работает, когда есть связь с компьютером-сервером. Пока можно добавить <button type="button" class="a-linkbtn" data-act="fp-view" data-view="custom">свой продукт</button> по этикетке.</p>';
  const r = a.result;
  return `<div class="fp-form">
    ${field('Какой продукт', `<input class="control" id="fp-aiq" data-fpai="query" value="${esc(a.query ?? P.q)}" placeholder="например: гречка, творог 5%, батончик Bombbar" maxlength="120">`)}
    <div class="field"><span class="smallcaps">В каком виде будете взвешивать</span>${stateChips('ai', a.state || '')}</div>
    <p class="note a-tight">ИИ сверит справочник и Open Food Facts и проверит, что цифры - для этого состояния (гречка сухая ≠ варёная).</p>
    <div class="a-row-btns"><button type="button" class="btn" data-act="fp-ai-go" ${a.job || aiOff() ? 'disabled' : ''}${aiOff() ? ` title="${AI_OFF_NOTE}"` : ''}>${a.job ? 'Ищу…' : 'Найти БЖУ'}</button></div>
    ${a.job ? `<div class="notice"><span class="spinner"></span> ИИ ищет и проверяет значения${a.ahead ? ` · в очереди ${a.ahead}` : ''}… Это до минуты.</div>` : ''}
    ${a.error ? `<p class="err">${esc(a.error)}</p>` : ''}
    ${r ? `<div class="raised fp-ai-res">
      <div class="a-card-head"><span class="fp-name-strong">${esc(r.name)} ${stBadge(r.state)}</span><span class="fp-conf g-${CONF[r.confidence]?.[1] || 'bad'}-t">уверенность: ${CONF[r.confidence]?.[0] || '-'}</span></div>
      <div class="fp-big mono">${num(r.kcal)} ккал · Б ${dec(r.p)} · Ж ${dec(r.f)} · У ${dec(r.c)} <span class="muted">на 100 г</span></div>
      ${r.warnings?.length ? `<ul class="fp-warn">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${r.reasoning_short ? `<p class="note a-tight">${esc(r.reasoning_short)}</p>` : ''}
      ${(twin => twin ? `<p class="note a-tight">Почти совпадает со справочником: «${esc(twin.title)}» - <button type="button" class="a-linkbtn" data-act="fp-sel" data-id="${esc(twin.id)}" data-back="1">взять его</button>, чтобы не плодить дубли.</p>` : '')((r.local || []).find(x => x.state === r.state && x.kcal && Math.abs(x.kcal - r.kcal) / x.kcal < 0.05 && foods.get(x.id)))}
      ${r.sources?.length ? `<details class="fp-src"><summary>Источники (${r.sources.length})${r.web ? '' : ' · Open Food Facts недоступен'}</summary><ul>${r.sources.map(s => `<li class="${s.used ? 'used' : ''}">${s.used ? glyph('check') + ' ' : ''}${s.kind === 'off' ? 'OFF' : 'справочник'}: ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}${s.brand ? ` (${esc(s.brand)})` : ''} <span class="mono muted">${num(s.kcal)} ккал · Б ${dec(s.p)} · Ж ${dec(s.f)} · У ${dec(s.c)}</span>${s.kind === 'db' && s.id != null && foods.get(s.id) ? ` <button type="button" class="a-linkbtn" data-act="fp-sel" data-id="${esc(s.id)}" data-back="1">взять</button>` : ''}</li>`).join('')}</ul></details>` : ''}
      <div class="a-row-btns"><button type="button" class="btn" data-act="fp-ai-accept">Проверить и сохранить</button></div></div>` : ''}
  </div>`;
}

function basketHtml() {
  if (!P.items.length) return '';
  const t = sumItems(P.items);
  return `<div class="fp-basket"><div class="fp-bh"><span class="smallcaps">В записи · ${P.items.length}</span><span class="mono">${mac(t)}</span></div>
    ${P.items.map((it, i) => `<div class="fp-bi"><span class="fp-bn ell">${esc(it.name)}</span>${stBadge(it.state)}
      <label class="fp-bg"><input class="control mono g-in" type="number" inputmode="decimal" min="0" value="${it.grams}" data-fpb="${i}" aria-label="граммы: ${esc(it.name)}"> г</label>
      <span class="mono muted fp-bk">${num(it.kcal)}</span><button type="button" class="btn quiet fp-x" data-act="fp-rm" data-i="${i}" aria-label="Убрать ${esc(it.name)}">×</button></div>`).join('')}</div>`;
}

function pickerHtml() {
  const tabs = [['search', 'Поиск'], ['custom', 'Свой продукт'], ['ai', 'Найти с ИИ']];
  const into = P.into ? store.get(P.into) : null;
  return `<div class="modal-head"><div class="kicker smallcaps">Справочник продуктов</div><h2>${into ? `Добавить в «${esc(MEAL_NAME[into.data.meal || 'snack'] || 'запись')}»` : 'Добавить продукты'}</h2></div>
    <div class="modal-body fp">
      ${into ? `<p class="note a-tight">Продукты допишутся к записи: ${esc((into.data.text || '').slice(0, 80))}${(into.data.text || '').length > 80 ? '…' : ''}</p>` : `<div class="fp-meal">${MEALS.map(([k, l]) => `<button type="button" class="chip ${P.meal === k ? 'on' : ''}" data-act="fp-meal" data-meal="${k}">${l}</button>`).join('')}
        <input class="control mono a-time" type="time" id="fp-time" value="${esc(P.time)}" aria-label="Время"></div>`}
      ${basketHtml()}
      <div class="fp-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${P.view === k}" class="${P.view === k ? 'on' : ''}" data-act="fp-view" data-view="${k}">${l}</button>`).join('')}</div>
      ${P.view === 'search' ? `<input class="control fp-q" id="fp-q" type="search" value="${esc(P.q)}" placeholder="гречка, творог 5%, банан…" autocomplete="off" aria-label="Поиск продукта">
        <div id="fp-res" class="fp-res">${searchResults()}</div>` : P.view === 'custom' ? customView() : aiView()}
    </div>
    <div class="modal-foot"><button type="button" class="btn quiet" data-act="close">Закрыть</button>
      <button type="button" class="btn solid" data-act="fp-commit" ${P.items.length ? '' : 'disabled'}>${commitLabel()}${P.items.length ? ` · ${num(sumItems(P.items).kcal)} ккал` : ''}</button></div>`;
}

function isPickerOpen() { return !!document.querySelector('#modal .fp'); }

function paint(focusId) {
  const body = document.querySelector('#modal .modal-body');
  const scroll = body ? body.scrollTop : 0;
  const active = focusId || (document.activeElement?.id?.startsWith('fp-') ? document.activeElement.id : null);
  openModal(pickerHtml());
  document.querySelector('#modal .modal')?.classList.add('fp-modal');
  const nb = document.querySelector('#modal .modal-body');
  if (nb) nb.scrollTop = scroll;
  if (active) {
    const el = document.getElementById(active);
    if (el) { el.focus({ preventScroll: true }); if (el.id === 'fp-g') el.select(); else if (el.type === 'search' || el.type === 'text') el.setSelectionRange?.(el.value.length, el.value.length); }
  }
}

function openPicker(date, opts = {}) {
  // into - id записи еды, в которую дописываем продукты (кнопка «+ продукт» у записи)
  if (P.date !== date || (opts.into || null) !== P.into) { P.items = []; P.sel = null; }
  P.into = opts.into || null;
  if (!opts.keepSel) { P.sel = null; P.q = ''; }
  P.date = date;
  P.meal = fval('food', 'meal', document.querySelector('[data-form=food][data-key=meal]')?.value || P.meal || 'snack');
  P.time = fval('food', 'time', document.querySelector('[data-form=food][data-key=time]')?.value || '') || (date === C.today() ? nowHM() : '');
  P.view = opts.view || 'search';
  P.warn = null;
  paint(P.view === 'search' && !opts.noFocus ? 'fp-q' : null);
  foods.refresh().then(() => { if (isPickerOpen() && P.view === 'search') updateResults(); });
}

function updateResults() {
  const box = document.getElementById('fp-res');
  if (box) box.innerHTML = searchResults();
}

// преобразовать форму своего продукта в значения на 100 г (или null, если чисел нет)
function convertCustom(c) {
  const n = k => (c[k] === '' || c[k] === undefined || c[k] === null) ? NaN : Number(String(c[k]).replace(',', '.'));
  const vals = { kcal: n('kcal'), p: n('p'), f: n('f'), c: n('c') };
  if (Object.values(vals).some(x => !Number.isFinite(x) || x < 0)) return null;
  if (c.perPortion) {
    const w = n('portion');
    if (!Number.isFinite(w) || w <= 0) return null;
    for (const k in vals) vals[k] = r1(vals[k] * 100 / w);
  }
  vals.kcal = Math.round(vals.kcal);
  return vals;
}

// ввод в окне: поиск, граммы, форма своего продукта, корзина — без полной перерисовки
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.closest?.('#modal .fp')) return;
  if (el.id === 'fp-q') { P.q = el.value; P.sel = null; updateResults(); return; }
  if (el.id === 'fp-g') {
    P.grams = el.value;
    const f = foods.get(P.sel), live = document.getElementById('fp-live');
    if (f && live) live.textContent = mac(foods.macrosFor(f, Number(el.value.replace(',', '.')) || 0));
    return;
  }
  if (el.id === 'fp-time') { P.time = el.value; return; }
  if (el.dataset.fp) {
    P.custom[el.dataset.fp] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'checkbox') { paint(); return; }
    const hint = document.getElementById('fp-cust-hint');
    const mm = foods.energyMismatch(convertCustom(P.custom) || {});
    if (hint) hint.innerHTML = (P.custom.perPortion ? 'Значения на порцию - пересчитаю на 100 г. ' : 'Значения на 100 г. ') + (mm !== null && mm > 0.25 ? '<span class="err">Калории не сходятся с БЖУ - проверьте цифры.</span>' : '');
    return;
  }
  if (el.dataset.fpai) { P.ai[el.dataset.fpai] = el.value; return; }
  if (el.dataset.fpb !== undefined) {
    const i = Number(el.dataset.fpb), it = P.items[i];
    const f = foods.get(it?.food_id);
    if (!it) return;
    const g = Math.max(0, Number(el.value.replace(',', '.')) || 0);
    Object.assign(it, f ? foods.itemFor(f, g) : { grams: g });
    const t = sumItems(P.items);
    const bh = document.querySelector('#modal .fp-bh .mono');
    if (bh) bh.textContent = mac(t);
    const bk = el.closest('.fp-bi')?.querySelector('.fp-bk');
    if (bk) bk.textContent = num(it.kcal);
    const commit = document.querySelector('#modal [data-act=fp-commit]');
    if (commit) commit.textContent = `${commitLabel()} · ${num(t.kcal)} ккал`;
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.closest?.('#modal .fp')) return;
  if (e.target.id === 'fp-g') { e.preventDefault(); actions['fp-add'](); }
  else if (e.target.id === 'fp-q') {
    e.preventDefault();
    const first = foods.search(P.q, { limit: 1 })[0];
    if (first) actions['fp-sel']({ dataset: { id: String(first.id) } });
  } else if (e.target.dataset?.fpai !== undefined) { e.preventDefault(); actions['fp-ai-go'](); }
});

function addToBasket(f, grams) {
  const g = Math.max(0, Number(String(grams).replace(',', '.')) || 0);
  if (!g) return toast('Сколько граммов?');
  P.items.push(foods.itemFor(f, g));
  P.sel = null; P.grams = '';
}

const idOf = v => (/^\d+$/.test(String(v)) ? Number(v) : v);

async function pollLookup() {
  const a = P.ai;
  if (!a.job) return;
  try {
    const s = await store.api(`/api/ai/jobs/${a.job}`);
    a.ahead = s.ahead;
    if (s.status === 'done') { a.job = null; a.result = s.result; }
    else if (s.status === 'error') { a.job = null; a.error = s.error; }
  } catch (e) { if (e.status === 404) { a.job = null; a.error = 'Задача потерялась - попробуйте ещё раз'; } }
  if (isPickerOpen() && P.view === 'ai') paint();
  if (a.job) setTimeout(pollLookup, 2500);
  else if (!isPickerOpen() && a.result) toast('БЖУ найдены - откройте «Добавить продукт» → «Найти с ИИ»', 5000);
}

const pickerActions = {
  'fp-open': el => openPicker(el.dataset.date),
  'fp-recent': el => {
    const f = foods.get(idOf(el.dataset.id));
    if (!f) return;
    const date = el.dataset.date;
    if (P.date !== date) { P.items = []; }
    P.date = date;
    const g = Number(el.dataset.g) || 0;
    if (g) addToBasket(f, g); else { P.sel = f.id; P.grams = '100'; }
    openPicker(date, { noFocus: true, keepSel: true });
    if (!g) setTimeout(() => document.getElementById('fp-g')?.focus(), 30);
  },
  'fp-view': el => {
    P.view = el.dataset.view;
    P.warn = null;
    if (P.view === 'custom' && !P.custom.name && P.q && !P.custom.id) P.custom.name = P.q.trim();
    if (P.view === 'ai' && P.ai.query === undefined && P.q) P.ai.query = P.q.trim();
    paint(P.view === 'search' ? 'fp-q' : null);
  },
  'fp-meal': el => { P.meal = el.dataset.meal; paint(); },
  'fp-sel': el => {
    const id = idOf(el.dataset.id);
    if (el.dataset.back) { P.view = 'search'; P.q = foods.get(id)?.name || P.q; }
    if (P.sel === id && !el.dataset.back) { P.sel = null; paint(); return; }
    P.sel = id;
    const u = foods.usage().get(id);
    P.grams = u?.last_grams ? String(u.last_grams) : '100';
    paint('fp-g');
    document.querySelector('#modal .fp-item.on')?.scrollIntoView({ block: 'nearest' });
  },
  'fp-portion': el => {
    P.grams = el.dataset.g;
    const inp = document.getElementById('fp-g');
    if (inp) { inp.value = P.grams; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.focus(); }
  },
  'fp-add': () => {
    const f = foods.get(P.sel);
    if (!f) return;
    addToBasket(f, P.grams || document.getElementById('fp-g')?.value);
    paint('fp-q');
    // корзина — вверху окна: показываем, что продукт добавлен, и поле поиска для следующего
    const b = document.querySelector('#modal .modal-body'); if (b) b.scrollTop = 0;
  },
  'fp-rm': el => { P.items.splice(Number(el.dataset.i), 1); paint(); },
  'fp-state': el => {
    const tgt = el.dataset.key === 'ai' ? P.ai : P.custom;
    tgt.state = tgt.state === el.dataset.val ? '' : el.dataset.val;
    paint();
  },
  'fp-warn-close': () => { P.warn = null; paint(); },
  'fp-custom-save': async el => {
    const c = P.custom;
    const name = (c.name || '').trim();
    if (name.length < 2) return toast('Как называется продукт?');
    const v = convertCustom(c);
    if (!v) return toast(c.perPortion ? 'Нужны ккал, белки, жиры, углеводы и вес порции' : 'Нужны ккал, белки, жиры и углеводы на 100 г');
    if (v.kcal > 950 || v.p + v.f + v.c > 105) return toast('Больше, чем бывает в 100 г - проверьте, не на упаковку ли значения', 5000);
    const portions = {};
    if (Number(c.piece) > 0) portions['шт'] = Number(c.piece);
    if (c.perPortion && Number(c.portion) > 0) portions['порция'] = Number(c.portion);
    const fields = { name, state: c.state || null, ...v, portions, brand: (c.brand || '').trim() || null, note: (c.note || '').trim() || null,
      source: c.source || 'manual' };
    const force = !!el.dataset.force;
    if (!force && !store.state.online) {
      const mm = foods.energyMismatch(v);
      if (mm !== null && mm > 0.25) { P.warn = [`Калории (${v.kcal}) не сходятся с БЖУ: 4·Б + 4·У + 9·Ж ≈ ${Math.round(4 * v.p + 4 * v.c + 9 * v.f)} ккал.`]; return paint(); }
    }
    let res;
    try { res = await foods.save(fields, { force, id: c.id || null }); }
    catch (e) { return toast(e.message, 6000); }
    if (res.need_confirm) { P.warn = res.warnings; return paint(); }
    P.warn = null;
    P.custom = {};
    P.ai = {};
    P.view = 'search';
    P.q = res.food.name;
    P.sel = res.food.id;
    P.grams = portions['порция'] ? String(portions['порция']) : portions['шт'] ? String(portions['шт']) : '100';
    toast(res.offline ? 'Сохранено у вас - в общий справочник уйдёт при подключении' : fields.source === 'manual' ? 'Продукт в справочнике' : 'Сохранено в справочник');
    paint('fp-g');
  },
  'fp-edit-own': el => {
    const f = foods.get(idOf(el.dataset.id));
    if (!f) return;
    P.custom = { id: f.id, name: f.name, state: f.state || '', kcal: f.kcal, p: f.p, f: f.f, c: f.c, brand: f.brand || '', note: f.note || '',
      piece: f.portions?.['шт'] || '', source: f.source };
    P.view = 'custom';
    paint();
  },
  'fp-del-own': async el => {
    const id = idOf(el.dataset.id);
    const f = foods.get(id);
    if (!f || !confirm(`Удалить «${f.name}» из справочника? Записи еды останутся.`)) return;
    try { await foods.remove(id); } catch (e) { return toast(e.status === 0 ? 'Удалить можно, когда есть связь' : e.message); }
    P.sel = null;
    paint('fp-q');
  },
  'fp-ai-go': async () => {
    const a = P.ai;
    const query = (a.query ?? P.q ?? '').trim();
    if (query.length < 2) return toast('Напишите, какой продукт искать');
    a.query = query; a.error = null; a.result = null;
    try {
      const res = await store.api('/api/ai/jobs', { kind: 'foodlookup', input: { query, state: a.state || null } });
      a.job = res.job_id;
      paint();
      setTimeout(pollLookup, 2500);
    } catch (e) { a.error = aiErr(e); paint(); }
  },
  'fp-ai-accept': () => {
    const r = P.ai.result;
    if (!r) return;
    P.custom = { name: r.name, state: r.state || '', kcal: r.kcal, p: r.p, f: r.f, c: r.c, source: r.source === 'web' ? 'web' : 'ai',
      note: r.state === 'dry' ? 'БЖУ для сухого продукта, взвешивать до варки' : '', lookup: { confidence: r.confidence, warnings: r.warnings } };
    P.view = 'custom';
    P.warn = null;
    paint();
  },
  'fp-commit': async () => {
    if (!P.items.length) return;
    const into = P.into ? store.get(P.into) : null;
    if (into) {
      const items = [...(into.data.items || []), ...P.items.map(it => ({ ...it }))];
      await store.patch(into.id, { items, totals: sumItems(items), edited: true });
      const added = sumItems(P.items).kcal;
      P.items = []; P.sel = null; P.q = ''; P.into = null;
      closeModal();
      await afterChange(into.date);
      return toast(`Добавлено в запись: ${num(added)} ккал`);
    }
    const items = P.items.map(it => ({ ...it }));
    const totals = sumItems(items);
    const text = items.map(it => `${it.name} ${num(it.grams)} г`).join(', ');
    const date = P.date || C.today();
    const rec = await addEntry(date, { meal: P.meal, text, items, totals, status: 'calculated', time: P.time, source: 'picker' });
    P.items = []; P.sel = null; P.q = '';
    closeModal();
    toast(rec.data.out_of_window ? 'Записал. Это вне окна питания - отмечу, но без упрёков.' : `${MEAL_NAME[P.meal]}: записано ${num(totals.kcal)} ккал`);
  },
};

// позиции записи: метка состояния и заметка продукта (чтобы «гречка сухая» и «варёная» не путались)
function itemState(it) {
  const f = it.food_id != null ? foods.get(it.food_id) : null;
  return { st: it.state || f?.state || null, note: f?.note || null };
}

// ── экран ──
// ── подсказки из истории: при ПП рацион почти одинаковый ──
// Записи за 60 дней группируются по тексту; вес - частота, свежесть и тот же приём пищи.
// Нажатие открывает окно правки: граммы каждого продукта, лишнее - убрать, потом записать.
const HIST_DAYS = 60;
const normText = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
function history(meal, q = '') {
  const today = C.today(), since = C.addDays(today, -HIST_DAYS), nq = normText(q);
  const groups = new Map();
  for (const r of store.list('food', store.uid(), r => r.date >= since && r.date <= today && r.data.text)) {
    const key = normText(r.data.text);
    const g = groups.get(key) || { key, n: 0, last: '', meals: {}, rec: null };
    g.n++;
    g.meals[r.data.meal || 'snack'] = (g.meals[r.data.meal || 'snack'] || 0) + 1;
    // образец - самая свежая посчитанная запись (граммы и БЖУ), иначе просто самая свежая
    const better = !g.rec || (r.data.status === 'calculated' && g.rec.data.status !== 'calculated')
      || ((r.data.status === 'calculated') === (g.rec.data.status === 'calculated') && r.date > g.rec.date);
    if (better) g.rec = r;
    if (r.date > g.last) g.last = r.date;
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (nq) {
      const names = (g.rec.data.items || []).map(x => normText(x.name)).join(' ');
      if (!g.key.includes(nq) && !names.includes(nq)) continue;
    } else if (g.n < 2 && !g.meals[meal]) continue;
    const ago = C.daysBetween(g.last, today);
    out.push({ ...g, score: g.n + 12 / (ago + 3) + (g.meals[meal] || 0) * 2 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, nq ? 6 : 8);
}
function histChips(date, meal, q = '') {
  const list = history(meal, q);
  if (!list.length) return q ? '' : '';
  const label = q ? 'Вы уже ели' : `Часто на ${(MEALS.find(([k]) => k === meal)?.[1] || 'перекус').toLowerCase()}`;
  return `<span class="smallcaps muted">${esc(label)}</span><div class="chips">${list.map(g => {
    const t = g.rec.data.text, kc = g.rec.data.status === 'calculated' ? g.rec.data.totals?.kcal : null;
    return `<button class="chip fh-chip" data-act="fh-open" data-id="${g.rec.id}" data-date="${date}" title="${esc(t)}${g.n > 1 ? ` · ${g.n} раз за ${HIST_DAYS} дней` : ''}"><span class="ell">${esc(t)}</span>${kc ? `<span class="mono muted">${num(kc)}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

// окно правки перед записью: src - запись из истории или избранное
const FH = { src: null, date: null, grams: [], off: [] };
function fhTotals() {
  const its = (FH.src.items || []).map((x, i) => scaleItem(x, FH.grams[i])).filter((_, i) => !FH.off[i]);
  return FP.totals(its);
}
function scaleItem(x, g) {
  const k = x.grams ? g / x.grams : 1, r1 = v => Math.round(v * 10) / 10;
  return { ...x, grams: g, kcal: Math.round((Number(x.kcal) || 0) * k), p: r1((Number(x.p) || 0) * k), f: r1((Number(x.f) || 0) * k), c: r1((Number(x.c) || 0) * k) };
}
function fhTotLine() {
  const t = fhTotals();
  return `итого <b class="mono">${num(t.kcal)}</b> ккал · Б ${dec(t.p)} · Ж ${dec(t.f)} · У ${dec(t.c)}`;
}
function openHist(src, date) {
  FH.src = structuredClone(src); FH.date = date;
  FH.grams = (src.items || []).map(x => Number(x.grams) || 0); FH.off = FH.grams.map(() => false);
  const calc = src.status === 'calculated' && src.items?.length;
  const h = new Date().getHours();
  const meal = document.querySelector('[data-form=food][data-key=meal]')?.value || src.meal || (h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snack');
  // время, уже выбранное в форме, важнее «сейчас» - как и приём пищи
  const formTime = hm(fval('food', 'time', document.querySelector('[data-form=food][data-key=time]')?.value || ''));
  const time = formTime || (date === C.today() ? nowHM() : (src.time || ''));
  openModal(`<div class="modal-head"><h2>Записать снова</h2></div><div class="modal-body">
    ${calc ? `<p class="note" style="margin-top:0">Поправьте граммы, если порция другая. Лишнее - уберите.</p>
      <div class="fh-items">${src.items.map((x, i) => `<div class="fh-item" data-i="${i}">
        <span class="fh-name">${esc(x.name)}</span>
        <label class="fh-g"><input class="control mono" type="number" inputmode="decimal" min="0" step="5" value="${num(x.grams).replace(/\s/g, '')}" data-fh-g="${i}" aria-label="Граммы: ${esc(x.name)}"><span class="muted">г</span></label>
        <button class="btn quiet" data-act="fh-off" data-i="${i}" aria-label="Убрать: ${esc(x.name)}">${glyph('cross')}</button></div>`).join('')}</div>
      <p class="fh-tot" id="fh-tot">${fhTotLine()}</p>`
    : `<label class="field"><span class="smallcaps">Что съели</span><textarea class="control" id="fh-text" rows="2">${esc(src.text)}</textarea></label>
      <p class="note">Эта запись ещё не посчитана - текст можно поправить, посчитается как обычно.</p>`}
    <div class="actions"><select class="control" id="fh-meal" aria-label="Приём пищи">${MEALS.map(([k, l]) => `<option value="${k}" ${k === meal ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="control mono a-time" type="time" id="fh-time" value="${esc(time)}" aria-label="Время"></div>
    </div><div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="fh-save">Записать</button></div>`);
}
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset?.fhG !== undefined && FH.src) {
    FH.grams[Number(el.dataset.fhG)] = Math.max(0, Number(String(el.value).replace(',', '.')) || 0);
    const t = document.getElementById('fh-tot'); if (t) t.innerHTML = fhTotLine();
  }
  // подсказки прямо при наборе: совпадения с прошлыми записями
  if (el.dataset?.form === 'food' && el.dataset.key === 'text') {
    const box = document.getElementById('fd-hist');
    if (!box) return;
    const q = el.value.trim();
    const meal = document.querySelector('[data-form=food][data-key=meal]')?.value || 'snack';
    box.innerHTML = q.length >= 2 ? histChips(box.dataset.date, meal, q) : histChips(box.dataset.date, meal);
  }
});

function viewFood(date) {
  const entries = store.byDate('food', date).sort((a, b) => timeOf(a).localeCompare(timeOf(b)) || (a.data.created || a.updated_at) - (b.data.created || b.updated_at));
  const tg = C.target();
  const cheat = H.dayTypeOf(date) === 'cheat';
  const sc = foodScore(date, entries, tg);
  const tot = sc.tot;
  const MACRO_DOM = { kcal: 'food', p: 'prot', f: 'fat', c: 'carb' };
  const macro = (label, k, unit) => {
    const g = tg ? tg[k] : null, v = tot[k];
    const pct = g ? Math.min(100, v / g * 100) : 0;
    return `<div class="macro" data-dom="${MACRO_DOM[k]}"><div class="top"><span class="smallcaps muted">${label}</span><span class="mono">${num(v)}${g ? ' / ' + num(g) : ''} ${unit}</span></div>
      <div class="groove ${g && v > g * 1.05 && !cheat ? 'over' : ''}"><div class="fill" style="width:${pct}%"></div></div></div>`;
  };
  // приём пищи по умолчанию - следующий не внесённый сегодня: завтрак → обед → ужин → перекус (и дальше перекус)
  const mealsToday = new Set(entries.map(e => e.data.meal || 'snack'));
  const defMeal = ['breakfast', 'lunch', 'dinner'].find(k => !mealsToday.has(k)) || 'snack';
  const uncounted = entries.filter(e => e.data.status !== 'calculated').length;
  const win = eatingWindow();
  const favs = store.list('favfood').sort((a, b) => (a.data.title || '').localeCompare(b.data.title || ''));
  const yest = store.byDate('food', C.addDays(date, -1));
  const yMeals = MEALS.filter(([k]) => yest.some(e => (e.data.meal || 'snack') === k));
  const nowOk = date === C.today() ? inWindow(nowHM(), win) : true;
  const fishy = isBackdated(date) && date < C.today();
  const recentFoods = foods.recent(8);
  return `<div class="head-row"><div><div class="kicker smallcaps">Питание · ${esc(dayTitle(date))}</div><h1>${cheat ? 'Читмил' : `${num(tot.kcal)} ккал`}</h1></div>${dateNav('food', date)}</div>
    ${cheat ? `<div class="notice a-cheat">Читмил - сегодня без подсчётов. Записывать можно, упрёков не будет${tot.kcal ? ` · записано ${num(tot.kcal)} ккал` : ''}.</div>` : ''}
    ${fishy ? `<div class="notice">Задним числом можно, но по памяти легко ошибиться в порциях. Лучше записывать сразу после еды.</div>` : ''}
    ${tg ? '' : '<div class="notice">Нормы ещё не посчитаны - заполните профиль и нажмите «Пересчитать нормы».</div>'}
    <div class="macros ${cheat ? 'a-muted' : ''}">${macro('Ккал', 'kcal', '')}${macro('Белки', 'p', 'г')}${macro('Жиры', 'f', 'г')}${macro('Углеводы', 'c', 'г')}</div>
    ${windowBar(date, win)}
    ${!cheat && (sc.score !== null || sc.lines.length) ? `<div class="raised a-card a-fscore">
      <div class="a-fs-num"><b class="mono ${sc.score === null ? '' : `g-${sc.score >= 75 ? 'good' : sc.score >= 50 ? 'ok' : 'bad'}-t`}">${sc.score ?? '-'}</b><span class="smallcaps muted">оценка</span></div>
      <ul class="a-flines">${sc.lines.slice(0, 5).map(([cls, t]) => `<li class="${cls}">${esc(t)}</li>`).join('')}</ul></div>` : ''}
    <div class="inset food-add">
      <textarea class="control" data-form="food" data-key="text" placeholder="гречка 200 г, 2 яйца, кофе с молоком" aria-label="Что съели" data-enter="food-add">${esc(fval('food', 'text'))}</textarea>
      <div class="actions">${select('food', 'meal', defMeal, MEALS, 'aria-label="Приём пищи" data-rerender')}
        <input class="control mono a-time" type="time" data-form="food" data-key="time" value="${esc(fval('food', 'time', date === C.today() ? nowHM() : ''))}" aria-label="Время">
        <button class="btn solid" data-act="food-add" data-date="${date}">Добавить</button>
        <button class="btn" data-act="fp-open" data-date="${date}">Из справочника</button>
        ${uncounted > 1 ? `<button class="btn" data-act="food-calc-all" data-date="${date}">Посчитать всё (${uncounted})</button>` : ''}</div>
      ${win && date === C.today() && !nowOk ? '<p class="note a-tight">Сейчас вне окна питания - запись отметится. Решать тебе.</p>' : ''}
      <div class="a-quick" id="fd-hist" data-date="${date}">${histChips(date, fval('food', 'meal', defMeal), String(fval('food', 'text', '')).trim().length >= 2 ? String(fval('food', 'text', '')).trim() : '')}</div>
      ${recentFoods.length ? `<div class="a-quick"><span class="smallcaps muted">Мои и недавние</span><div class="chips">${recentFoods.map(r => `<button class="chip fp-chip" data-act="fp-recent" data-id="${esc(r.food.id)}" data-g="${r.last_grams || ''}" data-date="${date}" title="${esc(r.food.name)}${r.last_grams ? ` · ${num(r.last_grams)} г` : ''}"><span class="ell">${esc(r.food.name)}</span>${stBadge(r.food.state)}${r.last_grams ? `<span class="mono muted">${num(r.last_grams)} г</span>` : ''}</button>`).join('')}</div></div>` : ''}
      ${favs.length ? `<div class="a-quick"><span class="smallcaps muted">${glyph('star', { fill: true })} Избранное</span><div class="chips">${favs.map(f => `<button class="chip" data-act="fd-fav-add" data-id="${f.id}" data-date="${date}" title="${esc(f.data.text)}">${esc(f.data.title || f.data.text)}${f.data.totals?.kcal ? ` <span class="mono muted">${num(f.data.totals.kcal)}</span>` : ''}</button>`).join('')}</div></div>` : ''}
      ${yMeals.length ? `<div class="a-quick"><span class="smallcaps muted">Как вчера</span><div class="chips">${yMeals.map(([k, l]) => `<button class="chip" data-act="fd-yesterday" data-meal="${k}" data-date="${date}">${l}</button>`).join('')}</div></div>` : ''}
      <p class="note" style="margin:8px 0 0">Пишите как есть: «тарелка борща», «2 куска пиццы» - или выберите продукты из справочника и укажите граммы. Знакомое посчитается сразу, остальное - локальной ИИ по кнопке.</p>
    </div>

    ${(() => {
      // блоки по времени: завтрак, обед, ужин - по одному, каждый перекус отдельно (C.mealBlocks)
      const bl = C.mealBlocks(date, undefined, { all: true }), sn = bl.filter(b => b.meal === 'snack').length;
      return bl.map(b => {
        const kc = b.entries.reduce((a, e) => a + (e.data.totals?.kcal || 0), 0);
        const label = b.meal === 'snack' && sn > 1 ? `${MEAL_NAME.snack} ${b.n}` : MEAL_NAME[b.meal] || b.meal;
        return `<div class="meal-title" data-dom="food"><span class="smallcaps muted">${label}</span><span class="mono">${num(kc)} ккал</span></div>${b.entries.map(e => foodEntry(e, win)).join('')}`;
      }).join('');
    })()}
    ${!entries.length ? '<p class="empty" style="margin-top:20px">За этот день ничего не записано.</p>' : ''}
    ${mpSection(date)}
    ${planSection(date)}`;
}

// чем посчитана запись: справочником (и памятью) на устройстве или с уточнением ИИ
function calcLabel(d) {
  if (d.status !== 'calculated' || !d.items?.length) return d.partial ? '<span class="fd-calc">часть посчитана по справочнику</span>' : '';
  if (d.calc === 'supp') return '<span class="fd-calc">из добавок - отмечено на «Сегодня»</span>';
  if (d.calc === 'drink') return '<span class="fd-calc">молоко к кофе - отмечено на «Сегодня»</span>';
  if (d.calc === 'ai' || d.items.some(i => i.source === 'ai')) return '<span class="fd-calc">уточнено ИИ</span>';
  return `<span class="fd-calc">посчитано по справочнику${d.items.some(i => i.source === 'brain') ? ' и памяти тренера' : ''}</span>`;
}

function isFav(e) { return store.list('favfood').find(f => f.data.text === e.data.text) || null; }

function foodEntry(e, win) {
  const d = e.data, job = jobFor(e.id);
  let status = '';
  if (job) status = `<p class="note"><span class="spinner"></span> ИИ считает${job.ahead ? ` · в очереди ${job.ahead}` : ''}…</p>`;
  else if (d.calc_pending) status = '<p class="note">Посчитается, когда появится связь с сервером.</p>';
  else if (d.status !== 'calculated') {
    status = `<div class="actions" style="margin-top:8px">${d.calc_error ? `<span class="err">${esc(d.calc_error)}</span>` : ''}
      ${d.unresolved?.length ? `<span class="note">${d.partial ? 'Остальное посчитано по справочнику; нужна ИИ' : 'Нет в справочнике'}: ${esc(d.unresolved.join(', '))}</span>` : ''}
      ${d.unresolved?.length && aiOff() ? aiOffHint('Продукта нет в справочнике - его посчитает ИИ')
        : `<button class="btn" data-act="food-calc" data-id="${e.id}">Посчитать${d.unresolved?.length ? ' с ИИ' : ''}</button>`}</div>`;
  }
  const macF = (label, k, v, name, i, act) => `<label class="mac-f"><span class="mac-l">${label}</span>
    <input class="control mono" type="number" inputmode="decimal" step="${k === 'kcal' ? 1 : 0.1}" min="0" value="${esc(String(v ?? 0))}"
      data-act="${act}" data-k="${k}" data-id="${e.id}" data-i="${i}" aria-label="${label === 'ккал' ? 'Калории' : label}: ${esc(name)}"></label>`;
  const per100 = it => { const k = it.grams ? 100 / it.grams : 0; return { kcal: it.kcal * k, p: it.p * k, f: it.f * k, c: it.c * k }; };
  const items = (d.items || []).map((it, i) => { const is = itemState(it); const p100 = per100(it);
    const macRow = `<div class="mac mac-edit">${macF('ккал', 'kcal', it.kcal, it.name, i, 'food-macro')}${macF('Б', 'p', it.p, it.name, i, 'food-macro')}${macF('Ж', 'f', it.f, it.name, i, 'food-macro')}${macF('У', 'c', it.c, it.name, i, 'food-macro')}</div>
        ${it.grams ? `<div class="mac-calc note">на 100 г: ${num(Math.round(p100.kcal))} ккал · Б ${dec(p100.p)} · Ж ${dec(p100.f)} · У ${dec(p100.c)}</div>` : ''}`;
    return `<div class="fi"><div class="ell nm">${esc(it.name)}${stBadge(is.st)}${it.source === 'ai' ? '<span class="src-ai" title="Оценка ИИ: продукта нет в справочнике">≈ИИ</span>' : it.source === 'brain' ? '<span class="src-brain" title="Так эту фразу раньше разобрала ИИ - теперь считается без неё">память</span>' : it.source === 'manual' ? '<span class="src-brain" title="БЖУ заданы вручную">своё</span>' : ''}</div>
    <label class="g"><input class="control g-in" type="number" inputmode="numeric" value="${it.grams}" data-act="food-grams" data-id="${e.id}" data-i="${i}" aria-label="граммы: ${esc(it.name)}"> г</label>
    <button class="btn quiet a-mini fi-edit" data-act="fi-open" data-id="${e.id}" data-i="${i}" aria-label="Править продукт: ${esc(it.name)}" title="Править: название, вес, КБЖУ на 100 г">${glyph('pencil')}</button>
    <button class="btn quiet a-mini fi-del" data-act="food-item-del" data-id="${e.id}" data-i="${i}" aria-label="Убрать из записи: ${esc(it.name)}" title="Убрать эту строку">${glyph('cross')}</button>
    ${macRow}
    ${is.note ? `<div class="fi-note">${esc(is.note)}</div>` : ''}</div>`; }).join('');
  const t = timeOf(e);
  const out = win && t && !inWindow(t, win);
  const fav = isFav(e);
  return `<div class="raised entry" data-dom="food">
    <div class="a-entry-head"><div class="etext">${t ? `<span class="mono a-etime">${esc(t)}</span>` : ''}${esc(d.text)}${out ? ' <span class="chip a-out">вне окна</span>' : ''}</div>
      <div class="a-entry-btns"><button class="btn quiet a-star ${fav ? 'on' : ''}" data-act="fd-fav" data-id="${e.id}" aria-label="${fav ? 'Убрать из избранного' : 'В избранное'}" aria-pressed="${!!fav}" title="${fav ? 'В избранном' : 'В избранное'}">${glyph('star', { fill: !!fav })}</button>
        <button class="btn quiet" data-act="food-edit" data-id="${e.id}">Изменить</button><button class="btn danger" data-act="food-del" data-id="${e.id}">Удалить</button></div></div>
    ${items ? `<div class='fis'>${items}</div>` : ''}
    ${d.status === 'calculated' && d.calc !== 'supp' ? `<div class="a-row-btns fi-add"><button class="btn quiet a-mini" data-act="food-item-add" data-id="${e.id}">+ продукт в эту запись</button>${d.edited ? '<span class="note">изменено вручную</span>' : ''}</div>` : ''}
    ${d.totals ? `<div class="tot"><span>итого ${num(d.totals.kcal)} ккал</span><span>Б ${dec(d.totals.p)} · Ж ${dec(d.totals.f)} · У ${dec(d.totals.c)}</span>${calcLabel(d)}</div>` : ''}
    ${status}</div>`;
}

export async function calcFood(rec, ai = true) {
  if (!store.state.online && ai) {
    await store.patch(rec.id, { calc_pending: true });
    toast('Посчитаю, когда появится связь');
    return;
  }
  try {
    const res = await store.api('/api/food/calc', { record: store.get(rec.id), ai });
    if (res.done) { await store.sync(); await afterChange(rec.date); }
    else if (res.job_id) { await store.patch(rec.id, { calc_pending: false, calc_error: null }); await addJob(res.job_id, 'food', rec.id); }
    else if (res.unresolved) await store.patch(rec.id, { unresolved: res.unresolved });
  } catch (e) {
    if (e.status === 0) { if (ai) await store.patch(rec.id, { calc_pending: true }); return; }
    await store.patch(rec.id, { calc_pending: false, calc_error: e.message });
  }
}

async function addEntry(date, data) {
  const win = eatingWindow();
  const time = hm(data.time) || (date === C.today() ? nowHM() : null);
  const rec = await store.put('food', store.newId(), {
    ...data, time, created: Date.now(), entered_at: Date.now(), out_of_window: !!(win && time && !inWindow(time, win)),
  }, date);
  await afterChange(date);
  return rec;
}
const aiErr = e => e.status === 404 || e.status === 400 ? 'Эта функция появится после обновления сервера'
  : e.status === 0 ? 'Нет связи с сервером' : e.message;

// ── правка одного продукта в записи: название, вес, КБЖУ на 100 г и съеденное (одно пересчитывает другое) ──
const MK = [['kcal', 'ккал'], ['p', 'белки'], ['f', 'жиры'], ['c', 'углеводы']];
const rnd = (k, v) => k === 'kcal' ? Math.round(v) : Math.round(v * 10) / 10;
function fiModal(r, i) {
  const it = r.data.items[i], g = Number(it.grams) || 0;
  const p100 = k => g ? rnd(k, (it[k] || 0) * 100 / g) : 0;
  const cell = (col, k, v) => `<input class="control mono" type="number" inputmode="decimal" min="0" step="${k === 'kcal' ? 1 : 0.1}"
    id="fi-${col}-${k}" value="${esc(String(v ?? 0))}" aria-label="${MK.find(x => x[0] === k)[1]}, ${col === 'h' ? 'на 100 г' : 'съедено'}">`;
  openModal(`<div class="modal-head"><div class="kicker smallcaps">Продукт в записи</div><h2 class="ell">${esc(it.name)}</h2></div>
    <div class="modal-body fi-modal" data-id="${r.id}" data-i="${i}">
      <div class="grid2">${field('Название', `<input class="control" id="fi-name" value="${esc(it.name)}" autocomplete="off">`)}
        ${field('Съедено, г', `<input class="control mono" type="number" inputmode="decimal" min="0" id="fi-g" value="${esc(String(g))}">`)}</div>
      <table class="fi-tbl"><thead><tr><th></th><th>на 100 г</th><th>съедено</th></tr></thead><tbody>
        ${MK.map(([k, l]) => `<tr><th scope="row">${l}</th><td>${cell('h', k, p100(k))}</td><td>${cell('e', k, it[k])}</td></tr>`).join('')}
      </tbody></table>
      <p class="note">Поменяйте цифры в любой колонке - вторая пересчитается по весу. КБЖУ с упаковки обычно указано на 100 г.</p>
      <label class="chk"><input type="checkbox" id="fi-learn"> Запомнить в справочнике: в следующий раз посчитается с этими цифрами на 100 г</label>
    </div>
    <div class="modal-foot"><button class="btn danger" data-act="fi-remove" data-id="${r.id}" data-i="${i}">Убрать из записи</button>
      <button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="fi-save" data-id="${r.id}" data-i="${i}">Сохранить</button></div>`);
}
// живой пересчёт в окне: правка «на 100 г» или веса → «съедено», правка «съедено» → «на 100 г»
document.addEventListener('input', e => {
  const t = e.target;
  if (!t.closest?.('.fi-modal') || !/^fi-(h|e)-|^fi-g$/.test(t.id)) return;
  const $ = id => document.getElementById(id), g = Number($('fi-g').value) || 0;
  const val = id => Math.max(0, Number($(id).value) || 0);
  for (const [k] of MK) {
    if (t.id === 'fi-g' || t.id === `fi-h-${k}`) $(`fi-e-${k}`).value = rnd(k, val(`fi-h-${k}`) * g / 100);
    else if (t.id === `fi-e-${k}` && g) $(`fi-h-${k}`).value = rnd(k, val(`fi-e-${k}`) * 100 / g);
  }
});

export const actions = {
  ...pickerActions,
  ...mpActions,
  'food-add': async el => {
    const text = (fval('food', 'text') || '').trim();
    if (!text) return toast('Напишите, что съели');
    const meal = fval('food', 'meal', document.querySelector('[data-form=food][data-key=meal]')?.value || 'snack');
    const time = fval('food', 'time', document.querySelector('[data-form=food][data-key=time]')?.value || '');
    // сначала локально (справочник + память): знакомое считается сразу, даже без сети
    const loc = FP.localCalc(text);
    const rec = await addEntry(el.dataset.date, { meal, text, status: 'raw', time, ...loc });
    S.forms.food = { meal };
    S.render();
    if (rec.data.out_of_window) toast('Записал. Это вне окна питания - отмечу, но без упрёков.');
    if (store.state.online && rec.data.status !== 'calculated') calcFood(rec, false);
  },
  'food-calc': el => calcFood(store.get(el.dataset.id), true),
  'food-calc-all': async el => {
    for (const r of store.byDate('food', el.dataset.date).filter(r => r.data.status !== 'calculated' && !jobFor(r.id))) await calcFood(r, true);
  },
  'food-del': async el => {
    const r = store.get(el.dataset.id);
    await store.remove(el.dataset.id);
    // протеин из добавок / молоко к кофе: убираем и саму отметку, иначе на «Сегодня» она осталась бы висеть
    if (r?.data.supp_id && store.get(r.data.supp_id)) await store.remove(r.data.supp_id);
    if (r?.data.drink_id && store.get(r.data.drink_id)) await store.patch(r.data.drink_id, { milk: null, food_id: null });
    if (r) await afterChange(r.date);
  },
  'food-edit': el => {
    const r = store.get(el.dataset.id);
    openModal(`<div class="modal-head"><h2>Изменить запись</h2></div><div class="modal-body">
      ${field('Что съедено', `<textarea class="control" id="fe-text" rows="3">${esc(r.data.text)}</textarea>`)}
      <div class="grid2" style="margin-top:12px">${field('Приём пищи', `<select class="control" id="fe-meal">${MEALS.map(([k, l]) => `<option value="${k}" ${r.data.meal === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${field('Время', `<input class="control mono" type="time" id="fe-time" value="${esc(timeOf(r))}">`)}</div></div>
      <div class="modal-foot"><button class="btn quiet" data-act="close">Отмена</button><button class="btn solid" data-act="food-save" data-id="${r.id}">Сохранить</button></div>`);
  },
  'food-save': async el => {
    const r = store.get(el.dataset.id);
    const text = document.getElementById('fe-text').value.trim(), meal = document.getElementById('fe-meal').value;
    const time = hm(document.getElementById('fe-time').value) || r.data.time || null;
    const win = eatingWindow();
    const out_of_window = !!(win && time && !inWindow(time, win));
    closeModal();
    // тот же текст: запись, посчитанная справочником на устройстве и не правленная руками, разбираем заново -
    // так чинятся записи, разобранные старыми правилами (результат ИИ и ручные правки не трогаем)
    if (text === r.data.text && (r.data.calc !== 'local' || r.data.edited)) { await store.patch(r.id, { meal, time, out_of_window }); return; }
    const rec = await store.put('food', r.id, { ...r.data, text, meal, time, out_of_window, status: 'raw', items: [], totals: null, unresolved: null, calc_error: null, calc: null, partial: null, ...FP.localCalc(text) }, r.date);
    if (store.state.online && rec.data.status !== 'calculated') calcFood(rec, false);
  },
  // избранное
  'fd-fav': async el => {
    const r = store.get(el.dataset.id);
    if (!r) return;
    const cur = isFav(r);
    if (cur) { await store.remove(cur.id); toast('Убрано из избранного'); return; }
    const title = r.data.text.length > 40 ? r.data.text.slice(0, 38) + '…' : r.data.text;
    await store.put('favfood', store.newId(), { title, text: r.data.text, items: r.data.items || [], totals: r.data.totals || null, meal: r.data.meal || 'snack' });
    toast('Добавлено в избранное');
  },
  'fh-open': el => { const r = store.get(el.dataset.id); if (r) openHist(r.data, el.dataset.date); },
  'fh-off': el => {
    const i = Number(el.dataset.i);
    FH.off[i] = !FH.off[i];
    el.closest('.fh-item')?.classList.toggle('off', FH.off[i]);
    el.setAttribute('aria-label', (FH.off[i] ? 'Вернуть: ' : 'Убрать: ') + (FH.src.items[i]?.name || ''));
    const t = document.getElementById('fh-tot'); if (t) t.innerHTML = fhTotLine();
  },
  'fh-save': async () => {
    const src = FH.src, date = FH.date;
    if (!src) return;
    const meal = document.getElementById('fh-meal')?.value || src.meal || 'snack';
    const time = document.getElementById('fh-time')?.value || '';
    const calc = src.status === 'calculated' && src.items?.length;
    let data;
    if (calc) {
      const its = src.items.map((x, i) => [x, FH.grams[i], FH.off[i]]).filter(([, g, off]) => !off && g > 0);
      if (!its.length) return toast('Ничего не осталось - укажите граммы хотя бы одного продукта');
      const items = its.map(([x, g]) => scaleItem(x, g));
      // текст записи - исходные куски, где порция та же, иначе «название N г»
      const text = its.map(([x, g]) => (g === Number(x.grams) && x.text ? x.text : `${String(x.name).toLowerCase()} ${num(g).replace(/\s/g, '')} г`)).join(', ');
      data = { meal, text, items, totals: FP.totals(items), status: 'calculated', calc: src.calc || 'local', time };
    } else {
      const text = document.getElementById('fh-text')?.value.trim();
      if (!text) return toast('Напишите, что съели');
      data = { meal, text, time, status: 'raw', items: [], totals: null, ...FP.localCalc(text) };
    }
    closeModal();
    const rec = await addEntry(date, data);
    toast(`Записано: ${data.totals ? `${num(data.totals.kcal)} ккал` : data.text}`);
    if (data.status !== 'calculated' && store.state.online) calcFood(rec, false);
    FH.src = null;
  },
  'fd-fav-add': async el => {
    const f = store.get(el.dataset.id);
    if (!f) return;
    // избранное тоже через окно правки: порция бывает другой
    if (f.data.totals && f.data.items?.length) return openHist({ ...f.data, status: 'calculated' }, el.dataset.date);
    const calc = f.data.totals && f.data.items?.length;
    const meal = fval('food', 'meal', document.querySelector('[data-form=food][data-key=meal]')?.value || f.data.meal || 'snack');
    const rec = await addEntry(el.dataset.date, { meal, text: f.data.text, items: structuredClone(f.data.items || []), totals: f.data.totals ? { ...f.data.totals } : null,
      status: calc ? 'calculated' : 'raw', time: fval('food', 'time', '') });
    toast(`${f.data.title}: записано`);
    if (!calc && store.state.online) calcFood(rec, false);
  },
  'fd-yesterday': async el => {
    const { meal, date } = el.dataset;
    const src = store.byDate('food', C.addDays(date, -1)).filter(e => (e.data.meal || 'snack') === meal);
    for (const e of src) {
      const calc = e.data.status === 'calculated';
      const rec = await addEntry(date, { meal, text: e.data.text, items: structuredClone(e.data.items || []), totals: e.data.totals ? { ...e.data.totals } : null,
        status: calc ? 'calculated' : 'raw', time: e.data.time || null });
      if (!calc && store.state.online) calcFood(rec, false);
    }
    toast(`${MEAL_NAME[meal]} как вчера: ${src.length} ${src.length === 1 ? 'запись' : 'записи'}`);
  },
  // планы и рецепты
  'fd-quick': async el => {
    const date = el.dataset.date;
    quickPlans.set(date, 'loading');
    S.render();
    try {
      const res = await store.api(`/api/mealplan/quick?date=${date}`);
      quickPlans.set(date, res || { error: 'Пустой ответ' });
    } catch (e) {
      quickPlans.set(date, { error: e.status === 404 ? 'Идеи на день появятся после обновления сервера.' : e.status === 0 ? 'Нет связи с сервером - идеи рациона собираются на компьютере с Тренером.' : e.message });
    }
    S.render();
  },
  'fd-recipe': () => { (S.forms.fd ||= {}).recipeAsk = true; S.render(); },
  'fd-recipe-cancel': () => { (S.forms.fd ||= {}).recipeAsk = false; S.render(); },
  'fd-ai': async el => {
    const { kind, date } = el.dataset;
    const text = kind === 'recipe' ? (fval('fd', 'recipeText', '') || '').trim() : '';
    try {
      await store.sync();
      const res = await store.api('/api/ai/jobs', { kind, input: kind === 'recipe' ? { text, date } : { date } });
      if (kind === 'recipe') S.forms.fd = { ...(S.forms.fd || {}), recipeAsk: false, recipeText: '' };
      await addJob(res.job_id, kind, kind === 'recipe' ? 'recipe' : 'mealplan:' + date);
    } catch (e) { toast(aiErr(e), 6000); }
  },
  // правка записи по строкам: убрать лишнее (ИИ посчитал яйца дважды), дописать забытое из справочника
  'food-item-del': async el => {
    const r = store.get(el.dataset.id);
    if (!r) return;
    const i = Number(el.dataset.i), items = (r.data.items || []).filter((_, j) => j !== i);
    const gone = r.data.items?.[i];
    if (!items.length) {
      await store.remove(r.id);
      toast('Это была последняя строка - запись удалена');
    } else {
      await store.patch(r.id, { items, totals: sumItems(items), edited: true });
      if (gone) toast(`Убрал «${gone.name}» из записи`);
    }
    await afterChange(r.date);
  },
  'fi-open': el => { const r = store.get(el.dataset.id); if (r?.data.items?.[Number(el.dataset.i)]) fiModal(r, Number(el.dataset.i)); },
  'fi-remove': async el => { closeModal(); await actions['food-item-del'](el); },
  'fi-save': async el => {
    const r = store.get(el.dataset.id);
    if (!r) return closeModal();
    const i = Number(el.dataset.i), items = structuredClone(r.data.items), it = items[i], prev = { ...it };
    const $ = id => document.getElementById(id), num0 = id => Math.max(0, Number($(id).value) || 0);
    const name = $('fi-name').value.trim() || it.name, g = num0('fi-g'), learn = $('fi-learn').checked;
    const per = Object.fromEntries(MK.map(([k]) => [k, num0(`fi-h-${k}`)]));
    it.name = name;
    it.grams = g;
    for (const [k] of MK) it[k] = rnd(k, num0(`fi-e-${k}`));
    const same = name === prev.name && MK.every(([k]) => it[k] === prev[k]);
    if (!same) { it.source = 'manual'; delete it.food_id; delete it.state; }
    closeModal();
    await store.patch(r.id, { items, totals: itemsTotals(items), edited: true });
    if (g !== prev.grams && same) BR.gramsEdited(items, i);
    if (learn && per.kcal) {
      foods.save({ name, kcal: per.kcal, p: per.p, f: per.f, c: per.c, source: 'manual' }, { force: true })
        .then(() => toast(`«${name}» теперь в справочнике`)).catch(e => toast(e.message));
    } else toast('Сохранено');
    await afterChange(r.date);
  },
  'food-item-add': el => {
    const r = store.get(el.dataset.id);
    if (r) openPicker(r.date, { into: r.id });
  },
};

// пересчёт итога записи по строкам (как в food-grams/food-macro)
function itemsTotals(items) {
  const totals = { kcal: 0, p: 0, f: 0, c: 0 };
  if (items.some(i => i.fiber !== undefined)) totals.fiber = 0;
  items.forEach(i => { for (const m in totals) totals[m] += i[m] || 0; });
  for (const m of ['p', 'f', 'c', 'fiber']) if (totals[m] !== undefined) totals[m] = Math.round(totals[m] * 10) / 10;
  return totals;
}

export const changes = {
  'mp-wt': el => { MP.wt = el.value; S.render(); },
  'food-grams': async el => {
    const r = store.get(el.dataset.id);
    const items = structuredClone(r.data.items), it = items[Number(el.dataset.i)];
    const g = Math.max(0, Number(el.value) || 0);
    if (it.grams) {
      const k = g / it.grams;
      it.kcal = Math.round(it.kcal * k);
      ['p', 'f', 'c', 'fiber'].forEach(m => { if (it[m] !== undefined) it[m] = Math.round(it[m] * k * 10) / 10; });
    }
    it.grams = g;
    await store.patch(r.id, { items, totals: itemsTotals(items) });
    BR.gramsEdited(items, Number(el.dataset.i));     // поправка порции/фразы → память для всех устройств
  },
  // БЖУ строки правится напрямую - числа заданы человеком, справочнику и памяти это уже не в зачёт
  // (food_id/state снимаем, как у позиций с явным КБЖУ в тексте - см. food.py _macro_item)
  'food-macro': async el => {
    const r = store.get(el.dataset.id);
    const items = structuredClone(r.data.items), it = items[Number(el.dataset.i)];
    const k = el.dataset.k, v = Math.max(0, Number(el.value) || 0);
    it[k] = k === 'kcal' ? Math.round(v) : Math.round(v * 10) / 10;
    it.source = 'manual';
    delete it.food_id;
    delete it.state;
    await store.patch(r.id, { items, totals: itemsTotals(items) });
  },
};

export const routes = { food: arg => viewFood(isDate(arg) ? arg : C.today()) };

// справочник при первом открытии экрана (дальше — раз в 5 минут из background)
let firstLoad = 0;
export function afterRender() {
  if (store.getMeta('foods') || !store.state.online || Date.now() - firstLoad < 30e3) return;
  firstLoad = Date.now();
  foods.refresh().then(() => { if (store.getMeta('foods')) S.render(); });
  BR.refresh();
}

// записи, которые просили посчитать без связи, — досчитать, когда связь появилась
export async function background() {
  if (!store.state.online) return;
  await foods.refresh();
  await BR.refresh();                                  // память «мозга»: дельта с сервера
  for (const r of store.list('food', store.uid(), r => r.data.calc_pending)) {
    await store.patch(r.id, { calc_pending: false });
    await calcFood(store.get(r.id), true);
  }
}
