// Справочник продуктов на клиенте: копия общего справочника в IndexedDB (meta 'foods'), поиск без сети,
// свои продукты (без сети — в очереди meta 'foods_pending', пока сервер их не примет), история по записям еды.
import * as store from './store.js';

export const STATES = [['dry', 'сухой'], ['raw', 'сырой'], ['cooked', 'готовый'], ['as_sold', 'как продаётся'], ['fresh', 'свежий']];
// полными словами: сокращения на телефоне не расшифровать — подсказка по наведению там не всплывает
export const STATE_SHORT = { dry: 'сухой', raw: 'сырой', cooked: 'готовый', as_sold: 'как в упаковке', fresh: 'свежий' };
export const STATE_HINT = { dry: 'сухой, до варки', raw: 'сырой, до готовки', cooked: 'готовый', as_sold: 'как продаётся', fresh: 'свежий' };

let byId = null;            // id → продукт
let keyed = [];             // [{f, words, stems, full}] для поиска
let byName = new Map();     // нормализованное имя → продукт
let lastRefresh = 0, refreshing = null;

export const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}%.,\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
const ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю',
  'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь'];
export function stem(w) {
  if (w.length <= 3) return w;
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
  return w;
}

function build() {
  const cache = store.getMeta('foods', null);
  const pending = store.getMeta('foods_pending', []);
  byId = new Map();
  for (const f of cache?.items || []) byId.set(f.id, f);
  for (const p of pending) byId.set(p.id, p);
  keyed = [];
  byName = new Map();
  for (const f of byId.values()) {
    const names = [f.name, ...(f.aliases || []), f.brand ? `${f.brand} ${f.name}` : ''].filter(Boolean).map(norm);
    const words = [...new Set(names.join(' ').split(' ').filter(Boolean))];
    keyed.push({ f, names, words, stems: words.map(stem), brandWords: f.brand ? norm(f.brand).split(' ').filter(Boolean) : null });
    for (const n of names) if (!byName.has(n)) byName.set(n, f);
  }
}
function ensure() { if (!byId) { build(); usageCache = null; } }

export function count() { ensure(); return byId.size; }
export function get(id) { ensure(); return byId.get(id) || null; }
export function findByName(name) { ensure(); return byName.get(norm(name)) || null; }
export const isMine = f => !!f && f.created_by === store.uid() && f.source !== 'seed' && f.source !== 'off';
export const isStore = f => f?.source === 'off';    // товар из магазина (Open Food Facts)

// ── история: что человек ест, по его записям еды (работает без сети) ──
let usageCache = null, usageKey = '';
export function usage() {
  ensure();
  const recs = store.list('food');
  const key = recs.length + ':' + recs.reduce((a, r) => Math.max(a, r.updated_at || 0), 0);
  if (usageCache && key === usageKey) return usageCache;
  const u = new Map();
  for (const r of recs) {
    for (const it of r.data.items || []) {
      const f = (it.food_id != null && byId.get(it.food_id)) || byName.get(norm(it.name));
      if (!f) continue;
      const cur = u.get(f.id) || { count: 0, last_grams: null, last_used: '' };
      cur.count++;
      const d = r.date || '';
      if (d >= cur.last_used) { cur.last_used = d; cur.last_grams = it.grams; }
      u.set(f.id, cur);
    }
  }
  usageCache = u; usageKey = key;
  return u;
}

// недавние и частые: сначала последние по дате, дальше — самые частые
export function recent(limit = 12) {
  const u = usage();
  const arr = [...u.entries()].filter(([id]) => byId.get(id)).map(([id, s]) => ({ food: byId.get(id), ...s }));
  const byDate = [...arr].sort((a, b) => b.last_used.localeCompare(a.last_used) || b.count - a.count);
  const top = byDate.slice(0, Math.ceil(limit * 2 / 3));
  const rest = arr.filter(x => !top.includes(x)).sort((a, b) => b.count - a.count);
  const mine = [...byId.values()].filter(f => isMine(f) && !u.has(f.id)).map(f => ({ food: f, count: 0, last_grams: null, last_used: '' }));
  return [...top, ...rest, ...mine].slice(0, limit);
}

// ── поиск ──
// Ранжирование: своё и частое → точное совпадение → начало названия → все слова по префиксу → по основам;
// на короткий общий запрос («крупа», «рыба») поднимаются усреднённые продукты «≈ в среднем».
export function search(query, { limit = 30 } = {}) {
  ensure();
  const q = norm(query);
  if (!q) return [];
  const qw = q.split(' ').filter(Boolean);
  const qs = qw.map(stem);
  const u = usage();
  const broad = qw.length === 1 && q.length >= 3;
  const out = [];
  for (const k of keyed) {
    let s = 0;
    if (k.names.includes(q)) s = 100;
    else if (k.names.some(n => n.startsWith(q))) s = 70;
    else if (qw.every(w => k.words.some(x => x.startsWith(w)))) s = 50;
    else if (qs.every(w => k.stems.some(x => x.startsWith(w) || (x.length >= 4 && w.startsWith(x))))) s = 30;
    else if (q.length >= 3 && k.names.some(n => n.includes(q))) s = 15;
    if (!s) continue;
    const us = u.get(k.f.id);
    if (us) s += 40 + Math.min(us.count, 10) * 3;
    if (isMine(k.f)) s += 8;
    if (k.f.generic && broad) s += 12;
    // товары из магазина - ниже обычных продуктов, но выше всех, если в запросе есть их бренд
    if (k.f.source === 'off') s += k.brandWords?.some(b => qw.some(w => w.length >= 3 && b.startsWith(w))) ? 10 : -8;
    if (k.f.name.length > 40) s -= 3;
    out.push([s, k.f]);
  }
  out.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
  return out.slice(0, limit).map(x => x[1]);
}

