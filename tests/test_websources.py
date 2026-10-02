"""Поиск товара на сайтах: разбор страницы, отбор кандидатов, группировка вариантов (без сети)."""
from app import websources as W

PAGE = """<html><head><meta property="og:title" content="Протеин Клубника Goku Gains Soulway - калорийность"></head>
<body><h1>Протеин Клубника Goku Gains Soulway</h1><div>Белки {{data.protein}} 65,4 г</div><div>Жиры 3 г</div>
<div>Углеводы 18 г</div><div>384 ккал на 100 г</div></body></html>"""


def test_parse_page():
    got = W.parse_page("https://example.ru/x", PAGE)
    assert got == {"title": "Протеин Клубника Goku Gains Soulway", "kcal": 384, "p": 65.4, "f": 3.0, "c": 18.0}


def test_parse_page_rejects_nonsense():
    bad = PAGE.replace("65,4", "95").replace("18 г", "40 г")         # Б+Ж+У > 100 - не на 100 г
    assert W.parse_page("https://example.ru/x", bad) is None


def c(title, kcal, p, f, cc, site="Таблица калорийности"):
    return {"title": title, "kcal": kcal, "p": p, "f": f, "c": cc, "site": site, "brand": ""}


def test_relevant_and_pick():
    assert W.relevant("протеин goku gains", "Goku gains whey protein chocolate Soulway")
    assert not W.relevant("йогурт активиа", "Био йогурт с вишней Актибио")
    rel = W.pick("сосиски папа может сочный гриль", [c("Сосиски сочный гриль Папа может", 187, 10, 15, 3),
                                                      c("Сосиски молочные Папа может", 168, 11, 13, 2)])
    assert [x["title"] for x in rel] == ["Сосиски сочный гриль Папа может"]


def test_variants_group_close_values():
    vs = W.variants([c("A", 384, 65.4, 3, 18), c("A2", 380, 64, 3.5, 17), c("B", 120, 20, 1, 6.6, "Health-diet")])
    assert len(vs) == 2 and vs[0]["kcal"] in (380, 382, 384) and len(vs[0]["sources"]) == 2
    assert len(W.variants([c("A", 100, 3, 3, 10), c("B", 104, 3.2, 3.1, 10.5)])) == 1
