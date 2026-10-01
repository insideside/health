"""Справочник товаров из магазинов: Open Food Facts → app/seed/foods_store.json.

Источник - открытая база Open Food Facts (https://world.openfoodfacts.org, лицензия ODbL 1.0,
данные вносят люди). Берём товары России, Беларуси, Казахстана и с русским названием, у которых
заполнены белки, жиры и углеводы на 100 г; отсеиваем ошибки (Б+Ж+У больше 100 г, калории не сходятся
с БЖУ), из одинаковых названий оставляем самый популярный по сканированиям.

Запуск:
    uv run --with duckdb python scripts/build_store_foods.py --parquet food.parquet
        food.parquet (~8 ГБ) - https://huggingface.co/datasets/openfoodfacts/product-database; основной вариант
    python3 scripts/build_store_foods.py [--csv products.csv.gz]
        CSV-выгрузка (~1,3 ГБ, читается потоком); в ней у части товаров пустые значения на 100 г - товаров меньше
"""
import argparse
import csv
import gzip
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "seed" / "foods_store.json"
CSV_URL = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
COUNTRIES = {"en:russia", "en:belarus", "en:kazakhstan"}


# категории Open Food Facts → группы справочника (первое совпадение по порядку)
GROUPS = [
    ("спортпит", ["protein-bars", "protein-powders", "dietary-supplements", "sports-nutrition", "bodybuilding"]),
    ("сыры", ["cheeses"]),
    ("молочные", ["dairies", "milks", "yogurts", "kefir", "fermented-milk", "cottage-cheese", "curds", "creams", "sour-creams", "dairy-desserts"]),
    ("напитки", ["beverages", "waters", "juices", "sodas", "teas", "coffees"]),
    ("колбасы и полуфабрикаты", ["sausages", "hams", "prepared-meats", "frankfurters", "salamis", "frozen-dumplings", "pelmeni", "dumplings"]),
    ("рыба и морепродукты", ["fishes", "seafood", "canned-fishes", "smoked-fishes"]),
    ("птица", ["poultries", "chickens", "turkeys"]),
    ("мясо", ["meats"]),
    ("яйца", ["eggs"]),
    ("жиры и масла", ["fats", "vegetable-oils", "butters", "margarines", "olive-oils"]),
    ("соусы и приправы", ["sauces", "condiments", "mayonnaises", "ketchups", "dressings", "spices", "mustards"]),
    ("сладости", ["chocolates", "candies", "confectioneries", "sweet-snacks", "biscuits", "cakes", "cookies", "wafers",
                  "ice-creams", "desserts", "jams", "honeys", "sweet-spreads", "marshmallows", "halva"]),
    ("фастфуд", ["salty-snacks", "crisps", "chips", "crackers", "popcorn", "instant-noodles", "pizzas", "burgers"]),
    ("хлеб и выпечка", ["breads", "pastries", "viennoiseries", "rusks", "crispbreads"]),
    ("макароны", ["pastas", "noodles"]),
    ("крупы", ["cereals", "breakfast-cereals", "mueslis", "grains", "rices", "flakes", "oat", "buckwheat", "flours"]),
    ("бобовые", ["legumes", "beans", "lentils", "chickpeas", "peas"]),
    ("орехи и семена", ["nuts", "seeds", "peanuts"]),
    ("фрукты и ягоды", ["fruits", "berries", "dried-fruits"]),
    ("овощи", ["vegetables", "canned-vegetables", "pickles", "mushrooms"]),
    ("готовые блюда", ["meals", "prepared-foods", "soups", "salads", "frozen-foods"]),
]

CYR = re.compile(r"[а-яё]", re.I)


