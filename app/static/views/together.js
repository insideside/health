// «Вместе»: прогресс пары по неделям, со счётом очков - только если оба включили соревнование. #together/{понедельник}
// Данные партнёра — только публичные dsum/wsum (см. coach.js → «соревнование пары»).
// Включается в профиле (profile.compete); если выключено у кого-то из двоих — дружеское приглашение.
import * as store from '../store.js';
import * as C from '../coach.js';
import * as P from '../plan.js';
import { S, esc, num, fmt, WD, profile, toast, plural, todayMark, glyph } from '../ui.js';

const short = d => fmt(d, { day: 'numeric', month: 'short' });
const GRADE = { good: 'хороший', ok: 'средний', bad: 'слабый', none: 'нет данных' };
const ALL_KEYS = C.COMPETE_CATS.map(c => c.key);
const dec1 = v => String(Math.round(v * 10) / 10).replace('.', ',');

function fmtVal(key, v) {
  if (v === null || v === undefined) return '-';
  if (key === 'xp') return `${num(v)}`;
  if (key === 'steps') return num(v);
  if (key === 'activity') return `${num(v)} мин`;
  if (key === 'sleep') return `${dec1(v)} ч`;
  if (key === 'grade') return String(Math.round(v));
  if (key === 'streak') return `${v} дн.`;
  return String(v);
}
function barMax(key, a, b) {
  if (key === 'grade') return 100;
  if (key === 'sleep') return 9;
  return Math.max(Number(a) || 0, Number(b) || 0, 1);
}

// ── включение и настройки (ими пользуется и профиль) ──
export async function setCompete(fields) {
  const uid = store.uid();
  const cur = store.get(`profile:${uid}`)?.data || {};
  const prev = C.competeSettings(uid);
  const compete = { enabled: prev.enabled, score: prev.score, show: prev.show, ...fields };
  if (cur && store.get(`profile:${uid}`)) await store.patch(`profile:${uid}`, { compete });
  else await store.put('profile', `profile:${uid}`, { ...cur, compete });
  await C.refreshCompete();
  S.render();
}

