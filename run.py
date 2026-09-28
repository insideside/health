"""Запуск: HTTPS для локальной сети и HTTP только для этого компьютера.

  uv run run.py

HTTPS  https://<имя>.local:8790  — телефоны и другие устройства (Service Worker в сети работает только по HTTPS)
HTTP   http://localhost:8791     — этот компьютер, без установки сертификата
"""
import asyncio
import os
import socket
import sys

import uvicorn
from pathlib import Path


def _load_settings() -> None:
    """settings.env рядом с run.py (пишет установщик): TRAINER_MODEL=qwen3:14b и т. п.
    Уже заданные переменные окружения важнее файла."""
    f = Path(__file__).resolve().parent / "settings.env"
    if not f.exists():
        return
    for line in f.read_text("utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))


_load_settings()          # до импорта app: модель и порты читаются при импорте

from app import certs, wan  # noqa: E402
from app.server import HTTPS_PORT, app  # noqa: E402

HTTP_PORT = int(os.environ.get("TRAINER_HTTP_PORT", HTTPS_PORT + 1))


def _has_ipv6() -> bool:
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as t:
            t.bind(("::", 0))
        return True
    except OSError:
        return False


async def main() -> None:
    cert, key = certs.ensure()
    host = certs.mdns_name()
    print("\n  Тренер запущен")
    print(f"  этот Mac:   http://localhost:{HTTP_PORT}")
    if host:
        print(f"  в сети:     https://{host}:{HTTPS_PORT}")
    for ip in certs.local_ips():
        print(f"              https://{ip}:{HTTPS_PORT}")
    print(f"  сертификат для iPhone: https://{host or 'IP'}:{HTTPS_PORT}/ca.crt\n")

    ssl = dict(ssl_certfile=cert, ssl_keyfile=key, log_level="warning")
    servers = [
        uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=HTTPS_PORT, lifespan="on", **ssl)),
        # второй сервер делит то же приложение; lifespan (БД, очередь ИИ) запускает только первый
        uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=HTTP_PORT, log_level="warning", lifespan="off")),
    ]
    # Тот же HTTPS и по IPv6: iPhone находит Mac по имени .local и сначала идёт на его IPv6-адрес (fe80::…).
    # Без этого адрес с именем Mac с телефона «недоступен», хотя по IP открывается. Отдельный слушатель,
    # потому что asyncio открывает IPv6-сокет в режиме «только IPv6».
    if _has_ipv6() and not os.environ.get("TRAINER_NO_IPV6"):
        servers.append(uvicorn.Server(uvicorn.Config(app, host="::", port=HTTPS_PORT, lifespan="off", **ssl)))
    # доступ из интернета — если включён в настройках (профиль → Подключение)
    wan_start = asyncio.create_task(wan.start())
    try:
        await asyncio.gather(*(s.serve() for s in servers))
    finally:
        wan_start.cancel()
        await wan.stop()   # не оставляем cloudflared висеть после остановки сервера


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
