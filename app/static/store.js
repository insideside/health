// Данные на клиенте: IndexedDB + копия в памяти + очередь исходящих изменений + синхронизация.
//
// Любая правка сразу пишется локально и в outbox, поэтому приложение одинаково работает с
// сервером и без него. sync() отправляет outbox и забирает изменения с rev > cursor.
//
// Несколько устройств (телефон, iPad, компьютер) правят одни и те же записи. Каждая правка
// в outbox помнит, от какой версии сервера она сделана (base_rev) и какими были данные тогда
// (base). Если сервер за это время получил другую правку, он не перезаписывает, а возвращает
// конфликт — и мы сливаем три версии (base, наша, серверная) по полям. Изменения в разных
// полях просто складываются, счётчики воды суммируются, отметки «сделано» объединяются.
// Если одно и то же поле изменено по-разному — правка откладывается (held) и приложение
// спрашивает пользователя: «с этого устройства», «с сервера» или «объединить».

const DB_NAME = 'trainer';
let idb = null;
const mem = new Map();          // id → запись
const outbox = new Map();       // id → { id, rec, base_rev, base, base_deleted, held, conflict }
const meta = {};                // cursor, me, partners, exercises, …
const listeners = new Set();
let syncing = null, syncAgain = false, syncTimer = null;
const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('trainer-store') : null;

// ai: доступна ли модель на сервере (true/false; null — ещё не знаем) — из опроса /api/sync/head
export const state = { online: navigator.onLine, lastSync: 0, error: null, syncing: false, persistError: null, ai: null };

function req2p(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(t) { return new Promise(res => { t.oncomplete = () => res(true); t.onerror = t.onabort = () => res(false); }); }
const clone = v => (v === undefined ? undefined : structuredClone(v));

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('records', { keyPath: 'id' });
      d.createObjectStore('outbox', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx(stores, mode = 'readonly') { return idb.transaction(stores, mode); }

// запись outbox из версии 1 (просто запись) → новый формат; base_rev неизвестен → «старый» режим
function upgradeEntry(e) {
  return e && e.rec ? e : { id: e.id, rec: e, base_rev: undefined, base: null, base_deleted: false, held: false };
}

export async function init() {
  idb = await openDB();
  const t = tx(['records', 'outbox', 'meta']);
  const [recs, out, keys, vals] = await Promise.all([
    req2p(t.objectStore('records').getAll()),
    req2p(t.objectStore('outbox').getAll()),
    req2p(t.objectStore('meta').getAllKeys()),
    req2p(t.objectStore('meta').getAll()),
  ]);
  recs.forEach(r => mem.set(r.id, r));
  out.map(upgradeEntry).forEach(e => { outbox.set(e.id, e); mem.set(e.id, e.rec); });
  keys.forEach((k, i) => { meta[k] = vals[i]; });
  window.addEventListener('online', () => { state.online = true; sync(); });
  window.addEventListener('offline', () => { state.online = false; emit(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  window.addEventListener('focus', () => sync());
  // Другие устройства: спрашиваем у сервера только номер последней ревизии (одно число) и делаем полный
  // обмен, лишь если появилось новое. Ради батареи: раз в 10 с, пока с приложением работают; раз в минуту,
  // если 2 минуты не трогали или вкладка свёрнута (свёрнутая, но живая вкладка — Mac, iPad — продолжает
  // принимать правки с других устройств и досылать свои). iPhone свёрнутую PWA замораживает целиком —
  // тогда обмен идёт при возврате (visibilitychange), а задачи ИИ тем временем выполняет сервер.
  let lastTouch = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'scroll']) addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true });
  const headTick = async () => {
    if (me() && !syncing && (state.online || document.hidden)) {
      try {
        const h = await api('/api/sync/head');
        if (h && typeof h.ai === 'boolean' && h.ai !== state.ai) { state.ai = h.ai; emit(); }
        if (h && (h.rev > getMeta('cursor', 0) || pendingCount())) sync();
      } catch (e) { /* офлайн — обменяемся, когда связь вернётся */ }
    }
    setTimeout(headTick, !document.hidden && Date.now() - lastTouch < 120000 ? 10000 : 60000);
  };
  setTimeout(headTick, 10000);
  // iOS может вычистить хранилище сайта, которым давно не пользовались; просим не трогать
  try { navigator.storage?.persist?.(); } catch (e) { /* не поддерживается */ }
  if (chan) chan.onmessage = onBroadcast;
}

// ── другие вкладки этого же браузера ──
// Вкладки делят одну IndexedDB, но у каждой своя копия в памяти: рассылаем, что записали.
function broadcast(msg) { try { chan?.postMessage(msg); } catch (e) { /* закрыт */ } }
function onBroadcast({ data: m }) {
  if (!m) return;
  if (m.t === 'recs') m.recs.forEach(r => { if (!outbox.has(r.id)) mem.set(r.id, r); });
  if (m.t === 'outbox') {
    (m.put || []).forEach(e => { outbox.set(e.id, e); mem.set(e.id, e.rec); });
    (m.del || []).forEach(id => outbox.delete(id));
  }
  if (m.t === 'meta') meta[m.k] = m.v;
  emit();
}

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let emitTimer = null;
function emit() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }), 16);
}

