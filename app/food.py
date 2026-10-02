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


# продолжение предыдущего продукта после запятой: «2 куриных ножки, запечённых с оливками», «кофе, на молоке»
CONT_RE = re.compile(r"^(?:(?:с|со|в|во|на|под|без|из|по)\s|[а-яё]+(?:нн|енн|анн|ённ)[а-яё]{1,3}(?:\s|$))", re.I)


# ── явные КБЖУ/БЖУ в тексте: «курица 200г 250/30/5/10», «250/30/5/10 курица 200г», «кбжу: 250/30/5/10» ──
# 4 числа — калории/белки/жиры/углеводы по порядку (как принято писать); 3 — белки/жиры/углеводы, калории считаем.
# Числа относятся к продукту, рядом с которым стоят (в том же куске или в соседнем, если написаны отдельной строкой),
# и это значения на 100 г продукта (как в справочниках питания) - итог в БЖУ приёма пищи считаем на реально
# указанный вес (грамм рядом, иначе по умолчанию); продукта ещё нет в справочнике - запоминаем в нём как есть (per_100).
NUM = r"\d+(?:[.,]\d+)?"
# число, за которым сразу (без разделителя-цифры) не идёт единица веса - иначе это не значение КБЖУ, а вес
# продукта: «…17.9, 170г» (запятая перед весом, как ещё один разделитель списка) не должно принять «170» за
# 4-е число КБЖУ
NUM_STRICT = r"\d++(?:[.,]\d++)?+(?!\s*(?:кг|км|г|гр|грамм\w*|мл|л|литр\w*)\b)"
MACRO_LABEL_RE = re.compile(r"(?:^|\s)(?:кбжу|бжу)\s*:?(?=\s|$)", re.I)
# числа КБЖУ подряд: через / \ (без пробелов вокруг не обязательно) или через запятую с пробелом после -
# «191, 12.5, 11.83, 8.97»; запятая без пробела после («12,5») — десятичная, не разделитель, её не трогаем
SEP = r"(?:\s*[/\\]\s*|,\s+)"
MACRO_SLASH_RE = re.compile(
    rf"(?<![\d.,/\\])({NUM_STRICT}){SEP}({NUM_STRICT}){SEP}({NUM_STRICT})(?:{SEP}({NUM_STRICT}))?"
    rf"(?!\d|\.)(?!{SEP}{NUM_STRICT})")
# кусок целиком - только числа через пробел (после разбиения по ;/переносам строк так остаётся, если КБЖУ
# написаны отдельной строкой без названия рядом, «Курица\n250 30 5 10»): здесь пробел без / \ , тоже разделитель
MACRO_WHOLE_RE = re.compile(rf"^\s*(?:кбжу|бжу)?\s*:?\s*({NUM_STRICT})[\s/\\]+({NUM_STRICT})[\s/\\]+({NUM_STRICT})(?:[\s/\\]+({NUM_STRICT}))?\s*$", re.I)


def _macro_from(nums: list[float]) -> dict:
    if len(nums) == 4:
        kcal, p, f, c = nums
    else:
        p, f, c = nums
        kcal = 4 * p + 9 * f + 4 * c
    return {"kcal": round(kcal), "p": round(p, 1), "f": round(f, 1), "c": round(c, 1)}


# запятая-разделитель списка (не десятичная: «12,5»)
# запятая внутри скобок - тоже нет: «шарлотка (яблоки, яйца, мука) 180 г» - состав одного блюда
IN_PAREN = r"(?![^()]*\))"
WEAK_COMMA_RE = re.compile(rf"(?<!\d),{IN_PAREN}|,(?!\d){IN_PAREN}")
# кусок - только количество: «200г», «- 30 гр.», «1 шт» (хвост к блюду с КБЖУ, а не отдельное блюдо)
BARE_QTY_RE = re.compile(r"^[\s\-–(]*\d+(?:[.,]\d+)?\s*(?:г|гр|грамм\w*|кг|мл|л|шт|штук\w*)?\.?[\s)]*$", re.I)
PH_RE = re.compile(r"\x00(\d+)\x00")


