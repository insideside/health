"""«ИИ как учитель», первый этап: учёт задач ИИ, режим «в тени» и база готовых ответов.

ai_log - одна строка на обращение к модели (или на ответ, взятый без неё): вид задачи, кто, когда, сколько длилось,
размер запроса и ответа в символах, думала ли модель, успех/ошибка, модель. Содержимого (текстов запросов и ответов)
здесь нет - только размеры (docs/PRIVACY.md). Поля «в тени»: shadow = match | mismatch | none - совпала ли догадка
без модели с ответом модели (пока только еда, ai/jobs.py job_food), shadow_note - счёт «совпало N из M».
cached = 1 - ответ взят без модели (из базы ответов или памяти тренера). Доля совпадений по видам задач - основа
будущего переключения «без ИИ».

ai_answers - база готовых ответов: пояснения к нормам (переиспользуются при том же входе, флаг meta 'ai_reuse_norms')
и разборы недели (только копятся - каждая неделя своя). Ответ привязан к человеку: в тексте могут быть его цифры,
другим он не показывается.

Миграция по истории (`migrate`, один раз при старте, флаг meta 'ai_teach_v1', повтор безопасен): записи о еде,
посчитанные ИИ, → память тренера (brain), завершённые задачи ai_jobs и ответы тренера в чате → ai_log,
пояснения к нормам и разборы недели → ai_answers.

Ошибка учёта никогда не ломает задачу: всё в try/except.
"""
import hashlib
import json
import time
import traceback

from fastapi import APIRouter, Depends

from . import db
from .userdata import current_user

router = APIRouter()

SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id TEXT, started INTEGER NOT NULL,
  duration_ms INTEGER, prompt_chars INTEGER, answer_chars INTEGER, think INTEGER, ok INTEGER NOT NULL DEFAULT 1,
  error TEXT, model TEXT, shadow TEXT, shadow_note TEXT, cached INTEGER NOT NULL DEFAULT 0,
  src TEXT NOT NULL DEFAULT 'live', job_id TEXT
);
CREATE INDEX IF NOT EXISTS ai_log_started ON ai_log(started);
CREATE UNIQUE INDEX IF NOT EXISTS ai_log_job ON ai_log(job_id) WHERE job_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ai_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id TEXT, key TEXT NOT NULL, text TEXT NOT NULL,
  created INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER, ref TEXT
);
CREATE INDEX IF NOT EXISTS ai_answers_key ON ai_answers(kind, user_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS ai_answers_ref ON ai_answers(kind, ref) WHERE ref IS NOT NULL;
"""
_ready = False
MIGRATION = "ai_teach_v1"
REUSE_DAYS = 60


def ensure() -> None:
    global _ready
    if not _ready:
        db.conn().executescript(SCHEMA)
        _ready = True


def _meta(key: str) -> str | None:
    rows = db.q("SELECT value FROM meta WHERE key = ?", (key,))
    return rows[0]["value"] if rows else None


# ── учёт ──

def record(kind: str, uid: str | None, started: int, duration_ms: int | None, prompt_chars: int | None = None,
           answer_chars: int | None = None, think: bool | None = None, ok: bool = True, error: str | None = None,
           model: str | None = None, cached: bool = False, src: str = "live", job_id: str | None = None) -> int | None:
    try:
        ensure()
        with db.tx() as c:
            cur = c.execute(
                "INSERT OR IGNORE INTO ai_log (kind, user_id, started, duration_ms, prompt_chars, answer_chars, think, ok, error,"
                " model, cached, src, job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (kind or "other", uid, int(started), duration_ms, prompt_chars, answer_chars,
                 None if think is None else int(bool(think)), int(bool(ok)), (error or None) and str(error)[:160],
                 model, int(bool(cached)), src, job_id))
            return cur.lastrowid if cur.rowcount else None
    except Exception:  # noqa: BLE001 - учёт не должен ломать задачу
        traceback.print_exc()
        return None


def set_shadow(log_id: int | None, shadow: str, note: str | None = None) -> None:
    if not log_id:
        return
    try:
        ensure()
        with db.tx() as c:
            c.execute("UPDATE ai_log SET shadow = ?, shadow_note = ? WHERE id = ?", (shadow, note, log_id))
    except Exception:  # noqa: BLE001
        traceback.print_exc()


# ── база готовых ответов ──

def norms_key(t: dict, goal: dict, tone: str | None) -> str:
    """Значимые входные параметры пояснения к нормам: округлённые ккал/БЖУ, режим, цели и тон."""
    goals = sorted({str(g.get("type")) for g in goal.get("goals") or [] if isinstance(g, dict) and g.get("type")})
    if not goals:
        goals = [k for k in ("fat_kg", "muscle_upper_kg", "muscle_lower_kg", "target_weight") if goal.get(k)]
    r = lambda v, step: None if not isinstance(v, (int, float)) else int(round(v / step) * step)
    sig = {"kcal": r(t.get("kcal"), 25), "p": r(t.get("p"), 5), "f": r(t.get("f"), 5), "c": r(t.get("c"), 5),
           "mode": t.get("mode"), "goals": goals, "tone": tone or "coach"}
    return hashlib.sha256(json.dumps(sig, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


def reuse_enabled(kind: str) -> bool:
    try:
        ensure()
        return _meta(f"ai_reuse_{kind}") != "0"
    except Exception:  # noqa: BLE001
        return False


def answer_get(kind: str, uid: str, key: str, max_days: int = REUSE_DAYS) -> dict | None:
    """Свежий готовый ответ этого человека с тем же ключом (и счётчик использований +1)."""
    try:
        ensure()
        rows = db.q("SELECT id, text FROM ai_answers WHERE kind = ? AND user_id = ? AND key = ? AND created >= ?"
                    " ORDER BY created DESC LIMIT 1", (kind, uid, key, db.now_ms() - max_days * 86_400_000))
        if not rows:
            return None
        with db.tx() as c:
            c.execute("UPDATE ai_answers SET uses = uses + 1, last_used = ? WHERE id = ?", (db.now_ms(), rows[0]["id"]))
        return json.loads(rows[0]["text"])
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return None


def answer_put(kind: str, uid: str, key: str, value: dict, ref: str | None = None, created: int | None = None) -> None:
    try:
        ensure()
        with db.tx() as c:
            c.execute("INSERT OR IGNORE INTO ai_answers (kind, user_id, key, text, created, ref) VALUES (?,?,?,?,?,?)",
                      (kind, uid, key, json.dumps(value, ensure_ascii=False), created or db.now_ms(), ref))
    except Exception:  # noqa: BLE001
        traceback.print_exc()


# ── режим «в тени» для еды: догадка без модели ──

def food_guess(chunks: list[str], idx, uid: str | None = None) -> dict[str, dict | None]:
    """Кусок → {food_id, name, grams} по нечёткому сравнению названий (как подсказки модели) и порциям.
    Ничего не пишет и никому не показывается - только для сравнения с ответом модели."""
    import difflib
    from . import food
    out: dict[str, dict | None] = {}
    try:
        pieces = food.pieces_of(uid)
    except Exception:  # noqa: BLE001
        return {c: None for c in chunks}
    for chunk in chunks:
        g = None
        try:
            clean, small = food.prepare(chunk)
            name, n, unit = food.parse_chunk(clean)
            close = difflib.get_close_matches(food.norm(name), idx.fuzzy, n=1, cutoff=0.5)
            f = food.with_piece(idx.keys.get(close[0]), chunk, pieces) if close else None
            if f:
                grams = (f.get("portions") or {}).get("горсть", 20) if small else food.grams_for(f, n, unit)
                if grams:
                    g = {"food_id": f.get("id"), "name": food.norm(f["name"]), "grams": float(grams)}
        except Exception:  # noqa: BLE001
            g = None
        out[chunk] = g
    return out


def chunk_of(text: str, chunks: list[str]) -> str | None:
    """Кусок запроса, к которому относится позиция ответа (так же сопоставляет brain.learn_food_ai)."""
    from . import food
    t = food.norm(text or "")
    return next((c for c in chunks if food.norm(c) == t), None) \
        or next((c for c in chunks if t and (t in food.norm(c) or food.norm(c) in t)), None) \
        or (chunks[0] if len(chunks) == 1 else None)


def food_shadow(guess: dict[str, dict | None], rows: list[dict]) -> tuple[str, str]:
    """Сравнить догадку с итоговыми позициями ответа модели. Совпадение куска: модель дала одну позицию, тот же продукт
    (food_id или название) и граммы в пределах 20 %. → (match | mismatch | none, «совпало N из M»)."""
    from . import food
    chunks = list(guess)
    by: dict[str, list[dict]] = {c: [] for c in chunks}
    for r in rows:
        c = chunk_of(r.get("text") or r.get("name") or "", chunks)
        if c:
            by[c].append(r)
    hit = 0
    for c in chunks:
        g, rs = guess[c], by[c]
        if not g or len(rs) != 1:
            continue
        r = rs[0]
        same = (g["food_id"] is not None and r.get("food_id") == g["food_id"]) or food.norm(r.get("name") or "") == g["name"]
        rg = float(r.get("grams") or 0)
        if same and rg > 0 and abs(rg - g["grams"]) <= 0.2 * max(rg, g["grams"]):
            hit += 1
    guessed = sum(1 for c in chunks if guess[c])
    if not guessed:
        return "none", f"совпало 0 из {len(chunks)}"
    return ("match" if hit == len(chunks) else "mismatch"), f"совпало {hit} из {len(chunks)}"


def save_food_shadow(log_id: int | None, guess: dict, rows: list[dict]) -> None:
    try:
        set_shadow(log_id, *food_shadow(guess or {}, rows))
    except Exception:  # noqa: BLE001
        traceback.print_exc()


# ── миграция по истории: один раз ──

def migrate(force: bool = False) -> dict:
    """Чему научить приложение по уже накопленным ответам ИИ. Повторный запуск ничего не дублирует."""
    ensure()
    if not force and _meta(MIGRATION):
        return {"skipped": True}
    started = db.now_ms()
    res = {"food_records": 0, "food_chunks": 0, "food_learned": 0, "food_corrected": 0, "food_manual": 0,
           "jobs_logged": 0, "chat_logged": 0, "norms_answers": 0, "weekly_answers": 0}
    for step in (_migrate_food, _migrate_jobs, _migrate_chat, _migrate_answers):
        try:
            step(res)
        except Exception:  # noqa: BLE001 - одна неудачная часть не мешает остальным
            traceback.print_exc()
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (MIGRATION, json.dumps({**res, "at": started})))
    return res


def _users() -> list[str]:
    return [r["id"] for r in db.q("SELECT id FROM users")]


def _migrate_food(res: dict) -> None:
    """Записи о еде, где считала ИИ: что сейчас без модели не распознаётся (справочник + память), а ИИ тогда
    разобрала, - в память тренера, как будто ответ пришёл сейчас. Уже известное памяти не трогаем (живое обучение
    его учло). Строки с выбором варианта (choice) - пропуск, как и вживую; ингредиенты блюда с составом - только
    всей группой; строки, добавленные руками (added), - ответ человека на «это вместо непосчитанного» (covers),
    учим как поправку человека; граммы, поправленные руками (base100), - тоже поправка человека."""
    from . import brain, food
    for uid in _users():
        idx = food.Index(uid)
        for r in db.list_kind(uid, "food"):
            d = r["data"]
            items = [i for i in d.get("items") or [] if isinstance(i, dict)]
            if not items or not (d.get("calc") == "ai" or any(i.get("source") in ("ai", "web") for i in items)):
                continue
            res["food_records"] += 1
            text = d.get("text") or ""
            try:
                done, rest = food.quick_parse(text, idx, uid=uid)
            except Exception:  # noqa: BLE001
                continue
            _learn_manual(items, idx, res)
            rest = food.drop_covered(rest, d)
            if not rest:
                continue
            known, rest = brain.resolve(rest, idx)
            if not rest:
                continue
            # строки записи, которые и сейчас считаются без модели (справочник, память), - не ответ ИИ по куску
            plain = {food.norm(i.get("text") or "") for i in done + known}
            groups: dict[str, list[dict]] = {}
            for it in items:
                if it.get("added") or food.norm(it.get("text") or "") in plain:
                    continue
                c = chunk_of(it.get("text") or "", rest)
                if c:
                    groups.setdefault(c, []).append(it)
            for chunk, gi in groups.items():
                res["food_chunks"] += 1
                if any(i.get("choice") for i in gi):
                    continue
                dishes = {i["dish"] for i in gi if i.get("dish")}
                if dishes and any(i.get("dish") in dishes and i not in gi for i in items):
                    continue                     # ингредиенты блюда разошлись по разным кускам - не всей группой
                key = brain.phrase_key(chunk)
                edited = any(i.get("base100") for i in gi)
                if not key or (brain._row("food_phrase", key) and not edited):
                    continue
                rows = [{**i} for i in gi]
                learned = brain.learn_food_ai([chunk], rows, idx, source="user" if edited else "ai",
                                              signal="correct" if edited else "observe")
                if learned:
                    res["food_corrected" if edited else "food_learned"] += 1


def _learn_manual(items: list[dict], idx, res: dict) -> None:
    """«+ новый продукт» / «+ из справочника» с пометкой «это вместо непосчитанного»: кусок → продукт человека."""
    from . import brain
    by: dict[str, list[dict]] = {}
    for it in items:
        if it.get("added") and len(it.get("covers") or []) == 1:
            by.setdefault(str(it["covers"][0]), []).append(it)
    for chunk, gi in by.items():
        if not all(isinstance(i.get("food_id"), int) and i.get("grams") for i in gi):
            continue
        rows = [{**i, "text": chunk} for i in gi]
        if brain.learn_food_ai([chunk], rows, idx, source="user", signal="correct"):
            res["food_manual"] += 1


def _size(s) -> int | None:
    return len(s) if isinstance(s, str) else None


def _migrate_jobs(res: dict) -> None:
    for j in db.q("SELECT id, user_id, kind, input, result, status, error, created, finished FROM ai_jobs"
                  " WHERE status IN ('done', 'error') AND finished IS NOT NULL"):
        lid = record(j["kind"], j["user_id"], j["created"], max(0, j["finished"] - j["created"]),
                     prompt_chars=_size(j["input"]), answer_chars=_size(j["result"]), ok=j["status"] == "done",
                     error="ошибка" if j["status"] == "error" else None, src="history", job_id=j["id"])
        if lid:
            res["jobs_logged"] += 1


def _migrate_chat(res: dict) -> None:
    """Ответы тренера в чате, для которых задачи уже нет: только учёт (размер), содержимое не учим - оно личное."""
    have = set()
    for j in db.q("SELECT result FROM ai_jobs WHERE kind = 'chat' AND result IS NOT NULL"):
        try:
            have.add(json.loads(j["result"]).get("record_id"))
        except (ValueError, AttributeError):
            pass
    for r in db.q("SELECT id, user_id, data, updated_at FROM records WHERE kind = 'chat' AND deleted = 0"):
        try:
            d = json.loads(r["data"])
        except ValueError:
            continue
        if d.get("source") != "ai" or r["id"] in have:
            continue
        lid = record("chat", r["user_id"], d.get("created") or r["updated_at"], None,
                     answer_chars=_size(d.get("text")), src="history", job_id=f"chat:{r['id']}")
        if lid:
            res["chat_logged"] += 1


def _migrate_answers(res: dict) -> None:
    from . import userdata
    for uid in _users():
        goal, tone = userdata.goal(uid), userdata.profile(uid).get("tone")
        for r in db.list_kind(uid, "target"):
            t = r["data"]
            if (t.get("explanation") or "").strip():
                before = _count("norms")
                answer_put("norms", uid, norms_key(t, goal, tone),
                           {"text": t["explanation"], "tips": t.get("tips") or []}, ref=r["id"], created=r["updated_at"])
                res["norms_answers"] += _count("norms") - before
        for r in db.list_kind(uid, "coach"):
            d = r["data"]
            if d.get("kind") != "weekly" or not (d.get("text") or "").strip():
                continue
            before = _count("weekly")
            answer_put("weekly", uid, weekly_key(d),
                       {k: d.get(k) for k in ("title", "text", "next", "day_tip", "grade")},
                       ref=r["id"], created=d.get("created") or r["updated_at"])
            res["weekly_answers"] += _count("weekly") - before


def weekly_key(d: dict) -> str:
    """Вход разбора недели: неделя и оценка. Разбор не переиспользуется (каждая неделя своя) - ключ только для порядка."""
    sig = {"monday": d.get("monday"), "grade": d.get("grade") or (d.get("stats") or {}).get("grade")}
    return hashlib.sha256(json.dumps(sig, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:24]


def _count(kind: str) -> int:
    return db.q("SELECT COUNT(*) n FROM ai_answers WHERE kind = ?", (kind,))[0]["n"]


# ── статистика для человека ──

KIND_RU = {"food": "Разбор еды", "foodlookup": "Поиск продукта", "norms": "Пояснение к нормам", "program": "Программа тренировок",
           "weekly": "Разбор недели", "mealplan": "Рацион", "mealplan_day": "Рацион на день", "recipe": "Рецепт",
           "analysis": "Разбор истории", "chat": "Чат с тренером", "other": "Другое"}


def stats(uid: str, days: int = 30) -> dict:
    """Задачи и ответы - только свои (сколько спрашивает партнёр, другим не видно); память о еде - общая."""
    ensure()
    since = db.now_ms() - days * 86_400_000
    rows = db.q("SELECT kind, COUNT(*) n, SUM(cached) cached, AVG(CASE WHEN cached = 0 AND ok = 1 THEN duration_ms END) avg_ms,"
                " SUM(CASE WHEN shadow = 'match' THEN 1 ELSE 0 END) sm, SUM(CASE WHEN shadow IN ('match','mismatch','none')"
                " THEN 1 ELSE 0 END) st, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) err"
                " FROM ai_log WHERE user_id = ? AND started >= ? GROUP BY kind ORDER BY n DESC", (uid, since))
    total = {r["kind"]: r["n"] for r in db.q("SELECT kind, COUNT(*) n FROM ai_log WHERE user_id = ? GROUP BY kind", (uid,))}
    answers = {r["kind"]: (r["n"], r["u"] or 0) for r in db.q("SELECT kind, COUNT(*) n, SUM(uses) u FROM ai_answers WHERE user_id = ? GROUP BY kind", (uid,))}
    kinds = [{"kind": r["kind"], "label": KIND_RU.get(r["kind"], KIND_RU["other"]), "n": r["n"], "all": total.get(r["kind"], r["n"]),
              "avg_s": round(r["avg_ms"] / 1000, 1) if r["avg_ms"] else None, "cached": r["cached"] or 0,
              "shadow_n": r["st"] or 0, "shadow_pct": round(100 * r["sm"] / r["st"]) if r["st"] else None,
              "errors": r["err"] or 0, "answers": answers.get(r["kind"], (0, 0))[0]} for r in rows]
    seen = {k["kind"] for k in kinds}
    for k, (n, _) in answers.items():
        if k not in seen:
            kinds.append({"kind": k, "label": KIND_RU.get(k, KIND_RU["other"]), "n": 0, "all": total.get(k, 0), "avg_s": None,
                          "cached": 0, "shadow_n": 0, "shadow_pct": None, "errors": 0, "answers": n})
    kn = {r["kind"]: r["n"] for r in db.q("SELECT kind, COUNT(*) n FROM knowledge WHERE deleted = 0 AND confidence >= 0.5 GROUP BY kind")}
    brain_hits = db.q("SELECT COUNT(*) n FROM ai_log WHERE user_id = ? AND cached = 1 AND started >= ?", (uid, since))[0]["n"]
    return {"days": days, "kinds": kinds, "phrases": kn.get("food_phrase", 0), "aliases": kn.get("food_alias", 0),
            "portions": kn.get("portion", 0), "answers": sum(n for n, _ in answers.values()),
            "reused": sum(u for _, u in answers.values()), "without_model": brain_hits,
            "reuse_norms": reuse_enabled("norms"), "taught_from_history": bool(_meta(MIGRATION))}


@router.get("/api/ai/stats")
def ai_stats(days: int = 30, u=Depends(current_user)):
    return stats(u["id"], max(1, min(365, days)))


def start() -> None:
    """При старте сервера: таблицы и однократное обучение по истории."""
    try:
        ensure()
        t = time.time()
        res = migrate()
        if not res.get("skipped"):
            print(f"[ai] обучение по истории: {res} за {time.time() - t:.1f} с")
    except Exception:  # noqa: BLE001 - старт сервера важнее
        traceback.print_exc()
