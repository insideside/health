"""Фоновая проверка внешних источников: работают ли сайты, из которых берутся БЖУ, погода, ИИ и обновления.

Проверка через ~2 минуты после старта и дальше раз в 6 часов (и по кнопке «Проверить сейчас»).
Наружу уходит только слово «молоко» и координаты центра Москвы - ничего из данных пользователей.
Выключенное в настройках приватности (поиск в интернете, погода, TRAINER_NO_WEB) не проверяется - статус «выключено».

Результат по каждому источнику: ok / warn / error / off, время ответа, сообщение по-русски, когда последний раз работало
и история последних 20 проверок. Хранится в `meta.monitor` (JSON).
"""
import asyncio
import json
import re
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException

from . import brain, db, updater, weather, websources
from .userdata import current_user

FIRST_DELAY = 120
EVERY = 6 * 3600
HISTORY = 20
TIMEOUT = 15
STATUS_KEY = "monitor"
QUERY = "молоко"

# адреса - в одном месте, чтобы тест мог подменить их и увидеть ошибку
URLS = {
    "off": "https://world.openfoodfacts.org/cgi/search.pl",
    "off2": "https://search.openfoodfacts.org/search",
    "tablica": websources.TK,
    "ddg": websources.DDG,
    "weather": weather.FORECAST_URL,
}

SOURCES = [   # (код, название, для чего)
    ("off", "Open Food Facts", "товары из магазинов с БЖУ"),
    ("tablica", "Таблица калорийности", "поиск БЖУ товаров с русскими брендами"),
    ("ddg", "DuckDuckGo", "поиск БЖУ на других сайтах-счётчиках"),
    ("weather", "Open-Meteo", "погода на «Сегодня» и в подсказках кардио"),
    ("ollama", "ИИ (Ollama)", "чат, программы, разбор еды и недели"),
    ("github", "GitHub", "проверка обновлений приложения"),
]
NAMES = {k: n for k, n, _ in SOURCES}

router = APIRouter()
_lock = asyncio.Lock()


class Bad(Exception):
    """Источник не работает: level = error | warn, текст - для человека."""

    def __init__(self, text: str, level: str = "error"):
        super().__init__(text)
        self.level = level


def _why(e: Exception) -> str:
    if isinstance(e, httpx.TimeoutException):
        return "не ответил вовремя"
    if isinstance(e, httpx.ConnectError):
        return "не удаётся подключиться (нет интернета или сайт недоступен)"
    if isinstance(e, httpx.HTTPStatusError):
        return f"ответил ошибкой {e.response.status_code}"
    if isinstance(e, (ValueError, httpx.DecodingError)):
        return "прислал непонятный ответ"
    return f"не отвечает как обычно ({type(e).__name__})"


def _client(**kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True, **kw)


# ── проверки: каждая возвращает (уровень, сообщение) или бросает Bad ──

async def check_off():
    params = {"search_terms": QUERY, "search_simple": 1, "action": "process", "json": 1, "page_size": 1,
              "fields": "product_name,nutriments"}
    async with _client(headers={"User-Agent": "Trainer/1.0 (local family app)"}) as c:
        first = None
        try:
            r = await c.get(URLS["off"], params=params)
            r.raise_for_status()
            if isinstance(r.json().get("products"), list):
                return "ok", "Поиск товаров отвечает."
            first = "прислал ответ без списка товаров"
        except (httpx.HTTPError, ValueError) as e:
            first = _why(e)
            if isinstance(e, httpx.ConnectError):
                raise Bad(f"Open Food Facts {first}. Товары из магазинов ищутся только по своему справочнику.") from e
        try:
            r = await c.get(URLS["off2"], params={"q": QUERY, "page_size": 1})
            r.raise_for_status()
            if isinstance(r.json().get("hits"), list):
                return "warn", f"Основной поиск {first}, работает запасной - товары находятся, но медленнее."
            raise ValueError
        except (httpx.HTTPError, ValueError) as e:
            raise Bad(f"Open Food Facts: основной поиск {first}, запасной {_why(e)}. "
                      "Товары из магазинов ищутся только по своему справочнику.") from e