def _has_qty(piece: str) -> bool:
    return bool(QTY_RE.search(piece) or BARE_UNIT_RE.search(piece))


def split_macro_segment(seg: str) -> list[tuple[str, dict | None]] | None:
    """Кусок текста (между ;/переносами строк) с явными КБЖУ → [(название блюда, КБЖУ | None), …].
    К блюду с КБЖУ относится: кусок списка, где стоят числа, соседние куски перед ним БЕЗ своего количества
    (части составного блюда: «рис с креветками, яйцом и луком фри кбжу …») и куски после него, где только
    количество («…кбжу 250/30/5/10, 200г»). Куски со своим количеством («слива 72 гр.») - отдельные продукты:
    они возвращаются с КБЖУ None и дальше разбираются по справочнику. Нет чисел вовсе - None."""
    whole = MACRO_WHOLE_RE.match(seg)
    if whole:
        return [("", _macro_from([float(x.replace(",", ".")) for x in whole.groups() if x]))]
    ms = list(MACRO_SLASH_RE.finditer(seg))
    if not ms:
        return None
    macros = [_macro_from([float(x.replace(",", ".")) for x in m.groups() if x]) for m in ms]
    # числа КБЖУ сами бывают через «, » - прячем их, прежде чем делить список по запятым
    ph, last = "", 0
    for i, m in enumerate(ms):
        ph += seg[last:m.start()] + f"\x00{i}\x00"
        last = m.end()
    ph += seg[last:]
    pieces = [p for p in WEAK_COMMA_RE.split(ph)]
    clean = lambda t: re.sub(r"\s+", " ", MACRO_LABEL_RE.sub(" ", t)).strip(" ,")
    out: list[tuple[str, dict | None]] = []
    pending: list[str] = []
    k = 0
    while k < len(pieces):
        piece = pieces[k]
        marks = list(PH_RE.finditer(piece))
        if not marks:
            pending.append(piece)
            k += 1
            continue
        # части составного блюда перед числами - куски без своего количества
        take: list[str] = []
        while pending and pending[-1].strip() and not _has_qty(pending[-1]):
            take.insert(0, pending.pop())
        # в куске только «кбжу …» без названия: блюдо - предыдущий кусок («курица 200г, кбжу 250/30/5/10»)
        if not clean(PH_RE.sub(" ", piece)) and not take and pending:
            take = [pending.pop()]
        rest = ", ".join(x for x in pending if x.strip())
        if rest:
            out.append((rest.strip(), None))
        pending = []
        # хвост: следующие куски, где только количество
        tail: list[str] = []
        j = k + 1
        while j < len(pieces) and not PH_RE.search(pieces[j]) and BARE_QTY_RE.match(pieces[j]):
            tail.append(pieces[j])
            j += 1
        # несколько КБЖУ в одном куске без запятой между ними: текст между числами - начало следующего блюда
        cuts = [0] + [m.end() for m in marks]
        for n, m in enumerate(marks):
            head = piece[cuts[n]:m.start()]
            after = piece[m.end():marks[n + 1].start()] if n + 1 < len(marks) else piece[m.end():]
            parts = (take if n == 0 else []) + [head + " " + after] + ([] if n + 1 < len(marks) else tail)
            if n + 1 < len(marks):
                # между двумя КБЖУ без запятой: вес сразу после чисел - этому блюду, остальное - следующему
                q = re.match(r"^[\s\-–)]*\d+(?:[.,]\d+)?\s*(?:г|гр|грамм\w*|кг|мл|л|шт)?\.?", after, re.I)
                parts = (take if n == 0 else []) + [head + " " + (q.group(0) if q else "")]
                if q:
                    cuts[n + 1] = m.end() + len(q.group(0))
            out.append((clean(", ".join(x for x in parts if x.strip())), macros[int(m.group(1))]))
        k = j
    rest = ", ".join(x for x in pending if x.strip())
    if rest:
        out.append((rest.strip(), None))
    return out


