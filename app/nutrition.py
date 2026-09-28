"""Питание кодом: план рациона на день из справочника и оценка дня питания.

План собирается без ИИ: шаблоны приёмов пищи из простых продуктов (белок + гарнир + овощи),
граммы подбираются линейным решением под калории и белок приёма. Так план есть всегда,
мгновенно и офлайн-предсказуемо; ИИ-рацион (ai/jobs.py, mealplan) — по кнопке, для разнообразия.
"""
import hashlib
import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException

from . import db, food, userdata
from .userdata import current_user

router = APIRouter()

MEAT_GROUPS = {"мясо", "птица", "колбасы и полуфабрикаты"}
FISH_GROUPS = {"рыба и морепродукты"}
DAIRY_GROUPS = {"молочные", "сыры"}
EGG_GROUPS = {"яйца"}
GLUTEN_RE = re.compile(r"хлеб|макарон|булгур|кускус|перлов|манн|ячнев|лаваш|лапша|овсян|мюсли|гранол|пшен(?!о)|батон|багет", re.I)
PORK_RE = re.compile(r"свин|сало|бекон|смалец", re.I)
LACTOSE_OK_RE = re.compile(r"безлактоз|пармезан|гауда|чеддер|маасдам", re.I)

# слот: (роль, кандидаты по порядку предпочтения, граммы по умолчанию, мин, макс)
# роль p — источник белка (масштабируется), c — гарнир (масштабируется), x — фиксированная добавка
TEMPLATES: dict[str, list[dict]] = {
    "breakfast": [
        {"title": "Овсянка с творогом и фруктом", "slots": [
            ("c", ["Овсянка на воде"], 250, 150, 400),
            ("p", ["Творог 5%", "Творог 2%", "Йогурт греческий", "Тофу"], 150, 80, 300),
            ("x", ["Банан", "Яблоко", "Ягоды замороженные"], 100, 0, 0)]},
        {"title": "Яйца, хлеб и овощи", "slots": [
            ("p", ["Яйцо варёное", "Омлет", "Тофу"], 110, 55, 220),
            ("c", ["Хлеб цельнозерновой", "Хлеб ржаной", "Хлебцы рисовые"], 60, 30, 120),
            ("x", ["Огурец", "Помидор"], 150, 0, 0)]},
        {"title": "Гречка с яйцом", "slots": [
            ("c", ["Гречка варёная"], 180, 100, 300),
            ("p", ["Яйцо варёное", "Тофу"], 110, 55, 220),
            ("x", ["Помидор", "Огурец"], 120, 0, 0)]},
        {"title": "Творог с ягодами и хлопьями", "slots": [
            ("p", ["Творог 5%", "Скайр", "Йогурт греческий", "Тофу"], 200, 100, 350),
            ("c", ["Овсяные хлопья сухие", "Гречка варёная"], 40, 20, 90),
            ("x", ["Ягоды замороженные", "Яблоко"], 100, 0, 0)]},
    ],
    "lunch": [
        {"title": "Курица с гречкой и овощами", "slots": [
            ("p", ["Куриная грудка варёная", "Индейка филе варёное", "Тофу"], 150, 80, 300),
            ("c", ["Гречка варёная"], 200, 100, 400),
            ("x", ["Брокколи", "Овощная смесь замороженная"], 150, 0, 0),
            ("x", ["Масло оливковое", "Масло подсолнечное"], 5, 0, 0)]},
        {"title": "Говядина с рисом и салатом", "slots": [
            ("p", ["Говядина варёная", "Телятина варёная", "Куриная грудка варёная", "Тофу"], 130, 70, 250),
            ("c", ["Рис бурый варёный", "Рис белый варёный"], 200, 100, 400),
            ("x", ["Капуста белокочанная", "Огурец"], 150, 0, 0),
            ("x", ["Масло подсолнечное", "Масло оливковое"], 7, 0, 0)]},
        {"title": "Индейка с макаронами и овощами", "slots": [
            ("p", ["Индейка филе варёное", "Куриная грудка варёная", "Тофу"], 150, 80, 300),
            ("c", ["Макароны цельнозерновые варёные", "Макароны варёные", "Рис белый варёный"], 200, 100, 400),
            ("x", ["Помидор", "Перец болгарский", "Огурец"], 150, 0, 0)]},
        {"title": "Рыба с картофелем и капустой", "slots": [
            ("p", ["Минтай отварной", "Треска", "Хек", "Тофу"], 200, 100, 350),
            ("c", ["Картофель варёный", "Рис белый варёный"], 250, 120, 450),
            ("x", ["Капуста белокочанная", "Морковь"], 150, 0, 0),
            ("x", ["Масло подсолнечное", "Масло оливковое"], 7, 0, 0)]},
        {"title": "Чечевица с рисом и овощами", "slots": [
            ("p", ["Чечевица варёная", "Нут варёный", "Фасоль варёная"], 200, 100, 350),
            ("c", ["Рис бурый варёный", "Рис белый варёный", "Гречка варёная"], 150, 60, 300),
            ("x", ["Овощная смесь замороженная", "Морковь"], 150, 0, 0),
            ("x", ["Масло оливковое", "Масло подсолнечное"], 7, 0, 0)]},
    ],
    "dinner": [
        {"title": "Запечённый лосось с булгуром и овощами", "slots": [
            ("p", ["Лосось запечённый", "Горбуша", "Форель", "Тофу"], 130, 80, 250),
            ("c", ["Булгур варёный", "Гречка варёная", "Рис бурый варёный"], 150, 60, 300),
            ("x", ["Брокколи", "Кабачок"], 200, 0, 0)]},
        {"title": "Курица с овощами и картофелем", "slots": [
            ("p", ["Куриная грудка запечённая", "Индейка филе варёное", "Тофу"], 150, 80, 300),
            ("c", ["Картофель запечённый", "Батат", "Гречка варёная"], 150, 60, 350),
            ("x", ["Овощи гриль", "Кабачок", "Перец болгарский"], 200, 0, 0)]},
        {"title": "Омлет с овощами и хлебом", "slots": [
            ("p", ["Омлет", "Яйцо варёное", "Тофу"], 170, 100, 300),
            ("c", ["Хлеб цельнозерновой", "Хлеб ржаной", "Хлебцы рисовые"], 40, 20, 100),
            ("x", ["Помидор", "Огурец", "Салат листовой"], 200, 0, 0)]},
        {"title": "Треска с рисом и салатом", "slots": [
            ("p", ["Треска", "Минтай отварной", "Хек", "Тофу"], 200, 100, 350),
            ("c", ["Рис белый варёный", "Рис бурый варёный", "Гречка варёная"], 150, 60, 300),
            ("x", ["Огурец", "Помидор", "Капуста пекинская"], 200, 0, 0),
            ("x", ["Масло оливковое", "Масло подсолнечное"], 5, 0, 0)]},
        {"title": "Нут с овощами", "slots": [
            ("p", ["Нут варёный", "Фасоль варёная", "Чечевица варёная"], 200, 100, 350),
            ("c", ["Булгур варёный", "Рис бурый варёный", "Гречка варёная"], 100, 40, 250),
            ("x", ["Овощи гриль", "Перец болгарский", "Помидор"], 200, 0, 0)]},
    ],
    "snack": [
        {"title": "Греческий йогурт с орехами", "slots": [
            ("p", ["Йогурт греческий", "Скайр", "Творог 2%"], 150, 80, 300),
            ("c", ["Грецкий орех", "Миндаль"], 15, 10, 30)]},
        {"title": "Кефир и яблоко", "slots": [
            ("p", ["Кефир 1%", "Кефир 2,5%", "Молоко соевое"], 250, 150, 400),
            ("c", ["Яблоко", "Груша", "Банан"], 150, 80, 250)]},
        {"title": "Хумус с хлебцами и овощами", "slots": [
            ("p", ["Хумус"], 70, 40, 120),
            ("c", ["Хлебцы хрустящие", "Хлебцы рисовые"], 30, 15, 60),
            ("x", ["Морковь", "Огурец"], 100, 0, 0)]},
        {"title": "Творог с бананом", "slots": [
            ("p", ["Творог 5%", "Творог 2%", "Тофу"], 150, 80, 250),
            ("c", ["Банан", "Яблоко"], 100, 50, 200)]},
        {"title": "Банан с арахисовой пастой", "slots": [
            ("c", ["Банан", "Яблоко"], 120, 80, 200),
            ("p", ["Арахисовая паста", "Миндаль"], 20, 10, 35)]},
    ],
}
MEAL_LABEL = {"breakfast": "Завтрак", "lunch": "Обед", "dinner": "Ужин", "snack": "Перекус"}
SHARES = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.25, "snack": 0.15}
SHARES_IF = {"lunch": 0.40, "snack": 0.20, "dinner": 0.40}


