"""Поиск КБЖУ товара на сайтах-счётчиках калорий (кроме Open Food Facts, см. ai/jobs.off_search).

Полной открытой базы российских товаров нет, а на сайтах-счётчиках (их пополняют люди) брендовые товары есть.
Сервер ищет страницы товара через поисковик DuckDuckGo (только по этим сайтам), открывает несколько первых
и достаёт с каждой название и КБЖУ на 100 г. Наружу уходит только название продукта - как и в Open Food Facts
(docs/PRIVACY.md); выключается тем же переключателем поиска в интернете (brain.web_allowed).

Данные разные люди вносят по-разному (бывает «на порцию» вместо «на 100 г»), поэтому кандидаты группируются
(variants): близкие значения - один вариант, заметно разные - несколько, и выбирает человек.
"""
import asyncio
import html
import re
from urllib.parse import quote_plus, unquote, urlparse, parse_qs

import httpx

from . import food

SITES = ("tablicakalorijnosti.ru", "health-diet.ru", "wayout.fitness", "calorizator.ru", "fitaudit.ru", "fatsecret.ru")
SITE_NAME = {"tablicakalorijnosti.ru": "Таблица калорийности", "health-diet.ru": "Health-diet",
             "wayout.fitness": "Wayout", "calorizator.ru": "Калоризатор", "fitaudit.ru": "Fitaudit", "fatsecret.ru": "FatSecret"}
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
      "Version/18.0 Safari/605.1.15")
DDG = "https://html.duckduckgo.com/html/"
PAGES = 6             # сколько страниц открывать на один запрос

NUM = r"(\d+(?:[.,]\d+)?)"
P_RE = re.compile(rf"Белк\w*\s*(?:[:—–-]\s*)?{NUM}\s*г", re.I)
F_RE = re.compile(rf"Жир\w*\s*(?:[:—–-]\s*)?{NUM}\s*г", re.I)
C_RE = re.compile(rf"Углевод\w*\s*(?:[:—–-]\s*)?{NUM}\s*г", re.I)
KCAL_LABEL_RE = re.compile(rf"(?:Калорийность|Калории|Энергетическая ценность|Энергия)\D{{0,30}}?{NUM}\s*к?кал", re.I)
KCAL_RE = re.compile(rf"(?<!в )(?<!\d){NUM}\s*к?кал", re.I)
TITLE_TAIL = re.compile(r"\s*(?:[-–—:|]\s*)?(?:калорийност|химическ|пищев|бжу|состав|калории|calories).*$", re.I)


def host_of(url: str) -> str:
    h = (urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def _text(page: str) -> str:
    page = re.sub(r"<script.*?</script>|<style.*?</style>|<!--.*?-->", " ", page, flags=re.S | re.I)
    page = re.sub(r"\{\{.*?\}\}", " ", page)                 # шаблоны Angular на tablicakalorijnosti
    t = html.unescape(re.sub(r"<[^>]+>", " ", page))
    return re.sub(r"\s+", " ", t)


def _title(page: str) -> str:
    for pat in (r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', r"<h1[^>]*>(.*?)</h1>", r"<title[^>]*>(.*?)</title>"):
        m = re.search(pat, page, re.S | re.I)
        if m:
            t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))).strip()
            t = re.sub(r"^Калорийность\s+", "", t, flags=re.I)
            t = TITLE_TAIL.sub("", t).strip(" .,-–—:")
            if len(t) >= 3:
                return t[:90]
    return ""


def _f(m) -> float | None:
    return float(m.group(1).replace(",", ".")) if m else None


def parse_page(url: str, page: str) -> dict | None:
    """Страница товара → {title, kcal, p, f, c} на 100 г или None, если цифр нет или они не сходятся."""
    title = _title(page)
    t = _text(page)
    # ищем после названия (в меню и шапке бывают «100 ккал» и т. п.)
    start = t.lower().find(title.lower()[:30]) if title else -1
    body = t[start:] if start >= 0 else t
    p, f, c = _f(P_RE.search(body)), _f(F_RE.search(body)), _f(C_RE.search(body))
    kcal = _f(KCAL_LABEL_RE.search(body)) or _f(KCAL_RE.search(body))
    if None in (p, f, c, kcal) or not title:
        return None
    if p + f + c > 101 or kcal > 950:
        return None
    mm = food.energy_mismatch(kcal, p, f, c)
    if mm is not None and mm > 0.35:
        return None
    return {"title": title, "kcal": round(kcal), "p": round(p, 1), "f": round(f, 1), "c": round(c, 1)}


