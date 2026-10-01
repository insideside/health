"""День подробно для ИИ-тренера и отметки из чата.

Тренер в чате должен видеть день целиком - каждый приём пищи, каждую добавку из плана (принята или нет), пункты
чек-листа, чашки, комплексы - а не только итоги: иначе он дописывает недостающее сам («L-карнитин уже взят утром»).
И по просьбе ставить или снимать отметки (добавка, пункт чек-листа) за любую дату. Название ищется детерминированно,
с учётом разных написаний; не нашлось или вариантов несколько - отметка не ставится, тренер переспрашивает.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta

from . import db, userdata

MEAL_RU = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин", "snack": "перекус"}
WEEKDAY_FORMS = [("понедельник",), ("вторник",), ("сред",), ("четверг",), ("пятниц",), ("суббот",), ("воскресен",)]
MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"]
# латиница, похожая на кириллицу в названиях добавок: «l-карнитин», «omega» и т. п. сводим к одному виду
LAT = str.maketrans({"l": "л", "a": "а", "c": "с", "e": "е", "o": "о", "p": "р", "x": "х", "k": "к", "m": "м", "t": "т", "b": "б",
                     "d": "д", "i": "и", "n": "н", "r": "р", "s": "с", "u": "у", "v": "в", "z": "з", "g": "г", "h": "х", "f": "ф"})


def norm(s: str) -> str:
    s = (s or "").lower().replace("ё", "е")
    s = re.sub(r"[^a-zа-я0-9]+", " ", s).strip()
    return s.translate(LAT)


def _stems(s: str) -> set[str]:
    """Основы слов: без последней буквы (падеж), от 3 до 6 букв; числа целиком - «омегу» → «омег», «воду» → «вод»."""
    return {w if w.isdigit() else w[:max(3, min(6, len(w) - 1))] for w in norm(s).split() if len(w) >= 3 or w.isdigit()}


def _covers(q: set[str], c: set[str]) -> bool:
    """Каждая основа запроса совпадает началом с какой-то основой кандидата («шагов» ↔ «шаги»)."""
    return bool(q) and all(any(a.startswith(b) or b.startswith(a) for b in c) for a in q)


def _resolve(query: str, cands: list[tuple[str, list[str], object]]):
    """cands: [(название, [другие написания], объект)] → ('ok', объект) | ('ask', [названия]) | ('none', [названия]).
    Сначала точное совпадение любого написания, потом - все основы слов запроса есть в написании кандидата."""
    q, qs = norm(query), _stems(query)
    names = [c[0] for c in cands]
    exact = [c for c in cands if any(norm(v) == q for v in [c[0], *c[1]])]
    if len(exact) == 1:
        return "ok", exact[0][2]
    pool = exact or cands
    hit = [c for c in pool if any(_covers(qs, _stems(v)) for v in [c[0], *c[1]])]
    if len(hit) == 1:
        return "ok", hit[0][2]
    if len(hit) > 1:
        return "ask", [c[0] for c in hit]
    return "none", names


# ── добавки ──
def supp_plan(uid: str) -> list[dict]:
    cat = {x["id"]: x for x in db.supplements().get("items", [])}
    out = []
    for s in userdata.profile(uid).get("supplements") or []:
        if s.get("active") is False:
            continue
        it = cat.get(s.get("sid")) or {}
        key = s.get("key") or s.get("sid")
        out.append({**s, "key": key, "name": s.get("name") or it.get("name") or key, "aliases": it.get("aliases") or []})
    return out


def supp_taken(uid: str, d: str) -> list[dict]:
    return sorted((r for r in db.list_kind(uid, "supp", d, d)), key=lambda r: r["data"].get("time") or "")


def resolve_supp(uid: str, name: str):
    return _resolve(name, [(s["name"], s["aliases"], s) for s in supp_plan(uid)])


def mark_supp(uid: str, s: dict, d: str, time: str | None = None, undo: bool = False) -> str:
    if undo:
        taken = [r for r in supp_taken(uid, d) if r["data"].get("key") == s["key"]]
        if not taken:
            return f"{s['name']} за {human_date(d)} и так не отмечен"
        r = taken[-1]
        db.server_put(uid, "supp", r["id"], r["data"], d, deleted=True)
        fid = r["data"].get("food_id")
        if fid and (f := db.get(fid)) and not f["deleted"]:
            db.server_put(uid, "food", fid, f["data"], d, deleted=True)
        return f"Снял отметку: {s['name']}, {human_date(d)}"
    t = time or (datetime.now().strftime("%H:%M") if d == date.today().isoformat() else (s.get("times") or ["12:00"])[0])
    dose = s.get("dose") or 1
    unit = s.get("dose_unit") or "порция"
    # запись еды для протеина и т. п. допишет устройство (supps.ensureFoods): справочник порций и БЖУ - там
    db.server_put(uid, "supp", uuid.uuid4().hex, {"key": s["key"], "sid": s.get("sid"), "name": s["name"], "time": t,
                                                  "dose": dose, "dose_unit": unit, "created": db.now_ms(), "via": "chat"}, d)
    return f"Отметил: {s['name']}, {human_date(d)} в {t}"


# ── чек-лист ──
def checklist(uid: str) -> list[dict]:
    """Пункты, которые человек отмечает сам (без учётных чая/кофе и отключённых)."""
    rows = [r for r in db.list_kind(uid, "item") if r["data"].get("active") is not False and not r["data"].get("track")]
    return sorted(rows, key=lambda r: r["data"].get("order") or 0)


def item_target(uid: str, it: dict) -> float | None:
    t = (userdata.latest_target(uid) or {}).get("data") or {}
    if it.get("target_from") == "water":
        return t.get("water_glasses") or it.get("target")
    if it.get("target_from") == "steps":
        return t.get("steps_manual") or t.get("steps") or it.get("target")
    return it.get("target")


def log_of(uid: str, item_id: str, d: str):
    r = db.get(f"log:{uid}:{d}:{item_id}")
    return None if not r or r["deleted"] else r["data"].get("v")


def resolve_item(uid: str, name: str):
    aliases = {"water": ["вода", "стаканы воды", "стакан воды"], "steps": ["шаги", "шагов"]}
    # «Тренировка по плану» и «Записать питание» отмечаются сами (по тренировке и записям еды) - галочкой их не ставим
    rows = [r for r in checklist(uid) if r["data"].get("type") not in ("workout", "food")]
    return _resolve(name, [(r["data"].get("title") or "", aliases.get(r["data"].get("target_from"), []), r) for r in rows])


def check_item(uid: str, r: dict, d: str, value=None, undo: bool = False) -> str:
    it, title = r["data"], r["data"].get("title") or "пункт"
    if it.get("type") == "routine":
        rid = f"routine:{uid}:{d}:{it.get('module') or 'morning'}"
        rt = db.get(rid)
        if not rt or rt["deleted"]:
            return f"«{title}» за {human_date(d)} ещё не собрана - открой её на «Сегодня», и я отмечу"
        exs = [{**x, "done": not undo} for x in rt["data"].get("exercises") or []]
        db.server_put(uid, "routine", rid, {**rt["data"], "exercises": exs, "done": not undo}, d)
        return f"{'Снял отметку' if undo else 'Отметил'}: {title}, {human_date(d)}"
    lid = f"log:{uid}:{d}:{r['id']}"
    if undo:
        db.server_put(uid, "log", lid, {"v": False if it.get("type") == "bool" else 0}, d)
        return f"Снял отметку: {title}, {human_date(d)}"
    if it.get("type") in ("counter", "number"):
        try:
            v = float(value) if value not in (None, "") else None
        except (TypeError, ValueError):
            v = None
        if v is None:
            v = item_target(uid, it) or 1
        v = int(v) if float(v).is_integer() else v
        db.server_put(uid, "log", lid, {"v": v}, d)
        return f"Записал: {title} - {v:g}, {human_date(d)}" if isinstance(v, float) else f"Записал: {title} - {v}, {human_date(d)}"
    db.server_put(uid, "log", lid, {"v": True}, d)
    return f"Отметил: {title}, {human_date(d)}"


# ── даты ──
def human_date(d: str) -> str:
    t = date.today()
    x = date.fromisoformat(d)
    if x == t:
        return "сегодня"
    if x == t - timedelta(days=1):
        return "вчера"
    return x.strftime("%d.%m")


def mentioned_dates(text: str, today: date | None = None) -> list[str]:
    """Даты, о которых спрашивают: «вчера», «позавчера», «в понедельник» (последний прошедший), «28 сентября», «28.09»."""
    today = today or date.today()
    s = (text or "").lower().replace("ё", "е")
    out = []
    if "позавчера" in s:
        out.append(today - timedelta(days=2))
    elif "вчера" in s:
        out.append(today - timedelta(days=1))
    for i, (stem,) in enumerate(WEEKDAY_FORMS):
        if re.search(rf"(?<![а-я]){stem}", s):
            back = (today.weekday() - i) % 7 or 7
            out.append(today - timedelta(days=back))
    for m in re.finditer(r"(?<!\d)(\d{1,2})\s+([а-я]+)", s):
        mi = next((k for k, st in enumerate(MONTHS) if m.group(2).startswith(st) and (st != "ма" or m.group(2).startswith("мая"))), None)
        if mi is not None:
            try:
                x = date(today.year, mi + 1, int(m.group(1)))
                out.append(x if x <= today else date(today.year - 1, mi + 1, int(m.group(1))))
            except ValueError:
                pass
    for m in re.finditer(r"(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?!\d)", s):
        try:
            y = int(m.group(3)) if m.group(3) else today.year
            out.append(date(y + 2000 if y < 100 else y, int(m.group(2)), int(m.group(1))))
        except ValueError:
            pass
    return sorted({x.isoformat() for x in out if x <= today and (today - x).days <= 60})


# ── день подробно ──
def _num(v) -> str:
    return f"{round(float(v or 0))}"


def day_detail(uid: str, d: str) -> str:
    lines = [f"{d} ({human_date(d)}) подробно:"]
    foods = sorted(db.list_kind(uid, "food", d, d), key=lambda r: r["data"].get("time") or "")
    fl = []
    for r in foods:
        x = r["data"]
        if x.get("calc") in ("supp", "drink"):
            continue
        t = x.get("totals") or {}
        tail = f"{_num(t.get('kcal'))} ккал, Б {_num(t.get('p'))} Ж {_num(t.get('f'))} У {_num(t.get('c'))}" if t else "не посчитано"
        fl.append(f"{MEAL_RU.get(x.get('meal'), x.get('meal') or 'приём')} {x.get('time') or '?'}: {(x.get('text') or '')[:90]} - {tail}"
                  + ("" if x.get("status") == "calculated" else " (часть не посчитана)"))
    lines.append("Еда: " + ("; ".join(fl) if fl else "ничего не записано"))
    plan, taken = supp_plan(uid), supp_taken(uid, d)
    if plan or taken:
        sl = []
        for s in plan:
            got = [r["data"].get("time") or "?" for r in taken if r["data"].get("key") == s["key"]]
            planned = ", ".join(s.get("times") or []) or "без времени"
            sl.append(f"{s['name']}: " + (f"принят в {', '.join(got)}" if got else f"НЕ отмечен (план {planned})"))
        extra = [r["data"].get("name") for r in taken if r["data"].get("key") not in {s["key"] for s in plan}]
        if extra:
            sl.append("вне плана: " + ", ".join(filter(None, extra)))
        lines.append("Добавки: " + "; ".join(sl))
    cl = []
    for r in checklist(uid):
        it = r["data"]
        if it.get("type") in ("workout", "food"):
            continue
        if it.get("type") == "routine":
            rt = db.get(f"routine:{uid}:{d}:{it.get('module') or 'morning'}")
            exs = (rt or {}).get("data", {}).get("exercises") or [] if rt and not rt["deleted"] else []
            cl.append(f"{it.get('title')}: " + (f"{sum(1 for x in exs if x.get('done'))} из {len(exs)} упражнений" if exs else "не собрана"))
            continue
        v, tg = log_of(uid, r["id"], d), item_target(uid, it)
        if it.get("type") == "bool":
            cl.append(f"{it.get('title')}: {'да' if v else 'нет'}")
        else:
            cl.append(f"{it.get('title')}: {v or 0}" + (f" из {tg:g}" if isinstance(tg, (int, float)) else ""))
    if cl:
        lines.append("Чек-лист: " + "; ".join(cl))
    rts = [r for r in db.list_kind(uid, "routine", d, d) if (r["data"].get("module") or "") != "morning"]
    if rts:
        lines.append("Комплексы: " + "; ".join(f"{(r['data'].get('title') or '').split(' · ')[0]} - "
                                                  f"{sum(1 for x in r['data'].get('exercises') or [] if x.get('done'))} из {len(r['data'].get('exercises') or [])}"
                                                  for r in rts))
    stt = db.get(f"state:{uid}:{d}")
    if stt and not stt["deleted"] and stt["data"].get("pains"):
        names = {"head": "голова", "back": "спина", "knees": "колени", "stomach": "живот"}
        lines.append("Болит: " + ", ".join(names.get(x, x) for x in stt["data"]["pains"]))
    sl = db.get(f"sleep:{uid}:{d}")
    if sl and not sl["deleted"]:
        from .ai.jobs import naps_of, sleep_hours_of
        x = sl["data"]
        night = f"ночь {x.get('bed')}-{x.get('wake')}, {sleep_hours_of(x)} ч" if x.get("bed") and x.get("wake") else "ночь не записана"
        naps = naps_of(x)
        lines.append("Сон: " + night + ("; дневной сон: " + ", ".join(f"{n['from']}-{n['to']} ({n['min']} мин)" for n in naps) if naps else ""))
    cups = sorted(db.list_kind(uid, "drink", d, d), key=lambda r: r["data"].get("time") or "")
    if cups:
        by = {}
        for r in cups:
            by.setdefault({"coffee": "кофе", "tea": "чай"}.get(r["data"].get("kind"), "напиток"), []).append(
                (r["data"].get("time") or "?") + (" с молоком" if r["data"].get("milk") else ""))
        lines.append("Чашки: " + "; ".join(f"{k} в {', '.join(v)}" for k, v in by.items()))
    acts = db.list_kind(uid, "activity", d, d)
    if acts:
        lines.append("Активности: " + ", ".join(f"{userdata.activity_name(r['data'].get('type') or 'other')} {r['data'].get('minutes') or 0} мин" for r in acts))
    return "\n".join(lines)


FACTS_RULE = ("Про прошлое и сегодняшнее говори только по этим данным. Чего в них нет - того не было или не отмечено: "
              "не додумывай («уже принял», «не ел с утра»), а если важно - спроси. Добавка «НЕ отмечен» - значит не принята, "
              "пока человек не скажет иначе.")


# ── просьба отметить прямо в тексте (страховка: модель пишет «отметил», а действие не добавляет) ──
MARK_RE = re.compile(r"(?<![а-я])(отмет|постав|запиш|сним|убер|отмен|выпил|принял|попил|сделал)", re.I)
UNDO_RE = re.compile(r"(?<![а-я])(сним|убер|отмен|удали|не пил|не принимал|не выпил|перепутал)", re.I)


def _mentions(text: str, variants: list[str]) -> bool:
    """В тексте есть какое-то из написаний - целиком или заметным словом («разминку» для «Утренняя разминка»);
    однозначность проверяет вызывающий: подошло несколько - не отмечаем ничего."""
    ts = _stems(text)
    for v in variants:
        vs = _stems(v)
        if vs and (_covers(vs, ts) or any(len(a) >= 4 and _covers({a}, ts) for a in vs)):
            return True
    return False


def intent_marks(uid: str, text: str) -> list[dict]:
    """Явная просьба отметить/снять → [{kind, params}] для однозначно названного; неоднозначное - пусто (переспросит модель)."""
    if not MARK_RE.search(text or ""):
        return []
    undo = bool(UNDO_RE.search(text))
    said = mentioned_dates(text)
    d = said[0] if len(said) == 1 else date.today().isoformat()
    out = []
    supps = [s for s in supp_plan(uid) if _mentions(text, [s["name"], *s["aliases"]])]
    if len(supps) == 1:
        tm = re.search(r"(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)", text) or re.search(r"в\s+(\d{1,2})(?:\s*час|\s*утра|\s*вечера|\b)", text)
        t = f"{int(tm.group(1)):02d}:{tm.group(2) if tm.lastindex and tm.lastindex >= 2 else '00'}" if tm else None
        out.append({"kind": "mark_supp", "params": {"name": supps[0]["name"], "key": supps[0]["key"], "date": d, "undo": undo, **({"time": t} if t else {})}})
    aliases = {"water": ["вода", "стаканы воды"], "steps": ["шаги"]}
    items = [r for r in checklist(uid) if r["data"].get("type") not in ("workout", "food")
             and _mentions(text, [r["data"].get("title") or "", *aliases.get(r["data"].get("target_from"), [])])]
    if len(items) == 1:
        num = re.search(r"(?<![\d.:])(\d+(?:[.,]\d+)?)(?![\d.:])", re.sub(r"\d{1,2}\.\d{1,2}(\.\d{2,4})?", " ", text))
        out.append({"kind": "check_item", "params": {"name": items[0]["data"].get("title"), "item_id": items[0]["id"], "date": d, "undo": undo,
                                                     **({"value": float(num.group(1).replace(",", "."))} if num and not undo else {})}})
    return out


def _all_stems(s: str) -> set[str]:
    """Как _stems, но и короткие слова («д» в «витамин д» - это D3): для сравнения, чем названы добавки."""
    return {w if len(w) <= 2 or w.isdigit() else w[:max(3, min(6, len(w) - 1))] for w in norm(s).split()}


def _matched_by(text: str, variants: list[str]) -> frozenset:
    """Какими словами текста названо (основы текста, совпавшие с каким-то написанием)."""
    ts = _all_stems(text) - {"и", "в", "за", "с", "на"}
    got = set()
    for v in variants:
        for a in _all_stems(v):
            got |= {b for b in ts if (len(b) >= 3 and (a.startswith(b) or b.startswith(a))) or (len(b) <= 2 and a.startswith(b) and len(a) <= 3)}
    return frozenset(got)


def vague_supps(uid: str, text: str, keys: list[str]) -> list[str]:
    """Отмечают несколько добавок, а в тексте их различает одно общее слово («витамины» → D3 и мультивитамины):
    → названия для уточнения; названы разными словами («омегу и магний») → []."""
    plan = {s["key"]: s for s in supp_plan(uid)}
    by = {k: _matched_by(text, [plan[k]["name"], *plan[k]["aliases"]]) for k in keys if k in plan}
    vague = [k for k in by if not by[k] or any(o != k and by[o] and by[o] >= by[k] for o in by)]
    return [plan[k]["name"] for k in vague]
