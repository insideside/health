"""ИИ-задачи: очередь, выполнение по одной, результаты — в записи (их забирает синхронизация).

Виды: food (БЖУ записи о еде), norms (пояснение к нормам), program (программа тренировок),
weekly (разбор недели), mealplan (рацион), recipe (рецепт), analysis (разбор истории),
chat (ответ тренера, обработчик в app/chat.py). Запускаются только по запросу пользователя
(и комментарий к нормам после пересчёта, если ИИ у человека включена).

Модель не запущена — задачи не отклоняются, а ждут в очереди (статус queued, в ответе waiting: true)
и выполняются сами, когда она заработает. Проверка — раз в минуту и только пока есть ждущие задачи.
"""
import asyncio
import difflib
import html
import json
import math
import re
import time
import traceback
import uuid
from datetime import date, timedelta

from .. import brain, db, food, norms, nutrition, userdata
from . import ollama
from .ollama import AIError, ask_json

# виды, которые клиент может заказать через POST /api/ai/jobs
USER_KINDS = ("program", "weekly", "mealplan", "recipe", "analysis", "foodlookup")

WAIT_DAYS = 7          # столько задача ждёт спящую модель, потом — ошибка с объяснением

_queue: asyncio.Queue | None = None
_ai = {"ok": None, "reason": "", "at": 0.0}


async def ai_state(max_age: float = 30) -> dict:
    """Доступна ли модель — с кэшем: опрос /api/sync/head не должен каждый раз стучаться в Ollama."""
    now = time.monotonic()
    if _ai["ok"] is None or now - _ai["at"] > max_age:
        st = await ollama.status()
        _ai.update(ok=st["ok"], reason=st.get("reason", ""), at=now)
    return {"ok": _ai["ok"], "reason": _ai["reason"]}


def waiting() -> bool:
    """Модель сейчас спит (по последней проверке) — новые задачи будут ждать."""
    return _ai["ok"] is False
_loop: asyncio.AbstractEventLoop | None = None


# ── очередь ──

async def start() -> None:
    global _queue, _loop
    _queue = asyncio.Queue()
    _loop = asyncio.get_running_loop()
    # задачи, прерванные остановкой сервера, — заново
    for r in db.q("SELECT id FROM ai_jobs WHERE status IN ('queued', 'running') ORDER BY created"):
        _queue.put_nowait(r["id"])
    asyncio.create_task(_worker())


def submit(uid: str, kind: str, input_: dict, replace: bool = False) -> str:
    """replace — прежние ещё не начатые задачи того же вида этого человека отменяются
    (комментарий к нормам нужен только к последнему пересчёту)."""
    job_id = uuid.uuid4().hex
    with db.tx() as c:
        if replace:
            c.execute("UPDATE ai_jobs SET status = 'cancelled', finished = ? WHERE user_id = ? AND kind = ? AND status = 'queued'",
                      (db.now_ms(), uid, kind))
        c.execute("INSERT INTO ai_jobs VALUES (?,?,?,?, 'queued', NULL, NULL, ?, NULL)",
                  (job_id, uid, kind, json.dumps(input_, ensure_ascii=False), db.now_ms()))
    _loop.call_soon_threadsafe(_queue.put_nowait, job_id)
    return job_id


def get_job(job_id: str) -> dict | None:
    rows = db.q("SELECT * FROM ai_jobs WHERE id = ?", (job_id,))
    if not rows:
        return None
    r = rows[0]
    ahead = db.q("SELECT COUNT(*) n FROM ai_jobs WHERE status = 'queued' AND created < ?", (r["created"],))[0]["n"]
    return {"id": r["id"], "user_id": r["user_id"], "kind": r["kind"], "status": r["status"],
            "result": json.loads(r["result"]) if r["result"] else None, "error": r["error"], "ahead": ahead,
            "waiting": r["status"] == "queued" and waiting()}


async def _await_model(created: int) -> bool:
    """Ждём, пока модель заработает (проверка раз в минуту). False — задача ждала дольше WAIT_DAYS."""
    while not (await ai_state(max_age=5))["ok"]:
        if db.now_ms() - created > WAIT_DAYS * 86_400_000:
            return False
        await asyncio.sleep(60)
    return True


def _live(job_id: str) -> dict | None:
    rows = db.q("SELECT * FROM ai_jobs WHERE id = ?", (job_id,))
    return rows[0] if rows and rows[0]["status"] in ("queued", "running") else None


async def _worker() -> None:
    while True:
        job_id = await _queue.get()
        while (job := _live(job_id)):
            if not await _await_model(job["created"]):
                _set(job_id, "error", error=f"ИИ была недоступна больше {WAIT_DAYS} дней - запрос отменён, повторите его")
                break
            if not (job := _live(job_id)):          # пока ждали, задачу заменили более свежей
                break
            _set(job_id, "running")
            try:
                result = await HANDLERS[job["kind"]](job["user_id"], json.loads(job["input"]))
                _set(job_id, "done", result=result)
            except AIError as e:
                if not (await ai_state(max_age=0))["ok"]:   # модель упала посреди задачи — подождём и повторим
                    _set(job_id, "queued")
                    continue
                _set(job_id, "error", error=str(e))
            except Exception as e:  # noqa: BLE001 — любая ошибка задачи должна дойти до пользователя
                traceback.print_exc()
                _set(job_id, "error", error=f"{type(e).__name__}: {e}")
            break


def _set(job_id: str, status: str, result=None, error=None) -> None:
    with db.tx() as c:
        c.execute("UPDATE ai_jobs SET status = ?, result = ?, error = ?, finished = ? WHERE id = ?",
                  (status, json.dumps(result, ensure_ascii=False) if result is not None else None, error,
                   db.now_ms() if status in ("done", "error") else None, job_id))


# ── еда ──

FOOD_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "text": {"type": "string"}, "name": {"type": "string"}, "grams": {"type": "number"},
            "kcal": {"type": "number"}, "p": {"type": "number"}, "f": {"type": "number"}, "c": {"type": "number"},
        },
        "required": ["text", "name", "grams", "kcal", "p", "f", "c"],
    }}},
    "required": ["items"],
}

FOOD_SYSTEM = """Ты диетолог. Пользователь пишет, что съел, свободным текстом по-русски.
Для каждого продукта или блюда верни:
- text — исходный фрагмент;
- name — каноническое название по-русски, как в таблицах калорийности, с состоянием (варёный, жареный, сырой).
  Если среди подсказок есть подходящее название — используй его дословно;
- grams — сколько съедено в граммах. Если вес не указан — оцени по типичной порции
  (яйцо 55 г, ломтик хлеба 30 г, тарелка супа 300 г, чашка кофе 200 мл ≈ 200 г);
- kcal, p, f, c — калории, белки, жиры, углеводы НА 100 г продукта (не на порцию).
Составное блюдо («кофе с молоком», «гречка с курицей») — одна позиция с усреднёнными значениями на 100 г.
Не выдумывай продукты, которых нет в тексте."""


async def job_food(uid: str, inp: dict) -> dict:
    rec = db.get(inp["record_id"])
    if not rec or rec["user_id"] != uid:
        raise AIError("Запись о еде не найдена")
    idx = food.Index(uid)          # с историей: «гречка» без уточнения — в том состоянии, что человек ест обычно
    done, rest = food.quick_parse(rec["data"].get("text", ""), idx)
    if rest:                       # что ИИ уже разбирала раньше — из памяти «мозга», без модели
        more, rest = brain.resolve(rest, idx)
        done += more
    used_ai = bool(rest)
    if rest:
        hints = sorted({k for chunk in rest
                        for k in difflib.get_close_matches(food.norm(food.parse_chunk(chunk)[0]),
                                                           idx.fuzzy, n=4, cutoff=0.5)})
        user = "Съедено:\n" + "\n".join(f"- {c}" for c in rest)
        if hints:
            user += "\n\nПодсказки — названия из справочника:\n" + ", ".join(hints)
        out = await ask_json(FOOD_SYSTEM, user, FOOD_SCHEMA, temperature=0.1)
        ai_items = []
        for it in out.get("items", []):
            grams = max(0.0, float(it.get("grams") or 0))
            if not grams:
                continue
            known = idx.match(it["name"])
            if known:
                ai_items.append(food.item_from(known, grams, it.get("text") or it["name"], source="db"))
            else:
                per100 = {k: max(0.0, float(it.get(k) or 0)) for k in ("kcal", "p", "f", "c")}
                db.learn_food(it["name"], per100, uid=uid)
                learned = db.food_by_name(it["name"])      # id нужен, чтобы запомнить фразу для всех устройств
                ai_items.append(food.item_from({**(learned or {}), "name": it["name"], **per100}, grams,
                                               it.get("text") or it["name"], source="ai"))
        brain.learn_food_ai(rest, ai_items, idx)            # «мозг»: в следующий раз — без ИИ
        done += ai_items
    return _save_food(rec, done, calc="ai" if used_ai else "db")


def _save_food(rec: dict, items: list[dict], calc: str = "db") -> dict:
    items = food.apply_preferences(items, rec["user_id"])
    # calc — чем посчитано: db (справочник и память) | ai (уточнено ИИ); клиент показывает пометку
    data = {**rec["data"], "items": items, "totals": food.totals(items), "status": "calculated", "calc": calc,
            "unresolved": None, "calc_error": None, "partial": None}
    saved = db.server_put(rec["user_id"], "food", rec["id"], data, rec["date"])
    return {"record_id": saved["id"], "totals": data["totals"]}


# ── общее для промптов ──

GOAL_LABEL = {"lose_fat": "сбросить жир", "gain_muscle": "набрать мышцы", "endurance": "выносливость",
              "tone": "тонус", "sleep": "качество сна", "gain_weight": "набрать вес", "maintain": "удержать форму",
              "posture": "осанка", "neck": "шея и второй подбородок"}
ZONE_LABEL = {"chest": "грудь", "shoulders": "плечи", "arms": "руки", "back": "спина", "abs": "пресс", "sides": "бока",
              "glutes": "ягодицы", "legs": "ноги", "neck": "шея", "knees": "колени", "lower_back": "поясница",
              "wrists": "запястья", "ankles": "голеностопы", "hips": "тазобедренные"}
HABIT_LABEL = {"less_sugar": "меньше сахара", "less_flour": "меньше мучного", "less_coffee": "меньше кофе",
               "less_alcohol": "меньше алкоголя", "less_fastfood": "меньше фастфуда",
               "less_late_eating": "не есть поздно", "more_veg": "больше овощей", "more_protein": "больше белка",
               "more_fiber": "больше клетчатки"}
PRIORITY_LABEL = {1: "главная", 2: "важная", 3: "по возможности"}
# коды записей → слова для промптов: модель иначе тащит в текст «broken» и «cheat»
WELLBEING_LABEL = {"great": "отлично", "good": "хорошо", "meh": "так себе", "broken": "разбит"}
SORENESS_LABEL = {"none": "не болят мышцы", "light": "мышцы слегка болят", "strong": "мышцы сильно болят"}
STRESS_LABEL = {"low": "стресс низкий", "mid": "стресс средний", "high": "стресс высокий"}
SLEEPY_LABEL = {"none": "днём не клонит в сон", "some": "временами сонливость днём", "strong": "сильная сонливость днём"}
DAYTYPE_LABEL = {"cheat": "читмил", "special": "особый день", "sick": "болеет", "rest": "день отдыха"}


def _fmt_num(v) -> str:
    return "?" if v is None else f"{v:g}".replace(".", ",")