async def _ddg(c: httpx.AsyncClient, query: str) -> list[str]:
    sites = " OR ".join(f"site:{s}" for s in SITES)
    r = await c.post(DDG, data={"q": f"{query} калорийность ({sites})", "kl": "ru-ru"})
    r.raise_for_status()
    if r.status_code != 200:            # 202 - защита от роботов: результатов нет, это не ошибка поиска
        return []
    urls = []
    for href in re.findall(r'class="result__a"[^>]*href="([^"]+)"', r.text):
        href = html.unescape(href)
        if "uddg=" in href:                                  # ссылка-переадресация DuckDuckGo
            href = unquote(parse_qs(urlparse(href).query).get("uddg", [""])[0])
        if host_of(href) in SITES and href not in urls:
            urls.append(href)
    return urls


async def _page(c: httpx.AsyncClient, url: str) -> dict | None:
    try:
        r = await c.get(url)
        if r.status_code != 200:
            return None
        got = parse_page(url, r.text)
    except (httpx.HTTPError, ValueError):
        return None
    if not got:
        return None
    if NOT_RU.search(got["title"]):
        return None                      # украинская карточка - товар не с наших полок
    host = host_of(url)
    return {"kind": "site", "site": SITE_NAME.get(host, host), "url": url, "brand": "", **got}


TK = "https://www.tablicakalorijnosti.ru"
NOT_RU = re.compile(r"[іїєґ]", re.I)


async def _tk(c: httpx.AsyncClient, query: str, n: int) -> list[str]:
    """Таблица калорийности: свой поиск (JSON, им пользуется их сайт) - русские бренды там есть широко.
    Отдаёт только калории; белки, жиры и углеводы - со страницы товара."""
    r = await c.get(f"{TK}/autocomplete/foodstuff-activity-meal", params={"query": query}, headers={"Accept": "application/json"})
    r.raise_for_status()
    return [f"{TK}/produkty/{x['url']}" for x in r.json() if x.get("clazz") == "foodstuff" and x.get("url")][:n]


async def search(query: str, pages: int = PAGES) -> tuple[list[dict], str | None]:
    """Кандидаты с сайтов: [{kind: site, site, url, title, kcal, p, f, c}], причина ошибки или None.
    Сначала Таблица калорийности, затем поисковик по остальным сайтам; что-то одно недоступно - берём другое."""
    errs = []
    async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers={"User-Agent": UA, "Accept-Language": "ru"}) as c:
        async def safe(coro, what):
            try:
                return await coro
            except (httpx.HTTPError, ValueError) as e:
                errs.append(f"{what} недоступен ({type(e).__name__})")
                return []
        tk, dd = await asyncio.gather(safe(_tk(c, query, pages), "Таблица калорийности"), safe(_ddg(c, query), "поисковик"))
        urls = tk + [u for u in dd if host_of(u) != "tablicakalorijnosti.ru" and u not in tk][:max(2, pages - len(tk))]
        got = await asyncio.gather(*[_page(c, u) for u in urls])
    got = [g for g in got if g]
    return got, (None if got or len(errs) < 2 else "; ".join(errs))


# ── то ли это вообще: название кандидата против запроса ──

LAT_WORD = re.compile(r"[a-z][a-z0-9-]{2,}")


# одно и то же по-русски и латиницей: «протеин Goku Gains» = «Goku gains whey protein»
SAME = {"протеин": "protein", "батончик": "bar", "йогурт": "yogurt", "шоколад": "chocolate", "печенье": "cookie",
        "напиток": "drink", "коктейль": "shake", "изолят": "isolate", "гейнер": "gainer", "сывороточн": "whey"}


