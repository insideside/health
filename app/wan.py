"""Доступ из интернета (WAN) и «свои» адреса сервера.

Два режима, как в vk-music:
- `tunnel` — быстрый туннель Cloudflare (`cloudflared tunnel --url …`): адрес `*.trycloudflare.com`,
  HTTPS даёт Cloudflare, роутер настраивать не нужно. Адрес меняется при каждом запуске — поэтому
  клиент хранит список зеркал, а не один адрес.
- `static` — пользователь сам пробросил порт на роутере на HTTPS-порт Mac и вводит внешний адрес.

Туннель ведём на HTTPS-порт, а не на HTTP (localhost): HTTP-порт считается «этим Mac» (управление
WAN, виджет), и запросы из интернета не должны приходить на него с адреса 127.0.0.1.

Настройки — в `data/settings.json` (`wan: {mode, url}`), рядом живёт `server_id` — случайный
идентификатор сервера, по которому клиент узнаёт «свой» сервер среди зеркал.
"""
import asyncio
import ipaddress
import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Request

from . import certs
from .db import DATA_DIR, ROOT

SETTINGS = DATA_DIR / "settings.json"
HTTPS_PORT = int(os.environ.get("TRAINER_PORT", 8790))
HTTP_PORT = int(os.environ.get("TRAINER_HTTP_PORT", HTTPS_PORT + 1))
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
TUNNEL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# состояние процесса: что включено, какой адрес сейчас, что пошло не так
state = {"mode": "off", "url": None, "status": "off", "error": None, "since": None}
_task: asyncio.Task | None = None
_proc: asyncio.subprocess.Process | None = None


# ── настройки ──

def load_settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(patch: dict) -> None:
    s = load_settings()
    s.update(patch)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(SETTINGS)


def server_id() -> str:
    s = load_settings()
    if not s.get("server_id"):
        s["server_id"] = secrets.token_hex(8)
        save_settings({"server_id": s["server_id"]})
    return s["server_id"]


def static_host() -> str | None:
    """Хост статического адреса — чтобы certs положил его в сертификат."""
    w = load_settings().get("wan") or {}
    if w.get("mode") == "static" and w.get("url"):
        return urlsplit(w["url"]).hostname
    return None


def normalize_static(raw: str) -> str:
    """Внешний адрес → `https://host[:port]`. Только HTTPS: иначе пароль шёл бы по сети открытым текстом."""
    v = (raw or "").strip().rstrip("/")
    if not v:
        raise ValueError("Укажите внешний адрес или IP")
    if "://" not in v:
        v = "https://" + v
    p = urlsplit(v)
    if p.scheme != "https":
        raise ValueError("Нужен адрес с https:// — без шифрования пароль виден в сети")
    host = p.hostname or ""
    if not re.fullmatch(r"[a-z0-9.-]{1,253}", host):
        raise ValueError("Не похоже на адрес: ожидается домен или IP")
    if p.path not in ("", "/") or p.query or p.username:
        raise ValueError("Только адрес и порт, без пути")
    try:
        port = p.port
    except ValueError:
        raise ValueError("Порт — число от 1 до 65535")
    return f"https://{host}" + (f":{port}" if port and port != 443 else "")


# ── cloudflared ──

def find_cloudflared() -> str | None:
    for cand in (ROOT / "bin" / "cloudflared", ROOT / "cloudflared"):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    # start.command запускается без PATH из профиля — Homebrew ищем явно
    return shutil.which("cloudflared") or next(
        (p for p in ("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared") if os.access(p, os.X_OK)), None)


async def _run_tunnel() -> None:
    """Держит туннель живым: упал — перезапуск с растущей паузой (5 с … 5 мин)."""
    global _proc
    backoff = 5
    while state["mode"] == "tunnel":
        exe = find_cloudflared()
        if not exe:
            state.update(status="error", url=None, error="cloudflared не установлен. Установите: brew install cloudflared")
            return
        state.update(status="starting", url=None, error=None)
        started = time.time()
        try:
            _proc = await asyncio.create_subprocess_exec(
                exe, "tunnel", "--no-autoupdate", "--no-tls-verify", "--url", f"https://127.0.0.1:{HTTPS_PORT}",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            # cloudflared пишет адрес в лог; читаем до конца, иначе переполненный канал его остановит
            while line := await _proc.stdout.readline():
                m = TUNNEL_RE.search(line.decode("utf-8", "replace"))
                if m and state["url"] != m.group(0):
                    state.update(url=m.group(0), status="on", since=int(time.time() * 1000))
                    remember_url(m.group(0))
                    print(f"  интернет:   {m.group(0)}")
            await _proc.wait()
            err = f"cloudflared завершился (код {_proc.returncode})"
        except OSError as e:
            err = f"Не удалось запустить cloudflared: {e}"
        finally:
            _proc = None
        if state["mode"] != "tunnel":
            return
        if time.time() - started > 120:
            backoff = 5
        state.update(status="error", url=None, error=f"{err}. Перезапуск через {backoff} с")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 300)


async def _stop_tunnel() -> None:
    global _task
    if _proc and _proc.returncode is None:
        _proc.terminate()
        try:
            await asyncio.wait_for(_proc.wait(), 5)
        except asyncio.TimeoutError:
            _proc.kill()
    if _task and not _task.done():
        _task.cancel()
    _task = None