def clean(s: str) -> str:
    s = re.sub(r"[«»\"“”„]", "", html.unescape(html.unescape(s or "")))
    s = re.sub(r"\s+", " ", s).strip(" ,.-—–")
    s = s.replace("—", "-").replace("–", "-")
    if s.isupper():
        s = s.capitalize()
    # «Хлеб Тостовый Отрубной» → «Хлеб тостовый отрубной»: русские слова с заглавной (кроме первого) - строчными,
    # аббревиатуры (XXL, ГОСТ) и латиница (бренды) остаются как есть
    words = s.split(" ")
    title = [w for w in words[1:] if re.match(r"^[А-ЯЁ][а-яё]", w)]
    if len(words) > 2 and len(title) >= (len(words) - 1) * 0.6:
        words = [words[0]] + [w[:1].lower() + w[1:] if re.match(r"^[А-ЯЁ][а-яё]", w) else w for w in words[1:]]
        s = " ".join(words)
    return s[:1].upper() + s[1:]


# если категорий нет - по словам названия (основы слов, первое совпадение)
NAME_GROUPS = [
    ("спортпит", r"протеин|изолят|гейнер|bcaa|белков(ый|ая) (батончик|коктейль)"),
    ("сыры", r"(^|\s)сыр(ы|а|ный|ная)?(\s|,|$)|моцарелл|пармезан|брынз|фет[аы]\b|рикотт|маскарпоне|гауда|чеддер"),
    ("молочные", r"молок|кефир|йогурт|творог|творожн|сметан|ряженк|сливк|простокваш|айран|тан\b|варенец|бифидок|снежок|глазированн"),
    ("напитки", r"\bсок|нектар|вода\b|напиток|лимонад|морс|квас|\bчай|кофе|кола\b|газиров|энергетик|компот"),
    ("колбасы и полуфабрикаты", r"колбас|сосиск|сардельк|ветчин|бекон|пельмен|вареник|котлет|наггетс|буженин|карбонад|шпикачк|салями|сервелат"),
    ("рыба и морепродукты", r"рыб|лосос|сёмг|семг|форел|тунец|сельд|скумбри|шпрот|краб|кальмар|кревет|икра|горбуш|минтай|треск"),
    ("птица", r"куриц|куриное|куриная|курин|индейк|цыпл|бройлер"),
    ("мясо", r"говядин|свинин|баранин|телятин|фарш|мясо"),
    ("яйца", r"^яйц|яйцо"),
    ("жиры и масла", r"масло|маргарин|спред"),
    ("соусы и приправы", r"соус|майонез|кетчуп|горчиц|приправ|специ|аджик|уксус|хрен\b"),
    ("сладости", r"шоколад|конфет|печенье|пряник|вафл|торт|пирожн|эклер|трубочк|зефир|пастил|мармелад|халв|мороженое|пломбир|эскимо|карамел|батончик|рулет|кекс|маффин|варенье|джем|мёд|мед\b|сгущ|драже|ирис|козинак"),
    ("фастфуд", r"чипс|сухарик|крекер|попкорн|лапша быстр|доширак|роллтон|бичи|гренк|снек"),
    ("хлеб и выпечка", r"хлеб|батон|булк|булочк|лаваш|багет|бублик|сушк|баранк|хлебц|круассан|пирог|слойк|лепёшк|лепешк|тортилья"),
    ("макароны", r"макарон|спагетти|лапша|паста\b|вермишел|фузилли|пенне"),
    ("крупы", r"крупа|гречк|гречнев|рис\b|рисов|овсян|геркулес|хлопья|мюсли|гранол|пшен|перлов|булгур|киноа|кукурузн|мука"),
    ("бобовые", r"фасол|чечевиц|нут\b|горох|горошек"),
    ("орехи и семена", r"орех|миндал|фундук|кешью|фисташк|арахис|семечк|семена|кунжут"),
    ("фрукты и ягоды", r"яблок|банан|груш|ягод|изюм|курага|чернослив|финик|фрукт|клубник|вишн|апельсин|манго|ананас"),
    ("овощи", r"огур|томат|помидор|капуст|морков|свёкл|свекл|кукуруз|горошек|оливк|маслин|гриб|шампиньон|перец|овощ|картоф"),
    ("готовые блюда", r"салат|суп|борщ|пицц|плов|каша|пюре|рагу|блин|сырник|лазань|шаурм|бургер|сэндвич|ролл|боул"),
]


