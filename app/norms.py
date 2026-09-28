"""Нормы по формулам: калории, БЖУ, клетчатка, вода, шаги, сон, сроки целей и интенсивность.

ИИ сюда не заходит: цифры должны быть одинаковыми при каждом пересчёте. ИИ потом только
объясняет результат (см. ai/jobs.py, задача `norms`).

v2: цели списком (с v1-запасным путём), темп и срок → уровень интенсивности
(комфортно / умеренно / агрессивно / нереально), плановые активности добавляются к расходу
по MET, поправки на тип телосложения. Ключи v1 в ответе сохранены.
"""
import math
import uuid
from datetime import date, timedelta

from . import db, userdata

ACTIVITY = {"sedentary": 1.2, "light": 1.375, "moderate": 1.55, "high": 1.725}
ACTIVITY_LABEL = {"sedentary": "сидячий образ жизни", "light": "лёгкая активность",
                  "moderate": "умеренная активность", "high": "высокая активность"}

LEVELS = ("comfortable", "moderate", "aggressive")
LEVEL_LABEL = {"comfortable": "комфортно", "moderate": "умеренно", "aggressive": "агрессивно", "unrealistic": "нереально"}
PACE_LEVEL = {"slower": "comfortable", "normal": "moderate", "faster": "aggressive"}
# Параметр уровня x: для cut/recomp — темп сброса жира в долях веса за неделю (0,007 = 0,7 %/нед),
# для bulk — профицит в долях расхода. Темп от веса честнее процента дефицита: у лёгкого человека
# тот же процент дефицита даёт другой смысл, а «0,5–1 % веса в неделю» — общепринятая шкала.
LEVEL_X = {
    "cut": {"comfortable": 0.004, "moderate": 0.007, "aggressive": 0.011},
    "recomp": {"comfortable": 0.003, "moderate": 0.005, "aggressive": 0.0075},
    "bulk": {"comfortable": 0.05, "moderate": 0.10, "aggressive": 0.15},
}
# верхние границы уровней по x: что выше последней — «нереально»
X_BOUNDS = {
    "cut": (0.005, 0.010, 0.015),
    "recomp": (0.004, 0.0065, 0.010),
    "bulk": (0.06, 0.11, 0.16),
}
X_SEARCH = {"cut": (0.001, 0.03, 0.00025), "recomp": (0.001, 0.03, 0.00025), "bulk": (0.02, 0.40, 0.005)}
MAX_DEFICIT = 0.35               # дефицит больше трети расхода не ставим никогда
SESSIONS = {"comfortable": 2, "moderate": 3, "aggressive": 4}
CARDIO_MIN = {  # минут кардио в неделю (активности засчитываются)
    "cut": {"comfortable": 60, "moderate": 120, "aggressive": 180},
    "recomp": {"comfortable": 60, "moderate": 90, "aggressive": 120},
    "bulk": {"comfortable": 30, "moderate": 45, "aggressive": 60},
    "maintain": {"comfortable": 60, "moderate": 90, "aggressive": 150},
}
KCAL_PER_KG_FAT = 7700
KCAL_PER_KG_GAIN = 5500          # набор веса: смесь мышц, жира и гликогена с водой
STRENGTH_MET = 5.0               # силовая средней интенсивности

UPPER_ZONES = ["chest", "shoulders", "arms", "back"]
LOWER_ZONES = ["legs", "glutes"]
HABIT_TARGETS = {
    "less_sugar": {"label": "добавленный сахар", "max_g": None},
    "less_flour": {"label": "мучное и выпечка", "max_per_week": 3},
    "less_coffee": {"label": "кофе", "max_cups": 2},
    "less_alcohol": {"label": "алкоголь", "max_per_week": 2},
    "less_fastfood": {"label": "фастфуд", "max_per_week": 1},
    "less_late_eating": {"label": "поздняя еда", "last_meal_before_sleep_h": 3},
    "more_veg": {"label": "овощи и фрукты", "min_g": 400},
    "more_protein": {"label": "белок", "min_g": None},
    "more_fiber": {"label": "клетчатка", "min_g": None},
}


