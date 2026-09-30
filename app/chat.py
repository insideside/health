"""Чат с тренером: ответ ИИ с предложенными действиями и их выполнение на сервере.

Модель только предлагает действия (кнопки), выполняет их сервер и только после нажатия:
так ИИ не может сам ничего поменять в плане, а сервер проверяет, что действие действительно
было предложено в этом сообщении и ещё не выполнено. Все изменения - обычные записи,
клиент получает их синхронизацией.
"""
import re
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from . import db, food, norms, userdata
from .ai import jobs
from .ai.jobs import (DAYTYPE_LABEL, SLEEPY_LABEL, SORENESS_LABEL, STRESS_LABEL, WEEKDAYS, WELLBEING_LABEL, goals_text,
                      person_text, sleep_hours_of, snooze_min, system_for)
from .ai.ollama import AIError, ask_json
from .health import match_activity

router = APIRouter()

HISTORY = 12
ACTION_KINDS = ("skip_today", "move_workout", "lighten_today", "swap_exercise", "recalc_norms", "set_macros", "rebuild_program",
                "set_daytype", "add_injury", "set_pace", "log_food", "log_activity")
DAYTYPES = ("cheat", "special", "sick", "rest")
INJURY_ZONES = ("chest", "shoulders", "arms", "back", "abs", "sides", "glutes", "legs", "neck",
                "knees", "lower_back", "wrists", "ankles", "hips")
MEALS = ("breakfast", "lunch", "dinner", "snack")
WEEKDAY_ACC = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"]

CHAT_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "actions": {"type": "array", "items": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": list(ACTION_KINDS)},
            "label": {"type": "string"},
            "params": {"type": "object", "properties": {
                "date": {"type": "string"}, "from": {"type": "string"}, "to": {"type": "string"},
                "type": {"type": "string"}, "zone": {"type": "string"}, "note": {"type": "string"},
                "pace": {"type": "string"}, "text": {"type": "string"}, "meal": {"type": "string"},
                "minutes": {"type": "number"}, "intensity": {"type": "string"},
                "kcal": {"type": "number"}, "p": {"type": "number"}, "f": {"type": "number"}, "c": {"type": "number"}}},
        }, "required": ["kind", "label", "params"]}},
    },
    "required": ["reply", "actions"],
}
REPLY_MAX = 900

STYLE = """Это чат в мессенджере. Отвечай как живой тренер, который знает клиента: коротко, 1–4 предложения,
по сути вопроса, со ссылкой на его реальные цифры, если они к месту. Без списков и заголовков, если сам не просит план.
Не начинай с «Отличный вопрос», «Конечно!», «Понимаю», «Как ИИ…», не повторяй вопрос, не подводи итоги в конце,
без канцелярита и без смайликов (максимум один, если очень к месту). Не знаешь - так и скажи, не выдумывай.
Обращайся на «ты» - всегда, без исключений и без соскальзывания на «вы» в середине ответа.
Пиши нормальными связными предложениями, не нанизывай через тире одно короткое утверждение за другим
(«калорий мало - добавь белка - и высыпайся» ты никогда не скажешь вслух) - если нужно перечислить несколько
вещей, соедини их по смыслу или сделай отдельными предложениями, как в живой речи, а не списком через тире.
Пиши обычной разговорной речью, как в переписке с человеком, а не готовыми шаблонами и не заезженными канцелярскими
оборотами («жми кнопку - сделаю», «выполнено», «данные обработаны» и т. п.) - если фраза не встраивается по смыслу
и грамматике в остальной ответ (например ты советуешь оставить всё как есть, но всё равно зовёшь «жать кнопку») -
не пиши её вообще, лучше просто ответь по сути своими словами.
Про лекарства, боли и болезни - без диагнозов: при сильной, острой или непроходящей боли - к врачу.
Если клиент жалуется на боль, травму или болезнь - никаких подколок и упрёков в любом тоне: коротко, по-человечески,
с заботой; предложи записать травму (add_injury) и облегчить или перенести тренировку."""

