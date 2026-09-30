"""SQLite: схема, доступ, универсальные записи.

Все пользовательские данные — строки таблицы `records` одной формы (id, user_id, kind,
date, data, updated_at, rev, deleted). Так синхронизация не знает о смысле записей:
клиент и сервер гоняют одно и то же. `rev` — монотонный счётчик сервера, по нему клиент
забирает изменения; `updated_at` — время правки (мс), по нему решается, чья запись новее.
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TRAINER_DATA", ROOT / "data"))
SEED_DIR = Path(__file__).resolve().parent / "seed"
DB_PATH = DATA_DIR / "trainer.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, date TEXT,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS records_rev ON records(rev);
CREATE INDEX IF NOT EXISTS records_user_kind ON records(user_id, kind, date);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
  grp TEXT, kcal REAL, p REAL, f REAL, c REAL, portions TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'seed'
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT, error TEXT, created INTEGER NOT NULL, finished INTEGER
);
CREATE TABLE IF NOT EXISTS health_tokens (user_id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
-- «мозг» (app/brain.py): обезличенные знания для всех устройств и недельная статистика под псевдонимом
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  confidence REAL NOT NULL, source TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS knowledge_updated ON knowledge(updated);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, week TEXT NOT NULL, bucket TEXT NOT NULL,
  features TEXT NOT NULL, results TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, built INTEGER NOT NULL,
  UNIQUE(subject, week)
);
-- токены устройств для зеркал (другой origin → без cookie); храним только sha256
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, label TEXT
);
"""

# Партнёр видит только эти виды записей: выполнение дня, достижения и сводку недели.
# видно партнёру: итоги дня/недели, достижения и общая утренняя разминка (только список упражнений, у кого она включена)
PUBLIC_KINDS = ("dsum", "ach", "wsum", "pairwarm", "highlight")

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        # миграция: is_admin появился позже - CREATE TABLE IF NOT EXISTS столбец в старую таблицу не добавит.
        # Админ - первый зарегистрированный пользователь сервера, может создавать группы (см. item 15/группы).
        cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        if "is_admin" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
            c.execute("UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created ASC, id ASC LIMIT 1)")
        _conn = c
    return _conn


class tx:
    """Транзакция под общим замком: одно соединение на процесс, запросов немного."""

    def __enter__(self) -> sqlite3.Connection:
        _lock.acquire()
        c = conn()
        c.execute("BEGIN IMMEDIATE")
        return c

    def __exit__(self, et, ev, tb):
        try:
            conn().execute("ROLLBACK" if et else "COMMIT")
        finally:
            _lock.release()


def q(sql: str, args=()) -> list[sqlite3.Row]:
    with _lock:
        return conn().execute(sql, args).fetchall()


# ── пароли и сессии ──

def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1)
    return salt.hex() + ":" + h.hex()


def check_pw(pw: str, stored: str) -> bool:
    try:
        salt, h = stored.split(":")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
        return secrets.compare_digest(got.hex(), h)
    except ValueError:
        return False


def new_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with tx() as c:
        c.execute("INSERT INTO sessions VALUES (?,?,?,?)", (token, user_id, now_ms(), now_ms()))
    return token