// ── meta ──
export function getMeta(k, def) { return k in meta ? meta[k] : def; }
export async function setMeta(k, v) {
  meta[k] = v;
  await req2p(tx('meta', 'readwrite').objectStore('meta').put(v, k));
  if (k === 'cursor' || k === 'me' || k === 'partners' || k === 'jobs' || k === 'is_admin' || k === 'groups') broadcast({ t: 'meta', k, v });
}

export function me() { return getMeta('me', null); }
export function partners() { return getMeta('partners', []); }
export function isAdmin() { return !!getMeta('is_admin', false); }
export function groups() { return getMeta('groups', []); }

// ── чтение ──
export function get(id) { const r = mem.get(id); return r && !r.deleted ? r : null; }

export function list(kind, uid = me()?.id, filter) {
  const out = [];
  for (const r of mem.values()) {
    if (r.kind === kind && r.user_id === uid && !r.deleted && (!filter || filter(r))) out.push(r);
  }
  return out;
}

export function byDate(kind, date, uid = me()?.id) { return list(kind, uid, r => r.date === date); }

// ── запись ──
export async function put(kind, id, data, date = null) {
  const uid = me().id;
  const prev = mem.get(id);
  const rec = { id, user_id: uid, kind, date, data, updated_at: Date.now(), deleted: false, ...(prev?.rev ? { rev: prev.rev } : {}) };
  await save(rec);
  return rec;
}

export async function patch(id, fields) {
  const r = mem.get(id);
  if (!r) return null;
  const rec = { ...r, data: { ...r.data, ...fields }, updated_at: Date.now() };
  await save(rec);
  return rec;
}

export async function remove(id) {
  const r = mem.get(id);
  if (!r) return;
  await save({ ...r, deleted: true, updated_at: Date.now() });
}

// Запись на устройство. Если IndexedDB отказала (нет места, iOS закрыла базу) — правка остаётся
// в памяти и в очереди на отправку, а запись на устройство повторяется, пока не получится.
const unpersisted = new Map();   // id → [rec, entry]
let persistTimer = null;
async function persist(rec, entry) {
  let ok = false;
  try {
    const t = tx(['records', 'outbox'], 'readwrite');
    t.objectStore('records').put(rec);
    t.objectStore('outbox').put(entry);
    ok = await done(t);
  } catch (e) { ok = false; }
  if (ok) { unpersisted.delete(rec.id); if (!unpersisted.size && state.persistError) { state.persistError = null; emit(); } return true; }
  unpersisted.set(rec.id, [rec, entry]);
  state.persistError = 'Не удалось сохранить на этом устройстве - повторяю. Правки не потеряны, пока приложение открыто и есть связь.';
  emit();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => { for (const [r, e] of [...unpersisted.values()]) await persist(r, outbox.get(r.id) || e); }, 2000);
  return false;
}

async function save(rec) {
  const prevEntry = outbox.get(rec.id);
  const known = mem.get(rec.id);
  // первая неотправленная правка запоминает версию, от которой сделана; следующие — наследуют
  const entry = prevEntry
    ? { ...prevEntry, rec }
    : { id: rec.id, rec, base_rev: known?.rev ?? null, base: clone(known?.data ?? null), base_deleted: !!known?.deleted, held: false };
  mem.set(rec.id, rec);
  outbox.set(rec.id, entry);
  await persist(rec, entry);
  broadcast({ t: 'outbox', put: [entry] });
  emit();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 800);
}

