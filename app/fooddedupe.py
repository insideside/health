"""Тихое объединение дублей в общем справочнике продуктов (таблица foods).

Справочник пополняют люди (source manual), ИИ (ai) и поиск в интернете (web) - копятся дубли:
«Йогурт Активиа лёгкая 1,5%» и «йогурт активиа легкая 1.5%», «Протеин Goku Gains» и «Протеин сывороточный
Goku Gains» с одинаковыми цифрами. Раз в сутки (и через минуту после старта сервера) они сливаются.

Дубль - пара, где хотя бы один продукт от людей/ИИ/интернета, и
  * названия совпадают после нормализации (регистр, ё/е, пунктуация, порядок слов, «1,5%» = «1.5%»,
    слова состояния, окончания) или набор слов одного содержится в другом (лишних не больше 2) при одном бренде
    (бренд - поле brand, латиница в названии или слово-бренд из товаров магазина);
  * цифры близки (websources.close: ккал ±12 %, Б/Ж/У ±3 г или 15 %);
  * состояние одинаковое, если указано у обоих (сухой и варёный - разные продукты; сырой = свежий).
Одинаковое название с разными цифрами не сливается (могут быть разные вкусы) - только в отчёт.

Кто остаётся: базовый (seed) или товар из магазина (off) - всегда, их не удаляем и друг с другом не сливаем;
дальше - больше использований в записях еды, проверенный (verified), старше. Слитый: deleted = 1,
merged_into = id оставшегося; его название и синонимы - в aliases оставшегося, порции (вес штуки) и бренд -
если у оставшегося нет. Ссылки перекидываются: items[].food_id в записях (еда, избранные блюда - любые записи,
где food_id числом), profile.pieces, знания «мозга» (food_alias, food_phrase, portion «{id}|единица»).
Журнал - meta food_dedupe_log (последние 200), отчёт последнего прохода - meta food_dedupe_report.

Без записи (посмотреть, что слилось бы): TRAINER_DATA=... uv run python -m app.fooddedupe --dry-run
"""
import asyncio
import json
import re
import sys

from . import db, food, websources

USER_SOURCES = ("manual", "ai", "web")
BASE_SOURCES = ("seed", "off")
LOG_KEY, REPORT_KEY, LOG_MAX = "food_dedupe_log", "food_dedupe_report", 200
LAT = re.compile(r"[a-z][a-z0-9-]{2,}")
EN_RU = {en: food.stem(ru) for ru, en in websources.SAME.items()}      # protein → протеин
STATE_CLASS = {"fresh": "raw"}                                          # свежий = сырой
MAX_EXTRA = 2                                                           # слов уточнения в более длинном названии


# ── названия ──

def _prep(s: str) -> str:
    s = (s or "").lower().replace("ё", "е")
    s = re.sub(r"(\d)\s*,\s*(\d)", r"\1.\2", s)        # 1,5% → 1.5%
    s = re.sub(r"(\d)\s+%", r"\1%", s)
    s = re.sub(r"(\d)\.0+(?!\d)", r"\1", s)              # 5.0% → 5%
    return s


def _bag(s: str) -> frozenset:
    words = food.base_name(_prep(s)).split()
    return frozenset(EN_RU.get(w, w) for w in words if w not in food.STOP and not w.isdigit() and len(w) > 1)


def _state(f: dict) -> str | None:
    st = f.get("state") or db.guess_state(f["name"], f.get("group"))
    return STATE_CLASS.get(st, st)


class Item:
    __slots__ = ("f", "name_bag", "full", "brand", "state", "base")

    def __init__(self, f: dict, brands: frozenset):
        self.f = f
        self.name_bag = _bag(f["name"])
        bb = _bag(f.get("brand") or "")
        self.full = self.name_bag | bb
        lat = {food.stem(w) for w in LAT.findall(_prep(f["name"])) if w not in EN_RU}
        self.brand = bb | lat | (self.name_bag & brands)
        self.state = _state(f)
        self.base = f.get("source") in BASE_SOURCES


def same_name(a: Item, b: Item) -> bool:
    if not a.name_bag or not b.name_bag:
        return False
    return a.name_bag == b.name_bag or a.full == b.full


