// «Подключение»: адреса сервера (зеркала) и доступ из интернета.
// PWA привязана к адресу, с которого установлена (к нему же привязаны данные на устройстве),
// поэтому адрес приложения не меняем — меняем только адрес, по которому оно ходит к серверу.
import * as store from '../store.js';
import { S, esc, toast, chips, fval, ensureForm, closeModal } from '../ui.js';

const KIND = { origin: 'адрес приложения', mdns: 'имя компьютера в сети', lan: 'IP в домашней сети', wan: 'из интернета', manual: 'добавлен вручную' };
const WAN_STATUS = { off: 'выключен', starting: 'запускается…', on: 'работает', error: 'ошибка' };

let wan = null, wanDenied = false, devices = null, devErr = null, loadedAt = 0, busy = false, wanTimer = null;

// стили экрана живут здесь: экран целиком свой, общие файлы стилей не трогаем
function injectStyle() {
  if (document.getElementById('cn-style')) return;
  const st = document.createElement('style');
  st.id = 'cn-style';
  st.textContent = `
.cn-list { padding: 4px 16px; }
.cn-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--rule); }
.cn-row:last-child { border-bottom: 0; }
.cn-url { font-family: var(--mono); font-size: 13.5px; color: var(--ink-strong); overflow-wrap: anywhere; }
.cn-meta { font-size: 13px; color: var(--ink-3); display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; margin-top: 2px; }
.cn-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--rule-2); margin-right: 5px; vertical-align: 1px; }
.cn-dot.ok { background: var(--ok); } .cn-dot.bad { background: var(--accent); }
.cn-btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.cn-add { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-top: 12px; }
.cn-now { display: grid; gap: 4px; padding: 14px 16px; }
.cn-wan-url { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; margin-top: 10px; }
@media (max-width: 480px) { .cn-row { grid-template-columns: minmax(0, 1fr); } .cn-btns { justify-content: flex-start; } }`;
  document.head.appendChild(st);
}

function ago(ms) {
  if (!ms) return '-';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(ms);
}

// Открыто на самом Mac (localhost), а адрес — https в сети: браузер Mac не доверяет сертификату
// «Тренера», если его не поставили в «Связку ключей», а Chrome ещё и не видит имена .local.
// Сервер при этом работает — с телефона адрес открывается. Не пугаем словом «недоступен».
const onMac = () => ['localhost', '127.0.0.1', '::1'].includes(location.hostname);

function statusHtml(st, url = '') {
  if (!st) return '<span><span class="cn-dot"></span>не проверен</span>';
  if (st.ok) return `<span><span class="cn-dot ok"></span>на связи · ${st.ms} мс</span>`;
  if (onMac() && url.startsWith('https://') && !/trycloudflare|^https:\/\/[^/]*\.(com|ru|net|org)/.test(url)) {
    return `<span><span class="cn-dot"></span>из браузера на компьютере не проверить - это адрес для телефона</span>`;
  }
  return `<span><span class="cn-dot bad"></span>${esc(st.error || 'недоступен')}</span>`;
}

function mirrorRow(m) {
  const act = m.current ? '<span class="note">используется</span>'
    : `<button class="btn quiet" data-act="cn-use" data-url="${esc(m.url)}">Использовать</button>`;
  return `<div class="cn-row"><div style="min-width:0"><div class="cn-url">${esc(m.url.replace(/^https?:\/\//, ''))}</div>
      <div class="cn-meta"><span>${KIND[m.kind] || m.kind}</span>${statusHtml(m.status, m.url)}</div></div>
    <div class="cn-btns">${act}${m.manual ? `<button class="btn quiet" data-act="cn-remove" data-url="${esc(m.url)}">Убрать</button>` : ''}</div></div>`;
}

