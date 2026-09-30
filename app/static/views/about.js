// «Как это работает»: честно о том, что считается на устройстве, а что — только с сервером и ИИ.
// Короткая версия docs/HOW-IT-WORKS.md; открывается и без сети.
import * as store from '../store.js';
import { S, esc, fmt, toast } from '../ui.js';

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
    ${updateSection(online)}`;
}

export const routes = { about: () => view() };
export const actions = {
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
