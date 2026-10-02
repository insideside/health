"""«Мозг» Тренера: обезличенная память знаний и статистика «действие → результат».

Знания (`knowledge`) — то, что ИИ или люди однажды выяснили и что можно применять без ИИ:
  food_phrase  «тарелка борща» → [{food_id, g}]   (g — граммы на одну единицу из фразы, для граммов — доля)
  food_alias   «гречневая каша» → food_id
  portion      «{food_id}|{единица}» → граммы на одну единицу
  activity_alias, exercise_swap, coach_fact — общий формат, пополняются через /api/brain/feedback.
Хранится на сервере, раздаётся клиентам дельтой (`GET /api/brain?since=`), клиент применяет офлайн.
Личного в знаниях нет: ни id людей, ни имён, ни заметок; фраза попадает в память, только если все её
слова — слова о еде (названия из справочника, единицы, числа, предлоги), см. `impersonal()`.

Уверенность (confidence 0..1): первый ответ ИИ — 0,55 (клиент уже применяет, порог 0,5), согласные
повторы и подтверждения людей её поднимают, противоречия — опускают; ниже порога знание не применяется,
а при сильном расхождении заменяется новым.

Статистика (`outcomes`) — недельные строки «что человек делал → что получилось», по типу человека
(пол, возраст, телосложение, цель, активность) под псевдонимом. Сырые строки других людей не отдаются
никогда: только агрегаты по группам от 3 человек и только согласившихся (`profile.share_stats`).
"""
import hashlib
import json
import math
import os
import re
import time
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from . import db, food, userdata
from .userdata import current_user

router = APIRouter()

KINDS = ("food_phrase", "food_alias", "portion", "activity_alias", "exercise_swap", "coach_fact")
MIN_USE = 0.5                                   # с этой уверенности клиент применяет знание
BASE = {"ai": 0.55, "user": 0.65, "stats": 0.5}
MASS = {"g": 1, "ml": 1, "kg": 1000, "l": 1000}
STOP = {"с", "со", "и", "без", "на", "в", "во", "из", "по", "под", "к", "от", "для", "а", "или", "пол", "половина",
        "половинка", "один", "одна", "одно", "два", "две", "три", "четыре", "пять", "шесть", "полтора", "полторы",
        "немного", "чуть", "большой", "большая", "большое", "маленький", "маленькая", "маленькое", "средний", "средняя"}


# ── таблицы ──
# knowledge и outcomes создаются в db.SCHEMA (CREATE TABLE IF NOT EXISTS — безопасно и для старых баз).

def ensure() -> None:
    db.conn()


# ── ключи и проверка «обезличенности» ──

def phrase_parts(chunk: str) -> tuple[str, float, str] | None:
    """Кусок текста → (основа названия, количество в единицах, единица). Граммы/мл/кг/л → 'g'."""
    name, n, unit = food.parse_chunk(chunk)
    base = food.stem(name)
    if not base:
        return None
    if unit in MASS:
        return base, (n or 0) * MASS[unit], "g"
    return base, (n if n else 1), unit or ""


def phrase_key(chunk: str) -> str | None:
    p = phrase_parts(chunk)
    return f"{p[0]}|{p[2]}" if p else None


# посуда и меры, которых нет среди единиц разбора: «кружка какао», «миска рамена», «пачка творога»
CONTAINERS = {"кружк", "миск", "пиал", "банк", "пачк", "бутылк", "упаковк", "ложк", "ложечк", "контейнер", "стаканчик",
              "тарелочк", "кусочек", "кусочк", "долек", "дольк", "ломтик", "щепотк", "капл", "ведерк", "коробк", "пакет",
              "бокал", "рюмк", "фужер", "плитк", "батончик", "брикет", "шарик", "вафл", "штучк", "половинк", "четверт"}
_vocab_cache: tuple[int, set[str]] = (-1, set())


def _words(foods: list[dict]) -> set[str]:
    words = set()
    for f in foods:
        for s in [f.get("name") or "", *(f.get("aliases") or [])]:
            words.update(food.stem(w) for w in food.norm(s).split())
    return words


