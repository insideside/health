"""Приём данных из «Здоровья» iPhone через Команды iOS.

PWA не видит HealthKit, поэтому данные приносит команда на телефоне: POST с личным токеном
в заголовке `X-Trainer-Token`. Токен отдельный от сессии: его вписывают в команду один раз,
и он не даёт доступа ни к чему, кроме импорта. Импорт идемпотентен по дате — команду можно
запускать сколько угодно раз в день, записи перезапишутся, а не размножатся.
"""
import re
import secrets
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse

from . import certs, db, shortcut, userdata, wan
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
    "traditional strength training": "gym_strength", "functional strength training": "functional_training",
    "силовая тренировка": "gym_strength", "функциональная силовая тренировка": "functional_training",
    "традиционная силовая тренировка": "gym_strength", "hiit": "hiit",
    "высокоинтенсивная интервальная тренировка": "hiit", "cross training": "functional_training",
    "core training": "functional_training", "jump rope": "jump_rope", "скакалка": "jump_rope",
    "fast walking": "walk_fast", "быстрая ходьба": "walk_fast", "indoor cycle": "stationary_bike",
    "велотренажер": "stationary_bike", "water fitness": "aqua_aerobics", "paddle sports": "sup",
    "surfing sports": "surfing", "badminton": "badminton", "table tennis": "table_tennis",
    "volleyball": "volleyball", "basketball": "basketball", "squash": "squash", "step training": "step_aerobics",
    "equestrian sports": "horse_riding", "skating sports": "ice_skating", "barre": "barre", "tai chi": "tai_chi",
    "elliptical": "elliptical_trainer", "эллипс": "elliptical_trainer", "rowing": "indoor_rowing", "гребля": "rowing",
    "stair climbing": "stairs", "лестница": "stairs", "stairs": "stairs",
    "tennis": "tennis", "теннис": "tennis", "football": "football", "soccer": "football", "футбол": "football",
    "gymnastics": "gymnastics", "гимнастика": "gymnastics", "climbing": "climbing", "скалолазание": "climbing",
    "martial arts": "martial_arts", "боевые искусства": "martial_arts", "boxing": "boxing", "бокс": "boxing",
    "skating": "ice_skating", "коньки": "ice_skating", "cooldown": "stretching", "flexibility": "stretching",
    "растяжка": "stretching", "гибкость": "stretching", "mind and body": "yoga", "other": "other", "другое": "other",
    # виды Apple Watch, для которых теперь есть свои записи в справочнике
    "kickboxing": "boxing", "кикбоксинг": "boxing", "wrestling": "wrestling", "борьба": "wrestling",
    "fencing": "fencing", "фехтование": "fencing", "hockey": "hockey", "хоккей": "hockey",
    "handball": "handball", "гандбол": "handball", "rugby": "rugby", "регби": "rugby",
    "american football": "american_football", "baseball": "baseball", "softball": "baseball", "cricket": "cricket",
    "golf": "golf", "гольф": "golf", "bowling": "bowling", "боулинг": "bowling", "curling": "curling", "кёрлинг": "curling",
    "water polo": "water_polo", "водное поло": "water_polo", "sailing": "sailing", "парусный спорт": "sailing",
    "paddle sports": "sup", "surfing sports": "surfing", "water sports": "swimming_outdoor",
    "pickleball": "padel", "disc sports": "frisbee", "gymnastics": "gymnastics",
    "track and field": "running", "lacrosse": "floorball", "mixed cardio": "hiit", "cardio dance": "dance",
    "social dance": "dance", "cooldown": "stretching", "preparation and recovery": "stretching",
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


