"""HTTP API и раздача клиента.

`/` всегда отдаёт оболочку приложения, вход рисует сам клиент по `/api/me`: так Service Worker
может кэшировать одну и ту же страницу независимо от того, вошёл пользователь или нет.
"""
import base64
import hashlib
import json
import hmac
import os
import re
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from . import backup, brain, certs, chat, db, food, foods_api, health, norms, nutrition, updater, userdata, wan, weather
from . import sync as sync_mod
from .ai import jobs, ollama
from .userdata import COOKIE, bearer, current_user

STATIC = Path(__file__).resolve().parent / "static"
HTTPS_PORT = int(os.environ.get("TRAINER_PORT", 8790))
MAX_USERS = 4
KINDS = {"profile", "goal", "target", "item", "log", "food", "body", "program", "workout", "dsum", "ach", "coach",
         "sleep", "state", "daytype", "activity", "injury", "routine", "favfood", "chat", "wsum", "mtest", "vitals", "period", "drink", "supp"}
SYNC_LIMIT = 2000


def build_hash() -> str:
    h = hashlib.md5()
    for p in sorted(STATIC.rglob("*")):
        if p.is_file():
            h.update(p.name.encode())
            h.update(p.read_bytes())
    return h.hexdigest()[:10]


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.conn()
    db.seed_foods()
    await jobs.start()
    backup.start()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
for _m in (chat, health, backup, nutrition, foods_api, brain, weather):
    app.include_router(_m.router)


# ── происхождение запросов: CORS для зеркал, защита от чужих сайтов ──

def _cors(origin: str) -> dict:
    # без Allow-Credentials: зеркала ходят с токеном устройства, cookie на чужой origin не нужны
    return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}


@app.middleware("http")
async def origin_guard(request: Request, call_next):
    server = request.scope.get("server") or (None, None)
    # HTTP-порт — только для этого Mac; чужое имя в Host значит DNS-rebinding со стороннего сайта
    if server[1] == wan.HTTP_PORT and (request.headers.get("host") or "").rsplit(":", 1)[0] not in wan.LOCAL_HOSTS:
        return JSONResponse({"detail": "forbidden host"}, 403)
    origin = request.headers.get("origin")
    if not origin:
        return await call_next(request)
    same = origin == f"{request.url.scheme}://{request.headers.get('host')}"
    allowed = same or origin in wan.own_origins()
    if request.method == "OPTIONS" and request.headers.get("access-control-request-method"):
        if not allowed:
            return Response(status_code=403)
        return Response(status_code=204, headers={
            **_cors(origin), "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
            "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600"})
    # записывающие запросы с чужих сайтов не пускаем вовсе (CSRF, в т. ч. на localhost без cookie)
    if not allowed and request.method not in ("GET", "HEAD"):
        return JSONResponse({"detail": "Запрос с чужого сайта отклонён"}, 403)
    resp = await call_next(request)
    if allowed and not same:
        resp.headers.update(_cors(origin))
    return resp


# ── авторизация ──

# попытки входа: не больше 10 в минуту с одного адреса (из интернета пароль могут подбирать)
_attempts: dict[str, deque] = {}


def rate_limit(request: Request, limit: int = 10) -> None:
    ip, now = wan.client_ip(request), time.monotonic()
    q = _attempts.setdefault(ip, deque())
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Слишком много попыток входа — подождите минуту")
    q.append(now)
    if len(_attempts) > 5000:   # не даём словарю расти бесконечно
        _attempts.clear()


def require_secure(request: Request) -> None:
    """Пароль и cookie — только по HTTPS или на самом Mac."""
    if request.url.scheme != "https" and not wan.is_local(request):
        raise HTTPException(403, "Вход возможен только по HTTPS")


def device_label(request: Request, body: dict) -> str:
    if body.get("label"):
        return str(body["label"])[:80]
    ua = request.headers.get("user-agent") or ""
    kind = next((n for k, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Macintosh", "Mac"), ("Windows", "Windows"),
                                ("Android", "Android")) if k in ua), "Устройство")
    return kind + (" · из интернета" if wan.is_wan(request) else "")


def user_json(u) -> dict:
    return {"id": u["id"], "login": u["login"], "name": u["name"]}


def set_cookie(resp: Response, request: Request, token: str) -> None:
    resp.set_cookie(COOKIE, token, max_age=365 * 86400, httponly=True, samesite="lax",
                    secure=request.url.scheme == "https", path="/")