def group_of(tags, name: str = "") -> str | None:
    # категории идут от общей к частной: смотрим с конца; составные («plant-based-foods-and-beverages») не в счёт
    tags = [t.split(":", 1)[-1] for t in (tags or []) if t]
    for t in reversed(tags):
        if "-and-" in t:
            continue
        for g, keys in GROUPS:
            if any(k in t for k in keys):
                return g
    # по названию - группа того слова, что стоит раньше («Пельмени со сливками» - полуфабрикаты, не молочные)
    low, best = name.lower(), None
    for g, pat in NAME_GROUPS:
        m = re.search(pat, low)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), g)
    return best[1] if best else None


def grams_of(qty: str) -> float | None:
    """«45 г», «0,5 л», «500ml», «2 x 40 g» → граммы упаковки (мл ≈ г)."""
    q = (qty or "").lower().replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(кг|kg|г|гр|g|мл|ml|л|l)\b", q)
    if not m or re.search(r"\d\s*[xх×*]\s*\d", q):
        return None
    v, u = float(m.group(1)), m.group(2)
    v *= 1000 if u in ("кг", "kg", "л", "l") else 1
    return v if 5 <= v <= 1000 else None


def num(v: str) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def nutr_of(r: dict) -> dict | None:
    p, f, c = num(r["proteins_100g"]), num(r["fat_100g"]), num(r["carbohydrates_100g"])
    kcal = num(r["energy-kcal_100g"])
    if kcal is None and num(r["energy_100g"]) is not None:
        kcal = num(r["energy_100g"]) / 4.184
    if None in (p, f, c, kcal) or min(p, f, c, kcal) < 0 or p + f + c > 101 or kcal > 900:
        return None
    calc = 4 * p + 4 * c + 9 * f
    # энергия должна сходиться с БЖУ; у батончиков с клетчаткой и подсластителями она ниже - до 35 %
    if abs(kcal - calc) > 15 and not (0.65 * calc <= kcal <= 1.15 * calc):
        return None
    return {"kcal": round(kcal), "p": round(p, 1), "f": round(f, 1), "c": round(c, 1)}


# украинские и болгарские названия (кириллица, но не русский): і ї є ґ, апостроф, «ъ» не перед е/ё/ю/я
NOT_RU = re.compile(r"[іїєґʼ’']|ъ(?![еёюя])", re.I)


def wanted(r: dict) -> bool:
    """Товар продаётся в России / Беларуси / Казахстане или описан по-русски, и название - по-русски."""
    name = r.get("product_name") or ""
    if not CYR.search(name) or NOT_RU.search(name):
        return False
    return r.get("lang") == "ru" or bool(COUNTRIES & set((r.get("countries_tags") or "").split(",")))


def build(rows) -> list[dict]:
    best: dict[str, tuple] = {}
    for r in rows:
        name = clean(r["product_name"])
        if len(name) < 3 or not CYR.search(name):
            continue
        n = nutr_of(r)
        if not n:
            continue
        brand = clean((r["brands"] or "").split(",")[0])[:40]
        if not brand:
            continue            # без бренда это просто «Йогурт» - такие есть в базовом справочнике, точнее и без ошибок
        title = name if not brand or brand.lower() in name.lower() else f"{name}, {brand}"
        if NOT_RU.search(title):
            continue            # украинский или болгарский бренд - товар не с наших полок
        if len(title) > 80:
            continue
        item = {"name": title, "brand": brand or None, "group": group_of((r["categories_tags"] or "").split(","), name), "state": "as_sold", **n}
        g = grams_of(r["quantity"])
        if g:
            item["portions"] = {"упаковка": round(g)}
        if r["code"]:
            item["code"] = r["code"]
        pop = (num(r["unique_scans_n"]) or 0, num(r.get("completeness")) or 0)
        key = title.lower().replace("ё", "е")
        if key not in best or pop > best[key][0]:
            best[key] = (pop, item)
    out = [x for _, x in sorted(best.values(), key=lambda t: t[0], reverse=True)]
    return [{k: v for k, v in x.items() if v is not None} for x in out]