def num(v, total: bool = False, grouped: bool | None = False) -> float | None:
    """Число из «1 234,5», «72,4 кг», ["3000","4500"] (total — сложить список, как шаги по часам).

    Список, вставленный в текст, Команды склеивают переводами строк: «3000\n4500» — тоже список.
    grouped — в английской локали «8,234» это тысячи: True — всегда (целые, как шаги),
    None — только если иначе вышло бы меньше 10 (активные ккал: «412,5» по-русски — дробь)."""
    if isinstance(v, str) and len([x for x in re.split(r"[\r\n]+", v) if x.strip()]) > 1:
        v = [x for x in re.split(r"[\r\n]+", v) if x.strip()]
    if isinstance(v, list):
        vals = [x for x in (num(i, grouped=grouped) for i in v) if x is not None]
        if not vals:
            return None
        return sum(vals) if total else vals[-1]
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[\s\u00a0\u202f\u2009]", "", str(v))
    if re.search(r"\d,\d+\.\d|\d\.\d+,\d", s):   # «1,234.5» / «1.234,5»: дробная часть после последнего знака
        s = s.replace(",", "") if s.rfind(".") > s.rfind(",") else s.replace(".", "").replace(",", ".")
    elif grouped is not False and re.search(r"(?<![\d,])\d{1,3}(?:,\d{3})+(?![\d,])", s):
        plain = num(s)
        if grouped or (plain is not None and abs(plain) < 10):
            s = s.replace(",", "")
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


def _dt(v) -> datetime | None:
    """ISO-дата со временем → местное время этого компьютера (со смещением пересчитываем, без — как есть)."""
    try:
        d = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.astimezone().replace(tzinfo=None) if d.tzinfo else d


SLEEP_SKIP = ("in bed", "inbed", "в постели", "awake", "бодрств", "не спал")


def _sleep_lines(lines: list[str], day: str | None) -> tuple[str, str] | None:
    """Готовая команда шлёт фазы сна строками «начало;конец;фаза» за двое суток → ночь, закончившаяся в day.

    Фазы «В постели» и «Бодрствование» не сон (если есть настоящие фазы). Фазы с разрывом до 2 ч — одна ночь;
    из ночей, закончившихся в этот день, берём самую длинную (дневной сон не собьёт время отхода ко сну)."""
    rows = []
    for line in lines:
        parts = [p.strip() for p in str(line).split(";")]
        if len(parts) < 2:
            continue
        a, b = _dt(parts[0]), _dt(parts[1])
        if a and b and b > a:
            rows.append((a, b, (parts[2] if len(parts) > 2 else "").lower()))
    use = [r for r in rows if not any(k in r[2] for k in SLEEP_SKIP)] or rows
    if not use:
        return None
    nights: list[list] = []
    for a, b, _ in sorted(use):
        if nights and a - nights[-1][1] <= timedelta(hours=2):
            nights[-1][1] = max(nights[-1][1], b)
            nights[-1][2] += b - a
        else:
            nights.append([a, b, b - a])
    try:
        target = date.fromisoformat(day) if day else date.today()
    except ValueError:
        target = date.today()
    ended = [n for n in nights if n[1].date() == target]
    if not ended:
        return None
    a, b, _ = max(ended, key=lambda n: n[2])
    return f"{a:%H:%M}", f"{b:%H:%M}"


def _sleep_span(sleep, day: str | None = None) -> tuple[str, str] | None:
    """Сон: {bed, wake}, список интервалов [{start, end}] (как отдаёт «Анализ сна»)
    или текст «начало;конец;фаза» построчно (готовая команда) → (лёг, встал)."""
    if isinstance(sleep, str) or (isinstance(sleep, list) and sleep and all(isinstance(x, str) for x in sleep)):
        text = sleep if isinstance(sleep, str) else "\n".join(sleep)
        return _sleep_lines([x for x in re.split(r"[\r\n]+", text) if x.strip()], day)
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
    steps = num(body.get("steps"), total=True, grouped=True)
    kcal = num(body.get("active_kcal"), total=True, grouped=None)
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
    span = _sleep_span(body.get("sleep"), day)
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

    # вес — если за день его ещё нет. weight_date — день замера (готовая команда шлёт последний
    # замер за 30 дней): старое взвешивание не выдаём за сегодняшнее
    w = num(body.get("weight"))
    wday = day
    wd = re.search(r"\d{4}-\d{2}-\d{2}", str(_first(body.get("weight_date")) or ""))
    if wd:
        wday = min(wd.group(0), day)
    if w and 25 <= w <= 350:
        cur = db.get(f"body:{uid}:{wday}")
        if not cur or cur["deleted"] or not cur["data"].get("weight") or cur["data"].get("source") == "health":
            data = {**((cur or {}).get("data") or {}), "weight": round(w, 1), "source": "health"}
            db.server_put(uid, "body", f"body:{uid}:{wday}", data, wday)
            done["weight"] = round(w, 1)
            if wday != day:
                done["weight_date"] = wday
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

    if request.query_params.get("reply") == "text":        # готовая команда показывает ответ уведомлением
        return PlainTextResponse(summary(done))
    return {"ok": True, "imported": done}


