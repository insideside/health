"""Чтение пользовательских данных из записей: профиль, цель, вес, нормы, справочник активностей."""
from fastapi import HTTPException, Request

from . import db

COOKIE = "trainer_session"


def bearer(request: Request) -> str | None:
    """Токен устройства из `Authorization: Bearer …` — так ходят к API с другого адреса (зеркала)."""
    h = request.headers.get("authorization") or ""
    return (h[7:].strip() or None) if h[:7].lower() == "bearer " else None


def current_user(request: Request):
    """Зависимость FastAPI: пользователь сессии или 401. Живёт здесь, чтобы роутеры модулей не импортировали server."""
    u = db.session_user(request.cookies.get(COOKIE)) or db.device_user(bearer(request))
    if not u:
        raise HTTPException(401, "not_logged_in")
    return u


def profile(uid: str) -> dict:
    r = db.get(f"profile:{uid}")
    return r["data"] if r and not r["deleted"] else {}


def ai_mode(uid: str) -> str:
    """Режим ИИ из профиля: on (по умолчанию) — по кнопкам, а комментарии тренера обновляются сами;
    off — локальная модель для этого человека не вызывается вовсе, всё работает формулами и справочником."""
    return "off" if profile(uid).get("ai") == "off" else "on"


def goal(uid: str) -> dict:
    r = db.get(f"goal:{uid}")
    return r["data"] if r and not r["deleted"] else {}


def latest_weight(uid: str) -> float | None:
    for r in reversed(db.list_kind(uid, "body")):
        if r["data"].get("weight"):
            return float(r["data"]["weight"])
    return profile(uid).get("weight")


def latest_target(uid: str) -> dict | None:
    rows = db.list_kind(uid, "target")
    rows.sort(key=lambda r: (r["data"].get("valid_from", ""), r["updated_at"]))
    return rows[-1] if rows else None


TONES = {
    "soft": "мягкий, тёплый, поддерживающий друг: хвалит щедро, замечания делает бережно",
    "coach": "строгий, но доброжелательный тренер: прямо и по делу, хвалит за дело, за пропуски спрашивает",
    "sergeant": ("суровый армейский сержант с сарказмом и юмором: жёстко подкалывает за лень, пропуски и отговорки, "
                 "скупо, но искренне хвалит за дело. Критикует поступки, а не человека: без оскорблений, без мата, "
                 "никаких насмешек над внешностью, телом, весом, фигурой и умом, никаких сравнений с животными"),
}


RULES = ("Правила: пиши по-русски, на «ты», живым разговорным языком, без канцелярита и без штампов. "
         "Не используй длинное тире «—», вместо него ставь обычный дефис «-». Без эмодзи. "
         "Используй ТОЛЬКО цифры из входных данных: не придумывай количество тренировок, стаканов, подходов и сроков, "
         "не меняй посчитанные нормы. Каждый совет или задача — отдельный короткий элемент списка (1–2 предложения), без нумерации.")


def tone(uid: str) -> str:
    return TONES.get(profile(uid).get("tone", "coach"), TONES["coach"])


NOT_MEDICAL = "Это не медицинская рекомендация: при болезнях, лекарствах и болях последнее слово за врачом."

LIMITATION_LABEL = {
    "knees": "колени", "lower_back": "поясница", "neck": "шея", "shoulders": "плечи", "wrists": "запястья",
    "hips": "тазобедренные суставы", "ankles": "голеностопы", "hypertension": "повышенное давление",
    "heart": "сердце", "hernia": "грыжа", "varicose": "варикоз", "pregnancy": "беременность",
    "asthma": "астма", "diabetes": "диабет", "overweight_joints": "лишний вес — беречь суставы",
}
DIET_LABEL = {
    "normal": "обычное питание", "vegetarian": "вегетарианство", "vegan": "веганство", "pescatarian": "пескетарианство",
    "lactose_free": "без лактозы", "gluten_free": "без глютена", "low_carb": "мало углеводов", "keto": "кето",
    "halal": "халяль", "kosher": "кошер", "if_16_8": "интервальное голодание 16/8",
    "if_18_6": "интервальное голодание 18/6", "diabetic": "диабетическое питание",
}
BODY_TYPE_LABEL = {"ecto": "эктоморф (сухой, трудно набирает)", "meso": "мезоморф",
                   "endo": "эндоморф (легко набирает жир)", "mixed": "смешанный"}


def open_injuries(uid: str) -> list[dict]:
    return [r["data"] for r in db.list_kind(uid, "injury") if not r["data"].get("resolved")]


