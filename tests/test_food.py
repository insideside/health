"""Разбор еды на сервере (app/food.py). Те же правила - в app/static/foodparse.js (сверка - tests/parity.mjs)."""
from app import food


def names(text, idx):
    done, rest = food.quick_parse(text, idx)
    return [(i["name"], i["grams"]) for i in done], rest


def test_simple(idx):
    got, rest = names("гречка 200 г, кефир 1% 200 мл", idx)
    assert ("Гречка варёная", 200) in got and not rest
    assert any(n.startswith("Кефир 1%") for n, _ in got)


def test_composite_dish_goes_to_ai(idx):
    # состав в скобках - одно блюдо: запятые внутри скобок не делят продукты, вес - на всё блюдо
    got, rest = names("1 яйцо С0, шарлотка (яблоки, яйца, мука, сахар) 180 гр", idx)
    assert got == [("Яйцо варёное", 61)]
    assert rest == ["шарлотка (яблоки, яйца, мука, сахар) 180 гр"]


def test_state_in_parens_is_not_composite(idx):
    got, rest = names("рис отварной 40 г (в сухом виде)", idx)
    assert not rest and got[0][0].startswith("Рис") and "сыр" in got[0][0].lower()


def test_split_respects_parens():
    assert food.split_weak("а, б (в, г) 10 г, д") == ["а", "б (в, г) 10 г", "д"]
    assert food.composite("салат (огурцы, помидоры) 200 г")
    assert not food.composite("рис (в сухом виде) 40 г")


def test_brand_not_matched_to_generic(idx):
    # бренд, которого у продукта нет: не «Йогурт натуральный», а товар Активиа или вопрос
    f = idx.match("йогурт активиа")
    assert f is None or "активиа" in (f["name"] + " " + (f.get("brand") or "")).lower()
    assert idx.match("курица домашняя")          # «домашняя» - не бренд


def test_branded_from_store(idx):
    done, rest = food.quick_parse("сосиски папа может 2 шт", idx)
    assert not rest and done and "папа может" in done[0]["name"].lower()
    # разные товары бренда с заметно разными цифрами - выбор человеку
    if done[0].get("choice"):
        opts = done[0]["choice"]["options"]
        assert len(opts) >= 2 and all(o.get("food_id") for o in opts)


def test_branded_percent_must_match(idx):
    hit, opts = idx.branded("молоко простоквашино 2,5%")
    for f in ([hit] if hit else opts):
        assert "2,5" in f["name"] or "2.5" in f["name"]


def test_explicit_macros_are_per_100g(idx):
    done, _ = food.quick_parse("курица 200г 250/30/5/10", idx)
    assert done[0]["grams"] == 200 and done[0]["kcal"] == 500 and done[0]["p"] == 60


def test_macros_with_comma_before_weight(idx):
    done, _ = food.quick_parse("курица кбжу 191, 12.5, 11.83, 8.97 290г", idx)
    assert done[0]["grams"] == 290 and round(done[0]["p"]) == 36


def test_egg_categories(idx):
    assert names("яйцо С0 - 1 шт", idx)[0][0][1] == 61
    assert names("2 яйца С1", idx)[0][0][1] == 106
    assert names("1 яйцо", idx)[0][0][1] == 50


def test_store_goku(idx):
    got, rest = names("протеин goku gains 30 г", idx)
    assert not rest and "Goku Gains" in got[0][0] and got[0][1] == 30


def test_fat_percent_must_match(idx):
    assert food.pct_clash("молоко 2,5%", {"name": "Молоко 3,2%"})
    assert not food.pct_clash("молоко 2.5%", {"name": "Молоко 2,5%"})
    f = idx.match("кефир 1%")
    assert f and "1%" in f["name"]