def session_user(token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    rows = q("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", (token,))
    return rows[0] if rows else None


# ── токены устройств ──
# Нужны, когда приложение ходит к API по другому адресу (зеркало): cookie туда не уходят.

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


TOKEN_IDLE_DAYS = 60


def new_device_token(user_id: str, label: str = "") -> str:
    token = secrets.token_urlsafe(32)
    with tx() as c:
        # ключи, которыми не пользовались 60 дней, — забытые браузеры и старые входы: отзываем сами,
        # иначе список «устройств с доступом» только растёт
        c.execute("DELETE FROM device_tokens WHERE user_id = ? AND last_seen < ?",
                  (user_id, now_ms() - TOKEN_IDLE_DAYS * 86400_000))
        c.execute("INSERT INTO device_tokens VALUES (?,?,?,?,?)",
                  (token_hash(token), user_id, now_ms(), now_ms(), label[:80]))
    return token


def device_user(token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    h = token_hash(token)
    rows = q("SELECT u.*, d.last_seen AS d_seen FROM device_tokens d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?", (h,))
    if not rows:
        return None
    if now_ms() - rows[0]["d_seen"] > 600_000:   # не пишем в БД на каждый запрос
        with tx() as c:
            c.execute("UPDATE device_tokens SET last_seen = ? WHERE token_hash = ?", (now_ms(), h))
    return rows[0]


def revoke_device(token: str) -> None:
    with tx() as c:
        c.execute("DELETE FROM device_tokens WHERE token_hash = ?", (token_hash(token),))


def is_admin(user_id: str) -> bool:
    rows = q("SELECT is_admin FROM users WHERE id = ?", (user_id,))
    return bool(rows and rows[0]["is_admin"])


def groups() -> list[dict]:
    """Все группы (kind='group', создаёт только админ) - {id, name, member_ids}."""
    return [{"id": r["id"], **json.loads(r["data"])} for r in q("SELECT id, data FROM records WHERE kind = 'group' AND deleted = 0")]


def user_groups(user_id: str) -> list[dict]:
    return [g for g in groups() if user_id in (g.get("member_ids") or [])]


def partner_ids(user_id: str) -> list[str]:
    """Раньше - все остальные аккаунты (пока их было двое, это и был единственный партнёр). Теперь, когда
    зарегистрироваться может больше двух человек, видимость - по общей группе (см. группы, item 15).
    Обратная совместимость: пока админ не создал ни одной группы - ведём себя как раньше (видно всех
    остальных), чтобы у существующих пар ничего не сломалось само; как только появилась хоть одна группа -
    совместные данные (dsum/ach/wsum) видны только внутри своей группы."""
    all_groups = groups()
    if not all_groups:
        return [r["id"] for r in q("SELECT id FROM users WHERE id != ?", (user_id,))]
    ids: set[str] = set()
    for g in all_groups:
        if user_id in (g.get("member_ids") or []):
            for m in g["member_ids"]:
                if m != user_id:
                    ids.add(m)
    return list(ids)


# ── записи ──

def next_rev(c: sqlite3.Connection) -> int:
    row = c.execute("SELECT value FROM meta WHERE key = 'rev'").fetchone()
    rev = int(row["value"]) + 1 if row else 1
    c.execute("INSERT OR REPLACE INTO meta VALUES ('rev', ?)", (str(rev),))
    return rev


def put(c: sqlite3.Connection, rec: dict, force: bool = False) -> dict | None:
    """Записать, если входящая версия не старее сохранённой. Вернёт сохранённую запись или None."""
    cur = c.execute("SELECT updated_at, user_id FROM records WHERE id = ?", (rec["id"],)).fetchone()
    if cur is not None:
        if cur["user_id"] != rec["user_id"]:
            return None                          # чужую запись с тем же id не трогаем
        if not force and cur["updated_at"] > rec["updated_at"]:
            return None
    rev = next_rev(c)
    row = (rec["id"], rec["user_id"], rec["kind"], rec.get("date"),
           json.dumps(rec.get("data") or {}, ensure_ascii=False),
           int(rec["updated_at"]), rev, 1 if rec.get("deleted") else 0)
    c.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?,?)", row)
    return {**rec, "rev": rev}


def server_put(user_id: str, kind: str, id_: str, data: dict, date: str | None = None) -> dict:
    """Запись, созданная сервером (результат ИИ, начальные данные): всегда новее."""
    with tx() as c:
        return put(c, {"id": id_, "user_id": user_id, "kind": kind, "date": date,
                       "data": data, "updated_at": now_ms()}, force=True)


def row_to_rec(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "user_id": r["user_id"], "kind": r["kind"], "date": r["date"],
            "data": json.loads(r["data"]), "updated_at": r["updated_at"], "rev": r["rev"],
            "deleted": bool(r["deleted"])}


def get(id_: str) -> dict | None:
    rows = q("SELECT * FROM records WHERE id = ?", (id_,))
    return row_to_rec(rows[0]) if rows else None


def list_kind(user_id: str, kind: str, date_from: str | None = None, date_to: str | None = None) -> list[dict]:
    sql = "SELECT * FROM records WHERE user_id = ? AND kind = ? AND deleted = 0"
    args: list = [user_id, kind]
    if date_from:
        sql += " AND date >= ?"; args.append(date_from)
    if date_to:
        sql += " AND date <= ?"; args.append(date_to)
    return [row_to_rec(r) for r in q(sql + " ORDER BY date, updated_at", args)]


# ── справочник продуктов ──
# Общий для всех аккаунтов: продукты из seed/foods.json (source seed) и добавленные людьми
# (manual — вручную, web — найдено ИИ в Open Food Facts, ai — оценка ИИ). Строки не удаляются,
# а помечаются deleted: клиенты кэшируют справочник и забирают изменения по updated (мс).

FOOD_STATES = ("dry", "raw", "cooked", "as_sold", "fresh")
FOOD_COLS = {  # новые колонки (миграция для старых баз)
    "state": "TEXT", "generic": "INTEGER NOT NULL DEFAULT 0", "note": "TEXT", "cooked_ratio": "REAL",
    "brand": "TEXT", "created_by": "TEXT", "created_at": "INTEGER", "updated": "INTEGER NOT NULL DEFAULT 0",
    "verified": "INTEGER NOT NULL DEFAULT 0", "deleted": "INTEGER NOT NULL DEFAULT 0",
    "code": "TEXT",                                  # штрихкод (товары из Open Food Facts)
}
_foods_migrated = False


def migrate_foods() -> None:
    global _foods_migrated
    if _foods_migrated:
        return
    with tx() as c:
        have = {r["name"] for r in c.execute("PRAGMA table_info(foods)")}
        for col, typ in FOOD_COLS.items():
            if col not in have:
                c.execute(f"ALTER TABLE foods ADD COLUMN {col} {typ}")
        c.execute("UPDATE foods SET updated = ? WHERE updated = 0", (now_ms(),))
        c.execute("CREATE INDEX IF NOT EXISTS foods_updated ON foods(updated)")
    _foods_migrated = True


_STATE_RE = [  # состояние по названию — для старых строк и выученных продуктов без поля state
    (r"сух|сыр(ая|ой|ое|ые)\b.*(круп|греч|рис|овся|пшен|булгур|киноа|перлов|ячн|макарон|спагет|паст|лапш|фасол|чечев|нут|горох|маш)"
     r"|(круп|греч|рис|овся|пшен|булгур|киноа|перлов|ячн|макарон|спагет|паст|лапш|фасол|чечев|нут|горох|маш)\w*\s.*(сыр|сух)"
     r"|хлопья|крупа", "dry"),
    (r"вар[её]н|отвар|тушен|жарен|запеч|готов|на пару|гриль|копч|каша|пюре|суп|борщ", "cooked"),
    (r"сыр(ая|ой|ое|ые)\b", "raw"),
]


def guess_state(name: str, group: str | None = None) -> str | None:
    n = (name or "").lower().replace("ё", "е")
    for pat, st in _STATE_RE:
        if re.search(pat, n):
            return st
    if group in ("фрукты и ягоды", "овощи"):
        return "fresh"
    return None


FOOD_ROW_COLS = ("name", "aliases", "grp", "kcal", "p", "f", "c", "portions", "state", "generic", "note", "cooked_ratio", "brand", "code")


def _food_row(it: dict) -> tuple:
    return (it["name"], json.dumps(it.get("aliases", []), ensure_ascii=False), it.get("group"),
            float(it["kcal"]), float(it["p"]), float(it["f"]), float(it["c"]),
            json.dumps(it.get("portions", {}), ensure_ascii=False),
            it.get("state") or guess_state(it["name"], it.get("group")), 1 if it.get("generic") else 0,
            it.get("note"), it.get("cooked_ratio"), it.get("brand"), it.get("code"))


# Файлы справочника: базовые продукты (seed) и товары из магазинов по Open Food Facts (off, ODbL,
# собирается scripts/build_store_foods.py). Товары грузятся вторыми: при совпадении имени базовый продукт важнее.
SEED_FILES = (("foods.json", "seed", "foods_seed"), ("foods_store.json", "off", "foods_store_seed"))


def seed_foods() -> None:
    migrate_foods()
    for fname, source, key in SEED_FILES:
        _seed_file(SEED_DIR / fname, source, key)


def _seed_file(path: Path, source: str, meta_key: str) -> None:
    """Загрузить файл справочника, если он изменился. id сохраняются (на них ссылаются записи еды);
    продукты людей (manual, web, ai) не трогаем; исчезнувшие из файла строки этого источника помечаются deleted."""
    if not path.exists():
        return
    raw = path.read_bytes()
    digest = hashlib.sha1(raw).hexdigest()
    if q("SELECT 1 FROM meta WHERE key = ? AND value = ?", (meta_key, digest)):
        return
    try:
        items = json.loads(raw)
    except ValueError:
        return                                   # файл в процессе записи — загрузим при следующем старте
    ts = now_ms()
    cols = ", ".join(FOOD_ROW_COLS)
    with tx() as c:
        cur = {r["name"].lower(): r for r in c.execute("SELECT * FROM foods")}
        seen = set()
        for it in items:
            if not it.get("name") or it.get("kcal") is None:
                continue
            key = it["name"].lower()
            if key in seen:
                continue
            seen.add(key)
            row = _food_row(it)
            old = cur.get(key)
            if old is None:
                c.execute(f"INSERT INTO foods ({cols}, source, verified, created_at, updated, deleted)"
                          f" VALUES ({', '.join('?' * len(FOOD_ROW_COLS))}, ?, 1, ?, ?, 0)", (*row, source, ts, ts))
            elif old["source"] == source:
                if tuple(old[k] for k in FOOD_ROW_COLS) != row or old["deleted"]:
                    c.execute(f"UPDATE foods SET {', '.join(k + '=?' for k in FOOD_ROW_COLS)}, verified=1, deleted=0, updated=? WHERE id=?",
                              (*row, ts, old["id"]))
            # имя занято продуктом другого источника (базовым или человека) — его версия важнее
        for key, old in cur.items():
            if old["source"] == source and key not in seen and not old["deleted"]:
                c.execute("UPDATE foods SET deleted = 1, updated = ? WHERE id = ?", (ts, old["id"]))
        c.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (meta_key, digest))


