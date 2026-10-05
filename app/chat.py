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

from . import daylog, db, food, norms, userdata
from .ai import jobs
from .ai.jobs import (DAYTYPE_LABEL, SLEEPY_LABEL, SORENESS_LABEL, STRESS_LABEL, WEEKDAYS, WELLBEING_LABEL, goals_text,
                      person_text, sleep_hours_of, snooze_min, system_for)
from .ai.ollama import AIError, ask_json
from .health import match_activity

router = APIRouter()

HISTORY = 12
ACTION_KINDS = ("skip_today", "move_workout", "lighten_today", "swap_exercise", "recalc_norms", "set_macros", "set_norms", "rebuild_program",
                "set_daytype", "add_injury", "set_pace", "log_food", "log_activity", "mark_supp", "check_item")
# отметки выполняются сразу (просьба «отметь / сними» однозначна), кнопка в ответе - «Отменить»
AUTO_KINDS = ("mark_supp", "check_item")
DAYTYPES = ("cheat", "special", "sick", "rest")
INJURY_ZONES = ("head", "stomach", "chest", "shoulders", "arms", "back", "abs", "sides", "glutes", "legs", "neck",
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
                "kcal": {"type": "number"}, "p": {"type": "number"}, "f": {"type": "number"}, "c": {"type": "number"},
                "name": {"type": "string"}, "value": {"type": "number"}, "time": {"type": "string"}, "undo": {"type": "boolean"},
                "place": {"type": "string"}, "sleep_hours": {"type": "number"}, "steps": {"type": "number"}}},
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
- set_norms {sleep_hours?, steps?} - своя норма сна (часы, 5-12) или цель шагов, о которых договорились
  («мне нужно 10 часов сна» → {sleep_hours: 10}); ты сам норму не меняешь и не «запоминаешь» - только этой кнопкой;
- rebuild_program {note?, place?} - пересобрать будущий план тренировок; note - коротко перескажи, что учесть при пересборке
  (акценты по зонам, что убрать/оставить, предпочтения по кардио и т. п. - из того, что клиент только что описал),
  иначе пересборка о разговоре ничего не узнает и придумает своё; place - home (дома) или gym (зал), если клиент
  меняет место («не могу ходить в зал» → home); без place остаётся место текущей программы;
- set_daytype {date, type} - тип дня: cheat (читмил), special (особый), sick (болею), rest (отдых);
- add_injury {zone, note} - записать, что болит (отметится и в самочувствии на «Сегодня», план дня подстроится);
  zone: head (голова), stomach (живот), chest, shoulders, arms, back, abs, sides, glutes, legs, neck,
  knees, lower_back, wrists, ankles, hips;
- set_pace {pace} - темп: slower, normal, faster (пересчитает нормы и план);
- log_food {text, meal} - записать еду как написал клиент; meal: breakfast, lunch, dinner, snack;
- log_activity {type, minutes, intensity} - записать активность; type - id из списка активностей; intensity: low, mid, high.
- mark_supp {name, date?, time?, undo?} - отметить приём добавки из плана клиента (undo: true - снять отметку); name -
  как её назвал клиент; date - YYYY-MM-DD (по умолчанию сегодня, можно прошлые дни); выполняется сразу, без кнопки;
- check_item {name, date?, value?, undo?} - отметить пункт чек-листа (галочку или разминку) или записать число
  (вода - стаканы, шаги - шаги) в value; undo: true - снять; за любую дату; выполняется сразу.