export function pendingCount() { let n = 0; for (const e of outbox.values()) if (!e.held) n++; return n; }
export function uid() { return me()?.id; }
export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
}

// ── слияние версий ──
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(x => stable(x === undefined ? null : x)).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const eq = (a, b) => stable(a) === stable(b);
const CONFLICT = Symbol('conflict');

// Особые правила по видам записей: где «оба правы», складываем, а не спорим.
function special(kind, id, b, l, s) {
  if (kind === 'log' && isObj(l) && isObj(s)) {
    const itemId = id.split(':').pop();
    const item = mem.get(itemId);
    const type = item?.data?.type;
    const bv = b?.v, lv = l.v, sv = s.v;
    if (type === 'counter' && typeof lv === 'number' && typeof sv === 'number') {
      // стакан воды на телефоне + стакан на iPad = два стакана
      return { ...s, ...l, v: Math.max(0, sv + lv - (typeof bv === 'number' ? bv : 0)) };
    }
    if (type === 'number' && typeof lv === 'number' && typeof sv === 'number') return { ...s, ...l, v: Math.max(lv, sv) };
    if (type === 'bool' || typeof lv === 'boolean') return { ...s, ...l, v: !!(lv || sv) };
  }
  return undefined;
}

// Трёхстороннее слияние: b — общая исходная, l — наша, s — серверная. Спорные места → conf.
function merge3(b, l, s, path, conf) {
  if (eq(l, s)) return l;
  if (eq(l, b)) return s;
  if (eq(s, b)) return l;
  if (isObj(l) && isObj(s)) {
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(s)])) {
      const v = merge3(isObj(b) ? b[k] : undefined, l[k], s[k], path ? `${path}.${k}` : k, conf);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(l) && Array.isArray(s)) {
    const prim = [...l, ...s].every(x => x === null || typeof x !== 'object');
    if (prim) {
      // набор значений (дни недели, теги): добавленное с любой стороны остаётся, убранное — уходит
      const base = Array.isArray(b) ? b : [];
      const has = (arr, x) => arr.some(y => eq(x, y));
      const out = [...l.filter(x => has(s, x) || !has(base, x)), ...s.filter(x => !has(l, x) && !has(base, x))];
      return out;
    }
    // список объектов по позициям (подходы тренировки, продукты в записи)
    const n = Math.max(l.length, s.length), out = [];
    for (let i = 0; i < n; i++) {
      const v = merge3(Array.isArray(b) ? b[i] ?? null : null, l[i] ?? null, s[i] ?? null, `${path}[${i}]`, conf);
      out.push(v === undefined ? null : v);
    }
    return out;
  }
  conf.push({ path, local: l, server: s });
  return CONFLICT;
}

// Решение для спорного значения при «объединить»: тексты склеиваем, флажки — «да» побеждает,
// остальное — более поздняя правка.
function combine(l, s, localNewer) {
  if (typeof l === 'boolean' && typeof s === 'boolean') return l || s;
  if (typeof l === 'string' && typeof s === 'string') {
    if (l.includes(s)) return l;
    if (s.includes(l)) return s;
    if (l.length > 24 || s.length > 24 || /\s/.test(l + s)) return `${s}\n${l}`;
  }
  if (l == null) return s;
  if (s == null) return l;
  return localNewer ? l : s;
}
function resolveMarkers(v, conf, pick) {
  if (v === CONFLICT) { const c = conf.shift(); return pick(c.local, c.server); }
  if (Array.isArray(v)) return v.map(x => resolveMarkers(x, conf, pick));
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = resolveMarkers(v[k], conf, pick); return o; }
  return v;
}

function mergeRecord(entry, server) {
  const l = entry.rec, conf = [];
  if (l.deleted !== !!server.deleted) {
    const other = l.deleted ? server : l;
    const baseData = entry.base;
    // удалили с одной стороны, а с другой не трогали — удаление побеждает; правили — спросим
    if (eq(other.data, baseData)) return { data: l.deleted ? l.data : server.data, deleted: true, conflicts: [] };
    return { data: l.deleted ? server.data : l.data, deleted: false, conflicts: [{ path: '(удаление)', local: l.deleted ? 'удалено' : 'изменено', server: server.deleted ? 'удалено' : 'изменено' }], deletion: true };
  }
  const sp = special(l.kind, l.id, entry.base, l.data, server.data);
  if (sp !== undefined) return { data: sp, deleted: !!l.deleted, conflicts: [] };
  const data = merge3(entry.base, l.data, server.data, '', conf);
  return { data, deleted: !!l.deleted, conflicts: conf };
}