ACTIONS_HELP = """actions - кнопки, которые клиент может нажать. Предлагай 0–2, ТОЛЬКО если они прямо помогают по теме
разговора; обычный вопрос-ответ - actions пустой. Действие выполнится только после нажатия. Виды и params:
- skip_today {date} - не тренироваться в этот день: тренировка переносится на ближайший свободный день, день отмечается отдыхом;
- move_workout {from, to} - перенести тренировку с даты на дату;
- lighten_today {date} - облегчить тренировку дня (меньше подходов, дольше отдых);
- swap_exercise {date, from, to} - заменить ОДНО упражнение (from, to - id; to - только из списка «можно на замену»);
  просят поменять несколько упражнений или весь день - не перечисляй несколько swap_exercise и не пиши id в ответе,
  предложи rebuild_program с note (опиши в note, что именно поменять);
- recalc_norms {} - пересчитать нормы ЗАНОВО ПО ФОРМУЛАМ (цифры не меняет по просьбе, только после изменений в профиле);
- set_macros {kcal?, p?, f?, c?} - поставить свои цифры, о которых договорились («углеводы до 200» → {c: 200});
  указывай только то, что меняем; калории пересчитаются сами (минус 4 ккал на каждый убранный грамм углеводов);
- rebuild_program {note?} - пересобрать будущий план тренировок; note - коротко перескажи, что учесть при пересборке
  (акценты по зонам, что убрать/оставить, предпочтения по кардио и т. п. - из того, что клиент только что описал),
  иначе пересборка о разговоре ничего не узнает и придумает своё;
- set_daytype {date, type} - тип дня: cheat (читмил), special (особый), sick (болею), rest (отдых);
- add_injury {zone, note} - записать, что болит; zone: chest, shoulders, arms, back, abs, sides, glutes, legs, neck,
  knees, lower_back, wrists, ankles, hips;
- set_pace {pace} - темп: slower, normal, faster (пересчитает нормы и план);
- log_food {text, meal} - записать еду как написал клиент; meal: breakfast, lunch, dinner, snack;
- log_activity {type, minutes, intensity} - записать активность; type - id из списка активностей; intensity: low, mid, high.
Даты - YYYY-MM-DD. label - коротко на кнопке, 2–5 слов («Перенести на четверг»).
Ты сам ничего не делаешь, пока не нажата кнопка - не пиши так, будто уже записал, перенёс или заменил. Но и не
подставляй в каждый ответ одну и ту же фразу «жми - сделаю»: предложи действие обычными словами, как в разговоре
(«Давай запишу», «Могу перенести на четверг», «Если хочешь, заменю на планку») - своими, а не по шаблону, и только
там, где кнопка действительно что-то делает: если ты советуешь ничего не менять, никакую кнопку жать не зови.
Просит записать еду или активность - обязательно предложи log_food / log_activity.
Служебные id (из каталога упражнений, «можно на замену» и т. п.) - только внутри params действий, их не видит
человек, которому ты отвечаешь. В тексте ответа называй упражнения обычными русскими названиями, никогда не id.
Имена действий и параметров (rebuild_program, note, from, to, params и т. п.) в тексте тоже не пиши: что учесть, ты
кладёшь в note кнопки, а человеку своими словами говоришь, что поменяешь («Пересоберу: верх и кор, ноги уберу,
кардио на эллипсе»)."""


# ── контекст ──