# Цели-показатели v3 (зеркало каталога app/static/goals.js; меняете одно — меняйте и другое).
# fields — поля записи body (несколько — среднее), ex — упражнения, из подходов которых берём результат,
# e1rm — оценка 1ПМ по Эпли. eff[dir]: fat/gain — сдвиг калорий, cardio — мин/нед, zones/patterns — акценты объёма.
METRICS = {
    "waist": {"label": "талия", "unit": "см", "fields": ["waist"], "eff": {"down": {"fat": 1, "cardio": 30, "zones": {"abs": 1.15, "sides": 1.15}}}},
    "belly": {"label": "живот", "unit": "см", "fields": ["belly"], "eff": {"down": {"fat": 1, "cardio": 30, "zones": {"abs": 1.2, "sides": 1.15}}}},
    "hips": {"label": "бёдра (таз)", "unit": "см", "fields": ["hips"],
             "eff": {"down": {"fat": 1, "cardio": 20}, "up": {"gain": 1, "zones": {"glutes": 1.6, "legs": 1.2}, "patterns": {"hinge": 1.4, "lunge": 1.2}}}},
    "chest": {"label": "грудь", "unit": "см", "fields": ["chest"],
              "eff": {"down": {"fat": 1, "cardio": 20}, "up": {"gain": 1, "zones": {"chest": 1.5, "shoulders": 1.15, "back": 1.1}, "patterns": {"push_h": 1.4}}}},
    "neck": {"label": "шея", "unit": "см", "fields": ["neck"], "eff": {"down": {"fat": 1, "cardio": 20, "zones": {"neck": 1.2}}}},
    "arms": {"label": "руки (среднее)", "unit": "см", "fields": ["arm_l", "arm_r"],
             "eff": {"down": {"fat": 1, "cardio": 20}, "up": {"gain": 1, "zones": {"arms": 1.6, "shoulders": 1.1, "back": 1.1}, "patterns": {"isolation": 1.3, "pull_v": 1.15, "push_v": 1.1}}}},
    "arm_r": {"label": "правая рука", "unit": "см", "fields": ["arm_r"], "eff": {"down": {"fat": 1}, "up": {"gain": 1, "zones": {"arms": 1.6}, "patterns": {"isolation": 1.3}}}},
    "arm_l": {"label": "левая рука", "unit": "см", "fields": ["arm_l"], "eff": {"down": {"fat": 1}, "up": {"gain": 1, "zones": {"arms": 1.6}, "patterns": {"isolation": 1.3}}}},
    "thighs": {"label": "бёдра-ноги (среднее)", "unit": "см", "fields": ["thigh_l", "thigh_r"],
               "eff": {"down": {"fat": 1, "cardio": 20}, "up": {"gain": 1, "zones": {"legs": 1.5, "glutes": 1.2}, "patterns": {"squat": 1.3, "lunge": 1.3}}}},
    "calves": {"label": "голени (среднее)", "unit": "см", "fields": ["calf_l", "calf_r"], "eff": {"down": {"fat": 1}, "up": {"zones": {"legs": 1.2}}}},
    "weight": {"label": "вес", "unit": "кг", "eff": {"down": {"fat": 1, "cardio": 30}, "up": {"gain": 1}}},
    "body_fat_pct": {"label": "процент жира", "unit": "%", "eff": {"down": {"fat": 1, "cardio": 30}}},
    "pushups_max": {"label": "отжимания (максимум)", "unit": "раз", "ex": ["pushup"],
                    "eff": {"up": {"zones": {"chest": 1.3, "arms": 1.2, "shoulders": 1.1}, "patterns": {"push_h": 1.5}}}},
    "pullups_max": {"label": "подтягивания (максимум)", "unit": "раз", "ex": ["pullup"],
                    "eff": {"up": {"zones": {"back": 1.4, "arms": 1.2}, "patterns": {"pull_v": 1.6, "pull_h": 1.2}}}},
    "plank_sec": {"label": "планка", "unit": "с", "ex": ["plank"], "eff": {"up": {"zones": {"abs": 1.4, "sides": 1.1}, "patterns": {"core_anti": 1.6}}}},
    "squat_1rm": {"label": "присед (1ПМ)", "unit": "кг", "ex": ["barbell_back_squat"], "e1rm": True,
                  "eff": {"up": {"zones": {"legs": 1.4, "glutes": 1.2}, "patterns": {"squat": 1.6}}}},
    "bench_1rm": {"label": "жим лёжа (1ПМ)", "unit": "кг", "ex": ["barbell_bench_press"], "e1rm": True,
                  "eff": {"up": {"zones": {"chest": 1.4, "arms": 1.2, "shoulders": 1.1}, "patterns": {"push_h": 1.6}}}},
    "run_5k_min": {"label": "бег 5 км", "unit": "мин", "eff": {"down": {"cardio": 60, "zones": {"legs": 1.1}}}},
    "steps_avg": {"label": "шаги в день", "unit": "шагов", "eff": {"up": {"steps": True}}},
    "sleep_avg_h": {"label": "сон", "unit": "ч", "eff": {"up": {}}},
    "water_avg": {"label": "вода", "unit": "стаканов", "eff": {"up": {}}},
    "protein_avg_g": {"label": "белок", "unit": "г/день", "eff": {"up": {"protein": True}}},
}
PRIO_K = {1: 1.0, 2: 0.7, 3: 0.4}
ZONE_RU = {"chest": "грудь", "shoulders": "плечи", "arms": "руки", "back": "спина", "abs": "пресс", "sides": "бока",
           "glutes": "ягодицы", "legs": "ноги", "neck": "шея"}