def macro_annotate(chunks: list[str]) -> list[tuple[str, dict | None]]:
    """Куски текста → [(кусок без КБЖУ, КБЖУ-числа для него | None)], по одной паре на каждое найденное КБЖУ -
    один кусок может дать и несколько пар (см. split_macro_segment). КБЖУ без названия рядом (своя строка,
    цифры отдельно) приклеиваются к соседней паре — сначала к предыдущей, иначе к следующей."""
    parsed: list[tuple[str, dict | None]] = []
    for c in chunks:
        entries = split_macro_segment(c)
        parsed.extend(entries if entries is not None else [(c, None)])
    out: list[list] = [[name, macro] for name, macro in parsed]
    for i, (name, macro) in enumerate(parsed):
        if name or macro is None:
            continue
        for j in (i - 1, i + 1):
            if 0 <= j < len(out) and out[j][0] and out[j][1] is None:
                out[j][1] = macro
                break
    # пустое название, не приклеившееся к соседу (цифры сами по себе, без блюда рядом), — отбрасываем
    return [(name, macro) for name, macro in out if name]


def split_strong(text: str) -> list[str]:
    """Границы между заведомо разными блюдами: точка с запятой, перенос строки, «+». Запятая внутри —
    слабая граница (см. split): у составного блюда через запятую часто перечислены его части
    («рис с креветками, яйцом и луком»), а не отдельные блюда."""
    text = QTY_DOT_RE.sub(r"\1, ", text or "")   # запятая внутри числа («молоко 1,5%») уже защищена этим шагом
    return [p.strip() for p in re.split(r"[;\n]|\+(?![^()]*\))", text) if p and p.strip()]


def split(text: str) -> list[str]:
    return [c for seg in split_strong(text) for c in split_weak(seg)]


def split_weak(text: str) -> list[str]:
    """Один кусок «между точками с запятой» → отдельные продукты: по запятой и «и» перед числом."""
    parts = [p.strip() for p in re.split(rf"(?<!\d),{IN_PAREN}|,(?!\d){IN_PAREN}|\s+и\s+(?=\d){IN_PAREN}", text) if p and p.strip()]
    out: list[str] = []
    for p in parts:
        # кусок без количества, который начинается с предлога или причастия, - уточнение предыдущего продукта
        if out and not QTY_RE.search(p) and not BARE_UNIT_RE.search(p) and CONT_RE.match(p):
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return [q for p in out for q in split_two(p)]


def split_two(p: str) -> list[str]:
    """Два количества с единицами в одном куске: «творог 200 г со сметаной 20 г» → «творог 200 г», «сметаной 20 г»."""
    ms = [m for m in QTY_RE.finditer(p) if m.group("u")]
    if len(ms) < 2:
        return [p]
    gap = p[ms[0].end():ms[1].start()]
    j = [m for m in re.finditer(r"\s(?:с|со|и|плюс)\s", gap, re.I)]
    if not j:
        return [p]
    cut = ms[0].end() + j[-1].start()
    return [p[:cut].strip(), *split_two(p[ms[0].end() + j[-1].end():].strip())]


# уточнения, которые мешают найти продукт: «(это в сухом виде)», «сорта богатырь», «марки …»
PAREN_RE = re.compile(r"\(([^)]*)\)")
QUALIFIER_RE = re.compile(r"\b(?:сорта|сорт|марки|фирмы|бренда|производства)\s+[\w-]+", re.I)
WITHOUT_RE = re.compile(r"\bбез\s+[\w-]+", re.I)
# «… с оливками»: добавка к блюду без своего количества - отдельный продукт, если блюдо её не покрывает
WITH_RE = re.compile(r"\s(?:с|со|плюс)\s+(.+)$", re.I)
SMALL_RE = re.compile(r"\b(?:немного|немножко|чуть-чуть|чуть|щепотк\w*|несколько листьев|пар[ау] листьев)\b", re.I)
STATE_HINT = [(r"сух", "сухой"), (r"сыр(ой|ая|ое|ом|ом виде)", "сырой"), (r"вар[её]н|отварн", "варёный"),
              (r"запеч", "запечённый"), (r"жарен", "жареный"), (r"готов", "готовый")]