def food_json(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "name": r["name"], "aliases": json.loads(r["aliases"] or "[]"), "group": r["grp"],
            "state": r["state"], "generic": bool(r["generic"]), "note": r["note"],
            "kcal": r["kcal"], "p": r["p"], "f": r["f"], "c": r["c"],
            "portions": json.loads(r["portions"] or "{}"), "cooked_ratio": r["cooked_ratio"],
            "source": r["source"], "brand": r["brand"], "code": r["code"], "created_by": r["created_by"],
            "verified": bool(r["verified"]), "updated": r["updated"], "deleted": bool(r["deleted"])}


def all_foods(include_deleted: bool = False) -> list[dict]:
    migrate_foods()
    sql = "SELECT * FROM foods" + ("" if include_deleted else " WHERE deleted = 0") + " ORDER BY id"
    return [food_json(r) for r in q(sql)]


def foods_since(since: int) -> list[dict]:
    migrate_foods()
    return [food_json(r) for r in q("SELECT * FROM foods WHERE updated > ? ORDER BY id", (since,))]


def food_by_id(fid: int) -> dict | None:
    migrate_foods()
    rows = q("SELECT * FROM foods WHERE id = ?", (fid,))
    return food_json(rows[0]) if rows else None


def food_by_name(name: str) -> dict | None:
    """Без учёта регистра и ё/е (SQLite lower() не знает кириллицу — сравниваем в Python)."""
    key = (name or "").strip().lower().replace("ё", "е")
    for r in q("SELECT * FROM foods"):
        if r["name"].lower().replace("ё", "е") == key:
            return food_json(r)
    return None