def relevant(query: str, title: str, brand: str = "") -> bool:
    """Кандидат про тот же товар: все слова латиницей (бренд) есть в названии, и покрыта хотя бы половина
    остальных слов запроса (по основам, без слов состояния)."""
    q = food.STATE_WORDS.sub(" ", food.norm(query))
    hay = food.norm(f"{title} {brand}")
    hay += " " + " ".join(ru for ru, en in SAME.items() if en in hay)
    lat = LAT_WORD.findall(q)
    if any(w not in hay for w in lat):
        return False
    words = [food.stem(w) for w in q.split() if len(w) > 2 and w not in food.STOP and not LAT_WORD.fullmatch(w)]
    if not words:
        return bool(lat)
    have = {food.stem(w) for w in hay.split()}
    # бренд кириллицей («активиа», «простоквашино») - как латиница: обязателен («Актибио» - другой товар)
    brands = food._brands_cache[1]
    if any(w in brands and not any(_same_word(w, h) for h in have) for w in words):
        return False
    hit = sum(1 for w in words if any(h.startswith(w[:max(3, len(w) - 1)]) or w.startswith(h) for h in have if len(h) > 2))
    return hit * 2 >= len(words)


def _same_word(a: str, b: str) -> bool:
    """Основы одного слова: общее начало без последней буквы основы («активи» = «активиа», но не «актиби»)."""
    n = max(3, min(len(a), len(b)) - 1)
    return a[:n] == b[:n]


def pick(query: str, cands: list[dict], n: int = 8) -> list[dict]:
    """Кандидаты про этот товар, лучшие первыми: меньше лишних слов в названии - ближе к запросу."""
    q = {food.stem(w) for w in food.norm(query).split() if len(w) > 2}
    def extra(x):
        words = [food.stem(w) for w in food.norm(x["title"]).split() if len(w) > 2]
        return sum(1 for w in words if not any(_same_word(w, a) for a in q))
    def missing(x):
        have = {food.stem(w) for w in food.norm(f"{x['title']} {x.get('brand') or ''}").split()}
        have |= {ru for ru, en in SAME.items() if en in have}
        return sum(1 for a in q if not a.isdigit() and not any(_same_word(a, h) for h in have if len(h) > 2))
    rel = [x for x in cands if relevant(query, x["title"], x.get("brand") or "")]
    # есть кандидаты, где нашлись все слова запроса («сосиски Папа может сочный гриль»), - остальные про другие
    # товары того же бренда («… молочные»), а не разночтения этого
    best = min(map(missing, rel), default=0)
    rel = [x for x in rel if missing(x) == best]
    return sorted(rel, key=extra)[:n]


# ── варианты: одинаковые значения - один вариант, заметно разные - выбирает человек ──

def close(a: dict, b: dict) -> bool:
    """Разночтения минимальные: калории в пределах 12 %, каждый из Б/Ж/У - в пределах 3 г или 15 %."""
    ka, kb = a["kcal"], b["kcal"]
    if abs(ka - kb) > max(15, 0.12 * max(ka, kb)):
        return False
    return all(abs(a[k] - b[k]) <= max(3, 0.15 * max(a[k], b[k])) for k in ("p", "f", "c"))


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def variants(cands: list[dict], n: int = 4) -> list[dict]:
    """Кандидаты → варианты [{kcal, p, f, c, title, sources: [{site, title, url, brand}]}], от самого частого.
    Значения варианта - медиана его кандидатов."""
    groups: list[list[dict]] = []
    for x in cands:
        for g in groups:
            if all(close(x, y) for y in g):
                g.append(x)
                break
        else:
            groups.append([x])
    # порядок: сначала группа с лучшим совпадением названия (кандидаты уже отсортированы pick), при равенстве - больше источников
    groups.sort(key=lambda g: (min(cands.index(x) for x in g), -len(g)))
    out = []
    for g in groups:
        v = {k: round(_median([x[k] for x in g]), 1) for k in ("kcal", "p", "f", "c")}
        v["kcal"] = round(v["kcal"])
        titles = list(dict.fromkeys(x["title"] for x in g))
        out.append({**v, "title": titles[0], "titles": titles[:4], "brand": next((x.get("brand") for x in g if x.get("brand")), ""),
                    "sources": [{"site": x.get("site") or "Open Food Facts", "title": x["title"], "url": x.get("url"),
                                 "brand": x.get("brand") or ""} for x in g]})
    return out[:n]