def _context(uid: str) -> str:
    today = date.today()
    a = (today - timedelta(days=6)).isoformat()
    t = (userdata.latest_target(uid) or {}).get("data") or {}
    goal = userdata.goal(uid)
    by = lambda kind, d1, d2: {r["date"]: r["data"] for r in db.list_kind(uid, kind, d1, d2)}  # noqa: E731
    dsum, sleep, state = by("dsum", a, today.isoformat()), by("sleep", a, today.isoformat()), by("state", a, today.isoformat())
    dtype = by("daytype", a, (today + timedelta(days=7)).isoformat())
    wos = by("workout", a, (today + timedelta(days=7)).isoformat())
    acts: dict[str, list] = {}
    for r in db.list_kind(uid, "activity", a, today.isoformat()):
        acts.setdefault(r["date"], []).append(f"{userdata.activity_name(r['data'].get('type') or 'other')} {r['data'].get('minutes') or 0} мин")
    foods: dict[str, list] = {}
    for r in db.list_kind(uid, "food", a, today.isoformat()):
        foods.setdefault(r["date"], []).append(r["data"].get("totals") or {})
    lines = []
    for i in range(7):
        d = (today - timedelta(days=6 - i)).isoformat()
        parts = [f"{d} {WEEKDAYS[(today.weekday() - 6 + i) % 7]}"]
        if d in dtype:
            parts.append(f"тип дня: {DAYTYPE_LABEL.get(dtype[d].get('type'), dtype[d].get('type'))}")
        if d in dsum:
            parts.append(f"чек-лист {dsum[d].get('pct', 0)}%" + (f", оценка {dsum[d]['grade']}" if dsum[d].get("grade") else ""))
        if d in sleep:
            sz = snooze_min(sleep[d])
            parts.append(f"сон {sleep_hours_of(sleep[d]) or '?'} ч" + (f" (из них {sz} мин дрёмы после будильника)" if sz else ""))
        if d in state:
            s = state[d]
            parts.append("самочувствие: " + ", ".join(filter(None, (WELLBEING_LABEL.get(s.get("wellbeing")),
                                                               SORENESS_LABEL.get(s.get("soreness")),
                                                               STRESS_LABEL.get(s.get("stress")),
                                                               SLEEPY_LABEL.get(s.get("sleepy"))))))
        if d in wos:
            w = wos[d]
            parts.append(f"тренировка «{w.get('title')}» {'сделана' if w.get('done') else 'не отмечена'}"
                         + (f" ({w['variant']})" if w.get("variant") not in (None, "full") else ""))
        if d in acts:
            parts.append("активности: " + ", ".join(acts[d]))
        if d in foods:
            k = sum(x.get("kcal") or 0 for x in foods[d])
            p = sum(x.get("p") or 0 for x in foods[d])
            parts.append(f"еда {round(k)} ккал, белок {round(p)} г")
        lines.append("; ".join(parts))
    upcoming = [f"{d} {WEEKDAYS[date.fromisoformat(d).weekday()]}: «{w.get('title')}»"
                for d, w in sorted(wos.items()) if d > today.isoformat()]
    tw = wos.get(today.isoformat())
    today_wo = "нет"
    swap = ""
    if tw:
        today_wo = f"«{tw.get('title')}»: " + ", ".join(
            f"{x.get('name')} [{x.get('id')}, для from] {x.get('sets')}×{x.get('reps')}" for x in tw.get("exercises") or [])
        prof = userdata.profile(uid)
        place = next((p["data"].get("place") for p in db.list_kind(uid, "program") if p["data"].get("active")), "home")
        excl = jobs.excluded_codes(uid, prof)
        cat = jobs.allowed_exercises(place, prof.get("equipment") or ["mat", "dumbbells", "chair", "ab_wheel"], excl)
        have = {x.get("id") for x in tw.get("exercises") or []}
        by_id = {e["id"]: e for e in db.exercises()}
        pats = {(by_id.get(i) or {}).get("pattern") for i in have}
        cand = [e for e in cat if e.get("pattern") in pats and e["id"] not in have][:25]
        swap = ("\nМожно на замену, для to в swap_exercise (название [id], id клиенту не показывай): "
                + "; ".join(f"{e['name']} [{e['id']}]" for e in cand))
    free = [d for d in ((today + timedelta(days=i)).isoformat() for i in range(1, 5)) if d not in wos]
    acts_cat = ", ".join(f"{a['id']} ({a.get('name')})" for a in db.activities()) or "walking, running, cycling, swimming, other"
    injuries = userdata.open_injuries(uid)
    return f"""{_cardio_line(uid)}
Сегодня {today.isoformat()}, {WEEKDAYS[today.weekday()]}, {datetime.now():%H:%M}.
Клиент: {person_text(uid)}. Цели: {goals_text(goal)}.
Нормы: {t.get('kcal', '-')} ккал, Б {t.get('p', '-')} / Ж {t.get('f', '-')} / У {t.get('c', '-')} г, вода {t.get('water_glasses', '-')} стак.,
шаги {t.get('steps_manual') or t.get('steps', '-')}, сон {t.get('sleep_hours', '-')} ч, темп: {(t.get('intensity') or {}).get('label', '-')}.
Травмы: {'; '.join(f"{i.get('zone')} {i.get('note') or ''} с {i.get('since')}" for i in injuries) or 'нет'}.
Последние 7 дней:
{chr(10).join(lines)}
Тренировка сегодня: {today_wo}{swap}
Ближайшие тренировки: {'; '.join(upcoming) or 'нет'}
Свободные для переноса дни: {', '.join(f"{d} {WEEKDAYS[date.fromisoformat(d).weekday()]}" for d in free) or 'нет'}
Виды активностей (id): {acts_cat}"""