CM_PER_KG_FAT = 1.0              # грубо: −1 см талии ≈ −1 кг жира (только для оценки срока, если вес не задан)


def _f(v) -> float | None:
    try:
        return None if v in (None, "") else float(str(v).replace(",", "."))
    except ValueError:
        return None


def metric_dir(g: dict) -> str:
    f, t = _f(g.get("from")), _f(g.get("to"))
    if f is not None and t is not None and f != t:
        return "down" if t < f else "up"
    eff = (METRICS.get(g.get("metric")) or {}).get("eff") or {}
    return next(iter(eff), "down")


def metric_effects(goals: list[dict]) -> dict:
    """Как цели меняют план: калории (fat/gain), кардио, шаги, акценты зон и паттернов (множители объёма).

    На калории влияют только главные и важные цели — «по возможности» режим не переключает.
    """
    out = {"fat": False, "gain": False, "cardio": 0, "steps": None, "protein": False, "zones": {}, "patterns": {}, "emphasis": []}
    for g in goals:
        if g.get("type") != "metric" or g.get("metric") not in METRICS:
            continue
        m, d = METRICS[g["metric"]], metric_dir(g)
        e = m["eff"].get(d) or {}
        pk = PRIO_K.get(int(g.get("priority") or 2), 0.7)
        if e.get("fat") and pk >= 0.7:
            out["fat"] = True
        if e.get("gain") and pk >= 0.7:
            out["gain"] = True
        if e.get("cardio"):
            out["cardio"] = max(out["cardio"], int(round(e["cardio"] * pk / 5) * 5))
        if e.get("steps") and _f(g.get("to")):
            out["steps"] = max(out["steps"] or 0, int(_f(g["to"])))
        if e.get("protein"):
            out["protein"] = True
        for key in ("zones", "patterns"):
            for k, v in (e.get(key) or {}).items():
                x = round(1 + (v - 1) * pk, 2)
                if x > out[key].get(k, 1):
                    out[key][k] = x
        if e.get("zones") or e.get("patterns"):
            out["emphasis"].append(f"{m['label']} {'↓' if d == 'down' else '↑'}")
    return out


def _metric_amounts(goals: list[dict], weight: float, notes: list[str]) -> list[dict]:
    """Цель «вес 90 → 82» или «талия −6 см» без явной цели в кг → оценка кг для шкалы сроков."""
    types = {g["type"] for g in goals}
    extra = []
    main = [g for g in goals if g["type"] == "metric" and int(g.get("priority") or 2) <= 2]
    wg = next((g for g in main if g.get("metric") == "weight"), None)
    if wg and _f(wg.get("to")):
        to = _f(wg["to"])
        if to < weight and metric_dir(wg) == "down" and "lose_fat" not in types:
            extra.append({"type": "lose_fat", "amount": round(weight - to, 1), "zones": [], "priority": int(wg.get("priority") or 2), "from_metric": "weight"})
        elif to > weight and metric_dir(wg) == "up" and not types & {"gain_weight", "gain_muscle"}:
            extra.append({"type": "gain_weight", "amount": round(to - weight, 1), "zones": [], "priority": int(wg.get("priority") or 2), "from_metric": "weight"})
    if not extra and "lose_fat" not in types:
        for g in main:
            if g.get("metric") in ("waist", "belly") and metric_dir(g) == "down" and _f(g.get("from")) and _f(g.get("to")):
                kg = round((_f(g["from"]) - _f(g["to"])) / CM_PER_KG_FAT, 1)
                extra.append({"type": "lose_fat", "amount": kg, "zones": [], "priority": int(g.get("priority") or 2), "from_metric": g["metric"]})
                notes.append(f"Срок по цели «{METRICS[g['metric']]['label']}» оценён грубо: −1 см ≈ −1 кг жира.")
                break
    return goals + extra