def save_food(fields: dict, uid: str | None, fid: int | None = None) -> dict:
    """Добавить (fid None) или обновить продукт. Поля: name, state, kcal, p, f, c, portions, brand, note,
    group, aliases, source, verified. Возвращает сохранённую строку."""
    migrate_foods()
    ts = now_ms()
    vals = {"name": fields["name"], "aliases": json.dumps(fields.get("aliases") or [], ensure_ascii=False),
            "grp": fields.get("group"), "kcal": fields["kcal"], "p": fields["p"], "f": fields["f"], "c": fields["c"],
            "portions": json.dumps(fields.get("portions") or {}, ensure_ascii=False), "state": fields.get("state"),
            "generic": 0, "note": fields.get("note"), "cooked_ratio": fields.get("cooked_ratio"), "brand": fields.get("brand"),
            "source": fields.get("source") or "manual", "verified": 1 if fields.get("verified") else 0,
            "deleted": 0, "updated": ts}
    with tx() as c:
        if fid is None:
            vals.update(created_by=uid, created_at=ts)
            cols = ",".join(vals)
            cur = c.execute(f"INSERT INTO foods ({cols}) VALUES ({','.join('?' * len(vals))})", tuple(vals.values()))
            fid = cur.lastrowid
        else:
            if uid:
                vals["created_by"] = uid           # восстановленная удалённая строка переходит к добавившему
            sets = ",".join(f"{k} = ?" for k in vals)
            c.execute(f"UPDATE foods SET {sets} WHERE id = ?", (*vals.values(), fid))
    return food_by_id(fid)


