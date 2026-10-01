"""Вес 1 шт для товаров из магазина (app/seed/foods_store.json), чтобы их можно было вводить штуками.

Open Food Facts даёт только вес упаковки (portions.упаковка), а вес штуки внутри - нет. Два правила:
1. Штуки внутри упаковки (сосиски, булочки, печенье, конфеты, сырники): вес штуки - как у такого же продукта
   базового справочника (app/seed/foods.json), найденного тем же сопоставлением названий, что разбор еды.
   Только если совпала группа и штука не тяжелее упаковки.
2. Штучная упаковка (йогурт 125 г, сырок, батончик, плитка шоколада, бутылочка): 1 шт = 1 упаковка, если
   упаковка небольшая (до 250 г) и группа такая, где товар едят упаковкой.
Куриные яйца считает отдельно приложение - по категории С0/С1/… (food.piece_of), здесь их не трогаем.

Запуск: uv run python scripts/store_pieces.py [--dry]. Вызывается и в конце build_store_foods.py.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import db, food  # noqa: E402

SEED = ROOT / "app" / "seed" / "foods.json"
STORE = ROOT / "app" / "seed" / "foods_store.json"
PACK_MAX = 250
PACK_GROUPS = {"молочные", "сладости", "напитки", "хлеб и выпечка", "фастфуд", "спортпит"}


def seed_index() -> food.Index:
    """Индекс только по базовому справочнику (без товаров из магазина и без базы приложения)."""
    seed = json.loads(SEED.read_text("utf-8"))
    rows = [{**f, "id": i + 1, "aliases": f.get("aliases") or [], "source": "seed", "brand": None} for i, f in enumerate(seed)]
    real = db.all_foods
    db.all_foods = lambda *a, **k: rows
    try:
        return food.Index()
    finally:
        db.all_foods = real


def bare_name(item: dict) -> str:
    """«Булочки Сырные, Мираторг» → «булочки сырные»: бренд после последней запятой не нужен."""
    name, brand = item["name"], (item.get("brand") or "").strip()
    if brand and name.lower().endswith(", " + brand.lower()):
        name = name[: -len(brand) - 2]
    return food.norm(name)


QTY_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(мл|л|кг|г|гр)(?![^\W\d_])", re.I)


def name_qty(name: str) -> float | None:
    """Объём или вес в названии: «Кола 1.5л» → 1500, «Сырок 45 г» → 45."""
    m = QTY_RE.search(name)
    if not m:
        return None
    n, u = float(m.group(1).replace(",", ".")), m.group(2).lower()
    return n * 1000 if u in ("л", "кг") else n


# много штук в упаковке: штука - не упаковка, а вес одной из базового справочника (по слову в названии)
MULTI = ["печенье", "печенья", "конфет", "вафл", "пряник", "зефир", "пастил", "мармелад", "сушк", "сушек", "баранк", "сухар",
         "хлебц", "драже", "ирис", "трюфел", "сосиск", "сардельк", "колбаск", "наггетс", "пельмен", "вареник", "манты",
         "хинкал", "сырник", "блин", "оладь", "котлет", "тефтел", "фрикадел", "булочк", "булк", "круассан", "пирожк",
         "пончик", "кекс", "маффин", "чипс", "крекер", "галет", "козинак", "финик", "чернослив", "кураг", "мандарин"]
# штучное само по себе (одна упаковка = одна штука), даже если в названии есть «орех», «вафл» и т. п.
SINGLE = re.compile(r"батончик|шоколад|паст|мороженое|эскимо|пломбир|торт|сникерс|твикс|баунти|пикник|picnic|snickers", re.I)
# сыпучее и развесное - упаковку за штуку не выдаём
NOT_PACK = re.compile(r"отруб|хлопь|мюсли|гранол|круп|мук|сахар|соль|крахмал|какао-порошок|приправ", re.I)


def multi_piece(name: str, seed: list[dict]) -> tuple[float | None, str]:
    """Много штук в упаковке: вес одной - у самого общего продукта справочника с тем же словом в начале названия
    («Печенье …», «Вафли …» → «Вафли» 15 г, а не вафельный торт). Слово ищем в первых трёх словах (бренд бывает первым)."""
    if SINGLE.search(name):
        return None, ""
    words = name.lower().split()[:3]
    for k in MULTI:
        if any(w.startswith(k) for w in words):
            cand = [f for f in seed if f["name"].lower().split()[0].startswith(k) and (f.get("portions") or {}).get("шт")]
            if cand:
                best = min(cand, key=lambda f: len(f["name"]))
                return best["portions"]["шт"], f"как «{best['name']}»"
            return None, "много штук"
    return None, ""


def piece_for(item: dict, idx: food.Index, seed: list[dict]) -> tuple[float | None, str]:
    if food.is_chicken_egg(item["name"]):
        return None, "яйцо"
    pack = (item.get("portions") or {}).get("упаковка")
    # напиток: бутылка или банка - объём из названия или упаковки (не «банка 330» из справочника для 1,5 л);
    # сухой (чай, кофе, какао - больше 150 ккал на 100 г) - только порционный пакетик до 40 г
    if item.get("group") == "напитки":
        v = name_qty(item["name"]) or pack
        if not v or v > 2000 or (item.get("kcal", 0) > 150 and v > 40):
            return None, ""
        return v, "объём"
    match = idx.match(bare_name(item))
    g = (match.get("portions") or {}).get("шт") if match else None
    if g and (not item.get("group") or not match.get("group") or item["group"] == match["group"]) and (not pack or g <= pack):
        return g, f"как «{match['name']}»"
    g, why = multi_piece(bare_name(item), seed)
    if g and (not pack or g <= pack):
        return g, why
    if why:                                     # много штук в упаковке - упаковку за штуку не выдаём
        return None, ""
    small = pack or name_qty(item["name"])
    if small and small <= PACK_MAX and item.get("group") in PACK_GROUPS and not NOT_PACK.search(item["name"]):
        return small, "упаковка"
    return None, ""


def main(dry: bool = False) -> None:
    raw = STORE.read_text("utf-8")
    items = json.loads(raw)
    idx = seed_index()
    seed = json.loads(SEED.read_text("utf-8"))
    stats = {"как в справочнике": 0, "упаковка": 0, "уже было": 0, "нет": 0}
    samples = []
    for it in items:
        if (it.get("portions") or {}).get("шт"):
            stats["уже было"] += 1
            continue
        g, why = piece_for(it, idx, seed)
        if not g:
            stats["нет"] += 1
            continue
        stats["упаковка" if why in ("упаковка", "объём") else "как в справочнике"] += 1
        it["portions"] = {**(it.get("portions") or {}), "шт": g}
        if len(samples) < 70 and why != "объём" and (len(samples) % 2 or "как «" in why):
            samples.append(f"{it['name']}: {g} г ({why})")
    print(json.dumps(stats, ensure_ascii=False))
    print("\n".join(samples))
    if not dry:
        indent = 2 if raw.startswith("[\n  {") else 1 if raw.startswith("[\n {") else None
        text = json.dumps(items, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":"))
        STORE.write_text(text + ("\n" if raw.endswith("\n") else ""), "utf-8")


if __name__ == "__main__":
    main(dry="--dry" in sys.argv)