def metric_current(uid: str, key: str) -> float | None:
    """Текущее значение показателя по записям (для промптов; точный расчёт с трендом — на клиенте, goals.js)."""
    m = METRICS.get(key)
    if not m:
        return None
    if key == "weight":
        return userdata.latest_weight(uid)
    if m.get("fields"):
        for r in reversed(db.list_kind(uid, "body")):
            vs = [_f(r["data"].get(f)) for f in m["fields"]]
            vs = [v for v in vs if v]
            if vs:
                return round(sum(vs) / len(vs), 1)
        return None
    since = (date.today() - timedelta(days=28)).isoformat()
    best = None
    for r in db.list_kind(uid, "mtest", date_from=since):
        v = _f(r["data"].get("value"))
        if r["data"].get("metric") == key and v:
            best = v if best is None or (v > best if key != "run_5k_min" else True) else best
    if m.get("ex"):
        for w in db.list_kind(uid, "workout", date_from=since):
            for x in w["data"].get("exercises") or []:
                if x.get("id") not in m["ex"]:
                    continue
                for s in x.get("log") or []:
                    if not s or not s.get("done"):
                        continue
                    reps, kg = _f(s.get("reps")) or 0, _f(s.get("weight")) or 0
                    v = kg * (1 + reps / 30) if m.get("e1rm") and 0 < reps <= 12 and kg else (None if m.get("e1rm") else reps)
                    if v and (best is None or v > best):
                        best = round(v, 1)
    if best is None:
        rows = [r for r in db.list_kind(uid, "mtest") if r["data"].get("metric") == key and _f(r["data"].get("value"))]
        best = _f(rows[-1]["data"]["value"]) if rows else None
    return best


def age_on(birth: str, today: date) -> int:
    b = date.fromisoformat(birth)
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


def goals_of(goal: dict) -> list[dict]:
    """Цели списком. v1 (fat_kg, muscle_*_kg) переводим в v2, чтобы старые данные считались так же."""
    if goal.get("goals"):
        out = []
        for g in goal["goals"]:
            if not g or not g.get("type"):
                continue
            if g["type"] == "metric":
                if g.get("metric") in METRICS:
                    out.append({"type": "metric", "metric": g["metric"], "from": _f(g.get("from")), "to": _f(g.get("to")),
                                "unit": g.get("unit") or METRICS[g["metric"]]["unit"], "deadline": g.get("deadline") or None,
                                "since": g.get("since") or None, "amount": 0.0, "zones": [], "priority": int(g.get("priority") or 2)})
                continue
            out.append({"type": g["type"], "amount": float(g.get("amount") or 0), "zones": list(g.get("zones") or []),
                        "priority": int(g.get("priority") or 2)})
        return out
    out = []
    fat = float(goal.get("fat_kg") or 0)
    up, low = float(goal.get("muscle_upper_kg") or 0), float(goal.get("muscle_lower_kg") or 0)
    if fat > 0:
        out.append({"type": "lose_fat", "amount": fat, "zones": [], "priority": 1})
    if up + low > 0:
        zones = (UPPER_ZONES if up else []) + (LOWER_ZONES if low else [])
        out.append({"type": "gain_muscle", "amount": up + low, "zones": zones, "priority": 1 if not fat else 2})
    return out


def _mode(goals: list[dict], bmi: float) -> str:
    types = {g["type"] for g in goals}
    eff = metric_effects(goals)
    fat = "lose_fat" in types or eff["fat"]
    gain = bool(types & {"gain_muscle", "gain_weight"})
    if eff["gain"] and not gain:
        # объём рук/груди при лишнем весе растим на поддержке калорий, а не на профиците
        if bmi >= 25 and not fat:
            return "maintain"
        gain = True
    if fat and gain:
        return "recomp"
    if fat:
        return "cut"
    if gain:
        return "bulk"
    return "maintain"


def _amount(goals: list[dict], t: str) -> float:
    return sum(g["amount"] for g in goals if g["type"] == t)