def metric_goal_text(g: dict, uid: str | None = None) -> str:
    """Цель-показатель v3: «талия 94 → 88 см (сейчас 92), к 2026-12-01»."""
    m = norms.METRICS.get(g.get("metric")) or {"label": g.get("metric"), "unit": g.get("unit") or ""}
    s = f"{m['label']} {_fmt_num(g.get('from'))} → {_fmt_num(g.get('to'))} {m['unit']}"
    cur = norms.metric_current(uid, g["metric"]) if uid else None
    if cur is not None:
        s += f" (сейчас {_fmt_num(cur)})"
    if g.get("deadline"):
        s += f", к {g['deadline']}"
    return s


def goals_text(goal: dict, uid: str | None = None) -> str:
    """Цели человеческим текстом (v2 списком, v1 — через norms.goals_of, v3 — цели-показатели)."""
    parts = []
    for g in sorted(norms.goals_of(goal), key=lambda g: g["priority"]):
        if g["type"] == "metric":
            parts.append(f"{metric_goal_text(g, uid)} — {PRIORITY_LABEL.get(g['priority'], '')}")
            continue
        s = GOAL_LABEL.get(g["type"], g["type"])
        if g.get("amount"):
            s += f" {g['amount']:g} кг"
        if g.get("zones"):
            s += " (зоны: " + ", ".join(ZONE_LABEL.get(z, z) for z in g["zones"]) + ")"
        parts.append(f"{s} — {PRIORITY_LABEL.get(g['priority'], '')}")
    out = "; ".join(parts) or "удержать форму"
    if goal.get("habits"):
        out += ". Привычки: " + ", ".join(HABIT_LABEL.get(h, h) for h in goal["habits"])
    if goal.get("deadline"):
        out += f". Срок: {goal['deadline']}"
    if goal.get("text"):
        out += f". Своими словами: {goal['text']}"
    return out


def person_text(uid: str, prof: dict | None = None) -> str:
    prof = prof or userdata.profile(uid)
    w = userdata.latest_weight(uid)
    age = norms.age_on(prof["birth"], date.today()) if prof.get("birth") else None
    sex = {"m": "мужчина", "f": "женщина"}.get(prof.get("sex"), "пол не указан")
    return f"{prof.get('name') or 'Клиент'}: {sex}{f', {age} лет' if age else ''}, рост {prof.get('height') or '?'} см, вес {w or '?'} кг"


def system_for(uid: str, role: str, health: bool = True) -> str:
    """Системный промпт: роль + тон + общие правила + всё о здоровье и питании с оговоркой."""
    prof = userdata.profile(uid)
    s = f"{role} Твой тон: {userdata.tone(uid)}. {userdata.RULES}"
    if health:
        notes = userdata.health_notes(prof, userdata.open_injuries(uid))
        if notes:
            s += ("\n\nОБЯЗАТЕЛЬНО учитывай о клиенте:\n" + notes +
                  f"\nЕсли что-то из этого влияет на совет — скажи прямо. {userdata.NOT_MEDICAL}")
        s += "\n\n" + userdata.SUPP_RULES
    return s


def _hours(bed: str | None, wake: str | None) -> float | None:
    try:
        bh, bm = map(int, bed.split(":"))
        wh, wm = map(int, wake.split(":"))
    except (AttributeError, ValueError):
        return None
    return round(((wh * 60 + wm) - (bh * 60 + bm)) % (24 * 60) / 60, 1)


def snooze_min(d: dict) -> int | None:
    """Минуты дрёмы между первым будильником и подъёмом (None - будильник не указан или не в пределах сна)."""
    total, to_alarm = _hours(d.get("bed"), d.get("wake")), _hours(d.get("bed"), d.get("alarm"))
    if not d.get("alarm") or total is None or to_alarm is None:
        return None
    s = round((total - to_alarm) * 60)
    return s if 0 < s <= 240 else None


def sleep_hours_of(d: dict) -> float | None:
    """Часы сна. Дрёма после первого будильника (рваный лёгкий сон) засчитывается наполовину - как на устройстве."""
    h = d.get("hours") or _hours(d.get("bed"), d.get("wake"))
    s = snooze_min(d) if not d.get("hours") else None
    return round(h - s / 120, 1) if h and s else h


# ── пояснение к нормам ──

NORMS_SCHEMA = {
    "type": "object",
    "properties": {"text": {"type": "string"}, "tips": {"type": "array", "items": {"type": "string"}}},
    "required": ["text", "tips"],
}


async def job_norms(uid: str, inp: dict) -> dict:
    rec = db.get(inp["target_id"])
    if not rec:
        raise AIError("Нормы не найдены")
    t = rec["data"]
    prof, goal = userdata.profile(uid), userdata.goal(uid)
    system = system_for(uid, "Ты персональный тренер и нутрициолог. Цифры уже посчитаны по формулам — "
                             "объясни, откуда они и как их выполнять. Честно оцени реалистичность цели и срока.")
    tl = t.get("timeline") or {}
    opts = "; ".join(f"{norms.LEVEL_LABEL[o['label']]}: {o['weeks']} нед. (до {o['deadline']})" for o in tl.get("options") or [])
    user = f"""Клиент: {person_text(uid, prof)}, ИМТ {t.get('bmi')}, {t.get('activity_label')}.
Цели: {goals_text(goal)}.
Режим: {t.get('mode')}, интенсивность: {(t.get('intensity') or {}).get('label', '—')}.
Базовый обмен {t.get('bmr')} ккал, расход {t.get('tdee')} ккал (из них плановые нагрузки ~{t.get('exercise_kcal', 0)} ккал/день).
Нормы: {t.get('kcal')} ккал, белок {t.get('p')} г, жиры {t.get('f')} г, углеводы {t.get('c')} г, клетчатка {t.get('fiber', '—')} г,
вода {t.get('water_glasses')} стаканов, шаги {t.get('steps')}, сон {t.get('sleep_hours', '—')} ч.
Силовых в неделю: {(t.get('intensity') or {}).get('weekly_sessions', '—')}, кардио {(t.get('intensity') or {}).get('cardio_minutes', '—')} мин/нед.
Реалистично нужно недель: {t.get('weeks_needed') or '—'}. Варианты срока: {opts or '—'}.
Предупреждения: {'; '.join(t.get('warnings') or []) or 'нет'}.
Пояснения расчёта: {'; '.join(t.get('notes') or []) or 'нет'}.

text — 3–6 предложений: что означают нормы и насколько реальна цель.
tips — 3–5 конкретных советов на ближайшие две недели."""
    out = await ask_json(system, user, NORMS_SCHEMA, temperature=0.5, think=True)
    cur = db.get(rec["id"])["data"]
    db.server_put(uid, "target", rec["id"], {**cur, "explanation": out.get("text", ""), "tips": out.get("tips", [])})
    return {"target_id": rec["id"]}


# ── программа тренировок ──

PROGRAM_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"}, "summary": {"type": "string"}, "progression": {"type": "string"},
        "days": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "name": {"type": "string"}, "focus": {"type": "string"},
                "warmup": {"type": "array", "items": {"type": "string"}},
                "exercises": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}, "sets": {"type": "integer"}, "reps": {"type": "string"},
                                   "rest_sec": {"type": "integer"}, "note": {"type": "string"}},
                    "required": ["id", "sets", "reps", "rest_sec", "note"],
                }},
                "cooldown": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["name", "focus", "warmup", "exercises", "cooldown"],
        }},
    },
    "required": ["title", "summary", "progression", "days"],
}

EQUIP_LABEL = {"mat": "коврик", "dumbbells": "гантели", "chair": "стулья", "ab_wheel": "ролик для пресса",
               "pullup_bar": "турник", "dip_bars": "брусья", "kettlebell": "гиря", "barbell": "штанга", "bench": "скамья",
               "band": "резинки", "jump_rope": "скакалка", "stepper": "степпер", "fitball": "фитбол",
               "foam_roller": "массажный ролик", "trx": "петли TRX", "bike": "велотренажёр", "treadmill": "беговая дорожка",
               "elliptical": "эллипс", "rower": "гребной тренажёр", "machine": "тренажёры", "cable": "блочный тренажёр",
               "rack": "силовая рама"}
CARDIO_MACHINES = {"treadmill", "bike", "elliptical", "rower", "stepper"}
LEVEL_LABEL = {1: "новичок", 2: "средний", 3: "продвинутый"}
WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
INTENSITY_LABEL = {"low": "лёгкая", "mid": "средняя", "high": "высокая"}
SLOT_LABEL = {"morning": "утром", "day": "днём", "evening": "вечером", "any": "в любое время", "none": "нет времени"}
LOWER_ZONES = {"legs", "glutes"}


def excluded_codes(uid: str, prof: dict) -> set[str]:
    """Коды противопоказаний: ограничения профиля + зоны открытых травм (как plan.excludedFor на клиенте)."""
    out = set(prof.get("limitations") or [])
    out |= {i.get("zone") for i in userdata.open_injuries(uid) if i.get("zone")}
    return out


def allowed_exercises(place: str, equipment: list[str], excluded: set[str] | None = None,
                      missing: set[str] | None = None, skip_ids: set[str] | None = None) -> list[dict]:
    """missing — чего нет в зале (profile.gym_equipment.missing), skip_ids — «не предлагать» (profile.exercise_prefs)."""
    have = set(equipment) | {"mat", "chair"} if place == "home" else None
    out = []
    for e in db.exercises():
        if place not in e.get("place", []):
            continue
        if skip_ids and e["id"] in skip_ids:
            continue
        if have is not None and not set(e.get("equipment", [])) <= have:
            continue
        if place == "gym" and missing and set(e.get("equipment", [])) & missing:
            continue
        if excluded and set(e.get("contraindications") or []) & excluded:
            continue
        out.append(e)
    return out


def _reps_minutes(reps: str) -> float | None:
    """«15-20 мин» (кардио-блок) → 17,5 минуты; иначе None."""
    if "мин" not in str(reps):
        return None
    nums = [float(n) for n in re.findall(r"\d+", str(reps))[:2]]
    return sum(nums) / len(nums) if nums else None


def _est_minutes(day: dict) -> float:
    """Грубая оценка длительности: подход ~45 с + отдых, плюс разминка и заминка; кардио-блок — его минуты."""
    sec = sum((_reps_minutes(x["reps"]) or 0) * 60 * x["sets"] if _reps_minutes(x["reps"]) else x["sets"] * (45 + x["rest_sec"])
              for x in day["exercises"])
    return sec / 60 + 2 * len(day["warmup"]) + 1.5 * len(day["cooldown"])


def _activity_days(prof: dict) -> dict[int, list[dict]]:
    """Активности, привязанные к дням недели: {0..6: [активность]}."""
    out: dict[int, list[dict]] = {}
    for a in prof.get("activities") or []:
        for wd in a.get("weekdays") or []:
            out.setdefault(int(wd), []).append(a)
    return out


def _activities_text(prof: dict) -> tuple[str, list[dict]]:
    lines, considered = [], []
    for a in prof.get("activities") or []:
        info = userdata.activity_info(a.get("type")) or {}
        name = info.get("name") or a.get("type")
        days = ", ".join(WEEKDAYS[int(d)] for d in a.get("weekdays") or [])
        zones = ", ".join(ZONE_LABEL.get(z, z) for z in info.get("zones") or [])
        lines.append(f"- {name}: {a.get('per_week') or len(a.get('weekdays') or []) or '?'} раз/нед"
                     f"{' (' + days + ')' if days else ''}, ~{a.get('minutes') or '?'} мин, "
                     f"интенсивность {INTENSITY_LABEL.get(a.get('intensity'), 'средняя')}"
                     f"{', нагрузка: ' + info['load'] if info.get('load') else ''}{', зоны: ' + zones if zones else ''}")
        sup = info.get("support") or {}
        if sup.get("why"):
            # чем дополнить этот спорт в зале/дома - программа должна это закрывать
            lines.append(f"  дополнить: {', '.join(ZONE_LABEL.get(z, z) for z in sup.get('zones') or [])} - {sup['why']}"
                         + (f" Осторожно: {sup['avoid']}" if sup.get("avoid") else ""))
        considered.append({"type": a.get("type"), "name": name, "per_week": a.get("per_week"),
                           "weekdays": a.get("weekdays") or [], "minutes": a.get("minutes"),
                           "intensity": a.get("intensity"), "zones": info.get("zones") or [], "load": info.get("load")})
    return "\n".join(lines), considered