def _cardio_line(uid: str) -> str:
    """Любимое кардио, чего нет в зале и постоянные занятия вне программы - иначе модель путает, например,
    эллипс в зале с велосипедом, который в профиле как прогулочная активность."""
    prof = userdata.profile(uid)
    likes = [userdata.activity_name(x) for x in (prof.get("cardio") or {}).get("likes") or [] if isinstance(x, str)]
    missing = [jobs.EQUIP_LABEL.get(x, x) for x in (prof.get("gym_equipment") or {}).get("missing") or []]
    regular = [f"{userdata.activity_name(a.get('type') or 'other')} {a.get('per_week') or 1} раз/нед по {a.get('minutes') or 0} мин"
               for a in prof.get("activities") or [] if isinstance(a, dict)]
    out = []
    if likes:
        out.append("Любимое кардио клиента: " + ", ".join(likes) + ". Кардио в плане и в ответах - из этого списка, не подменяй другим.")
    if missing:
        out.append("В зале клиента НЕТ: " + ", ".join(missing) + " - не предлагай упражнения на этом.")
    if regular:
        out.append("Постоянные занятия вне программы (это не кардио в зале, не путай с ним): " + "; ".join(regular) + ".")
    return "\n".join(out)


def _history(uid: str, exclude: str) -> list[dict]:
    rows = [r for r in db.list_kind(uid, "chat") if r["id"] != exclude and r["data"].get("text")]
    rows.sort(key=lambda r: r["data"].get("created") or r["updated_at"])
    out = []
    for r in rows[-HISTORY:]:
        role = "user" if r["data"].get("role") == "user" else "assistant"
        out.append({"role": role, "content": r["data"]["text"]})
    return out


def _clean_actions(raw: list, uid: str) -> list[dict]:
    """Проверить предложенное моделью: вид, обязательные параметры, даты. Непонятное - выбросить."""
    out = []
    today = date.today().isoformat()
    for a in raw or []:
        k, p = a.get("kind"), {kk: v for kk, v in (a.get("params") or {}).items() if v not in (None, "")}
        if k not in ACTION_KINDS:
            continue
        for key in (("date",) if k == "swap_exercise" else ("date", "from", "to")):
            if key in p:
                try:
                    date.fromisoformat(str(p[key]))
                except ValueError:
                    p.pop(key, None)
        if k in ("skip_today", "lighten_today", "set_daytype"):
            p.setdefault("date", today)
        if k == "move_workout":
            p.setdefault("from", today)
            # модель не всегда видит, что день занят: переносим на ближайший свободный
            if "to" not in p or _wo(uid, p["to"]) or p["to"] <= p["from"]:
                free = _free_day(uid, p["from"], 4)
                if not free:
                    continue
                p["to"] = free
                a = {**a, "label": "Перенести на " + WEEKDAY_ACC[date.fromisoformat(free).weekday()]}
        if k == "swap_exercise" and not (p.get("from") and p.get("to")):
            continue
        if k == "set_daytype" and p.get("type") not in DAYTYPES:
            continue
        if k == "add_injury" and p.get("zone") not in INJURY_ZONES:
            continue
        if k == "set_pace" and p.get("pace") not in norms.PACE_LEVEL:
            continue
        if k == "log_food":
            if not p.get("text"):
                continue
            if p.get("meal") not in MEALS:
                p["meal"] = "snack"
        if k == "log_activity":
            if not p.get("minutes"):
                continue
            p["type"] = p.get("type") if userdata.activity_info(p.get("type") or "") else match_activity(p.get("type") or "")
            if p.get("intensity") not in ("low", "mid", "high"):
                p["intensity"] = "mid"
        out.append({"id": uuid.uuid4().hex[:8], "kind": k, "label": (a.get("label") or k)[:40],
                    "params": p, "status": "offered"})
    return out[:3]