def _vocab(foods: list[dict]) -> set[str]:
    """Слова о еде: весь справочник (названия и синонимы) + найденные продукты + посуда."""
    global _vocab_cache
    n = db.q("SELECT COUNT(*) n, MAX(updated) u FROM foods")[0]
    key = hash((n["n"], n["u"]))
    if _vocab_cache[0] != key:
        _vocab_cache = (key, _words(db.all_foods()))
    return _vocab_cache[1] | _words(foods) | CONTAINERS


def impersonal(name: str, foods: list[dict]) -> bool:
    """Фразу можно запомнить для всех, только если каждое её слово — про еду: слово из справочника или
    из названий найденных продуктов (по основе или первым 4 буквам), посуда, единица, число, предлог,
    слово состояния. Так «борщ у мамы Иры» в память не попадёт, а «тарелка борща», «кружка какао
    с зефирками» и «гречневая каша» — попадут."""
    words = food.norm(name).split()
    if not words or len(words) > 6 or len(name) > 60:
        return False
    vocab = _vocab(foods)
    pref = {v[:4] for v in vocab if len(v) >= 4}
    for w in words:
        if w in STOP or re.fullmatch(r"[\d.,%]+", w) or food.BARE_UNIT_RE.fullmatch(w) or food.unit_code(w) \
                or food.STATE_WORDS.fullmatch(w):
            continue
        s = food.stem(w)                         # w может быть уже основой (ключ фразы) — проверяем и её
        if s in vocab or w in vocab or any(len(x) >= 4 and x[:4] in pref for x in (s, w)):
            continue
        return False
    return True


# ── память знаний ──

def _row(kind: str, key: str):
    rows = db.q("SELECT * FROM knowledge WHERE kind = ? AND key = ?", (kind, key))
    return rows[0] if rows else None


def get(kind: str, key: str, min_conf: float = MIN_USE):
    ensure()
    r = _row(kind, key)
    if not r or r["deleted"] or r["confidence"] < min_conf:
        return None
    return json.loads(r["value"])


def _same(kind: str, a: dict, b: dict) -> bool:
    if kind == "food_phrase":
        ia, ib = a.get("items") or [], b.get("items") or []
        if sorted(x["food_id"] for x in ia) != sorted(x["food_id"] for x in ib):
            return False
        ga = {x["food_id"]: x["g"] for x in ia}
        return all(abs(ga[x["food_id"]] - x["g"]) <= 0.2 * max(ga[x["food_id"]], x["g"], 1e-9) for x in ib)
    if kind == "portion":
        return abs(a["g"] - b["g"]) <= 0.15 * max(a["g"], b["g"], 1e-9)
    return a == b


def _blend(kind: str, old: dict, new: dict, w_new: float) -> dict:
    """Числа усредняем с весом: одно новое наблюдение не перечёркивает накопленное."""
    if kind == "portion":
        return {"g": round(old["g"] * (1 - w_new) + new["g"] * w_new, 3)}
    if kind == "food_phrase" and _same_ids(old, new):
        ng = {x["food_id"]: x["g"] for x in new["items"]}
        return {"items": [{"food_id": x["food_id"], "g": round(x["g"] * (1 - w_new) + ng[x["food_id"]] * w_new, 4)}
                          for x in old["items"]]}
    return new


def _same_ids(a: dict, b: dict) -> bool:
    return sorted(x["food_id"] for x in a.get("items") or []) == sorted(x["food_id"] for x in b.get("items") or [])