def sub_name(a: Item, b: Item) -> bool:
    """Набор слов одного внутри другого при одном бренде; в меньшем есть и слово о самом продукте."""
    brand = a.brand | b.brand
    if not brand or not a.brand <= b.full or not b.brand <= a.full:
        return False
    small, big = (a.full, b.full) if len(a.full) <= len(b.full) else (b.full, a.full)
    # уточнение небольшое («сывороточный»), длинный хвост - уже другое блюдо или описание приёма пищи
    return small < big and len(big - small) <= MAX_EXTRA and bool(small - brand)


def states_ok(a: Item, b: Item) -> bool:
    return not a.state or not b.state or a.state == b.state


def close(a: Item, b: Item) -> bool:
    try:
        return websources.close(a.f, b.f)
    except (TypeError, KeyError):
        return False


# ── использование ──

def usage() -> dict[int, int]:
    """food_id → сколько раз встречается в строках записей еды (у всех людей)."""
    out: dict[int, int] = {}
    for r in db.q("SELECT data FROM records WHERE kind = 'food' AND deleted = 0"):
        try:
            items = json.loads(r["data"]).get("items") or []
        except ValueError:
            continue
        for it in items:
            fid = it.get("food_id") if isinstance(it, dict) else None
            if isinstance(fid, int):
                out[fid] = out.get(fid, 0) + 1
    return out


# ── поиск ──

def find() -> dict:
    """План слияния без записи: {merges: [{from, to, why}], conflicts: [{a, b, why}]}."""
    db.migrate_foods()
    foods = db.all_foods()
    brands = food.brand_words(foods)
    items = [Item(f, brands) for f in foods]
    users = [x for x in items if x.f["source"] in USER_SOURCES]
    bases = [x for x in items if x.base]
    by_word: dict[str, list[Item]] = {}
    for x in bases:
        for w in x.full:
            by_word.setdefault(w, []).append(x)
    use = usage()

    def rank(x: Item):                                   # меньше - главнее
        f = x.f
        return (0 if x.base else 1, -use.get(f["id"], 0), 0 if f.get("verified") else 1, f.get("created_at") or 0, f["id"])

    def why_of(a: Item, b: Item) -> str:
        return "то же название" if same_name(a, b) else "то же название с уточнением, тот же бренд"

    merges: list[dict] = []
    conflicts: list[dict] = []
    gone: set[int] = set()
    target: dict[int, Item] = {}                         # слитый → куда

    # 1. продукт людей/ИИ/интернета, совпадающий с базовым или товаром, - в базовый (ближайший по цифрам)
    for u in users:
        cand = {id(x): x for w in u.full for x in by_word.get(w, ())}.values()
        hits, diff = [], []
        for b in cand:
            if not states_ok(u, b):
                continue
            exact = same_name(u, b)
            if not exact and not sub_name(u, b):
                continue
            if close(u, b):
                hits.append((0 if exact else 1, abs(u.f["kcal"] - b.f["kcal"]), rank(b), b))
            elif exact:
                diff.append(b)
        if hits:
            b = min(hits, key=lambda h: h[:3])[3]
            target[u.f["id"]] = b
            gone.add(u.f["id"])
            merges.append({"from": _brief(u.f), "to": _brief(b.f), "why": why_of(u, b) + ", цифры близки"})
        elif diff:
            conflicts.append({"a": _brief(u.f), "b": _brief(diff[0].f), "why": "то же название, цифры разные"})

    # 2. между собой: группы похожих, остаётся главный по rank
    rest = [u for u in users if u.f["id"] not in gone]
    parent = {u.f["id"]: u.f["id"] for u in rest}

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, a in enumerate(rest):
        for b in rest[i + 1:]:
            if not states_ok(a, b):
                continue
            exact = same_name(a, b)
            if not exact and not sub_name(a, b):
                continue
            if close(a, b):
                parent[root(a.f["id"])] = root(b.f["id"])
            elif exact:
                conflicts.append({"a": _brief(a.f), "b": _brief(b.f), "why": "то же название, цифры разные"})
    groups: dict[int, list[Item]] = {}
    for u in rest:
        groups.setdefault(root(u.f["id"]), []).append(u)
    for g in groups.values():
        if len(g) < 2:
            continue
        g.sort(key=rank)
        keep = g[0]
        for x in g[1:]:
            # в группе по цепочке могли оказаться далёкие - сливаем только похожих на оставшийся
            if states_ok(x, keep) and close(x, keep) and (same_name(x, keep) or sub_name(x, keep)):
                merges.append({"from": _brief(x.f), "to": _brief(keep.f), "why": why_of(x, keep) + ", цифры близки"})
    return {"merges": merges, "conflicts": conflicts}


