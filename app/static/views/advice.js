import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import * as GL from '../goals.js';
import * as AN from '../analysis.js';
import * as SP from '../supps.js';
import { esc, num, plural, profile, glyph } from '../ui.js';

// Рекомендации тренера: одно место со всеми советами - питание, вода, сон, активность, тренировки, вес, самочувствие.
// Считается на устройстве из ваших записей при каждом открытии (последние 7 дней), поэтому само обновляется
// после новых данных; без сети и без ИИ. Комментарий ИИ к нормам (если был) - отдельной строкой.

const safe = (fn, fb = null) => { try { const v = fn(); return v === undefined ? fb : v; } catch (e) { console.warn(e); return fb; } };
const dec = (v, d = 1) => (v == null ? '-' : (+v).toFixed(d).replace('.', ','));
const avg = xs => { const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const days = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
// последние 7 завершённых дней (вчера и раньше): сегодняшний день ещё идёт
const lastDays = (n = 7) => Array.from({ length: n }, (_, i) => C.addDays(C.today(), -(i + 1)));

const actName = type => (store.getMeta('activities', []) || []).find(a => a.id === type)?.name || type;
// рекомендация: level good | warn | info; text - что видно; tip - что делать
const R = (level, text, tip = '') => ({ level, text, tip });

function nutrition(uid) {
  const t = C.target(uid), out = [];
  if (!t?.kcal) return [R('info', 'Нормы питания ещё не посчитаны.', 'Профиль → «Нормы» → «Пересчитать».')];
  const ds = lastDays().map(d => C.foodDay(d, uid)).filter(f => f?.calculated);
  if (ds.length < 3) return [R('info', ds.length ? `Еда посчитана только за ${days(ds.length)} из последних 7.` : 'За последние 7 дней еда ещё не записана.', 'Записывай все приёмы пищи - без этого советы по питанию будут наугад.')];
  const a = k => avg(ds.map(f => f[k]));
  const kcal = a('kcal'), p = a('p'), f = a('f'), c = a('c');
  const dk = (kcal - t.kcal) / t.kcal;
  out.push(Math.abs(dk) <= 0.1 ? R('good', `Калории в среднем ${num(kcal)} при норме ${num(t.kcal)} - в коридоре.`)
    : dk > 0 ? R('warn', `Калорий в среднем ${num(kcal)} - на ${Math.round(dk * 100)} % выше нормы ${num(t.kcal)}.`, 'Проще всего срезать сладкое, соусы и перекусы - основной рацион не трогая.')
    : R('warn', `Калорий в среднем ${num(kcal)} - на ${Math.round(-dk * 100)} % ниже нормы ${num(t.kcal)}.`, dk < -0.25 ? 'Сильный недобор тормозит обмен и съедает мышцы - добавь полноценный приём пищи.' : 'Возможно, не всё записано. Если записано всё - добавь перекус с белком.'));
  const dp = p / t.p;
  out.push(dp >= 0.9 ? R('good', `Белок в среднем ${num(p)} г из ${num(t.p)} - хорошо.`)
    : R('warn', `Белка в среднем ${num(p)} г из ${num(t.p)} - не хватает ${num(t.p - p)} г в день.`, 'Белок в каждый приём: творог, яйца, курица, рыба, греческий йогурт. 100 г творога 5 % - это 17 г.'));
  if (t.c && c > t.c * 1.15) out.push(R('warn', `Углеводов в среднем ${num(c)} г при норме ${num(t.c)}.`, 'Убери сладкое и мучное вне тренировочных дней.'));
  if (t.f && f > t.f * 1.2) out.push(R('warn', `Жиров в среднем ${num(f)} г при норме ${num(t.f)}.`, 'Масло, сыр, орехи и соусы - взвешивай, их легко перебрать.'));
  const late = ds.filter(x => x.late.length).length;
  if (late >= 3) out.push(R('warn', `Поздняя еда в ${days(late)} из ${ds.length}.`, 'Последний плотный приём - за 3 часа до сна.'));
  if (t.macros_manual) out.push(R('info', `Нормы БЖУ у тебя свои: ${t.p} / ${t.f} / ${t.c} г, ${num(t.kcal)} ккал (по формуле ${num(t.formula?.kcal)} ккал).`));
  return out;
}

function water(uid) {
  const t = C.target(uid), it = C.items(uid).find(i => i.data.target_from === 'water');
  const out = [];
  const own = C.goalTo('water_avg', uid), norm = t?.water_glasses;
  if (own && norm && own < norm) {
    out.push(R('warn', `Твоя цель - ${own} ${plural(own, 'стакан', 'стакана', 'стаканов')}, а по расчёту нужно около ${norm} (${num(t.water_ml)} мл, 30 мл на кг веса).`,
      'Часть воды приходит с едой (супы, овощи, фрукты), так что начать с твоей цели можно. Но в дни тренировок и в жару добирай до расчётной, а цель в «Целях» поднимай по стакану в неделю.'));
  }
  if (it) {
    const vals = lastDays().map(d => Number(C.logVal(d, it.id, uid))).filter(v => v > 0);
    if (vals.length >= 3) {
      const a = avg(vals), goal = C.itemTarget(it, C.today(), uid);
      out.push(a >= goal * 0.9 ? R('good', `Воды в среднем ${dec(a)} ${plural(Math.round(a), 'стакан', 'стакана', 'стаканов')} в день - цель ${goal} выполняется.`)
        : R('warn', `Воды в среднем ${dec(a)} стак. при цели ${goal}.`, 'Стакан воды к каждому приёму пищи и после тренировки - уже половина нормы.'));
    } else out.push(R('info', 'Вода отмечена меньше трёх дней за неделю.', 'Отмечай стаканы на «Сегодня» - так тренер увидит, хватает ли воды.'));
  }
  return out;
}

function sleepAdvice(uid) {
  const st = C.sleepStats(7, uid), need = C.sleepTarget(uid), out = [];
  if (st.count < 3) return [R('info', st.count ? `Сон записан за ${days(st.count)} из последних 7.` : 'За последние 7 дней сон ещё не записан.', 'Записывайте сон каждое утро - без этого не видно, откуда усталость.')];
  out.push(st.avgHours >= need - 0.25 ? R('good', `Сон в среднем ${dec(st.avgHours)} ч при норме ${dec(need)} - хватает.`)
    : R('warn', `Сон в среднем ${dec(st.avgHours)} ч при норме ${dec(need)}; коротких ночей: ${st.shortNights}.`, 'Отбой на 15 минут раньше каждую неделю - так сдвигать проще всего. Недосып мешает худеть: растёт аппетит и тяга к сладкому.'));
  if (st.bedtimeSpreadMin >= 60) out.push(R('warn', `Время отбоя гуляет в среднем на ${st.bedtimeSpreadMin} мин.`, 'Ложись в одно время и в выходные - сон станет глубже без лишних часов.'));
  if (st.avgSnooze >= 20) out.push(R('info', `Дрёма после будильника в среднем ${st.avgSnooze} мин.`, 'Этот сон рваный и почти не восстанавливает - лучше поставить будильник позже и вставать с первого.'));
  if (st.trend === 'down') out.push(R('warn', 'Качество сна за неделю снизилось.', 'Проверь поздний кофе, еду перед сном и экран в постели.'));
  return out;
}

function activity(uid) {
  const out = [];
  const stepsIt = C.items(uid).find(i => i.data.target_from === 'steps');
  if (stepsIt) {
    const vals = lastDays().map(d => Number(C.logVal(d, stepsIt.id, uid))).filter(v => v > 0);
    const goal = C.itemTarget(stepsIt, C.today(), uid);
    if (vals.length >= 3) {
      const a = avg(vals);
      out.push(a >= goal * 0.9 ? R('good', `Шагов в среднем ${num(a)} при цели ${num(goal)}.`)
        : R('warn', `Шагов в среднем ${num(a)} при цели ${num(goal)} - не хватает ${num(goal - a)}.`, `Это около ${Math.round((goal - a) / 100)} минут ходьбы: прогулка после ужина или часть пути пешком.`));
    } else out.push(R('info', 'Шаги почти не записаны за неделю.', 'Подключи «Здоровье» (Профиль → «Здоровье») - шаги будут приходить сами.'));
  }
  const ct = safe(() => P.cardioTarget(uid)), cw = safe(() => P.cardioWeek(C.today(), uid));
  if (ct && cw) {
    const left = ct.minutes - cw.done, dl = 6 - C.weekday(C.today());
    out.push(left <= 0 ? R('good', `Кардио на этой неделе ${cw.done} из ${ct.minutes} мин - норма есть.`)
      : R(left > (dl + 1) * 40 ? 'warn' : 'info', `Кардио на этой неделе ${cw.done} из ${ct.minutes} мин, осталось ${left} мин за ${days(dl + 1)}.`, 'Карточка кардио на «Сегодня» подскажет, что и где: велосипед, быстрая ходьба, степпер.'));
  }
  const wa = safe(() => C.weekActivity(C.today(), uid));
  if (wa?.behindMin >= 30) out.push(R('warn', `Недельный объём движения отстаёт примерно на ${wa.behindMin} мин.`, 'Домашний комплекс из плана или короткая тренировка на 20 минут закроют часть.'));
  return out;
}

function training(uid) {
  const out = [];
  const from = C.addDays(C.today(), -14);
  const ws = store.list('workout', uid, r => r.date >= from && r.date < C.today() && r.data.variant !== 'moved');
  if (!ws.length && !store.list('program', uid).some(r => r.data.active !== false)) {
    return [R('info', 'Программы тренировок пока нет.', '«Спорт» → «Составить программу»: тренер разложит тренировки по твоим дням.')];
  }
  if (ws.length) {
    const done = ws.filter(w => C.workoutProgress(w) >= 0.8).length;
    out.push(done >= ws.length * 0.8 ? R('good', `За 2 недели сделано ${done} из ${ws.length} тренировок по плану.`)
      : R('warn', `За 2 недели сделано ${done} из ${ws.length} тренировок.`, 'Не получается в свой день - переноси, а не пропускай: на «Сегодня» есть «перенести», тренер найдёт свободный день.'));
  }
  // план недели: комплексы и активности, которые ещё впереди
  const plan = safe(() => C.planTasks(uid), []);
  const mon = C.mondayOf(), left = [];
  for (const t of plan) {
    let n = 0;
    for (let d = mon; d <= C.today(); d = C.addDays(d, 1)) if (C.planDone(t, d, uid) >= 0.5) n++;
    if (n < t.n) left.push(`${t.kind === 'module' ? (P.MODULES?.[t.module]?.title || t.module) : t.name || actName(t.type)} ${n}/${t.n}`);
  }
  if (left.length) out.push(R('info', `План недели: ${left.join(', ')}.`, 'Пропущенное тренер переносит на оставшиеся дни - смотри чек-лист «Сегодня».'));
  if (safe(() => P.needsDeload?.(), false)) out.push(R('warn', 'Пора разгрузочную неделю.', '«Спорт» → «Разгрузочная неделя»: те же упражнения, меньше подходов и веса.'));
  return out;
}

function body(uid) {
  const out = [];
  const tr = safe(() => C.weightTrend(21, uid)), dir = C.goalDir(uid);
  if (tr == null) out.push(R('info', 'Для тренда веса мало взвешиваний.', 'Взвешивайся 2-3 раза в неделю утром натощак - тренд покажет, работает ли план.'));
  else if (dir === 'down') out.push(tr <= -0.2 ? R(tr < -1 ? 'warn' : 'good', `Вес снижается на ${dec(-tr)} кг в неделю${tr < -1 ? ' - быстровато, так уходят и мышцы' : ''}.`, tr < -1 ? 'Добавь 150-200 ккал и держи белок.' : '')
    : R('warn', `Вес за 3 недели почти стоит (${tr > 0 ? '+' : ''}${dec(tr)} кг в неделю).`, 'Проверь, всё ли записано в еде; если да - нормы стоит пересчитать с новым весом.'));
  else if (dir === 'up') out.push(tr >= 0.1 ? R('good', `Вес растёт на ${dec(tr)} кг в неделю.`) : R('warn', 'Вес не растёт.', 'Добавь 200 ккал в день, лучше углеводами вокруг тренировки.'));
  if (safe(() => C.plateau(uid)?.weight)) out.push(R('warn', 'Похоже на плато по весу.', 'Профиль → «Нормы» → «Пересчитать»: нормы подстроятся под новый вес.'));
  for (const g of safe(() => GL.metricGoals(uid), [])) {
    const pr = safe(() => GL.progress(g, uid));
    const m = GL.metric(g.metric);
    // привычки (вода, шаги, сон, белок) разобраны в своих разделах - здесь только тело и результаты
    if (!pr || !m || m.group === 'habit' || pr.status === 'nodata' || pr.status === 'early') continue;
    if (pr.status === 'behind') out.push(R('warn', `${m.label}: ${pr.label}.`, m.hint?.[g.to > g.from ? 'up' : 'down'] || ''));
    else if (pr.status === 'done') out.push(R('good', `${m.label}: цель достигнута.`, 'Поставь следующую ступень в «Целях».'));
  }
  return out;
}

function feel(uid) {
  const ss = lastDays().map(d => C.stateOf(d, uid)).filter(Boolean);
  if (ss.length < 3) return [R('info', 'Самочувствие отмечено меньше трёх дней за неделю.', 'Две секунды на «Сегодня» - и тренер видит, когда облегчать нагрузку.')];
  const out = [];
  const stress = ss.filter(s => s.stress === 'high').length, sleepy = ss.filter(s => s.sleepy === 'some' || s.sleepy === 'strong').length;
  const bad = ss.filter(s => s.wellbeing === 'meh' || s.wellbeing === 'broken').length, sore = ss.filter(s => s.soreness === 'strong').length;
  if (stress >= 3) out.push(R('warn', `Сильный стресс ${days(stress)} из ${ss.length}.`, 'В такие дни лучше прогулка или лёгкая тренировка вместо тяжёлой; сон важнее обычного.'));
  if (sleepy >= 3) out.push(R('warn', `В сон днём клонило ${days(sleepy)} из ${ss.length}.`, 'Чаще всего это недосып или тяжёлый обед; кофе после 14:00 делает только хуже ночью.'));
  if (sore >= 3) out.push(R('warn', `Сильная мышечная боль ${days(sore)} из ${ss.length}.`, 'Нагрузка растёт слишком быстро - облегчи ближайшую тренировку и добавь сна.'));
  if (bad >= 3) out.push(R('warn', `Самочувствие «так себе» или хуже ${days(bad)} из ${ss.length}.`, 'Посмотри на сон и питание выше; если держится - отдых и, при необходимости, врач.'));
  if (!out.length) out.push(R('good', 'Самочувствие ровное: без сильного стресса, сонливости и боли.'));
  return out;
}

// курение/алкоголь - только если отмечено в целях (без цели этого раздела не будет вовсе). Считаем и сегодня,
// не только прошедшую неделю - иначе «сорвался сегодня» может показаться зелёной галочкой (неделя-то ещё чистая)
function habitLine(freeDays, todayN, weekN, freeText, weekWord, tip) {
  if (todayN > 0) return R('warn', `Сегодня уже отмечено случаев: ${todayN}.`, tip);
  if (weekN > 0) return R('warn', `За неделю отмечено случаев: ${weekN}.`, tip);
  return R('good', freeDays != null ? `${freeText} ${days(freeDays)} подряд - так держать.` : `За неделю ${weekWord} не отмечен${weekWord === 'алкоголь' ? '' : 'о'}.`);
}
function habits(uid) {
  const out = [];
  const today = C.today();
  if (C.smokingOn(uid)) {
    const todayN = C.smokeList(today, uid).length, weekN = lastDays().reduce((a, d) => a + C.smokeList(d, uid).length, 0);
    out.push(habitLine(C.smokeFreeDays(uid), todayN, weekN, 'Без курения', 'курение',
      'Отмечай каждый случай честно - тренер видит прогресс только по записям, не по ощущениям.'));
  }
  if (C.alcoholOn(uid)) {
    const todayN = C.alcoholList(today, uid).length, weekN = lastDays().reduce((a, d) => a + C.alcoholList(d, uid).length, 0);
    out.push(habitLine(C.alcoholFreeDays(uid), todayN, weekN, 'Без алкоголя', 'алкоголь',
      'Считается любая порция - так лучше видно, где чаще всего срывы.'));
  }
  return out;
}

function supplements(uid) {
  const adv = safe(() => SP.advice(uid), []) || [];
  return adv.slice(0, 3).map(a => R('info', `Можно рассмотреть: ${a.item.name}.`, a.why));
}

function insights(uid) {
  const list = safe(() => AN.insights(uid), []) || [];
  return list.filter(x => x.strength === 'strong' || x.strength === 'moderate').slice(0, 4).map(x => R('info', `${x.title}: ${x.text}`));
}

const SECTIONS = [
  ['food', 'Питание', 'food', nutrition], ['water', 'Вода', 'water', water], ['sleep', 'Сон', 'sleep', sleepAdvice],
  ['move', 'Активность', 'move', activity], ['train', 'Тренировки', 'train', training], ['goal', 'Вес и цели', 'goal', body],
  ['mood', 'Самочувствие', 'mood', feel], ['habits', 'Курение и алкоголь', 'mood', habits],
  ['supp', 'Добавки', 'food', supplements], ['coach', 'Что показал анализ', 'coach', insights],
];

export function collect(uid = store.uid()) {
  return SECTIONS.map(([key, title, dom, fn]) => ({ key, title, dom, items: safe(() => fn(uid), []) || [] })).filter(s => s.items.length);
}

const MARK = { good: ['check', 'хорошо'], warn: ['dip', 'обратить внимание'], info: ['steady', 'к сведению'] };

function viewAdvice() {
  const secs = collect();
  const all = secs.flatMap(s => s.items), warn = all.filter(x => x.level === 'warn').length, good = all.filter(x => x.level === 'good').length;
  const t = C.target();
  const top = secs.flatMap(s => s.items.filter(x => x.level === 'warn').map(x => ({ ...x, sec: s.title }))).slice(0, 3);
  return `<div class="head-row"><div><div class="kicker smallcaps">Тренер · по твоим данным за неделю</div><h1>Рекомендации</h1></div></div>
    <p class="lede">Сводка по всему сразу. Обновляется сама, когда появляются новые записи: еда, сон, шаги, тренировки, вес.</p>
    <div class="stats"><span class="chip">${glyph('dip')} обратить внимание: <span class="mono">${warn}</span></span><span class="chip">${glyph('check')} хорошо: <span class="mono">${good}</span></span></div>
    ${top.length ? `<div class="raised a-card adv-top" data-dom="coach"><div class="smallcaps">Главное сейчас</div><ol>${top.map(x => `<li><b>${esc(x.sec)}.</b> ${esc(x.text)}</li>`).join('')}</ol></div>` : ''}
    ${secs.map(s => `<div class="section adv-sec" data-dom="${s.dom}"><div class="section-title"><span class="smallcaps">${esc(s.title)}</span></div>
      ${s.items.map(x => `<div class="adv-it adv-${x.level}"><span class="adv-mark" title="${MARK[x.level][1]}">${glyph(MARK[x.level][0])}</span>
        <div><div>${esc(x.text)}</div>${x.tip ? `<div class="note">${esc(x.tip)}</div>` : ''}</div></div>`).join('')}</div>`).join('')}
    ${t?.explanation ? `<div class="coach inset info"><div class="who smallcaps">Комментарий тренера к нормам</div><p style="margin:0">${esc(t.explanation)}</p>
      ${t.tips?.length ? `<ul>${t.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    <p class="note">Это наблюдения по твоим записям, а не диагноз. Чем полнее они, тем точнее советы.</p>`;
}

export const routes = { advice: () => viewAdvice() };