def exercise_kcal(profile: dict, weight: float) -> tuple[float, int, list[str]]:
    """Средний расход на плановые активности и силовые в день (чистый, сверх покоя: MET − 1).

    → (ккал/день, минут активностей в неделю, пояснения). Минус 1 MET — потому что это время
    уже учтено базовым обменом × коэффициент активности, иначе посчитали бы дважды.
    """
    acts = profile.get("activities") or []
    notes, total, minutes = [], 0.0, 0
    cat = {a.get("id"): a for a in db.activities()}
    for a in acts:
        per_week = float(a.get("per_week") or len(a.get("weekdays") or []) or 0)
        mins = float(a.get("minutes") or 0)
        if not per_week or not mins:
            continue
        info = cat.get(a.get("type")) or {}
        met_tbl = info.get("met") or {"low": 3.5, "mid": 5.0, "high": 7.5}
        met = float(met_tbl.get(a.get("intensity") or "mid") or 5.0)
        total += (met - 1) * weight * mins / 60 * per_week
        minutes += int(per_week * mins)
        notes.append(f"{info.get('name', a.get('type'))}: {per_week:g}×{mins:g} мин")
    sessions = _strength_sessions(profile)
    if acts and sessions:
        mins = min(60, int(profile.get("time_budget_min") or 60))
        total += (STRENGTH_MET - 1) * weight * mins / 60 * sessions
        notes.append(f"силовые: {sessions}×{mins} мин")
    return total / 7, minutes, notes


def _strength_sessions(profile: dict) -> int:
    n = len(profile.get("weekdays") or []) or int(profile.get("gym_days") or 0)
    cap = profile.get("max_sessions_week")
    return min(n, int(cap)) if cap else n


def _pct(mode: str, x: float, weight: float, tdee: float) -> float:
    """x уровня → доля дефицита (cut/recomp) или профицита (bulk) от расхода."""
    if mode in ("cut", "recomp"):
        return x * weight * KCAL_PER_KG_FAT / 7 / tdee if tdee else 0.0
    return x


def _weeks_for(mode: str, x: float, weight: float, tdee: float, goals: list[dict], sex: str) -> float | None:
    """Сколько недель при данном x. None — у цели нет количественной части."""
    fat = _amount(goals, "lose_fat")
    muscle = _amount(goals, "gain_muscle")
    gainw = _amount(goals, "gain_weight")
    base = 1.0 if sex == "m" else 0.5          # кг мышц в месяц у новичка
    weeks = []
    if mode in ("cut", "recomp") and fat:
        weeks.append(fat / (x * weight))
    if muscle:
        # темп набора мышц растёт с профицитом, но упирается в физиологию; при дефиците — вдвое медленнее
        k = min(1.3, x / 0.10) if mode == "bulk" else 0.5
        weeks.append(muscle / (base * max(0.3, k)) * 4.35)
    if gainw and mode == "bulk":
        weeks.append(gainw * KCAL_PER_KG_GAIN / (tdee * x * 7))
    return max(weeks) if weeks else None


def _label(mode: str, x: float) -> str:
    b = X_BOUNDS.get(mode)
    if not b:
        return "comfortable"
    for lvl, top in zip(LEVELS, b):
        if x <= top + 1e-9:
            return lvl
    return "unrealistic"


def _x_for_weeks(mode: str, weeks_left: float, weight: float, tdee: float, goals: list[dict], sex: str) -> float | None:
    """Минимальный x, при котором цель успевается к сроку (перебором). None — не успеть ни при каком."""
    lo, hi, step = X_SEARCH[mode]
    x = lo
    while x <= hi + 1e-12:
        w = _weeks_for(mode, x, weight, tdee, goals, sex)
        if w is None or w <= weeks_left:
            return round(x, 5)
        x += step
    return None


def sleep_hours(age: int) -> float:
    return 8.5 if age < 26 else 8.0 if age < 46 else 7.5


