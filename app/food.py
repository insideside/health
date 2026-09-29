"""Разбор записей о еде: «гречка 200г, 2 яйца, кофе с молоком».

Сначала без ИИ: делим текст на куски, в каждом ищем количество и единицу, название —
в справочнике. Если распознано всё — ИИ не нужен. Нераспознанные куски уходят в ИИ
(ai/jobs.py), и её ответ снова сверяется со справочником через `match()`.
"""
import difflib
import re

from . import db

UNITS = [
    (r"кг|килограмм\w*", "kg"), (r"г|гр|грамм\w*", "g"), (r"мл|миллилитр\w*", "ml"), (r"л|литр\w*", "l"),
    (r"шт\w*|штук\w*", "шт"), (r"ст\.?\s?л\.?|столов\w+\s+лож\w*", "ст.л."), (r"ч\.?\s?л\.?|чайн\w+\s+лож\w*", "ч.л."),
    (r"стакан\w*", "стакан"), (r"чашк\w*|чашек", "чашка"), (r"ломтик\w*|ломт\w*", "ломтик"),
    (r"кус\w*", "кусок"), (r"тарел\w*", "тарелка"), (r"порци\w*", "порция"), (r"горст\w*", "горсть"),
]
UNIT_RE = "|".join(f"(?:{p})" for p, _ in UNITS)
WORD_NUM = {"пол": 0.5, "половина": 0.5, "половинка": 0.5, "один": 1, "одна": 1, "одно": 1, "два": 2, "две": 2,
            "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "полтора": 1.5, "полторы": 1.5}
QTY_RE = re.compile(
    rf"(?<![\w.,])(?P<n>\d+(?:[.,]\d+)?|{'|'.join(WORD_NUM)})(?![.,]?\d)\s*(?P<u>{UNIT_RE})?(?=$|[\s.,)])", re.I)

BARE_UNIT_RE = re.compile(
    r"(?<!\w)(?:стакан\w*|чашк\w*|тарел\w*|кус\w*|ломтик\w*|порци\w*|горст\w*|ст\.\s?л\.?|ч\.\s?л\.?)(?!\w)", re.I)


def norm(s: str) -> str:
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[^\w\s%.-]", " ", s)
    return re.sub(r"\s+", " ", s).strip(" .-")


def unit_code(u: str | None) -> str | None:
    if not u:
        return None
    for pat, code in UNITS:
        if re.fullmatch(pat, u.strip(), re.I):
            return code
    return None


# точка после количества или слова - конец продукта: «хлеб 25 гр. форель 50 г», «кофе. молоко» (но не «1 ст. л.»)
QTY_DOT_RE = re.compile(r"(\d\s*(?:г|гр|грамм\w*|кг|мл|л|шт|штук\w*)?|[^\W\d_]{3,})\.\s+(?=[^\W_])", re.I)


def split(text: str) -> list[str]:
    # запятая внутри числа («молоко 1,5%») — не разделитель
    text = QTY_DOT_RE.sub(r"\1, ", text or "")
    parts = re.split(r"(?<!\d),|,(?!\d)|[;\n+]|\s+и\s+(?=\d)", text)
    return [p.strip() for p in parts if p and p.strip()]


def parse_chunk(chunk: str) -> tuple[str, float | None, str | None]:
    """→ (название, количество, единица). Количество None, если не указано."""
    m = QTY_RE.search(chunk)
    if not m:
        # «тарелка борща», «стакан кефира» — единица без числа значит одну штуку
        u = BARE_UNIT_RE.search(chunk)
        if u:
            return norm(chunk[:u.start()] + " " + chunk[u.end():]), 1, unit_code(u.group(0))
        return norm(chunk), None, None
    raw = m.group("n").lower().replace(",", ".")
    n = WORD_NUM.get(raw) or float(raw)
    name = norm(chunk[:m.start()] + " " + chunk[m.end():])
    return name, n, unit_code(m.group("u"))


ENDINGS = sorted(["ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ой", "ей", "ий", "ый", "ая", "яя", "ое", "ее",
                  "ую", "юю", "ом", "ем", "ам", "ям", "ах", "ях", "ов", "ев", "а", "я", "ы", "и", "у", "ю", "е", "о", "ь"],
                 key=len, reverse=True)


def stem(name: str) -> str:
    """Грубый стеммер: «тарелка борща» и «борщ» дают одну основу. Короткие слова не трогаем."""
    out = []
    for w in norm(name).split():
        if len(w) > 3:
            for e in ENDINGS:
                if w.endswith(e) and len(w) - len(e) >= 3:
                    w = w[:-len(e)]
                    break
        out.append(w)
    return " ".join(out)


# слова состояния: «гречка сухая», «рис варёный» — если в тексте есть, выбор состояния сделал человек
STATE_WORDS = re.compile(r"\b(сух\w*|сыр(ой|ая|ое|ые|ом|ую)|вар[её]н\w*|отварн\w*|готов\w*|жарен\w*|запеч[её]н\w*|"
                         r"тушен\w*|на пару|крупа|хлопь\w*|каш\w+|свеж\w*)\b", re.I)


def base_name(name: str) -> str:
    """Название без состояния: «Гречка варёная» и «Гречка сырая» → «гречк»."""
    return stem(STATE_WORDS.sub(" ", norm(name)))


class Index:
    def __init__(self, uid: str | None = None):
        self.foods = db.all_foods()
        self.by_id = {f["id"]: f for f in self.foods}
        self.keys: dict[str, dict] = {}
        self.stems: dict[str, dict] = {}
        self.bases: dict[str, list[dict]] = {}
        self.fuzzy: list[str] = []          # нечёткое сравнение - без товаров из магазина (их 15 тыс., бренды не угадываем)
        for f in self.foods:
            for k in [f["name"], *f["aliases"], *([f"{f['brand']} {f['name']}"] if f.get("brand") else [])]:
                nk = norm(k)
                if nk not in self.keys and f.get("source") != "off":
                    self.fuzzy.append(nk)
                self.keys.setdefault(nk, f)
                self.stems.setdefault(stem(k), f)
            self.bases.setdefault(base_name(f["name"]), []).append(f)
        self.usage = usage(uid, self) if uid else {}

    def _raw_match(self, name: str) -> dict | None:
        if name in self.keys:
            return self.keys[name]
        if stem(name) in self.stems:
            return self.stems[stem(name)]
        close = difflib.get_close_matches(name, self.fuzzy, n=1, cutoff=0.86)
        return self.keys[close[0]] if close else None

    def match(self, name: str) -> dict | None:
        name = norm(name)
        if not name:
            return None
        f = self._raw_match(name)
        if f and self.usage and not STATE_WORDS.search(name):
            f = self.prefer_used(f)
        return f

    def siblings(self, f: dict) -> list[dict]:
        """Тот же продукт в других состояниях (сухой / варёный)."""
        return [x for x in self.bases.get(base_name(f["name"]), []) if x["id"] != f["id"] and x.get("state") != f.get("state")]

    def prefer_used(self, f: dict) -> dict:
        """«гречка 80 г» без слова о состоянии: если человек обычно пишет сухую — берём сухую."""
        mine = self.usage.get(f["id"], {}).get("count", 0)
        best = max(self.siblings(f), key=lambda x: self.usage.get(x["id"], {}).get("count", 0), default=None)
        if best and self.usage.get(best["id"], {}).get("count", 0) > mine:
            return best
        return f


def usage(uid: str, idx: "Index | None" = None, days: int = 180) -> dict[int, dict]:
    """История человека по записям еды: food_id → {count, last_grams, last_used (дата)}.
    Старые позиции без food_id сопоставляются по названию."""
    from datetime import date, timedelta
    since = (date.today() - timedelta(days=days)).isoformat()
    out: dict[int, dict] = {}
    keys = idx.keys if idx else None
    for rec in db.list_kind(uid, "food", since):
        for it in rec["data"].get("items") or []:
            fid = it.get("food_id")
            if not isinstance(fid, int):
                if keys is None:
                    keys = {norm(f["name"]): f for f in db.all_foods()}
                f = keys.get(norm(it.get("name") or ""))
                fid = f["id"] if f else None
            if not fid:
                continue
            u = out.setdefault(fid, {"count": 0, "last_grams": None, "last_used": ""})
            u["count"] += 1
            if (rec["date"] or "") >= u["last_used"]:
                u["last_used"] = rec["date"] or ""
                u["last_grams"] = it.get("grams")
    return out


def grams_for(food: dict, n: float | None, unit: str | None) -> float | None:
    portions = food.get("portions") or {}
    if unit in ("g", "ml"):
        return n
    if unit in ("kg", "l"):
        return n * 1000
    if n is None:
        for u in ("порция", "шт", "чашка", "стакан", "тарелка", "кусок"):
            if u in portions:
                return portions[u]
        return None
    if unit is None:
        # «2 яйца» — штуки; «гречка 200» — граммы
        if n > 20:
            return n
        if "шт" in portions:
            return n * portions["шт"]
        return None
    if unit in portions:
        return n * portions[unit]
    return None


def item_from(food: dict, grams: float, text: str, source: str = "db") -> dict:
    k = grams / 100
    out = {"text": text, "name": food["name"], "grams": round(grams),
           "kcal": round(food["kcal"] * k), "p": round(food["p"] * k, 1),
           "f": round(food["f"] * k, 1), "c": round(food["c"] * k, 1), "source": source}
    if food.get("id"):
        out["food_id"] = food["id"]
    if food.get("state"):
        out["state"] = food["state"]
    return out


def quick_parse(text: str, idx: Index | None = None) -> tuple[list[dict], list[str]]:
    """→ (распознанные позиции, нераспознанные куски)."""
    idx = idx or Index()
    done, rest = [], []
    for chunk in split(text):
        name, n, unit = parse_chunk(chunk)
        food = idx.match(name)
        grams = grams_for(food, n, unit) if food else None
        if food and grams:
            done.append(item_from(food, grams, chunk))
        else:
            rest.append(chunk)
    return done, rest


def totals(items: list[dict]) -> dict:
    return {k: round(sum(i.get(k) or 0 for i in items), 1 if k != "kcal" else 0) for k in ("kcal", "p", "f", "c")}


def apply_preferences(items: list[dict], uid: str, idx: Index | None = None) -> list[dict]:
    """Позиции, распознанные без учёта истории (быстрый разбор): если в тексте нет слова о состоянии,
    а человек обычно ест этот продукт в другом состоянии — пересчитать по нему."""
    idx = idx if idx is not None and idx.usage else Index(uid)
    if not idx.usage:
        return items
    out = []
    for it in items:
        f = idx.by_id.get(it.get("food_id"))
        if f and it.get("source") == "db" and not STATE_WORDS.search(norm(it.get("text") or "")):
            g = idx.prefer_used(f)
            if g is not f:
                it = item_from(g, it["grams"], it.get("text") or g["name"], it.get("source", "db"))
        out.append(it)
    return out


# ── проверка значений на 100 г ──

STATE_RU = {"dry": "сухой (до варки)", "raw": "сырой", "cooked": "готовый", "as_sold": "как продаётся", "fresh": "свежий"}
GRAIN_RE = re.compile(r"^(греч|рис\b|овсян|геркулес|пшено|пшенн|булгур|киноа|перлов|ячнев|кускус|манк|крупа|полба|"
                      r"макарон|спагет|паста\b|лапш|вермишел|фасоль|чечевиц|нут\b|горох|маш\b)", re.I)
DRIED_RE = re.compile(r"сушен|сушён|вялен|сухофрукт|изюм|кураг|урюк|финик|чернослив|инжир сух|чипс|сублим|годжи|цукат", re.I)
ALCOHOL_RE = re.compile(r"пив|\bэль\b|лагер|стаут|ipa|вин[оа]\b|винн|водк|коньяк|виски|бренди|бурбон|\bром\b|текил|джин|вермут|саке|"
                        r"настойк|наливк|ликер|ликёр|сидр|шампан|игрист|глинтвейн|коктейл|мохито|маргарит|апероль|отв[её]ртк|"
                        r"лонг-айленд|белый русский|кровавая|космополитен|пина колад|абсент|самбук|бальзам|медовух|портвейн|херес|"
                        r"граппа|кальвадос|алког", re.I)
NOT_GRAIN_RE = re.compile(r"быстрого|гранол|мюсли|кранч|батончик|хлебц|суп|каша на молоке|с ", re.I)


def energy_mismatch(kcal: float, p: float, f: float, c: float, fiber: float = 0) -> float | None:
    """Отклонение калорий от 4б + 4у + 9ж (+2 ккал/г клетчатки, если известна) в долях (0.3 = 30 %);
    None — если значения слишком малы для проверки."""
    est = 4 * p + 4 * c + 9 * f + 2 * fiber
    if max(kcal, est) < 25:
        return None
    return abs(kcal - est) / max(kcal, est, 1)


def is_alcohol(name: str, group: str | None = None) -> bool:
    return group in (None, "напитки") and bool(ALCOHOL_RE.search(norm(name)))


NOT_GRAIN_RE = re.compile(r"молок|латте|капучино|флэт|раф\b|кофе|суп|хлеб|печень|батон|булк|пирог|пицц|"
                          r"паст[аы] (томат|шокол|арахис|миндал|кунжут|ореш)|(томатн|шоколадн|арахисов|миндальн)\w* паст|"
                          r"гранол|мюсли|кранч|хлопья|батончик|йогурт|греческ", re.I)
NOT_VEG_RE = re.compile(r"авокадо|оливк|маслин|картоф|батат|жарен|жарен|чеснок|хрен|имбир|кукуруз|горох|фасоль сух|сушен", re.I)


def kind_of(name: str, group: str | None) -> str | None:
    """Вид продукта для проверки диапазонов. Сначала группа из справочника — ей можно верить;
    по названию угадываем только свои продукты без группы (иначе «йогурт греческий» — это гречка,
    а «инжир» — жир)."""
    n = norm(name)
    g = (group or "").lower()
    if DRIED_RE.search(n):
        return None
    if g:
        if g == "жиры и масла":
            if "сливоч" in n:
                return "butter"
            return "oil" if re.search(r"\bмасло\b", n) else None
        if g in ("крупы", "макароны", "бобовые"):
            return None if NOT_GRAIN_RE.search(n) else "grain"
        if g == "овощи":
            return None if NOT_VEG_RE.search(n) else "veg"
        if g == "фрукты и ягоды":
            return None if re.search(r"кокос|авокадо", n) else "fruit"
        if g == "орехи и семена":
            return None if re.search(r"каштан", n) else "nuts"
        return None
    if re.search(r"\bмасло (подсол|оливк|растит|льнян|кокос|кукуруз|рапс)|^масло$|\bмасло растительное", n) and "сливоч" not in n:
        return "oil"
    if "сливоч" in n and "масло" in n:
        return "butter"
    if GRAIN_RE.search(n) and not NOT_GRAIN_RE.search(n):
        return "grain"
    if re.search(r"\b(орех|миндал|фундук|кешью|арахис|семечк|семена)", n) and not re.search(r"молок|латте|капучино|паст|круассан", n):
        return "nuts"
    return None


# правдоподобные ккал на 100 г: (вид, состояние) → (мин, макс); состояние None — любое
RANGES = {
    ("grain", "dry"): (280, 470), ("grain", "cooked"): (60, 220),
    ("veg", None): (5, 120), ("fruit", None): (10, 170), ("oil", None): (850, 910), ("butter", None): (600, 760),
    ("nuts", None): (350, 720),
}


def sanity(name: str, state: str | None, group: str | None, v: dict, cooked_ratio: float | None = None) -> list[str]:
    """Предупреждения по значениям на 100 г: энергия против БЖУ, сумма БЖУ, диапазоны по виду и состоянию."""
    w = []
    kcal, p, f, c = (float(v.get(k) or 0) for k in ("kcal", "p", "f", "c"))
    if min(kcal, p, f, c) < 0:
        w.append("Отрицательные значения — так не бывает.")
    if kcal > 910:
        w.append("Больше 900 ккал на 100 г не бывает даже у масла — похоже, это не на 100 г.")
    if p + f + c > 102:
        w.append(f"Белков, жиров и углеводов в сумме {p + f + c:.0f} г на 100 г — больше 100 г, значения, видимо, на порцию или упаковку.")
    mm = energy_mismatch(kcal, p, f, c)
    est = 4 * p + 4 * c + 9 * f
    # алкоголь (7 ккал/г) не входит в БЖУ: у напитков лишняя энергия — это он, а не ошибка
    alcohol = is_alcohol(name, group) or (group == "напитки" and kcal > est)
    if mm is not None and mm > 0.25 and not alcohol:
        w.append(f"Калории ({kcal:.0f}) не сходятся с БЖУ: 4·Б + 4·У + 9·Ж ≈ {4 * p + 4 * c + 9 * f:.0f} ккал.")
    k = kind_of(name, group)
    rng = RANGES.get((k, state)) or RANGES.get((k, None)) if k != "grain" or state in ("dry", "cooked") else None
    if k == "grain" and state == "dry" and kcal and kcal < 220:
        est = f" (сухая ≈ {kcal * cooked_ratio:.0f} ккал)" if cooked_ratio else ""
        w.append(f"{kcal:.0f} ккал — это похоже на значения для готовой (варёной) крупы, а нужна сухая: обычно 300–380 ккал на 100 г{est}.")
    elif k == "grain" and state == "cooked" and kcal > 250:
        w.append(f"{kcal:.0f} ккал — похоже на сухую крупу, а нужна готовая: обычно 80–180 ккал на 100 г.")
    elif rng and kcal and not (rng[0] <= kcal <= rng[1]):
        what = {"veg": "овощей", "fruit": "фруктов и ягод", "oil": "растительного масла", "butter": "сливочного масла",
                "nuts": "орехов и семян", "grain": "круп и макарон"}[k]
        st = f" ({STATE_RU.get(state, state)})" if state and (k, state) in RANGES else ""
        w.append(f"Для {what}{st} обычно {rng[0]}–{rng[1]} ккал на 100 г, здесь {kcal:.0f}.")
    return w