def health_notes(prof: dict, injuries: list[dict] | None = None) -> str:
    """Всё, что ИИ обязана учесть о здоровье и питании: одной строкой-блоком для промпта."""
    parts = []
    lim = [LIMITATION_LABEL.get(x, x) for x in prof.get("limitations") or []]
    if lim or prof.get("limitations_note"):
        parts.append("Ограничения по здоровью: " + ", ".join(lim) + (f" ({prof['limitations_note']})" if prof.get("limitations_note") else ""))
    if injuries:
        parts.append("Сейчас болит / травмы: " + "; ".join(f"{i.get('zone')}{' — ' + i['note'] if i.get('note') else ''}" for i in injuries))
    if prof.get("diet") and prof["diet"] != "normal":
        parts.append("Питание: " + DIET_LABEL.get(prof["diet"], prof["diet"]))
    if prof.get("allergies"):
        parts.append("Аллергии и исключения: " + prof["allergies"])
    if prof.get("medications"):
        parts.append("Лекарства: " + prof["medications"])
    if prof.get("patterns"):
        parts.append("Особенности (со слов клиента): " + prof["patterns"])
    if prof.get("body_type"):
        parts.append("Тип телосложения: " + BODY_TYPE_LABEL.get(prof["body_type"], prof["body_type"]))
    if prof.get("extra_notes"):
        parts.append("Дополнительно учесть: " + prof["extra_notes"])
    sup = supplements_text(prof)
    if sup:
        parts.append("Принимает добавки: " + sup)
    return "\n".join(parts)


def supplements_text(prof: dict) -> str:
    """Добавки из профиля одной строкой: «Магний (цитрат) 1 таблетка в 21:00; Протеин 1 порция»."""
    cat = {x["id"]: x for x in db.supplements().get("items", [])}
    out = []
    for s in prof.get("supplements") or []:
        if s.get("active") is False:
            continue
        name = s.get("name") or cat.get(s.get("sid"), {}).get("name") or s.get("sid") or ""
        try:
            dose = float(s.get("dose") or s.get("amount") or 1)
        except (TypeError, ValueError):
            dose = 1.0
        unit = s.get("dose_unit") or (cat.get(s.get("sid"), {}).get("serving") or {}).get("unit") or "порция"
        times = ", ".join(s.get("times") or [])
        out.append(f"{name} {dose:g} {unit} за приём" + (f" в {times}" if times else ""))
    return "; ".join(out)


# правила для ИИ о добавках: только советы с сильной доказательной базой, ничего опасного, без назначений
SUPP_RULES = ("Про витамины и добавки: ты не врач и ничего не назначаешь. Советовать можно только то, что подтверждено "
              "исследованиями (метаанализы, консенсусы ISSN, МОК, EFSA): протеин при недоборе белка, креатин моногидрат "
              "при силовых целях, изотоник и электролиты на долгих тренировках и в жару, проверку витамина D осенью "
              "и зимой, омега-3 при редкой рыбе, B12 при вегетарианстве. Всегда говори уровень доказательности словами "
              "(«сильные доказательства», «данные слабые») и добавляй «обсуди с врачом», особенно при лекарствах, "
              "беременности, давлении, болезнях сердца, почек и щитовидной железы. Не советуй железо, калий, йод и "
              "высокие дозы витаминов без анализа. Никогда не советуй жиросжигатели, эфедрин, DNP, DMAA, сибутрамин, "
              "кленбутерол, SARMs, стероиды, гормоны, мочегонные и рецептурные препараты, дозы выше безопасного предела. "
              "Слабые добавки (L-карнитин, BCAA при достаточном белке, глютамин, жиросжигатели) честно называй малополезными.")


# ── активности ──

# запасной MET, если в seed/activities.json нет вида (или файла ещё нет)
MET_FALLBACK = {"low": 3.5, "mid": 5.0, "high": 7.5}


def activity_info(type_: str) -> dict | None:
    return next((a for a in db.activities() if a.get("id") == type_), None)


def activity_name(type_: str) -> str:
    a = activity_info(type_)
    return a["name"] if a else type_


def met(type_: str, intensity: str = "mid") -> float:
    a = activity_info(type_) or {}
    m = a.get("met") or MET_FALLBACK
    return float(m.get(intensity) or m.get("mid") or MET_FALLBACK["mid"])


def activity_kcal(type_: str, minutes: float, intensity: str, weight: float | None) -> int:
    """ккал = MET × вес × часы (как plan.activityKcal на клиенте)."""
    return round(met(type_, intensity or "mid") * float(weight or 70) * float(minutes or 0) / 60)