@app.get("/api/auth/state")
def auth_state(request: Request):
    n = db.q("SELECT COUNT(*) n FROM users")[0]["n"]
    # из интернета не показываем имена и не даём заводить аккаунты
    if wan.is_wan(request):
        return {"has_users": n > 0, "can_register": False, "users": []}
    return {"has_users": n > 0, "can_register": n < MAX_USERS,
            "users": [r["name"] for r in db.q("SELECT name FROM users ORDER BY created")]}


@app.post("/api/auth/register")
async def register(request: Request):
    require_secure(request)
    rate_limit(request)
    if wan.is_wan(request):
        raise HTTPException(403, "Новый аккаунт можно завести только из домашней сети")
    body = await request.json()
    login = (body.get("login") or "").strip().lower()
    name = (body.get("name") or "").strip()
    pw = body.get("password") or ""
    if not re.fullmatch(r"[a-zа-я0-9_.-]{2,32}", login):
        raise HTTPException(400, "Логин: 2–32 символа, буквы, цифры, _ . -")
    if not name or len(pw) < 4:
        raise HTTPException(400, "Нужны имя и пароль не короче 4 символов")
    if db.q("SELECT COUNT(*) n FROM users")[0]["n"] >= MAX_USERS:
        raise HTTPException(403, "Достигнут предел аккаунтов")
    if db.q("SELECT 1 FROM users WHERE login = ?", (login,)):
        raise HTTPException(409, "Такой логин уже есть")
    uid = uuid.uuid4().hex[:12]
    with db.tx() as c:
        c.execute("INSERT INTO users VALUES (?,?,?,?,?)", (uid, login, name, db.hash_pw(pw), db.now_ms()))
    create_defaults(uid, name)
    resp = JSONResponse({"user": {"id": uid, "login": login, "name": name},
                         "device_token": db.new_device_token(uid, device_label(request, body))})
    set_cookie(resp, request, db.new_session(uid))
    return resp


@app.post("/api/auth/login")
async def login(request: Request):
    require_secure(request)
    rate_limit(request)
    body = await request.json()
    rows = db.q("SELECT * FROM users WHERE login = ?", ((body.get("login") or "").strip().lower(),))
    if not rows or not db.check_pw(body.get("password") or "", rows[0]["pw_hash"]):
        raise HTTPException(401, "Неверный логин или пароль")
    # токен устройства — для зеркал (другой адрес сервера), см. store.js
    resp = JSONResponse({"user": user_json(rows[0]),
                         "device_token": db.new_device_token(rows[0]["id"], device_label(request, body))})
    set_cookie(resp, request, db.new_session(rows[0]["id"]))
    return resp


@app.post("/api/auth/logout")
def logout(request: Request):
    token = request.cookies.get(COOKIE)
    if token:
        with db.tx() as c:
            c.execute("DELETE FROM sessions WHERE token = ?", (token,))
    if (dt := bearer(request)):
        db.revoke_device(dt)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.post("/api/auth/device")
async def device_token(request: Request):
    """Выдать токен устройства уже вошедшему по cookie (устройства, вошедшие до появления зеркал)."""
    u = db.session_user(request.cookies.get(COOKIE))
    if not u:
        raise HTTPException(401, "not_logged_in")
    return {"device_token": db.new_device_token(u["id"], device_label(request, await _body(request)))}


@app.get("/api/auth/devices")
def devices(request: Request, u=Depends(current_user)):
    cur = db.token_hash(bearer(request)) if bearer(request) else ""
    rows = db.q("SELECT * FROM device_tokens WHERE user_id = ? ORDER BY last_seen DESC", (u["id"],))
    return {"devices": [{"id": r["token_hash"][:12], "label": r["label"], "created": r["created"],
                         "last_seen": r["last_seen"], "current": r["token_hash"] == cur} for r in rows]}


@app.delete("/api/auth/devices/{did}")
def device_revoke(did: str, u=Depends(current_user)):
    if not re.fullmatch(r"[0-9a-f]{12}", did):
        raise HTTPException(400, "bad id")
    with db.tx() as c:
        c.execute("DELETE FROM device_tokens WHERE user_id = ? AND substr(token_hash, 1, 12) = ?", (u["id"], did))
    return {"ok": True}