def _program_days(out: dict, by_id: dict, weekdays: list[int], day_minutes: dict) -> list[dict]:
    """Ответ модели → дни программы: только id из каталога, без повторов, в бюджет времени."""
    n_days = len(weekdays)
    days = []
    for n, d in enumerate(out.get("days", [])[:n_days]):
        def keep(ids):
            return [i for i in ids if i in by_id][:5]
        exs = []
        for x in d.get("exercises", []):
            if x.get("id") not in by_id or any(e["id"] == x["id"] for e in exs):
                continue
            e = by_id[x["id"]]
            exs.append({"id": e["id"], "name": e["name"], "unit": e["unit"], "per_side": e.get("per_side", False),
                        "sets": max(1, min(8, int(x.get("sets") or 3))), "reps": str(x.get("reps") or "10"),
                        "rest_sec": max(0, min(600, int(x.get("rest_sec") or 90))), "note": x.get("note", "")})
        if not exs:
            continue
        day = {"name": _day_name(d.get("name"), d.get("focus", ""), len(days)), "focus": d.get("focus", ""),
               "warmup": keep(d.get("warmup", [])), "exercises": exs, "cooldown": keep(d.get("cooldown", []))}
        # бюджет времени — жёсткий: лишнее с конца (кроме последнего упражнения на кор), не меньше трёх упражнений
        limit = day_minutes[weekdays[min(n, n_days - 1)]] * 1.1
        while _est_minutes(day) > limit and len(day["exercises"]) > 3:
            drop = next((i for i in range(len(day["exercises"]) - 2, -1, -1)
                         if by_id[day["exercises"][i]["id"]].get("category") != "strength" or i > 1), None)
            day["exercises"].pop(drop if drop is not None else -1)
        while _est_minutes(day) > limit and any(x["sets"] > 2 for x in day["exercises"]):
            for x in day["exercises"]:
                if x["sets"] > 2:
                    x["sets"] -= 1
        day["minutes"] = round(_est_minutes(day))
        days.append(day)
    return days



def _day_name(name: str | None, focus: str, i: int) -> str:
    """Модель любит называть дни «A», «B» — в календаре это ни о чём не говорит."""
    name = re.sub(r"\s*[—–]\s*", " - ", (name or "").strip())   # длинного тире в интерфейсе нет
    if len(name) <= 3:
        label = name or chr(ord("A") + i)
        return f"День {label}: {focus}" if focus else f"День {label}"
    return name


def cardio_weekly_target(prof: dict, goal: dict, target: dict) -> int:
    """Недельная норма кардио: из норм (intensity.cardio_minutes), иначе по цели (как plan.cardioTarget на клиенте)."""
    v = ((target or {}).get("intensity") or {}).get("cardio_minutes")
    if v:
        return int(v)
    types = {g.get("type") for g in (goal or {}).get("goals") or []}
    if "lose_fat" in types or (goal or {}).get("fat_kg"):
        return 150
    if types & {"gain_muscle", "gain_weight"}:
        return 60
    return 120


def _cardio_text(prof: dict, goal: dict, target: dict, place: str, catalog: list[dict]) -> tuple[str, dict]:
    """Кардио-предпочтения клиента (profile.cardio) и что из кардио есть в каталоге этого места."""
    cardio = prof.get("cardio") or {}
    likes = [x for x in cardio.get("likes") or [] if isinstance(x, str)]
    names = []
    for x in likes:
        a = userdata.activity_info(x)
        e = next((e for e in db.exercises() if e["id"] == x), None)
        names.append((a or {}).get("name") or (e or {}).get("name") or x)
    weekly = cardio_weekly_target(prof, goal, target)
    in_cat = [e for e in catalog if e.get("category") == "cardio"]
    machines = [e for e in in_cat if set(e.get("equipment") or []) & CARDIO_MACHINES]
    liked_ids = set(likes) | {e["id"] for e in machines if any(n.lower()[:5] in e["name"].lower() for n in names if len(n) >= 5)}
    home_m = sorted(set(prof.get("equipment") or []) & CARDIO_MACHINES)
    lines = [f"Недельная норма кардио: {weekly} мин (кардио-активности клиента засчитываются)."]
    if names:
        lines.append("Любимое кардио клиента: " + ", ".join(names) + ".")
    if cardio.get("places"):
        lines.append("Где клиенту удобно кардио: " + ", ".join({"gym": "в зале", "home": "дома", "outdoor": "на улице"}.get(p, p)
                                                              for p in cardio["places"]) + ".")
    if home_m:
        lines.append("Кардиотренажёры дома: " + ", ".join(EQUIP_LABEL.get(x, x) for x in home_m) + ".")
    if machines:
        fav = [e["id"] for e in machines if e["id"] in liked_ids] or [e["id"] for e in machines]
        lines.append("Кардио-упражнения в каталоге для кардио-блока: " + ", ".join(fav[:6]) + ".")
    info = {"weekly_minutes": weekly, "likes": likes, "machines": [e["id"] for e in machines]}
    return "\n".join(lines), info