function devicesHtml() {
  if (devErr) return `<p class="note">${esc(devErr)}</p>`;
  if (!devices) return '<p class="note"><span class="spinner"></span> Загружаю…</p>';
  if (!devices.length) return '<p class="empty">Пока ни одного - токен появится после входа.</p>';
  // свежие сверху; длинный хвост старых входов прячем - он только мешает найти нужное
  const all = S.forms.cn_all, shown = all ? devices : devices.slice(0, 5), rest = devices.length - shown.length;
  return `<div class="inset card cn-list">${shown.map(d => `<div class="cn-row"><div style="min-width:0">
      <div class="ell" style="color:var(--ink-strong)">${esc(d.label || 'Устройство')}${d.current ? ' <span class="note">· это устройство</span>' : ''}</div>
      <div class="cn-meta"><span>выдан ${esc(ago(d.created))}</span><span>был на связи ${esc(ago(d.last_seen))}</span></div></div>
    <div class="cn-btns"><button class="btn quiet danger" data-act="cn-revoke" data-id="${esc(d.id)}">${d.current ? 'Отозвать' : 'Отключить'}</button></div></div>`).join('')}</div>
    <div class="actions">${rest > 0 ? `<button class="btn quiet" data-act="cn-all">Показать ещё ${rest}</button>` : ''}
      ${devices.length > 1 ? '<button class="btn quiet danger" data-act="cn-revoke-others">Отключить все, кроме этого</button>' : ''}</div>
    <p class="note">Ключи, которыми не пользовались 60 дней, отключаются сами.</p>`;
}

function wanHtml() {
  if (wanDenied) return `<p class="note">Включить доступ из интернета можно на самом компьютере (откройте <span class="mono">http://localhost:${esc(String((wan && wan.https_port + 1) || 8791))}</span>) или из аккаунта владельца - того, кто зарегистрировался первым.</p>`;
  if (!wan) return '<p class="note"><span class="spinner"></span> Загружаю…</p>';
  const f = ensureForm('wan', () => ({ mode: wan.mode, url: wan.static_url || '' }));
  const mode = f.mode;
  const st = WAN_STATUS[wan.status] || wan.status;
  return `<div class="notice">Сервер станет доступен из любой сети - например, с телефона в мобильном интернете. Данные защищает пароль вашего аккаунта; новые аккаунты из интернета заводить нельзя, частые попытки входа блокируются. Включайте, только если это нужно, и выбирайте надёжный пароль.</div>
    <div style="margin:14px 0 12px">${chips('wan', 'mode', wan.mode, [['off', 'Выключен'], ['tunnel', 'Туннель Cloudflare'], ['static', 'Свой адрес']])}</div>
    ${mode === 'tunnel' ? `<p class="note">Бесплатный туннель Cloudflare: роутер настраивать не нужно, шифрование HTTPS даёт Cloudflare. Адрес вида <span class="mono">…trycloudflare.com</span> меняется при каждом запуске - приложение узнаёт новый сам, пока хоть раз было на связи дома.</p>
      ${wan.cloudflared ? '' : '<p class="warn small">На компьютере нет программы cloudflared. macOS: в Терминале <span class="mono">brew install cloudflared</span>; Windows и Linux: скачайте с сайта Cloudflare (developers.cloudflare.com, раздел cloudflared) и перезапустите сервер.</p>'}` : ''}
    ${mode === 'static' ? `<label class="field"><span class="smallcaps">Внешний адрес</span><input class="control mono" data-form="wan" data-key="url" value="${esc(fval('wan', 'url', ''))}" placeholder="https://203.0.113.5:${esc(String(wan.https_port))}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <p class="note">Для постоянного IP или домена: на роутере пробросьте внешний порт на порт <span class="mono">${esc(String(wan.https_port))}</span> этого компьютера. Адрес попадёт в сертификат после перезапуска сервера.</p>
      ${wan.mode === 'static' && !wan.cert_ok ? '<p class="warn small">Перезапустите Тренер, чтобы сертификат включил этот адрес, - иначе iPhone не доверит соединению.</p>' : ''}` : ''}
    <div class="cn-now inset card" style="margin-top:12px"><div class="small">Сейчас: <b>${esc(st)}</b>${wan.status === 'starting' ? ' <span class="spinner"></span>' : ''}</div>
      ${wan.error ? `<div class="warn small">${esc(wan.error)}</div>` : ''}
      ${wan.url ? `<div class="cn-wan-url"><span class="cn-url">${esc(wan.url)}</span><button class="btn quiet" data-act="cn-copy" data-v="${esc(wan.url)}">Копировать</button></div>` : ''}</div>
    ${mode === 'off' && wan.mode === 'off' ? '' : `<div class="actions"><button class="btn solid" data-act="cn-wan-apply" ${busy ? 'disabled' : ''}>${mode === 'off' ? 'Выключить' : mode === wan.mode ? 'Применить' : 'Включить'}</button></div>`}`;
}