@app.delete("/api/auth/devices")
def devices_revoke_others(request: Request, u=Depends(current_user)):
    """Отключить все устройства, кроме того, с которого просят (его ключ — в заголовке)."""
    cur = db.token_hash(bearer(request)) if bearer(request) else ""
    with db.tx() as c:
        n = c.execute("DELETE FROM device_tokens WHERE user_id = ? AND token_hash != ?", (u["id"], cur)).rowcount
    return {"ok": True, "revoked": n}


@app.post("/api/auth/device/prove")
async def device_prove(request: Request):
    """Зеркало доказывает, что это тот же сервер: знает хэш токена устройства.
    Клиент не отдаёт токен адресу, который не прошёл эту проверку (например, опечатка в ручном адресе)."""
    body = await _body(request)
    did, nonce = str(body.get("id") or ""), str(body.get("nonce") or "")
    if not re.fullmatch(r"[0-9a-f]{16}", did) or not 16 <= len(nonce) <= 64:
        raise HTTPException(400, "bad request")
    rows = db.q("SELECT token_hash FROM device_tokens WHERE substr(token_hash, 1, 16) = ?", (did,))
    if not rows:
        raise HTTPException(404, "unknown device")
    return {"proof": hmac.new(rows[0]["token_hash"].encode(), nonce.encode(), hashlib.sha256).hexdigest()}


@app.get("/api/me")
def me(u=Depends(current_user)):
    # пол партнёра нужен тренеру для окончаний («Маша сделала», «подбодри её»); остальной профиль — приватный
    partners = [{**user_json(r), "sex": (db.get(f"profile:{r['id']}") or {}).get("data", {}).get("sex")}
                for r in db.q("SELECT * FROM users WHERE id != ? ORDER BY created", (u["id"],))]
    return {"user": user_json(u), "partners": partners}


# ── начальные данные нового пользователя ──



def create_defaults(uid: str, name: str) -> None:
    db.server_put(uid, "profile", f"profile:{uid}", {
        "name": name, "sex": None, "birth": None, "height": None, "weight": None, "activity": "light",
        "gym": False, "gym_days": 3, "weekdays": [0, 2, 4], "equipment": ["mat", "dumbbells", "chair", "ab_wheel"],
        "tone": "coach", "glass_ml": 250, "setup_done": False,
        "time_budget_min": 60, "start_mode": "smooth", "pace": "normal", "limitations": [], "activities": [],
        "modules": {"morning": {"enabled": True, "minutes": 10, "pinned": []}}})
    # утро — одна «Утренняя разминка»: каждый день новая под выбранное время; свои упражнения
    # пользователь закрепляет в ней сам (profile.modules.morning.pinned)
    items = [{"title": "Утренняя разминка", "type": "routine", "module": "morning", "group": "morning"}]
    items += [
        {"title": "Вода", "type": "counter", "group": "day", "target_from": "water", "target": 8, "unit": "стак."},
        {"title": "Шаги", "type": "number", "group": "day", "target_from": "steps", "target": 8000, "unit": "шагов"},
        {"title": "Тренировка по плану", "type": "workout", "group": "day"},
        {"title": "Записать питание", "type": "food", "group": "day", "target": 3, "unit": "приёма"},
    ]
    for i, it in enumerate(items):
        db.server_put(uid, "item", uuid.uuid4().hex, {**it, "order": i, "active": True})


# ── синхронизация ──

@app.get("/api/sync/head")
async def sync_head(u=Depends(current_user)):
    """Номер последней ревизии, которую видит пользователь: клиент сверяет его со своим курсором
    и делает полный обмен, только если есть новое (дешёвый опрос раз в 10 с)."""
    partners = db.partner_ids(u["id"])
    marks = ",".join("?" * len(partners)) or "''"
    kinds = ",".join("?" * len(db.PUBLIC_KINDS))
    row = db.q(f"SELECT MAX(rev) r FROM records WHERE user_id = ? OR (user_id IN ({marks}) AND kind IN ({kinds}))",
               (u["id"], *partners, *db.PUBLIC_KINDS))
    # ai — доступна ли модель (кэш на минуту): клиент показывает в шапке «ИИ спит»
    return {"rev": row[0]["r"] or 0, "ai": (await jobs.ai_state(60))["ok"]}


def _acts(data: dict) -> list:
    """Действия сообщения без статуса: клиент может отметить «сделано/нет», но не подменить сами действия."""
    return [{k: v for k, v in a.items() if k != "status"} for a in data.get("actions") or []]