async def job_program(uid: str, inp: dict) -> dict:
    prof, goal = userdata.profile(uid), userdata.goal(uid)
    today = date.today()
    if inp.get("rebuild"):
        # пересборка: параметры активной программы, недели — сколько осталось
        act = next((p["data"] for p in db.list_kind(uid, "program") if p["data"].get("active")), None)
        if not act:
            raise AIError("Нет активной программы для пересборки")
        end = date.fromisoformat(act.get("end") or (today + timedelta(weeks=6)).isoformat())
        inp = {"place": act.get("place"), "weekdays": act.get("weekdays"), "minutes": act.get("minutes"),
               "level": act.get("level"), "weeks": max(1, math.ceil((end - today).days / 7)),
               "notes": act.get("notes") or "", "start": today.isoformat(),
               "reason": inp.get("reason") or "", "rebuild": True}
    place = inp.get("place") or "home"
    weekdays = sorted({int(d) for d in inp.get("weekdays") or prof.get("weekdays") or [0, 2, 4]})
    cap = prof.get("max_sessions_week")
    if cap and len(weekdays) > int(cap):
        weekdays = weekdays[:int(cap)]
    weeks = max(1 if inp.get("rebuild") else 2, min(8, int(inp.get("weeks") or 6)))
    budget = int(prof.get("time_budget_min") or 0)
    minutes = int(inp.get("minutes") or budget or 60)
    if budget:
        minutes = min(minutes, budget)
    # минуты по дням: рабочий график может оставлять меньше времени (slot «none» — лишь пометка для ИИ)
    sched = (prof.get("schedule") or {}).get("days") or {}
    day_minutes = {wd: minutes for wd in weekdays}
    level = int(inp.get("level") or 1)
    equipment = prof.get("equipment") or ["mat", "dumbbells", "chair", "ab_wheel"]
    excluded = excluded_codes(uid, prof)
    # «не предлагать» и чего нет в зале — из профиля (SPEC-v3 п. 17–18)
    ex_prefs = prof.get("exercise_prefs") or {}
    # «не предлагать» с учётом места: «нигде», «в зале»/«дома» - для программы этого места; «только в разминке» - не касается
    skip_ids = {k for k, v in (ex_prefs.get("exclude") or {}).items()
                if (v or {}).get("scope", "all") in ("all", "gym" if place == "gym" else "home")}
    liked_ex = [i for i in ex_prefs.get("like") or [] if i not in skip_ids]
    gym_missing = set(((prof.get("gym_equipment") or {}).get("missing")) or [])
    catalog = allowed_exercises(place, equipment, excluded, missing=gym_missing if place == "gym" else None, skip_ids=skip_ids)
    if not db.exercises():
        raise AIError("Каталог упражнений пуст — нет app/seed/exercises.json")
    if len(catalog) < 8:
        raise AIError("После фильтра по ограничениям и инвентарю почти не осталось упражнений — проверьте профиль")
    by_id = {e["id"]: e for e in catalog}

    def cat_line(e):
        extra = []
        if e.get("zones"):
            extra.append("зоны " + ",".join(e["zones"]))
        if e.get("impact"):
            extra.append("удар " + e["impact"])
        if e.get("tags"):
            extra.append(",".join(e["tags"][:4]))
        return (f"{e['id']} | {e['name']} | {e['category']} | {e['region']} | {e['pattern']} | ур.{e['level']} | "
                f"{'сек' if e['unit'] == 'seconds' else 'повт'}{' | на сторону' if e.get('per_side') else ''}"
                f"{' | ' + '; '.join(extra) if extra else ''}")
    lines = "\n".join(cat_line(e) for e in catalog)
    n_days = len(weekdays)
    acts_text, considered = _activities_text(prof)
    act_days = _activity_days(prof)
    # что будет на следующий день после каждой тренировки — чтобы не убить ноги перед сноубордом
    day_notes = []
    for i, wd in enumerate(weekdays):
        nxt = act_days.get((wd + 1) % 7, [])
        same = act_days.get(wd, [])
        s = f"День {i + 1} ({WEEKDAYS[wd]}), до {day_minutes[wd]} мин"
        slot = (sched.get(str(wd)) or sched.get(wd) or {}).get("slot") if isinstance(sched, dict) else None
        if slot:
            s += f", время: {SLOT_LABEL.get(slot, slot)}"
        if same:
            s += "; в этот же день: " + ", ".join(userdata.activity_name(a.get("type")) for a in same)
        if nxt:
            s += "; НА СЛЕДУЮЩИЙ день: " + ", ".join(userdata.activity_name(a.get("type")) for a in nxt)
        day_notes.append(s)
    smooth = (prof.get("start_mode") or "smooth") == "smooth"
    n_ex_lo = max(3, min(7, round((minutes - 12) / 9)))
    n_ex_hi = n_ex_lo + 1
    target = (userdata.latest_target(uid) or {}).get("data") or {}
    intensity = target.get("intensity") or {}
    # цели-показатели v3 → акценты объёма по зонам (те же правила, что в norms и goals.js на клиенте)
    m_eff = norms.metric_effects(norms.goals_of(goal))
    focus_zones = {z: k for z, k in m_eff["zones"].items() if k >= 1.2}
    emphasis_text = ""
    if m_eff["zones"] or m_eff["patterns"]:
        emphasis_text = ("\nАкценты от целей-показателей (множитель объёма, 1 — обычный): "
                         + ", ".join(f"{ZONE_LABEL.get(z, z)} ×{k:g}" for z, k in sorted(m_eff["zones"].items(), key=lambda kv: -kv[1]))
                         + ("; паттерны: " + ", ".join(f"{p} ×{k:g}" for p, k in m_eff["patterns"].items()) if m_eff["patterns"] else "")
                         + ". Зонам с множителем от 1,2 дай больше упражнений и подходов за неделю, чем остальным.")

    cardio_text, cardio_info = _cardio_text(prof, goal, target, place, catalog)
    liked_names = [by_id[i]["name"] for i in liked_ex if i in by_id]
    prefs_text = ""
    if liked_names:
        prefs_text += "\nЛюбимые упражнения клиента (ставь их чаще, если подходят дню): " + ", ".join(liked_names[:12]) + "."
    if skip_ids:
        prefs_text += f"\nКлиент попросил не предлагать {len(skip_ids)} упражн. — их уже нет в каталоге, не придумывай замену вне каталога."
    if place == "gym" and gym_missing:
        prefs_text += "\nВ зале клиента НЕТ: " + ", ".join(EQUIP_LABEL.get(x, x) for x in sorted(gym_missing)) + " (упражнения с этим уже убраны)."
    system = system_for(uid, "Ты опытный тренер по силовой и функциональной подготовке. Составляешь безопасную, "
                             "реалистичную программу тренировок. Используй ТОЛЬКО id из каталога — дословно, "
                             "других упражнений не бывает. Каталог уже очищен от упражнений, противопоказанных клиенту.")
    user = f"""Клиент: {person_text(uid, prof)}, уровень подготовки: {LEVEL_LABEL.get(level, 'новичок')}.
Цели (по приоритету): {goals_text(goal, uid)}.{emphasis_text}
Темп: {dict(slower='медленнее', normal='обычный', faster='быстрее').get(prof.get('pace') or 'normal')}; интенсивность по нормам: {intensity.get('label', '—')}, кардио {intensity.get('cardio_minutes', '—')} мин/нед (активности засчитываются).
Пожелания к программе: {inp.get('notes') or '—'}.{prefs_text}
Кардио:
{cardio_text}{chr(10) + 'Причина пересборки: ' + inp['reason'] if inp.get('reason') else ''}
Место: {'тренажёрный зал' if place == 'gym' else 'дома, инвентарь: ' + ', '.join(EQUIP_LABEL.get(x, x) for x in equipment)}.
Тренировок в неделю: {n_days}, программа на {weeks} нед., дни повторяются каждую неделю.
{chr(10).join(day_notes)}
Другие активности клиента (их не планируй — он делает их сам, но учитывай нагрузку и восстановление; строки «дополнить» — что программа должна подтянуть в поддержку этого спорта):
{acts_text or '— нет'}

Каталог (id | название | категория | зона | паттерн | уровень | единица | доп.):
{lines}

Требования:
- days — ровно {n_days} разных тренировочных дней, в том же порядке, что «День 1…»; вместе покрывают всё тело
  с упором на главные цели и зоны клиента;
- если на следующий день активность, нагружающая ноги (сноуборд, велосипед, бег, лыжи, танцы) — в этот день
  НЕ ставь тяжёлые ноги, лучше верх/кор; если в тот же день активность — день короче и легче;
- кардио-активности клиента засчитываются в недельное кардио; если их мало для недельной нормы кардио —
  добавь в конце 1–2 дней кардио-блок 10–20 мин из кардио-упражнений каталога (лучше любимое клиента):
  sets 1, reps «15-20 мин», rest_sec 0; не ставь интенсивное кардио в день тяжёлых ног;
- warmup — 3–5 упражнений категорий warmup/mobility; cooldown — 2–3 упражнения mobility;
- exercises — {n_ex_lo}–{n_ex_hi} основных упражнений в день, 3–4 подхода, чтобы занять указанные минуты; сначала
  базовые многосуставные, потом изолирующие, в конце кор;
- за неделю — минимум 3 силовых упражнения на ноги и ягодицы (region lower): велосипед и сноуборд не заменяют силовую
  работу ног, просто не ставь ноги накануне этих активностей;
- подходы пиши для полной нагрузки: плавный вход в первые недели приложение сделает само;
- уровень упражнений не выше уровня клиента + 1;
- reps — строка: «8-12» для повторений или «30-45 с» для упражнений на время;
- rest_sec — отдых между подходами; note — 1 короткий совет именно этому клиенту (с учётом ограничений и особенностей);
- progression — как прибавлять нагрузку от недели к неделе, 2–4 предложения{'; упомяни, что первые 2 недели на подход меньше (плавный вход)' if smooth else ''};
- summary — 2–4 предложения: логика программы, как учтены активности и ограничения."""
    feedback = ""
    for attempt in range(2):
        out = await ask_json(system, user + feedback, PROGRAM_SCHEMA, temperature=0.4)
        days = _program_days(out, by_id, weekdays, day_minutes)
        problems = []
        if len(days) < n_days:
            problems.append(f"нужно ровно {n_days} дней, а годных получилось {len(days)}")
        lower = sum(1 for d in days for x in d["exercises"]
                    if by_id[x["id"]].get("region") == "lower" and by_id[x["id"]].get("category") == "strength")
        if lower < 2 and any(e.get("region") == "lower" and e.get("category") == "strength" for e in catalog):
            problems.append("почти нет упражнений на ноги и ягодицы")
        short = [d["name"] for d in days if len(d["exercises"]) < n_ex_lo - 1]
        if short:
            problems.append("слишком мало упражнений в днях: " + ", ".join(short))
        # акцентные зоны: за неделю хотя бы 2 упражнения (и 3 при ×1,4 и выше), если в каталоге такие есть
        for z, k in focus_zones.items():
            need = 3 if k >= 1.4 else 2
            have = sum(1 for d in days for x in d["exercises"] if z in (by_id[x["id"]].get("zones") or []))
            if have < need and sum(1 for e in catalog if z in (e.get("zones") or [])) >= need:
                problems.append(f"мало упражнений на зону «{ZONE_LABEL.get(z, z)}» (цель клиента): {have} за неделю, нужно от {need}")
        if not problems or attempt == 1:
            break
        feedback = "\n\nПРОШЛЫЙ ВАРИАНТ ОТКЛОНЁН: " + "; ".join(problems) + ". Исправь."
    if not days:
        raise AIError("Модель не составила ни одного дня из упражнений каталога. Попробуйте ещё раз.")

    start = date.fromisoformat(inp.get("start") or today.isoformat())
    program_id = uuid.uuid4().hex
    program = {"title": out.get("title") or "Программа", "summary": out.get("summary", ""),
               "progression": out.get("progression", ""), "place": place, "weekdays": weekdays,
               "weeks": weeks, "minutes": minutes, "level": level, "notes": inp.get("notes") or "",
               "start": start.isoformat(), "end": (start + timedelta(weeks=weeks)).isoformat(), "days": days,
               "active": True, "start_mode": "smooth" if smooth else "hard",
               "activities_considered": considered, "excluded": sorted(excluded),
               "rebuilt": bool(inp.get("rebuild")), "reason": inp.get("reason") or "",
               "goal_emphasis": m_eff["zones"], "cardio": cardio_info,
               "skipped_exercises": sorted(skip_ids), "gym_missing": sorted(gym_missing)}

    # старые программы и их будущие тренировки без отметок снимаем; с отметками — не трогаем
    keep_dates = set()
    for p in db.list_kind(uid, "program"):
        if p["data"].get("active"):
            db.server_put(uid, "program", p["id"], {**p["data"], "active": False})
    with db.tx() as c:
        for w in db.list_kind(uid, "workout", date_from=max(today.isoformat(), start.isoformat())):
            if any(ex.get("log") for ex in w["data"].get("exercises", [])) or w["data"].get("done"):
                keep_dates.add(w["date"])
            else:
                db.put(c, {**w, "deleted": True, "updated_at": db.now_ms()}, force=True)
    db.server_put(uid, "program", program_id, program)

    monday = start - timedelta(days=start.weekday())
    # отсчёт плавного старта — от profile.start_date (при пересборке тоже), иначе от начала программы
    try:
        ramp_from = date.fromisoformat(prof.get("start_date") or "")
    except ValueError:
        ramp_from = start
    if ramp_from > start + timedelta(days=6):
        ramp_from = start
    i = 0
    for week in range(weeks + 1):
        for wd in weekdays:
            day = monday + timedelta(weeks=week, days=wd)
            if day < start or day >= start + timedelta(weeks=weeks) or day.isoformat() in keep_dates:
                continue
            # шаблон привязан к дню недели: «День 1» модель составляла под первый выбранный день
            # (его минуты, активности накануне и после), поэтому и в календаре он всегда в этот день
            tpl = days[weekdays.index(wd) % len(days)]
            i += 1
            wk = (day - monday).days // 7 + 1
            # плавный старт: первые 2 недели от начала занятий на подход меньше (исходное число — в sets_base)
            rw = (day - ramp_from).days // 7 + 1
            delta = -1 if smooth and rw <= 2 else 0
            exercises = [{**x, "sets": max(1, x["sets"] + delta), "sets_base": x["sets"], "log": []} for x in tpl["exercises"]]
            db.server_put(uid, "workout", f"wo:{uid}:{day.isoformat()}", {
                "program_id": program_id, "week": wk, "weeks": weeks,
                "title": tpl["name"], "focus": tpl["focus"], "warmup": tpl["warmup"], "cooldown": tpl["cooldown"],
                "exercises": exercises, "done": False, "variant": "full", "source": "program",
                "planned_minutes": tpl["minutes"],
                "ramp": {"week": rw, "sets_delta": delta, "factor": (0.6, 0.8, 1.0)[min(max(rw, 1), 3) - 1] if smooth else 1.0},
            }, day.isoformat())
    return {"program_id": program_id, "workouts": i, "kept": sorted(keep_dates)}


# ── разбор недели ──

WEEKLY_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "text": {"type": "string"},
                   "next": {"type": "array", "items": {"type": "string"}},
                   "day_tip": {"type": "string"}},
    "required": ["title", "text", "next", "day_tip"],
}
MEASURES = ("neck", "chest", "waist", "belly", "hips", "arm_l", "arm_r", "thigh_l", "thigh_r", "calf_l", "calf_r")
GRADE_EMOJI = {"A": "🏆", "B": "💪", "C": "🙂", "D": "😐", "E": "🥶"}


def _items_by_source(uid: str) -> dict[str, str]:
    return {r["data"].get("target_from"): r["id"] for r in db.list_kind(uid, "item") if r["data"].get("target_from")}