Просят отметить или снять добавку/пункт («отметь, что выпил л-карнитин», «поставь воду 6 стаканов за вчера») -
обязательно добавь mark_supp / check_item. Если непонятно, что именно отметить (в плане несколько похожих, названия
нет в данных), - не добавляй действие, а спроси. Про уже сделанное отметку не пиши, будто она есть: отметит кнопка.
Даты - YYYY-MM-DD. label - коротко на кнопке, 2–5 слов («Перенести на четверг»).
Ты сам ничего не делаешь, пока не нажата кнопка - не пиши так, будто уже записал, перенёс или заменил. Но и не
подставляй в каждый ответ одну и ту же фразу «жми - сделаю»: предложи действие обычными словами, как в разговоре
(«Давай запишу», «Могу перенести на четверг», «Если хочешь, заменю на планку») - своими, а не по шаблону, и только
там, где кнопка действительно что-то делает: если ты советуешь ничего не менять, никакую кнопку жать не зови.
Просит записать еду или активность - обязательно предложи log_food / log_activity.
Служебные id (из каталога упражнений, «можно на замену» и т. п.) - только внутри params действий, их не видит
человек, которому ты отвечаешь. В тексте ответа называй упражнения обычными русскими названиями, никогда не id.
Имена действий и параметров (rebuild_program, note, from, to, params и т. п.) в тексте тоже не пиши, и не проси
«нажать кнопку с note»: что учесть, ты кладёшь в note кнопки, а человеку своими словами говоришь, что поменяешь
(«Пересоберу: верх и кор, ноги уберу, кардио на эллипсе»). Настройки профиля, которых нет среди действий, ты поменять
не можешь - так и скажи и подскажи, где это в профиле, а не обещай «запомнить»."""


# ── контекст ──

def _context(uid: str, text: str = "") -> str:
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
            if sleep_hours_of(sleep[d]):
                parts.append(f"сон {sleep_hours_of(sleep[d])} ч" + (f" (из них {sz} мин дрёмы после будильника)" if sz else ""))
            if (nm := jobs.nap_min_of(sleep[d])):
                parts.append(f"дневной сон {nm} мин")
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
    act_prog = next((p["data"] for p in db.list_kind(uid, "program") if p["data"].get("active")), None)
    prog_place = ("нет" if not act_prog else "в зале" if act_prog.get("place") == "gym" else "дома") + \
        f", инвентарь дома: {', '.join(jobs.EQUIP_LABEL.get(x, x) for x in userdata.profile(uid).get('equipment') or [])}"
    free = [d for d in ((today + timedelta(days=i)).isoformat() for i in range(1, 5)) if d not in wos]
    acts_cat = ", ".join(f"{a['id']} ({a.get('name')})" for a in db.activities()) or "walking, running, cycling, swimming, other"
    injuries = userdata.open_injuries(uid)
    # сегодня и вчера - подробно (каждый приём пищи, добавки из плана с отметками, чек-лист, чашки, комплексы), и дни,
    # о которых спрашивают («в понедельник», «28 сентября»)
    days = sorted({today.isoformat(), (today - timedelta(days=1)).isoformat(), *daylog.mentioned_dates(text, today)}, reverse=True)
    detail = "\n".join(daylog.day_detail(uid, d) for d in days)
    return f"""{_cardio_line(uid)}