// ── конфликты для интерфейса ──
export function conflicts() {
  return [...outbox.values()].filter(e => e.held && e.conflict).map(e => ({
    id: e.id, kind: e.rec.kind, date: e.rec.date, local: e.rec, server: e.conflict.server, fields: e.conflict.fields,
  }));
}

// choice: 'local' — оставить данные этого устройства, 'server' — взять с сервера, 'merge' — объединить
export async function resolveConflict(id, choice) {
  const e = outbox.get(id);
  if (!e || !e.conflict) return;
  const server = e.conflict.server;
  const t = tx(['records', 'outbox'], 'readwrite');
  if (choice === 'server') {
    outbox.delete(id);
    mem.set(id, server);
    t.objectStore('outbox').delete(id);
    t.objectStore('records').put(server);
    await done(t);
    broadcast({ t: 'outbox', del: [id] });
    broadcast({ t: 'recs', recs: [server] });
  } else {
    let rec = { ...e.rec, updated_at: Date.now() };
    if (choice === 'merge') {
      const conf = [];
      const merged = merge3(e.base, e.rec.data, server.data, '', conf);
      const localNewer = (e.rec.updated_at || 0) >= (server.updated_at || 0);
      const data = conf.length ? resolveMarkers(merged, conf, (l, s) => combine(l, s, localNewer)) : merged;
      rec = { ...rec, data, deleted: e.conflict.deletion ? false : !!e.rec.deleted };
    }
    const entry = { id, rec, base_rev: server.rev, base: clone(server.data), base_deleted: !!server.deleted, held: false };
    outbox.set(id, entry);
    mem.set(id, rec);
    t.objectStore('outbox').put(entry);
    t.objectStore('records').put(rec);
    await done(t);
    broadcast({ t: 'outbox', put: [entry] });
  }
  emit();
  sync();
}

export async function resolveAll(choice) {
  for (const c of conflicts()) await resolveConflict(c.id, choice);
}

// ── сеть ──
export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

// Запрос к API. Адрес сервера — «свой» origin или выбранное зеркало (meta api_base): origin PWA
// не меняем никогда (к нему привязаны IndexedDB и кэш оболочки), меняется только адрес API.
// На зеркало cookie не уходят — там авторизует токен устройства (Authorization: Bearer).
export async function api(path, body, method, retried) {
  const base = apiBase();
  if (base) {
    checkHome();
    // после перезагрузки зеркало заново доказывает, что это наш сервер, — только потом токен
    if (!(await verifyMirror(base).catch(() => false))) return apiFailover(path, body, method, retried);
  }
  const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
  const tok = getMeta('device_token');
  // на свой origin токен тоже шлём: по нему сервер отзывает токен при выходе
  if (tok) headers.Authorization = 'Bearer ' + tok;
  let resp;
  try {
    resp = await fetch(base + path, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: base ? 'omit' : 'same-origin', cache: 'no-store',
    });
  } catch (e) {
    return apiFailover(path, body, method, retried);
  }
  let data = null;
  try { data = await resp.json(); } catch (e) { /* пустой ответ */ }
  if (data && data.error === 'offline') return apiFailover(path, body, method, retried);
  state.online = true;
  if (!resp.ok) throw new ApiError((data && data.detail) || `Ошибка ${resp.status}`, resp.status);
  if (data && data.device_token) await setMeta('device_token', data.device_token);
  if (path === '/api/config' && data) { configAsked = true; rememberConfig(data); }
  else if (!configAsked) { configAsked = true; api('/api/config').catch(() => { configAsked = false; }); }   // список зеркал — раз за запуск
  // вошли раньше, чем появились зеркала: токен устройства берём один раз, пока свой адрес жив
  if (!base && !tok && me() && !tokenAsked) {
    tokenAsked = true;
    api('/api/auth/device', {}).catch(() => { tokenAsked = false; });
  }
  return data;
}