# Яйца по категориям (ГОСТ 31654-2012, масса с скорлупой): СВ от 75 г, С0 65-74,9, С1 55-64,9, С2 45-54,9, С3 35-44,9.
# Съедобная часть - около 88 % (скорлупа ≈ 12 %): середина категории × 0,88. Без категории - 50 г из справочника.
EGG_G = {"В": 69, "0": 61, "1": 53, "2": 44, "3": 35}
EGG_RE = re.compile(r"яйц|яиц|яичн", re.I)
# «С0», «C1», «СО» (буква вместо нуля), «СВ» - латиница и кириллица, без пробела внутри
EGG_CAT_RE = re.compile(r"(?<![^\W\d_])[сc]\s?([0-3оoвvbB])(?![^\W\d_])", re.I)
# куриное яйцо (в том числе товар из магазина «Яйцо окское С1»): вес штуки - по категории; перепелиные, утиные,
# шоколадные, блюда из яиц - нет (как foods.isChickenEgg на клиенте)
CHICKEN_EGG = re.compile(r"^(яйц|яичница-глазунья)", re.I)
NOT_CHICKEN = re.compile(r"перепел|утин|гусин|страус|индюш|шоколад|киндер|фарширов|бенедикт|порошок|белок|желток|сюрприз", re.I)
EGG_PLAIN_G = 50


def is_chicken_egg(name: str) -> bool:
    return bool(CHICKEN_EGG.search(name or "")) and not NOT_CHICKEN.search(name or "")


def egg_category(chunk: str) -> str | None:
    """«яйцо С0 2 шт» → "0"; нет яиц или категории - None."""
    if not EGG_RE.search(chunk or ""):
        return None
    m = EGG_CAT_RE.search(chunk)
    if not m:
        return None
    c = m.group(1).lower()
    return "0" if c in "оo0" else "В" if c in "вvb" else c


def piece_of(food: dict | None, chunk: str = "", pieces: dict | None = None) -> float | None:
    """Вес 1 шт для записи: категория яйца из текста, из названия продукта; личный вес (profile.pieces);
    справочник (portions.шт); куриное яйцо без категории - 50 г. Как foods.pieceOf на клиенте."""
    if not food:
        return None
    egg = is_chicken_egg(food.get("name") or "")
    cat = (egg_category(chunk) or egg_category(food.get("name") or "")) if egg else None
    if cat:
        return EGG_G[cat]
    own = (pieces or {}).get(str(food.get("id")))
    if own and float(own) > 0:
        return float(own)
    base = (food.get("portions") or {}).get("шт")
    if base:
        return base
    return EGG_PLAIN_G if egg else None


def with_piece(food: dict | None, chunk: str, pieces: dict | None = None) -> dict | None:
    """Копия продукта с piece_g, если вес штуки для этой записи отличается от справочного."""
    if not food:
        return food
    g = piece_of(food, chunk, pieces)
    return {**food, "piece_g": g} if g and g != (food.get("portions") or {}).get("шт") else food


def pieces_of(uid: str | None) -> dict:
    """Личный вес штуки: {id продукта: граммы} из профиля (окно продукта в записи еды)."""
    if not uid:
        return {}
    try:
        from . import userdata
        return (userdata.profile(uid) or {}).get("pieces") or {}
    except Exception:
        return {}


def composite(chunk: str) -> bool:
    """В скобках перечислен состав («шарлотка (яблоки, яйца, мука, сахар) 180 г»): блюдо из нескольких продуктов,
    вес после скобок - на всё блюдо. Такое понимает только ИИ: по справочнику нашлось бы одно слово вне скобок.
    Скобки с состоянием («(в сухом виде)») - не состав."""
    for inner in PAREN_RE.findall(chunk or ""):
        if any(re.search(pat, inner, re.I) for pat, _ in STATE_HINT):
            continue
        if len([w for w in re.split(r",|\s+и\s+|\s*\+\s*", inner) if re.search(r"[^\W\d_]{2,}", w)]) >= 2:
            return True
    return False