def _guess_meal(text: str) -> str:
    t = text.lower()
    for key, meal in (("завтрак", "breakfast"), ("обед", "lunch"), ("ужин", "dinner"), ("перекус", "snack")):
        if key in t:
            return meal
    h = datetime.now().hour
    return "breakfast" if h < 11 else "lunch" if h < 16 else "dinner" if h >= 18 else "snack"


# служебное, что модель всё же вписала в текст: «с note: «…»», «(note: …)», длинное тире
_PARAM_RE = re.compile(r"\s*(?:\(\s*)?(?:с\s+)?\b(?:note|params|from|to|reason)\s*[:=]\s*(?:«[^»]*»|\"[^\"]*\"|[^.,;)\n]*)\)?", re.I)


def _humanize(reply: str) -> str:
    reply = _PARAM_RE.sub("", reply)
    reply = re.sub(r"\s*[—–]\s*", " - ", reply)
    return re.sub(r"[ \t]{2,}", " ", reply).replace(" .", ".").strip()


async def job_chat(uid: str, inp: dict) -> dict:
    msg = db.get(inp["message_id"])
    if msg and msg["user_id"] != uid:
        raise AIError("Сообщение не найдено")
    text = inp.get("text") or (msg or {}).get("data", {}).get("text") or ""
    system = (system_for(uid, "Ты личный тренер и помощник по здоровью в приложении «Тренер»: питание, тренировки, сон, "
                              "восстановление, мотивация.") + "\n\n" + STYLE + "\n\n" + ACTIONS_HELP +
              "\n\nДанные клиента (используй, когда к месту):\n" + _context(uid))
    # think=True: иначе модель рассуждает прямо в поле reply
    out = await ask_json(system, text, CHAT_SCHEMA, temperature=0.7, think=True, history=_history(uid, inp["message_id"]))
    reply = (out.get("reply") or "").strip()
    if len(reply) > REPLY_MAX:
        # модель слила рассуждения в ответ - берём последний абзац (обычно это и есть ответ)
        reply = reply.split("\n\n")[-1].strip().strip('"«»')[:REPLY_MAX]
    reply = _humanize(reply)
    if not reply:
        raise AIError("Модель промолчала - спросите ещё раз")
    actions = _clean_actions(out.get("actions"), uid)
    # модель иногда отвечает «записал», не предложив кнопку: если просили записать еду - добавляем её сами
    if re.search(r"запиш|записа|внес", text, re.I) and not any(a["kind"] == "log_food" for a in actions):
        idx = food.Index()
        # берём только утвердительные фразы с продуктами, без вопросов и «запиши»
        parts = [p for p in re.split(r"(?<=[.!?])\s+", text) if not p.strip().endswith("?")]
        parts = [re.sub(r"(?i)[,.!]?\s*(пожалуйста|запиши(те)?|записать|внеси)\b[,.!]?", " ", p).strip(" ,.!") for p in parts]
        parts = [p for p in parts if any(idx.match(w) for w in re.findall(r"[а-яё]{4,}", p.lower()))]
        if parts:
            actions.append({"id": uuid.uuid4().hex[:8], "kind": "log_food", "label": "Записать еду",
                            "params": {"text": ", ".join(parts), "meal": _guess_meal(text)}, "status": "offered"})
            if re.search(r"(?i)записал|записан", reply):
                reply = (re.sub(r"(?i)[^.!?]*записа[лн][^.!?]*[.!?]?\s*", "", reply).strip() + " Жми кнопку - запишу.").strip()
    rec_id = uuid.uuid4().hex
    db.server_put(uid, "chat", rec_id, {"role": "coach", "text": reply, "created": db.now_ms(), "source": "ai",
                                        "reply_to": inp["message_id"], "actions": actions},
                  date.today().isoformat())
    return {"record_id": rec_id}