async function apiFailover(path, body, method, retried) {
  state.online = false; emit();
  if (!retried) {
    const alt = await findAlive();
    if (alt !== null && alt !== apiBase()) {
      await setMeta('api_base', alt);
      return api(path, body, method, true);
    }
  }
  throw new ApiError('Нет связи с сервером', 0);
}

// ── зеркала: другие адреса того же сервера ──
// Источник списка — /api/config (mDNS, IP в сети, адрес в интернете) плюс адреса, введённые вручную.
// Живое зеркало ищем при обрыве связи: сначала свой origin, иначе самое быстрое из ответивших.
let tokenAsked = false, configAsked = false, probing = null, lastProbeFail = 0, lastHomeCheck = 0;
const status = new Map();        // url → { ok, ms, at, error }
const verified = new Set();      // зеркала, доказавшие, что это наш сервер (им можно отдать токен)

export function apiBase() { return getMeta('api_base', ''); }
export function usingMirror() { return !!apiBase(); }

function defaultPort() {
  const m = (getMeta('mirrors_server', []).find(x => x.kind !== 'wan') || {}).url || '';
  return (m.match(/:(\d+)$/) || [])[1] || '8790';
}

// «192.168.1.50» → https://192.168.1.50:8790; путь и лишний слэш отбрасываем
export function normMirror(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  const hadScheme = v.includes('://');
  if (!hadScheme) v = 'https://' + v;
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  if (!hadScheme && !u.port && !u.hostname.endsWith('.trycloudflare.com')) u.port = defaultPort();
  return u.origin;
}

export function mirrors() {
  const own = location.origin;
  const out = [{ url: own, kind: 'origin', manual: false }];
  const seen = new Set([own]);
  for (const m of getMeta('mirrors_server', [])) if (!seen.has(m.url)) { seen.add(m.url); out.push({ ...m, manual: false }); }
  for (const url of getMeta('mirrors_manual', [])) if (!seen.has(url)) { seen.add(url); out.push({ url, kind: 'manual', manual: true }); }
  const cur = apiBase() || own;
  return out.map(m => ({ ...m, current: m.url === cur, status: status.get(m.url) || null }));
}

// копия списка для страницы «Сервер недоступен» из SW: у неё нет доступа к нашей IndexedDB
function mirrorLocal() {
  try { localStorage.setItem('trainer_mirrors', JSON.stringify(mirrors().map(m => m.url).filter(u => u !== location.origin))); } catch (e) { /* приватный режим */ }
}

async function rememberConfig(cfg) {
  if (cfg.server_id && !apiBase()) await setMeta('server_id', cfg.server_id);
  if (Array.isArray(cfg.mirrors)) {
    // адрес туннеля меняется при каждом запуске: старые wan-адреса выбрасываем, чтобы не копились
    await setMeta('mirrors_server', cfg.mirrors.filter(m => m && /^https?:\/\//.test(m.url)));
    mirrorLocal();
  }
}

export async function addMirror(raw) {
  const url = normMirror(raw);
  if (!url) throw new ApiError('Не похоже на адрес. Пример: 192.168.1.50 или https://имя.local:8790', 400);
  const list = getMeta('mirrors_manual', []);
  if (!list.includes(url) && !mirrors().some(m => m.url === url)) await setMeta('mirrors_manual', [...list, url]);
  mirrorLocal(); emit();
  return url;
}

export async function removeMirror(url) {
  await setMeta('mirrors_manual', getMeta('mirrors_manual', []).filter(u => u !== url));
  if (apiBase() === url) await setMeta('api_base', '');
  mirrorLocal(); emit();
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }

// Зеркало должно доказать, что знает хэш нашего токена устройства: иначе по опечатке в адресе
// токен ушёл бы чужому серверу.
const verifying = new Map();
function verifyMirror(url) {
  if (verified.has(url)) return Promise.resolve(true);
  if (!verifying.has(url)) verifying.set(url, doVerify(url).finally(() => verifying.delete(url)));
  return verifying.get(url);
}
async function doVerify(url) {
  const tok = getMeta('device_token');
  if (!tok || !crypto.subtle) return false;
  const th = await sha256hex(tok);
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const r = await fetch(url + '/api/auth/device/prove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', cache: 'no-store',
    body: JSON.stringify({ id: th.slice(0, 16), nonce }), signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) return false;
  const { proof } = await r.json();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(th), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const ok = proof === hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(nonce)));
  if (ok) verified.add(url);
  return ok;
}

