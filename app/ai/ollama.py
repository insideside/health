"""Минимальный клиент Ollama: один запрос - один JSON по схеме."""
import json
import os
import time
from urllib.parse import urlparse

import httpx

from .. import ailog

URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
# ИИ только на этом компьютере: личные данные уходят в модель, и отправлять их куда-то ещё нельзя.
# Чужой адрес в OLLAMA_URL не принимаем вовсе, а не «предупреждаем».
_host = urlparse(URL).hostname or ""
if _host not in ("127.0.0.1", "localhost", "::1"):
    raise SystemExit(f"OLLAMA_URL должен указывать на этот компьютер (127.0.0.1), а не на {_host}")
MODEL = os.environ.get("TRAINER_MODEL", "qwen3:30b")


class AIError(Exception):
    pass


async def status() -> dict:
    """Есть ли Ollama и скачана ли модель. Модель не загружает."""
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{URL}/api/tags")
            names = [m["name"] for m in r.json().get("models", [])]
    except (httpx.HTTPError, ValueError):
        return {"ok": False, "model": MODEL, "reason": "Ollama не запущена"}
    if MODEL not in names and f"{MODEL}:latest" not in names:
        return {"ok": False, "model": MODEL, "reason": f"модель {MODEL} не скачана"}
    return {"ok": True, "model": MODEL}


async def ask_json(system: str, user: str, schema: dict, temperature: float = 0.3, think: bool = False,
                   history: list[dict] | None = None, kind: str = "other", uid: str | None = None,
                   log: dict | None = None) -> dict:
    """history - прошлые реплики [{role: user|assistant, content}] между системным промптом и вопросом (чат).
    kind/uid - для учёта задач ИИ (app/ailog.py: вид, кто, время, размеры - без содержимого). В log (если передан)
    кладётся id строки учёта - по нему вызывающий допишет сравнение «в тени»."""
    started, t0 = int(time.time() * 1000), time.monotonic()
    prompt_chars = len(system) + len(user) + sum(len(str(h.get("content") or "")) for h in history or [])

    def _log(ok: bool, answer_chars: int | None = None, error: str | None = None) -> None:
        try:
            lid = ailog.record(kind, uid, started, int((time.monotonic() - t0) * 1000), prompt_chars, answer_chars,
                               think, ok, error, MODEL)
            if log is not None:
                log["id"] = lid
        except Exception:  # noqa: BLE001 - учёт не ломает задачу
            pass

    try:
        out, n = await _ask(system, user, schema, temperature, think, history)
    except AIError as e:
        _log(False, error=str(e))
        raise
    _log(True, n)
    return out


async def _ask(system: str, user: str, schema: dict, temperature: float, think: bool,
               history: list[dict] | None) -> tuple[dict, int]:
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system}, *(history or []), {"role": "user", "content": user}],
        "format": schema,
        "stream": False,
        "think": think,
        "keep_alive": "5m",
        "options": {"temperature": temperature, "num_ctx": 16384},
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=5)) as c:
            r = await c.post(f"{URL}/api/chat", json=body)
    except httpx.ConnectError:
        raise AIError("Ollama не запущена: brew services start ollama")
    except httpx.HTTPError as e:
        raise AIError(f"Ollama: {e}")
    if r.status_code != 200:
        raise AIError(f"Ollama {r.status_code}: {r.text[:300]}")
    content = r.json().get("message", {}).get("content", "")
    try:
        return json.loads(content), len(content)
    except json.JSONDecodeError:
        raise AIError("Модель вернула не JSON")
