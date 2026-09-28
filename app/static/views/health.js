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

// раскрытые шаги не сворачиваются при перерисовке (синхронизация, возврат из «Команд»): помним, какие открыты
const OPEN = new Set((() => { try { return JSON.parse(sessionStorage.getItem('hg-open') || '[]'); } catch (e) { return []; } })());
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('hg-step') || !d.dataset.k) return;
  if (d.open) OPEN.add(d.dataset.k); else OPEN.delete(d.dataset.k);
  try { sessionStorage.setItem('hg-open', JSON.stringify([...OPEN])); } catch (e) { /* приватный режим */ }
}, true);
const step = (k, n, title, body) => `<details class="raised card hg-step" data-k="${k}" ${OPEN.has(k) ? 'open' : ''}><summary><span class="mono hg-n">${n}</span><b>${title}</b></summary><div class="hg-body">${body}</div></details>`;

let shortcutState = null;   // null | 'loading' | {error}

function view() {
  const url = `${location.origin}/api/health/import`;
  const last = lastImport();
  const today = new Date().toISOString().slice(0, 10);
  const ok = last && last >= new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  return `<div class="kicker smallcaps">Профиль · Здоровье iPhone</div>
    <h1>Подключить «Здоровье»</h1>
    <p class="lede">Шаги, сон, вес, активные калории, пульс в покое и HRV будут сами приходить в ваш аккаунт.</p>

    <div class="raised card hg-status ${ok ? 'ok' : ''}">
      <div><b>${last ? (ok ? 'Данные приходят' : 'Данные давно не приходили') : 'Ещё не подключено'}</b>
        <div class="note">${last ? `последний импорт: ${esc(shortDate(last))}${last === today ? ' (сегодня)' : ''}` : 'после настройки здесь появится дата последнего импорта'}</div></div>
      <button class="btn quiet" data-act="hg-check">Проверить</button></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Как это устроено</span></div>
      <div class="hg-flow">
        <div class="inset hg-box"><span class="smallcaps muted">1 · Команда</span><b>«Тренер: Здоровье»</b><span class="note">что сделать: взять данные из «Здоровья» и отправить Тренеру</span></div>
        <div class="hg-arrow" aria-hidden="true">←</div>
        <div class="inset hg-box"><span class="smallcaps muted">2 · Автоматизация</span><b>каждый день в 22:30</b><span class="note">когда: запускает команду сама, без вас</span></div>
      </div>
      <p class="small">Команда и автоматизация - две разные вещи в приложении «Команды». Автоматизация ничего не собирает сама: её единственное действие - <b>«Запустить команду “Тренер: Здоровье”»</b>. Так они и связаны.</p></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Шаг 1. Команда</span><span class="note">один раз на каждом iPhone</span></div>
      <div class="raised card hg-quick">
        <b>Готовая команда - одним нажатием</b>
        <p class="small">Откройте эту страницу на своём iPhone в Safari и нажмите кнопку. Safari скачает команду «Тренер Здоровье» - ваш адрес и токен в ней уже вписаны. Откройте файл (или «Загрузки» → файл) → «Добавить быструю команду».</p>
        <p class="small">Внутри: шаги и активные калории за сегодня, вес, пульс в покое, вариабельность пульса (HRV) и сон прошлой ночи. После отправки придёт уведомление, что именно записалось.</p>
        ${/iPhone|iPad|iPod/.test(navigator.userAgent) ? '' : '<p class="note">Сейчас страница открыта не на iPhone: файл скачается сюда. Удобнее открыть «Здоровье iPhone» в Тренере на телефоне.</p>'}
        <div class="actions"><button class="btn solid" data-act="hg-shortcut" ${shortcutState === 'loading' ? 'disabled' : ''}>${shortcutState === 'loading' ? 'Готовлю…' : 'Добавить команду на iPhone'}</button></div>
        ${shortcutState?.error ? `<div class="notice">${esc(shortcutState.error)}</div>` : ''}
        <p class="note">При первом запуске «Команды» спросят доступ к «Здоровью» - разрешите все типы. Проверить сразу: запустите команду вручную и нажмите «Проверить» вверху. Если команда показывает окно «Образцы не найдены» (например, нет часов - нет HRV, нет весов - нет веса), удалите в ней этот блок: иначе окно остановит автоматизацию. После «Выпустить новый токен» команду нужно скачать заново.</p>
      </div>
      <p class="note" style="margin-top:12px">Если кнопка не сработала - соберите команду вручную (ниже, «Если собирать вручную»).</p></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Шаг 2. Автоматизация</span><span class="note">чтобы запускалась сама</span></div>
      <ol class="hg-ol">
        <li>Откройте «Команды» → вкладка <b>«Автоматизация»</b> внизу → <b>«+»</b> (или «Новая автоматизация»).</li>
        <li>Выберите <b>«Время суток»</b> → 22:30 → <b>«Ежедневно»</b> → отметьте <b>«Запускать сразу»</b> (без вопроса) → «Далее».</li>
        <li>В списке команд выберите <b>«Тренер: Здоровье»</b> - это и есть связка. Если списка нет: «Новая пустая автоматизация» → «Добавить действие» → найдите <b>«Запустить команду»</b> → нажмите на синее слово «Команда» → выберите «Тренер: Здоровье».</li>
        <li>«Готово». Всё: каждый вечер данные придут сами.</li>
      </ol>
      <p class="note">По желанию - вторая автоматизация: «Приложение» → Тренер → «Открыто» → та же команда. Тогда данные подтянутся при каждом открытии Тренера. Запускать можно сколько угодно раз - за день данные перезаписываются, а не множатся.</p></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Адрес и токен</span><span class="note">для ручной сборки</span></div>
      <div class="inset card hg-keys">
        <div class="hg-key"><span class="smallcaps muted">Адрес</span><code class="mono">${esc(url)}</code>
          <button class="btn quiet" data-act="hg-copy" data-v="${esc(url)}">Скопировать</button></div>
        <div class="hg-key"><span class="smallcaps muted">Токен</span>
          ${token ? `<code class="mono">${esc(token)}</code><button class="btn quiet" data-act="hg-copy" data-v="${esc(token)}">Скопировать</button>`
            : `<span class="note">${esc(tokenError || 'Загружаю…')}</span><span></span>`}</div>
      </div>
      <div class="actions"><button class="btn quiet" data-act="hg-rotate">Выпустить новый токен</button>
        <span class="note">старый перестанет работать - команду нужно будет добавить заново</span></div>
      <p class="note">Сертификат Тренера должен быть установлен и включён в «Доверии сертификатам» (<a class="link" href="#install">как это сделать</a>), иначе команда не достучится до сервера. Команда работает только на вашем iPhone и шлёт данные только в ваш аккаунт; у второго человека - своя команда со своим токеном.</p>
    </div>

    <div class="section"><div class="section-title"><span class="smallcaps">Если собирать вручную</span><span class="note">Команды → «+» → назовите «Тренер: Здоровье»</span></div>
      <p class="small">Добавляйте действия по порядку (поиск действий - внизу экрана). Главное - шаги 1 и 8, остальное по желанию.</p>
      ${step('steps', 1, 'Шаги за сегодня', `<ol><li>Действие «Найти образцы Здоровья»: тип <b>Шаги</b>, «Дата начала» - <b>сегодня</b>, «Группировать» - <b>по дню</b>.</li>
        <li>«Вычислить статистику» → <b>Сумма</b>.</li><li>«Задать переменную» → имя <code>steps</code>.</li></ol>`)}
      ${step('sleep', 2, 'Сон прошлой ночью', `<ol><li>«Найти образцы Здоровья»: тип <b>Анализ сна</b>, «Дата начала» - за последние <b>1 день</b>, «Значение» - <b>Во сне</b>, сортировка по дате начала, <b>по возрастанию</b>.</li>
        <li>«Получить сведения об образцах Здоровья» → <b>Дата начала</b> → «Получить объект из списка» → <b>Первый</b> → «Форматировать дату» (ISO 8601) → переменная <code>bed</code>.</li>
        <li>То же с <b>Датой окончания</b> и <b>Последний</b> → переменная <code>wake</code>.</li></ol>`)}
      ${step('weight', 3, 'Вес', `<ol><li>«Найти образцы Здоровья»: тип <b>Вес</b>, сортировка - сначала новые, «Ограничить» - <b>1</b>.</li>
        <li>«Получить сведения» → <b>Значение</b> → переменная <code>weight</code>.</li></ol>`)}
      ${step('kcal', 4, 'Активные калории', `<ol><li>«Найти образцы Здоровья»: тип <b>Активная энергия</b>, с <b>сегодня</b> → «Вычислить статистику» → <b>Сумма</b> → переменная <code>active_kcal</code>.</li></ol>`)}
      ${step('workouts', 5, 'Тренировки (Apple Watch)', `<p class="small">Встроенные действия «Команд» тренировки <b>не читают</b>: «Найти образцы Здоровья» умеет шаги, сон, пульс, вес, но не тренировки. Поэтому в готовой команде их нет. Варианты:</p>
        <ul><li>Стороннее приложение с действиями для «Команд», например <b>Toolbox Pro</b> (действие «Find Workouts»): «Повторить с каждым» → «Словарь» с ключами <code>type</code>, <code>start</code>, <code>end</code>, <code>kcal</code>, <code>distance</code>, при желании <code>heart_rate</code> (значения пульса за время тренировки) → «Добавить в переменную» <code>workouts</code> → поле <code>workouts</code> в отправке. Тренер сам определит вид и интенсивность по пульсу.</li>
        <li>Или отмечать тренировку в Тренере: «Сегодня» → «+ Активность» (виды с часов - бег, силовая, HIIT, бокс и др. - там есть). Активные калории с часов всё равно придут готовой командой.</li></ul>`)}
      ${step('vitals', 6, 'Пульс в покое и HRV', `<ol><li>«Найти образцы Здоровья»: тип <b>Пульс в состоянии покоя</b>, сначала новые, ограничение <b>1</b> → «Получить сведения» → <b>Значение</b> → переменная <code>resting_hr</code>.</li>
        <li>То же с типом <b>Вариабельность пульса</b> → переменная <code>hrv</code>.</li></ol>
        <p class="note">Выше обычного пульс в покое или ниже HRV - признак недовосстановления: тренер предложит облегчить тренировку.</p>`)}
      ${step('period', 7, 'Цикл (по желанию)', `<ol><li>«Найти образцы Здоровья»: тип <b>Менструации</b>, за последние <b>90 дней</b>.</li>
        <li>«Повторить с каждым»: «Словарь» с ключами <code>date</code> (дата начала) и <code>flow</code> (значение) → «Добавить в переменную» <code>period</code>.</li></ol>
        <p class="note">Если цикл ведёте в другом приложении (Flo, Clue, Period Tracker…), включите в нём синхронизацию со «Здоровьем».</p>`)}
      ${step('send', 8, 'Отправка Тренеру', `<ol><li>«Текущая дата» → «Форматировать дату»: свой формат <code>yyyy-MM-dd</code> → переменная <code>date</code>.</li>
        <li>«Получить содержимое URL»: адрес - «Адрес» выше; нажмите «Показать больше»: метод <b>POST</b>, «Заголовки» → добавьте <code>X-Trainer-Token</code> = ваш «Токен»; «Тело запроса» - <b>JSON</b>, поля: <code>date</code>, <code>steps</code>, <code>weight</code>, <code>active_kcal</code>, <code>sleep</code> (словарь с <code>bed</code> и <code>wake</code>), <code>workouts</code>, <code>resting_hr</code>, <code>hrv</code>, <code>period</code> - в каждое поле подставьте одноимённую переменную.</li>
        <li>По желанию «Показать уведомление» с ответом - там видно, что записалось.</li></ol>`)}
    </div>

    <div class="section"><div class="section-title"><span class="smallcaps">Что и куда попадает</span></div>
      <table class="hg-table"><tbody>
        <tr><td>Шаги</td><td>отметка «Шаги» в чек-листе дня</td></tr>
        <tr><td>Сон</td><td>журнал сна - если вы не внесли его вручную (ваши ответы про сон сохраняются)</td></tr>
        <tr><td>Вес</td><td>замеры - если за этот день веса ещё нет</td></tr>
        <tr><td>Тренировки</td><td>активности «из Здоровья» - если команда их отправляет (нужно стороннее приложение, см. шаг 5): вид, время, дистанция, пульс и интенсивность по пульсу</td></tr>
        <tr><td>Пульс в покое, HRV</td><td>готовность дня - только вам</td></tr>
        <tr><td>Цикл</td><td>дни, начала и длина цикла - только вам</td></tr>
        <tr><td>Активные калории</td><td>в отчёты</td></tr>
      </tbody></table>
      <p class="note">Данные, которые партнёр расшарил через «Здоровье → Общий доступ», командам недоступны - поэтому у каждого своя команда. На компьютере «Здоровье» данные сторонним программам не отдаёт.</p>
    </div>`;
}