def learn(kind: str, key: str, value: dict, source: str = "ai", signal: str = "observe") -> dict | None:
    """Добавить наблюдение. signal: observe (ответ ИИ), confirm (человек согласен), correct (человек поправил)."""
    ensure()
    if kind not in KINDS or not key or len(key) > 120:
        return None
    ts = db.now_ms()
    with db.tx() as c:
        r = c.execute("SELECT * FROM knowledge WHERE kind = ? AND key = ?", (kind, key)).fetchone()
        if r is None:
            if signal == "confirm":
                return None                     # подтверждать нечего
            conf = BASE.get(source, 0.5)
            c.execute("INSERT INTO knowledge (kind, key, value, confidence, source, uses, created, updated) VALUES (?,?,?,?,?,1,?,?)",
                      (kind, key, json.dumps(value, ensure_ascii=False), conf, source, ts, ts))
            return {"kind": kind, "key": key, "value": value, "confidence": conf}
        old = json.loads(r["value"])
        conf, uses, src = r["confidence"], r["uses"] + 1, r["source"]
        if signal == "confirm" or (signal == "observe" and _same(kind, old, value)):
            conf += (1 - conf) * (0.35 if source == "user" else 0.25)
            val = _blend(kind, old, value, 1 / uses) if signal == "observe" else old
        elif signal == "correct":
            # поправка человека весомее ответа ИИ, но одна поправка — ещё не правило для всех
            val = _blend(kind, old, value, 0.5) if _same_ids(old, value) or kind == "portion" else value
            conf = max(0.55, min(0.85, conf))
            src = "user"
        else:
            conf -= 0.15                         # ИИ ответила иначе, чем раньше: доверия меньше
            val = old
            if conf < 0.35:
                val, conf, uses = value, 0.45, 1
        conf = round(min(0.98, max(0.05, conf)), 3)
        c.execute("UPDATE knowledge SET value = ?, confidence = ?, source = ?, uses = ?, updated = ?, deleted = 0 WHERE id = ?",
                  (json.dumps(val, ensure_ascii=False), conf, src, uses, ts, r["id"]))
        return {"kind": kind, "key": key, "value": val, "confidence": conf}


def delta(since: int = 0) -> dict:
    ensure()
    rows = db.q("SELECT kind, key, value, confidence, deleted, updated FROM knowledge WHERE updated > ? ORDER BY updated", (since,))
    return {"items": [[r["kind"], r["key"], json.loads(r["value"]), r["confidence"]] for r in rows if not r["deleted"]],
            "deleted": [[r["kind"], r["key"]] for r in rows if r["deleted"]], "now": db.now_ms(), "full": since <= 0}


# ── применение на сервере (те же правила, что в app/static/foodparse.js) ──

def resolve(chunks: list[str], idx: "food.Index | None" = None) -> tuple[list[dict], list[str]]:
    """Нераспознанные справочником куски → позиции по памяти: сначала фраза целиком, потом синоним + порция."""
    ensure()
    idx = idx or food.Index()
    done, rest = [], []
    for chunk in chunks:
        parts = phrase_parts(chunk)
        items = None
        if parts:
            base, n, unit = parts
            v = get("food_phrase", f"{base}|{unit}")
            if v and n:
                fs = [(idx.by_id.get(x["food_id"]), x["g"]) for x in v.get("items") or []]
                if fs and all(f for f, _ in fs):
                    items = [{**food.item_from(f, g * n, chunk, source="brain"), "phrase": f"{base}|{unit}", "pn": n}
                             for f, g in fs]
            if items is None:
                a = get("food_alias", base)
                f = idx.by_id.get(a["food_id"]) if a else None
                if f:
                    name, qn, qu = food.parse_chunk(chunk)
                    grams = food.grams_for(f, qn, qu) or portion_grams(f["id"], qu or ("шт" if qn and qn <= 20 else None), qn)
                    if grams:
                        items = [{**food.item_from(f, grams, chunk, source="brain"), **({"pu": qu, "pn": qn or 1} if qu not in MASS else {})}]
        if items:
            done += items
        else:
            rest.append(chunk)
    return done, rest


def portion_grams(food_id: int, unit: str | None, n: float | None) -> float | None:
    if not unit or unit in MASS:
        return None
    v = get("portion", f"{food_id}|{unit}")
    return v["g"] * (n or 1) if v else None


# ── обучение на ответах ИИ (ai/jobs.py → job_food) ──