jobs.HANDLERS["chat"] = job_chat


@router.post("/api/chat")
async def chat_post(request: Request, u=Depends(userdata.current_user)):
    body = await request.json()
    uid = u["id"]
    text = (body.get("text") or "").strip()
    mid = body.get("message_id")
    if mid:
        # клиент сам пишет запись сообщения (и синхронизирует её) - второй не создаём, текст берём из запроса
        rec = db.get(mid)
        if rec and rec["user_id"] != uid:
            raise HTTPException(403, "чужое сообщение")
        if not text and rec:
            text = rec["data"].get("text") or ""
        if not text:
            raise HTTPException(400, "Пустое сообщение")
    else:
        if not text:
            raise HTTPException(400, "Пустое сообщение")
        mid = uuid.uuid4().hex
        db.server_put(uid, "chat", mid, {"role": "user", "text": text[:2000], "created": db.now_ms(), "source": "user"},
                      date.today().isoformat())
    if userdata.ai_mode(uid) == "off":
        raise HTTPException(403, "ИИ выключена в профиле - работают быстрые кнопки чата")
    await jobs.ai_state()
    return {"job_id": jobs.submit(uid, "chat", {"message_id": mid, "text": text[:2000]}), "message_id": mid,
            "waiting": jobs.waiting()}


# ── выполнение действий ──

def _wo(uid: str, d: str) -> dict | None:
    r = db.get(f"wo:{uid}:{d}")
    return r if r and not r["deleted"] else None


def _free_day(uid: str, frm: str, days: int = 3) -> str | None:
    base = date.fromisoformat(frm)
    for i in range(1, days + 1):
        d = (base + timedelta(days=i)).isoformat()
        dt = db.get(f"daytype:{uid}:{d}")
        if not _wo(uid, d) and not (dt and not dt["deleted"] and dt["data"].get("type") in ("sick", "rest")):
            return d
    return None


def _move(uid: str, frm: str, to: str) -> str:
    w = _wo(uid, frm)
    if not w:
        raise HTTPException(400, f"На {frm} нет тренировки")
    if any(x.get("log") for x in w["data"].get("exercises") or []):
        raise HTTPException(400, "В этой тренировке уже есть отметки подходов - переносить поздно")
    if _wo(uid, to):
        raise HTTPException(409, f"На {to} уже стоит тренировка")
    d = dict(w["data"])
    exercises = d.pop("orig_exercises", None) or d.get("exercises") or []
    db.server_put(uid, "workout", f"wo:{uid}:{to}", {**d, "exercises": exercises, "variant": "full", "moved_from": frm}, to)
    with db.tx() as c:
        db.put(c, {**w, "data": {**w["data"], "moved_to": to}, "deleted": True, "updated_at": db.now_ms()}, force=True)
    t = date.fromisoformat(to)
    return f"Тренировка перенесена на {WEEKDAY_ACC[t.weekday()]}, {t:%d.%m}"


def _set_daytype(uid: str, d: str, t: str, note: str = "") -> None:
    db.server_put(uid, "daytype", f"daytype:{uid}:{d}", {"type": t, "note": note}, d)


def _recalc(uid: str, pace: str | None = None) -> str:
    try:
        tid, data = norms.recalc_for(uid, pace=pace)
    except norms.MissingData as e:
        raise HTTPException(400, str(e))
    return f"Нормы пересчитаны: {data['kcal']} ккал, белок {data['p']} г"


def _has_program(uid: str) -> bool:
    return any(p["data"].get("active") for p in db.list_kind(uid, "program"))


