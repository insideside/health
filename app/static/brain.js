// «Мозг» на клиенте: копия обезличенной памяти знаний сервера (meta 'brain'), поиск по ней без сети,
// отправка поправок человека и раздел профиля «Данные и приватность».
// Знания: food_phrase «тарелка борща» → [{food_id, g}], food_alias «гречневая каша» → food_id,
// portion «{food_id}|{единица}» → граммы, activity_alias, exercise_swap. Формат — app/brain.py.
import * as store from './store.js';
import { esc, num, toast, S } from './ui.js';

export const MIN_USE = 0.5;        // с этой уверенности знание применяется (как на сервере)
let lastRefresh = 0, refreshing = null;

const cache = () => store.getMeta('brain', null);     // { items: { kind: { key: [value, conf] } }, ts }

export function count() {
  const c = cache();
  return c ? Object.values(c.items || {}).reduce((a, m) => a + Object.keys(m).length, 0) : 0;
}

// знание, если ему уже можно верить; minConf — для случаев, где нужна большая уверенность (порции поверх справочника)
export function lookup(kind, key, minConf = MIN_USE) {
  const e = cache()?.items?.[kind]?.[key];
  return e && e[1] >= minConf ? { value: e[0], conf: e[1] } : null;
}
export const phrase = key => lookup('food_phrase', key)?.value || null;
export const alias = key => lookup('food_alias', key)?.value?.food_id ?? null;
export const portion = (foodId, unit, minConf) => lookup('portion', `${foodId}|${unit}`, minConf)?.value?.g ?? null;
export const activityAlias = s => lookup('activity_alias', String(s || '').toLowerCase().trim())?.value?.type || null;
export const exerciseSwap = id => lookup('exercise_swap', id)?.value?.to || null;

// ── синхронизация: дельта по времени изменения, как у справочника продуктов ──
export async function refresh(force = false) {
  if (refreshing) return refreshing;
  if (!store.state.online || (!force && Date.now() - lastRefresh < 60e3 && cache())) return;
  refreshing = (async () => {
    try {
      await flushFeedback();
      const c = cache();
      const since = c?.ts && !force ? c.ts : 0;
      const res = await store.api(`/api/brain${since ? `?since=${since}` : ''}`);
      const items = res.full || !c ? {} : structuredClone(c.items || {});
      for (const [kind, key] of res.deleted || []) if (items[kind]) delete items[kind][key];
      for (const [kind, key, value, conf] of res.items || []) (items[kind] ||= {})[key] = [value, conf];
      await store.setMeta('brain', { items, ts: res.now });
      lastRefresh = Date.now();
    } catch (e) { /* без сети — работаем с тем, что есть */ } finally { refreshing = null; }
  })();
  return refreshing;
}

// ── поправки человека: без сети копятся в meta 'brain_fb' и уходят при подключении ──
export async function feedback(kind, key, value, signal = 'correct') {
  if (!key) return;
  const q = store.getMeta('brain_fb', []).filter(x => !(x.kind === kind && x.key === key));
  await store.setMeta('brain_fb', [...q, { kind, key, value, signal }].slice(-50));
  // своё устройство учится сразу, не дожидаясь сервера
  const c = cache() || { items: {}, ts: 0 };
  const cur = c.items?.[kind]?.[key];
  if (signal === 'correct') {
    const items = structuredClone(c.items || {});
    (items[kind] ||= {})[key] = [value, Math.max(cur?.[1] || 0, 0.6)];
    await store.setMeta('brain', { ...c, items });
  }
  if (store.state.online) flushFeedback();
}

let flushing = false;
async function flushFeedback() {
  if (flushing || !store.state.online) return;
  flushing = true;
  try {
    for (const fb of store.getMeta('brain_fb', [])) {
      try { await store.api('/api/brain/feedback', fb); }
      catch (e) { if (e.status === 0) return; /* 400 — сервер не принял (не про еду): просто забываем */ }
      await store.setMeta('brain_fb', store.getMeta('brain_fb', []).filter(x => !(x.kind === fb.kind && x.key === fb.key && x.signal === fb.signal)));
    }
  } finally { flushing = false; }
}

// Человек поменял граммы позиции: если позиция из памяти/ИИ по фразе — поправка фразы (все позиции этой фразы),
// если из порции («тарелка», «кусок») — поправка порции. Явные граммы («гречка 200 г») не учим.
export function gramsEdited(items, i) {
  const it = items[i];
  if (!it || !(it.grams > 0)) return;
  const pn = Number(it.pn) || 1;
  if (it.phrase) {
    const same = items.filter(x => x.phrase === it.phrase && typeof x.food_id === 'number' && x.grams > 0);
    if (same.length) feedback('food_phrase', it.phrase, { items: same.map(x => ({ food_id: x.food_id, g: Math.round(x.grams / pn * 1e4) / 1e4 })) });
  } else if (it.pu && typeof it.food_id === 'number') {
    feedback('portion', `${it.food_id}|${it.pu}`, { g: Math.round(it.grams / pn * 10) / 10 });
  }
}

// ── раздел профиля «Данные и приватность» ──
let settings = null, settingsLoading = false;
async function loadSettings() {
  if (settingsLoading || !store.state.online) return;
  settingsLoading = true;
  try { settings = await store.api('/api/brain/settings'); S.render(); }
  catch (e) { settings = settings || { error: e.status === 404 ? 'old' : 'offline' }; }
  finally { settingsLoading = false; }
}

export function privacySummary() {
  const share = !!(store.get(`profile:${store.uid()}`)?.data?.share_stats);
  return `${share ? 'статистикой делюсь' : 'статистикой не делюсь'} · память ${num(count())}`;
}