def learn_food_ai(rest: list[str], ai_items: list[dict], idx: "food.Index") -> list[dict]:
    """Ответ ИИ по нераспознанным кускам → фразы, синонимы и порции. ai_items — позиции уже с food_id.
    Возвращает те же позиции с пометкой phrase/pn (по ним клиент пришлёт поправку, если человек изменит граммы)."""
    ensure()
    groups: dict[str, list[dict]] = {}
    for it in ai_items:
        t = food.norm(it.get("text") or "")
        chunk = next((c for c in rest if food.norm(c) == t), None) \
            or next((c for c in rest if t and (t in food.norm(c) or food.norm(c) in t)), None) \
            or (rest[0] if len(rest) == 1 else None)
        if chunk:
            groups.setdefault(chunk, []).append(it)
    out = []
    for chunk, items in groups.items():
        parts = phrase_parts(chunk)
        ok = [it for it in items if isinstance(it.get("food_id"), int) and it.get("grams")]
        if not parts or not ok or len(ok) != len(items):
            continue
        base, n, unit = parts
        foods = [idx.by_id.get(it["food_id"]) or db.food_by_id(it["food_id"]) for it in ok]
        name = food.parse_chunk(chunk)[0]
        if not n or not all(foods) or not impersonal(name, foods):
            continue
        key = f"{base}|{unit}"
        learn("food_phrase", key, {"items": [{"food_id": it["food_id"], "g": round(it["grams"] / n, 4)} for it in ok]}, "ai")
        for it in ok:
            it["phrase"], it["pn"] = key, n
        if len(ok) == 1:
            f = foods[0]
            if food.stem(name) not in {food.stem(k) for k in [f["name"], *f.get("aliases", [])]}:
                learn("food_alias", base, {"food_id": f["id"]}, "ai")
            if unit and unit != "g":
                learn("portion", f"{f['id']}|{unit}", {"g": round(ok[0]["grams"] / n, 1)}, "ai")
        out += ok
    return out


# ── синонимы из поиска продукта с ИИ: запрос → продукт, который человек сохранил ──
_lookups: dict[tuple[str, str], tuple[str, float]] = {}


def note_lookup(uid: str, query: str, name: str) -> None:
    now = time.time()
    for k in [k for k, (_, t) in _lookups.items() if now - t > 86400]:
        _lookups.pop(k, None)
    _lookups[(uid, food.norm(name))] = (query, now)


def on_food_saved(uid: str, f: dict) -> None:
    """Человек сохранил продукт после поиска с ИИ: его запрос — синоним этого продукта (если он про еду)."""
    hit = _lookups.pop((uid, food.norm(f.get("name") or "")), None)
    if not hit:
        return
    q = food.STATE_WORDS.sub(" ", food.norm(hit[0])).strip()
    base = food.stem(q)
    if base and base != food.stem(f["name"]) and impersonal(q, [f]):
        learn("food_alias", base, {"food_id": f["id"]}, "user")


# ── настройки приватности сервера ──

def web_forced_off() -> bool:
    return os.environ.get("TRAINER_NO_WEB", "") not in ("", "0")


def web_allowed() -> bool:
    """Поиск продукта в интернете (Open Food Facts и сайты-счётчики, app/websources.py). Выключается здесь."""
    if web_forced_off():
        return False
    rows = db.q("SELECT value FROM meta WHERE key = 'web_lookup'")
    return not rows or rows[0]["value"] != "0"


def ollama_local() -> bool:
    from .ai import ollama
    host = re.sub(r"^\w+://", "", ollama.URL).split("/")[0].rsplit(":", 1)[0].strip("[]")
    return host in ("127.0.0.1", "localhost", "::1")


# ── статистика «действие → результат» ──

FEATURES = {"sleep_h": "сон, ч", "steps": "шаги в день", "workouts": "тренировок в неделю", "protein_gkg": "белок, г/кг",
            "kcal_pct": "калории от нормы, %", "activity_min": "активность, мин в неделю", "cheat_days": "читмилов в неделю",
            "late_meals": "поздних приёмов пищи"}
RESULTS = {"d_weight": "изменение веса, кг за неделю", "d_waist": "изменение талии, см", "d_arm": "изменение руки, см",
           "grade": "оценка недели"}