@app.post("/api/sync")
async def sync(request: Request, u=Depends(current_user)):
    """Отправить правки и забрать изменения. Конфликты не перезаписываются — см. app/sync.py."""
    body = await request.json()
    uid = u["id"]
    applied, revs, rejected, conflicts = [], {}, [], []
    with db.tx() as c:
        for op in body.get("ops") or []:
            if op.get("user_id") != uid or op.get("kind") not in KINDS or not op.get("id"):
                rejected.append(op.get("id"))
                continue
            # ответы ИИ с кнопками действий пишет только сервер: иначе клиент мог бы подсунуть
            # «сообщение тренера» с любым действием и выполнить его через /api/chat/action
            if op["kind"] == "chat" and (op.get("data") or {}).get("source") == "ai":
                cur = db.get(op["id"])
                if not cur or cur["data"].get("source") != "ai" or _acts(cur["data"]) != _acts(op["data"]):
                    rejected.append(op["id"])
                    continue
            status, res = sync_mod.apply_op(c, op)
            if status == "applied":
                applied.append(op["id"])
                revs[op["id"]] = res["rev"]
            elif status == "conflict":
                conflicts.append({"id": op["id"], "server": res})
            else:
                rejected.append(op["id"])
    changes, cursor, more = sync_mod.changes_for(uid, int(body.get("since") or 0))
    # на месте отклонённых (сервер знает версию новее) клиенту нужна актуальная версия
    have = {r["id"] for r in changes}
    for rid in rejected:
        if rid and rid not in have and (cur := db.get(rid)) and cur["user_id"] == uid:
            changes.append(cur)
    return {"applied": applied, "revs": revs, "rejected": rejected, "conflicts": conflicts,
            "changes": changes, "cursor": cursor, "more": more}


# ── справочники ──

@app.get("/api/exercises")
def exercises_list(u=Depends(current_user)):
    return {"exercises": db.exercises()}


@app.get("/api/activities")
def activities_list(u=Depends(current_user)):
    return {"activities": db.activities()}


@app.get("/api/supplements")
def supplements_list(u=Depends(current_user)):
    return db.supplements()


@app.get("/api/foods")
def foods_search(q: str = "", u=Depends(current_user)):
    idx = food.Index()
    qn = food.norm(q)
    if not qn:
        return {"foods": []}
    hits = [f for k, f in idx.keys.items() if qn in k]
    seen, out = set(), []
    for f in sorted(hits, key=lambda f: (not food.norm(f["name"]).startswith(qn), len(f["name"]))):
        if f["name"] not in seen:
            seen.add(f["name"])
            out.append(f)
    return {"foods": out[:20]}


# ── расчёты ──

@app.post("/api/food/calc")
async def food_calc(request: Request, u=Depends(current_user)):
    """Посчитать БЖУ записи. Сначала без ИИ; если что-то не распознано — задача ИИ."""
    body = await request.json()
    rec = body.get("record") or {}
    if rec.get("user_id") != u["id"] or rec.get("kind") != "food":
        raise HTTPException(400, "bad record")
    with db.tx() as c:
        db.put(c, {**rec, "updated_at": int(rec.get("updated_at") or db.now_ms())})
    saved = db.get(rec["id"])
    done, rest = food.quick_parse(saved["data"].get("text", ""))
    if rest:                                   # то, что ИИ уже однажды разобрала, — из памяти, без ИИ
        more, rest = brain.resolve(rest)
        done += more
    if not rest:
        jobs._save_food(saved, done)
        return {"done": True}
    if body.get("ai") is False or userdata.ai_mode(u["id"]) == "off":
        return {"done": False, "unresolved": rest}
    await jobs.ai_state()
    return {"done": False, "job_id": jobs.submit(u["id"], "food", {"record_id": rec["id"]}), "waiting": jobs.waiting()}


def _ai_on(uid: str) -> None:
    if userdata.ai_mode(uid) == "off":
        raise HTTPException(403, "ИИ выключена в профиле (раздел «Профиль» → «Режим ИИ»)")


async def _body(request: Request) -> dict:
    """Тело запроса или {} — старые клиенты шлют пустое тело."""
    try:
        b = await request.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


@app.post("/api/norms")
async def norms_calc(request: Request, u=Depends(current_user)):
    body = await _body(request)
    try:
        target_id, _ = norms.recalc_for(u["id"], deadline=body.get("deadline") or None, pace=body.get("pace"))
    except norms.MissingData as e:
        raise HTTPException(400, str(e))
    job_id = None
    # комментарий тренера — к последнему пересчёту: прежний неначатый заменяется; модель спит — подождёт в очереди
    if userdata.ai_mode(u["id"]) == "on":
        await jobs.ai_state()
        job_id = jobs.submit(u["id"], "norms", {"target_id": target_id}, replace=True)
    return {"target_id": target_id, "job_id": job_id, "waiting": bool(job_id) and jobs.waiting()}