Сегодня {today.isoformat()}, {WEEKDAYS[today.weekday()]}, {datetime.now():%H:%M}.
Клиент: {person_text(uid)}. Цели: {goals_text(goal)}.
Нормы: {t.get('kcal', '-')} ккал, Б {t.get('p', '-')} / Ж {t.get('f', '-')} / У {t.get('c', '-')} г, вода {t.get('water_glasses', '-')} стак.,
шаги {t.get('steps_manual') or t.get('steps', '-')}, сон {norms.sleep_of(t) or '-'} ч{' (своя норма)' if t.get('sleep_manual') else ''}, темп: {(t.get('intensity') or {}).get('label', '-')}.
Травмы: {'; '.join(f"{i.get('zone')} {i.get('note') or ''} с {i.get('since')}" for i in injuries) or 'нет'}.
Последние 7 дней:
{chr(10).join(lines)}
Программа тренировок: {prog_place}.
Тренировка сегодня: {today_wo}{swap}
Ближайшие тренировки: {'; '.join(upcoming) or 'нет'}
Свободные для переноса дни: {', '.join(f"{d} {WEEKDAYS[date.fromisoformat(d).weekday()]}" for d in free) or 'нет'}
Виды активностей (id): {acts_cat}
{detail}
{daylog.FACTS_RULE}"""


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
    own = jobs.own_exercises(uid)
    if own:
        out.append("Свои упражнения клиента (добавил сам; отметки - в чек-листе дня): "
                   + ", ".join(f"{e['name']}{' (' + e['how'] + ')' if e.get('how') else ''}" for e in own[:12]) + ".")
    sw = jobs.swaps_text(uid, prof)
    if sw:
        out.append("Клиент сам заменял упражнения (было → стало): " + sw + ". Учитывай: прежнее ему не подошло.")
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
        if k == "rebuild_program" and p.get("place") not in ("home", "gym"):
            p.pop("place", None)
        if k == "set_norms":
            p = {kk: p[kk] for kk in ("sleep_hours", "steps") if isinstance(p.get(kk), (int, float))}
            if not p or not (5 <= p.get("sleep_hours", 8) <= 12 and 1000 <= p.get("steps", 5000) <= 40000):
                continue
        if k == "log_food":
            if not p.get("text"):
                continue
            if p.get("meal") not in MEALS:
                p["meal"] = "snack"
        if k in AUTO_KINDS:
            if not p.get("name"):
                continue
            p.setdefault("date", today)
            if p.get("date") > today:
                continue
            if p.get("time") and not re.fullmatch(r"\d{1,2}:\d{2}", str(p["time"])):
                p.pop("time")
            p["undo"] = bool(p.get("undo"))
        if k == "log_activity":
            if not p.get("minutes"):
                continue
            p["type"] = p.get("type") if userdata.activity_info(p.get("type") or "") else match_activity(p.get("type") or "")
            if p.get("intensity") not in ("low", "mid", "high"):
                p["intensity"] = "mid"
        out.append({"id": uuid.uuid4().hex[:8], "kind": k, "label": (a.get("label") or k)[:40],
                    "params": p, "status": "offered"})
    return out[:3]


_NO_GYM_RE = re.compile(r"(?i)(без\s+зала|не\s+(?:могу|буду|получается|смогу)\s+(?:\S+\s+){0,2}(?:в\s+)?зал|"
                        r"(?:тренироваться|заниматься|занятия|тренировки)\s+дома|домашн\w+\s+(?:трениров|программ))")
_TO_GYM_RE = re.compile(r"(?i)(снова|опять|теперь|начал\w*|буду)\s+(?:\S+\s+){0,2}(?:в\s+)?зал")


def _place_intent(text: str) -> str | None:
    if _NO_GYM_RE.search(text):
        return "home"
    if _TO_GYM_RE.search(text):
        return "gym"
    return None


def _guess_meal(text: str) -> str:
    t = text.lower()
    for key, meal in (("завтрак", "breakfast"), ("обед", "lunch"), ("ужин", "dinner"), ("перекус", "snack")):
        if key in t:
            return meal
    h = datetime.now().hour
    return "breakfast" if h < 11 else "lunch" if h < 16 else "dinner" if h >= 18 else "snack"


# служебное, что модель всё же вписала в текст: «с note: «…»», «(note: …)», длинное тире
_PARAM_RE = re.compile(r"\s*(?:\(\s*)?(?:с\s+)?\b(?:note|params|from|to|reason)\s*[:=]\s*(?:«[^»]*»|\"[^\"]*\"|[^.,;)\n]*)\)?", re.I)


# имя действия в тексте: «жми rebuild_program» → «жми кнопку», «кнопку set_norms» → «кнопку»
_KIND_RE = re.compile(r"(\s*)(?:(кнопк[ауеи])|(жми|нажми|нажать|нажимай))?\s*\b(?:" + "|".join(ACTION_KINDS) +
                      r")\b(?:\s*\([^)]*\))?", re.I)
_NOTE_RE = re.compile(r"\s*(?:с|и)\s+(?:note|примечанием)\b\s*[:=]?\s*(?:«[^»]*»|\"[^\"]*\")?", re.I)


def _humanize(reply: str) -> str:
    reply = _KIND_RE.sub(lambda m: m.group(1) + (m.group(2) or (m.group(3) + " кнопку" if m.group(3) else "")), reply)
    reply = _NOTE_RE.sub("", reply)
    reply = _PARAM_RE.sub("", reply)
    reply = re.sub(r"\s*[—–]\s*", " - ", reply)
    return re.sub(r"[ \t]{2,}", " ", reply).replace(" .", ".").strip()


def _find_mark(uid: str, kind: str, p: dict):
    """→ ('ok', объект) | ('ask'/'none', [названия]) - добавка из плана или пункт чек-листа."""
    if kind == "mark_supp":
        if p.get("key"):
            s = next((x for x in daylog.supp_plan(uid) if x["key"] == p["key"]), None)
            return ("ok", s) if s else ("none", [x["name"] for x in daylog.supp_plan(uid)])
        return daylog.resolve_supp(uid, p.get("name") or "")
    if p.get("item_id"):
        r = next((x for x in daylog.checklist(uid) if x["id"] == p["item_id"]), None)
        return ("ok", r) if r else ("none", [x["data"].get("title") for x in daylog.checklist(uid)])
    return daylog.resolve_item(uid, p.get("name") or "")


def _mark(uid: str, kind: str, p: dict) -> dict:
    st, obj = _find_mark(uid, kind, p)
    if st != "ok":
        raise HTTPException(400, "Не нашёл, что отметить")
    d = p.get("date") or date.today().isoformat()
    if kind == "mark_supp":
        return {"text": daylog.mark_supp(uid, obj, d, p.get("time"), bool(p.get("undo"))), "key": obj["key"], "date": d}
    return {"text": daylog.check_item(uid, obj, d, p.get("value"), bool(p.get("undo"))), "item_id": obj["id"], "date": d}


def _apply_marks(uid: str, actions: list[dict], text: str = "") -> tuple[list[dict], list[str], str | None]:
    """Отметки из ответа выполняем сразу. → (действия для сообщения, строки «что сделано», вопрос-уточнение | None).
    Не нашли однозначно - ничего не отмечаем, а спрашиваем со списком вариантов."""
    out, done, ask = [], [], None
    for a in actions:
        if a["kind"] not in AUTO_KINDS:
            out.append(a)
            continue
        p = a["params"]
        # модель часто не ставит дату («за вчера отметь…» → сегодня): одна названная в сообщении дата важнее
        said = daylog.mentioned_dates(text)
        if len(said) == 1 and p.get("date") == date.today().isoformat() and said[0] != p["date"]:
            p["date"] = said[0]
        st, obj = _find_mark(uid, a["kind"], p)
        what = "добавку" if a["kind"] == "mark_supp" else "пункт"
        if st != "ok":
            if not obj:
                ask = f"Не нашёл «{p.get('name')}»: в плане нет {'добавок' if a['kind'] == 'mark_supp' else 'пунктов чек-листа'}."
            else:
                ask = (f"Уточни, какую {what} отметить: " if st == "ask" else f"Не нашёл «{p.get('name')}». Какую {what} ты имеешь в виду: ") + ", ".join(obj) + "?"
            continue
        res = _mark(uid, a["kind"], p)
        done.append(res["text"])
        ref = {"key": res["key"]} if "key" in res else {"item_id": res["item_id"]}
        a.update(status="done", result=res, done_at=db.now_ms(), params={**p, **ref}, label=res["text"].split(",")[0][:40])
        out.append(a)
        # «Отменить» - то же действие с обратным знаком
        out.append({"id": uuid.uuid4().hex[:8], "kind": a["kind"], "label": "Отменить", "status": "offered", "undo_of": a["id"],
                    "params": {**p, **ref, "undo": not p.get("undo")}})
    return out, done, ask


async def job_chat(uid: str, inp: dict) -> dict:
    msg = db.get(inp["message_id"])
    if msg and msg["user_id"] != uid:
        raise AIError("Сообщение не найдено")
    text = inp.get("text") or (msg or {}).get("data", {}).get("text") or ""
    system = (system_for(uid, "Ты личный тренер и помощник по здоровью в приложении «Тренер»: питание, тренировки, сон, "
                              "восстановление, мотивация.") + "\n\n" + STYLE + "\n\n" + ACTIONS_HELP +
              "\n\nДанные клиента (используй, когда к месту):\n" + _context(uid, text))
    # think=True: иначе модель рассуждает прямо в поле reply
    out = await ask_json(system, text, CHAT_SCHEMA, temperature=0.7, think=True, history=_history(uid, inp["message_id"]),
                         kind="chat", uid=uid)
    reply = (out.get("reply") or "").strip()
    if len(reply) > REPLY_MAX:
        # модель слила рассуждения в ответ - берём последний абзац (обычно это и есть ответ)
        reply = reply.split("\n\n")[-1].strip().strip('"«»')[:REPLY_MAX]
    reply = _humanize(reply)
    if not reply:
        raise AIError("Модель промолчала - спросите ещё раз")
    actions = _clean_actions(out.get("actions"), uid)
    # модель не добавила отметку, хотя просили явно («поставь воду 6 стаканов за вчера») - берём из самого текста
    if not any(a["kind"] in AUTO_KINDS for a in actions):
        for m in daylog.intent_marks(uid, text):
            actions.append({"id": uuid.uuid4().hex[:8], "kind": m["kind"], "label": "Отметить", "params": m["params"], "status": "offered"})
    # несколько добавок по одному общему слову («отметь витамины») - не угадываем, спрашиваем
    many = [a for a in actions if a["kind"] == "mark_supp"]
    if len(many) > 1:
        keys = [(daylog.resolve_supp(uid, a["params"].get("name") or "")[1] or {}).get("key") if daylog.resolve_supp(uid, a["params"].get("name") or "")[0] == "ok" else None for a in many]
        vague = daylog.vague_supps(uid, text, [k for k in keys if k])
        if vague:
            names = [a["params"].get("name") for a in many if a["params"].get("name")]
            actions = [a for a in actions if a["kind"] != "mark_supp"]
            reply = f"Уточни, что отметить: {', '.join(names)} - какие из них?"
    for a in actions:
        if a["kind"] == "rebuild_program":
            # место из самой просьбы, если модель его не передала; слова клиента - в пересборку как есть
            if "place" not in a["params"] and (pl := _place_intent(text)):
                a["params"]["place"] = pl
            a["params"]["request"] = text[:600]
    actions, marked, ask = _apply_marks(uid, actions, text)
    if not marked and not ask and daylog.MARK_RE.search(text) and re.search(r"(?i)(отметил|снял|записал|поставил|убрал)", reply):
        # «отметил», а на деле ничего не сделано и понять, что именно, не вышло - честно переспрашиваем
        reply = "Не понял, что именно отметить. Назови добавку или пункт чек-листа и день - например, «отметь омегу за вчера»."
    if ask:
        # отметить не вышло - вместо уверенного ответа уточнение (модель могла написать «отметил»)
        reply = ask if not marked else f"{'. '.join(marked)}. {ask}"
    elif marked:
        # что именно сделано - нашими словами: модель иногда пишет «отмечу», хотя уже отмечено
        reply = re.sub(r"(?i)[^.!?]*(отмеч|отмет|сним|снял|снят|запиш|записа|постав)[^.!?]*[.!?]?\s*", "", reply).strip()
        reply = (". ".join(marked) + ". " + reply).strip()
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
        new = next((e for e in [*db.exercises(), *jobs.own_exercises(uid)] if e["id"] == p.get("to")), None)
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
        notes = p.get("note") or ""
        if p.get("request"):
            notes = (notes + "\n" if notes else "") + f"Слова клиента: «{p['request']}»"
        # кнопки, предложенные до появления place, - место по их заметке
        place = p.get("place") if p.get("place") in ("home", "gym") else _place_intent(f"{p.get('note') or ''} {p.get('request') or ''}")
        where = {"home": " дома", "gym": " в зале"}.get(place or "", "")
        return {"text": f"Пересобираю план{where} - это займёт пару минут",
                "job_id": jobs.submit(uid, "program", {"rebuild": True, "reason": p.get("note") or "по просьбе в чате",
                                                        "notes": notes, **({"place": place} if place else {})})}
    if kind == "set_norms":
        fields = {}
        if isinstance(p.get("sleep_hours"), (int, float)) and 5 <= p["sleep_hours"] <= 12:
            fields["sleep_manual"] = round(p["sleep_hours"] * 4) / 4
        if isinstance(p.get("steps"), (int, float)) and 1000 <= p["steps"] <= 40000:
            fields["steps_manual"] = round(p["steps"] / 100) * 100
        t = userdata.latest_target(uid)
        if not fields or not t:
            raise HTTPException(400, "Нормы ещё не посчитаны" if not t else "Не указано, что поменять")
        db.server_put(uid, "target", t["id"], {**t["data"], **fields}, t.get("date"))
        bits = ([f"сон {norms.hours_text(fields['sleep_manual'])} ч"] if "sleep_manual" in fields else []) + \
               ([f"шаги {fields['steps_manual']}"] if "steps_manual" in fields else [])
        return {"text": "Своя норма: " + ", ".join(bits)}
    if kind == "set_daytype":
        _set_daytype(uid, p.get("date") or today, p["type"], p.get("note") or "")
        return {"text": "Тип дня отмечен"}
    if kind == "add_injury":
        # то же, что «Что-то болит» в самочувствии: отметка на сегодня (устройство подстроит план дня)
        pain = {"head": "head", "stomach": "stomach", "back": "back", "lower_back": "back", "knees": "knees"}.get(p["zone"])
        if pain:
            st = db.get(f"state:{uid}:{today}")
            data = dict(st["data"]) if st and not st["deleted"] else {"entered_at": db.now_ms()}
            data["pains"] = sorted(set(data.get("pains") or []) | {pain})
            db.server_put(uid, "state", f"state:{uid}:{today}", data, today)
        if p["zone"] in ("head", "stomach"):
            return {"text": "Отметил в самочувствии на сегодня - план дня облегчу"}
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
    if kind in AUTO_KINDS:
        return _mark(uid, kind, p)
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
    if act.get("undo_of"):
        act["label"] = (result.get("text") or "Отменено").split(",")[0][:40]
    cur = db.get(msg["id"])                # сообщение могли поменять, пока шло действие
    db.server_put(uid, "chat", msg["id"], {**cur["data"], "actions": actions}, msg["date"])
    return {"ok": True, "result": result}