def prepare(chunk: str) -> tuple[str, bool]:
    """→ (кусок для разбора, «немного»). Состояние из скобок важнее слов снаружи: «рис отварной 40 г (в сухом виде)» - сухой."""
    hint = None
    for inner in PAREN_RE.findall(chunk):
        for pat, word in STATE_HINT:
            if re.search(pat, inner, re.I):
                hint = word
                break
    text = PAREN_RE.sub(" ", chunk)
    if hint:
        text = STATE_WORDS.sub(" ", text) + " " + hint
    text = QUALIFIER_RE.sub(" ", text)
    text = WITHOUT_RE.sub(" ", text)            # «без сахара», «без масла» - не продукт
    if EGG_RE.search(text):                     # «яйцо С0» - категория идёт в вес штуки (with_piece), не в название
        text = EGG_CAT_RE.sub(" ", text)
    text = re.sub(r"\s[-–]\s", " ", text)        # «яйцо С0 - 1 шт»: одиночное тире между словами - не часть названия
    small = bool(SMALL_RE.search(text)) and not QTY_RE.search(text)
    if small:
        text = SMALL_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip(), small


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
                  "ых", "их", "ые", "ие", "ым", "им",
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


STOP = {"с", "со", "и", "в", "во", "на", "из", "по", "под", "без", "для", "к", "это", "вид", "виде", "шт", "г", "гр", "мл"}
SMALL_G = 20          # «немного» без числа - горсть или 20 г


def bag(name: str) -> frozenset:
    return frozenset(w for w in stem(name).split() if w not in STOP and not w.isdigit())


def base_name(name: str) -> str:
    """Название без состояния: «Гречка варёная» и «Гречка сырая» → «гречк»."""
    return stem(STATE_WORDS.sub(" ", norm(name)))


_brands_cache: list = [None, frozenset()]


def brand_words(foods: list[dict]) -> frozenset:
    """Основы слов-брендов из товаров: слово стоит в бренде хотя бы в 40 % случаев, где встречается
    («простоквашин» 54 из 54, «может» 20 из 21), и его нет в названиях базовых продуктов («домашн» - 9 из 65).
    Как brandWords в foodparse.js."""
    common = {w for x in foods if x.get("source") == "seed" for w in bag(x["name"])}
    in_name: dict[str, int] = {}
    in_brand: dict[str, int] = {}
    for x in foods:
        if x.get("brand"):
            bw = bag(x["brand"])
            for w in bw:
                in_brand[w] = in_brand.get(w, 0) + 1
            for w in bag(x["name"]) | bw:
                in_name[w] = in_name.get(w, 0) + 1
    return frozenset(w for w, n in in_brand.items() if n >= 2 and n >= 0.4 * in_name[w] and len(w) > 3
                     and w not in common and w not in STOP)