def delete_food(fid: int) -> None:
    with tx() as c:
        c.execute("UPDATE foods SET deleted = 1, updated = ? WHERE id = ?", (now_ms(), fid))


def learn_food(name: str, per100: dict, source: str = "ai", uid: str | None = None) -> None:
    """Продукт, который ИИ оценила при расчёте записи. Существующие строки людей и seed не перетираем."""
    migrate_foods()
    if food_by_name(name):
        return
    ts = now_ms()
    with tx() as c:
        c.execute(
            "INSERT OR IGNORE INTO foods (name, aliases, grp, kcal, p, f, c, portions, state, source, created_by, created_at, updated)"
            " VALUES (?, '[]', NULL, ?,?,?,?, '{}', ?, ?, ?, ?, ?)",
            (name, per100["kcal"], per100["p"], per100["f"], per100["c"], guess_state(name), source, uid, ts, ts))


_seed_cache: dict[str, tuple[float, list]] = {}


def _seed_list(name: str) -> list:
    """Справочник из seed/ с перечитыванием при изменении файла: каталоги дополняются без перезапуска."""
    path = SEED_DIR / name
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return []
    cached = _seed_cache.get(name)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        data = json.loads(path.read_text("utf-8"))
    except (ValueError, OSError):
        return cached[1] if cached else []      # файл в процессе записи — отдаём прошлую версию
    _seed_cache[name] = (mtime, data)
    return data


def exercises() -> list[dict]:
    return _seed_list("exercises.json")


def activities() -> list[dict]:
    return _seed_list("activities.json")


def supplements() -> dict:
    """Справочник витаминов и добавок: {items: [...], stoplist: [...]} (файл - словарь, не список)."""
    data = _seed_list("supplements.json")
    return data if isinstance(data, dict) else {"items": [], "stoplist": []}