// ════════════ экран ════════════
// «Мой прогресс | Вместе» - вверху «Прогресса» и «Вместе» (только если есть с кем сравнивать)
export function modeSwitch(active) {
  if (!store.partners().length) return '';
  const tab = (k, href, l) => `<a href="${href}" class="${active === k ? 'on' : ''}" ${active === k ? 'aria-current="page"' : ''}>${l}</a>`;
  return `<nav class="a-tabs pg-mode" aria-label="Чей прогресс">${tab('me', '#progress', 'Мой прогресс')}${tab('together', '#together', 'Вместе')}${tab('feed', '#feed', 'Лента')}</nav>`;
}
// людей несколько (группа) - выбор, с кем сравнивать; экран один на двоих, так что сравнение всегда попарное
function whoPicker() {
  const ps = store.partners();
  if (ps.length < 2) return '';
  const cur = C.partner()?.id;
  return `<div class="t-who"><span class="smallcaps muted">Сравнить с</span><div class="chips">${ps.map(p => `<button type="button" class="chip ${p.id === cur ? 'on' : ''}" aria-pressed="${p.id === cur}" data-act="together-pick" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div></div>`;
}

function viewTogether(arg) {
  return modeSwitch('together') + whoPicker() + togetherBody(arg);
}
function togetherBody(arg) {
  const mon = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? C.mondayOf(arg) : C.mondayOf();
  const d = C.duel(mon);
  const p = d.partner;
  if (d.state === 'no_partner') {
    return `<div class="kicker smallcaps">Вместе</div><h1>Прогресс вместе</h1>
      <p class="lede">Здесь будет прогресс партнёра рядом с вашим: дни недели, шаги, тренировки, сон, задания и серия на двоих.</p>
      <p class="note">Второй аккаунт на этом сервере пока не создан. Когда партнёр зарегистрируется, раздел оживёт сам.</p>`;
  }
  const name = esc(p.name);
  if (d.state === 'me_off') {
    return `<div class="kicker smallcaps">Вместе · ${name}</div><h1>Обмен прогрессом выключен</h1>
      <p class="lede">Включите, чтобы видеть прогресс друг друга за неделю - шаги, тренировки, сон, опыт, серия - и делать совместные задания. Счёт очков - отдельно и только по желанию. Партнёр: ${name}.</p>
      <p class="note">Это по желанию. Партнёр увидит только то, что вы разрешите в профиле. Никогда не передаются: питание, вес и замеры, самочувствие, цикл, курение и алкоголь, добавки.
        ${C.partnerCompete(p.id).enabled ? `<br>${name} уже делится прогрессом и ждёт вас.` : ''}</p>
      <div class="actions"><button class="btn solid" data-act="together-enable">Делиться прогрессом</button>
        <a class="btn quiet" href="#profile" data-act="together-settings">Что показывать</a></div>
      ${raceBlock(d, false)}`;
  }
  if (d.state === 'partner_off') {
    return `<div class="kicker smallcaps">Вместе · ${name}</div><h1>${name} пока не делится прогрессом</h1>
      <p class="lede">Обмен прогрессом включён только у вас. Как только ${name} включит его в профиле, здесь появятся цифры за неделю.</p>
      <p class="note">Подскажите: «Профиль → Прогресс вместе».</p>
      ${raceBlock(d, false)}
      <div class="actions"><a class="btn quiet" href="#profile" data-act="together-settings">Настройки</a></div>`;
  }

  const who = C.TONE_NAMES[profile().tone || 'coach'];
  const line = C.duelLine(d);
  const prev = C.addDays(mon, -7), next = C.addDays(mon, 7);
  const lead = d.score.me > d.score.them ? 'me' : d.score.me < d.score.them ? 'them' : '';
  const title = d.scoring
    ? `<h1 class="t-title"><span class="ell">Вы</span> <b class="mono t-score"><i class="${lead === 'me' ? 'lead' : ''}">${d.score.me}</i>:<i class="${lead === 'them' ? 'lead' : ''}">${d.score.them}</i></b> <span class="ell">${name}</span></h1>`
    : `<h1 class="t-title"><span class="ell">Вы и ${name}</span></h1>`;
  // соревнование включено только у одного - подсказка, почему счёта нет
  const half = d.myScore !== d.theirScore
    ? `<p class="note">${d.myScore ? `Соревнование со счётом включено только у вас - счёт появится, когда ${name} тоже его включит.` : `${name} хочет соревноваться со счётом - включите «Соревнование» в профиле, если хотите тоже.`}</p>` : '';
  return `<div class="head-row"><div><div class="kicker smallcaps">Вместе · ${esc(short(mon))} - ${esc(short(C.addDays(mon, 6)))}</div>
      ${title}</div>
    <div class="datenav"><a class="btn quiet" href="#together/${prev}" aria-label="Прошлая неделя">←</a>
      ${!d.current ? `<a class="btn" href="#together">Эта неделя</a><a class="btn quiet" href="#together/${next}" aria-label="Следующая неделя">→</a>` : `${todayMark('Эта неделя')}<span class="btn quiet is-off" aria-disabled="true">→</span>`}</div></div>
    ${half}
    ${cheerNotice(p)}
    ${line ? `<div class="coach inset ${lead === 'me' ? 'praise' : lead === 'them' ? 'scold' : 'info'}"><div class="who smallcaps">${esc(who)}</div><q>${esc(line)}</q></div>` : ''}
    ${boardBlock(d)}
    ${raceBlock(d, true)}
    ${challengesBlock(mon)}
    ${d.current ? cheerBlock(p) : ''}
    ${historyBlock(p)}`;
}

// смысловой цвет категории (accents.css): точка у названия, полоски остаются «вы / партнёр»
const CAT_DOM = { xp: 'goal', steps: 'move', workouts: 'train', activity: 'move', sleep: 'sleep', grade: 'coach', streak: 'goal' };
function boardBlock(d) {
  if (!d.cats.length) return `<p class="note">Вы с партнёром не выбрали ни одной общей категории - настройте в профиле, что показывать.</p>`;
  const rows = d.cats.map(c => {
    const mx = barMax(c.key, c.me, c.them);
    const w = v => Math.round(Math.max(0, Math.min(1, (Number(v) || 0) / mx)) * 100);
    const mark = side => c.win === 'tie' ? '<span class="t-mark tie" title="ничья">=</span>'
      : c.win === side ? '<span class="t-mark" title="победа в категории">●</span>' : '';
    const cell = (side, v) => `<div class="t-side ${side}"><div class="t-v"><b class="mono ell">${esc(fmtVal(c.key, v))}</b>${mark(side)}</div>
        <div class="groove"><div class="fill" style="width:${w(v)}%"></div></div></div>`;
    return `<div class="t-row ${c.win ? 'w-' + c.win : 'w-none'}"${CAT_DOM[c.key] ? ` data-dom="${CAT_DOM[c.key]}"` : ''}><span class="smallcaps t-cat ell">${esc(c.label)}</span>${cell('me', c.me)}${cell('them', c.them)}</div>`;
  }).join('');
  return `<div class="section"><div class="section-title"><span class="smallcaps">${d.scoring ? 'Счёт по категориям' : 'Прогресс по категориям'}</span>${d.scoring ? '<span class="note">победа в категории - очко</span>' : '<span class="note">за эту неделю</span>'}</div>
    <div class="t-board"><div class="t-row t-head"><span></span><span class="smallcaps ell">Вы</span><span class="smallcaps ell">${esc(d.partner.name)}</span></div>${rows}</div>
    ${d.shared.includes('sleep') ? '<p class="note t-foot">Сон: среднее за ночь, больше 9 ч не засчитывается; нужно хотя бы 3 записанные ночи.</p>' : ''}</div>`;
}

function raceBlock(d, full) {
  const pn = esc(d.partner.name);
  const bar = (g, cls) => {
    const h = g.score != null ? Math.max(8, Math.round(g.score)) : g.grade !== 'none' ? 30 : 0;
    return `<i class="t-bar ${cls} g-${g.grade}" style="height:${h}%" title="${esc(GRADE[g.grade] || '')}${g.score != null ? ` · ${Math.round(g.score)}` : ''}"></i>`;
  };
  return `<div class="section"><div class="section-title"><span class="smallcaps">Гонка по дням</span>
      <span class="note t-legend"><span class="t-key me"></span>вы <span class="t-key them"></span>${pn}</span></div>
    <div class="t-race inset">${d.days.map((x, i) => `<div class="t-col ${x.today ? 'today' : ''} ${x.future ? 'future' : ''}">
        <div class="t-bars">${bar(x.me, 'me')}${bar(x.them, 'them')}</div>
        <span class="smallcaps">${WD[i]}</span></div>`).join('')}</div>
    <p class="note t-foot">В каждом дне левый столбик - вы, правый - ${pn} (полоска сверху того же цвета, что в подписи). Высота - оценка дня из 100, цвет - хороший, средний или слабый день.${full ? '' : ' Оценки дня видны партнёру и без соревнования.'}</p></div>`;
}

function challengesBlock(mon) {
  const cs = C.challenges(mon);
  if (!cs.length) return '';
  const isCur = mon === C.mondayOf();
  return `<div class="section"><div class="section-title"><span class="smallcaps">Задания на двоих</span><span class="note">${isCur ? 'новые - каждый понедельник' : 'итог недели'}</span></div>
    <div class="t-ch">${cs.map(c => `<div class="t-chi ${c.done ? 'done' : ''}">
        <div class="t-chi-h"><b class="ell">${esc(c.title)}</b>${c.done ? '<span class="chip">выполнено</span>' : ''}</div>
        <div class="groove"><div class="fill" style="width:${Math.round(c.frac * 100)}%"></div></div>
        <span class="mono note">${num(c.have)} из ${num(c.target)}</span></div>`).join('')}</div></div>`;
}

function historyBlock(p) {
  const h = C.duelHistory(8);
  const js = C.jointStreak(p.id);
  const ach = C.coupleAchievements();
  const played = h.weeks.filter(w => w.result);
  const initial = s => esc((s || '?').trim()[0] || '?');
  return `<div class="section"><div class="section-title"><span class="smallcaps">${C.duel().scoring ? 'История · 8 недель' : 'Вместе'}</span></div>
    ${!played.length && !C.duel().scoring ? '' : played.length ? `<div class="t-tally"><span><span class="smallcaps muted">Вы</span> <b class="mono">${h.me}</b></span>
        <span><span class="smallcaps muted ell">${esc(p.name)}</span> <b class="mono">${h.them}</b></span>
        <span><span class="smallcaps muted">ничьих</span> <b class="mono">${h.draw}</b></span></div>
      <div class="t-weeks">${[...h.weeks].reverse().map(w => `<a class="t-wk ${w.result ? 'r-' + w.result : 'r-none'}" href="#together/${w.monday}" title="${esc(short(w.monday))}${w.score ? ` · ${w.score.me}:${w.score.them}` : ''}">
          <span class="mono">${w.result === 'me' ? 'В' : w.result === 'them' ? initial(p.name) : w.result === 'draw' ? '=' : '·'}</span></a>`).join('')}</div>`
      : '<p class="note">Прошлых недель с данными пока нет - история появится с понедельника.</p>'}
    <p class="t-joint"><span class="smallcaps muted">Совместная серия</span> <b class="mono">${js.current}</b> ${plural(js.current, 'день', 'дня', 'дней')}
      <span class="note">· рекорд ${js.best} · оба на «хорошо» или оба ≥ ${C.STREAK_MIN} % чек-листа</span></p>
    ${ach.length ? `<div class="chips t-ach">${ach.slice(0, 12).map(a => `<span class="chip" title="${esc(short(a.data.monday || a.date || C.today()))}">${esc(a.data.title || a.data.code)}</span>`).join('')}</div>` : ''}</div>`;
}

// метка у своей фразы: партнёр нажал «Спасибо» (людей несколько - с именами)
function thx(mine) {
  const who = C.cheerThanks(mine);
  if (!who.length) return '';
  return ` <span class="chip t-thx">спасибо${store.partners().length > 1 ? ` от ${esc(who.join(', '))}` : ''}</span>`;
}
// ── «Подбодрить» ──
function cheerBlock(p) {
  const tone = profile().tone || 'coach';
  const presets = C.CHEERS[tone] || C.CHEERS.coach;
  const mine = C.myCheer();
  const text = S.forms.cheer?.text ?? '';
  return `<div class="section"><div class="section-title"><span class="smallcaps">Подбодрить</span><span class="note ell">${esc(p.name)} увидит на экране «Сегодня»</span></div>
    <div class="chips t-presets">${presets.map((t, i) => `<button type="button" class="chip" data-act="cheer-preset" data-i="${i}">${esc(t)}</button>`).join('')}</div>
    <div class="t-cheer"><input class="control" id="cheer-text" data-form="cheer" data-key="text" maxlength="80" placeholder="Своими словами, до 80 знаков" value="${esc(text)}" aria-label="Текст">
      <button class="btn solid" data-act="cheer-send">Подбодрить</button></div>
    ${mine ? `<p class="note">Последнее: «${esc(mine.text)}» · ${esc(new Date(mine.at).toLocaleString('ru', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}${thx(mine)}</p>` : ''}</div>`;
}

// полученная фраза партнёра (здесь и на «Сегодня»)
export function cheerNotice(p = C.partner()) {
  if (!p) return '';
  const c = C.unseenCheer(p.id);
  if (!c) return '';
  // несколько фраз одного человека до «Спасибо» - одним блоком, каждая со временем
  const at = t => new Date(t).toLocaleString('ru', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const body = c.list.length > 1
    ? `<ul class="t-cheer-list">${c.list.map(x => `<li>«${esc(x.text)}» <span class="note mono">${esc(at(x.at))}</span></li>`).join('')}</ul>`
    : ` «${esc(c.text)}»`;
  return `<div class="notice t-cheer-in"><span class="t-cheer-txt"><span class="smallcaps">${esc(p.name)} подбадривает:</span>${body}</span>
    <button class="btn quiet" data-act="cheer-seen" data-pid="${esc(p.id)}" title="${esc(p.name)} увидит, что вы сказали спасибо">Спасибо</button></div>`;
}
// все непрочитанные фразы (от каждого, с кем виден прогресс) - на «Сегодня» отдельным блоком под тренером
export function cheersBlock() {
  return C.unseenCheers().map(({ p }) => cheerNotice(p)).join('');
}

// ── раздел профиля «Соревнование с партнёром» (сохраняется сразу, без кнопки «Сохранить») ──
const SHOW_HINT = { xp: 'опыт за день', steps: 'шаги', workouts: 'сделанные тренировки', activity: 'минуты движения', sleep: 'часы сна',
  grade: 'оценка недели', streak: 'серия дней' };
export function competeSummary() {
  const cp = C.competeSettings();
  return cp.enabled ? `включено · ${cp.show.length} из ${ALL_KEYS.length} категорий${cp.score ? ' · со счётом' : ''}` : 'выключено';
}
export function competeBody() {
  const cp = C.competeSettings();
  const p = C.partner();
  const pc = p ? C.partnerCompete(p.id) : null;
  return `<div class="pf-compete">
    <div><label class="chk pf-chk"><input type="checkbox" data-act="pf-compete" ${cp.enabled ? 'checked' : ''}>Делиться прогрессом с партнёром</label></div>
    <div class="pf-sub"><label class="chk pf-chk"><input type="checkbox" data-act="pf-compete-score" ${cp.score ? 'checked' : ''} ${cp.enabled ? '' : 'disabled'}>Соревнование: считать очки и победы в неделе</label></div>
    <p class="note">${p ? `${esc(p.name)}: прогресс ${pc.enabled ? 'виден' : 'пока не виден'}${pc.enabled ? `, соревнование ${pc.score ? 'включено' : 'выключено'}` : ''}. Без соревнования видно только, как у кого идут дела, без очков и победителей; счёт недели появится, когда соревнование включат оба.` : 'Партнёра на сервере пока нет.'}
      Партнёр увидит только выбранное ниже. Никогда не передаются: питание, вес и замеры, самочувствие, цикл, курение и алкоголь, добавки.</p>
    <div class="field"><span class="smallcaps">Что показывать</span>
      <div class="chips">${C.COMPETE_CATS.map(c => `<button type="button" class="chip ${cp.show.includes(c.key) ? 'on' : ''}" data-act="pf-compete-show" data-k="${c.key}" title="${esc(SHOW_HINT[c.key])}">${esc(c.label)}</button>`).join('')}</div></div>
    <p class="note">Выключение сразу убирает шаги, сон и активность из ваших сводок за последние 8 недель. Оценка дня и опыт видны партнёру всегда.</p>
    <div class="field pf-share"><span class="smallcaps">Показывать в ленте</span>
      <label class="chk pf-chk"><input type="checkbox" data-form="profile" data-key="share_activity" ${(S.forms.profile?.share_activity ?? profile().share_activity) !== false ? 'checked' : ''}>мои тренировки, комплексы и активности</label>
      <p class="note">В ленту «Вместе» уходит только название и минуты (например, «Комплекс «Осанка» · 10 мин», «Велосипед · 40 мин») - без упражнений, еды и подробностей. Личное (массаж, баня, медитация, занятия с детьми) не уходит никогда. Изменение сохранится кнопкой «Сохранить» внизу профиля.</p></div>
    ${pairBody(p)}
    <div class="actions"><a class="link" href="#together">Открыть «Вместе» →</a> <a class="link" href="#feed">Лента →</a></div></div>`;
}

// «Общие комплексы»: что каждый согласен делать одинаково с партнёром (зал - нет, там у каждого своя программа)
function pairBody(p) {
  if (!p) return '';
  const mine = P.pairChosen(), theirs = P.partnerChosen(p.id);
  const title = m => P.MODULES[m]?.title || m;
  const both = mine.filter(m => theirs.includes(m));
  const waitThem = mine.filter(m => !theirs.includes(m)), waitMe = theirs.filter(m => !mine.includes(m));
  const nm = esc(p.name), ins = esc(C.nameForms?.(p.id)?.ins || p.name), marked = p.sex === 'f' ? 'отметила' : 'отметил';
  return `<div class="field pf-pair"><span class="smallcaps">Общие комплексы</span>
      <p class="note">Отметьте, что готовы делать вместе с ${ins}. Комплекс станет общим, когда его отметите оба: у вас будет один и тот же набор упражнений, а замена или пересборка у одного сразу появится у другого (с пометкой, кто и что поменял). Упражнения из вашего «не предлагать» заменятся похожими. Зал не участвует - там у каждого своя программа.</p>
      <div class="chips">${P.PAIR_MODULES.map(m => `<button type="button" class="chip ${mine.includes(m) ? 'on' : ''}" aria-pressed="${mine.includes(m)}" data-act="pf-pair-mod" data-m="${m}">${esc(title(m))}${theirs.includes(m) ? ` <span class="pf-pair-ok" title="${nm} тоже ${marked}">${nm[0] || ''}</span>` : ''}</button>`).join('')}</div>
      <p class="note">${both.length ? `Общие сейчас: ${esc(both.map(title).join(', '))}.` : 'Общих комплексов пока нет.'}
        ${waitThem.length ? ` Ждёт согласия ${esc(C.nameForms?.(p.id)?.gen || p.name)}: ${esc(waitThem.map(title).join(', '))}.` : ''}
        ${waitMe.length ? ` ${nm} предлагает делать вместе: ${esc(waitMe.map(title).join(', '))} - отметьте, если согласны.` : ''}
        Буква на кнопке - ${nm} тоже ${marked}.</p></div>`;
}

export const changes = {
  'pf-compete': async el => {
    await setCompete({ enabled: el.checked });
    toast(el.checked ? 'Прогресс виден партнёру' : 'Обмен прогрессом выключен');
  },
  'pf-compete-score': async el => {
    await setCompete({ score: el.checked });
    toast(el.checked ? 'Соревнование включено: счёт появится, когда включат оба' : 'Счёт очков выключен');
  },
};

// ════════════ лента: что делали вы и те, с кем вы делитесь прогрессом ════════════
const FEED_STEP = 14;
const HL_TITLE = { workout: 'Тренировка', gym: 'Зал', complex: 'Комплекс', activity: '' };
const HL_DOM = { workout: 'train', gym: 'train', complex: 'train', activity: 'move' };
const ago = d => d === C.today() ? 'Сегодня' : d === C.addDays(C.today(), -1) ? 'Вчера' : fmt(d, { weekday: 'long', day: 'numeric', month: 'long' });
const hm = at => at ? new Date(at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '';
function feedCard(x) {
  const who = x.who, ini = esc((who.me ? (profile().name || 'Вы') : who.name || '?').trim()[0] || '?');
  let body, dom;
  if (x.kind === 'hl') {
    const t = HL_TITLE[x.type] ?? '';
    body = `${t ? `${t} ` : ''}${t ? `«${esc(x.label || '')}»` : `<b>${esc(x.label || 'Активность')}</b>`}${x.minutes ? ` <span class="mono">· ${num(x.minutes)} мин</span>` : ''}`;
    dom = HL_DOM[x.type] || 'move';
  } else if (x.kind === 'ach') {
    body = `Достижение <b>«${esc(x.title)}»</b>${x.couple ? ' <span class="note">на двоих</span>' : ''}`;
    dom = 'goal';
  } else {
    body = x.grade === 'good' ? `Хороший день <span class="mono">· ${x.pct} %</span> чек-листа` : `День закрыт на <span class="mono">${x.pct} %</span>`;
    dom = 'coach';
  }
  return `<article class="raised fd-card" data-dom="${dom}"><span class="fd-ava ${who.me ? 'me' : ''}" aria-hidden="true">${ini}</span>
    <div class="fd-main"><div class="fd-who"><b class="ell">${esc(who.me ? 'Вы' : who.name)}</b>${x.kind === 'hl' ? `<span class="note mono">${esc(hm(x.at))}</span>` : ''}</div>
      <div class="fd-body">${body}</div></div>
    ${who.me ? `<button type="button" class="btn quiet a-mini fd-del" data-act="feed-del" data-kind="${x.kind}" data-key="${esc(x.key)}" aria-label="Убрать из ленты" title="${x.kind === 'hl' ? 'Убрать из ленты' : 'Скрыть из ленты (в вашей статистике останется)'}">${glyph('cross')}</button>` : ''}</article>`;
}
function viewFeed() {
  if (!store.partners().length) return `<div class="kicker smallcaps">Лента</div><h1>Лента</h1>
    <p class="lede">Здесь будут тренировки, комплексы, активности, достижения и хорошие дни - ваши и тех, с кем вы делитесь прогрессом.</p>
    <p class="note">Пока на сервере нет никого, с кем вы делитесь прогрессом.</p>`;
  const f = S.forms.feed ||= { days: FEED_STEP, who: null };
  const ps = [{ id: store.uid(), name: 'Вы' }, ...store.partners()];
  const items = C.feed(f.days, f.who);
  const byDay = [];
  for (const x of items) { const last = byDay[byDay.length - 1]; if (last?.date === x.date) last.items.push(x); else byDay.push({ date: x.date, items: [x] }); }
  return `${modeSwitch('feed')}<div class="kicker smallcaps">Вместе</div><h1>Лента</h1>
    <p class="note a-tight">Видно только то, чем каждый делится: тренировки, комплексы, активности, достижения и хорошие дни - без еды, веса и подробностей.</p>
    <div class="t-who"><div class="chips">
      <button type="button" class="chip ${!f.who ? 'on' : ''}" aria-pressed="${!f.who}" data-act="feed-who" data-id="">Все</button>
      ${ps.map(p => `<button type="button" class="chip ${f.who === p.id ? 'on' : ''}" aria-pressed="${f.who === p.id}" data-act="feed-who" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div></div>
    ${byDay.length ? byDay.map(g => `<div class="fd-day smallcaps muted">${esc(ago(g.date))}</div><div class="fd-list">${g.items.map(feedCard).join('')}</div>`).join('')
      : `<p class="empty">За ${f.days} дней пока пусто. Вехи появляются, когда кто-то закрывает тренировку, комплекс, записывает активность или получает достижение.</p>`}
    ${f.days < 120 ? `<div class="actions"><button class="btn quiet" data-act="feed-more">Показать раньше</button><span class="note">сейчас - за ${f.days} дней</span></div>` : ''}`;
}

export const routes = { together: arg => viewTogether(arg), feed: () => viewFeed() };

export const confirms = {
  'feed-del': el => ({ title: 'Убрать карточку из ленты?', ok: 'Убрать', text: el.dataset.kind === 'hl' ? 'Карточка пропадёт из ленты у всех.' : 'Карточка скроется из ленты у всех, в вашей статистике она останется.' }),
};

export const actions = {
  'together-enable': async () => {
    await setCompete({ enabled: true });
    toast('Прогресс виден партнёру');
  },
  'together-settings': () => { location.hash = '#profile'; setTimeout(() => document.getElementById('sec-compete')?.setAttribute('open', ''), 60); },
  'cheer-preset': el => {
    const tone = profile().tone || 'coach';
    const t = (C.CHEERS[tone] || C.CHEERS.coach)[Number(el.dataset.i)] || '';
    (S.forms.cheer ||= {}).text = t;
    const inp = document.getElementById('cheer-text');
    if (inp) inp.value = t;
  },
  'cheer-send': async () => {
    const inp = document.getElementById('cheer-text');
    const text = (inp?.value ?? S.forms.cheer?.text ?? '').trim();
    if (!text) return toast('Выберите фразу или напишите свою');
    const ok = await C.sendCheer(text);
    if (!ok) return toast('Сначала включите обмен прогрессом');
    delete S.forms.cheer;
    toast(`${C.partner()?.name || 'Партнёр'} увидит это при следующем открытии`);
    S.render();
  },
  'cheer-seen': async el => { await C.markCheerSeen(el.dataset.pid || undefined); S.render(); },
  'feed-who': el => { (S.forms.feed ||= { days: FEED_STEP }).who = el.dataset.id || null; S.render(); },
  'feed-del': async el => {
    await C.hideFeedItem({ kind: el.dataset.kind, key: el.dataset.key });
    toast(el.dataset.kind === 'hl' ? 'Убрано из ленты' : 'Скрыто из ленты - в вашей статистике осталось');
    S.render();
  },
  'feed-more': () => { const f = (S.forms.feed ||= { days: FEED_STEP, who: null }); f.days = Math.min(120, f.days + FEED_STEP); S.render(); },
  'together-pick': async el => { await store.setMeta('together_pid', el.dataset.id); S.render(); },
  'pf-pair-mod': async el => {
    const uid = store.uid(), m = el.dataset.m, cur = P.pairChosen(uid);
    const modules = cur.includes(m) ? cur.filter(x => x !== m) : P.PAIR_MODULES.filter(x => cur.includes(x) || x === m);
    const pid = `profile:${uid}`, prof = store.get(pid)?.data || {}, pair = { ...(prof.pair || {}), modules };
    if (store.get(pid)) await store.patch(pid, { pair }); else await store.put('profile', pid, { ...prof, pair });
    await P.publishConsent(uid);
    await P.pairSyncAll(C.today(), uid);
    const pa = C.partner(), on = modules.includes(m), title = P.MODULES[m]?.title || m;
    const f = pa ? (C.nameForms?.(pa.id) || {}) : {};
    toast(!on ? `«${title}» - снова только ваш` : pa && P.partnerChosen(pa.id).includes(m) ? `«${title}» теперь общий с ${f.ins || pa.name}` : `«${title}»: ждём согласия ${f.gen || pa?.name || 'партнёра'}`);
    S.render();
  },
  'pf-compete-show': async el => {
    const k = el.dataset.k, cur = C.competeSettings().show;
    const show = cur.includes(k) ? cur.filter(x => x !== k) : ALL_KEYS.filter(x => cur.includes(x) || x === k);
    await setCompete({ show });
  },
};

// раз в цикл опроса: совместные достижения за выполненные задания
let awarding = false;
export async function background() {
  if (awarding || !store.uid()) return;
  awarding = true;
  try {
    const fresh = await C.awardCouple();
    fresh.forEach((a, i) => setTimeout(() => toast(`Достижение: ${a.title}`, 3500), i * 3600));
  } finally { awarding = false; }
}
export const afterRender = () => { background(); };
