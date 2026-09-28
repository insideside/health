"""Справочник продуктов: общий для всех аккаунтов, кэшируется клиентом для поиска без сети.

GET  /api/foods/all?since=   — компактный список (или изменения с момента since, мс, вместе с удалёнными)
GET  /api/foods/recent       — продукты, которые человек ел чаще и недавно (из его записей еды)
POST /api/foods              — добавить свой продукт (если такое имя уже есть у этого человека — обновить)
PUT/DELETE /api/foods/{id}   — править и удалять только свои продукты
Поиск БЖУ с ИИ — задача `foodlookup` (ai/jobs.py): результат не сохраняется сам, клиент показывает его
для подтверждения и сохраняет через POST /api/foods.
"""
import math
import re

from fastapi import APIRouter, Depends, HTTPException, Request

from . import brain, db, food
from .userdata import current_user

router = APIRouter()

FIELDS = ("id", "name", "aliases", "group", "state", "generic", "note", "kcal", "p", "f", "c", "portions",
          "cooked_ratio", "source", "brand", "created_by", "verified", "updated")
SOURCES = ("manual", "web", "ai")


def compact(f: dict) -> dict:
    out = {k: f.get(k) for k in FIELDS}
    # пустые поля не гоняем: справочник целиком ~700 строк, клиент хранит его в IndexedDB
    return {k: v for k, v in out.items() if v not in (None, [], {}, False) or k in ("kcal", "p", "f", "c", "id", "name")}


@router.get("/api/foods/all")
def foods_all(since: int = 0, u=Depends(current_user)):
    db.migrate_foods()
    now = db.now_ms()
    if since > 0:
        rows = db.foods_since(since)
        return {"foods": [compact(f) for f in rows if not f["deleted"]],
                "deleted": [f["id"] for f in rows if f["deleted"]], "now": now, "full": False}
    return {"foods": [compact(f) for f in db.all_foods()], "deleted": [], "now": now, "full": True}


@router.get("/api/foods/recent")
def foods_recent(limit: int = 20, u=Depends(current_user)):
    idx = food.Index()
    use = food.usage(u["id"], idx)
    ranked = sorted(use.items(), key=lambda kv: (kv[1]["last_used"], kv[1]["count"]), reverse=True)
    # свежие вперёд, но часто используемые не теряются: сначала 2/3 по дате, остальное — по частоте
    top = ranked[: max(1, limit * 2 // 3)]
    rest = sorted(ranked[len(top):], key=lambda kv: kv[1]["count"], reverse=True)
    out = []
    for fid, st in [*top, *rest][:limit]:
        f = idx.by_id.get(fid)
        if f:
            out.append({**compact(f), "count": st["count"], "last_grams": st["last_grams"], "last_used": st["last_used"]})
    return {"foods": out}


def _clean(body: dict) -> dict:
    name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
    if not 2 <= len(name) <= 80:
        raise HTTPException(400, "Название: от 2 до 80 символов")
    state = body.get("state") or None
    if state is not None and state not in db.FOOD_STATES:
        raise HTTPException(400, f"Состояние: одно из {', '.join(db.FOOD_STATES)}")
    vals = {}
    for k in ("kcal", "p", "f", "c"):
        try:
            v = float(body.get(k))
        except (TypeError, ValueError):
            raise HTTPException(400, "Нужны числа: ккал, белки, жиры, углеводы на 100 г")
        if not math.isfinite(v) or v < 0:
            raise HTTPException(400, "Значения не могут быть отрицательными")
        vals[k] = round(v, 1)
    if vals["kcal"] > 950 or vals["p"] + vals["f"] + vals["c"] > 105:
        raise HTTPException(400, "Значения больше возможных для 100 г — возможно, указаны на порцию или упаковку")
    portions = {}
    for k, v in (body.get("portions") or {}).items():
        try:
            g = float(v)
        except (TypeError, ValueError):
            continue
        k = str(k).strip()[:24]
        if k and 0 < g <= 5000:
            portions[k] = round(g, 1)
    text = lambda k, n: (re.sub(r"\s+", " ", str(body.get(k) or "")).strip()[:n] or None)
    src = body.get("source") if body.get("source") in SOURCES else "manual"
    aliases = [food.norm(a) for a in (body.get("aliases") or []) if isinstance(a, str) and food.norm(a)][:8]
    return {"name": name, "state": state, **vals, "portions": portions, "brand": text("brand", 60),
            "note": text("note", 200), "group": text("group", 40), "aliases": aliases, "source": src}


def _warnings(f: dict) -> list[str]:
    w = []
    mm = food.energy_mismatch(f["kcal"], f["p"], f["f"], f["c"])
    if mm is not None and mm > 0.25:
        w.append(f"Калории ({f['kcal']:g}) не сходятся с БЖУ: 4·Б + 4·У + 9·Ж ≈ {4 * f['p'] + 4 * f['c'] + 9 * f['f']:.0f} ккал."
                 " Проверьте, что всё указано на 100 г.")
    w += [x for x in food.sanity(f["name"], f["state"], f["group"], f) if x not in w and "не сходятся" not in x]
    return w


def _own(fid: int, uid: str) -> dict:
    f = db.food_by_id(fid)
    if not f or f["deleted"]:
        raise HTTPException(404, "Продукт не найден")
    if f["created_by"] != uid or f["source"] == "seed":
        raise HTTPException(403, "Менять можно только свои продукты")
    return f


@router.post("/api/foods")
async def foods_add(request: Request, u=Depends(current_user)):
    body = await request.json()
    cur = db.food_by_name(str(body.get("name") or ""))
    if cur and cur["created_by"] == u["id"] and not cur["deleted"]:
        # повторное добавление своего продукта — обновление: чего нет в запросе, остаётся как было
        body = {**{k: cur[k] for k in ("portions", "brand", "note", "group", "aliases")}, **body}
    f = _clean(body)
    warnings = _warnings(f)
    if warnings and not body.get("force"):
        return {"ok": False, "need_confirm": True, "warnings": warnings}
    if cur and not cur["deleted"] and cur["created_by"] != u["id"]:
        raise HTTPException(409, f"«{cur['name']}» уже есть в справочнике"
                                 + (" (добавил другой человек)" if cur["created_by"] else "")
                                 + " — выберите его или уточните название, например брендом")
    saved = db.save_food({**f, "verified": body.get("verified")}, u["id"], cur["id"] if cur else None)
    brain.on_food_saved(u["id"], saved)       # сохранили найденное поиском с ИИ — запрос станет синонимом
    return {"ok": True, "food": compact(saved), "updated": bool(cur), "warnings": warnings}


@router.put("/api/foods/{fid}")
async def foods_edit(fid: int, request: Request, u=Depends(current_user)):
    old = _own(fid, u["id"])
    body = await request.json()
    f = _clean({**old, **body, "source": body.get("source") or old["source"]})
    warnings = _warnings(f)
    if warnings and not body.get("force"):
        return {"ok": False, "need_confirm": True, "warnings": warnings}
    other = db.food_by_name(f["name"])
    if other and other["id"] != fid and not other["deleted"]:
        raise HTTPException(409, f"«{other['name']}» уже есть в справочнике")
    saved = db.save_food({**f, "verified": old["verified"]}, u["id"], fid)
    return {"ok": True, "food": compact(saved), "warnings": warnings}


@router.delete("/api/foods/{fid}")
def foods_delete(fid: int, u=Depends(current_user)):
    _own(fid, u["id"])
    db.delete_food(fid)
    return {"ok": True}