async def execute(uid: str, kind: str, p: dict) -> dict:
    today = date.today().isoformat()
    if kind == "skip_today":
        d = p.get("date") or today
        _set_daytype(uid, d, "rest", "по просьбе в чате")
        if not _wo(uid, d):
            return {"text": "День отмечен отдыхом"}
        to = _free_day(uid, d)
        if to:
            return {"text": _move(uid, d, to) + ", день отмечен отдыхом", "to": to}
        w = _wo(uid, d)
        db.server_put(uid, "workout", w["id"], {**w["data"], "skipped": True}, d)
        return {"text": "Ближайшие дни заняты - тренировка пропущена, день отмечен отдыхом"}
    if kind == "move_workout":
        to = p.get("to") or _free_day(uid, p.get("from") or today)
        if not to:
            raise HTTPException(409, "Нет свободного дня в ближайшие три дня")
        return {"text": _move(uid, p.get("from") or today, to), "to": to}
    if kind == "lighten_today":
        d = p.get("date") or today
        w = _wo(uid, d)
        if not w:
            raise HTTPException(400, f"На {d} нет тренировки")
        data = dict(w["data"])
        orig = data.get("orig_exercises") or data.get("exercises") or []
        cur = data.get("exercises") or []
        data["orig_exercises"] = orig
        data["exercises"] = [{**x, "sets": max(1, round(x.get("sets", 3) * 0.6)),
                              "rest_sec": round((x.get("rest_sec") or 60) * 1.3),
                              "log": (cur[i].get("log") if i < len(cur) else []) or []} for i, x in enumerate(orig)]
        data["variant"] = "light"
        db.server_put(uid, "workout", w["id"], data, d)
        return {"text": "Тренировка облегчена: меньше подходов, дольше отдых"}
    if kind == "swap_exercise":
        d = p.get("date") or today
        w = _wo(uid, d)
        if not w:
            raise HTTPException(400, f"На {d} нет тренировки")
        prof = userdata.profile(uid)
        new = next((e for e in db.exercises() if e["id"] == p.get("to")), None)
        if not new:
            raise HTTPException(400, "Такого упражнения нет в каталоге")
        if set(new.get("contraindications") or []) & jobs.excluded_codes(uid, prof):
            raise HTTPException(400, "Это упражнение противопоказано при ваших ограничениях")
        data = dict(w["data"])
        if any(x.get("id") == new["id"] for x in data.get("exercises") or []):
            raise HTTPException(400, f"«{new['name']}» уже есть в этой тренировке")
        hit = False
        for key in ("exercises", "orig_exercises"):
            if data.get(key):
                lst = []
                for x in data[key]:
                    if x.get("id") == p.get("from"):
                        x = {**x, "id": new["id"], "name": new["name"], "unit": new["unit"],
                             "per_side": new.get("per_side", False), "log": [], "note": ""}
                        hit = True
                    lst.append(x)
                data[key] = lst
        if not hit:
            raise HTTPException(400, "Этого упражнения нет в тренировке")
        db.server_put(uid, "workout", w["id"], data, d)
        return {"text": f"Заменили на «{new['name']}»"}
    if kind == "recalc_norms":
        return {"text": _recalc(uid)}
    if kind == "set_macros":
        fields = {k: p[k] for k in ("kcal", "p", "f", "c") if isinstance(p.get(k), (int, float)) and p[k] > 0}
        if not fields:
            raise HTTPException(400, "Не указано, какие цифры поставить")
        try:
            t = norms.set_manual(uid, fields)
        except (norms.MissingData, ValueError) as e:
            raise HTTPException(400, str(e))
        warn = " " + " ".join(t.get("manual_warnings") or []) if t.get("manual_warnings") else ""
        return {"text": f"Нормы: {t['kcal']} ккал, белки {t['p']} г, жиры {t['f']} г, углеводы {t['c']} г{warn}"}
    if kind == "rebuild_program":
        if not _has_program(uid):
            raise HTTPException(400, "Нет активной программы")
        if userdata.ai_mode(uid) == "off":
            raise HTTPException(403, "ИИ выключена в профиле - план можно поправить вручную в «Тренировках»")
        return {"text": "Пересобираю план - это займёт пару минут",
                "job_id": jobs.submit(uid, "program", {"rebuild": True, "reason": p.get("note") or "по просьбе в чате",
                                                        "notes": p.get("note") or ""})}
    if kind == "set_daytype":
        _set_daytype(uid, p.get("date") or today, p["type"], p.get("note") or "")
        return {"text": "Тип дня отмечен"}
    if kind == "add_injury":
        db.server_put(uid, "injury", uuid.uuid4().hex, {"zone": p["zone"], "note": p.get("note") or "",
                                                         "since": today, "resolved": None}, today)
        return {"text": "Записал. Упражнения на эту зону уберу из новых тренировок, пока не отметишь, что прошло"}
    if kind == "set_pace":
        text = _recalc(uid, pace=p["pace"])
        res = {"text": text}
        if _has_program(uid) and userdata.ai_mode(uid) != "off":
            res["job_id"] = jobs.submit(uid, "program", {"rebuild": True, "reason": f"смена темпа на {p['pace']}"})
            res["text"] += "; план пересобирается"
        return res
    if kind == "log_food":
        rid = uuid.uuid4().hex
        rec = db.server_put(uid, "food", rid, {"meal": p.get("meal") or "snack", "text": p["text"], "items": [],
                                               "status": "raw", "time": datetime.now().strftime("%H:%M"),
                                               "entered_at": db.now_ms()}, today)
        done, rest = food.quick_parse(p["text"], uid=uid)
        if not rest:
            jobs._save_food(rec, done)
            return {"text": f"Записал: {food.totals(done)['kcal']:.0f} ккал", "record_id": rid}
        if userdata.ai_mode(uid) != "off":
            return {"text": "Записал, считаю калории" if not jobs.waiting() else "Записал, калории посчитаю, когда проснётся ИИ", "record_id": rid,
                    "job_id": jobs.submit(uid, "food", {"record_id": rid})}
        return {"text": "Записал, калории посчитаются позже", "record_id": rid}
    if kind == "log_activity":
        minutes = float(p.get("minutes") or 0)
        kcal = userdata.activity_kcal(p["type"], minutes, p.get("intensity") or "mid", userdata.latest_weight(uid))
        rid = uuid.uuid4().hex
        db.server_put(uid, "activity", rid, {"type": p["type"], "minutes": round(minutes), "intensity": p.get("intensity") or "mid",
                                             "kcal": kcal, "note": p.get("note") or "", "source": "manual",
                                             "entered_at": db.now_ms()}, p.get("date") or today)
        return {"text": f"Записал: {userdata.activity_name(p['type'])}, {round(minutes)} мин, ~{kcal} ккал", "record_id": rid}
    raise HTTPException(400, "Неизвестное действие")