async def check_tablica():
    async with _client(headers={"User-Agent": websources.UA, "Accept-Language": "ru-RU,ru;q=0.9"}) as c:
        try:
            r = await c.get(f"{URLS['tablica']}/autocomplete/foodstuff-activity-meal", params={"query": QUERY},
                            headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise Bad(f"Таблица калорийности: поиск {_why(e)}. Поиск товаров с этого сайта не работает, остальные источники - да.") from e
        if not isinstance(data, list):
            raise Bad("Таблица калорийности отвечает, но поиск прислал не список товаров - сайт поменял поиск, товары с него не находятся.")
        urls = [x["url"] for x in data if isinstance(x, dict) and x.get("clazz") == "foodstuff" and x.get("url")]
        if not urls:
            raise Bad("Таблица калорийности отвечает, но по слову «молоко» не нашлось ни одного товара - "
                      "похоже, поменялся формат поиска, товары с этого сайта не находятся.")
        url = f"{URLS['tablica']}/produkty/{urls[0]}"
        try:
            r = await c.get(url)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise Bad(f"Таблица калорийности: поиск работает, а страница товара {_why(e)} - БЖУ с этого сайта не берутся.") from e
        if not websources.parse_page(url, r.text):
            raise Bad("Таблица калорийности отвечает, но со страницы товара не читаются белки/жиры/углеводы - "
                      "сайт поменял вёрстку, поиск товаров с него не работает.")
    return "ok", "Поиск и страница товара читаются, БЖУ на месте."


async def check_ddg():
    async with _client(headers={"User-Agent": websources.UA, "Accept-Language": "ru-RU,ru;q=0.9"}) as c:
        try:
            r = await c.post(URLS["ddg"], data={"q": f"{QUERY} калорийность", "kl": "ru-ru"})
            r.raise_for_status()
        except httpx.HTTPError as e:
            # вспомогательный источник: без него ищут Таблица калорийности и Open Food Facts - предупреждение, не тревога
            raise Bad(f"DuckDuckGo {_why(e)}. Поиск БЖУ на других сайтах временно без него, Таблица калорийности и Open Food Facts работают отдельно.", "warn") from e
    if r.status_code == 202:
        raise Bad("DuckDuckGo сейчас ограничивает запросы от роботов - поиск по сайтам-счётчикам временно без результатов. "
                  "Обычно проходит само.", "warn")
    if not re.search(r'class="result__a"', r.text):
        raise Bad("DuckDuckGo отвечает, но в ответе нет результатов поиска - похоже, поменялась страница, "
                  "поиск по сайтам-счётчикам не работает.", "warn")
    return "ok", "Поиск отвечает."


async def check_weather():
    params = {"latitude": "55.75", "longitude": "37.62", "timezone": "auto", "forecast_days": 1,
              "current": "temperature_2m"}
    async with _client(headers=weather.HEADERS) as c:
        try:
            r = await c.get(URLS["weather"], params=params)
            r.raise_for_status()
            cur = r.json().get("current") or {}
        except (httpx.HTTPError, ValueError) as e:
            raise Bad(f"Open-Meteo {_why(e)}. Погода на «Сегодня» не обновляется.") from e
    if "temperature_2m" not in cur:
        raise Bad("Open-Meteo отвечает, но без температуры - поменялся формат, погода не показывается.")
    return "ok", "Прогноз приходит."


async def check_ollama():
    from .ai import ollama
    st = await ollama.status()
    if st.get("ok"):
        return "ok", f"Модель {st.get('model')} на месте."
    reason = st.get("reason") or "недоступна"
    if "не скачана" in reason:
        raise Bad(f"Ollama работает, но {reason}. Задачи ИИ ждут в очереди. Скачать: ollama pull {st.get('model')}.")
    raise Bad(f"{reason} на компьютере. Задачи ИИ ждут в очереди, всё остальное работает.")


async def check_github():
    st = await asyncio.to_thread(updater.check, True, False)
    if st.get("offline"):
        raise Bad("Не удаётся связаться с GitHub - проверить и поставить обновления сейчас нельзя.", "warn")
    n = st.get("behind") or 0
    return "ok", ("Доступно обновление." if n else "Установлена последняя версия.")


CHECKS = {"off": check_off, "tablica": check_tablica, "ddg": check_ddg, "weather": check_weather,
          "ollama": check_ollama, "github": check_github}


def disabled(code: str) -> str | None:
    """Почему источник не проверяем (выключен), или None."""
    if code in ("off", "tablica", "ddg", "github") and brain.web_forced_off():
        return "Выход в интернет выключен на сервере (TRAINER_NO_WEB)."
    if code in ("off", "tablica", "ddg") and not brain.web_allowed():
        return "Поиск в интернете выключен в настройках приватности."
    if code == "weather" and not weather.allowed():
        return "Погода выключена" + (" на сервере (TRAINER_NO_WEB)." if weather.forced_off() else " в настройках приватности.")
    if code == "github":
        st = updater.check(fetch=False)
        if not st.get("available"):
            return "Сервер установлен не из git - обновления отсюда не ставятся."
    return None


# ── хранение ──

def _load() -> dict:
    rows = db.q("SELECT value FROM meta WHERE key = ?", (STATUS_KEY,))
    try:
        return json.loads(rows[0]["value"]) if rows else {}
    except (ValueError, TypeError):
        return {}


def _save(st: dict) -> None:
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (STATUS_KEY, json.dumps(st, ensure_ascii=False)))