KEEP = ("code", "product_name", "brands", "quantity", "unique_scans_n", "completeness", "categories_tags", "countries_tags", "lang",
        "energy-kcal_100g", "energy_100g", "proteins_100g", "fat_100g", "carbohydrates_100g")


def read_rows(src: str):
    """Строки выгрузки (TSV в gzip) - потоком, только нужные товары и столбцы."""
    csv.field_size_limit(sys.maxsize)
    raw = open(src, "rb") if not src.startswith("http") else urllib.request.urlopen(
        urllib.request.Request(src, headers={"User-Agent": "Trainer/1.0 (family app; food catalog build)"}), timeout=120)
    with raw, gzip.open(raw, "rt", encoding="utf-8", errors="replace", newline="") as fh:
        rd = csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE)
        for i, r in enumerate(rd):
            if i % 500000 == 0:
                print(f"  {i // 1000} тыс. строк", file=sys.stderr, flush=True)
            if wanted(r):
                yield {k: r.get(k) for k in KEEP}


def read_parquet(path: str):
    """Выгрузка Parquet (Hugging Face: openfoodfacts/product-database, food.parquet): в ней полные nutriments,
    а в CSV у части товаров значения на 100 г пустые. Нужен duckdb: uv run --with duckdb python …"""
    import duckdb
    rel = duckdb.connect().execute(f"""
      SELECT code, product_name, brands, quantity, unique_scans_n, completeness, categories_tags, countries_tags, lang,
             list_filter(nutriments, x -> x.name IN ('energy-kcal', 'energy', 'proteins', 'fat', 'carbohydrates')) AS nutr
      FROM '{path}'
      WHERE (list_has_any(countries_tags, ['en:russia', 'en:belarus', 'en:kazakhstan']) OR lang = 'ru')""")
    for code, names, brands, qty, scans, compl, cats, countries, lang, nutr in rel.fetchall():
        name = next((x["text"] for lg in ("ru", "main") for x in names or [] if x.get("lang") == lg and CYR.search(x.get("text") or "")), "") \
            or next((x["text"] for x in names or [] if CYR.search(x.get("text") or "")), "")
        r = {"code": code, "product_name": name, "brands": brands, "quantity": qty, "unique_scans_n": scans, "completeness": compl,
             "categories_tags": ",".join(cats or []), "countries_tags": ",".join(countries or []), "lang": lang,
             "energy-kcal_100g": None, "energy_100g": None, "proteins_100g": None, "fat_100g": None, "carbohydrates_100g": None}
        for x in nutr or []:
            r[f"{x['name']}_100g"] = x.get("100g")
        if wanted(r):
            yield r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", help="выгрузка Parquet (надёжнее CSV: в ней полные значения на 100 г)")
    ap.add_argument("--csv", default=CSV_URL, help="выгрузка Open Food Facts (.csv.gz, путь или URL)")
    ap.add_argument("--limit", type=int, default=20000, help="сколько самых популярных товаров оставить")
    a = ap.parse_args()
    rows = list(read_parquet(a.parquet) if a.parquet else read_rows(a.csv))
    items = build(rows)[: a.limit]
    OUT.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} товаров в выборке → {len(items)} в {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} КБ)")
    # вес 1 шт (штучная упаковка или как у такого же продукта базового справочника) - scripts/store_pieces.py
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import store_pieces
    store_pieces.main()


if __name__ == "__main__":
    main()