@app.post("/api/norms/preview")
async def norms_preview(request: Request, u=Depends(current_user)):
    """Ползунок срока. Клиент может прислать черновик цели (ещё не сохранённый) и темп."""
    body = await _body(request)
    uid = u["id"]
    prof, goal, weight = userdata.profile(uid), userdata.goal(uid), userdata.latest_weight(uid)
    if isinstance(body.get("goal"), dict):
        goal = body["goal"]
    if not (prof.get("sex") and prof.get("birth") and prof.get("height") and weight):
        raise HTTPException(400, "Заполните в профиле пол, дату рождения, рост и вес")
    deadline = body.get("deadline") or goal.get("deadline")
    pace = body.get("pace") if body.get("pace") in norms.PACE_LEVEL else None
    if deadline:
        try:
            date.fromisoformat(deadline)
        except (TypeError, ValueError):
            raise HTTPException(400, "Нужна дата срока YYYY-MM-DD")
    return norms.preview(prof, float(weight), goal, deadline, pace=pace)


@app.post("/api/ai/jobs")
async def ai_submit(request: Request, u=Depends(current_user)):
    body = await request.json()
    kind = body.get("kind")
    if kind not in jobs.USER_KINDS:
        raise HTTPException(400, "unknown kind")
    _ai_on(u["id"])
    await jobs.ai_state()
    return {"job_id": jobs.submit(u["id"], kind, body.get("input") or {}), "waiting": jobs.waiting()}


@app.post("/api/program/rebuild")
async def program_rebuild(request: Request, u=Depends(current_user)):
    """Пересобрать будущий план с параметрами активной программы и текущим профилем."""
    body = await _body(request)
    if not any(p["data"].get("active") for p in db.list_kind(u["id"], "program")):
        raise HTTPException(400, "Нет активной программы — составьте её в разделе «Тренировки»")
    _ai_on(u["id"])
    await jobs.ai_state()
    return {"job_id": jobs.submit(u["id"], "program", {"rebuild": True, "reason": body.get("reason") or ""}),
            "waiting": jobs.waiting()}


@app.get("/api/ai/jobs/{job_id}")
def ai_job(job_id: str, u=Depends(current_user)):
    j = jobs.get_job(job_id)
    if not j or j["user_id"] != u["id"]:
        raise HTTPException(404, "not found")
    return j


@app.get("/api/ai/status")
async def ai_status():
    return await ollama.status()


@app.get("/api/widget/summary")
def widget_summary(request: Request):
    """Для десктоп-виджета на этом Mac: только HTTP-порт с 127.0.0.1 (туннель сюда не ведёт).
    Ничего личного: лучший процент чек-листа за сегодня среди аккаунтов и сколько аккаунтов уже отмечались.
    Имён, питания и веса здесь нет — виджет рисует по этому кольцо дня."""
    if not wan.is_local(request) or request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for"):
        raise HTTPException(403, "forbidden")
    today = date.today().isoformat()
    pcts = []
    for r in db.q("SELECT data FROM records WHERE kind = 'dsum' AND date = ? AND deleted = 0", (today,)):
        try:
            pcts.append(int((json.loads(r["data"]) or {}).get("pct") or 0))
        except (ValueError, TypeError):
            continue
    return {"date": today, "pct": max(pcts) if pcts else None, "active": sum(1 for x in pcts if x > 0)}


# ── служебное ──

@app.get("/api/version")
def version():
    return {"version": build_hash(), "server": wan.server_id(), "commit": updater.current_version()}


# ── обновление из GitHub (git pull + uv sync + перезапуск), как в transkribator ──

@app.get("/api/update/check")
def update_check(force: bool = False, u=Depends(current_user)):
    """Есть ли новые коммиты. Сеть - не чаще раза в 30 минут; force=1 - проверить сейчас."""
    return updater.check(fetch=True, force=force)