async def apply(mode: str, url: str | None = None, persist: bool = True) -> dict:
    """Включить/выключить WAN. Бросает ValueError с понятным текстом."""
    global _task
    if mode not in ("off", "tunnel", "static"):
        raise ValueError("Режим: off, tunnel или static")
    if mode == "static":
        url = normalize_static(url or "")
    state["mode"] = mode   # до остановки: цикл туннеля по нему понимает, что перезапуск не нужен
    await _stop_tunnel()
    state.update(url=None, error=None, since=None, status="off")
    if mode == "tunnel":
        if not find_cloudflared():
            state.update(status="error", error="cloudflared не установлен. Установите: brew install cloudflared")
        else:
            state["status"] = "starting"
            _task = asyncio.create_task(_run_tunnel())
    elif mode == "static":
        state.update(url=url, status="on", since=int(time.time() * 1000))
        remember_url(url)
    if persist:
        prev = load_settings().get("wan") or {}
        save_settings({"wan": {"mode": mode, "url": url if mode == "static" else prev.get("url")}})
    return status()


async def start() -> None:
    """При запуске сервера: восстановить сохранённый режим."""
    w = load_settings().get("wan") or {}
    if w.get("mode") in ("tunnel", "static"):
        try:
            await apply(w["mode"], w.get("url"), persist=False)
        except ValueError as e:
            state.update(status="error", error=str(e))


async def stop() -> None:
    state["mode"] = "off"
    await _stop_tunnel()


def status() -> dict:
    saved = (load_settings().get("wan") or {})
    host = urlsplit(state["url"]).hostname if state["mode"] == "static" and state["url"] else None
    # статический адрес должен быть в сертификате, иначе iPhone не доверит соединению
    cert_ok = True
    if host:
        try:
            names = json.loads(certs.NAMES.read_text())
            cert_ok = host in names.get("dns", []) or host in names.get("ips", [])
        except (OSError, ValueError):
            cert_ok = False
    return {**state, "static_url": saved.get("url"), "cloudflared": bool(find_cloudflared()),
            "cert_ok": cert_ok, "https_port": HTTPS_PORT}


# ── адреса и происхождение запроса ──

_ips_cache: tuple[float, list[str]] = (0, [])


def lan_ips() -> list[str]:
    """IP Mac с кэшем на минуту: список нужен на каждый CORS-запрос, а внутри — subprocess."""
    global _ips_cache
    if time.time() - _ips_cache[0] > 60:
        _ips_cache = (time.time(), certs.local_ips())
    return _ips_cache[1]


def mirrors() -> list[dict]:
    out = []
    host = certs.mdns_name()
    if host:
        out.append({"url": f"https://{host}:{HTTPS_PORT}", "kind": "mdns"})
    out += [{"url": f"https://{ip}:{HTTPS_PORT}", "kind": "lan"} for ip in lan_ips()]
    if state["url"]:
        out.append({"url": state["url"], "kind": "wan"})
    return out


def remember_url(url: str) -> None:
    """Прошлые внешние адреса: PWA, установленная по старому адресу туннеля, должна достучаться до зеркал."""
    hist = [u for u in load_settings().get("wan_history", []) if u != url]
    save_settings({"wan_history": [url, *hist][:20]})


_origins_cache: tuple[float, set[str]] = (0, set())


def own_origins() -> set[str]:
    """Origin'ы самого приложения: только им разрешены запросы к API с другого адреса (CORS).
    Сюда входят и прежние адреса (из сертификата и истории WAN): как раз PWA со старого адреса
    и нуждается в зеркале."""
    global _origins_cache
    if time.time() - _origins_cache[0] < 10:
        return _origins_cache[1] | ({state["url"]} if state["url"] else set())
    o = {m["url"] for m in mirrors()}
    o |= {f"https://localhost:{HTTPS_PORT}", f"https://127.0.0.1:{HTTPS_PORT}",
          f"http://localhost:{HTTP_PORT}", f"http://127.0.0.1:{HTTP_PORT}"}
    try:
        names = json.loads(certs.NAMES.read_text())
        o |= {f"https://{n}:{HTTPS_PORT}" for n in names.get("dns", []) + names.get("ips", [])}
    except (OSError, ValueError):
        pass
    s = load_settings()
    o |= set(s.get("wan_history", []))
    if (s.get("wan") or {}).get("url"):
        o.add(s["wan"]["url"])
    _origins_cache = (time.time(), o)
    return o


def is_local(request: Request) -> bool:
    """Запрос с этого Mac: HTTP-порт слушает только 127.0.0.1, туннель на него не ведёт.
    Host проверяем от DNS-rebinding (чужой сайт, чьё имя указывает на 127.0.0.1)."""
    server = request.scope.get("server") or (None, None)
    client = peer_ip(request)
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    return server[1] == HTTP_PORT and client in ("127.0.0.1", "::1") and host in LOCAL_HOSTS


def peer_ip(request: Request) -> str:
    """Адрес соединения. Сервер слушает IPv6 и IPv4 сразу, и IPv4-клиенты приходят как «::ffff:192.168.0.5» —
    приводим к обычному виду, иначе проверки «с этого Mac» и «через туннель» перестали бы узнавать 127.0.0.1."""
    ip = request.client.host if request.client else ""
    return ip[7:] if ip.lower().startswith("::ffff:") and "." in ip else ip


def client_ip(request: Request) -> str:
    """Настоящий адрес клиента: для туннеля его сообщает Cloudflare (заголовку верим только с 127.0.0.1)."""
    ip = peer_ip(request)
    if ip in ("127.0.0.1", "::1") and request.headers.get("cf-connecting-ip"):
        return request.headers["cf-connecting-ip"]
    return ip


def is_wan(request: Request) -> bool:
    """Запрос пришёл из интернета (туннель или проброшенный порт), а не из домашней сети."""
    ip = client_ip(request)
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return not (a.is_private or a.is_loopback or a.is_link_local)