def _allergy_words(text: str) -> list[str]:
    out = []
    for w in re.split(r"[,;\n/]+|\s+", (text or "").lower().replace("ё", "е")):
        w = w.strip(" .-")
        if len(w) >= 3 and w not in ("нет", "без", "аллергия", "аллергии", "на"):
            out.append(food.stem(w)[:max(3, len(food.stem(w)))])
    return out


def allowed(f: dict, diet: str, allergy: list[str]) -> bool:
    """Подходит ли продукт диете и списку исключений (простое вхождение основы слова)."""
    g, n = f.get("group") or "", f["name"]
    low = n.lower().replace("ё", "е")
    if diet in ("vegetarian", "vegan") and g in MEAT_GROUPS | FISH_GROUPS:
        return False
    if diet == "pescatarian" and g in MEAT_GROUPS:
        return False
    if diet == "vegan" and (g in DAIRY_GROUPS | EGG_GROUPS or "мёд" in low or "мед" == low):
        return False
    if diet == "lactose_free" and g in DAIRY_GROUPS and not LACTOSE_OK_RE.search(n):
        return False
    if diet == "gluten_free" and GLUTEN_RE.search(n):
        return False
    if diet in ("halal", "kosher") and PORK_RE.search(n):
        return False
    if diet == "kosher" and g in FISH_GROUPS and re.search(r"кревет|кальмар|мидии|осьминог|краб", low):
        return False
    grp = g.lower()
    return not any(w in low or w in grp for w in allergy)