def week_stats(uid: str, end: date) -> dict:
    start = end - timedelta(days=6)
    a, b = start.isoformat(), end.isoformat()
    dsum = {r["date"]: r["data"] for r in db.list_kind(uid, "dsum", a, b)}
    workouts = db.list_kind(uid, "workout", a, b)
    bodies = [r for r in db.list_kind(uid, "body", None, b) if r["data"].get("weight")]
    target = (userdata.latest_target(uid) or {}).get("data", {})
    sleeps = {r["date"]: r["data"] for r in db.list_kind(uid, "sleep", a, b)}
    states = {r["date"]: r["data"] for r in db.list_kind(uid, "state", a, b)}
    dtypes = {r["date"]: r["data"].get("type") for r in db.list_kind(uid, "daytype", a, b)}
    acts = db.list_kind(uid, "activity", a, b)
    items = _items_by_source(uid)
    logs = {(r["date"], r["id"].rsplit(":", 1)[-1]): r["data"].get("v") for r in db.list_kind(uid, "log", a, b)}
    # чашки кофе и чая (записи drink со временем): сколько за день и сколько после 14:00
    cups: dict[str, dict] = {}
    for r in db.list_kind(uid, "drink", a, b):
        c = cups.setdefault(r["date"], {"coffee": 0, "tea": 0, "after_14": 0, "last": None})
        k = r["data"].get("kind")
        if k in ("coffee", "tea"):
            c[k] += 1
        t = r["data"].get("time") or ""
        if t >= "14:00":
            c["after_14"] += 1
        if t and (not c["last"] or t > c["last"]):
            c["last"] = t
    # добавки: приёмы по дням и регулярность против плана из профиля
    supp_days: dict[str, list] = {}
    supp_n: dict[str, int] = {}
    for r in db.list_kind(uid, "supp", a, b):
        k = r["data"].get("key") or r["data"].get("sid") or "?"
        dose = f"{r['data']['dose']:g} {r['data'].get('dose_unit') or ''}" if isinstance(r["data"].get("dose"), (int, float)) else ""
        supp_days.setdefault(r["date"], []).append(" ".join(x for x in (r["data"].get("name") or k, dose, r["data"].get("time") or "") if x))
        supp_n[k] = supp_n.get(k, 0) + 1

    days = []
    for i in range(7):
        d = (start + timedelta(days=i)).isoformat()
        fs = nutrition.day_food_score(uid, d, target)
        sl = sleeps.get(d)
        days.append({
            "date": d, "weekday": WEEKDAYS[(start.weekday() + i) % 7],
            "pct": (dsum.get(d) or {}).get("pct", 0),
            "grade": (dsum.get(d) or {}).get("grade"),
            "day_type": DAYTYPE_LABEL.get(dtypes.get(d), dtypes.get(d)),
            "food": {**fs["totals"], "score": fs["score"], "flags": fs["flags"]} if fs else None,
            "sleep_h": sleep_hours_of(sl) if sl else None,
            "snooze_min": snooze_min(sl) if sl else None,
            "alarms": sl.get("alarms") if sl else None,
            "state": ", ".join(filter(None, (WELLBEING_LABEL.get((states.get(d) or {}).get("wellbeing")),
                                             SORENESS_LABEL.get((states.get(d) or {}).get("soreness")),
                                             STRESS_LABEL.get((states.get(d) or {}).get("stress")),
                                             SLEEPY_LABEL.get((states.get(d) or {}).get("sleepy"))))) or None,
            "water": logs.get((d, items.get("water"))),
            "steps": logs.get((d, items.get("steps"))),
            "cups": cups.get(d),
            "supplements": supp_days.get(d),
        })
    sl_hours = [x["sleep_h"] for x in days if x["sleep_h"]]
    sl_scores = [s.get("score") for s in sleeps.values() if s.get("score") is not None]
    act_min: dict[str, int] = {}
    massages = []
    for r in acts:
        t = r["data"].get("type") or "other"
        act_min[userdata.activity_name(t)] = act_min.get(userdata.activity_name(t), 0) + int(r["data"].get("minutes") or 0)
        if t == "massage":
            massages.append({k: (r["data"].get("details") or {}).get(k) for k in ("kind", "zones", "after")})
    state_dist: dict[str, int] = {}
    for s in states.values():
        if s.get("wellbeing"):
            w = WELLBEING_LABEL.get(s["wellbeing"], s["wellbeing"])
            state_dist[w] = state_dist.get(w, 0) + 1
    food_days = [x["food"] for x in days if x["food"]]
    measures = [r for r in db.list_kind(uid, "body", (end - timedelta(days=60)).isoformat(), b)
                if any(r["data"].get(k) for k in MEASURES)]
    mdelta = {}
    if len(measures) >= 2:
        f0, f1 = measures[0]["data"], measures[-1]["data"]
        mdelta = {k: round(f1[k] - f0[k], 1) for k in MEASURES if f0.get(k) and f1.get(k)}
        mdelta["period"] = f"{measures[0]['date']} — {measures[-1]['date']}"
    steps = [x["steps"] for x in days if isinstance(x["steps"], (int, float))]
    water = [x["water"] for x in days if isinstance(x["water"], (int, float))]
    st = {
        "period": f"{a} — {b}", "days": days,
        "avg_pct": round(sum(x["pct"] or 0 for x in days) / 7),
        "workouts_planned": len(workouts), "workouts_done": sum(1 for w in workouts if w["data"].get("done")),
        "workouts_light": sum(1 for w in workouts if w["data"].get("variant") in ("light", "recovery")),
        "target": {k: target.get(k) for k in ("kcal", "p", "f", "c", "water_glasses", "steps", "sleep_hours")},
        "food_days_logged": len(food_days),
        "food_avg": {k: round(sum(f[k] for f in food_days) / len(food_days)) for k in ("kcal", "p", "f", "c")} if food_days else None,
        "food_avg_score": round(sum(f["score"] for f in food_days) / len(food_days)) if food_days else None,
        "sleep": {"nights": len(sl_hours), "avg_hours": round(sum(sl_hours) / len(sl_hours), 1) if sl_hours else None,
                  "short_nights": sum(1 for h in sl_hours if h < 7),
                  "avg_score": round(sum(sl_scores) / len(sl_scores)) if sl_scores else None},
        "state": state_dist,
        "activities_min": act_min, "massages": massages,
        "steps_avg": round(sum(steps) / len(steps)) if steps else None,
        "water_avg": round(sum(water) / len(water), 1) if water else None,
        "coffee_avg": round(sum(c["coffee"] for c in cups.values()) / len(cups), 1) if cups else None,
        "cups_after_14_days": sum(1 for c in cups.values() if c["after_14"]) if cups else None,
        "supplements_plan": [{"name": s.get("name") or s.get("sid"), "per_day": len(s.get("times") or []) or 1,
                              "taken_week": supp_n.get(s.get("key") or s.get("sid"), 0)}
                             for s in userdata.profile(uid).get("supplements") or [] if s.get("active") is not False] or None,
        "day_types": {DAYTYPE_LABEL.get(t, t): sum(1 for v in dtypes.values() if v == t) for t in set(dtypes.values()) if t},
        "habits": [HABIT_LABEL.get(h, h) for h in userdata.goal(uid).get("habits") or []],
        "measures_delta": mdelta,
        "weight_start": next((r["data"]["weight"] for r in reversed(bodies) if r["date"] <= a), None),
        "weight_end": bodies[-1]["data"]["weight"] if bodies else None,
    }
    st["grade"] = _week_grade(st)
    return st


def _week_grade(st: dict) -> str:
    """Оценка недели кодом (честная, не зависит от модели): чек-лист, тренировки, еда, сон."""
    parts = [st["avg_pct"] / 100]
    if st["workouts_planned"]:
        parts.append(st["workouts_done"] / st["workouts_planned"])
    if st["food_avg_score"] is not None:
        parts.append(st["food_avg_score"] / 100 * min(1, st["food_days_logged"] / 5))
    if st["sleep"]["avg_hours"]:
        parts.append(min(1, st["sleep"]["avg_hours"] / (st["target"].get("sleep_hours") or 7.5)))
    s = sum(parts) / len(parts)
    return "A" if s >= 0.85 else "B" if s >= 0.7 else "C" if s >= 0.55 else "D" if s >= 0.35 else "E"


async def job_weekly(uid: str, inp: dict) -> dict:
    if inp.get("end"):
        end = date.fromisoformat(inp["end"])
    elif inp.get("monday"):
        end = min(date.today(), date.fromisoformat(inp["monday"]) + timedelta(days=6))
    else:
        end = date.today()
    monday = inp.get("monday") or (end - timedelta(days=end.weekday())).isoformat()
    st = week_stats(uid, end)
    goal = userdata.goal(uid)
    system = system_for(uid, "Ты персональный тренер. Разбираешь неделю клиента по фактическим цифрам: хвалишь "
                             "за конкретные успехи, ругаешь за конкретные провалы. Дни с типом cheat/special/sick/rest "
                             "не ругай. Не знаешь — не выдумывай: null значит «не записано».")
    user = (f"Цели: {goals_text(goal)}.\nОценка недели (посчитана кодом): {st['grade']}.\n"
            f"Статистика недели (pct — % чек-листа; food — съедено и оценка 0–100; sleep_h — часы сна (дрёма после будильника засчитана наполовину), snooze_min — минуты дрёмы между первым будильником и подъёмом, alarms — сколько было будильников; state — самочувствие; "
            f"water — стаканы; cups — чашки кофе/чая, after_14 — из них после 14:00, last — время последней; supplements — принятые добавки со временем, supplements_plan — план и сколько приёмов за неделю; steps — шаги; activities_min — минуты по видам; measures_delta — изменение замеров, см):\n"
            f"{json.dumps(st, ensure_ascii=False)}\n\n"
            "title — заголовок в 3–6 слов; text — разбор 5–8 предложений: питание (БЖУ к норме), сон, активность, "
            "самочувствие, вода и шаги — только то, по чему есть данные; next — 3 конкретные задачи на следующую неделю; "
            "day_tip — одна короткая рекомендация на завтра.")
    out = await ask_json(system, user, WEEKLY_SCHEMA, temperature=0.6, think=True)
    rec_id = uuid.uuid4().hex
    db.server_put(uid, "coach", rec_id, {"kind": "weekly", "title": out.get("title", "Разбор недели"),
                                         "text": out.get("text", ""), "next": out.get("next", []),
                                         "day_tip": out.get("day_tip", ""), "grade": st["grade"],
                                         "emoji_grade": GRADE_EMOJI[st["grade"]], "stats": st, "monday": monday,
                                         "created": db.now_ms()}, end.isoformat())
    return {"record_id": rec_id}


# ── рацион ──

MEALPLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "days": {"type": "array", "minItems": 1, "items": {"type": "object", "properties": {
            "meals": {"type": "array", "minItems": 3, "maxItems": 5, "items": {"type": "object", "properties": {
                "meal": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
                "title": {"type": "string"},
                "items": {"type": "array", "items": {"type": "object", "properties": {
                    "name": {"type": "string"}, "grams": {"type": "number"}},
                    "required": ["name", "grams"]}},
            }, "required": ["meal", "title", "items"]}},
        }, "required": ["meals"]}},
        "note": {"type": "string"},
    },
    "required": ["days", "note"],
}
# простые продукты для рациона: модель выбирает из короткого списка — так быстрее и без экзотики
CLASSIC_FOODS = sorted({n for tpls in nutrition.TEMPLATES.values() for t in tpls for _, names, *_ in t["slots"] for n in names} | {
    "Овсянка на молоке", "Макароны варёные", "Картофель запечённый", "Картофельное пюре", "Фасоль варёная",
    "Говяжий фарш", "Куриное бедро варёное", "Тунец консервированный", "Сыр лёгкий 17%", "Сыр Российский",
    "Сметана 10%", "Молоко 1,5%", "Кефир 1%", "Йогурт натуральный 2,5%", "Хлеб ржаной", "Лаваш тонкий",
    "Капуста цветная", "Свёкла варёная", "Кабачок", "Шпинат", "Горошек зелёный консервированный", "Апельсин",
    "Мандарин", "Груша", "Киви", "Мёд", "Масло сливочное 82,5%", "Сельдь солёная", "Скумбрия", "Омлет"})


def _food_rows(items: list[dict], idx: food.Index) -> list[dict]:
    """Позиции ИИ → позиции с БЖУ: из справочника, где имя совпало; иначе оценка ИИ (на 100 г)."""
    out = []
    for it in items:
        g = max(0.0, float(it.get("grams") or 0))
        if not g or not it.get("name"):
            continue
        # «Кабачок сырой» → «Кабачок»: в справочнике у сырых овощей и фарша состояние часто не пишут
        known = idx.match(it["name"]) or idx.match(re.sub(r"\s+(сыр(ой|ая|ое|ые)|свеж(ий|ая|ее|ие))\b", "", it["name"], flags=re.I))
        if known:
            row = food.item_from(known, g, it["name"], "db")
        else:
            per100 = {k: max(0.0, float(it.get(k) or 0)) for k in ("kcal", "p", "f", "c")}
            row = food.item_from({"name": it["name"], **per100}, g, it["name"], "ai")
        row.pop("text", None)
        out.append(row)
    return out


def _meal_rows(items: list[dict], idx: food.Index) -> list[list]:
    """Позиции приёма → строки для подгонки: [продукт, граммы, мин, макс, роль p/c/x]."""
    rows = []
    for it in items:
        f = idx.match(it.get("name") or "")
        g = float(it.get("grams") or 0)
        if f and g > 0:
            dens = f["p"] * 4 / f["kcal"] if f["kcal"] else 0
            # гарниром (им подгоняются калории) считаем только крупы, макароны, хлеб и картофель — не фрукты и мёд
            starch = f.get("group") in ("крупы", "макароны", "хлеб и выпечка", "бобовые") or f["name"].startswith(("Картоф", "Батат"))
            role = "p" if dens >= 0.3 else "c" if starch else "x"
            rows.append([f, g, g * 0.5, max(g, 150 if role != "x" else g), role])
    return rows


