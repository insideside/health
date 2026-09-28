// «Здоровье iPhone»: как подключить своё «Здоровье» к своему аккаунту через «Команды» iOS.
// PWA не видит HealthKit — данные приносит команда на телефоне. Текст встроен сюда, чтобы
// инструкция открывалась и без связи с сервером. Полная версия — docs/HEALTH-SHORTCUT.md.
import * as store from '../store.js';
import { S, esc, toast, shortDate } from '../ui.js';

let token = null, tokenError = null;

async function loadToken(rotate = false) {
  try {
    const r = await store.api('/api/health/token', rotate ? {} : undefined);
    token = r.token; tokenError = null;
  } catch (e) {
    tokenError = e.status === 0 ? 'Нет связи с сервером - токен покажется, когда он будет доступен.' : e.message;
  }
}

function lastImport() {
  const uid = store.uid();
  let last = null;
  for (const kind of ['activity', 'log', 'sleep', 'body']) {
    for (const r of store.list(kind, uid)) {
      const fromHealth = r.data?.source === 'health' || r.data?.active_kcal !== undefined || r.data?.from_health;
      if (fromHealth && r.date && (!last || r.date > last)) last = r.date;
    }
  }
  return last;
}

const step = (n, title, body) => `<details class="raised card hg-step"><summary><span class="mono hg-n">${n}</span><b>${title}</b></summary><div class="hg-body">${body}</div></details>`;