class Index:
    def __init__(self, uid: str | None = None):
        self.foods = db.all_foods()
        self.by_id = {f["id"]: f for f in self.foods}
        self.keys: dict[str, dict] = {}
        self.stems: dict[str, dict] = {}
        self.bases: dict[str, list[dict]] = {}
        self.fuzzy: list[str] = []          # нечёткое сравнение - без товаров из магазина (их 15 тыс., бренды не угадываем)
        self.bags: list[tuple[frozenset, dict]] = []    # наборы основ слов названий и синонимов (тоже без магазина)
        for f in self.foods:
            for k in [f["name"], *f["aliases"], *([f"{f['brand']} {f['name']}"] if f.get("brand") else [])]:
                nk = norm(k)
                if nk not in self.keys and f.get("source") != "off":
                    self.fuzzy.append(nk)
                self.keys.setdefault(nk, f)
                self.stems.setdefault(stem(k), f)
                if f.get("source") != "off":
                    b = bag(k)
                    if b:
                        self.bags.append((b, f))
            self.bases.setdefault(base_name(f["name"]), []).append(f)
        key = (len(self.foods), max((f.get("updated") or 0 for f in self.foods), default=0))
        if _brands_cache[0] != key:             # слова брендов меняются только вместе со справочником
            _brands_cache[:] = [key, brand_words(self.foods)]
        self.brand_words = _brands_cache[1]
        self.usage = usage(uid, self) if uid else {}

    def misses_brand(self, name: str, f: dict) -> bool:
        """В запросе бренд, которого у продукта нет: «йогурт активиа» → «Йогурт натуральный» - другой товар
        с другими цифрами, такое совпадение не засчитываем (ищем товар или спрашиваем ИИ)."""
        extra = bag(name) - bag(" ".join([f["name"], *(f.get("aliases") or []), f.get("brand") or ""]))
        return any(re.search(r"[a-z]{3}", w) or w in self.brand_words for w in extra)

    def _raw_match(self, name: str) -> dict | None:
        if name in self.keys:
            return self.keys[name]
        if stem(name) in self.stems:
            return self.stems[stem(name)]
        by_bag = self._bag_match(name)
        if by_bag:
            return by_bag
        close = difflib.get_close_matches(name, self.fuzzy, n=1, cutoff=0.86)
        return self.keys[close[0]] if close else None

    def _bag_match(self, name: str) -> dict | None:
        """Слова в любом порядке и падеже, лишние слова можно: «листья салата айсберг» → «Салат листовой».
        Продукт засчитывается, если его названия покрывают не меньше половины слов запроса и нет равного соперника."""
        q = bag(name)
        if not q:
            return None
        cover: dict[int, set] = {}
        foods: dict[int, dict] = {}
        for b, f in self.bags:
            if b <= q:
                cover.setdefault(f["id"], set()).update(b)
                foods[f["id"]] = f
        if cover:
            ranked = sorted(cover.items(), key=lambda kv: (-len(kv[1]), len(foods[kv[0]]["name"])))
            best, n = ranked[0][0], len(ranked[0][1])
            rival = len(ranked) > 1 and len(ranked[1][1]) == n and base_name(foods[ranked[1][0]]["name"]) != base_name(foods[best]["name"])
            if n * 2 >= len(q) and not rival:
                return foods[best]
        # запрос короче названия: «салат из свежих овощей» → «Салат из свежих овощей с маслом» (одно лишнее слово)
        if len(q) >= 2:
            wider = {}
            for bb, f in self.bags:
                if q < bb and len(bb) - len(q) == 1:
                    wider.setdefault(base_name(f["name"]), f)
            if len(wider) == 1:
                return next(iter(wider.values()))
        return None

    def exact(self, name: str) -> bool:
        """Совпало название или синоним целиком (с точностью до окончаний) - тогда «с …» часть блюда: «кофе с молоком»."""
        n = norm(name)
        return n in self.keys or stem(n) in self.stems

    def covered(self, name: str, f: dict) -> frozenset:
        """Какие слова запроса покрыты названиями продукта."""
        q, out = bag(name), set()
        for b, g in self.bags:
            if g["id"] == f["id"] and b <= q:
                out |= b
        return frozenset(out)

    def match(self, name: str) -> dict | None:
        name = norm(name)
        if not name:
            return None
        f = self._raw_match(name)
        if f and self.misses_brand(name, f):
            return None
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
    portions = dict(food.get("portions") or {})
    if food.get("piece_g"):                     # with_piece: категория яйца или личный вес штуки
        portions["шт"] = food["piece_g"]
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


def drop_covered(rest: list[str], rec_data: dict) -> list[str]:
    """Нераспознанные куски без тех, что человек закрыл строкой руками («+ Добавить продукт» → «это вместо», covers)."""
    cov = {norm(str(c)) for i in (rec_data.get("items") or []) if isinstance(i, dict) and i.get("added") for c in i.get("covers") or []}
    return [r for r in rest if norm(r) not in cov] if cov else rest