def compute(profile: dict, weight: float, goal: dict, today: date | None = None,
            deadline: str | None = None, pace: str | None = None) -> dict:
    """Нормы и сроки.

    Уровень интенсивности: явный `pace` (из запроса) → срок `deadline` (из запроса, иначе из цели) →
    `profile.pace` → «умеренно».
    """
    today = today or date.today()
    sex = profile.get("sex") or "m"
    height = float(profile["height"])
    age = age_on(profile["birth"], today)
    act = profile.get("activity") or "light"
    bmi = weight / (height / 100) ** 2
    warnings: list[str] = []
    notes: list[str] = []
    goals = _metric_amounts(goals_of(goal), weight, notes)
    mode = _mode(goals, bmi)
    types = {g["type"] for g in goals}
    m_eff = metric_effects(goals)
    if m_eff["gain"] and mode == "maintain" and not types & {"gain_muscle", "gain_weight"}:
        notes.append("Рост объёма при ИМТ от 25 — на поддержке калорий, без профицита: мышцы растут, жир не прибавляется.")

    bmr = 10 * weight + 6.25 * height - 5 * age + (5 if sex == "m" else -161)
    ex_kcal, act_minutes, ex_notes = exercise_kcal(profile, weight)
    factor_key = act
    if profile.get("activities"):
        # спорт считаем отдельно по MET, коэффициент — только быт, иначе двойной счёт
        if ACTIVITY.get(act, 1.375) > ACTIVITY["light"]:
            factor_key = "light"
            notes.append("Тренировки и активности посчитаны отдельно по MET, поэтому бытовая активность взята как «лёгкая».")
    tdee = bmr * ACTIVITY.get(factor_key, 1.375) + ex_kcal
    if ex_notes:
        notes.append(f"Плановые нагрузки добавляют в среднем {round(ex_kcal)} ккал в день ({'; '.join(ex_notes)}).")

    # ── уровень интенсивности ──
    deadline = deadline or (None if pace else goal.get("deadline"))
    pace = pace or profile.get("pace") or "normal"
    level = PACE_LEVEL.get(pace, "moderate")
    x = LEVEL_X.get(mode, {}).get(level, 0.0)
    weeks_left = None
    if deadline and mode != "maintain":
        try:
            weeks_left = max(0.5, (date.fromisoformat(deadline) - today).days / 7)
        except ValueError:
            deadline = None
    if weeks_left is not None:
        need = _x_for_weeks(mode, weeks_left, weight, tdee, goals, sex)
        if need is None:
            level, x = "unrealistic", LEVEL_X[mode]["aggressive"]
        else:
            level = _label(mode, need)
            # срок далёкий — не тянем дефицит к нулю: минимум половина «комфортного»
            x = min(max(need, LEVEL_X[mode]["comfortable"] / 2), LEVEL_X[mode]["aggressive"])
    pct = min(MAX_DEFICIT, _pct(mode, x, weight, tdee)) if mode != "maintain" else 0.0
    if mode == "maintain":
        pct = 0.0
        if "tone" in types and bmi >= 25:
            pct = 0.05
            notes.append("Цель «тонус» при ИМТ от 25: небольшой дефицит 5 %, чтобы рельеф проявлялся.")

    # поправки на тип телосложения — скромные, чтобы не спорить с физиологией
    body = profile.get("body_type")
    if body == "ecto" and mode == "bulk":
        pct += 0.03
        notes.append("Эктоморфу набирать труднее — профицит на 3 % выше обычного.")
    sign = -1 if mode in ("cut", "recomp") or (mode == "maintain" and pct) else 1
    floor = 1500 if sex == "m" else 1200
    kcal = tdee * (1 + sign * pct)
    if kcal < floor:
        warnings.append(f"Расчётные калории ниже безопасного минимума — ставим {floor} ккал. Лучше увеличить срок или добавить движения.")
        kcal = floor
    real_pct = (tdee - kcal) / tdee if tdee else 0

    # ── БЖУ ──
    ref_w = min(weight, 27 * (height / 100) ** 2) if bmi > 30 else weight
    protein = ref_w * (2.0 if mode in ("recomp", "bulk") else 1.8)
    fat_share = 0.25
    if body == "endo":
        fat_share = 0.30
        notes.append("Эндоморфу чуть меньше углеводов: доля жиров поднята до 30 %, углеводы — остаток.")
    if profile.get("diet") in ("low_carb", "keto"):
        fat_share = 0.45 if profile["diet"] == "low_carb" else 0.65
        notes.append("Выбрано питание с малым количеством углеводов — доля жиров увеличена.")
    fat_g = max(0.8 * weight, kcal * fat_share / 9)
    carbs = max(0.0, (kcal - protein * 4 - fat_g * 9) / 4)
    fiber = kcal / 1000 * 14

    # ── вода, шаги, сон ──
    sessions = _strength_sessions(profile)
    water_ml = weight * 30
    glass = int(profile.get("glass_ml") or 250)
    steps = {"cut": 10000, "recomp": 9000, "maintain": 8000, "bulk": 7000}[mode]
    if mode == "maintain" and types & {"tone", "endurance"}:
        steps = 9000
    if m_eff["steps"]:
        steps = max(steps, min(15000, m_eff["steps"]))
    sleep = sleep_hours(age)
    if "sleep" in types:
        notes.append(f"Цель по сну: {sleep:g} ч и отбой в одно и то же время ±30 мин.")

    # ── сроки ──
    weeks_real = _weeks_for(mode, LEVEL_X[mode]["moderate"], weight, tdee, goals, sex) if mode != "maintain" else None
    max_sessions = sessions or 3
    budget = int(profile.get("time_budget_min") or 60)
    options = []
    if weeks_real:
        sign_o = 1 if mode != "bulk" else -1
        for lvl in LEVELS:
            lx = LEVEL_X[mode][lvl]
            w = _weeks_for(mode, lx, weight, tdee, goals, sex)
            lp = min(MAX_DEFICIT, _pct(mode, lx, weight, tdee))
            options.append({"label": lvl, "weeks": math.ceil(w), "deadline": (today + timedelta(weeks=math.ceil(w))).isoformat(),
                            "deficit_pct": round(lp * sign_o * 100),
                            "rate_pct_week": round(lx * 100, 2) if mode != "bulk" else None,
                            "sessions": min(SESSIONS[lvl], max(max_sessions, 2)),
                            "kcal": round(max(floor, tdee * (1 - sign_o * lp)) / 10) * 10})
        aggr = options[-1]["weeks"]
        uw = max(1, math.floor(aggr * 0.6))
        options.append({"label": "unrealistic", "weeks": uw, "deadline": (today + timedelta(weeks=uw)).isoformat(),
                        "deficit_pct": None, "sessions": None, "kcal": None})

    # предупреждения о реалистичности (логика v1)
    fat_kg, muscle_kg = _amount(goals, "lose_fat"), _amount(goals, "gain_muscle")
    muscle_month = (1.0 if sex == "m" else 0.5) / (2 if mode == "recomp" else 1)
    if muscle_kg >= (8 if sex == "m" else 4):
        warnings.append(f"+{muscle_kg:g} кг мышц — это цель на год-полтора даже при идеальном режиме. "
                        f"Реальный темп новичка около {muscle_month:g} кг в месяц.")
    if mode == "recomp":
        warnings.append("Сброс жира и набор мышц одновременно (рекомпозиция) возможен, но оба процесса идут медленнее. "
                        "Часто эффективнее сначала сбросить жир, потом набирать.")
    if fat_kg and fat_kg > weight * 0.2:
        warnings.append("Больше 20 % веса за раз — лучше разбить цель на этапы по 5–7 кг.")
    if weeks_left is not None:
        dl = date.fromisoformat(deadline)
        if level == "unrealistic":
            warnings.append(f"К {dl:%d.%m.%Y} цель не успеть даже в агрессивном режиме: реалистично около "
                            f"{math.ceil(weeks_real or 0)} нед., а осталось {max(0, round(weeks_left))}. Сдвиньте срок или уменьшите цель.")
        elif level == "aggressive":
            warnings.append(f"Срок {dl:%d.%m.%Y} достижим только в агрессивном режиме: будет тяжело, выше риск сорваться.")
    if "neck" in types:
        notes.append("Второй подбородок уходит только вместе с общим жиром; упражнения для шеи улучшают осанку и тонус, но не «сжигают» жир точечно.")
    if profile.get("limitations") and set(profile["limitations"]) & {"heart", "hypertension", "pregnancy", "diabetes"}:
        warnings.append("Есть ограничения по здоровью — нормы и нагрузку стоит согласовать с врачом.")

    # ── интенсивность ──
    lvl_for_load = level if level in SESSIONS else "aggressive"
    weekly_sessions = min(SESSIONS[lvl_for_load], max(max_sessions, 2)) if mode != "maintain" else min(3, max(max_sessions, 2))
    cardio = CARDIO_MIN[mode][lvl_for_load]
    if "endurance" in types:
        cardio += 60
    if m_eff["cardio"]:
        cardio += m_eff["cardio"]
        notes.append(f"Цели-показатели: кардио +{m_eff['cardio']} мин в неделю.")
    if m_eff["zones"]:
        notes.append("Акцент в тренировках: " + ", ".join(f"{ZONE_RU.get(z, z)} ×{str(v).replace('.', ',')}" for z, v in sorted(m_eff["zones"].items(), key=lambda kv: -kv[1])) + ".")
    intensity = {
        "level": level, "label": LEVEL_LABEL[level],
        "deficit_pct": round(real_pct * 100),              # отрицательный — профицит
        "rate_pct_week": round(x * 100, 2) if mode in ("cut", "recomp") else None,   # темп сброса, % веса в неделю
        "weekly_sessions": weekly_sessions,
        "weekly_minutes": weekly_sessions * min(budget, 75),
        "cardio_minutes": cardio,
        "cardio_from_activities": min(cardio, act_minutes),
        "emphasis": {"zones": m_eff["zones"], "patterns": m_eff["patterns"]},   # множители объёма от целей-показателей
    }

    habits = {h: HABIT_TARGETS[h] for h in goal.get("habits") or [] if h in HABIT_TARGETS}
    if "less_sugar" in habits:
        habits["less_sugar"] = {**habits["less_sugar"], "max_g": 36 if sex == "m" else 25}
    if "more_protein" in habits:
        habits["more_protein"] = {**habits["more_protein"], "min_g": round(protein)}
    if "more_fiber" in habits:
        habits["more_fiber"] = {**habits["more_fiber"], "min_g": round(fiber)}

    return {
        # поля v1
        "mode": mode,
        "bmr": round(bmr), "tdee": round(tdee), "bmi": round(bmi, 1), "age": age,
        "kcal": round(kcal / 10) * 10,
        "p": round(protein), "f": round(fat_g), "c": round(carbs),
        "water_ml": round(water_ml / 50) * 50,
        "water_ml_gym": round((water_ml + 500) / 50) * 50,
        "water_glasses": math.ceil(water_ml / glass),
        "water_glasses_gym": math.ceil((water_ml + 500) / glass) if sessions or profile.get("gym") else math.ceil(water_ml / glass),
        "steps": steps,
        "weeks_needed": math.ceil(weeks_real) if weeks_real else None,
        "warnings": warnings,
        "activity_label": ACTIVITY_LABEL.get(factor_key, factor_key),
        # v2
        "fiber": round(fiber),
        "sleep_hours": sleep,
        "goals": goals,
        "pace": pace,
        "deadline": deadline,
        "exercise_kcal": round(ex_kcal),
        "timeline": {"realistic_weeks": math.ceil(weeks_real) if weeks_real else None,
                     "realistic_deadline": (today + timedelta(weeks=math.ceil(weeks_real))).isoformat() if weeks_real else None,
                     "chosen": {"label": level, "deadline": deadline,
                                "weeks": math.ceil(_weeks_for(mode, x, weight, tdee, goals, sex) or 0) or None if mode != "maintain" else None},
                     "options": options},
        "intensity": intensity,
        "habits_targets": habits,
        "notes": notes,
    }