function view() {
  injectStyle();
  const list = store.mirrors();
  const cur = store.apiBase() || location.origin;
  return `<div class="kicker smallcaps">Профиль · Подключение</div>
    <h1>Адреса сервера</h1>
    <p class="lede">Если у компьютера сменился адрес, приложение само найдёт другой рабочий, переустанавливать его не нужно.</p>

    <div class="section"><div class="section-title"><span class="smallcaps">Сейчас</span></div>
      <div class="inset card cn-now"><span class="cn-url">${esc(cur.replace(/^https?:\/\//, ''))}</span>
        <span class="note">${store.state.online ? 'сервер на связи' : 'сервер недоступен - правки ждут на этом устройстве'}${store.usingMirror() ? ' · запасной адрес' : ''}</span></div></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Все адреса</span>
      <button class="btn quiet" data-act="cn-probe">Проверить</button></div>
      <div class="inset card cn-list">${list.map(mirrorRow).join('')}</div>
      <form class="cn-add" data-submit="cn-add"><input class="control mono" name="url" placeholder="192.168.1.50 или адрес из интернета" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Адрес сервера">
        <button class="btn" type="submit">Добавить</button></form>
      <p class="note">Список приходит с сервера, когда приложение на связи, и дополняется вашими адресами. Адрес считается рабочим, только если сервер докажет, что он тот же самый, иначе ключ доступа этого устройства туда не отправляется.</p>
    </div>

    <div class="section"><div class="section-title"><span class="smallcaps">Устройства с доступом</span></div>
      ${devicesHtml()}
      <p class="note">У каждого входа свой ключ. Отключите устройство, которое потеряли или больше не используете: ему придётся войти заново.</p></div>

    <div class="section"><div class="section-title"><span class="smallcaps">Доступ из интернета</span></div>${wanHtml()}</div>

    ${onMac() ? `<details class="raised card" style="margin-top:22px"><summary><b>Почему адреса в сети здесь «не проверить»</b></summary>
      <p class="small">Вы открыли Тренер на самом компьютере - по <span class="mono">localhost</span>, и так и нужно. Адреса вида <span class="mono">https://…local:8790</span> и <span class="mono">https://192.168…</span> - для телефона и планшета. Сервер по ним отвечает, но браузер этого компьютера их не пускает: сертификат Тренера установлен только на телефоне, а Chrome ещё и не открывает имена <span class="mono">.local</span> (Safari открывает).</p>
      <p class="small">Как поставить на телефон - <a class="link" href="#install">пошаговая инструкция с QR-кодом</a>.</p>
      <p class="small">Если хотите открывать эти адреса и с компьютера: скачайте <a class="link" href="/ca.crt">сертификат</a> и добавьте его в доверенные. macOS: двойной клик → «Связка ключей» → «Trainer local CA» → «Доверие» → «Всегда доверять». Windows: двойной клик → «Установить сертификат» → «Поместить все сертификаты в следующее хранилище» → «Доверенные корневые центры сертификации». Linux: зависит от системы и браузера. Для адресов <span class="mono">.local</span> удобнее Safari или адрес по IP.</p></details>` : ''}
    <details class="raised card" style="margin-top:22px"><summary><b>Почему не нужно переустанавливать приложение</b></summary>
      <p class="small">Приложение на экране «Домой» и все данные на устройстве привязаны к адресу, с которого его установили. Раньше при смене адреса пришлось бы ставить его заново. Теперь само приложение открывается из памяти устройства, а к серверу оно ходит по любому из рабочих адресов: по имени компьютера в сети, по IP, через интернет или по адресу, который вы добавили. Выбирается первый ответивший; когда основной адрес снова заработает, приложение вернётся к нему.</p>
    </details>`;
}