def _brief(f: dict) -> dict:
    return {"id": f["id"], "name": f["name"], "source": f["source"], "brand": f.get("brand"), "state": f.get("state"),
            "kcal": f["kcal"], "p": f["p"], "f": f["f"], "c": f["c"]}


# ── слияние ──

def merge(old_id: int, new_id: int) -> dict:
    """Слить продукт old_id в new_id и перекинуть ссылки. Вернёт счётчики перепривязки."""
    ts = db.now_ms()
    stats = {"records": 0, "knowledge": 0, "profiles": 0}
    with db.tx() as c:
        old = c.execute("SELECT * FROM foods WHERE id = ?", (old_id,)).fetchone()
        new = c.execute("SELECT * FROM foods WHERE id = ?", (new_id,)).fetchone()
        if not old or not new or old["deleted"] or new["deleted"] or old["source"] in BASE_SOURCES:
            return stats
        aliases = json.loads(new["aliases"] or "[]")
        have = {food.norm(new["name"]), *map(food.norm, aliases)}
        for a in [old["name"], *json.loads(old["aliases"] or "[]")]:
            na = food.norm(a)
            if na and na not in have:
                aliases.append(na)
                have.add(na)
        portions = json.loads(new["portions"] or "{}")
        for k, v in json.loads(old["portions"] or "{}").items():
            portions.setdefault(k, v)
        c.execute("UPDATE foods SET aliases = ?, portions = ?, brand = COALESCE(brand, ?), updated = ? WHERE id = ?",
                  (json.dumps(aliases[:30], ensure_ascii=False), json.dumps(portions, ensure_ascii=False),
                   old["brand"], ts, new_id))
        c.execute("UPDATE foods SET deleted = 1, merged_into = ?, updated = ? WHERE id = ?", (new_id, ts, old_id))
        # раньше слитые в old - теперь сразу в new
        c.execute("UPDATE foods SET merged_into = ?, updated = ? WHERE merged_into = ?", (new_id, ts, old_id))
        stats["knowledge"] = _relink_knowledge(c, old_id, new_id, ts)
    stats["records"], stats["profiles"] = _relink_records(old_id, new_id)
    return stats


def _swap(v, old_id: int, new_id: int):
    """food_id старого → новый где угодно в данных записи (только числа: у чашек и добавок food_id - id записи)."""
    if isinstance(v, dict):
        out, hit = {}, False
        for k, x in v.items():
            if k == "food_id" and isinstance(x, int) and not isinstance(x, bool) and x == old_id:
                out[k], hit = new_id, True
            else:
                out[k], h = _swap(x, old_id, new_id)
                hit = hit or h
        return out, hit
    if isinstance(v, list):
        res = [_swap(x, old_id, new_id) for x in v]
        return [r[0] for r in res], any(r[1] for r in res)
    return v, False


def _relink_records(old_id: int, new_id: int) -> tuple[int, int]:
    n_rec = n_prof = 0
    rows = db.q("SELECT * FROM records WHERE deleted = 0 AND data LIKE ?", (f'%"food_id": {old_id}%',))
    for r in rows:
        data, hit = _swap(json.loads(r["data"]), old_id, new_id)
        if hit:
            # через server_put: новая rev - изменение уйдёт на устройства; food_id у клиента служебный ключ
            # (store.js TECH_KEYS), поэтому окна конфликта не будет
            db.server_put(r["user_id"], r["kind"], r["id"], data, r["date"])
            n_rec += 1
    for r in db.q("SELECT * FROM records WHERE kind = 'profile' AND deleted = 0 AND data LIKE '%\"pieces\"%'"):
        data = json.loads(r["data"])
        pieces = data.get("pieces")
        if isinstance(pieces, dict) and str(old_id) in pieces:
            pieces = dict(pieces)
            v = pieces.pop(str(old_id))
            pieces.setdefault(str(new_id), v)
            db.server_put(r["user_id"], "profile", r["id"], {**data, "pieces": pieces}, r["date"])
            n_prof += 1
    return n_rec, n_prof