export const routes = { health: () => view() };

export const actions = {
  // готовая команда: сервер собирает её с вашим адресом и токеном и подписывает (на Mac); iPhone откроет «Команды»
  'hg-shortcut': async () => {
    shortcutState = 'loading'; S.render();
    try {
      // первый запрос готовит и подписывает файл на компьютере (до 10 с) и проверяет ошибки;
      // затем переходим по прямой ссылке - так Safari на iPhone скачает команду и предложит открыть её в «Командах»
      const r = await fetch('/api/health/shortcut', { credentials: 'same-origin' });
      if (!r.ok) {
        let msg = '';
        try { msg = (await r.json()).detail; } catch (e) { /* не JSON */ }
        throw new Error(r.status === 404 ? 'Готовая команда появится после обновления и перезапуска сервера - пока соберите её вручную.' : msg || `Сервер ответил ${r.status}`);
      }
      shortcutState = null; S.render();
      location.href = '/api/health/shortcut';
      toast('Откройте скачанный файл - «Команды» предложат добавить команду', 6000);
    } catch (e) {
      shortcutState = { error: e.message === 'Failed to fetch' || e.message === 'Load failed' ? 'Нет связи с сервером.' : e.message };
      S.render();
    }
  },
  'hg-check': async () => {
    try { await store.sync(); } catch (e) { /* офлайн */ }
    const last = lastImport();
    toast(last ? `Последний импорт: ${shortDate(last)}` : 'Данных из «Здоровья» пока нет. Запустите команду на iPhone вручную и проверьте снова.', 5000);
    S.render();
  },
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
