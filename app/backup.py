"""Резервные копии БД и экспорт своих записей.

Копия — через backup API SQLite: она согласована даже при открытых транзакциях и WAL,
в отличие от копирования файла. Храним 14 последних дней — этого хватает, чтобы
откатиться после неудачной правки, и не раздувает диск.
"""
import asyncio
import sqlite3
from datetime import date

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from . import db
from .userdata import current_user

KEEP = 14
router = APIRouter()


def backup_now() -> str | None:
    """Копия за сегодня (если её ещё нет). → путь или None."""
    folder = db.DATA_DIR / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"trainer-{date.today().isoformat()}.db"
    if not path.exists():
        tmp = path.with_suffix(".tmp")
        dst = sqlite3.connect(tmp)
        try:
            with db._lock:
                db.conn().backup(dst)
        finally:
            dst.close()
        tmp.replace(path)
    for old in sorted(folder.glob("trainer-*.db"))[:-KEEP]:
        old.unlink(missing_ok=True)
    return str(path)


async def _loop() -> None:
    while True:
        try:
            await asyncio.to_thread(backup_now)
        except Exception as e:  # noqa: BLE001 — бэкап не должен ронять сервер
            print(f"  бэкап не удался: {e}")
        await asyncio.sleep(24 * 3600)


def start() -> None:
    asyncio.get_running_loop().create_task(_loop())


@router.get("/api/export")
def export(u=Depends(current_user)):
    rows = db.q("SELECT * FROM records WHERE user_id = ? AND deleted = 0 ORDER BY kind, date, updated_at", (u["id"],))
    body = {"user": {"id": u["id"], "login": u["login"], "name": u["name"]},
            "exported_at": db.now_ms(), "records": [db.row_to_rec(r) for r in rows]}
    return JSONResponse(body, headers={
        "Content-Disposition": f'attachment; filename="trainer-{u["id"]}-{date.today().isoformat()}.json"'})
