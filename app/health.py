"""Приём данных из «Здоровья» iPhone через Команды iOS.

PWA не видит HealthKit, поэтому данные приносит команда на телефоне: POST с личным токеном
в заголовке `X-Trainer-Token`. Токен отдельный от сессии: его вписывают в команду один раз,
и он не даёт доступа ни к чему, кроме импорта. Импорт идемпотентен по дате — команду можно
запускать сколько угодно раз в день, записи перезапишутся, а не размножатся.
"""
import re
import secrets
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request

from . import db, userdata
from .userdata import current_user

router = APIRouter()

# названия тренировок из «Здоровья» (англ. и рус.) → id из activities.json; дополняют aliases справочника
HEALTH_NAMES = {
    "walking": "walking", "ходьба": "walking", "прогулка": "walking", "hiking": "hiking", "хайкинг": "hiking",
    "running": "running", "бег": "running", "cycling": "cycling", "велоспорт": "cycling", "велосипед": "cycling",
    "swimming": "swimming", "плавание": "swimming", "pool swim": "swimming", "open water swim": "swimming",
    "yoga": "yoga", "йога": "yoga", "pilates": "pilates", "пилатес": "pilates",
    "dance": "dance", "dancing": "dance", "танцы": "dance", "cardio dance": "dance", "social dance": "dance",
    "snowboarding": "snowboard", "сноуборд": "snowboard", "downhill skiing": "alpine_skiing",
    "cross country skiing": "cross_country_skiing", "горные лыжи": "alpine_skiing", "лыжи": "cross_country_skiing",
    "traditional strength training": "functional_training", "functional strength training": "functional_training",
    "силовая тренировка": "functional_training", "функциональная силовая тренировка": "functional_training",
    "традиционная силовая тренировка": "functional_training", "hiit": "functional_training",
    "высокоинтенсивная интервальная тренировка": "functional_training", "cross training": "functional_training",
    "core training": "functional_training", "jump rope": "jump_rope", "скакалка": "jump_rope",
    "fast walking": "walk_fast", "быстрая ходьба": "walk_fast", "indoor cycle": "stationary_bike",
    "велотренажер": "stationary_bike", "water fitness": "aqua_aerobics", "paddle sports": "sup",
    "surfing sports": "surfing", "badminton": "badminton", "table tennis": "table_tennis",
    "volleyball": "volleyball", "basketball": "basketball", "squash": "squash", "step training": "step_aerobics",
    "equestrian sports": "horse_riding", "skating sports": "ice_skating", "barre": "pilates", "tai chi": "yoga",
    "elliptical": "elliptical_trainer", "эллипс": "elliptical_trainer", "rowing": "indoor_rowing", "гребля": "rowing",
    "stair climbing": "stairs", "лестница": "stairs", "stairs": "stairs",
    "tennis": "tennis", "теннис": "tennis", "football": "football", "soccer": "football", "футбол": "football",
    "gymnastics": "gymnastics", "гимнастика": "gymnastics", "climbing": "climbing", "скалолазание": "climbing",
    "martial arts": "martial_arts", "боевые искусства": "martial_arts", "boxing": "boxing", "бокс": "boxing",
    "skating": "ice_skating", "коньки": "ice_skating", "cooldown": "stretching", "flexibility": "stretching",
    "растяжка": "stretching", "гибкость": "stretching", "mind and body": "yoga", "other": "other", "другое": "other",
}


def _norm(s: str) -> str:
    s = re.sub(r"^hkworkoutactivitytype", "", str(s).strip().lower().replace("ё", "е"))
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)
    return re.sub(r"[_\-]+", " ", s).strip()


def match_activity(name: str) -> str:
    """Название вида → id из activities.json; неизвестное — 'other'."""
    n = _norm(name)
    if not n:
        return "other"
    cat = db.activities()
    ids = {a["id"] for a in cat}
    for a in cat:
        keys = [a["id"], a.get("name", ""), *(a.get("aliases") or [])]
        if n in {_norm(k) for k in keys if k}:
            return a["id"]
    hit = HEALTH_NAMES.get(n)
    if hit and (not ids or hit in ids):
        return hit
    for a in cat:                             # «утренний бег» → бег
        for k in [a.get("name", ""), *(a.get("aliases") or [])]:
            if k and len(k) >= 3 and _norm(k) in n:
                return a["id"]
    for k, v in HEALTH_NAMES.items():
        if len(k) >= 4 and k in n and (not ids or v in ids):
            return v
    return "other"


# ── токен ──