export function privacyBody() {
  if (!settings && !settingsLoading) loadSettings();
  const share = !!(store.get(`profile:${store.uid()}`)?.data?.share_stats);
  const st = settings && !settings.error ? settings : null;
  return `<div class="br-priv">
    <p class="note">Всё хранится на этом компьютере. Локальная ИИ работает на нём же${st && !st.ollama_local ? ' - <b class="err">но адрес модели задан не локальный, проверьте OLLAMA_URL</b>' : ''} и никуда данные не передаёт.
      Партнёр видит только оценку дня, опыт и достижения (и то, что вы включили в «Соревновании»).</p>
    <label class="chk pf-chk"><input type="checkbox" data-act="br-share" ${share ? 'checked' : ''}>Делиться обезличенной статистикой</label>
    <p class="note">Недельные цифры без имени - сон, шаги, тренировки, белок, изменения веса и замеров - попадут в общие выводы
      «что на что влияет» у людей вашего типа. Другие не увидят ваших записей: только средние по группе от 3 человек.
      Сравнение с другими доступно тем, кто делится.</p>
    <label class="chk pf-chk"><input type="checkbox" data-act="br-web" ${st?.web_lookup ? 'checked' : ''} ${!st || st.web_forced_off ? 'disabled' : ''}>Искать продукты в интернете (Open Food Facts)</label>
    <p class="note">${st?.web_forced_off ? 'Выключено на сервере (TRAINER_NO_WEB=1).' : !st ? (store.state.online ? 'Загружаю настройки сервера…' : 'Настройка доступна, когда есть связь с сервером.') : ''}
      При поиске уходит только название продукта, без данных о вас. Настройка общая для всех на этом сервере.</p>
    <label class="chk pf-chk"><input type="checkbox" data-act="br-weather" ${st?.weather ? 'checked' : ''} ${!st || st.web_forced_off || st.weather === undefined ? 'disabled' : ''}>Погода для «Сегодня» (Open-Meteo)</label>
    <p class="note">Сервер спрашивает прогноз по координатам города из профиля («Кардио» → «Город для погоды») - только координаты, без имени и записей.
      Без погоды тренер выбирает место для кардио по сезону.</p>
    <p class="note">Память тренера: ${num(count())} ${plural(count())} - разобранные ИИ фразы («тарелка борща»), синонимы и порции.
      Общая для всех устройств и без личных данных: благодаря ей еда считается без ИИ, даже без сети.</p></div>`;
}
const plural = n => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'знание' : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 'знания' : 'знаний'; };

export async function setShareStats(on) {
  const id = `profile:${store.uid()}`;
  if (store.get(id)) await store.patch(id, { share_stats: !!on });
  else await store.put('profile', id, { share_stats: !!on });
  toast(on ? 'Спасибо! Ваши обезличенные недели попадут в общую статистику' : 'Статистика больше не участвует в общих выводах');
  S.render();
}

export async function setWeather(on) {
  try {
    settings = await store.api('/api/brain/settings', { weather: !!on });
    await store.setMeta('weather_off', !on);
    toast(on ? 'Погода включена' : 'Сервер больше не спрашивает погоду');
  } catch (e) { toast(e.status === 0 ? 'Нужна связь с сервером' : e.message); }
  S.render();
}

export async function setWebLookup(on) {
  try {
    settings = await store.api('/api/brain/settings', { web_lookup: !!on });
    toast(on ? 'Поиск продуктов в интернете включён' : 'Сервер больше не ходит в интернет');
  } catch (e) { toast(e.status === 0 ? 'Нужна связь с сервером' : e.message); }
  S.render();
}

// обработчики для экрана профиля (подключаются в views/profile.js → changes)
export const changes = {
  'br-share': el => setShareStats(el.checked),
  'br-web': el => setWebLookup(el.checked),
  'br-weather': el => setWeather(el.checked),
};

// Стили блоков «мозга» (анализ, пометки расчёта еды, приватность): свои файлы стилей у других агентов,
// поэтому держим их здесь, только на токенах «Стенограммы».
if (typeof document !== 'undefined' && !document.getElementById('brain-css')) {
  const st = document.createElement('style');
  st.id = 'brain-css';
  st.textContent = `
.an-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.an-i{padding:10px 12px;border-left:3px solid var(--rule);background:var(--sheet-2);border-radius:var(--r-sm);min-width:0}
.an-i.an-strong{border-left-color:var(--accent)}.an-i.an-moderate{border-left-color:var(--accent-2)}
.an-h{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 8px;min-width:0}
.an-h b{min-width:0;overflow-wrap:anywhere}.an-h .smallcaps{flex:none;font-size:12px}
.an-i p{margin:4px 0 0;color:var(--ink-2)}
.an-few-l{margin:6px 0 0;padding:0 0 0 18px;color:var(--ink-3);font-size:14px}.an-few-l li{margin:3px 0}.an-few-l b{color:var(--ink-2);font-weight:600}
.an-e{display:flex;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;font-size:14px;min-width:0}
.an-e>span:first-child{min-width:0;overflow-wrap:anywhere}.an-e.an-strong>span:first-child{color:var(--ink-strong)}
.an-server{margin-top:14px;padding-top:10px;border-top:1px solid var(--rule-2)}
.an-group{margin-top:12px}.an-gt{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;margin-bottom:4px}
.an-actions{align-items:center;flex-wrap:wrap}.an-actions .btn{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry .tot .fd-calc{flex-basis:100%;font-family:var(--sans);font-size:12px;color:var(--ink-3)}
.src-brain{color:var(--ink-3);font-size:12px;margin-left:4px}
.br-priv .pf-chk{margin-top:10px}`;
  document.head.appendChild(st);
}