# рацион на один день по слотам клиента (mealplan.js): ИИ подбирает блюда и рецепты,
# код оставляет только продукты из справочника, здоровые и по диете, и доводит граммы под цели слотов
MEALDAY_SCHEMA = {
    "type": "object",
    "properties": {
        "slots": {"type": "array", "items": {"type": "object", "properties": {
            "key": {"type": "string"}, "title": {"type": "string"},
            "items": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "grams": {"type": "number"}}, "required": ["name", "grams"]}},
            "steps": {"type": "array", "items": {"type": "string"}}, "time_min": {"type": "integer"},
        }, "required": ["key", "title", "items", "steps", "time_min"]}},
        "note": {"type": "string"},
    },
    "required": ["slots", "note"],
}


def _num_or(v, default: float = 0.0, hi: float = 5000.0) -> float:
    try:
        return max(0.0, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


async def job_mealplan_day(uid: str, inp: dict) -> dict:
    prof, goal = userdata.profile(uid), userdata.goal(uid)
    t = (userdata.latest_target(uid) or {}).get("data") or {}
    day = str(inp.get("date") or date.today().isoformat())[:10]
    diet = prof.get("diet") or "normal"
    allergy = nutrition._allergy_words(prof.get("allergies") or "")
    exclude = {food.norm(str(x)) for x in (inp.get("exclude") or [])[:100]}
    idx = food.Index(uid)
    slots_in = [s for s in (inp.get("slots") or [])[:8] if isinstance(s, dict) and s.get("key")]
    if not slots_in:
        raise AIError("Нет приёмов пищи для рациона")
    # список продуктов для модели: дома → что человек ест → текущий план → простые продукты; всё уже отфильтровано
    names, seen = [], set()
    pantry = [str(x) for x in (inp.get("pantry") or [])[:60]]
    pool = [*pantry, *[str(x) for x in (inp.get("usual_foods") or [])[:40]],
            *[i.get("name", "") for s in slots_in for i in (s.get("items") or [])], *CLASSIC_FOODS]
    for nm in pool:
        f = idx.match(nm) if nm else None
        if f and f["id"] not in seen and not nutrition.unhealthy(f) and nutrition.allowed(f, diet, allergy) and food.norm(f["name"]) not in exclude:
            seen.add(f["id"])
            names.append(f["name"])
    home = [n for n in names if any(food.norm(n) == food.norm(p) or (idx.match(p) or {}).get("name") == n for p in pantry)]
    w = inp.get("workout") or {}
    acts = ", ".join(f"{a.get('name')} {a.get('minutes')} мин" for a in (inp.get("activities") or [])[:5] if isinstance(a, dict)) or "нет"
    slot_txt = "\n".join(
        f"- key={s['key']}: {s.get('time', '')} {s.get('label', '')} — цель {round(_num_or((s.get('target') or {}).get('kcal')))} ккал, "
        f"белок {round(_num_or((s.get('target') or {}).get('p')))} г, жиры {round(_num_or((s.get('target') or {}).get('f')))} г, "
        f"углеводы {round(_num_or((s.get('target') or {}).get('c')))} г. Смысл: {s.get('reason', '')}" for s in slots_in)
    system = system_for(uid, "Ты спортивный нутрициолог. Составляешь рацион на один день из обычных продуктов с простыми домашними "
                             "рецептами: здоровое питание, не только калории.")
    user = f"""Клиент: {person_text(uid, prof)}. Цели: {goals_text(goal, uid)}.
Норма на день: {t.get('kcal', '—')} ккал, белок {t.get('p', '—')} г. Тренировка сегодня: {f"{w.get('title')} в {w.get('time')}, {w.get('minutes')} мин" if w else 'нет'}. Активности: {acts}.

Приёмы пищи (время и цели уже рассчитаны — не меняй их, верни ровно эти key):
{slot_txt}

Правила: в каждом приёме 2–4 продукта; до тренировки — быстрые углеводы и немного белка, мало жира; после — белок и углеводы;
на обед и ужин — белок, гарнир и овощи. Без сладкого, фастфуда, колбас, жареного. Спортпит — только если он есть в списке.
{('Дома есть: ' + '; '.join(home) + '. Строй приёмы в первую очередь из этого.') if home else ''}
name — СТРОГО дословно из списка ниже; grams — в том виде, как в названии (сухая крупа — сухой вес).
title — короткое название блюда; steps — 2–4 коротких шага приготовления (для перекусов можно 1); time_min — минуты на готовку.
note — одно-два предложения: чем этот день хорош под цель. Без рассуждений.

Продукты: {'; '.join(names[:140])}"""
    out = await ask_json(system, user, MEALDAY_SCHEMA, temperature=0.5)
    by_key = {str(s.get("key")): s for s in (out.get("slots") or []) if isinstance(s, dict)}
    slots_out, dropped_all = [], []
    for s in slots_in:
        ai = by_key.get(str(s["key"])) or {}
        rows, dropped = nutrition.check_slot_items(ai.get("items") or [], idx, diet, allergy, exclude)
        dropped_all += dropped
        from_ai = bool(rows)
        if not rows:                          # модель потеряла приём или всё выбросили — берём проверенный локальный вариант
            rows, _ = nutrition.check_slot_items(s.get("items") or [], idx, diet, allergy, exclude)
        tgt = {k: _num_or((s.get("target") or {}).get(k)) for k in ("kcal", "p", "f", "c")}
        nutrition.fit_slot(rows, tgt)
        items = nutrition.slot_items(rows)
        steps = [str(x)[:200] for x in (ai.get("steps") or [])[:5]] if from_ai else []
        slots_out.append({
            "key": str(s["key"])[:20], "kind": s.get("kind") or "snack", "time": str(s.get("time") or "")[:5],
            "label": str(s.get("label") or "")[:60], "reason": str(s.get("reason") or "")[:200],
            "meal": s.get("meal") if s.get("meal") in ("breakfast", "lunch", "dinner", "snack") else "snack",
            "title": (str(ai.get("title") or "")[:80] if from_ai else ""), "items": items, "totals": food.totals(items),
            "recipe": {"steps": steps, "time_min": int(_num_or(ai.get("time_min"), 0, 240))} if steps else None,
            "source": "ai" if from_ai else "local"})
    if not any(s["items"] for s in slots_out):
        raise AIError("Модель не составила рацион. Попробуйте ещё раз.")
    tot = food.totals([i for s in slots_out for i in s["items"]])
    eaten = inp.get("eaten") or {}
    day_tot = {k: round(tot[k] + _num_or(eaten.get(k)), 1) for k in tot}
    diff = {k: round((day_tot[k] - t[k]) / t[k] * 100) if t.get(k) else None for k in ("kcal", "p", "f", "c")}
    note = (out.get("note") or "").strip()
    rec_id = uuid.uuid4().hex
    db.server_put(uid, "coach", rec_id, {
        "kind": "mealplan", "variant": "day", "date": day, "title": f"Рацион на {day}", "text": note if len(note) <= 400 else "",
        "slots": slots_out, "totals": tot, "day_totals": day_tot, "diff_pct": diff, "eaten": eaten or None,
        "target": {k: t.get(k) for k in ("kcal", "p", "f", "c", "fiber")}, "dropped": dropped_all[:20],
        "workout": w or None, "notes": [f"Убрано из ответа ИИ: {', '.join(dropped_all[:5])}."] if dropped_all else [],
        "diet": diet, "created": db.now_ms()}, day)
    return {"record_id": rec_id}


async def job_mealplan(uid: str, inp: dict) -> dict:
    if inp.get("slots"):                    # рацион на день по слотам (mealplan.js)
        return await job_mealplan_day(uid, inp)
    n = max(1, min(7, int(inp.get("days") or 1)))
    prof, goal = userdata.profile(uid), userdata.goal(uid)
    t = (userdata.latest_target(uid) or {}).get("data")
    if not t:
        raise AIError("Сначала посчитайте нормы в профиле")
    diet = prof.get("diet") or "normal"
    allergy = nutrition._allergy_words(prof.get("allergies") or "")
    idx = food.Index()
    names = [nm for nm in CLASSIC_FOODS if (f := idx.match(nm)) and f["name"] == nm and nutrition.allowed(f, diet, allergy)]
    win = prof.get("eating_window") or {}
    window = f"с {win.get('from')} до {win.get('to')}" if win.get("enabled") else "не задано"
    system = system_for(uid, "Ты нутрициолог. Составляешь простой домашний рацион из обычных продуктов. "
                             "Граммы — готового продукта.")
    user = f"""Клиент: {person_text(uid, prof)}. Цели: {goals_text(goal)}.
Норма на день: {t.get('kcal')} ккал, белок {t.get('p')} г, жиры {t.get('f')} г, углеводы {t.get('c')} г.
Окно питания: {window}. Пожелания: {inp.get('notes') or '—'}.

Составь рацион на {n} дн., дни не повторяются. На день: {'обед, перекус и ужин (интервальное голодание)' if diet in ('if_16_8', 'if_18_6') else 'завтрак, обед, ужин и перекус'}.
В каждом приёме 2–4 продукта; белок в каждом основном приёме. Граммы подбирай под норму — точную подгонку сделает приложение.
name — СТРОГО дословно из списка; title — короткое название блюда («Гречка с курицей и огурцом»).
note — ОДНО короткое предложение: что можно заменять. Без рассуждений.

Продукты: {'; '.join(names)}"""
    out = await ask_json(system, user, MEALPLAN_SCHEMA, temperature=0.5)
    days_out = []
    start = date.fromisoformat(inp.get("start") or date.today().isoformat())
    for i, d in enumerate(out.get("days", [])[:n]):
        plan = []
        day_iso = (start + timedelta(days=i)).isoformat()
        for m in d.get("meals", []):
            rows = _meal_rows(m.get("items") or [], idx)
            if rows and m.get("meal") not in {x[0] for x in plan}:
                plan.append((m.get("meal") or "snack", m.get("title") or "", rows))
        # модель иногда теряет приёмы пищи — недостающие берём из плана-по-шаблонам (nutrition.build_day)
        want = ("lunch", "snack", "dinner") if diet in ("if_16_8", "if_18_6") else ("breakfast", "lunch", "dinner", "snack")
        missing = [w for w in want if w not in {x[0] for x in plan}]
        if missing:
            quick = nutrition.build_day(t, prof, day_iso, uid)
            for qm in quick["meals"]:
                if qm["meal"] in missing:
                    plan.append((qm["meal"], qm["title"], _meal_rows(qm["items"], idx)))
        plan.sort(key=lambda x: want.index(x[0]) if x[0] in want else 9)
        if not plan:
            continue
        # модель плохо считает — подгоняем граммы кодом: белковые продукты под белок, гарниры под калории
        nutrition.fit_day(plan, t, idx, diet, allergy, 2.5)
        meals = []
        for meal, title, rs in plan:
            items = []
            for f, g, *_ in rs:
                it = food.item_from(f, nutrition._round_g(g), f["name"], "db")
                it.pop("text", None)
                items.append(it)
            meals.append({"meal": meal, "label": nutrition.MEAL_LABEL.get(meal, meal), "title": title,
                          "items": items, "totals": food.totals(items)})
        tot = food.totals([x for m in meals for x in m["items"]])
        diff = {key: round((tot[key] - t[key]) / t[key] * 100) if t.get(key) else None for key in ("kcal", "p", "f", "c")}
        days_out.append({"date": day_iso, "meals": meals, "totals": tot, "diff_pct": diff})
    if not days_out:
        raise AIError("Модель не составила рацион. Попробуйте ещё раз.")
    note = (out.get("note") or "").strip()
    if len(note) > 300:                       # модель иногда сливает сюда рассуждения — не показываем
        note = ""
    rec_id = uuid.uuid4().hex
    db.server_put(uid, "coach", rec_id, {"kind": "mealplan", "title": f"Рацион на {n} дн.", "text": note,
                                         "days": days_out, "target": {k: t.get(k) for k in ("kcal", "p", "f", "c")},
                                         "diet": diet, "created": db.now_ms()}, date.today().isoformat())
    return {"record_id": rec_id}


# ── рецепт ──

RECIPE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"}, "time_min": {"type": "integer"}, "portions": {"type": "integer"},
        "ingredients": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "grams": {"type": "number"},
            "kcal": {"type": "number"}, "p": {"type": "number"}, "f": {"type": "number"}, "c": {"type": "number"}},
            "required": ["name", "grams", "kcal", "p", "f", "c"]}},
        "steps": {"type": "array", "items": {"type": "string"}},
        "tip": {"type": "string"},
    },
    "required": ["title", "time_min", "portions", "ingredients", "steps", "tip"],
}