def preview(profile: dict, weight: float, goal: dict, deadline: str, today: date | None = None,
            pace: str | None = None) -> dict:
    """Ползунок срока: что будет, если поставить такой срок. Ничего не пишет. Срок важнее темпа."""
    r = compute(profile, weight, goal, today, deadline=deadline, pace=pace)
    i = r["intensity"]
    weeks = None
    if deadline:
        weeks = max(0, round((date.fromisoformat(deadline) - (today or date.today())).days / 7))
    return {"label": i["level"], "label_ru": i["label"], "weeks": weeks, "deficit_pct": i["deficit_pct"],
            "rate_pct_week": i.get("rate_pct_week"), "options": r["timeline"]["options"],
            "sessions": i["weekly_sessions"], "cardio_minutes": i["cardio_minutes"], "kcal": r["kcal"],
            "realistic_weeks": r["timeline"]["realistic_weeks"], "warnings": r["warnings"]}


class MissingData(ValueError):
    pass


def recalc_for(uid: str, deadline: str | None = None, pace: str | None = None) -> tuple[str, dict]:
    """Пересчитать и записать новую версию норм (общая часть POST /api/norms и действия чата).

    Явные pace/deadline сохраняются в профиль/цель — чтобы следующий пересчёт их помнил.
    → (id записи target, данные). MissingData — если в профиле не хватает полей.
    """
    prof, goal = userdata.profile(uid), userdata.goal(uid)
    weight = userdata.latest_weight(uid)
    missing = [n for n, v in (("пол", prof.get("sex")), ("дата рождения", prof.get("birth")),
                              ("рост", prof.get("height")), ("вес", weight)) if not v]
    if missing:
        raise MissingData("Заполните в профиле: " + ", ".join(missing))
    pace = pace if pace in PACE_LEVEL else None
    if pace and pace != prof.get("pace"):
        prof = {**prof, "pace": pace}
        db.server_put(uid, "profile", f"profile:{uid}", prof)
    if deadline and goal and deadline != goal.get("deadline"):
        db.server_put(uid, "goal", f"goal:{uid}", {**goal, "deadline": deadline})
    res = compute(prof, float(weight), goal, deadline=deadline, pace=pace)
    prev = userdata.latest_target(uid)
    manual = (prev or {}).get("data", {}).get("steps_manual")     # ручная правка шагов переживает пересчёт
    target_id = uuid.uuid4().hex
    data = {**res, "weight": float(weight), "valid_from": date.today().isoformat(), "source": "formula",
            "explanation": "", "tips": [], **({"steps_manual": manual} if manual else {})}
    db.server_put(uid, "target", target_id, data)
    return target_id, data