def _seed(*parts) -> int:
    return int(hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def _resolve(slots, idx, diet, allergy, rot) -> list | None:
    out = []
    for role, names, g, lo, hi in slots:
        cands = [idx.match(n) for n in names]
        cands = [c for c in cands if c and allowed(c, diet, allergy)]
        if not cands:
            if role == "x":
                continue                     # добавку можно просто убрать
            return None
        out.append((role, cands[rot % len(cands)] if role == "x" else cands[0], g, lo, hi))
    return out


def _fit(slots, kcal_t: float, p_t: float, low_carb: bool) -> list[list]:
    """Граммы белка и гарнира: 2×2 система «калории и белок», потом зажим в разумные пределы.

    → [[продукт, граммы, мин, макс, роль]] — пределы нужны дневной доводке.
    """
    fixed = [[f, g, g, g, "x"] for role, f, g, *_ in slots if role == "x"]
    pr = next(((f, lo, hi) for role, f, g, lo, hi in slots if role == "p"), None)
    cr = next(((f, lo, hi) for role, f, g, lo, hi in slots if role == "c"), None)
    k0 = sum(f["kcal"] * g / 100 for f, g, *_ in fixed)
    p0 = sum(f["p"] * g / 100 for f, g, *_ in fixed)
    K, P = max(0.0, kcal_t - k0), max(0.0, p_t - p0)
    gp = gc = 0.0
    if pr and cr:
        a, b, c, d = pr[0]["kcal"] / 100, cr[0]["kcal"] / 100, pr[0]["p"] / 100, cr[0]["p"] / 100
        det = a * d - b * c
        if abs(det) > 1e-9:
            gp = (K * d - b * P) / det
            gc = (a * P - c * K) / det
        if gp <= 0 or gc <= 0:               # нерешаемо (гарнир белковее белка и т. п.) — сначала белок
            gp = P / c if c else pr[1]
            gc = (K - a * gp) / b if b else cr[1]
        gp = min(max(gp, pr[1]), pr[2])
        gc = cr[1] if low_carb else min(max((K - a * gp) / b if b else gc, cr[1]), cr[2])
    elif pr:
        gp = min(max(P / (pr[0]["p"] / 100 or 1), pr[1]), pr[2])
    out = []
    if pr:
        out.append([pr[0], gp, pr[1], pr[2], "p"])
    if cr:
        out.append([cr[0], gc, cr[1], cr[1] if low_carb else cr[2], "c"])
    return out + fixed


def _sum(rows, key: str) -> float:
    return sum(f[key] * g / 100 for f, g, *_ in rows)


def _adjust(rows: list[list], role: str, key: str, gap: float, stretch: float = 1.5) -> None:
    """Добрать (или убрать) `gap` по `key`, меняя граммы продуктов роли пропорционально их вкладу."""
    rows = [r for r in rows if r[4] == role and r[0][key] > 0]
    have = sum(r[0][key] * r[1] / 100 for r in rows)
    if not rows or have <= 0:
        return
    k = 1 + gap / have
    for r in rows:
        r[1] = min(max(r[1] * k, r[2]), r[3] * stretch)


def _round_g(g: float) -> int:
    step = 5 if g < 100 else 10
    return max(step, int(round(g / step) * step))


def fit_day(plan: list, target: dict, idx: food.Index, diet: str, allergy: list[str], stretch: float = 1.5) -> None:
    """Довести день до норм на месте: масло — под жиры, белковые продукты — под белок, гарниры — под калории.

    plan — [(приём, название, [[продукт, граммы, мин, макс, роль]])]. Общая часть плана по шаблонам и ИИ-рациона.
    """
    low_carb = diet in ("low_carb", "keto")
    kcal_t, p_t, f_t = float(target.get("kcal") or 2000), float(target.get("p") or 100), float(target.get("f") or 60)
    rows = [r for _, _, rs in plan for r in rs]
    # жиры: простые продукты постные, недостающее — маслом к обеду и ужину (до 15 г на приём)
    oil = next((f for n in ("Масло оливковое", "Масло подсолнечное") if (f := idx.match(n)) and allowed(f, diet, allergy)), None)
    fat_gap = f_t - _sum(rows, "f")
    if oil and fat_gap > 5:
        spots = [rs for meal, _, rs in plan if meal in ("lunch", "dinner", *(("breakfast",) if low_carb else ()))]
        cap = 30.0 if low_carb else 15.0
        for rs in spots:
            cur = next((r for r in rs if r[0]["name"] == oil["name"]), None)
            add = min(cap, fat_gap / len(spots) / (oil["f"] / 100))
            if cur:
                cur[1] = min(cap, cur[1] + add)
            else:
                rs.append([oil, add, 0, cap, "x"])
        rows = [r for _, _, rs in plan for r in rs]
    for _ in range(4):
        _adjust(rows, "p", "p", p_t - _sum(rows, "p"), stretch)
        if not low_carb:
            _adjust(rows, "c", "kcal", kcal_t - _sum(rows, "kcal"), stretch)
    if oil and low_carb:
        # при кето/низкоуглеводном калории добираем жиром, а не гарниром
        gap = kcal_t - _sum(rows, "kcal")
        for r in (r for r in rows if r[0]["name"] == oil["name"]):
            if gap <= 0:
                break
            add = min(30.0 - r[1], gap / (oil["kcal"] / 100))
            r[1] += add
            gap -= add * oil["kcal"] / 100


def build_day(target: dict, prof: dict, day: str, uid: str = "") -> dict:
    """План на день под нормы. Возвращает приёмы, суммы и отклонение от цели в процентах.

    Сначала каждый приём подгоняется под свою долю, потом день доводится целиком: масло — под жиры,
    гарниры — под калории, белковые продукты — под белок (несколько проходов, пределы порций растянуты
    в 1,5 раза). Цель — ±5 % по калориям и белку; если продуктов для этого мало, отклонение честно видно в diff_pct.
    """
    idx = food.Index()
    diet = prof.get("diet") or "normal"
    allergy = _allergy_words(prof.get("allergies") or "")
    low_carb = diet in ("low_carb", "keto")
    shares = SHARES_IF if diet in ("if_16_8", "if_18_6") else SHARES
    kcal_t, p_t = float(target.get("kcal") or 2000), float(target.get("p") or 100)
    plan = []
    for meal, share in shares.items():
        tpls = TEMPLATES[meal]
        start = _seed(uid, day, meal) % len(tpls)
        for k in range(len(tpls)):
            tpl = tpls[(start + k) % len(tpls)]
            slots = _resolve(tpl["slots"], idx, diet, allergy, _seed(day, meal, k))
            if slots:
                # название шаблона — только если продукты те же, что в нём задуманы
                same = all(f["name"] == names[0] or role == "x" for (role, f, *_), (_, names, *__) in zip(slots, tpl["slots"]))
                plan.append((meal, tpl["title"] if same else None, _fit(slots, kcal_t * share, p_t * share, low_carb)))
                break
    fit_day(plan, target, idx, diet, allergy, 2.0 if len(plan) <= 3 else 1.5)
    meals = []
    for meal, title, rs in plan:
        items = []
        for f, g, *_ in rs:
            if g >= 1:
                it = food.item_from(f, _round_g(g), f["name"], source="db")
                it.pop("text", None)
                items.append(it)
        meals.append({"meal": meal, "label": MEAL_LABEL[meal],
                      "title": title or ", ".join(i["name"].lower() for i in items[:3]).capitalize(),
                      "items": items, "totals": food.totals(items)})
    tot = food.totals([i for m in meals for i in m["items"]])
    diff = {k: round((tot[k] - float(target.get(k) or 0)) / float(target[k]) * 100) if target.get(k) else None
            for k in ("kcal", "p", "f", "c")}
    return {"date": day, "target": {k: target.get(k) for k in ("kcal", "p", "f", "c")}, "diet": diet,
            "meals": meals, "totals": tot, "diff_pct": diff}


@router.get("/api/mealplan/quick")
def mealplan_quick(day: str | None = None, days: int = 1, u=Depends(current_user)):
    uid = u["id"]
    t = userdata.latest_target(uid)
    if not t:
        raise HTTPException(400, "Сначала посчитайте нормы в профиле")
    prof = userdata.profile(uid)
    start = date.fromisoformat(day) if day else date.today()
    plans = [build_day(t["data"], prof, date.fromordinal(start.toordinal() + i).isoformat(), uid)
             for i in range(max(1, min(7, days)))]
    return plans[0] if len(plans) == 1 else {"days": plans}


# ── оценка дня питания ──

SWEET_GROUPS = {"сладости"}
FLOUR_RE = re.compile(r"хлеб белый|батон|булоч|круассан|пирож|пончик|печенье|торт|вафли|пряник|беляш|чебурек|самса|слойк", re.I)
ALCO_RE = re.compile(r"пиво(?! безалк)|вино|шампан|водка|коньяк|виски|ром|джин|сидр|апероль|мохито", re.I)
COFFEE_RE = re.compile(r"кофе|капучино|латте|раф|флэт", re.I)


def day_food_score(uid: str, day: str, target: dict | None = None) -> dict | None:
    """Оценка питания за день 0..100: калории к норме, белок, число приёмов, пищевые привычки.

    None — если за день ничего не записано (это не «плохо», это «нет данных»).
    """
    recs = [r for r in db.list_kind(uid, "food", day, day)]
    if not recs:
        return None
    target = target or (userdata.latest_target(uid) or {}).get("data") or {}
    goal = userdata.goal(uid)
    idx = food.Index()
    items = [i for r in recs for i in (r["data"].get("items") or [])]
    tot = food.totals(items)
    raw = sum(1 for r in recs if r["data"].get("status") != "calculated")
    flags, score = [], 0.0
    kt = target.get("kcal")
    if kt:
        dev = abs(tot["kcal"] - kt) / kt
        score += 40 * (1 if dev <= 0.10 else max(0.0, 1 - (dev - 0.10) / 0.30))
        if tot["kcal"] > kt * 1.15:
            flags.append("перебор калорий")
        elif tot["kcal"] < kt * 0.7:
            flags.append("сильный недобор калорий")
    else:
        score += 20
    pt = target.get("p")
    if pt:
        score += 30 * min(1.0, tot["p"] / pt)
        if tot["p"] < pt * 0.8:
            flags.append("мало белка")
    else:
        score += 15
    score += 15 * min(1.0, len(recs) / 3)
    habits = set(goal.get("habits") or [])
    hits = {"less_sugar": 0, "less_flour": 0, "less_alcohol": 0, "less_coffee": 0, "less_fastfood": 0}
    veg_g = 0.0
    for it in items:
        f = idx.match(it.get("name") or "") or {}
        g, n = f.get("group") or "", it.get("name") or ""
        if g in SWEET_GROUPS:
            hits["less_sugar"] += 1
        if FLOUR_RE.search(n):
            hits["less_flour"] += 1
        if ALCO_RE.search(n):
            hits["less_alcohol"] += 1
        if COFFEE_RE.search(n):
            hits["less_coffee"] += 1
        if g == "фастфуд":
            hits["less_fastfood"] += 1
        if g in ("овощи", "фрукты и ягоды"):
            veg_g += it.get("grams") or 0
    habit_pen = 0
    labels = {"less_sugar": "сладкое", "less_flour": "мучное", "less_alcohol": "алкоголь",
              "less_coffee": "кофе", "less_fastfood": "фастфуд"}
    for h, n in hits.items():
        limit = 2 if h == "less_coffee" else 0
        if h in habits and n > limit:
            habit_pen += 5
            flags.append(f"{labels[h]} при цели «меньше»")
    if "more_veg" in habits and veg_g < 400:
        habit_pen += 5
        flags.append("меньше 400 г овощей и фруктов")
    score += max(0, 15 - habit_pen)
    return {"date": day, "score": round(score), "totals": tot, "target": {k: target.get(k) for k in ("kcal", "p", "f", "c")},
            "meals": len(recs), "not_calculated": raw, "veg_g": round(veg_g), "habit_hits": hits, "flags": flags}


# ── рацион на день по слотам: проверка ответа ИИ (задача mealplan со slots, клиент — mealplan.js) ──
# Те же правила «здорового», что в app/static/mealplan.js (unhealthy): меняете там — меняйте здесь.
BAD_GROUPS = {"фастфуд", "сладости", "напитки", "соусы и приправы", "колбасы и полуфабрикаты", "готовые блюда"}
BAD_RE = re.compile(
    r"чипс|(?<![а-я])фри(?![а-я])|панировк|в кляре|глазир|сладк|с сахаром|сгущ|майонез|бекон|(?<![а-я])сало(?![а-я])|смалец|копч|"
    r"шоколад|торт|печенье|вафл|конфет|морожен|пирожн|сироп|варень|джем|к пиву|гейнер|маргарин|спред|кранч|гранол|сдоб|пончик|"
    r"булоч|круассан|батон|хлеб белый|хлеб пшеничн|тостов|быстрого приготовления|в масле|в томат|цукат|жарен|солен|с маслом|"
    r"сливочн|\(снек\)|шарики|хлопья кукуруз|кукурузные хлопья|хлопья для завтрака|манн|мука|крахмал|сухари|сушки|отбивн|фарш|"
    r"с сыром|с ветчиной|с беконом|бенедикт|фаршир|утк|гусь|сырок|творожн(ая|ый) (масса|десерт)|десерт|пудинг шок|"
    r"коктейль в бутылке|молочный коктейль|сливки|сметана 2|сметана 3|сыр плавлен|колбасн")
SPORT_OK_RE = re.compile(r"^(протеин|изолят сывороточного|казеин|соевый протеин|протеиновый батончик|протеиновый коктейль на (воде|молоке))")
STARCH_GROUPS = ("крупы", "макароны", "хлеб и выпечка")


def unhealthy(f: dict) -> str | None:
    """Почему продукт не годится в «здоровый» рацион (None — годится)."""
    g, n = f.get("group") or "", food.norm(f.get("name") or "")
    if g == "спортпит":
        return None if SPORT_OK_RE.search(n) else "спортпит"
    if g in BAD_GROUPS:
        return g
    if BAD_RE.search(n):
        return "способ приготовления или добавки"
    if food.is_alcohol(f.get("name") or "", g or None):
        return "алкоголь"
    return None


def _slot_role(f: dict) -> str:
    """p — белок (подгоняется под белок), c — гарнир (под калории), s — спортпит (порция как есть), x — остальное."""
    if f.get("group") == "спортпит":
        return "s"
    dens = f["p"] * 4 / f["kcal"] if f.get("kcal") else 0
    if dens >= 0.3:
        return "p"
    if f.get("group") in STARCH_GROUPS or (f.get("group") == "бобовые" and f.get("state") == "dry") or re.match(r"^(Картоф|Батат)", f["name"]):
        return "c"
    return "x"


def check_slot_items(items: list[dict], idx: food.Index, diet: str, allergy: list[str], exclude: set[str]) -> tuple[list[list], list[str]]:
    """Позиции (name, grams) → строки [продукт, граммы, роль] только из справочника, здоровые, по диете;
    вторым — что выброшено и почему (для честной пометки)."""
    rows, dropped = [], []
    for it in items or []:
        name = str(it.get("name") or "").strip()
        try:
            g = float(it.get("grams") or 0)
        except (TypeError, ValueError):
            g = 0
        if not name or g <= 0:
            continue
        f = idx.match(name)
        if not f:
            dropped.append(f"{name} — нет в справочнике")
            continue
        why = unhealthy(f)
        if why or not allowed(f, diet, allergy) or food.norm(f["name"]) in exclude:
            dropped.append(f"{f['name']} — {why or 'не подходит вашим ограничениям'}")
            continue
        if any(r[0]["id"] == f["id"] for r in rows):
            continue
        rows.append([f, min(g, 600.0), _slot_role(f)])
    return rows, dropped


def fit_slot(rows: list[list], tgt: dict) -> None:
    """Граммы под цель слота: белковые — под белок, гарниры — под оставшиеся калории; пределы — от 0,4 порции модели."""
    if not rows:
        return
    # модель часто занижает гарнир — ему даём больше простора (сухая крупа — до 120 г, готовое — до 350 г)
    def hi(f, g, role):
        if role == "c":
            return max(g * 2.5, 120.0 if f.get("state") == "dry" else 350.0)
        return max(g * 2, 220.0 if role == "p" else 60.0)
    bounds = [(g * 0.4, hi(f, g, role)) for f, g, role in rows]
    p_t, k_t = float(tgt.get("p") or 0), float(tgt.get("kcal") or 0)
    for _ in range(12):
        for role, key, want in (("p", "p", p_t), ("c", "kcal", k_t)):
            mine = [i for i, r in enumerate(rows) if r[2] == role and r[0].get(key)]
            if not mine or want <= 0:
                continue
            others = sum(r[0][key] * r[1] / 100 for i, r in enumerate(rows) if i not in mine)
            have = sum(rows[i][0][key] * rows[i][1] / 100 for i in mine) or 1
            k = max(0.0, want - others) / have
            for i in mine:
                lo, hi = bounds[i]
                rows[i][1] = min(max(rows[i][1] * k, lo), hi)


def slot_items(rows: list[list]) -> list[dict]:
    out = []
    for f, g, role in rows:
        grams = _round_g(g) if role != "s" else round(g)
        piece = (f.get("portions") or {}).get("шт")
        if piece and f.get("group") in ("яйца", "фрукты и ягоды", "спортпит"):
            grams = int(max(1, round(g / piece)) * piece)
        it = food.item_from(f, grams, f["name"], "db")
        it.pop("text", None)
        if role == "s":
            it["optional"] = True
        out.append(it)
    return out
