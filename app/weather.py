"""Погода для «Сегодня» и подсказок кардио: Open-Meteo (без ключа).

Наружу уходят только координаты города из профиля (или строка поиска города при геокодинге) — ни имени,
ни id, ни записей. Выключается настройкой сервера `meta.weather` (Профиль → «Данные и приватность») или
жёстко — `TRAINER_NO_WEB=1`. Ответы кэшируются в памяти на час на точку (координаты округлены до 0,01°).
"""
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from . import db, userdata
from .userdata import current_user

router = APIRouter()

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
TTL = 3600
HEADERS = {"User-Agent": "Trainer/1.0"}
_cache: dict[str, tuple[float, dict]] = {}
_geo_cache: dict[str, tuple[float, list]] = {}


def forced_off() -> bool:
    from . import brain
    return brain.web_forced_off()


def allowed() -> bool:
    """Погода — второй (после Open Food Facts) выход сервера в интернет. По умолчанию включена."""
    if forced_off():
        return False
    rows = db.q("SELECT value FROM meta WHERE key = 'weather'")
    return not rows or rows[0]["value"] != "0"


def set_allowed(on: bool) -> None:
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO meta VALUES ('weather', ?)", ("1" if on else "0",))


def _check() -> None:
    if not allowed():
        raise HTTPException(409, "Погода выключена на сервере" + (" (TRAINER_NO_WEB=1)" if forced_off() else ""))


def _coord(v, lo: float, hi: float) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if lo <= x <= hi else None


async def fetch(lat: float, lon: float) -> dict:
    key = f"{lat:.2f},{lon:.2f}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < TTL:
        return {**hit[1], "cached": True}
    params = {
        "latitude": f"{lat:.2f}", "longitude": f"{lon:.2f}", "timezone": "auto", "forecast_days": 3,
        "wind_speed_unit": "ms",
        "current": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset,weather_code",
    }
    try:
        async with httpx.AsyncClient(timeout=6, headers=HEADERS) as c:
            r = await c.get(FORECAST_URL, params=params)
            r.raise_for_status()
            raw = r.json()
    except (httpx.HTTPError, ValueError) as e:
        if hit:   # сеть пропала — отдаём последнее, честно помечая время
            return {**hit[1], "cached": True, "stale": True}
        raise HTTPException(502, f"Open-Meteo недоступен: {type(e).__name__}")
    cur = raw.get("current") or {}
    d = raw.get("daily") or {}
    days = []
    for i, day in enumerate(d.get("time") or []):
        def at(k):
            v = d.get(k) or []
            return v[i] if i < len(v) else None
        days.append({"date": day, "tmax": at("temperature_2m_max"), "tmin": at("temperature_2m_min"),
                     "precip": at("precipitation_sum"), "code": at("weather_code"),
                     "sunrise": (at("sunrise") or "")[-5:] or None, "sunset": (at("sunset") or "")[-5:] or None})
    out = {
        "lat": round(lat, 2), "lon": round(lon, 2), "tz": raw.get("timezone"),
        "current": {"time": cur.get("time"), "temp": cur.get("temperature_2m"), "feels": cur.get("apparent_temperature"),
                    "precip": cur.get("precipitation"), "code": cur.get("weather_code"), "wind": cur.get("wind_speed_10m")},
        "daily": days, "fetched_at": int(time.time() * 1000), "source": "open-meteo",
    }
    _cache[key] = (time.time(), out)
    return {**out, "cached": False}


@router.get("/api/weather")
async def weather(lat: float | None = None, lon: float | None = None, u=Depends(current_user)):
    _check()
    loc = userdata.profile(u["id"]).get("location") or {}
    la = _coord(lat if lat is not None else loc.get("lat"), -90, 90)
    lo = _coord(lon if lon is not None else loc.get("lon"), -180, 180)
    if la is None or lo is None:
        raise HTTPException(400, "Город не указан: Профиль → «Погода и город»")
    res = await fetch(la, lo)
    return {**res, "city": loc.get("city") if lat is None else None}


@router.get("/api/weather/geocode")
async def geocode(q: str = "", u=Depends(current_user)):
    _check()
    q = " ".join(q.split())[:60]
    if len(q) < 2:
        return {"results": []}
    key = q.lower()
    hit = _geo_cache.get(key)
    if hit and time.time() - hit[0] < 24 * 3600:
        return {"results": hit[1]}
    try:
        async with httpx.AsyncClient(timeout=6, headers=HEADERS) as c:
            r = await c.get(GEOCODE_URL, params={"name": q, "count": 5, "language": "ru", "format": "json"})
            r.raise_for_status()
            raw = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, f"Поиск города недоступен: {type(e).__name__}")
    out = []
    for x in raw.get("results") or []:
        if x.get("latitude") is None or x.get("longitude") is None:
            continue
        region = ", ".join(v for v in (x.get("admin1"), x.get("country")) if v and v != x.get("name"))
        out.append({"city": x.get("name"), "region": region, "lat": round(float(x["latitude"]), 3),
                    "lon": round(float(x["longitude"]), 3), "tz": x.get("timezone")})
    _geo_cache[key] = (time.time(), out)
    return {"results": out}


def settings_patch(body: dict, request: Request) -> None:
    """Вызов из POST /api/brain/settings: {weather: bool}."""
    if "weather" in body:
        if forced_off() and body["weather"]:
            raise HTTPException(409, "Выход в интернет выключен на сервере (TRAINER_NO_WEB=1)")
        set_allowed(bool(body["weather"]))