@app.post("/api/update/apply")
def update_apply(request: Request):
    wan_admin(request)          # только на самом компьютере или из аккаунта владельца
    if db.q("SELECT COUNT(*) n FROM ai_jobs WHERE status = 'running'")[0]["n"]:
        raise HTTPException(409, "Сейчас ИИ выполняет задачу - обновите приложение через пару минут")
    try:
        result = updater.apply()
    except updater.UpdateError as e:
        raise HTTPException(400, str(e)) from e
    if result.get("updated"):
        updater.restart_soon(1.5)
    return {**result, "restarting": bool(result.get("updated"))}


@app.get("/api/config")
def config():
    host = certs.mdns_name()
    urls = [f"https://{ip}:{HTTPS_PORT}" for ip in wan.lan_ips()]
    return {"lan_host_url": f"https://{host}:{HTTPS_PORT}" if host else None, "all_urls": urls,
            "wan_url": wan.state["url"], "mirrors": wan.mirrors(), "server_id": wan.server_id()}


# ── доступ из интернета (WAN) ──

def wan_admin(request: Request) -> None:
    """Управлять WAN можно с самого Mac или владельцу (первый зарегистрированный аккаунт)."""
    if wan.is_local(request):
        return
    try:
        u = current_user(request)
    except HTTPException:
        raise HTTPException(403, "Доступ из интернета включают на самом компьютере или из аккаунта владельца")
    owner = db.q("SELECT id FROM users ORDER BY created LIMIT 1")
    if not owner or owner[0]["id"] != u["id"]:
        raise HTTPException(403, "Доступ из интернета включают на самом компьютере или из аккаунта владельца")


@app.get("/api/wan")
def wan_get(request: Request):
    wan_admin(request)
    return {**wan.status(), "local": wan.is_local(request)}


@app.post("/api/wan")
async def wan_set(request: Request):
    wan_admin(request)
    body = await _body(request)
    try:
        return await wan.apply(str(body.get("mode") or "off"), body.get("url"))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/ca.crt")
def ca_crt():
    return Response(certs.ca_der(), media_type="application/x-x509-ca-cert",
                    headers={"Content-Disposition": 'attachment; filename="trainer-ca.crt"'})


NO_CACHE = {"Cache-Control": "no-cache"}


@app.get("/sw.js")
def sw():
    code = (STATIC / "sw.js").read_text("utf-8").replace("BUILD_HASH", build_hash())
    return Response(code, media_type="application/javascript", headers=NO_CACHE)


_icon_uri: dict[str, str] = {}


def icon_data_uri(name: str) -> str:
    """Иконка строкой data: — её не нужно загружать отдельным запросом.

    WebKit не применяет apple-touch-icon, когда сервер работает по самоподписанному HTTPS:
    файл скачивает, но значок не ставит (выяснено в vk-music по журналу обращений). Вшитая
    в разметку и манифест картинка подресурсом не считается — запрещать нечего."""
    if name not in _icon_uri:
        _icon_uri[name] = "data:image/png;base64," + base64.b64encode((STATIC / name).read_bytes()).decode("ascii")
    return _icon_uri[name]


@app.get("/manifest.json")
def manifest():
    # iOS 16.4+ берёт значок домашнего экрана уже из манифеста — первой идёт вшитая версия
    return JSONResponse({
        "name": "Тренер", "short_name": "Тренер", "start_url": "/", "scope": "/", "display": "standalone",
        "background_color": "#141311", "theme_color": "#141311", "lang": "ru",
        "icons": [{"src": icon_data_uri("icon-512.png"), "sizes": "512x512", "type": "image/png", "purpose": "any"},
                  {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                  {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                  {"src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png", "purpose": "any"}],
    }, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/favicon.ico")
def favicon_ico():
    # браузеры и iOS спрашивают /favicon.ico сами; внутри PNG — по содержимому его понимают все
    return FileResponse(STATIC / "favicon-48.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/")
def index():
    html = ((STATIC / "index.html").read_text("utf-8").replace("BUILD_HASH", build_hash())
            .replace("APPLE_ICON_URI", icon_data_uri("apple-touch-icon.png")))
    return Response(html, media_type="text/html; charset=utf-8", headers=NO_CACHE)


@app.get("/views/{name}")
def view_file(name: str):
    path = (STATIC / "views" / name).resolve()
    if path.parent != STATIC / "views" or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers=NO_CACHE)


@app.get("/{name}")
def static_file(name: str):
    path = (STATIC / name).resolve()
    if path.parent != STATIC or not path.is_file() or name in ("index.html", "sw.js"):
        raise HTTPException(404)
    return FileResponse(path, headers=NO_CACHE)