async function loadAll() {
  loadedAt = Date.now();
  const jobs = [
    store.api('/api/config').catch(() => null),
    store.api('/api/auth/devices').then(d => { devices = d.devices; devErr = null; })
      .catch(e => { devErr = e.status === 0 ? 'Нет связи с сервером.' : e.message; }),
    loadWan(),
  ];
  await Promise.all(jobs);
  S.render();
  await store.probeMirrors();
}

async function loadWan() {
  try { wan = await store.api('/api/wan'); wanDenied = false; }
  catch (e) { wanDenied = e.status === 403; if (!wanDenied) wan = null; }
  clearTimeout(wanTimer);
  // пока туннель поднимается, адрес появится через несколько секунд - подтягиваем
  if (wan?.status === 'starting') wanTimer = setTimeout(async () => { if (location.hash.startsWith('#connect')) { await loadWan(); S.render(); } }, 2000);
}

export const routes = { connect: () => view() };

export const actions = {
  'cn-open': () => { closeModal(); location.hash = '#connect'; },
  'cn-probe': async () => { toast('Проверяю адреса…'); await store.probeMirrors(); },
  'cn-use': async el => {
    try {
      const t = await store.setMirror(el.dataset.url);
      toast(t ? 'Приложение работает через этот адрес' : 'Вернулись к основному адресу');
      store.sync();
    } catch (e) { toast(e.message); }
  },
  'cn-remove': async el => { await store.removeMirror(el.dataset.url); },
  'cn-add': async formEl => {
    const url = await store.addMirror(formEl.url.value);
    formEl.url.value = '';
    toast('Адрес добавлен - проверяю');
    await store.probeMirrors();
    return url;
  },
  'cn-copy': async el => {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('Скопировано'); }
    catch (e) { toast('Не получилось скопировать - выделите адрес вручную'); }
  },
  'cn-revoke': async el => {
    const d = devices?.find(x => x.id === el.dataset.id);
    await store.api(`/api/auth/devices/${el.dataset.id}`, undefined, 'DELETE');
    if (d?.current) await store.setMeta('device_token', null);
    devices = devices.filter(x => x.id !== el.dataset.id);
    toast('Устройство отключено');
    S.render();
  },
  'cn-all': () => { S.forms.cn_all = true; S.render(); },
  'cn-revoke-others': async el => {
    const r = await store.api('/api/auth/devices', undefined, 'DELETE');
    devices = devices.filter(x => x.current);
    toast(`Отключено устройств: ${r.revoked}`);
    S.render();
  },
  'cn-wan-apply': async () => {
    const f = S.forms.wan || {};
    busy = true; S.render();
    try {
      wan = await store.api('/api/wan', { mode: f.mode || 'off', url: f.url || '' });
      toast(f.mode === 'off' ? 'Доступ из интернета выключен' : f.mode === 'tunnel' ? 'Запускаю туннель…' : 'Адрес сохранён');
      await loadWan();
      store.api('/api/config').catch(() => {});
    } catch (e) { toast(e.message); }
    finally { busy = false; S.render(); }
  },
};

export const confirms = {
  'cn-remove': el => ({ title: 'Убрать адрес?', ok: 'Убрать', text: `${String(el.dataset.url || '').replace(/^https?:\/\//, '')} исчезнет из списка адресов.` }),
  'cn-revoke': el => {
    const d = devices?.find(x => x.id === el.dataset.id);
    return d?.current ? { title: 'Отозвать доступ этого устройства?', ok: 'Отозвать', text: 'Нужно будет войти снова.' }
      : { title: 'Отключить устройство?', ok: 'Отключить', text: `${d?.label ? `«${d.label}» ` : 'Устройство '}потеряет доступ, ему придётся войти заново.` };
  },
  'cn-revoke-others': () => ({ title: 'Отключить все остальные устройства?', ok: 'Отключить', text: 'Остальным придётся войти заново. Это устройство останется.' }),
};

export function afterRender() {
  // при каждом заходе на экран (не чаще раза в 30 с) - свежие адреса, устройства и состояние WAN
  if (Date.now() - loadedAt > 30000) loadAll().catch(e => console.error(e));
}