function view() {
  const url = `${location.origin}/api/health/import`;
  const last = lastImport();
  return `<div class="kicker smallcaps">Профиль · Здоровье iPhone</div>
    <h1>Подключить «Здоровье»</h1>
    <p class="lede">Шаги, сон, вес и тренировки будут сами приходить в ваш аккаунт - без ручного ввода.</p>
    <div class="notice">Подключать или нет - решаете вы. Команда работает только на вашем iPhone и отправляет данные только в ваш аккаунт. Каждый из вас настраивает её на своём телефоне со своим токеном. Отключить - удалить команду или выпустить новый токен.</div>

    <div class="section"><div class="section-title"><span class="smallcaps">Ваш адрес и токен</span>
      ${last ? `<span class="note">последний импорт: ${esc(shortDate(last))}</span>` : '<span class="note">импорта ещё не было</span>'}</div>
      <div class="inset card hg-keys">
        <div class="hg-key"><span class="smallcaps muted">Адрес</span><code class="mono">${esc(url)}</code>
          <button class="btn quiet" data-act="hg-copy" data-v="${esc(url)}">Скопировать</button></div>
        <div class="hg-key"><span class="smallcaps muted">Токен</span>
          ${token ? `<code class="mono">${esc(token)}</code><button class="btn quiet" data-act="hg-copy" data-v="${esc(token)}">Скопировать</button>`
            : `<span class="note">${esc(tokenError || 'Загружаю…')}</span><span></span>`}</div>
      </div>
      <div class="actions"><button class="btn quiet" data-act="hg-rotate">Выпустить новый токен</button>
        <span class="note">старый перестанет работать</span></div>
      <p class="note">Сертификат Тренера должен быть установлен и включён в «Доверии сертификатам» - как для самого приложения (<a class="link" href="#install">как это сделать</a>), иначе команда не достучится до сервера.</p>
    </div>

    <div class="section"><div class="section-title"><span class="smallcaps">Собрать команду «Тренер: Здоровье»</span><span class="note">Команды → «+»</span></div>
      ${step(1, 'Шаги за сегодня', `<ol><li>«Найти образцы Здоровья»: тип <b>Шаги</b>, начальная дата - <b>сегодня</b>, группировать по <b>дню</b>.</li>
        <li>«Вычислить статистику» → <b>Сумма</b>.</li><li>«Задать переменную» <code>steps</code>.</li></ol>`)}
      ${step(2, 'Сон прошлой ночью', `<ol><li>«Найти образцы Здоровья»: тип <b>Анализ сна</b>, за последние <b>1 день</b>, значение <b>Во сне</b>; сортировать по дате начала по возрастанию.</li>
        <li>«Получить сведения об образцах» → <b>Дата начала</b> → «Получить объект из списка» → <b>Первый</b> → «Форматировать дату» (ISO 8601) → переменная <code>bed</code>.</li>
        <li>То же с <b>Датой окончания</b> → <b>Последний</b> → переменная <code>wake</code>.</li></ol>`)}
      ${step(3, 'Вес', `<ol><li>«Найти образцы Здоровья»: тип <b>Вес</b>, сначала новые, ограничение <b>1</b>.</li>
        <li>«Получить сведения» → <b>Значение</b> → переменная <code>weight</code> (в килограммах).</li></ol>`)}
      ${step(4, 'Активные калории', `<ol><li>«Найти образцы Здоровья»: тип <b>Активная энергия</b>, с <b>сегодня</b> → <b>Сумма</b> → переменная <code>active_kcal</code>.</li></ol>`)}
      ${step(5, 'Тренировки с пульсом', `<ol><li>«Найти образцы Здоровья»: тип <b>Тренировки</b>, с <b>сегодня</b>.</li>
        <li>«Повторить с каждым». Внутри:
          <ul><li>«Найти образцы Здоровья»: тип <b>Частота пульса</b>, начальная дата - <b>дата начала</b> тренировки, конечная - <b>дата окончания</b> → «Получить сведения» → <b>Значение</b> → переменная <code>hr</code> (список замеров).</li>
          <li>«Словарь» с ключами: <code>type</code> (тип тренировки), <code>start</code> и <code>end</code> (даты начала и окончания), <code>kcal</code> (активная энергия), <code>distance</code> (дистанция, если есть), <code>heart_rate</code> = переменная <code>hr</code>.</li>
          <li>«Добавить в переменную» <code>workouts</code>.</li></ul></li></ol>
        <p class="note">По пульсу Тренер сам определит интенсивность (лёгкая / средняя / высокая) по зонам для вашего возраста - точнее, чем на глаз.</p>`)}
      ${step(6, 'Пульс в покое и вариабельность (HRV)', `<ol><li>«Найти образцы Здоровья»: тип <b>Пульс в состоянии покоя</b>, сначала новые, ограничение <b>1</b> → «Получить сведения» → <b>Значение</b> → переменная <code>resting_hr</code>.</li>
        <li>То же с типом <b>Вариабельность пульса</b> → переменная <code>hrv</code>.</li></ol>
        <p class="note">Если пульс в покое выше вашего обычного или HRV ниже - это признак недовосстановления: тренер предложит облегчить тренировку. Сравнение - с вашей же нормой за 3 недели, партнёр эти данные не видит.</p>`)}
      ${step(7, 'Цикл (по желанию)', `<p class="small">Если вы ведёте цикл в трекере (Period Tracker, «Календарь месячных», Flo, Clue…), включите в нём синхронизацию с «Здоровьем» - тогда дни попадут сюда.</p>
        <ol><li>«Найти образцы Здоровья»: тип <b>Менструации</b>, за последние <b>90 дней</b>.</li>
        <li>«Повторить с каждым»: «Словарь» с ключами <code>date</code> (дата начала) и <code>flow</code> (значение) → «Добавить в переменную» <code>period</code>.</li></ol>
        <p class="note">Тренер сам найдёт начала циклов и их длину: в первые дни нагрузка мягче, а колебания веса не считаются провалом. Эти данные видите только вы.</p>`)}
      ${step(8, 'Отправка', `<ol><li>«Текущая дата» → «Форматировать дату»: <code>yyyy-MM-dd</code> → переменная <code>date</code>.</li>
        <li>«Получить содержимое URL»: адрес - ваш адрес выше, метод <b>POST</b>, заголовок <code>X-Trainer-Token</code> = ваш токен,
          тело <b>JSON</b>: <code>date</code>, <code>steps</code>, <code>weight</code>, <code>active_kcal</code>, <code>sleep</code> (словарь: <code>bed</code>, <code>wake</code>), <code>workouts</code>, <code>resting_hr</code>, <code>hrv</code>, <code>period</code>.</li>
        <li>По желанию - «Показать уведомление» с ответом: там видно, что записалось.</li></ol>
        <p class="note">Числа можно слать текстом и с запятой, сон - интервалами, тренировки - по-русски или по-английски: сервер разберётся.</p>`)}
    </div>

    <div class="section"><div class="section-title"><span class="smallcaps">Запускать автоматически</span></div>
      <ol class="small"><li>Команды → «Автоматизация» → «+» → «Создать автоматизацию для себя».</li>
        <li><b>Время суток</b>, например 22:30 ежедневно → «Запустить команду» → «Тренер: Здоровье». Выключите «Спрашивать до запуска».</li>
        <li>По желанию - вторая: «Приложение» → «Открыто» → Тренер: данные подтянутся при каждом открытии.</li></ol>
      <p class="note">Запускать можно сколько угодно раз: данные за день перезаписываются, а не множатся.</p>
    </div>

    <div class="section"><div class="section-title"><span class="smallcaps">Что и куда попадает</span></div>
      <table class="hg-table"><tbody>
        <tr><td>Шаги</td><td>отметка «Шаги» в чек-листе дня</td></tr>
        <tr><td>Сон</td><td>журнал сна - только если вы не внесли его вручную</td></tr>
        <tr><td>Вес</td><td>замеры - если за этот день веса ещё нет</td></tr>
        <tr><td>Тренировки</td><td>активности с пометкой «из Здоровья»: время, дистанция, пульс, интенсивность по пульсу</td></tr>
        <tr><td>Пульс в покое, HRV</td><td>показатели дня для «готовности» - только вам</td></tr>
        <tr><td>Цикл</td><td>дни, начала и длина цикла - только вам</td></tr>
        <tr><td>Активные калории</td><td>в отчёты</td></tr>
      </tbody></table>
      <p class="note">Данные супруга, которые он(а) расшарил(а) через «Здоровье → Общий доступ», командам, скорее всего, недоступны - поэтому у каждого своя команда. На компьютере «Здоровье» сторонним программам данные не отдаёт.</p>
    </div>`;
}

export const routes = { health: () => view() };

export const actions = {
  'hg-copy': async el => {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('Скопировано'); }
    catch (e) { toast('Не получилось скопировать - выделите и скопируйте вручную'); }
  },
  'hg-rotate': async el => {
    if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Точно? Старый токен перестанет работать'; return; }
    await loadToken(true);
    toast(tokenError || 'Новый токен выпущен - замените его в команде');
    S.render();
  },
};

export async function afterRender() {
  if (token || tokenError) return;
  await loadToken();
  if (location.hash.startsWith('#health')) S.render();
}