async def job_recipe(uid: str, inp: dict) -> dict:
    t = (userdata.latest_target(uid) or {}).get("data") or {}
    ask = inp.get("title") or inp.get("text") or ""
    ingr = inp.get("ingredients") or ""
    if isinstance(ingr, list):
        ingr = ", ".join(map(str, ingr))
    if not ask and not ingr:
        raise AIError("Нужно название блюда или список продуктов")
    system = system_for(uid, "Ты повар и нутрициолог. Даёшь простые домашние рецепты: понятные шаги, обычная кухня, "
                             "без редких ингредиентов.")
    user = f"""{'Блюдо: ' + ask if ask else ''}{chr(10) + 'Есть продукты: ' + ingr if ingr else ''}
Норма клиента в день: {t.get('kcal', '—')} ккал, белок {t.get('p', '—')} г.
Ингредиенты — в граммах НА ВЕСЬ РЕЦЕПТ, в том виде, в каком кладёшь (сырые крупы, сырое мясо);
kcal, p, f, c — на 100 г ингредиента; name — обычное название с состоянием («Гречка сырая», «Куриная грудка сырая»).
steps — 4–8 коротких шагов; time_min — общее время; portions — порций; tip — один совет, как сделать блюдо полезнее под цель."""
    out = await ask_json(system, user, RECIPE_SCHEMA, temperature=0.5)
    idx = food.Index()
    rows = _food_rows(out.get("ingredients") or [], idx)
    if not rows:
        raise AIError("Модель не дала ингредиентов. Попробуйте ещё раз.")
    portions = max(1, int(out.get("portions") or 1))
    tot = food.totals(rows)
    per = {k: round(v / portions, 1 if k != "kcal" else 0) for k, v in tot.items()}
    rec_id = uuid.uuid4().hex
    db.server_put(uid, "coach", rec_id, {
        "kind": "recipe", "title": out.get("title") or ask or "Рецепт", "time_min": int(out.get("time_min") or 0),
        "portions": portions, "ingredients": [{"name": r["name"], "grams": r["grams"], "source": r["source"]} for r in rows],
        "steps": out.get("steps") or [], "text": out.get("tip", ""), "totals": tot, "per_portion": per,
        "created": db.now_ms()}, date.today().isoformat())
    return {"record_id": rec_id}


# ── анализ истории ──

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "text": {"type": "string"},
                   "worked": {"type": "array", "items": {"type": "string"}},
                   "didnt": {"type": "array", "items": {"type": "string"}},
                   "recommendations": {"type": "array", "items": {"type": "string"}}},
    "required": ["title", "text", "worked", "didnt", "recommendations"],
}


def history_stats(uid: str, months: int = 6) -> dict:
    """Помесячная сводка: вес, замеры, тренировки, активности, сон, самочувствие, питание."""
    since = (date.today() - timedelta(days=31 * months)).isoformat()
    by_m: dict[str, dict] = {}

    def m(d):
        return by_m.setdefault(d[:7], {"weights": [], "workouts_planned": 0, "workouts_done": 0, "activity_min": {},
                                       "sleep": [], "state": {}, "kcal": [], "protein": []})
    for r in db.list_kind(uid, "body", since):
        if r["data"].get("weight"):
            m(r["date"])["weights"].append(r["data"]["weight"])
    for r in db.list_kind(uid, "workout", since, date.today().isoformat()):
        x = m(r["date"])
        x["workouts_planned"] += 1
        x["workouts_done"] += 1 if r["data"].get("done") else 0
    for r in db.list_kind(uid, "activity", since):
        x = m(r["date"])["activity_min"]
        n = userdata.activity_name(r["data"].get("type") or "other")
        x[n] = x.get(n, 0) + int(r["data"].get("minutes") or 0)
    for r in db.list_kind(uid, "sleep", since):
        h = sleep_hours_of(r["data"])
        if h:
            m(r["date"])["sleep"].append(h)
    for r in db.list_kind(uid, "state", since):
        w = WELLBEING_LABEL.get(r["data"].get("wellbeing"), r["data"].get("wellbeing"))
        if w:
            s = m(r["date"])["state"]
            s[w] = s.get(w, 0) + 1
    food_days: dict[str, list] = {}
    for r in db.list_kind(uid, "food", since):
        t = r["data"].get("totals") or {}
        fd = food_days.setdefault(r["date"], [0, 0])
        fd[0] += t.get("kcal") or 0
        fd[1] += t.get("p") or 0
    for d, (k, p) in food_days.items():
        m(d)["kcal"].append(k)
        m(d)["protein"].append(p)
    months_out = []
    for key in sorted(by_m):
        x = by_m[key]
        avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None  # noqa: E731
        months_out.append({"month": key, "weight_avg": avg(x["weights"]),
                           "workouts": f"{x['workouts_done']}/{x['workouts_planned']}",
                           "activity_min": x["activity_min"], "sleep_avg_h": avg(x["sleep"]),
                           "state": x["state"], "food_days": len(x["kcal"]),
                           "kcal_avg": round(avg(x["kcal"]) or 0) or None, "protein_avg": round(avg(x["protein"]) or 0) or None})
    measures = [{"date": r["date"], **{k: r["data"][k] for k in ("weight", *MEASURES) if r["data"].get(k)}}
                for r in db.list_kind(uid, "body", since) if any(r["data"].get(k) for k in MEASURES)]
    programs = [{"title": p["data"].get("title"), "start": p["data"].get("start"), "end": p["data"].get("end"),
                 "place": p["data"].get("place"), "weekdays": p["data"].get("weekdays")} for p in db.list_kind(uid, "program")]
    return {"months": months_out, "measurements": measures, "programs": programs}


async def job_analysis(uid: str, inp: dict) -> dict:
    scope = inp.get("scope") or "all"            # body — упор на замеры и вес
    st = history_stats(uid, int(inp.get("months") or 6))
    if not st["months"] and not st["measurements"]:
        raise AIError("Пока мало данных для анализа — внесите хотя бы несколько недель веса, замеров и тренировок")
    goal = userdata.goal(uid)
    t = (userdata.latest_target(uid) or {}).get("data") or {}
    system = system_for(uid, "Ты тренер-аналитик. По истории клиента находишь, что реально сработало, а что нет, "
                             "и связываешь изменения веса и замеров с тренировками, активностями, сном и питанием. "
                             "Корреляция — не доказательство: где данных мало, так и говори.")
    user = (f"Клиент: {person_text(uid)}. Цели: {goals_text(goal)}.\nНорма: {t.get('kcal', '—')} ккал, белок {t.get('p', '—')} г.\n"
            f"История (по месяцам; measurements — замеры в см, weight — кг; workouts — сделано/запланировано):\n"
            f"{json.dumps(st, ensure_ascii=False)}\n\n"
            + ("Фокус разбора: замеры тела и вес — как меняются объёмы по зонам и что на это повлияло.\n"
               if scope == "body" else "")
            + "title — 3–6 слов; text — 4–7 предложений: общая картина и тренд; worked — что сработало (2–4 пункта, с цифрами); "
            "didnt — что не сработало или мешает (1–4 пункта); recommendations — 3–5 конкретных шагов на следующий месяц.")
    out = await ask_json(system, user, ANALYSIS_SCHEMA, temperature=0.5, think=True)
    rec_id = uuid.uuid4().hex
    db.server_put(uid, "coach", rec_id, {"kind": "analysis", "title": out.get("title", "Анализ истории"),
                                         "text": out.get("text", ""), "worked": out.get("worked", []),
                                         "didnt": out.get("didnt", []), "next": out.get("recommendations", []),
                                         "recommendations": out.get("recommendations", []), "stats": st, "scope": scope,
                                         "created": db.now_ms()}, date.today().isoformat())
    return {"record_id": rec_id}


# ── поиск БЖУ продукта (справочник + Open Food Facts + ИИ) ──

OFF_URL = "https://world.openfoodfacts.org/cgi/search.pl"
OFF_SEARCH2 = "https://search.openfoodfacts.org/search"
OFF_FIELDS = "product_name,product_name_ru,brands,nutriments,quantity,serving_size,nutrition_data_per,code"

LOOKUP_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"}, "state": {"type": "string", "enum": list(db.FOOD_STATES)},
        "group": {"type": "string"},
        "kcal": {"type": "number"}, "p": {"type": "number"}, "f": {"type": "number"}, "c": {"type": "number"},
        "confidence": {"type": "string", "enum": ["low", "mid", "high"]},
        "used_sources": {"type": "array", "items": {"type": "string"}},
        "reasoning_short": {"type": "string"},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "state", "kcal", "p", "f", "c", "confidence", "reasoning_short", "warnings"],
}

LOOKUP_SYSTEM = """Ты нутрициолог и аккуратный проверяющий. Нужно определить калорийность и БЖУ продукта НА 100 г
в ЗАПРОШЕННОМ СОСТОЯНИИ: dry — сухой до варки (крупы, макароны, бобовые), raw — сырой (мясо, рыба, овощи до готовки),
cooked — готовый (варёный, жареный, запечённый), as_sold — как продаётся (творог, йогурт, батончик, хлеб), fresh — свежий (фрукты, овощи).
Тебе дают кандидатов из локального справочника и из базы Open Food Facts (данные вносят люди, бывают ошибки).
Правила проверки:
- состояние: у круп и макарон сухие ≈ 300–380 ккал, варёные ≈ 80–180; 110 ккал у гречки — это варёная, сухая ≈ 310–340;
  у мяса сырое и готовое тоже различаются (готовое калорийнее на 100 г из-за потери воды);
- энергия должна сходиться с БЖУ: 4·Б + 4·У + 9·Ж ≈ ккал (±15 %);
- значения на порцию/батончик/упаковку часто по ошибке выдают за 100 г — сумма Б+Ж+У не может быть больше 100 г;
- отбрасывай кандидатов, которые явно про другой продукт или другое состояние; бренд важен, если он указан в запросе;
- у батончиков и продуктов с клетчаткой/подсластителями энергия ниже 4·Б + 4·У + 9·Ж: клетчатка ≈ 2 ккал/г, полиолы ещё меньше — это не ошибка;
- если в запросе бренд и нашлись товары этого бренда — опирайся на них (на типичный вкус или середину по вкусам), а не на усреднённый продукт;
- если источники расходятся — возьми правдоподобную середину и снизь уверенность.
Ответ: name — каноническое русское название с состоянием (например «Гречка сухая (ядрица)») и брендом, если он в запросе;
state — запрошенное состояние (или подходящее, если не указано); group — одна из групп: крупы, макароны, бобовые, овощи,
фрукты и ягоды, мясо, птица, рыба и морепродукты, молочные, сыры, яйца, хлеб и выпечка, сладости, орехи и семена,
жиры и масла, напитки, соусы и приправы, спортпит, готовые блюда, фастфуд, колбасы и полуфабрикаты;
kcal, p, f, c — на 100 г; confidence — high, если источники согласны и проверки сходятся, mid — если есть расхождения,
low — если данных мало или пришлось оценивать самому; used_sources — какие кандидаты использованы (их метки);
reasoning_short — 1–2 предложения, почему такие цифры; warnings — несоответствия, найденные в источниках
(например «в Open Food Facts у одного товара значения на батончик 40 г, а не на 100 г»).
В warnings и reasoning_short называй источники словами («справочник», «Open Food Facts», название товара), без меток."""