@router.post("/api/chat/action")
async def chat_action(request: Request, u=Depends(userdata.current_user)):
    body = await request.json()
    uid = u["id"]
    msg = db.get(body.get("message_id") or "")
    if not msg or msg["user_id"] != uid or msg["kind"] != "chat" or msg["deleted"]:
        raise HTTPException(404, "Сообщение не найдено")
    actions = msg["data"].get("actions") or []
    act = next((a for a in actions if a.get("id") == body.get("action_id")), None)
    if not act:
        raise HTTPException(400, "Такое действие в этом сообщении не предлагалось")
    if act.get("status") == "done":
        return {"ok": True, "result": act.get("result") or {}, "already": True}
    if act.get("status") == "declined" and not body.get("decline"):
        raise HTTPException(400, "Действие уже отклонено")
    if body.get("decline"):
        act.update(status="declined")
        db.server_put(uid, "chat", msg["id"], {**msg["data"], "actions": actions}, msg["date"])
        return {"ok": True, "result": {"text": "Отклонено"}}
    result = await execute(uid, act["kind"], act.get("params") or {})
    act.update(status="done", result=result, done_at=db.now_ms())
    cur = db.get(msg["id"])                # сообщение могли поменять, пока шло действие
    db.server_put(uid, "chat", msg["id"], {**cur["data"], "actions": actions}, msg["date"])
    return {"ok": True, "result": result}