PAIRS = [("sleep_h", "grade"), ("sleep_h", "d_weight"), ("protein_gkg", "d_weight"), ("protein_gkg", "d_waist"),
         ("protein_gkg", "d_arm"), ("steps", "d_weight"), ("steps", "d_waist"), ("workouts", "d_arm"), ("workouts", "d_waist"),
         ("workouts", "grade"), ("kcal_pct", "d_weight"), ("activity_min", "d_weight"), ("cheat_days", "grade"),
         ("cheat_days", "d_weight"), ("late_meals", "d_weight")]
MIN_USERS = 3
WEEKS_BACK = 26
_built = 0.0


def subject(uid: str) -> str:
    """Псевдоним в статистике: из него нельзя получить id без соли сервера."""
    salt = db.q("SELECT value FROM meta WHERE key = 'stats_salt'")
    if not salt:
        with db.tx() as c:
            c.execute("INSERT OR IGNORE INTO meta VALUES ('stats_salt', ?)", (os.urandom(16).hex(),))
        salt = db.q("SELECT value FROM meta WHERE key = 'stats_salt'")
    return hashlib.sha256((salt[0]["value"] + uid).encode()).hexdigest()[:16]


def _age_band(birth: str | None) -> str | None:
    try:
        b = date.fromisoformat(birth)
    except (TypeError, ValueError):
        return None
    a = (date.today() - b).days // 365
    return "<25" if a < 25 else "25–34" if a < 35 else "35–44" if a < 45 else "45–54" if a < 55 else "55+"


def bucket_of(uid: str) -> dict:
    prof, goal = userdata.profile(uid), userdata.goal(uid)
    goals = sorted(goal.get("goals") or [], key=lambda g: g.get("priority") or 2)
    main = goals[0]["type"] if goals else ("lose_fat" if goal.get("fat_kg") else "gain_muscle" if goal.get("muscle_upper_kg") else None)
    return {"sex": prof.get("sex"), "age": _age_band(prof.get("birth")), "body_type": prof.get("body_type"),
            "goal": main, "activity": prof.get("activity")}