// ── расчёт ──
export function macrosFor(food, grams) {
  const k = (Number(grams) || 0) / 100;
  return { kcal: Math.round((food.kcal || 0) * k), p: r1((food.p || 0) * k), f: r1((food.f || 0) * k), c: r1((food.c || 0) * k) };
}
const r1 = x => Math.round(x * 10) / 10;

export function itemFor(food, grams) {
  const it = { food_id: food.id, name: food.name, grams: Math.round(Number(grams) || 0), ...macrosFor(food, grams), source: 'db' };
  if (food.state) it.state = food.state;
  return it;
}

// порции продукта: [['1 шт', 55], ['ст.л.', 25], …]
export function portions(food) {
  return Object.entries(food?.portions || {}).filter(([, g]) => Number(g) > 0).map(([k, g]) => [k === 'шт' ? '1 шт' : k, Number(g)]);
}

// 4б + 4у + 9ж против ккал: доля расхождения или null
export function energyMismatch(v) {
  const est = 4 * (+v.p || 0) + 4 * (+v.c || 0) + 9 * (+v.f || 0), kcal = +v.kcal || 0;
  if (Math.max(kcal, est) < 25) return null;
  return Math.abs(kcal - est) / Math.max(kcal, est, 1);
}

// ── синхронизация справочника ──
async function saveCache(items, ts) {
  await store.setMeta('foods', { items, ts });
  byId = null;
}

export async function refresh(force = false) {
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefresh < 5 * 60e3 && store.getMeta('foods')) return;
  refreshing = (async () => {
    try {
      await pushPending();
      const cache = store.getMeta('foods', null);
      const since = cache?.ts && !force ? cache.ts : 0;
      const res = await store.api(`/api/foods/all${since ? `?since=${since}` : ''}`);
      if (res.full || !cache) await saveCache(res.foods, res.now);
      else if (res.foods.length || res.deleted.length) {
        const m = new Map(cache.items.map(f => [f.id, f]));
        for (const id of res.deleted) m.delete(id);
        for (const f of res.foods) m.set(f.id, f);
        await saveCache([...m.values()], res.now);
      } else await store.setMeta('foods', { ...cache, ts: res.now });
      lastRefresh = Date.now();
    } catch (e) { /* без сети — работаем с кэшем */ } finally { refreshing = null; }
  })();
  return refreshing;
}

// положить продукт в локальный кэш сразу после ответа сервера (не дожидаясь refresh)
export async function upsertLocal(f) {
  const cache = store.getMeta('foods', null) || { items: [], ts: 0 };
  const items = cache.items.filter(x => x.id !== f.id);
  items.push(f);
  await saveCache(items, cache.ts);
}
export async function removeLocal(id) {
  const cache = store.getMeta('foods', null);
  if (cache) await saveCache(cache.items.filter(x => x.id !== id), cache.ts);
}

// ── свои продукты ──
// save(): онлайн — POST /api/foods; ответ {need_confirm, warnings} возвращается вызывающему (он спросит человека
// и повторит с force). Без сети — продукт сразу доступен локально (id 'tmp-…') и уйдёт на сервер позже.
export async function save(fields, { force = false, id = null } = {}) {
  const body = { ...fields, force };
  if (store.state.online) {
    try {
      const res = await store.api(id ? `/api/foods/${id}` : '/api/foods', body, id ? 'PUT' : 'POST');
      if (res.ok) await upsertLocal(res.food);
      return res;
    } catch (e) {
      if (e.status !== 0) throw e;
    }
  }
  if (id && typeof id === 'number') throw new Error('Править продукт можно, когда есть связь с сервером');
  const pending = store.getMeta('foods_pending', []);
  const tmp = { ...fields, id: id || 'tmp-' + store.newId().slice(0, 12), created_by: store.uid(), source: fields.source || 'manual', pending: true };
  await store.setMeta('foods_pending', [...pending.filter(p => p.id !== tmp.id), tmp]);
  byId = null;
  return { ok: true, food: tmp, offline: true };
}

export async function remove(id) {
  if (String(id).startsWith('tmp-')) {
    await store.setMeta('foods_pending', store.getMeta('foods_pending', []).filter(p => p.id !== id));
    byId = null;
    return;
  }
  await store.api(`/api/foods/${id}`, undefined, 'DELETE');
  await removeLocal(id);
}

// отправить продукты, созданные без сети; ссылки food_id в записях еды заменить на настоящие id
export async function pushPending() {
  const pending = store.getMeta('foods_pending', []);
  if (!pending.length || !store.state.online) return;
  for (const p of pending) {
    const { id, pending: _, created_by, ...fields } = p;
    let res;
    try {
      res = await store.api('/api/foods', { ...fields, force: true });
    } catch (e) {
      if (e.status === 0) return;
      if (e.status === 409) {
        // имя занято чужим продуктом — сохраняем со своей пометкой
        try { res = await store.api('/api/foods', { ...fields, name: `${fields.name} (${fields.brand || 'своё'})`.slice(0, 80), force: true }); }
        catch (e2) { if (e2.status === 0) return; res = null; }
      } else res = null;
    }
    if (res?.ok) {
      await upsertLocal(res.food);
      for (const r of store.list('food')) {
        const items = r.data.items || [];
        if (items.some(it => it.food_id === id)) {
          await store.patch(r.id, { items: items.map(it => it.food_id === id ? { ...it, food_id: res.food.id, name: res.food.name } : it) });
        }
      }
    }
    await store.setMeta('foods_pending', store.getMeta('foods_pending', []).filter(x => x.id !== id));
    byId = null;
  }
}