async def _one(code: str) -> dict:
    off = await asyncio.to_thread(disabled, code)
    if off:
        return {"status": "off", "message": off, "ms": None}
    t0 = time.monotonic()
    try:
        level, msg = await asyncio.wait_for(CHECKS[code](), TIMEOUT * 3)
    except Bad as e:
        level, msg = e.level, str(e)
    except asyncio.TimeoutError:
        level, msg = "error", f"{NAMES[code]} не ответил за {TIMEOUT * 3} секунд."
    except Exception as e:  # noqa: BLE001 — неожиданное в проверке не должно ронять остальные
        level, msg = "error", f"{NAMES[code]}: проверка не удалась ({type(e).__name__}: {str(e)[:200]})"
    return {"status": level, "message": msg, "ms": round((time.monotonic() - t0) * 1000)}


async def run_checks() -> dict:
    """Проверить все источники сразу (параллельно) и сохранить."""
    async with _lock:
        results = await asyncio.gather(*(_one(code) for code, _, _ in SOURCES))
        st = _load()
        now = time.time()
        src = st.setdefault("sources", {})
        for (code, _, _), res in zip(SOURCES, results):
            cur = src.get(code) or {}
            hist = [h for h in (cur.get("history") or []) if isinstance(h, dict)]
            hist.append({"at": now, "status": res["status"], "ms": res["ms"],
                         **({"message": res["message"]} if res["status"] in ("warn", "error") else {})})
            last_ok = now if res["status"] == "ok" else cur.get("last_ok")
            src[code] = {**res, "at": now, "last_ok": last_ok, "history": hist[-HISTORY:]}
        st["checked_at"] = now
        await asyncio.to_thread(_save, st)
        return st


def status() -> dict:
    st = _load()
    src = st.get("sources") or {}
    out = []
    for code, name, purpose in SOURCES:
        s = src.get(code) or {}
        out.append({"code": code, "name": name, "purpose": purpose, "status": s.get("status") or "unknown",
                    "message": s.get("message") or "Ещё не проверялся.", "ms": s.get("ms"), "at": s.get("at"),
                    "last_ok": s.get("last_ok"), "history": s.get("history") or []})
    return {"checked_at": st.get("checked_at"), "sources": out, "running": _lock.locked(),
            "every_hours": EVERY // 3600}


async def _loop() -> None:
    await asyncio.sleep(FIRST_DELAY)
    while True:
        try:
            await run_checks()
        except Exception as e:  # noqa: BLE001 — проверка не должна ронять сервер
            print(f"  проверка источников не удалась: {e}")
        await asyncio.sleep(EVERY)


def start() -> None:
    asyncio.get_running_loop().create_task(_loop())


# ── API ──

@router.get("/api/monitor")
def monitor_status(u=Depends(current_user)):
    return status()


@router.post("/api/monitor/check")
async def monitor_check(u=Depends(current_user)):
    if _lock.locked():
        raise HTTPException(409, "Проверка уже идёт - через полминуты обновите экран")
    st = _load()
    if time.time() - (st.get("checked_at") or 0) < 20:
        return status()          # двойное нажатие - не ходим в сеть второй раз
    await run_checks()
    return status()