def _avg(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else None


def week_rows(uid: str) -> list[dict]:
    """Недельные признаки и результаты человека за последние полгода (только завершённые недели)."""
    from .ai.jobs import sleep_hours_of
    today = date.today()
    this_mon = today - timedelta(days=today.weekday())
    start = this_mon - timedelta(weeks=WEEKS_BACK)
    a = start.isoformat()
    by = lambda kind: db.list_kind(uid, kind, a)
    sleeps, foods, acts, dtypes = by("sleep"), by("food"), by("activity"), by("daytype")
    workouts = [w for w in by("workout") if w["date"] < this_mon.isoformat()]
    bodies = db.list_kind(uid, "body", (start - timedelta(days=14)).isoformat())
    wsums = {r["date"] or r["id"].rsplit(":", 1)[-1]: r["data"] for r in db.list_kind(uid, "wsum")}
    items = {r["data"].get("target_from"): r["id"] for r in db.list_kind(uid, "item") if r["data"].get("target_from")}
    steps_id = items.get("steps")
    logs = [r for r in db.list_kind(uid, "log", a) if steps_id and r["id"].endswith(":" + steps_id)]
    tgt = (userdata.latest_target(uid) or {}).get("data", {})
    weight0 = userdata.latest_weight(uid)
    wk = lambda d: (date.fromisoformat(d) - timedelta(days=date.fromisoformat(d).weekday())).isoformat()
    W: dict[str, dict] = {}
    get_w = lambda d: W.setdefault(wk(d), {"sleep": [], "steps": [], "wo": 0, "kcal": {}, "p": {}, "act": 0, "cheat": 0, "late": 0})
    for r in sleeps:
        h = sleep_hours_of(r["data"])
        if h:
            get_w(r["date"])["sleep"].append(h)
    for r in logs:
        if isinstance(r["data"].get("v"), (int, float)) and r["data"]["v"] > 0:
            get_w(r["date"])["steps"].append(r["data"]["v"])
    for r in workouts:
        if r["data"].get("done"):
            get_w(r["date"])["wo"] += 1
    for r in foods:
        t = r["data"].get("totals") or {}
        if r["data"].get("status") == "calculated" and t:
            x = get_w(r["date"])
            x["kcal"][r["date"]] = x["kcal"].get(r["date"], 0) + (t.get("kcal") or 0)
            x["p"][r["date"]] = x["p"].get(r["date"], 0) + (t.get("p") or 0)
        if (r["data"].get("time") or "") >= "21:00":
            get_w(r["date"])["late"] += 1
    for r in acts:
        get_w(r["date"])["act"] += int(r["data"].get("minutes") or 0)
    for r in dtypes:
        if r["data"].get("type") == "cheat":
            get_w(r["date"])["cheat"] += 1
    wts = [(r["date"], r["data"]["weight"]) for r in bodies if r["data"].get("weight")]
    meas = lambda k: [(r["date"], r["data"][k]) for r in bodies if r["data"].get(k)]
    arms = [(r["date"], _avg([r["data"].get("arm_l"), r["data"].get("arm_r")])) for r in bodies
            if r["data"].get("arm_l") or r["data"].get("arm_r")]

    def change(series, mon: date):
        """Сдвиг за неделю: последнее значение до конца недели (не старше 14 дней) → последнее в следующей неделе."""
        end, nxt = (mon + timedelta(days=6)).isoformat(), (mon + timedelta(days=13)).isoformat()
        before = [v for d, v in series if (mon - timedelta(days=14)).isoformat() <= d <= end]
        after = [v for d, v in series if end < d <= nxt]
        return round(after[-1] - before[-1], 2) if before and after else None

    def wavg(mon: date):
        return _avg([v for d, v in wts if mon.isoformat() <= d <= (mon + timedelta(days=6)).isoformat()])

    rows = []
    for m, x in sorted(W.items()):
        mon = date.fromisoformat(m)
        if mon >= this_mon:
            continue
        w_now, w_next = wavg(mon), wavg(mon + timedelta(weeks=1))
        kd = list(x["kcal"].values())
        pd = list(x["p"].values())
        feats = {
            "sleep_h": round(_avg(x["sleep"]), 2) if x["sleep"] else None,
            "steps": round(_avg(x["steps"])) if x["steps"] else None,
            "workouts": x["wo"],
            "protein_gkg": round(_avg(pd) / (w_now or weight0), 2) if pd and (w_now or weight0) else None,
            "kcal_pct": round(_avg(kd) / tgt["kcal"] * 100) if kd and tgt.get("kcal") else None,
            "activity_min": x["act"], "cheat_days": x["cheat"], "late_meals": x["late"],
        }
        res = {"d_weight": round(w_next - w_now, 2) if w_now and w_next else None,
               "d_waist": change(meas("waist"), mon), "d_arm": change(arms, mon),
               "grade": (wsums.get(m) or {}).get("score")}
        if any(v is not None for v in res.values()):
            rows.append({"week": m, "features": feats, "results": res})
    return rows


def rebuild(force: bool = False) -> None:
    """Пересобрать таблицу outcomes (кодом, без ИИ). Для 2–4 человек это доли секунды; не чаще раза в 6 ч."""
    global _built
    ensure()
    if not force and time.time() - _built < 6 * 3600:
        return
    users = [r["id"] for r in db.q("SELECT id FROM users")]
    rows = []
    for uid in users:
        shared = 1 if userdata.profile(uid).get("share_stats") else 0
        b = json.dumps(bucket_of(uid), ensure_ascii=False)
        s = subject(uid)
        for r in week_rows(uid):
            rows.append((s, r["week"], b, json.dumps(r["features"]), json.dumps(r["results"]), shared, db.now_ms()))
    with db.tx() as c:
        c.execute("DELETE FROM outcomes")
        c.executemany("INSERT INTO outcomes (subject, week, bucket, features, results, shared, built) VALUES (?,?,?,?,?,?,?)", rows)
    _built = time.time()


def _corr(pairs: list[tuple[float, float]]) -> tuple[float | None, float | None]:
    n = len(pairs)
    if n < 4:
        return None, None
    mx, my = sum(p[0] for p in pairs) / n, sum(p[1] for p in pairs) / n
    sxx = sum((p[0] - mx) ** 2 for p in pairs)
    syy = sum((p[1] - my) ** 2 for p in pairs)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
    if sxx <= 0 or syy <= 0:
        return None, None
    return round(sxy / math.sqrt(sxx * syy), 2), round(sxy / sxx, 4)


def effects(rows: list[dict]) -> list[dict]:
    out = []
    for f, r in PAIRS:
        pts = [(x["features"][f], x["results"][r]) for x in rows
               if isinstance(x["features"].get(f), (int, float)) and isinstance(x["results"].get(r), (int, float))]
        rho, slope = _corr(pts)
        if rho is None:
            continue
        out.append({"feature": f, "result": r, "r": rho, "slope": slope, "n": len(pts),
                    "users": len({x["subject"] for x in rows if isinstance(x["features"].get(f), (int, float))})})
    return sorted(out, key=lambda e: -abs(e["r"]))


def averages(rows: list[dict]) -> dict:
    return {k: (round(v, 2) if (v := _avg([x["features"].get(k) for x in rows])) is not None else None) for k in FEATURES}


LEVELS = [("same_type", ("sex", "age", "goal", "body_type")), ("sex_goal", ("sex", "goal")), ("sex_age", ("sex", "age")),
          ("goal", ("goal",)), ("all", ())]
LEVEL_RU = {"same_type": "Люди вашего типа", "sex_goal": "Того же пола и с той же целью", "sex_age": "Того же пола и возраста",
            "goal": "Люди с той же целью", "all": "Все, кто делится статистикой"}


def insights(uid: str, refresh: bool = False) -> dict:
    rebuild(force=refresh)
    me = subject(uid)
    my_bucket = bucket_of(uid)
    share = bool(userdata.profile(uid).get("share_stats"))
    all_rows = [{"subject": r["subject"], "week": r["week"], "bucket": json.loads(r["bucket"]), "shared": r["shared"],
                 "features": json.loads(r["features"]), "results": json.loads(r["results"])}
                for r in db.q("SELECT * FROM outcomes")]
    own = [r for r in all_rows if r["subject"] == me]
    out = {"share": share, "min_users": MIN_USERS, "built": int(_built * 1000),
           "own": {"weeks": len(own), "effects": effects(own), "avg": averages(own)}, "groups": [],
           "bucket": my_bucket}
    if not share:
        out["note"] = "Сравнение с другими доступно, когда вы тоже делитесь обезличенной статистикой (Профиль → Данные и приватность)."
        return out
    pool = [r for r in all_rows if r["shared"]]
    seen_sets = set()
    for level, keys in LEVELS:
        if any(my_bucket.get(k) is None for k in keys):
            continue
        rows = [r for r in pool if all(r["bucket"].get(k) == my_bucket.get(k) for k in keys)]
        users = {r["subject"] for r in rows}
        if len(users) < MIN_USERS or frozenset(users) in seen_sets:
            continue
        seen_sets.add(frozenset(users))
        out["groups"].append({"level": level, "label": LEVEL_RU[level], "users": len(users), "weeks": len(rows),
                              "effects": effects(rows), "avg": averages(rows)})
    if not out["groups"]:
        n = len({r["subject"] for r in pool})
        out["note"] = (f"Для сравнения нужно хотя бы {MIN_USERS} человека, которые делятся статистикой; сейчас — {n}. "
                       "Пока — только ваши собственные данные.")
    return out


# ── эндпоинты ──

@router.get("/api/brain")
def brain_delta(since: int = 0, u=Depends(current_user)):
    return delta(max(0, since))


@router.post("/api/brain/feedback")
async def brain_feedback(request: Request, u=Depends(current_user)):
    """Сигнал клиента: человек подтвердил или поправил то, что посчитала память/ИИ. Проверяем форму и что
    в ключе нет ничего, кроме слов о еде."""
    body = await request.json()
    kind, key, value, signal = body.get("kind"), str(body.get("key") or "")[:120], body.get("value"), body.get("signal")
    if kind not in KINDS or signal not in ("confirm", "correct") or not isinstance(value, dict) or not key:
        raise HTTPException(400, "bad feedback")
    idx = food.Index()
    if kind == "food_phrase":
        items = value.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 8:
            raise HTTPException(400, "bad items")
        clean = []
        for x in items:
            f = idx.by_id.get(x.get("food_id")) if isinstance(x, dict) else None
            g = x.get("g") if isinstance(x, dict) else None
            if not f or not isinstance(g, (int, float)) or not 0 < g <= 3000:
                raise HTTPException(400, "bad item")
            clean.append({"food_id": f["id"], "g": round(float(g), 4)})
        base = key.split("|")[0]
        if "|" not in key or not impersonal(base, [idx.by_id[x["food_id"]] for x in clean]):
            raise HTTPException(400, "phrase is not about food")
        value = {"items": clean}
    elif kind == "food_alias":
        f = idx.by_id.get(value.get("food_id"))
        if not f or not impersonal(key, [f]):
            raise HTTPException(400, "bad alias")
        key, value = food.stem(key), {"food_id": f["id"]}
    elif kind == "portion":
        fid, _, unit = key.partition("|")
        g = value.get("g")
        if not fid.isdigit() or int(fid) not in idx.by_id or not unit or unit in MASS or not isinstance(g, (int, float)) or not 0 < g <= 3000:
            raise HTTPException(400, "bad portion")
        value = {"g": round(float(g), 1)}
    elif kind == "activity_alias":
        acts = {a["id"] for a in db.activities()}
        if value.get("type") not in acts or not impersonal_words(key):
            raise HTTPException(400, "bad activity alias")
        key, value = food.norm(key), {"type": value["type"]}
    elif kind == "exercise_swap":
        ex = {e["id"] for e in db.exercises()}
        if key not in ex or value.get("to") not in ex:
            raise HTTPException(400, "bad swap")
        value = {"to": value["to"]}
    else:
        raise HTTPException(400, "coach_fact пишет только сервер")
    res = learn(kind, key, value, "user", signal)
    return {"ok": True, "knowledge": res}


def impersonal_words(s: str) -> bool:
    """Короткая фраза без цифр-телефонов и имён (для синонимов активностей): до 3 слов, только строчные буквы."""
    n = food.norm(s)
    return bool(n) and len(n) <= 30 and len(n.split()) <= 3 and bool(re.fullmatch(r"[a-zа-я -]+", n)) and s == s.lower()


@router.get("/api/brain/insights")
def brain_insights(refresh: int = 0, u=Depends(current_user)):
    return insights(u["id"], bool(refresh))


@router.get("/api/brain/settings")
def brain_settings(u=Depends(current_user)):
    ensure()
    n = db.q("SELECT COUNT(*) n FROM knowledge WHERE deleted = 0")[0]["n"]
    from . import weather
    return {"web_lookup": web_allowed(), "web_forced_off": web_forced_off(), "ollama_local": ollama_local(),
            "knowledge": n, "weather": weather.allowed()}


@router.post("/api/brain/settings")
async def brain_settings_set(request: Request, u=Depends(current_user)):
    body = await request.json()
    # настройка общая для сервера — менять её может только владелец или человек за этим Mac
    from . import wan
    owner = db.q("SELECT id FROM users ORDER BY created LIMIT 1")
    if not wan.is_local(request) and (not owner or owner[0]["id"] != u["id"]):
        raise HTTPException(403, "Эту настройку меняет владелец сервера или на самом компьютере")
    if "web_lookup" in body:
        if web_forced_off() and body["web_lookup"]:
            raise HTTPException(409, "Поиск в интернете выключен на сервере (TRAINER_NO_WEB=1)")
        with db.tx() as c:
            c.execute("INSERT OR REPLACE INTO meta VALUES ('web_lookup', ?)", ("1" if body["web_lookup"] else "0",))
    from . import weather
    weather.settings_patch(body, request)
    return brain_settings(u)
