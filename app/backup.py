"""Резервные копии БД и экспорт своих записей.

Копия — через backup API SQLite: она согласована даже при открытых транзакциях и WAL,
в отличие от копирования файла. Делается по календарю: при старте, если копии за сегодня нет,
и каждый день вскоре после полуночи. Каждую копию сразу проверяем (integrity_check + число строк),
неудачная не заменяет прежние. Храним 14 ежедневных + 8 еженедельных (понедельник) + 12 ежемесячных (1-е число).

Необязательная вторая папка `TRAINER_BACKUP_DIR` (settings.env): туда дублируется свежая копия
(iCloud Drive, внешний диск). Недоступна — ошибка в статусе, сервер работает дальше.
Статус хранится в `meta.backup_status` (JSON).
"""
import asyncio
import json
import os
import shutil
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from . import db, wan
from .userdata import current_user

KEEP_DAILY, KEEP_WEEKLY, KEEP_MONTHLY = 14, 8, 12
AFTER_MIDNIGHT_MIN = 5          # ночная копия - в 00:05 и позже
RETRY_SEC = 3600                # после неудачи пробуем снова через час, а не каждые 10 минут
TICK_SEC = 600                  # проверяем часы раз в 10 минут: так копия не теряется после сна компьютера
COUNT_TABLES = ("records", "users", "foods")
STATUS_KEY = "backup_status"
PREFIX = "trainer-"

router = APIRouter()
_run_lock = threading.Lock()    # ночная копия и кнопка «Сделать копию сейчас» не идут одновременно
_last_fail = 0.0


def folder() -> Path:
    return db.DATA_DIR / "backups"


def mirror_dir() -> Path | None:
    v = os.environ.get("TRAINER_BACKUP_DIR", "").strip()
    return Path(v).expanduser() if v else None


def _day_of(p: Path) -> date | None:
    try:
        return date.fromisoformat(p.stem[len(PREFIX):])
    except ValueError:
        return None


def _copies(where: Path) -> list[tuple[date, Path]]:
    out = [(d, p) for p in where.glob(f"{PREFIX}*.db") if (d := _day_of(p))]
    return sorted(out)


def keep_set(days: list[date]) -> set[date]:
    """Что оставить: 14 последних дней, 8 последних недель и 12 последних месяцев.
    Для недели берём самую раннюю копию недели (обычно понедельник), для месяца - самую раннюю
    в месяце (обычно 1-е число): если в понедельник компьютер был выключен, неделя не пропадает."""
    days = sorted(set(days))
    keep = set(days[-KEEP_DAILY:])
    weeks: dict[tuple, date] = {}
    months: dict[tuple, date] = {}
    for d in days:
        weeks.setdefault(tuple(d.isocalendar())[:2], d)
        months.setdefault((d.year, d.month), d)
    keep |= set(sorted(weeks.values())[-KEEP_WEEKLY:])
    keep |= set(sorted(months.values())[-KEEP_MONTHLY:])
    return keep


def _rotate(where: Path) -> int:
    items = _copies(where)
    keep = keep_set([d for d, _ in items])
    for d, p in items:
        if d not in keep:
            p.unlink(missing_ok=True)
    return len(_copies(where))


def _counts(c: sqlite3.Connection) -> dict:
    return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in COUNT_TABLES}


def verify(path: Path, live: dict) -> dict:
    """Открыть копию только для чтения: integrity_check == ok и строки на месте. → счётчики или исключение."""
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        res = c.execute("PRAGMA integrity_check").fetchone()[0]
        if res != "ok":
            raise RuntimeError(f"копия повреждена (integrity_check: {res[:200]})")
        got = _counts(c)
    finally:
        c.close()
    if live.get("users") and not got.get("users"):
        raise RuntimeError("в копии нет пользователей")
    if got.get("records", 0) < 0.9 * live.get("records", 0):
        raise RuntimeError(f"в копии {got['records']} записей из {live['records']}")
    if got.get("foods", 0) < 0.9 * live.get("foods", 0):
        raise RuntimeError(f"в копии {got['foods']} продуктов из {live['foods']}")
    return got


# ── статус ──

def _load() -> dict:
    rows = db.q("SELECT value FROM meta WHERE key = ?", (STATUS_KEY,))
    try:
        return json.loads(rows[0]["value"]) if rows else {}
    except (ValueError, TypeError):
        return {}


def _save(st: dict) -> None:
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (STATUS_KEY, json.dumps(st, ensure_ascii=False)))


def status() -> dict:
    st = _load()
    items = _copies(folder()) if folder().exists() else []
    st["count"] = len(items)
    st["total_bytes"] = sum(p.stat().st_size for _, p in items if p.exists())
    st["oldest"] = items[0][0].isoformat() if items else None
    md = mirror_dir()
    st["mirror_dir"] = str(md) if md else None
    if not md:
        st.pop("mirror", None)
    st["policy"] = {"daily": KEEP_DAILY, "weekly": KEEP_WEEKLY, "monthly": KEEP_MONTHLY}
    ok_at = (st.get("last_ok") or {}).get("at") or 0
    err_at = (st.get("last_error") or {}).get("at") or 0
    # «сломано»: последняя попытка не удалась, или удачной копии нет больше двух суток
    st["problem"] = bool(err_at > ok_at or (ok_at and time.time() - ok_at > 2 * 86400) or (not ok_at and err_at))
    return st


# ── копия ──

