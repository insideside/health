// «Как это работает»: честно о том, что считается на устройстве, а что — только с сервером и ИИ.
// Короткая версия docs/HOW-IT-WORKS.md; открывается и без сети.
import * as store from '../store.js';
import { S, esc, fmt, plural, toast } from '../ui.js';

// ── версия и обновление из GitHub (сервер делает git pull, доустанавливает библиотеки и перезапускается) ──
const UP = { st: null, busy: false, err: null };
function updateSection(online) {
  const st = UP.st, cur = st?.current;
  const when = d => (d ? fmt(d.slice(0, 10), { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  let body;
  if (!online) body = '<p class="note">Проверить обновления можно, когда сервер на связи.</p>';
  else if (UP.err) body = `<div class="notice err">${esc(UP.err)}</div>`;
  else if (!st) body = '<p class="note">Новые версии публикуются на GitHub. Проверка займёт пару секунд.</p>';
  else if (!st.available) body = `<div class="notice">${esc(st.reason)}</div>`;
  else if (st.offline) body = `<div class="notice">${esc(st.offline)}</div>`;
  else if (!st.behind) body = '<p class="small">Установлена последняя версия.</p>';
  else body = `<p class="small"><b>Доступно обновление</b>: ${st.behind} ${st.behind === 1 ? 'изменение' : st.behind < 5 ? 'изменения' : 'изменений'}${st.dependencies_changed ? ', обновятся и библиотеки' : ''}.</p>
    <ul class="small up-list">${st.commits.slice(0, 12).map(c => `<li>${esc(c.subject)} <span class="note">${esc(when(c.date))}</span></li>`).join('')}</ul>
    ${st.dirty?.length ? `<div class="notice">В папке приложения изменены файлы (${esc(st.dirty.slice(0, 4).join(', '))}) - обновление их перезаписало бы. Сохраните их отдельно.</div>` : ''}
    <p class="note">Сервер обновится и перезапустится примерно за минуту. Данные не затрагиваются. Телефоны и планшеты поставят новую версию сами, когда будет удобно. Обновляет владелец или человек у самого компьютера.</p>`;
  const canApply = online && st?.available && st.behind > 0 && !st.offline && !st.dirty?.length;
  return `<div class="section"><div class="section-title"><span class="smallcaps">Версия и обновления</span>
      <span class="note">${cur?.hash ? `версия <span class="mono">${esc(cur.hash)}</span>${cur.date ? ` от ${esc(when(cur.date))}` : ''}` : ''}</span></div>
    ${body}
    <div class="actions"><button class="btn" data-act="up-check" ${online && !UP.busy ? '' : 'disabled'}>${UP.busy === 'check' ? 'Проверяю…' : 'Проверить обновления'}</button>
      ${canApply ? `<button class="btn solid" data-act="up-apply" ${UP.busy ? 'disabled' : ''}>${UP.busy === 'apply' ? 'Обновляю…' : 'Обновить'}</button>` : ''}</div></div>`;
}

// ── состояние сервера: резервные копии и внешние источники (app/backup.py, app/monitor.py) ──
// Данные - с сервера при открытии экрана; без сети - «нет связи». serverAlerts() - короткий текст проблем для шапки.
const OPS = { backup: null, monitor: null, err: null, at: 0, loading: false, busy: null };
const OPS_TTL = 30_000, ALERT_TTL = 10 * 60_000;

async function loadOps(force) {
  if (OPS.loading || !store.state.online || !store.me()) return;
  if (!force && Date.now() - OPS.at < (OPS.backup || OPS.err ? OPS_TTL : 0)) return;
  OPS.loading = true; OPS.at = Date.now();
  const before = alertText();
  try {
    const [b, m] = await Promise.all([store.api('/api/backup/status'), store.api('/api/monitor')]);
    OPS.backup = b; OPS.monitor = m; OPS.err = null;
  } catch (e) { OPS.err = e.status === 404 ? 'Сервер старой версии - состояние появится после обновления' : e.status === 0 ? 'нет связи' : e.message; }
  OPS.loading = false;
  if (location.hash.startsWith('#about') || alertText() !== before) S.render();
}

// «сегодня в 03:05», «вчера в 03:05», «29 сентября в 03:05»
function when(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(d)) / 86400_000);
  if (diff === 0) return `сегодня в ${hm}`;
  if (diff === 1) return `вчера в ${hm}`;
  return `${new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(d)} в ${hm}`;
}
const size = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const LEVEL = { ok: 'работает', warn: 'с перебоями', error: 'не работает', off: 'выключено', unknown: 'не проверялся' };

function alertText() {
  const out = [], b = OPS.backup, m = OPS.monitor;
  if (b?.problem) out.push(b.last_error?.at > (b.last_ok?.at || 0) ? 'резервная копия не удалась' : 'давно нет резервной копии');
  if (b?.mirror && !b.mirror.ok) out.push('копия во вторую папку не дошла');
  const bad = (m?.sources || []).filter(x => x.status === 'error').map(x => x.name);
  if (bad.length) out.push(`не работает: ${bad.join(', ')}`);
  return out.join('; ');
}

// Краткий текст проблем сервера (для шапки или меню) или ''. Сам раз в 10 минут подтягивает статус с сервера.
export function serverAlerts() {
  if (Date.now() - OPS.at > ALERT_TTL) loadOps(true);
  const t = alertText();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function backupBlock() {
  const b = OPS.backup;
  if (!b) return '';
  const ok = b.last_ok, err = b.last_error;
  const failedLast = err && err.at > (ok?.at || 0);
  const lines = [];
  if (ok) lines.push(`<p class="small"><span class="ops-dot ${Date.now() / 1000 - ok.at > 2 * 86400 ? 'error' : failedLast ? 'warn' : 'ok'}"></span><b>Последняя копия</b> ${esc(when(ok.at))}, ${esc(size(ok.size))}${ok.verified ? ', проверена: файл цел, записи на месте' : ''}.</p>`);
  else lines.push('<p class="small"><span class="ops-dot unknown"></span>Резервных копий ещё нет.</p>');
  if (failedLast) lines.push(`<div class="notice ops-err">Копия ${esc(when(err.at))} не удалась: ${esc(err.text)}. Прежние копии целы.</div>`);
  else if (err) lines.push(`<p class="note">Последняя ошибка - ${esc(when(err.at))}: ${esc(err.text)}</p>`);
  lines.push(`<p class="note">Хранится ${b.count} ${plural(b.count, 'копия', 'копии', 'копий')}${b.total_bytes ? `, ${esc(size(b.total_bytes))}` : ''}: каждый день после полуночи, ${b.policy?.daily || 14} последних дней, а также по одной на неделю (${b.policy?.weekly || 8} недель) и на месяц (${b.policy?.monthly || 12} месяцев). Папка data/backups на компьютере.</p>`);
  if (b.mirror_dir) {
    const mr = b.mirror;
    if (!mr) lines.push(`<p class="note">Вторая папка: ${esc(b.mirror_dir)} - копия попадёт туда со следующей.</p>`);
    else if (mr.ok) lines.push(`<p class="note">Дубль во второй папке ${esc(b.mirror_dir)} - ${esc(when(mr.at))}.</p>`);
    else lines.push(`<div class="notice ops-err">${esc(mr.error || 'Вторая папка недоступна')} (${esc(when(mr.at))}). Попробую снова через час.</div>`);
  } else lines.push('<p class="note">Можно дублировать копии во вторую папку (iCloud Drive, внешний диск): строка TRAINER_BACKUP_DIR=путь в settings.env рядом с приложением и перезапуск сервера.</p>');
  const btn = b.can_manage
    ? `<div class="actions"><button class="btn" data-act="ops-backup" ${OPS.busy ? 'disabled' : ''}>${OPS.busy === 'backup' ? 'Делаю копию…' : 'Сделать копию сейчас'}</button></div>`
    : '<p class="note">Сделать копию по кнопке может владелец сервера или человек у самого компьютера.</p>';
  return `<div class="ops-sub smallcaps">Резервные копии</div>${lines.join('')}${btn}`;
}

function sourcesBlock() {
  const m = OPS.monitor;
  if (!m) return '';
  const rows = m.sources.map(x => {
    const tail = [];
    if (x.status === 'ok' && x.ms != null && x.code !== 'github') tail.push(`ответ ${x.ms < 1000 ? `${x.ms} мс` : `${(x.ms / 1000).toFixed(1).replace('.', ',')} с`}`);
    if (x.status !== 'ok' && x.status !== 'off' && x.status !== 'unknown') tail.push(x.last_ok ? `последний раз работало ${when(x.last_ok)}` : 'ни разу не работало при проверках');
    return `<div class="ops-row"><span class="ops-dot ${esc(x.status)}" title="${esc(LEVEL[x.status] || '')}"></span>
      <div class="ops-main"><div class="ops-name"><b>${esc(x.name)}</b> <span class="note">${esc(x.purpose)}</span></div>
        <div class="small ops-msg">${esc(x.message)}</div>${tail.length ? `<div class="note">${esc(tail.join(', '))}</div>` : ''}</div></div>`;
  }).join('');
  return `<div class="ops-sub smallcaps">Внешние источники</div>
    <p class="note">Проверяются сами раз в ${m.every_hours || 6} часов${m.checked_at ? `, последний раз ${esc(when(m.checked_at))}` : ''}. Наружу уходит только слово «молоко», без ваших данных.</p>
    <div class="ops-list">${rows}</div>
    <div class="actions"><button class="btn" data-act="ops-check" ${OPS.busy || m.running ? 'disabled' : ''}>${OPS.busy === 'check' || m.running ? 'Проверяю…' : 'Проверить сейчас'}</button></div>`;
}

function opsSection(online) {
  let body;
  if (!online) body = '<p class="note">Нет связи с сервером - состояние покажется, когда он будет рядом.</p>';
  else if (OPS.err && !OPS.backup) body = `<div class="notice ops-err">${esc(OPS.err === 'нет связи' ? 'Нет связи с сервером.' : OPS.err)}</div>`;
  else if (!OPS.backup) body = '<p class="note">Загружаю…</p>';
  else body = backupBlock() + sourcesBlock();
  const t = online ? alertText() : '';
  return `<div class="section ops"><div class="section-title"><span class="smallcaps">Состояние сервера</span>
      ${online && OPS.backup ? `<span class="note">${t ? 'есть неполадки' : 'всё в порядке'}</span>` : ''}</div>${body}</div>`;
}

const LOCAL = 'на устройстве', PART = 'частично', SERVER = 'нужен сервер';
const ROWS = [
  ['Чек-лист, вода, шаги, сон, самочувствие', LOCAL, 'Всё отмечается без сети и уходит на сервер при подключении.'],
  ['Оценки дня и недели, серии, уровни, календарь', LOCAL, 'Считаются по вашим данным на этом устройстве.'],
  ['Реплики тренера и напоминания', LOCAL, 'Шаблоны на три тона, с вашим именем и в нужном роде.'],
  ['Разминки, шея и осанка, тренировки «на любой случай»', LOCAL, 'Собираются из каталога под время, инвентарь, ограничения и цели.'],
  ['Готовность дня, облегчить или перенести тренировку', LOCAL, 'По сну, самочувствию и нагрузке за неделю.'],
  ['Цели в цифрах и прогресс', LOCAL, 'Прогноз и реалистичность - по статистике для вашего пола и уровня.'],
  ['БЖУ еды из текста', PART, 'Знакомое - по справочнику и памяти тренера без сети; новое разбирает ИИ и запоминает.'],
  ['Рацион на сегодня', PART, 'План - на устройстве; рецепты и уточнения - с ИИ.'],
  ['Нормы калорий и БЖУ', PART, 'Без сети - ориентировочно по формулам; с сервером - точно, со сроками и комментарием.'],
  ['Анализ «что на вас влияет»', PART, 'По вашим данным - на устройстве; сравнение с похожими людьми - с сервером и по согласию.'],
  ['Прогресс вместе и соревнование', PART, 'Ваши цифры видны сразу, цифры партнёра приходят с синхронизацией.'],
  ['Программа тренировок на недели', SERVER, 'Составляет ИИ; готовая программа потом работает и без сети.'],
  ['Чат с тренером, разбор недели, анализ замеров', SERVER, 'Отвечает ИИ. Быстрые кнопки в чате работают и без неё.'],
  ['Поиск БЖУ продукта по названию', SERVER, 'Интернет-справочник + ИИ + проверка «сухое / готовое».'],
  ['Импорт из «Здоровья» iPhone', SERVER, 'Команда на телефоне отправляет на ваш компьютер шаги, сон, вес, тренировки с пульсом, пульс в покое и HRV, дни цикла.'],
  ['Готовность по пульсу в покое и HRV', LOCAL, 'Сравнивается с вашей обычной нормой за 3 недели - прямо на устройстве.'],
  ['Синхронизация между устройствами', SERVER, 'Без связи правки копятся здесь; спорные места приложение покажет.'],
];

function view() {
  const online = store.state.online;
  const cls = m => (m === LOCAL ? 'ab-local' : m === PART ? 'ab-part' : 'ab-server');
  return `<div class="kicker smallcaps">Приложение</div>
    <h1>Как это работает</h1>
    <p class="lede">Всё, что можно посчитать по формулам, справочникам и вашей истории, считается прямо здесь и работает без сети. Сервер на вашем компьютере связывает устройства, а локальная ИИ уточняет и объясняет.</p>
    <div class="notice">${online ? 'Сейчас сервер на связи - доступно всё.' : 'Сейчас сервера нет рядом: работает всё, что помечено «на устройстве» и «частично».'}</div>
    <div class="section"><div class="ab-list">${ROWS.map(([t, m, d]) => `<div class="ab-row"><div class="ab-t">${esc(t)}</div>
      <span class="chip ${cls(m)}">${esc(m)}</span><div class="note ab-d">${esc(d)}</div></div>`).join('')}</div></div>
    <div class="section"><div class="section-title"><span class="smallcaps">Приложение учится</span></div>
      <p class="small">Когда ИИ окончательно что-то выясняет - например, сколько граммов в «кружке какао с зефирками» - это попадает в общую память тренера (только факты о еде, без имён и заметок) и приезжает на все устройства. В следующий раз то же самое считается без ИИ и без сети.</p></div>
    <div class="section"><div class="section-title"><span class="smallcaps">Ваши данные</span></div>
      <p class="small">Данные хранятся на ваших устройствах и на вашем компьютере. Локальная ИИ работает только на этом компьютере. Партнёр видит лишь итоги дня и недели, а цифры соревнования - только если вы оба его включили. Еду, вес, замеры, сон и заметки не видит никто.</p></div>
    ${opsSection(online)}
    ${updateSection(online)}`;
}

export const routes = { about: () => { loadOps(); return view(); } };
export const actions = {
  'ops-backup': async () => {
    OPS.busy = 'backup'; S.render();
    try {
      OPS.backup = await store.api('/api/backup/run', {});
      const e = OPS.backup.last_error, ok = OPS.backup.last_ok;
      toast(e && e.at > (ok?.at || 0) ? 'Копия не удалась - причина на экране' : 'Копия готова и проверена');
    } catch (e) { toast(e.message || 'Не получилось', 5000); }
    OPS.busy = null; S.render();
  },
  'ops-check': async () => {
    OPS.busy = 'check'; S.render();
    try { OPS.monitor = await store.api('/api/monitor/check', {}); } catch (e) { toast(e.message || 'Не получилось', 5000); }
    OPS.busy = null; S.render();
  },
  'up-check': async () => {
    UP.busy = 'check'; UP.err = null; S.render();
    try { UP.st = await store.api('/api/update/check?force=1'); } catch (e) { UP.err = e.status === 404 ? 'Сервер старой версии - обновите его вручную (git pull), дальше можно будет отсюда' : e.message; }
    UP.busy = false; S.render();
  },
  'up-apply': async () => {
    UP.busy = 'apply'; S.render();
    try {
      const r = await store.api('/api/update/apply', {});
      if (r.restarting) { toast('Обновлено - сервер перезапускается. Через минуту в шапке появится метка «обновление».', 7000); UP.st = null; }
      else toast(r.message || 'Уже последняя версия');
    } catch (e) { UP.err = e.message; }
    UP.busy = false; S.render();
  },
};