def _num(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and x >= 0 else None


async def off_search(query: str, n: int = 10) -> tuple[list[dict], str | None]:
    """Open Food Facts: до n товаров с БЖУ на 100 г. Без сети — ([], причина).
    Единственный выход сервера в интернет: уходит только название продукта (см. docs/PRIVACY.md)."""
    import httpx
    if not brain.web_allowed():
        return [], "поиск в интернете выключен в настройках приватности"
    params = {"search_terms": query, "search_simple": 1, "action": "process", "json": 1, "page_size": n, "fields": OFF_FIELDS}
    products, err = None, None
    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Trainer/1.0 (local family app)"}) as c:
        try:
            r = await c.get(OFF_URL, params=params)
            r.raise_for_status()
            products = r.json().get("products") or []
        except (httpx.HTTPError, ValueError) as e:
            err = e
        if products is None and not isinstance(err, httpx.ConnectError):
            # старый поиск часто отвечает 503 под нагрузкой — тогда новый (search-a-licious)
            try:
                r = await c.get(OFF_SEARCH2, params={"q": query, "page_size": n, "fields": OFF_FIELDS})
                r.raise_for_status()
                products = r.json().get("hits") or []
            except (httpx.HTTPError, ValueError) as e:
                err = e
    if products is None:
        return [], f"Open Food Facts недоступен ({type(err).__name__})"
    out = []
    for pr in products:
        nu = pr.get("nutriments") or {}
        kcal = _num(nu.get("energy-kcal_100g"))
        if kcal is None and _num(nu.get("energy_100g")) is not None:
            kcal = round(_num(nu.get("energy_100g")) / 4.184, 1)
        vals = {"kcal": kcal, "p": _num(nu.get("proteins_100g")), "f": _num(nu.get("fat_100g")),
                "c": _num(nu.get("carbohydrates_100g"))}
        if any(v is None for v in vals.values()):
            continue
        name = html.unescape(pr.get("product_name_ru") or pr.get("product_name") or "").strip()
        if not name:
            continue
        out.append({"label": f"off{len(out) + 1}", "kind": "off", "title": name, "brand": html.unescape(", ".join(pr["brands"]) if isinstance(pr.get("brands"), list) else pr.get("brands") or "").split(",")[0].strip(),
                    "quantity": pr.get("quantity") or "", "per": pr.get("nutrition_data_per") or "100g",
                    "serving": pr.get("serving_size") or "",
                    "url": f"https://world.openfoodfacts.org/product/{pr['code']}" if pr.get("code") else None,
                    **{k: round(v, 1) for k, v in vals.items()}, "fiber": round(_num(nu.get("fiber_100g")) or 0, 1)})
    return out, None


def local_candidates(query: str, idx: food.Index, n: int = 6) -> list[dict]:
    """Кандидаты из справочника: точное совпадение, продукт в других состояниях, похожие названия."""
    qn = food.norm(query)
    qwords = [food.stem(w) for w in qn.split() if len(w) > 1]
    picked: list[dict] = []

    def add(f):
        if f and all(x["id"] != f["id"] for x in picked):
            picked.append(f)
    m = idx.match(query)
    add(m)
    if m:
        for s in idx.siblings(m):
            add(s)
    for f in idx.foods:
        words = [food.stem(w) for w in food.norm(" ".join([f["name"], *f["aliases"]])).split()]
        if qwords and all(any(w.startswith(q) or q.startswith(w) for w in words if len(w) > 2) for q in qwords):
            add(f)
        if len(picked) >= n * 2:
            break
    for k in difflib.get_close_matches(qn, idx.keys.keys(), n=3, cutoff=0.7):
        add(idx.keys[k])
    return [{"label": f"db{i + 1}", "kind": "db", "id": f["id"], "title": f["name"], "state": f.get("state"),
             "group": f.get("group"), "note": f.get("note"), "cooked_ratio": f.get("cooked_ratio"),
             "source": f.get("source"), **{k: f[k] for k in ("kcal", "p", "f", "c")}} for i, f in enumerate(picked[:n])]


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


async def job_foodlookup(uid: str, inp: dict) -> dict:
    query = " ".join(str(inp.get("query") or "").split())[:120]
    if not query:
        raise AIError("Пустой запрос")
    state = inp.get("state") if inp.get("state") in db.FOOD_STATES else None
    idx = food.Index(uid)
    local = local_candidates(query, idx)
    # в OFF ищем без слов состояния: «гречка сухая» там почти не встречается
    off_q = food.STATE_WORDS.sub(" ", food.norm(query)).strip() or query
    web, web_err = await off_search(off_q)
    # бренд латиницей («Bombbar»): если общий поиск его не нашёл — ищем по бренду отдельно
    brand_words = [w for w in re.findall(r"[a-z][a-z0-9-]{2,}", query.lower())]
    has_brand = lambda x: any(b in f"{x['title']} {x.get('brand') or ''}".lower() for b in brand_words)
    if brand_words and not web_err and not any(map(has_brand, web)):
        more, _ = await off_search(" ".join(brand_words), 20)
        more = [m for m in more if has_brand(m)][:8]
        seen = {(w["title"], w["kcal"]) for w in web}
        web += [m for m in more if (m["title"], m["kcal"]) not in seen]
        for i, w in enumerate(web):
            w["label"] = f"off{i + 1}"
    notes = []
    for w in web:
        if w["per"] not in ("100g", "100 g", ""):
            notes.append(f"{w['label']}: в карточке значения на порцию ({w['serving'] or w['per']})")
        if w["p"] + w["f"] + w["c"] > 102:
            notes.append(f"{w['label']}: Б+Ж+У больше 100 г — не на 100 г")
        mm = food.energy_mismatch(w["kcal"], w["p"], w["f"], w["c"], w.get("fiber") or 0)
        if mm is not None and mm > 0.25:
            notes.append(f"{w['label']}: калории не сходятся с БЖУ")
    line = lambda x: (f"[{x['label']}] {x['title']}" + (f" ({x['brand']})" if x.get("brand") else "")
                      + (f", состояние {x['state']}" if x.get("state") else "") + (f", {x['quantity']}" if x.get("quantity") else "")
                      + f": {x['kcal']:g} ккал, Б {x['p']:g}, Ж {x['f']:g}, У {x['c']:g}" + (f", клетчатка {x['fiber']:g}" if x.get("fiber") else "") + (f" — {x['note']}" if x.get("note") else ""))
    user = (f"Запрос: «{query}». Нужное состояние: {state + ' — ' + food.STATE_RU[state] if state else 'не указано, выбери подходящее'}.\n\n"
            "Локальный справочник:\n" + ("\n".join(map(line, local)) or "— ничего") +
            "\n\nOpen Food Facts (на 100 г, по данным карточек):\n" + ("\n".join(map(line, web)) or f"— нет данных{': ' + web_err if web_err else ''}") +
            ("\n\nАвтоматические замечания:\n" + "\n".join(notes) if notes else ""))
    model_ok = True
    try:
        out = await ask_json(LOOKUP_SYSTEM, user, LOOKUP_SCHEMA, temperature=0.1, think=True)
    except AIError as e:
        # без модели — середина по источникам в нужном состоянии, с честной низкой уверенностью
        model_ok = False
        pool = [x for x in local if not state or x.get("state") in (state, None)] or web
        if not pool:
            raise
        out = {"name": pool[0]["title"], "state": state or pool[0].get("state") or "as_sold", "group": pool[0].get("group"),
               **{k: _median([x[k] for x in pool]) for k in ("kcal", "p", "f", "c")}, "confidence": "low",
               "used_sources": [x["label"] for x in pool], "reasoning_short": f"ИИ недоступна ({e}); медиана по источникам.",
               "warnings": []}
    by_label = {x["label"]: x for x in [*local, *web]}
    # метки источников (db2, off3) человеку ничего не скажут — подставляем названия
    unlabel = lambda t: re.sub(r"\[?\b(db|off)\d+\b\]?", lambda m: "«" + by_label[m.group(0).strip("[]")]["title"] + "»"
                                if m.group(0).strip("[]") in by_label else m.group(0), t)
    out["warnings"] = [unlabel(w) for w in out.get("warnings") or [] if isinstance(w, str)]
    out["reasoning_short"] = unlabel(out.get("reasoning_short") or "")
    vals = {k: round(max(0.0, float(out.get(k) or 0)), 1) for k in ("kcal", "p", "f", "c")}
    vals["kcal"] = round(vals["kcal"])
    res_state = state or (out.get("state") if out.get("state") in db.FOOD_STATES else None)
    group = out.get("group") or (local[0]["group"] if local else None)
    ratio = next((x.get("cooked_ratio") for x in local if x.get("cooked_ratio")), None)
    warnings = [w for w in (out.get("warnings") or []) if isinstance(w, str) and w.strip()][:6]
    checks = food.sanity(out.get("name") or query, res_state, group, vals, ratio)
    warnings += [w for w in checks if w not in warnings]
    # сверка со справочником в том же состоянии
    same = [x for x in local if res_state and x.get("state") == res_state and x["source"] == "seed"]
    if same and same[0]["kcal"] and abs(vals["kcal"] - same[0]["kcal"]) / same[0]["kcal"] > 0.35:
        warnings.append(f"В справочнике «{same[0]['title']}» — {same[0]['kcal']:g} ккал: расхождение больше трети.")
    conf = out.get("confidence") if out.get("confidence") in ("low", "mid", "high") else "low"
    if brand_words and not any(has_brand(by_label[l]) for l in {str(x).strip("[] ") for x in out.get("used_sources") or []} if l in by_label):
        n_brand = sum(map(has_brand, web))
        warnings.append(f"Карточки этого бренда в Open Food Facts есть ({n_brand}), но значения взяты типичные — у конкретного вкуса они другие; сверьте с этикеткой."
                        if n_brand else "Товар этого бренда в источниках не найден — значения типичные для такого продукта; сверьте с этикеткой.")
        conf = "low" if conf == "low" else "mid"
    if checks:
        conf = "low" if conf != "high" or len(checks) > 1 else "mid"
    used = {str(x).strip("[] ") for x in out.get("used_sources") or []}
    sources = [{k: x.get(k) for k in ("label", "kind", "title", "brand", "url", "kcal", "p", "f", "c", "state", "id")}
               | {"used": x["label"] in used} for x in by_label.values()]
    name = re.sub(r"\s*\(?\b(dry|raw|cooked|as_sold|fresh)\b\)?", "", out.get("name") or query).strip(" ,") or query
    brain.note_lookup(uid, query, name[:80])   # если человек сохранит этот продукт — запрос станет синонимом
    return {"query": query, "name": name[:80], "state": res_state or "as_sold", "group": group,
            **vals, "confidence": conf, "sources": sources, "web": bool(web), "web_error": web_err, "model": model_ok,
            "source": "web" if any(by_label.get(l, {}).get("kind") == "off" for l in used) else "ai",
            "reasoning_short": (out.get("reasoning_short") or "").strip()[:400], "warnings": warnings[:8],
            "local": [x for x in local][:6], "cooked_ratio": ratio}


HANDLERS = {"food": job_food, "foodlookup": job_foodlookup, "norms": job_norms, "program": job_program, "weekly": job_weekly,
            "mealplan": job_mealplan, "recipe": job_recipe, "analysis": job_analysis}
# «chat» регистрирует app/chat.py