def token_for(uid: str, rotate: bool = False) -> str:
    rows = db.q("SELECT token FROM health_tokens WHERE user_id = ?", (uid,))
    if rows and not rotate:
        return rows[0]["token"]
    tok = secrets.token_urlsafe(24)
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO health_tokens VALUES (?,?,?)", (uid, tok, db.now_ms()))
    return tok


@router.get("/api/health/token")
def get_token(u=Depends(current_user)):
    return {"token": token_for(u["id"])}


@router.post("/api/health/token")
def new_token(u=Depends(current_user)):
    return {"token": token_for(u["id"], rotate=True)}


# ── разбор причуд Команд ──

def _first(v):
    """Команды часто присылают список вместо одного значения — берём первый элемент."""
    while isinstance(v, list):
        if not v:
            return None
        v = v[0]
    return v


def num(v, total: bool = False) -> float | None:
    """Число из «1 234,5», «72,4 кг», ["3000","4500"] (total — сложить список, как шаги по часам)."""
    if isinstance(v, list):
        vals = [x for x in (num(i) for i in v) if x is not None]
        if not vals:
            return None
        return sum(vals) if total else vals[-1]
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(" ", "").replace(" ", "")
    m = re.search(r"-?\d+(?:[.,]\d+)?", s)
    return float(m.group(0).replace(",", ".")) if m else None


def hhmm(v) -> str | None:
    """«23:40», «2026-09-27 23:40:00», «27 сент. 2026 г., 23:40», ISO — в HH:MM."""
    v = _first(v)
    if v is None:
        return None
    m = re.search(r"(\d{1,2})[:.](\d{2})(?::\d{2})?(?!\d)", str(v).split("T")[-1] if "T" in str(v) else str(v))
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if "pm" in str(v).lower() and h < 12:
        h += 12
    return f"{h % 24:02d}:{mi:02d}" if mi < 60 else None


def _sleep_span(sleep) -> tuple[str, str] | None:
    """Сон: {bed, wake} или список интервалов [{start, end}] (как отдаёт «Анализ сна») → (лёг, встал)."""
    if isinstance(sleep, dict):
        bed, wake = hhmm(sleep.get("bed") or sleep.get("start")), hhmm(sleep.get("wake") or sleep.get("end"))
        if bed and wake:
            return bed, wake
        sleep = sleep.get("samples")
    if isinstance(sleep, list) and sleep and isinstance(sleep[0], dict):
        starts = [s.get("start") or s.get("bed") for s in sleep]
        ends = [s.get("end") or s.get("wake") for s in sleep]
        starts, ends = [str(x) for x in starts if x], [str(x) for x in ends if x]
        if starts and ends:
            bed, wake = hhmm(min(starts)), hhmm(max(ends))
            if bed and wake:
                return bed, wake
    return None


def _date(v) -> str:
    v = _first(v)
    if not v:
        return date.today().isoformat()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(v))
    if m:
        return m.group(0)
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", str(v))
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    raise HTTPException(400, "date: нужна дата YYYY-MM-DD")


def _age(uid: str) -> int | None:
    birth = userdata.profile(uid).get("birth")
    try:
        b = date.fromisoformat(birth)
    except (TypeError, ValueError):
        return None
    t = date.today()
    return t.year - b.year - ((t.month, t.day) < (b.month, b.day))


def _hr_stats(wk: dict) -> dict:
    """Пульс тренировки: готовые avg/max/min или список замеров (Команды отдают «Частоту пульса» списком)."""
    out = {}
    samples = wk.get("heart_rate") or wk.get("hr") or wk.get("hr_samples")
    if isinstance(samples, list):
        vals = [x for x in (num(v) for v in samples) if x and 30 <= x <= 230]
        if vals:
            out = {"hr_avg": round(sum(vals) / len(vals)), "hr_max": round(max(vals)), "hr_min": round(min(vals))}
    for k, keys in (("hr_avg", ("hr_avg", "avg_hr", "heart_rate_avg")), ("hr_max", ("hr_max", "max_hr", "heart_rate_max")),
                    ("hr_min", ("hr_min", "min_hr", "heart_rate_min"))):
        v = next((num(wk.get(x)) for x in keys if wk.get(x) is not None), None)
        if v and 30 <= v <= 230:
            out[k] = round(v)
    return out


def _intensity(hr_avg: float | None, age: int | None) -> str | None:
    """Средний пульс → лёгкая / средняя / высокая. Максимум по Танаке (208 − 0,7·возраст), зоны 64 % и 77 %."""
    if not hr_avg:
        return None
    hr_max = 208 - 0.7 * (age or 35)
    pct = hr_avg / hr_max
    return "low" if pct < 0.64 else "mid" if pct < 0.77 else "high"


