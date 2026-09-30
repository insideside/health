"""Синхронизация записей между устройствами.

Каждая правка с клиента приходит с `base_rev` — ревизией сервера, от которой она сделана.
Совпала с текущей → правка применяется. Не совпала (запись успели изменить с другого
устройства или сервер записал результат ИИ) → это конфликт: сервер ничего не перезаписывает
и возвращает свою версию, а клиент сливает изменения сам или спрашивает пользователя.
Так часы устройств больше ни на что не влияют: решает только порядок ревизий на сервере.

Старые клиенты без поля `base_rev` работают по-прежнему: побеждает бо́льший `updated_at`.
"""
import json

from . import db

SYNC_LIMIT = 2000


def _same(a: dict, b: dict) -> bool:
    return (json.dumps(a.get("data") or {}, sort_keys=True, ensure_ascii=False) ==
            json.dumps(b.get("data") or {}, sort_keys=True, ensure_ascii=False)
            and bool(a.get("deleted")) == bool(b.get("deleted")))


def apply_op(c, op: dict) -> tuple[str, dict | None]:
    """→ ('applied', {id, rev}) | ('conflict', серверная запись) | ('rejected', None)."""
    row = c.execute("SELECT * FROM records WHERE id = ?", (op["id"],)).fetchone()
    cur = db.row_to_rec(row) if row else None
    if cur and cur["user_id"] != op["user_id"]:
        return "rejected", None                   # чужая запись с тем же id
    rec = {k: op.get(k) for k in ("id", "user_id", "kind", "date", "data", "deleted")}
    rec["updated_at"] = int(op.get("updated_at") or db.now_ms())

    if "base_rev" not in op:                      # старый клиент: побеждает поздняя правка
        saved = db.put(c, rec)
        return ("applied", {"id": op["id"], "rev": saved["rev"]}) if saved else ("rejected", None)

    if cur is None or op.get("force") or cur["rev"] == op["base_rev"]:
        saved = db.put(c, rec, force=True)
        return "applied", {"id": op["id"], "rev": saved["rev"]}
    if _same(cur, rec):                           # обе стороны пришли к одному и тому же
        return "applied", {"id": op["id"], "rev": cur["rev"]}
    return "conflict", cur


def changes_for(uid: str, since: int) -> tuple[list[dict], int, bool]:
    """Изменения с ревизией > since: свои записи и публичные записи партнёров.

    Курсор и выборка читаются под одним замком: иначе запись, пришедшая между ними,
    получила бы ревизию ≤ курсора и не попала в выдачу — устройство пропустило бы её навсегда.
    """
    partners = db.partner_ids(uid)
    marks = ",".join("?" * len(partners)) or "''"
    kinds = ",".join("?" * len(db.PUBLIC_KINDS))
    with db._lock:
        c = db.conn()
        top = c.execute("SELECT value FROM meta WHERE key = 'rev'").fetchone()
        top = int(top["value"]) if top else 0
        rows = c.execute(
            f"SELECT * FROM records WHERE rev > ? AND rev <= ? AND (user_id = ? OR (user_id IN ({marks}) AND kind IN ({kinds})))"
            f" ORDER BY rev LIMIT ?", (since, top, uid, *partners, *db.PUBLIC_KINDS, SYNC_LIMIT)).fetchall()
    more = len(rows) == SYNC_LIMIT
    cursor = rows[-1]["rev"] if more else top
    recs = [db.row_to_rec(r) for r in rows]
    out = [r if r["user_id"] == uid else db.public_view(r) for r in recs]
    return [r for r in out if r is not None], cursor, more