def quick_parse(text: str, idx: Index | None = None, uid: str | None = None) -> tuple[list[dict], list[str]]:
    """→ (распознанные позиции, нераспознанные куски). Явные КБЖУ относятся к целому куску «между ;/переносами
    строк» (split_strong) — так составное блюдо, у которого через запятую перечислены части («рис с креветками,
    яйцом и луком»), не разваливается на отдельные продукты; запятая делит на блюда, только когда КБЖУ рядом нет."""
    idx = idx or Index()
    done, rest = [], []
    pieces = pieces_of(uid)
    for seg, macro in macro_annotate(split_strong(text)):
        if macro:
            clean, small = prepare(seg)
            name, n, unit = parse_chunk(clean)
            food = with_piece(idx.match(name), seg, pieces)
            # явные КБЖУ рядом с продуктом — они и идут в БЖУ приёма пищи, справочник тут не спрашиваем
            done.append(_macro_item(seg, name, _macro_grams(n, unit, food), macro, idx, uid))
            continue
        for chunk in split_weak(seg):
            if composite(chunk):
                rest.append(chunk)
                continue
            clean, small = prepare(chunk)
            name, n, unit = parse_chunk(clean)
            food = with_piece(idx.match(name), chunk, pieces)
            grams = (food.get("portions") or {}).get("горсть", SMALL_G) if food and small else grams_for(food, n, unit) if food else None
            if food and grams:
                done.append(item_from(food, grams, chunk))
                # ничего не теряем: «ножки запечённые с оливками» нашлись как ножки - оливки отдельной строкой
                extra = with_extra(name, food, idx)
                if extra:
                    f2 = idx.match(extra)
                    if f2:
                        done.append(item_from(f2, (f2.get("portions") or {}).get("горсть", SMALL_G), extra))
                    else:
                        rest.append(extra)
            else:
                rest.append(chunk)
    return done, rest


def _macro_grams(n: float | None, unit: str | None, food: dict | None) -> float:
    """Вес, к которому относятся явные КБЖУ: указанный рядом (граммы/мл, штуки по порции продукта),
    иначе — число без единицы (если похоже на граммы) или порция по умолчанию, иначе 100 г."""
    if unit in ("g", "ml"):
        return n
    if unit in ("kg", "l"):
        return n * 1000
    if unit and food:
        g = grams_for(food, n, unit)
        if g:
            return g
    if n and unit is None and n > 20:
        return n
    if food:
        g = grams_for(food, None, None)
        if g:
            return g
    return 100.0


def _macro_item(chunk: str, name: str, grams: float, macro: dict, idx: "Index", uid: str | None) -> dict:
    """Позиция по явным КБЖУ, не по справочнику: числа - значения на 100 г продукта, итог считаем на реально
    указанный вес. Продукта (или его синонима) ещё нет в справочнике - запоминаем его туда как есть (per_100),
    как это делает разбор ИИ (idx.match, а не только точное имя: «курица» не задваивает «Курицу варёную»,
    у которой это уже алиас)."""
    title = re.sub(r"\s+", " ", name).strip()
    title = (title[:1].upper() + title[1:]) if title else "Без названия"
    if not idx.match(title):
        db.learn_food(title, macro, source="manual", uid=uid)
    k = grams / 100
    item = {"kcal": round(macro["kcal"] * k), "p": round(macro["p"] * k, 1), "f": round(macro["f"] * k, 1), "c": round(macro["c"] * k, 1)}
    return {"text": chunk, "name": title, "grams": round(grams), **item, "source": "manual"}


def with_extra(name: str, food: dict, idx: "Index") -> str | None:
    """Хвост «с …», который найденный продукт не покрывает (или None)."""
    m = WITH_RE.search(norm(name))
    if not m or idx.exact(name):
        return None
    tail = m.group(1).strip()
    tb = bag(tail)
    return tail if tb and not tb <= idx.covered(name, food) else None


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