def _mirror(src: Path, st: dict) -> None:
    md = mirror_dir()
    if not md:
        return
    try:
        if not md.is_dir():
            raise OSError(f"папка {md} недоступна (не подключён диск или нет такой папки)")
        dst = md / src.name
        tmp = dst.with_suffix(".tmp")
        shutil.copyfile(src, tmp)
        tmp.replace(dst)
        n = _rotate(md)
        st["mirror"] = {"ok": True, "at": time.time(), "dir": str(md), "count": n, "error": None}
    except OSError as e:
        st["mirror"] = {"ok": False, "at": time.time(), "dir": str(md),
                        "error": f"Не удалось скопировать во вторую папку: {e}"}
        print(f"  копия во вторую папку не удалась: {e}")


def backup_now(force: bool = False) -> dict:
    """Копия за сегодня (если её ещё нет, или force - заново). Проверяется до того, как заменит прежнюю.
    → статус; ошибки копии записываются в статус, а не бросаются (кроме уже идущей копии)."""
    global _last_fail
    if not _run_lock.acquire(blocking=False):
        raise RuntimeError("копия уже делается")
    try:
        where = folder()
        path = where / f"{PREFIX}{date.today().isoformat()}.db"
        st = _load()
        # копия за сегодня есть, но проверенной ещё не было (первый запуск после обновления) - делаем заново с проверкой
        if path.exists() and not force and st.get("last_ok"):
            _rotate(where)
            return status()
        tmp = path.with_suffix(".tmp")
        t0 = time.time()
        try:
            where.mkdir(parents=True, exist_ok=True)
            tmp.unlink(missing_ok=True)
            dst = sqlite3.connect(tmp)
            try:
                with db._lock:
                    db.conn().backup(dst)
                    live = _counts(db.conn())   # под тем же замком: между копией и подсчётом ничего не записалось
                dst.execute("PRAGMA journal_mode=DELETE")   # копия - один файл, без -wal/-shm рядом
            finally:
                dst.close()
            for side in ("-wal", "-shm"):
                Path(f"{tmp}{side}").unlink(missing_ok=True)
            got = verify(tmp, live)
            tmp.replace(path)
        except Exception as e:  # noqa: BLE001 — любая ошибка копии остаётся в статусе, прежние копии целы
            for p in (tmp, Path(f"{tmp}-wal"), Path(f"{tmp}-shm")):
                p.unlink(missing_ok=True)
            _last_fail = time.time()
            st["last_error"] = {"at": time.time(), "text": str(e) or type(e).__name__}
            _save(st)
            print(f"  бэкап не удался: {e}")
            return status()
        st["last_ok"] = {"at": time.time(), "file": path.name, "date": date.today().isoformat(),
                         "size": path.stat().st_size, "verified": True, "counts": got,
                         "seconds": round(time.time() - t0, 2)}
        _rotate(where)
        _mirror(path, st)
        _save(st)
        return status()
    finally:
        _run_lock.release()


def _due() -> bool:
    """Пора делать копию: за сегодня её нет, уже 00:05 или позже, и после неудачи прошёл час."""
    if (folder() / f"{PREFIX}{date.today().isoformat()}.db").exists() and _load().get("last_ok"):
        return False
    now = datetime.now()
    if now.hour == 0 and now.minute < AFTER_MIDNIGHT_MIN and _load().get("last_ok"):
        return False
    return time.time() - _last_fail >= RETRY_SEC


def _retry_mirror() -> None:
    """Вторая папка была недоступна (диск отключён) - раз в час пробуем донести туда сегодняшнюю копию."""
    st = _load()
    m = st.get("mirror") or {}
    path = folder() / f"{PREFIX}{date.today().isoformat()}.db"
    if mirror_dir() and m and not m.get("ok") and time.time() - (m.get("at") or 0) >= RETRY_SEC and path.exists():
        with _run_lock:
            _mirror(path, st)
            _save(st)


async def _loop() -> None:
    while True:
        try:
            if _due():
                await asyncio.to_thread(backup_now)
            else:
                await asyncio.to_thread(_retry_mirror)
        except Exception as e:  # noqa: BLE001 — бэкап не должен ронять сервер
            print(f"  бэкап не удался: {e}")
        await asyncio.sleep(TICK_SEC)


def start() -> None:
    asyncio.get_running_loop().create_task(_loop())


# ── API ──

def can_manage(request: Request, u) -> bool:
    """Делать копию по кнопке: владелец сервера (первый пользователь) или человек у самого компьютера."""
    return wan.is_local(request) or bool(u and db.is_admin(u["id"]))


@router.get("/api/backup/status")
def backup_status(request: Request, u=Depends(current_user)):
    return {**status(), "can_manage": can_manage(request, u)}


@router.post("/api/backup/run")
async def backup_run(request: Request, u=Depends(current_user)):
    if not can_manage(request, u):
        raise HTTPException(403, "Копию по кнопке делает владелец сервера или человек у самого компьютера")
    try:
        st = await asyncio.to_thread(backup_now, True)
    except RuntimeError as e:
        raise HTTPException(409, "Копия уже делается - подождите минуту") from e
    return {**st, "can_manage": True}


@router.get("/api/export")
def export(u=Depends(current_user)):
    rows = db.q("SELECT * FROM records WHERE user_id = ? AND deleted = 0 ORDER BY kind, date, updated_at", (u["id"],))
    body = {"user": {"id": u["id"], "login": u["login"], "name": u["name"]},
            "exported_at": db.now_ms(), "records": [db.row_to_rec(r) for r in rows]}
    return JSONResponse(body, headers={
        "Content-Disposition": f'attachment; filename="trainer-{u["id"]}-{date.today().isoformat()}.json"'})