// одна проверка: /api/version за 2 с, тот же server_id, для чужого origin — ещё и доказательство
async function probe(url) {
  const own = url === location.origin;
  const t0 = performance.now();
  let st;
  try {
    const r = await fetch((own ? '' : url) + '/api/version', { cache: 'no-store', credentials: own ? 'same-origin' : 'omit', signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    if (!r.ok || !d.version) throw new Error('нет ответа');
    const ms = Math.round(performance.now() - t0);
    const sid = getMeta('server_id');
    if (sid && d.server && d.server !== sid) st = { ok: false, ms, error: 'другой сервер' };
    else if (!own && !(await verifyMirror(url).catch(() => false))) {
      st = { ok: false, ms, error: getMeta('device_token') ? 'не подтвердил, что это ваш сервер' : 'войдите заново, чтобы пользоваться зеркалами' };
    } else st = { ok: true, ms };
  } catch (e) {
    st = { ok: false, ms: null, error: e.name === 'TimeoutError' ? 'не отвечает' : 'недоступен' };
  }
  status.set(url, { ...st, at: Date.now() });
  return st;
}

export async function probeMirrors() {
  const list = mirrors();
  await Promise.all(list.map(m => probe(m.url)));
  emit();
  return mirrors();
}

// лучший живой адрес: '' (свой origin), URL зеркала или null, если не отвечает никто
function findAlive() {
  if (probing) return probing;
  if (Date.now() - lastProbeFail < 15000) return Promise.resolve(null);   // не штурмуем сеть, пока офлайн
  probing = (async () => {
    const list = await probeMirrors();
    if (list[0].status?.ok) return '';
    const alive = list.filter(m => m.status?.ok).sort((a, b) => a.status.ms - b.status.ms);
    if (!alive.length) { lastProbeFail = Date.now(); return null; }
    return alive[0].url;
  })().finally(() => { probing = null; });
  return probing;
}

// на зеркале раз в минуту проверяем свой origin: вернулся — возвращаемся к нему (там cookie и SW)
function checkHome() {
  if (Date.now() - lastHomeCheck < 60000) return;
  lastHomeCheck = Date.now();
  probe(location.origin).then(st => { if (st.ok && apiBase()) setMirror(''); });
}

// выбрать адрес вручную; зеркало проверяем до того, как отдать ему токен
export async function setMirror(url) {
  const target = !url || url === location.origin ? '' : url;
  if (target) {
    const st = await probe(target);
    if (!st.ok) { emit(); throw new ApiError(`Адрес ${target} ${st.error || 'недоступен'}`, 0); }
  }
  await setMeta('api_base', target);
  lastProbeFail = 0;
  emit();
  return target;
}

// Приложение сворачивают или закрывают: iOS может выгрузить PWA раньше, чем пройдёт обычный обмен.
// Запрос с keepalive браузер дошлёт и после выгрузки страницы. Ответ не ждём: сервер применит правки,
// а подтверждения придут при следующем обмене (повтор тех же правок сервер узнаёт и не дублирует).
export function flushOnExit() {
  if (!me()) return;
  const entries = [...outbox.values()].filter(e => !e.held);
  if (!entries.length) return;
  const body = JSON.stringify({ ops: entries.map(opOf), since: getMeta('cursor', 0) });
  if (body.length > 60000) return;           // лимит keepalive-запроса ~64 КБ; большое уйдёт обычным обменом
  const base = apiBase(), headers = { 'Content-Type': 'application/json' }, tok = getMeta('device_token');
  if (tok) headers.Authorization = 'Bearer ' + tok;
  try {
    fetch(base + '/api/sync', { method: 'POST', keepalive: true, headers, body, credentials: base ? 'omit' : 'same-origin' }).catch(() => {});
  } catch (e) { /* браузер не умеет keepalive — правки уйдут при следующем открытии */ }
}

function opOf(e) {
  const op = { ...e.rec };
  delete op.rev;
  if (e.base_rev !== undefined) op.base_rev = e.base_rev;
  return op;
}

async function syncOnce() {
  let rounds = 0, more = true;
  while (more && rounds++ < 20) {
    const entries = [...outbox.values()].filter(e => !e.held);
    const sent = new Map(entries.map(e => [e.id, e.rec.updated_at]));
    const res = await api('/api/sync', { ops: entries.map(opOf), since: getMeta('cursor', 0) });
    const t = tx(['records', 'outbox'], 'readwrite');
    const bRecs = [], bPut = [], bDel = [];
    const revs = res.revs || {};

    // принятые: убираем из outbox, если с тех пор не правили; иначе новая база — принятая версия
    for (const id of res.applied || []) {
      const e = outbox.get(id);
      if (!e) continue;
      const rev = revs[id];
      if (e.rec.updated_at === sent.get(id)) {
        outbox.delete(id); t.objectStore('outbox').delete(id); bDel.push(id);
        const rec = { ...e.rec, ...(rev ? { rev } : {}) };
        mem.set(id, rec); t.objectStore('records').put(rec); bRecs.push(rec);
      } else if (rev) {
        const sentEntry = entries.find(x => x.id === id);
        const ne = { ...e, base_rev: rev, base: clone(sentEntry?.rec.data ?? null), base_deleted: !!sentEntry?.rec.deleted };
        outbox.set(id, ne); t.objectStore('outbox').put(ne); bPut.push(ne);
      }
    }
    for (const id of res.rejected || []) {
      const e = outbox.get(id);
      if (e && e.rec.updated_at === sent.get(id)) { outbox.delete(id); t.objectStore('outbox').delete(id); bDel.push(id); }
    }

    // конфликты: сливаем сами, спорное — откладываем до решения пользователя
    let again = false;
    for (const { id, server } of res.conflicts || []) {
      const e = outbox.get(id);
      if (!e) continue;
      const m = mergeRecord(e, server);
      if (!m.conflicts.length) {
        const rec = { ...e.rec, data: m.data, deleted: m.deleted, updated_at: Date.now() };
        const ne = { id, rec, base_rev: server.rev, base: clone(server.data), base_deleted: !!server.deleted, held: false };
        outbox.set(id, ne); mem.set(id, rec);
        t.objectStore('outbox').put(ne); t.objectStore('records').put(rec); bPut.push(ne);
        again = true;
      } else {
        const ne = { ...e, held: true, conflict: { server, fields: m.conflicts.map(c => ({ path: c.path, local: c.local, server: c.server })), deletion: !!m.deletion } };
        outbox.set(id, ne); t.objectStore('outbox').put(ne); bPut.push(ne);
      }
    }

    for (const r of res.changes || []) {
      if (outbox.has(r.id)) continue;           // своя неотправленная правка важнее — её сольёт следующий обмен
      mem.set(r.id, r); t.objectStore('records').put(r); bRecs.push(r);
    }
    await done(t);
    if (bRecs.length) broadcast({ t: 'recs', recs: bRecs });
    if (bPut.length || bDel.length) broadcast({ t: 'outbox', put: bPut, del: bDel });
    await setMeta('cursor', res.cursor);
    more = res.more || again;
  }
}

export function sync() {
  if (!me()) return Promise.resolve();
  if (syncing) { syncAgain = true; return syncing; }
  const run = async () => {
    state.syncing = true; emit();
    try {
      await syncOnce();
      state.lastSync = Date.now();
      state.error = null;
    } catch (e) {
      state.error = e.message;
      if (e.status === 401) { await setMeta('me', null); location.reload(); }
    } finally {
      state.syncing = false;
    }
  };
  syncing = (async () => {
    try {
      // в нескольких вкладках одного браузера обменивается с сервером только одна
      if (navigator.locks?.request) await navigator.locks.request('trainer-sync', run);
      else await run();
    } finally {
      syncing = null;
      emit();
      if (syncAgain) { syncAgain = false; setTimeout(sync, 50); }
    }
  })();
  return syncing;
}

// полный сброс локальных данных (выход из аккаунта)
export async function wipe() {
  mem.clear(); outbox.clear();
  for (const k of Object.keys(meta)) delete meta[k];
  const t = tx(['records', 'outbox', 'meta'], 'readwrite');
  ['records', 'outbox', 'meta'].forEach(s => t.objectStore(s).clear());
  await done(t);
}
