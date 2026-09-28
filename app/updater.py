"""Обновление приложения через git (как в transkribator): проверка новых коммитов, git pull, доустановка зависимостей,
перезапуск сервера.

Работает, только если приложение установлено через `git clone` и в системе есть git.
Данные пользователей (data/: база, сертификаты, бэкапы) в .gitignore - pull их не трогает.
Клиенты (телефоны, планшеты) после перезапуска увидят метку «обновление» и поставят новую версию сами в безопасный момент.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from .db import ROOT

log = logging.getLogger("trainer.updater")

GIT = shutil.which("git")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DEPENDENCY_FILES = ("uv.lock", "pyproject.toml")
# служебные подписи в конце сообщений коммитов - пользователю в списке изменений не нужны
_TRAILER = re.compile(r"^(Co-Authored-By|Signed-off-by|Reviewed-by|Change-Id):", re.IGNORECASE)
CHECK_CACHE_SEC = 30 * 60  # как часто реально ходить в сеть при автоматической проверке

_cache: dict = {"time": 0.0, "result": None}
_lock = threading.Lock()


class UpdateError(RuntimeError):
    pass


def _git(*args: str, timeout: int = 30, raw: bool = False) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}  # без интерактивных запросов пароля
    try:
        proc = subprocess.run(
            [GIT, *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, env=env, creationflags=_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as e:
        raise UpdateError(f"git {args[0]}: превышено время ожидания") from e
    if proc.returncode != 0:
        raise UpdateError((proc.stderr or proc.stdout).strip() or f"git {args[0]} завершился с кодом {proc.returncode}")
    return proc.stdout if raw else proc.stdout.strip()


def current_version() -> dict:
    """Текущая версия: короткий хеш коммита и его дата (или «неизвестно» без git)."""
    if not GIT or not (ROOT / ".git").exists():
        return {"hash": None, "date": None, "subject": None}
    try:
        h, date, subject = _git("log", "-1", "--pretty=format:%h%x1f%cI%x1f%s").split("\x1f")
        return {"hash": h, "date": date, "subject": subject}
    except UpdateError:
        return {"hash": None, "date": None, "subject": None}


def _unavailable(reason: str) -> dict:
    return {"available": False, "reason": reason, "current": current_version()}


def check(fetch: bool = True, force: bool = False) -> dict:
    """Есть ли обновления. fetch=False - без обращения к сети (по уже скачанным данным)."""
    with _lock:
        if not force and fetch and _cache["result"] and time.time() - _cache["time"] < CHECK_CACHE_SEC:
            return _cache["result"]
        result = _check(fetch)
        if fetch:
            _cache.update(time=time.time(), result=result)
        return result


def _check(fetch: bool) -> dict:
    if not GIT:
        return _unavailable("В системе не найден git. Установите его (macOS: xcode-select --install; "
                            "Windows: git-scm.com), чтобы обновлять приложение отсюда.")
    if not (ROOT / ".git").exists():
        return _unavailable("Приложение установлено не через git (например, из ZIP-архива), поэтому обновить его отсюда нельзя. "
                            "Как перейти на git, не теряя данных, - README, раздел «Обновление».")
    try:
        branch = _git("rev-parse", "--abbrev-ref", "HEAD")
        upstream = _git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    except UpdateError:
        return _unavailable("У текущей ветки нет связанной ветки на GitHub (upstream) - обновлять не из чего.")

    offline = None
    if fetch:
        try:
            _git("fetch", "--quiet", "--prune", timeout=40)
        except UpdateError as e:
            offline = f"Не удалось связаться с GitHub: {e}"
            log.warning("Проверка обновлений: %s", offline)

    commits = []
    raw = _git("log", "HEAD..@{u}", "--pretty=format:%h%x1f%an%x1f%cI%x1f%s%x1f%b%x1e")
    for item in raw.split("\x1e"):
        item = item.strip("\n")
        if not item:
            continue
        h, author, date, subject, body = (item.split("\x1f") + [""] * 5)[:5]
        body = "\n".join(line for line in body.splitlines() if not _TRAILER.match(line.strip())).strip()
        commits.append({"hash": h, "author": author, "date": date, "subject": subject, "body": body})
    changed = _git("diff", "--name-only", "HEAD", "@{u}").splitlines() if commits else []
    # raw: у первой строки статуса ведущий пробел значимый (" M путь")
    dirty = [line[3:] for line in _git("status", "--porcelain", "--untracked-files=no", raw=True).splitlines() if line.strip()]
    ahead = int(_git("rev-list", "--count", "@{u}..HEAD") or 0)
    return {
        "available": True,
        "branch": branch,
        "upstream": upstream,
        "current": current_version(),
        "behind": len(commits),
        "ahead": ahead,
        "commits": commits,
        "files_changed": len(changed),
        "dependencies_changed": any(f in DEPENDENCY_FILES for f in changed),
        "dirty": dirty,
        "offline": offline,
        "checked_at": time.time(),
    }


def _find_uv() -> str | None:
    exe = "uv.exe" if sys.platform == "win32" else "uv"
    # из Dock/виджета PATH минимальный - проверяем и стандартные места установки uv
    candidates = [shutil.which("uv"), str(Path.home() / ".local" / "bin" / exe), str(Path.home() / ".cargo" / "bin" / exe),
                  "/opt/homebrew/bin/uv", "/usr/local/bin/uv"]
    return next((c for c in candidates if c and Path(c).exists()), None)


def apply() -> dict:
    """git pull --ff-only + (при необходимости) uv sync. Перезапуск делает вызывающий код."""
    with _lock:
        st = _check(fetch=True)
        if not st["available"]:
            raise UpdateError(st["reason"])
        if st["offline"]:
            raise UpdateError(st["offline"])
        if st["behind"] == 0:
            return {"updated": False, "message": "Уже установлена последняя версия", "current": st["current"]}
        if st["dirty"]:
            raise UpdateError("В папке приложения есть изменённые файлы - обновление их перезаписало бы: "
                              + ", ".join(st["dirty"][:8]) + ". Сохраните их отдельно или выполните `git stash`.")
        before = st["current"]["hash"]
        log.info("Обновление: %s → %s (%d коммитов)", before, st["upstream"], st["behind"])
        before_full = _git("rev-parse", "HEAD")  # запоминаем ДО pull - к нему откатываемся при сбое
        _git("pull", "--ff-only", "--quiet", timeout=120)

        synced = False
        if st["dependencies_changed"]:
            try:
                _sync_dependencies()
            except UpdateError:
                # код без подходящих библиотек не запустится - возвращаем прежнюю версию целиком.
                # Безопасно: изменённых файлов нет (проверено выше), данные и модели git не отслеживает.
                _git("reset", "--hard", "--quiet", before_full)
                log.error("Обновление откатено к %s", before)
                raise
            synced = True
        _cache.update(time=0.0, result=None)
        after = current_version()
        log.info("Обновление завершено: %s → %s, зависимости %s", before, after["hash"], "обновлены" if synced else "без изменений")
        return {"updated": True, "from": before, "to": after, "dependencies_synced": synced}


def _sync_dependencies() -> None:
    uv = _find_uv()
    if not uv:
        raise UpdateError("Новая версия требует обновить библиотеки, а менеджер uv не найден. "
                          "Обновление отменено. Выполните в папке приложения: uv sync - и повторите.")
    args = [uv, "sync", "--frozen", "--no-dev"]
    log.info("Обновление зависимостей: %s", " ".join(args[1:]))
    try:
        proc = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=1800, creationflags=_NO_WINDOW)
    except subprocess.TimeoutExpired as e:
        raise UpdateError("Обновление библиотек заняло слишком много времени. Обновление отменено.") from e
    if proc.returncode != 0:
        log.error("uv sync: %s", proc.stderr[-2000:])
        raise UpdateError("Не удалось обновить библиотеки, обновление отменено: " + proc.stderr.strip()[-400:])


def restart_soon(delay: float = 1.0) -> None:
    """Перезапуск сервера с новым кодом после отправки ответа клиенту."""

    def _restart():
        time.sleep(delay)
        args = [sys.executable, str(ROOT / "run.py")]
        log.info("Перезапуск сервера после обновления")
        logging.shutdown()
        if sys.platform == "win32":
            # новое окно сервера; старый процесс завершается и освобождает порт
            subprocess.Popen(args, cwd=ROOT, creationflags=subprocess.CREATE_NEW_CONSOLE)
            os._exit(0)
        else:
            # тот же процесс, новый код; слушающие сокеты не наследуются (PEP 446) - новый сервер займёт те же порты
            os.execv(sys.executable, args)

    threading.Thread(target=_restart, daemon=True, name="restart").start()
