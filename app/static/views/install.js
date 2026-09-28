// «Установка на iPhone и iPad»: адрес с QR-кодом, сертификат («профиль»), доверие, экран «Домой».
// Открывают обычно на Mac, а навести камеру телефона на QR — быстрее, чем набирать адрес.
// QR рисует qrcode.js (Kazuhiko Arase, MIT), лежит локально — работает без интернета.
import * as store from '../store.js';
import { S, esc, toast, IS_ANDROID } from '../ui.js';

let cfg = null, cfgErr = null, qrReady = false;

function loadQr() {
  if (window.qrcode) { qrReady = true; return Promise.resolve(); }
  return new Promise(res => {
    const s = document.createElement('script');
    s.src = '/qrcode.js';
    s.onload = () => { qrReady = true; res(); };
    s.onerror = () => res();
    document.head.appendChild(s);
  });
}

function qrSvg(text) {
  if (!qrReady || !window.qrcode) return '';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

// адрес для телефона: имя Mac в сети (не меняется при смене IP), запасной — по IP
function addresses() {
  const out = [];
  if (cfg?.lan_host_url) out.push({ url: cfg.lan_host_url, label: 'имя компьютера в сети - основной, не меняется при смене IP' });
  // 172.16–31.x — обычно служебные сети (Docker и т. п.): прячем, если есть обычный домашний адрес
  const ips = cfg?.all_urls || [];
  const home = ips.filter(u => /\/\/(192\.168|10)\./.test(u));
  for (const u of home.length ? home : ips) out.push({ url: u, label: 'по IP - если имя не открывается' });
  if (cfg?.wan_url) out.push({ url: cfg.wan_url, label: 'из интернета (туннель)' });
  return out;
}

const step = (n, title, body) => `<div class="raised card in-step"><div class="in-head"><span class="mono in-n">${n}</span><b>${title}</b></div><div class="in-body">${body}</div></div>`;

// Android: Chrome, сертификат ставится в настройках системы как «Сертификат ЦС», затем «Установить приложение»
function androidSteps() {
  return `<div class="section"><div class="section-title"><span class="smallcaps">По шагам</span><span class="note">Chrome на Android</span></div>
      ${step(1, 'Открыть адрес в Chrome', '<p>Chrome предупредит «Подключение не защищено» - это нормально: сертификат ещё не установлен. Нажмите «Дополнительные» → «Перейти на сайт».</p>')}
      ${step(2, 'Скачать сертификат', '<p>Откройте ссылку <a class="link" href="/ca.crt">сертификат Тренера</a> (<span class="mono">…/ca.crt</span>) - файл сохранится в «Загрузки».</p>')}
      ${step(3, 'Установить сертификат', '<p><b>Настройки → Безопасность</b> (или «Безопасность и конфиденциальность») → <b>Шифрование и учётные данные</b> → <b>Установить сертификат</b> → <b>Сертификат ЦС</b> → «Всё равно установить» → выберите скачанный файл. Названия пунктов у разных производителей немного отличаются - поищите в настройках «сертификат».</p>')}
      ${step(4, 'Установить приложение', '<p>Закройте и снова откройте адрес в Chrome (предупреждения больше нет) → меню <b>⋮</b> → <b>Установить приложение</b> (или «Добавить на главный экран»).</p>')}
      ${step(5, 'Войти', '<p>Откройте «Тренер» с главного экрана и войдите своим логином.</p>')}
      <p class="note">Шаги и сон на Android вводятся вручную: автоматического импорта из Health Connect пока нет.</p></div>`;
}

function view() {
  const onPhone = !['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const addrs = addresses();
  const main = addrs[0]?.url;
  return `<div class="kicker smallcaps">Приложение</div>
    <h1>${IS_ANDROID ? 'Установка на Android' : 'Установка на iPhone и iPad'}</h1>
    <p class="lede">Один раз на каждом устройстве: поставить сертификат Тренера, добавить приложение на экран «Домой» и войти. Дальше оно работает как обычное приложение, в том числе без сети.</p>
    ${onPhone ? '<div class="notice">Вы уже открыли Тренер на этом устройстве. Если адрес открылся без предупреждений - сертификат стоит, переходите к шагу 5.</div>' : ''}

    <div class="section"><div class="section-title"><span class="smallcaps">Адрес для телефона</span></div>
      ${cfgErr ? `<p class="note">${esc(cfgErr)}</p>` : !cfg ? '<p class="note"><span class="spinner"></span> Узнаю адрес…</p>' : `
      <div class="in-addr">
        ${main && qrReady ? `<div class="in-qr inset" aria-label="QR-код адреса">${qrSvg(main)}</div>` : ''}
        <div class="in-list">${addrs.map(a => `<div class="in-a"><span class="mono">${esc(a.url)}</span><span class="note">${esc(a.label)}</span>
          <button class="btn quiet" data-act="in-copy" data-v="${esc(a.url)}">Скопировать</button></div>`).join('')}
          <p class="note">${IS_ANDROID ? 'На Android берите адрес с цифрами (IP): имена «.local» Chrome на Android часто не открывает.' : 'Наведите камеру iPhone на QR-код и нажмите на появившуюся ссылку - откроется Safari.'} Телефон должен быть в той же Wi-Fi-сети, что и компьютер.</p></div>
      </div>`}
    </div>

    ${IS_ANDROID ? androidSteps() : ''}
    <div class="section" ${IS_ANDROID ? 'hidden' : ''}><div class="section-title"><span class="smallcaps">По шагам</span></div>
      ${step(1, 'Открыть адрес в Safari', `<p>Именно в <b>Safari</b>: только он умеет ставить профили и добавлять приложения на экран «Домой». Safari предупредит «Подключение не защищено» - это нормально, сертификат ещё не установлен. Нажмите «Подробнее» → «посетить этот веб-сайт».</p>`)}
      ${step(2, 'Скачать профиль с сертификатом', `<p>Откройте ссылку <a class="link" href="/ca.crt">сертификат Тренера</a> (адрес <span class="mono">…/ca.crt</span>). iPhone спросит: «Веб-сайт пытается загрузить профиль конфигурации» → <b>Разрешить</b> → «Профиль загружен» → Закрыть.</p>`)}
      ${step(3, 'Установить профиль', `<p><b>Настройки</b> → вверху появится строка <b>«Профиль загружен»</b> (или: Основные → VPN и управление устройством → «Trainer local CA») → <b>Установить</b> → код-пароль телефона → ещё раз <b>Установить</b> → Готово.</p>`)}
      ${step(4, 'Включить доверие', `<p><b>Настройки → Основные → Об этом устройстве</b> → в самом низу <b>Доверие сертификатам</b> → включите переключатель <b>«Trainer local CA»</b> → Продолжить.</p>
        <p class="note">Без этого шага Safari по-прежнему будет предупреждать, а приложение не сможет работать без сети.</p>`)}
      ${step(5, 'Добавить на экран «Домой»', `<p>Вернитесь в Safari, откройте адрес ещё раз (предупреждения больше нет) → кнопка <b>Поделиться</b> (квадрат со стрелкой) → <b>На экран «Домой»</b> → Добавить.</p>`)}
      ${step(6, 'Войти', `<p>Откройте «Тренер» с экрана «Домой» и войдите своим логином. Каждый - в свой аккаунт: данные, «Здоровье» и напоминания у каждого свои.</p>`)}
    </div>

    <div class="section" ${IS_ANDROID ? 'hidden' : ''}><div class="section-title"><span class="smallcaps">Если что-то не так</span></div>
      <ul class="small">
        <li><b>Адрес с именем компьютера не открывается</b> - попробуйте адрес по IP из списка выше; проверьте, что телефон в той же Wi-Fi-сети.</li>
        <li><b>Не видно «Профиль загружен»</b> - ссылку на сертификат открывали не в Safari; откройте её в Safari заново.</li>
        <li><b>Нет переключателя в «Доверии сертификатам»</b> - профиль скачан, но не установлен (шаг 3).</li>
        <li><b>Сменился адрес компьютера</b> - переустанавливать не нужно: приложение само найдёт рабочий адрес (Профиль → Адреса сервера).</li>
      </ul>
    </div>`;
}

export const routes = { install: () => view() };

export const actions = {
  'in-copy': async el => {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('Адрес скопирован'); }
    catch (e) { toast('Не получилось скопировать - выделите адрес вручную'); }
  },
};

export async function afterRender() {
  let changed = false;
  if (!qrReady) { await loadQr(); changed = qrReady; }
  if (!cfg && !cfgErr) {
    try { cfg = await store.api('/api/config'); } catch (e) { cfgErr = e.status === 0 ? 'Нет связи с сервером - адрес покажется, когда он будет доступен.' : e.message; }
    changed = true;
  }
  if (changed && location.hash.startsWith('#install')) S.render();
}