def summary(done: dict) -> str:
    """Что записалось, одной строкой для уведомления на iPhone (без длинного тире)."""
    parts = []
    if "steps" in done:
        parts.append(f"шаги {done['steps']}")
    if done.get("active_kcal"):
        parts.append(f"активные {done['active_kcal']} ккал")
    sl = done.get("sleep")
    if isinstance(sl, dict):
        parts.append(f"сон {sl['bed']}-{sl['wake']}")
    elif sl:
        parts.append("сон не тронут: есть ручная запись")
    if "weight" in done:
        wd = done.get("weight_date")
        parts.append(f"вес {str(done['weight']).replace('.', ',')} кг" + (f" (от {wd[8:10]}.{wd[5:7]})" if wd else ""))
    vit = done.get("vitals") or {}
    if vit.get("resting_hr"):
        parts.append(f"пульс покоя {round(vit['resting_hr'])}")
    if vit.get("hrv"):
        parts.append(f"ВСР {round(vit['hrv'])} мс")
    if done.get("workouts"):
        parts.append(f"тренировок {done['workouts']}")
    d = done.get("date", "")
    head = f"Тренер получил за {d[8:10]}.{d[5:7]}" if len(d) == 10 else "Тренер получил"
    if not parts:
        return head + ": новых данных нет. Проверьте, что команде разрешено читать «Здоровье»."
    return head + ": " + ", ".join(parts) + "."


# ── готовая команда «Тренер: Здоровье» ──

_signed: dict[tuple[str, str], bytes] = {}      # подпись идёт ~10 с и через серверы Apple: не повторяем
NO_SIGN = ("Готовую команду подписывает утилита shortcuts, а она есть только на Mac (macOS 12 и новее). "
           "Соберите команду вручную по инструкции: Профиль, раздел «Здоровье iPhone».")


def import_url(request: Request) -> str:
    """Адрес импорта, как его видит iPhone: тот же, с которого открыт Тренер. С localhost телефон
    сервер не найдёт, поэтому тогда берём имя компьютера в сети (`<имя>.local`) и HTTPS-порт."""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc).split(",")[0].strip()
    if host.rsplit(":", 1)[0] in wan.LOCAL_HOSTS:
        name = certs.mdns_name()
        if name:
            proto, host = "https", f"{name}:{wan.HTTPS_PORT}"
    return f"{proto}://{host}/api/health/import"


@router.get("/api/health/shortcut")
def get_shortcut(request: Request, u=Depends(current_user)):
    """Подписанная команда с адресом импорта и личным токеном. Подпись «для всех» делает только macOS."""
    url, tok = import_url(request), token_for(u["id"])
    data = _signed.get((url, tok))
    if data is None:
        if not shortcut.available():
            raise HTTPException(501, NO_SIGN)
        data = shortcut.sign(shortcut.build(url, tok))
        if not data:
            err = shortcut.sign.last_error
            raise HTTPException(501, "Не удалось подписать команду" + (f" ({err[:200]})" if err else "")
                                + ". Подписи нужен интернет на компьютере. Или соберите команду вручную: "
                                  "Профиль, раздел «Здоровье iPhone».")
        if len(_signed) > 32:
            _signed.clear()
        _signed[(url, tok)] = data
    return Response(data, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename=\"Trener-Zdorovye.shortcut\"; filename*=UTF-8''"
                               "%D0%A2%D1%80%D0%B5%D0%BD%D0%B5%D1%80%20%D0%97%D0%B4%D0%BE%D1%80%D0%BE%D0%B2%D1%8C%D0%B5.shortcut",
        "Cache-Control": "no-store"})