def _relink_knowledge(c, old_id: int, new_id: int, ts: int) -> int:
    n = 0
    for r in c.execute("SELECT * FROM knowledge WHERE deleted = 0 AND kind IN ('food_alias', 'food_phrase')").fetchall():
        val = json.loads(r["value"])
        if r["kind"] == "food_alias":
            if val.get("food_id") != old_id:
                continue
            val["food_id"] = new_id
        else:
            its = val.get("items") or []
            if not any(x.get("food_id") == old_id for x in its):
                continue
            merged: dict[int, float] = {}
            for x in its:
                fid = new_id if x.get("food_id") == old_id else x.get("food_id")
                merged[fid] = round(merged.get(fid, 0) + (x.get("g") or 0), 4)
            val["items"] = [{"food_id": k, "g": g} for k, g in merged.items()]
        c.execute("UPDATE knowledge SET value = ?, updated = ? WHERE id = ?", (json.dumps(val, ensure_ascii=False), ts, r["id"]))
        n += 1
    for r in c.execute("SELECT * FROM knowledge WHERE deleted = 0 AND kind = 'portion' AND key LIKE ?", (f"{old_id}|%",)).fetchall():
        key = f"{new_id}|{r['key'].split('|', 1)[1]}"
        cur = c.execute("SELECT * FROM knowledge WHERE kind = 'portion' AND key = ?", (key,)).fetchone()
        if cur is None:
            c.execute("UPDATE knowledge SET key = ?, updated = ? WHERE id = ?", (key, ts, r["id"]))
            # старый ключ клиенты должны забыть: оставляем удалённую строку с ним
            c.execute("INSERT OR IGNORE INTO knowledge (kind, key, value, confidence, source, uses, created, updated, deleted)"
                      " VALUES ('portion', ?, ?, 0, ?, 0, ?, ?, 1)", (r["key"], r["value"], r["source"], ts, ts))
        else:
            if cur["deleted"] or cur["confidence"] < r["confidence"]:
                c.execute("UPDATE knowledge SET value = ?, confidence = ?, uses = ?, deleted = 0, updated = ? WHERE id = ?",
                          (r["value"], r["confidence"], max(cur["uses"], r["uses"]), ts, cur["id"]))
            c.execute("UPDATE knowledge SET deleted = 1, updated = ? WHERE id = ?", (ts, r["id"]))
        n += 1
    return n


def _meta(key: str, default):
    rows = db.q("SELECT value FROM meta WHERE key = ?", (key,))
    try:
        return json.loads(rows[0]["value"]) if rows else default
    except ValueError:
        return default


def _set_meta(key: str, value) -> None:
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, json.dumps(value, ensure_ascii=False)))


def run(dry: bool = False) -> dict:
    plan = find()
    if dry:
        return plan
    log = _meta(LOG_KEY, [])
    done = []
    for m in plan["merges"]:
        to = db.merged_target(m["to"]["id"])
        st = merge(m["from"]["id"], to)
        entry = {"at": db.now_ms(), "from": m["from"], "to": {**m["to"], "id": to}, "why": m["why"], **st}
        done.append(entry)
        log.append(entry)
    if done:
        _set_meta(LOG_KEY, log[-LOG_MAX:])
    _set_meta(REPORT_KEY, {"at": db.now_ms(), "merged": len(done), "conflicts": plan["conflicts"][:100]})
    return {"merges": done, "conflicts": plan["conflicts"]}


# ── фон ──

START_DELAY, PERIOD = 60, 24 * 3600


async def _loop() -> None:
    await asyncio.sleep(START_DELAY)
    while True:
        try:
            await asyncio.to_thread(run)
        except Exception as e:                       # фон не должен падать: попробуем завтра
            print(f"fooddedupe: {e!r}", file=sys.stderr)
        await asyncio.sleep(PERIOD)


def start() -> None:
    asyncio.get_running_loop().create_task(_loop())


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    res = run(dry=dry)
    print(("Слилось бы" if dry else "Слито") + f": {len(res['merges'])}")
    for m in res["merges"]:
        a, b = m["from"], m["to"]
        print(f"  [{a['id']} {a['source']}] {a['name']} ({a['kcal']:g}/{a['p']:g}/{a['f']:g}/{a['c']:g})"
              f"  →  [{b['id']} {b['source']}] {b['name']} ({b['kcal']:g}/{b['p']:g}/{b['f']:g}/{b['c']:g}) - {m['why']}")
    print(f"Не слито, одинаковое название и разные цифры: {len(res['conflicts'])}")
    for x in res["conflicts"]:
        a, b = x["a"], x["b"]
        print(f"  [{a['id']}] {a['name']} ({a['kcal']:g}/{a['p']:g}/{a['f']:g}/{a['c']:g})"
              f"  ≠  [{b['id']}] {b['name']} ({b['kcal']:g}/{b['p']:g}/{b['f']:g}/{b['c']:g})")