FLOW = {"light": "light", "лёгк": "light", "легк": "light", "скуд": "light", "medium": "medium", "средн": "medium",
        "heavy": "heavy", "обильн": "heavy", "сильн": "heavy", "none": None, "нет": None}


def _import_period(uid: str, period) -> dict:
    """Дни менструации → period:{uid}:{дата} и пересчёт profile.cycle (последнее начало, длины).

    Приходит списком дат или словарей {date|start, flow}. Начало цикла — первый день после перерыва ≥ 3 дня.
    Длина цикла и месячных — медианы по всей истории, чтобы один сбившийся цикл не ломал прогноз."""
    items = period if isinstance(period, list) else [period]
    days = {}
    for it in items:
        d, flow = (it.get("date") or it.get("start"), it.get("flow") or it.get("value")) if isinstance(it, dict) else (it, None)
        try:
            day = _date(d)
        except HTTPException:
            continue
        f = next((v for k, v in FLOW.items() if k in str(flow or "").lower()), "medium")
        if f is None:
            continue
        days[day] = f
    for day, f in days.items():
        db.server_put(uid, "period", f"period:{uid}:{day}", {"flow": f, "source": "health"}, day)
    all_days = sorted(r["date"] for r in db.list_kind(uid, "period"))
    if not all_days:
        return {"days": 0}
    starts, runs, run = [all_days[0]], [], 1
    for a, b in zip(all_days, all_days[1:]):
        gap = (date.fromisoformat(b) - date.fromisoformat(a)).days
        if gap >= 3:
            starts.append(b); runs.append(run); run = 1
        else:
            run += gap
    runs.append(run)
    med = lambda xs: sorted(xs)[len(xs) // 2]
    lens = [(date.fromisoformat(b) - date.fromisoformat(a)).days for a, b in zip(starts, starts[1:])]
    lens = [x for x in lens if 18 <= x <= 50]
    prof = userdata.profile(uid)
    cyc = {**(prof.get("cycle") or {}), "enabled": True, "last_start": starts[-1], "source": "health",
           "period": max(2, min(10, med(runs)))}
    if lens:
        cyc["length"] = med(lens)
    db.server_put(uid, "profile", f"profile:{uid}", {**prof, "cycle": cyc})
    return {"days": len(days), "last_start": starts[-1], "length": cyc.get("length"), "period": cyc["period"]}


@router.post("/api/health/import")
async def health_import(request: Request):
    tok = request.headers.get("x-trainer-token") or request.query_params.get("token")
    rows = db.q("SELECT user_id FROM health_tokens WHERE token = ?", (tok or "",))
    if not tok or not rows:
        raise HTTPException(401, "Неверный токен: возьмите новый в профиле Тренера")
    uid = rows[0]["user_id"]
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Нужен JSON")
    if isinstance(body, list):
        body = body[0] if body else {}
    day = _date(body.get("date"))
    done: dict = {"date": day}
    weight_now = userdata.latest_weight(uid)

    # шаги (и активные калории) → отметка пункта чек-листа «Шаги»
    steps = num(body.get("steps"), total=True)
    kcal = num(body.get("active_kcal"), total=True)
    item = next((r for r in db.list_kind(uid, "item") if r["data"].get("target_from") == "steps"), None)
    if item and (steps is not None or kcal is not None):
        lid = f"log:{uid}:{day}:{item['id']}"
        cur = db.get(lid)
        data = {**((cur or {}).get("data") or {}), "source": "health"} if cur and not cur["deleted"] else {"source": "health"}
        if steps is not None:
            data["v"] = int(steps)
            done["steps"] = int(steps)
        if kcal is not None:
            data["active_kcal"] = round(kcal)
            done["active_kcal"] = round(kcal)
        db.server_put(uid, "log", lid, data, day)

    # сон — только если человек не внёс его сам (ручная запись точнее: там ощущения)
    span = _sleep_span(body.get("sleep"))
    if span:
        cur = db.get(f"sleep:{uid}:{day}")
        if not cur or cur["deleted"] or cur["data"].get("source") == "health":
            # ответы человека (засыпание, подъём, будильники) к импортированной ночи не затираем
            keep = cur["data"] if cur and not cur["deleted"] else {}
            db.server_put(uid, "sleep", f"sleep:{uid}:{day}", {**keep, "bed": span[0], "wake": span[1], "source": "health",
                                                                  "entered_at": keep.get("entered_at") or db.now_ms()}, day)
            done["sleep"] = {"bed": span[0], "wake": span[1]}
        else:
            done["sleep"] = "есть ручная запись — не трогаем"

    # вес — если за день его ещё нет
    w = num(body.get("weight"))
    if w and 25 <= w <= 350:
        cur = db.get(f"body:{uid}:{day}")
        if not cur or cur["deleted"] or not cur["data"].get("weight") or cur["data"].get("source") == "health":
            data = {**((cur or {}).get("data") or {}), "weight": round(w, 1), "source": "health"}
            db.server_put(uid, "body", f"body:{uid}:{day}", data, day)
            done["weight"] = round(w, 1)
            weight_now = w

    # показатели за день: пульс в покое, вариабельность (HRV), VO₂max — по ним «готовность» видит,
    # восстановился ли организм. Партнёру не видны (вид vitals не входит в PUBLIC_KINDS).
    vit = {k: v for k, v in {
        "resting_hr": num(body.get("resting_hr") or body.get("resting_heart_rate")),
        "hrv": num(body.get("hrv") or body.get("hrv_ms")),
        "vo2max": num(body.get("vo2max")),
        "walking_hr": num(body.get("walking_hr")),
    }.items() if v and v > 0}
    if vit.get("resting_hr") and not 30 <= vit["resting_hr"] <= 130:
        vit.pop("resting_hr")
    if vit.get("hrv") and not 5 <= vit["hrv"] <= 250:
        vit.pop("hrv")
    if vit:
        vid = f"vitals:{uid}:{day}"
        cur = db.get(vid)
        data = {**((cur or {}).get("data") or {}), **{k: round(v, 1) for k, v in vit.items()}, "source": "health"}
        db.server_put(uid, "vitals", vid, data, day)
        done["vitals"] = {k: round(v, 1) for k, v in vit.items()}

    # цикл: дни менструации из «Здоровья» (туда их пишет трекер цикла) → записи period + профиль
    period = body.get("period") or body.get("menstruation")
    if period:
        done["period"] = _import_period(uid, period)

    # тренировки → активности с детерминированными id; лишние от прошлого импорта удаляем
    workouts = body.get("workouts")
    if isinstance(workouts, dict):
        workouts = [workouts]
    if isinstance(workouts, list):
        age = _age(uid)
        n = 0
        for wk in workouts:
            if not isinstance(wk, dict):
                continue
            start, end = hhmm(wk.get("start")), hhmm(wk.get("end"))
            minutes = num(wk.get("minutes") or wk.get("duration"))
            if (not minutes) and start and end:
                a, b = (int(x[:2]) * 60 + int(x[3:]) for x in (start, end))
                minutes = (b - a) % 1440
            if not minutes or minutes <= 0:
                continue
            if minutes > 600:                  # пришли секунды
                minutes /= 60
            t = match_activity(wk.get("type") or wk.get("name") or "")
            kcal = num(wk.get("kcal") or wk.get("energy"))
            hr = _hr_stats(wk)
            # интенсивность по пульсу точнее, чем «на глаз»: зоны от максимального пульса по возрасту
            intensity = _intensity(hr.get("hr_avg"), age) or "mid"
            dist = num(wk.get("distance_km") or wk.get("distance"))
            if dist and dist > 300:            # пришли метры
                dist /= 1000
            n += 1
            data = {
                "type": t, "minutes": round(minutes), "intensity": intensity,
                "kcal": round(kcal) if kcal else userdata.activity_kcal(t, minutes, intensity, weight_now),
                "note": str(_first(wk.get("type") or wk.get("name") or "")) if t == "other" else "",
                "source": "health", "entered_at": db.now_ms(),
                **({"start": start} if start else {}), **({"end": end} if end else {}),
                **({"distance_km": round(dist, 2)} if dist else {}), **hr,
            }
            if hr.get("hr_avg"):
                data["intensity_from"] = "hr"
            db.server_put(uid, "activity", f"activity:health:{uid}:{day}:{n}", data, day)
        for old in db.q("SELECT id FROM records WHERE user_id = ? AND kind = 'activity' AND date = ? AND deleted = 0 AND id LIKE ?",
                        (uid, day, f"activity:health:{uid}:{day}:%")):
            if int(old["id"].rsplit(":", 1)[-1]) > n:
                rec = db.get(old["id"])
                with db.tx() as c:
                    db.put(c, {**rec, "deleted": True, "updated_at": db.now_ms()}, force=True)
        done["workouts"] = n

    return {"ok": True, "imported": done}
